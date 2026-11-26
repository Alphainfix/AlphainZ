/**
 * Turn stored preferences into a configured agent.
 *
 * The one place that knows how a user's settings become a provider, a model and
 * a tool set — so the sidebar, the reader popup and the CLI all get the same
 * agent rather than each assembling their own.
 *
 * Deliberately split from the pure modules it composes: this is the only file
 * in `llm/` that touches Zotero, which keeps everything else unit-testable
 * without a Zotero runtime.
 */

import { getPref, setPref } from '../../utils/prefs';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    EMBEDDING_PRESETS,
    embeddingProviderFromPreset,
    type EmbeddingPresetId,
    type EmbeddingProvider,
    type EmbeddingRequestOutcome,
} from './embeddings';
import { noteEmbeddingOutcome } from './embeddingHealth';
import { geminiIndexPacing } from './embeddingQuota';
import {
    PROVIDER_PRESETS,
    RETIRED_MODELS,
    presetCapabilities,
    presetSupportsVision,
    providerFromPreset,
    retireChoice,
    type ProviderPresetId,
} from './openAICompatible';
import { probeVision, refreshVisionCapability, visionProbeApplies, type VisionProbeVerdict } from './visionProbe';
import {
    DEFAULT_CUSTOM_MAX_TOKENS,
    customModelCapabilities,
    customProviderFromEndpoint,
    findCustomEndpoint,
    findCustomModel,
    isCustomProviderId,
    updateCustomModel,
} from './customEndpoints';
import { readRunLimits, resolveOutputTokens } from './runLimits';
import { THINKING_TIERS, isThinkingTier, nearestTier, type ThinkingTier } from './thinkingTiers';
import { modelContextWindow, modelThinkingTiers, presetModelOutputTokens } from './modelTuning';
import { conversationSyncMode } from '../conversationSync';
import {
    baseUrlOverrideFor,
    hydrateProviderOverrides,
    readProviderOverrides,
    updateProviderOverride,
} from './providerOverrides';
// RETIRED_MODELS is re-exported for callers that only need the map.
export { RETIRED_MODELS };
import { buildSystemPrompt, type PromptContext } from './systemPrompt';
import { toolSchemas } from './toolSchemas';
import { IMAGE_TOOLS, LIBRARY_TOOL_NAMES } from './zoteroToolDispatch';
import type { ChatProvider, ToolSchema } from './types';
import { currentUiLanguage } from '../../utils/i18n';

/** Every thinking tier a model can take, least first; each model offers its own subset. */
export const REASONING_EFFORTS = THINKING_TIERS;
export type ReasoningEffortSetting = ThinkingTier;

/**
 * The reasoning-effort field to send, if this provider and model take one.
 *
 * Returned under its chat-completions name, `reasoning_effort`; a provider on
 * the Responses wire (OpenAI, or a gateway added with that API) sends it as
 * `reasoning.effort`. A model that takes none — gpt-4o, a hand-added model
 * with no tiers — gets nothing, since the field is a 400 there.
 *
 * The setting is one for every model; each model takes its own tiers (see
 * thinkingTiers.ts), and a tier this one does not take goes out as the nearest
 * it does — GLM refuses "none" and gets "minimal", Zhipu's GLM-5.3 has no
 * "medium" and gets "high".
 *
 * This is not only a quality dial. Thinking is spent from the same output
 * budget as the answer, so on a long tool-using run a high setting can end the
 * turn inside the reasoning, with no text and no tool call to show for it.
 */
export function reasoningEffortBody(
    providerId: ProviderPresetId | string,
    model?: string,
): { extraBody: Record<string, unknown> } | Record<string, never> {
    const tiers = modelThinkingTiers(providerId, model ?? '');
    const raw = trimmedPref('reasoningEffort');
    const effort = nearestTier(isThinkingTier(raw) ? raw : 'low', tiers);
    return effort ? { extraBody: { reasoning_effort: effort } } : {};
}

/** Whether the thinking dial applies to this provider and model, preset or hand-added. */
export function providerSupportsReasoningEffort(providerId: string, model?: string): boolean {
    return modelThinkingTiers(providerId, model ?? '').length > 0;
}

/** Which pref holds the key for each chat provider. */
export const KEY_PREF_BY_PROVIDER: Record<ProviderPresetId, 'llmKeyDeepseek' | 'llmKeyOpenai' | 'llmKeyOpenrouter' | 'llmKeyZhipu' | 'llmKeyGoogle' | null> = {
    deepseek: 'llmKeyDeepseek',
    openai: 'llmKeyOpenai',
    openrouter: 'llmKeyOpenrouter',
    zhipu: 'llmKeyZhipu',
    google: 'llmKeyGoogle',
    // Runs on this machine; there is no key to hold.
    ollama: null,
};

/**
 * The key preference behind a provider id read from a preference (a plain
 * string): `undefined` for an id that is not a preset, `null` for a keyless one.
 */
export function keyPrefForProvider(
    providerId: string,
): (typeof KEY_PREF_BY_PROVIDER)[ProviderPresetId] | undefined {
    return (KEY_PREF_BY_PROVIDER as Record<string, (typeof KEY_PREF_BY_PROVIDER)[ProviderPresetId] | undefined>)[providerId];
}

/**
 * Whether conversations, runs and settings live in this install's own
 * database rather than on a Beaver account.
 *
 * Always true here: this build has no account to fall back to. It is a
 * separate question from `isAgentConfigured()` — an install with no API key
 * yet still owns its history, and routing storage by "is a model configured"
 * sent a fresh or freshly-synced setup to a sign-in server that does not
 * exist, surfacing as a connection failure instead of "paste your key".
 */
export function isLocalBrain(): boolean {
    return true;
}

/** Ollama's address when nothing was typed on its card. */
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** Ollama's base URL as the user configured it, without a trailing slash. */
export function ollamaBaseUrlFromPrefs(): string {
    const raw = trimmedPref('ollamaBaseUrl') || DEFAULT_OLLAMA_BASE_URL;
    return raw.replace(/\/+$/, '');
}

/** The OpenAI-compatible root Ollama serves under its base URL. */
export function ollamaApiBaseUrl(): string {
    const base = ollamaBaseUrlFromPrefs();
    return base.endsWith('/v1') ? base : `${base}/v1`;
}

/**
 * `fetch`, bound to its global.
 *
 * In Zotero's privileged context `fetch` is a Window method: passing the bare
 * reference around throws "'fetch' called on an object that does not implement
 * interface Window" at call time, not at hand-off — so the failure surfaces deep
 * inside whatever used it. This has bitten three separate call paths, which is
 * why it is the default here rather than each caller's responsibility.
 */
export const boundFetch = ((url: string, init?: any) => fetch(url, init)) as typeof fetch;

function trimmedPref(key: Parameters<typeof getPref>[0]): string {
    const value = getPref(key);
    return typeof value === 'string' ? value.trim() : '';
}

export interface AgentConfigProblem {
    /** What the user has to do, phrased for a settings panel. */
    message: string;
    /** True when the fix is entering a key rather than a broader misconfiguration. */
    needsKey: boolean;
    /** The Settings tab where it is fixed: every model and key lives under Model. */
    settingsTab: 'models';
}

/** Where every model and key is set up, as a problem message names it. */
const PROVIDERS_SETTING = 'Settings → Model → Providers';

export type AgentConfigResult =
    | {
          ok: true;
          provider: ChatProvider;
          tools: ToolSchema[];
          /** Present only when semantic search is usable. */
          embeddings: EmbeddingProvider | null;
          /** Passed to the run so the UI can surface them. */
          warnings: Array<{ type: string; message: string }>;
          /** The output cap each request carries, for the warning when a reply reaches it. */
          outputTokenLimit: number;
          /**
           * Whether the chosen model reads images. The image tools are left out
           * of `tools` when it does not, and the dispatcher should refuse them
           * too (`DataProviderDispatcherOptions.readsImages`).
           */
          readsImages: boolean;
      }
    | { ok: false; problem: AgentConfigProblem };

/** Is the plugin configured enough to run at all? Cheap; safe to call in render. */
export function isAgentConfigured(): boolean {
    const providerId = retireChoice(trimmedPref('llmProvider'), '').provider;
    // A hand-added endpoint is configured when it exists and names a model;
    // its key is optional, since a server on this computer usually takes none.
    if (isCustomProviderId(providerId)) {
        const endpoint = findCustomEndpoint(providerId);
        const model = trimmedPref('llmModel');
        return !!endpoint && !!endpoint.baseUrl && !!model && findCustomModel(endpoint, model) !== null;
    }
    if (!providerId || !(providerId in PROVIDER_PRESETS)) return false;
    const keyPref = keyPrefForProvider(providerId);
    if (keyPref === undefined) return false;
    return keyPref === null || trimmedPref(keyPref).length > 0;
}

/**
 * Where topic search stands, and why.
 *
 * `off` is the user's own choice — no embedding provider picked — and not a
 * fault. The other two unusable states are faults with a fix: a cloud provider
 * chosen without its vendor's key on this computer (the choice syncs, keys do
 * not, so this is the normal state of a second machine), or an Ollama that did
 * not answer its last probe.
 */
export type SemanticSearchState =
    | { status: 'ready'; provider: EmbeddingPresetId }
    | { status: 'off' }
    | { status: 'needs_key'; provider: Exclude<EmbeddingPresetId, 'ollama'>; label: string }
    | { status: 'unreachable'; provider: 'ollama'; reason: string };

export function semanticSearchState(): SemanticSearchState {
    const id = trimmedPref('embeddingProvider');
    if (!id || !(id in EMBEDDING_PRESETS)) return { status: 'off' };
    // Embeddings reuse the chat key for the same vendor (Google's may have one
    // of its own); Ollama needs none — but it has to be running, with the
    // model installed, which only a probe can tell (see
    // refreshSemanticSearchAvailability). Until the first probe the answer is
    // optimistic; every run probes before it builds its prompt.
    if (id === 'ollama') {
        return ollamaEmbeddingProbe && !ollamaEmbeddingProbe.ok
            ? { status: 'unreachable', provider: 'ollama', reason: ollamaEmbeddingProbe.reason }
            : { status: 'ready', provider: 'ollama' };
    }
    const provider = id as Exclude<EmbeddingPresetId, 'ollama'>;
    if (embeddingKeyFor(provider)) return { status: 'ready', provider };
    return { status: 'needs_key', provider, label: EMBEDDING_PRESETS[provider].label };
}

/**
 * The preferences an embedding option can take its key from, the one that
 * wins first: Google's own embedding key, then the Gemini card's; for the
 * others, the vendor's chat key. None for Ollama.
 */
export function embeddingKeyPrefs(id: EmbeddingPresetId): Array<'embeddingKeyGoogle' | NonNullable<ReturnType<typeof keyPrefForProvider>>> {
    if (id === 'ollama') return [];
    if (id === 'google') return ['embeddingKeyGoogle', 'llmKeyGoogle'];
    const keyPref = keyPrefForProvider(id);
    return keyPref ? [keyPref] : [];
}

/** The key an embedding option is used with, or empty when there is none. */
export function embeddingKeyFor(id: EmbeddingPresetId): string {
    for (const pref of embeddingKeyPrefs(id)) {
        const key = trimmedPref(pref);
        if (key) return key;
    }
    return '';
}

/**
 * Whether semantic search can run.
 *
 * Kept separate because it is a *capability* question, not a validity one: an
 * agent with no embedding provider is perfectly usable, it just cannot search
 * by topic — and the prompt has to say so, or the model reads an empty result
 * as evidence the library holds nothing on the subject.
 */
export function isSemanticSearchAvailable(): boolean {
    return semanticSearchState().status === 'ready';
}

/** Last look at the local embedding server: is it there, with the model? */
let ollamaEmbeddingProbe: { checkedAt: number; ok: boolean; reason: string } | null = null;
const OLLAMA_PROBE_TTL_MS = 15_000;

/**
 * Re-check whether semantic search can run *right now*, and cache the answer
 * briefly. For a cloud provider this is the preference check. For Ollama it
 * asks the server for its installed models: a chosen-but-absent Ollama has to
 * read exactly like "no embedding provider" — same prompt, same tool set —
 * or the model is handed a topic search that returns nothing and concludes
 * the library holds nothing on the subject.
 */
export async function refreshSemanticSearchAvailability(
    fetchImpl: (url: string, init?: any) => Promise<any> = (url, init) => fetch(url, init),
): Promise<boolean> {
    if (trimmedPref('embeddingProvider') !== 'ollama') return isSemanticSearchAvailable();
    const now = Date.now();
    if (ollamaEmbeddingProbe && now - ollamaEmbeddingProbe.checkedAt < OLLAMA_PROBE_TTL_MS) {
        return ollamaEmbeddingProbe.ok;
    }
    const model = EMBEDDING_PRESETS.ollama.model;
    const base = ollamaBaseUrlFromPrefs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    let ok = false;
    let reason = '';
    try {
        const response = await fetchImpl(`${base}/api/tags`, { signal: controller.signal });
        if (!response.ok) {
            reason = `Ollama answered ${response.status}`;
        } else {
            const tags = await response.json();
            const names: string[] = (Array.isArray(tags?.models) ? tags.models : [])
                .map((m: any) => String(m?.name ?? m?.model ?? ''));
            ok = names.some((n) => n === model || n === `${model}:latest` || n.startsWith(`${model}:`));
            if (!ok) {
                reason = `the ${model} model is not installed in Ollama — Get it under Settings → Model → `
                    + 'Topic and full-text search';
            }
        }
    } catch {
        // The address on the Ollama card may be another machine.
        reason = base === DEFAULT_OLLAMA_BASE_URL
            ? 'Ollama is not running on this computer'
            : `Ollama is not running at ${base}`;
    } finally {
        clearTimeout(timer);
    }
    ollamaEmbeddingProbe = { checkedAt: now, ok, reason };
    return ok;
}

/**
 * Check, now, whether one model reads images — pressed by the user, never
 * scheduled. A preset model gets the probe's verdict recorded where the
 * picker's "reads figures" reads it; a hand-added model gets its own switch
 * set and the evidence kept beside it. A preset that declares its answer is
 * reported as declared, without a request.
 */
export async function checkModelVision(
    providerId: string,
    model: string,
    fetchImpl: (url: string, init?: any) => Promise<any> = (url, init) => fetch(url, init),
): Promise<{ verdict: VisionProbeVerdict; applied: boolean }> {
    if (isCustomProviderId(providerId)) {
        const endpoint = findCustomEndpoint(providerId);
        if (!endpoint || !findCustomModel(endpoint, model)) {
            return {
                verdict: { seesImages: false, checkedAt: Date.now(), detail: 'this model is no longer on the endpoint' },
                applied: false,
            };
        }
        const verdict = await probeVision(
            { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, authStyle: endpoint.authStyle, model },
            fetchImpl,
        );
        const applied = updateCustomModel(providerId, model, {
            supportsVision: verdict.seesImages,
            visionChecked: { at: verdict.checkedAt, seesImages: verdict.seesImages, detail: verdict.detail },
        });
        // Same line the preset path writes, so a log shows every request this
        // probe ever made — and that none was made without a Check.
        logger(`visionProbe: ${providerId}/${model} reads images: ${verdict.seesImages} (${verdict.detail})`, 2);
        return { verdict, applied };
    }
    if (!visionProbeApplies(providerId, model)) {
        const { verdict } = await refreshVisionCapability(providerId, model, '', fetchImpl);
        return { verdict, applied: false };
    }
    const keyPref = keyPrefForProvider(providerId);
    const apiKey = keyPref ? trimmedPref(keyPref) : '';
    const { verdict } = await refreshVisionCapability(providerId, model, apiKey, fetchImpl, { force: true });
    return { verdict, applied: !!apiKey };
}

/**
 * Why topic search is off, in words the user can act on; empty when it is on.
 *
 * A provider that is chosen but unusable is named as such: reporting it as
 * "none configured" sends the user looking for a choice they already made,
 * while the fix is a key on this computer or a server to start.
 */
export function semanticSearchUnavailableReason(): string {
    const state = semanticSearchState();
    switch (state.status) {
        case 'ready':
            return '';
        case 'needs_key':
            return `Topic search is off: embeddings are set to ${state.label}, but this computer has no `
                + `${state.label} API key. Add it under ${PROVIDERS_SETTING} (keys are stored per computer). `
                + 'Keyword and metadata search still work.';
        case 'unreachable':
            return `Topic search is off: ${state.reason}. Keyword and metadata search still work.`;
        case 'off':
            return 'Topic search is off: no embedding provider is chosen (Settings → Model → Topic and '
                + 'full-text search). Keyword and metadata search still work.';
    }
}

/** Test seam: forget the last probe. */
export function resetSemanticSearchProbe(): void {
    ollamaEmbeddingProbe = null;
}

/**
 * Whether a model reads images: a preset's declared or checked answer for
 * that model, or a hand-added model's own "Reads figures" switch — the same
 * answer the model picker shows as "reads figures".
 *
 * The image tools are offered, and described, only when it is true. A
 * text-only endpoint handed a picture either rejects the whole request or
 * drops the picture silently, and the model then describes a page it never
 * saw.
 */
export function modelReadsImages(providerId: string, model: string): boolean {
    if (isCustomProviderId(providerId)) {
        return customModelCapabilities(providerId, model)?.supportsVision === true;
    }
    if (!(providerId in PROVIDER_PRESETS)) return false;
    return presetSupportsVision(providerId as ProviderPresetId, model || undefined) === true;
}

/** `modelReadsImages` for the model the settings choose now. */
export function currentModelReadsImages(): boolean {
    const stored = retireChoice(trimmedPref('llmProvider'), trimmedPref('llmModel'));
    // A "reads figures" flag declared in a provider's catalogue is read from
    // where hydration puts it.
    hydrateProviderOverrides();
    return modelReadsImages(stored.provider, stored.model);
}

/**
 * Move the global base URL older versions kept (`llmBaseUrl`) onto the
 * provider it redirects, once, and clear it.
 *
 * That field applied to whichever provider happened to be selected, and it
 * was checked before each preset's own address — so a relay typed for one
 * vendor silently redirected every provider added later, Ollama included,
 * while each card's Test used the card's address and passed. No setting shows
 * it any more.
 *
 * It moves to the selected built-in provider, the one it is redirecting right
 * now, onto the address its card shows and its Test uses: the provider's own
 * address override, or for Ollama the Address on the Ollama card. Chat keeps
 * the address it uses today; what was invisible becomes visible and removable
 * on the card; and no other provider is ever sent there again.
 *
 * Two cases drop it instead. A preset with an address override of its own
 * never used it, since the override is checked first. An Ollama card with an
 * address already keeps that one: it is what the card, its Detect button and
 * the embedding probe use, so it is the address the user can see working.
 *
 * Left alone while no built-in provider is selected: a hand-added endpoint
 * carries its own address and was never redirected.
 */
export function migrateLegacyBaseUrl(): void {
    const legacy = trimmedPref('llmBaseUrl').replace(/\/+$/, '');
    if (!legacy) return;
    const providerId = retireChoice(trimmedPref('llmProvider'), '').provider;
    if (!(providerId in PROVIDER_PRESETS)) return;
    const preset = providerId as ProviderPresetId;
    try {
        if (preset === 'ollama') {
            const server = legacy.replace(/\/v1$/, '');
            const current = trimmedPref('ollamaBaseUrl').replace(/\/+$/, '');
            if (server !== DEFAULT_OLLAMA_BASE_URL && (!current || current === DEFAULT_OLLAMA_BASE_URL)) {
                setPref('ollamaBaseUrl', server);
            }
        } else if (!baseUrlOverrideFor(preset) && legacy !== PROVIDER_PRESETS[preset].baseUrl.replace(/\/+$/, '')) {
            updateProviderOverride(preset, { baseUrl: legacy });
        }
        setPref('llmBaseUrl', '');
        logger(`agentConfig: moved the legacy global base URL onto ${preset}`, 2);
    } catch (error) {
        logger(`agentConfig: could not move the legacy global base URL onto ${preset}: ${error}`, 1);
    }
}

/**
 * An embedding provider for a preset, with the key it uses. Ollama is reached
 * at the address on its card — the one the availability probe and the setup
 * guide ask — rather than at the preset's default.
 *
 * Every request's outcome is recorded (embeddingHealth.ts), which is how the
 * chat and Settings learn that topic search is failing. A Google key is also
 * paced while the API reports it on the free tier (embeddingQuota.ts).
 */
function embeddingProviderForPreset(id: EmbeddingPresetId, fetchImpl: typeof fetch): EmbeddingProvider {
    const preset = EMBEDDING_PRESETS[id];
    const apiKey = embeddingKeyFor(id);
    const pacing = id === 'google' && apiKey ? geminiIndexPacing(apiKey, preset.label) : null;
    const onRequest = (outcome: EmbeddingRequestOutcome) => {
        try {
            noteEmbeddingOutcome(preset.model, preset.label, outcome);
            pacing?.onRequest(outcome);
        } catch (error) {
            logger(`agentConfig: could not record an embedding outcome: ${error}`, 1);
        }
    };
    return embeddingProviderFromPreset(id, apiKey, fetchImpl as any, {
        ...(id === 'ollama' ? { baseUrl: ollamaApiBaseUrl() } : {}),
        onRequest,
        ...(pacing ? { beforeIndexBatch: pacing.beforeIndexBatch } : {}),
    });
}

/**
 * Build the agent from stored settings.
 *
 * Returns a problem rather than throwing: the caller renders it in the chat
 * panel, where an actionable sentence is far more use than a stack trace.
 */
export interface BuildAgentOptions {
    /**
     * Use the model configured for the reader's selection popup, when one is.
     *
     * Falls back to the main model rather than failing: an unset selection model
     * means "same as the sidebar", not "no model".
     */
    surface?: 'main' | 'selection';
}

export function buildAgentFromPrefs(
    fetchImpl: typeof fetch = boundFetch,
    options: BuildAgentOptions = {},
): AgentConfigResult {
    /*
     * One model, whichever surface asked.
     *
     * The reader's selection popup used to be able to run on a model of its
     * own, on the reasoning that it wants a fast, short answer. In practice it
     * only ever forked: the user changes the model in the sidebar, asks a
     * question from a highlight, and gets an answer from the model they thought
     * they had just stopped using — with nothing on screen saying which one
     * replied. Following the sidebar is the behaviour that matches what the
     * user can see.
     */
    // A stored pair may name a retired provider or model; it runs as its
    // successor, the same resolution the composer shows.
    const stored = retireChoice(trimmedPref('llmProvider'), trimmedPref('llmModel'));
    const providerId = stored.provider;

    if (!providerId) {
        return {
            ok: false,
            problem: {
                message: `No model is set up yet. Add a provider and paste its API key under ${PROVIDERS_SETTING}.`,
                needsKey: true,
                settingsTab: 'models',
            },
        };
    }
    if (isCustomProviderId(providerId)) {
        const endpoint = findCustomEndpoint(providerId);
        if (!endpoint) {
            return {
                ok: false,
                problem: {
                    // Endpoints carry keys, so they stay on the computer they
                    // were added on while the model choice syncs: this is the
                    // normal state of a second machine.
                    message: 'The chosen model belongs to a custom provider that is not set up on this computer. '
                        + `Add it under ${PROVIDERS_SETTING} → Add custom provider, or pick another model.`,
                    needsKey: true,
                    settingsTab: 'models',
                },
            };
        }
        const modelId = stored.model;
        if (!modelId || !findCustomModel(endpoint, modelId)) {
            return {
                ok: false,
                problem: {
                    message: `"${modelId || '(none)'}" is not one of the models of ${endpoint.name || endpoint.baseUrl}. `
                        + `Add it to that provider's card under ${PROVIDERS_SETTING}, or pick another model.`,
                    needsKey: false,
                    settingsTab: 'models',
                },
            };
        }
        // A model's own declared cap is both its default and its ceiling: it is
        // usually there because the endpoint refuses more.
        const declared = findCustomModel(endpoint, modelId)?.maxTokens;
        const outputTokens = resolveOutputTokens(
            readRunLimits().outputTokens,
            declared ?? DEFAULT_CUSTOM_MAX_TOKENS,
            declared,
        );
        return finishAgentConfig(
            customProviderFromEndpoint(endpoint, modelId, fetchImpl as any, {
                ...reasoningEffortBody(providerId, modelId),
                maxTokens: outputTokens,
            }),
            fetchImpl,
            outputTokens,
            modelReadsImages(providerId, modelId),
        );
    }

    if (!(providerId in PROVIDER_PRESETS)) {
        return {
            ok: false,
            problem: {
                message: `The chosen provider "${providerId}" is not one this version knows. `
                    + `Pick another model, or add a provider under ${PROVIDERS_SETTING}.`,
                needsKey: false,
                settingsTab: 'models',
            },
        };
    }

    const keyPref = keyPrefForProvider(providerId);
    const apiKey = keyPref ? trimmedPref(keyPref) : '';
    if (keyPref && !apiKey) {
        const label = PROVIDER_PRESETS[providerId as ProviderPresetId].label;
        return {
            ok: false,
            problem: {
                // Keys stay on the computer they were pasted on while the model
                // choice syncs, so with sync on this is the normal state of a
                // second machine — worth saying, and only then. With no key
                // here the provider has no card yet, so the way in is Add provider.
                message: `${label} needs an API key on this computer. Paste it into its card under `
                    + `${PROVIDERS_SETTING} (Add provider, if it has no card here yet).`
                    + (conversationSyncMode() !== 'off'
                        ? ' Keys are stored per computer: the model choice syncs, the key does not.'
                        : ''),
                needsKey: true,
                settingsTab: 'models',
            },
        };
    }

    // A stored model that has since been retired resolves to its successor
    // instead of 404ing every request (see RETIRED_MODELS).
    const modelOverride = stored.model;
    // The provider's own address override first (its catalogue's declared
    // capabilities ride along); Ollama's address is its own setting. A global
    // address from older versions is moved onto the provider it redirects
    // before either is read.
    migrateLegacyBaseUrl();
    const overrides = readProviderOverrides();
    hydrateProviderOverrides(overrides);
    const baseUrlOverride = baseUrlOverrideFor(providerId, overrides)
        || (providerId === 'ollama' ? ollamaApiBaseUrl() : '');

    // What one reply may spend: the user's setting, or the provider's default,
    // held under what the provider accepts. A provider whose models think
    // before answering spends part of this on the thinking, so its default is
    // sized for both; too little ends the turn inside the reasoning with
    // neither text nor a tool call to show for it. The ceiling is the chosen
    // model's: one preset can host models with very different limits. A
    // budget set for the model itself, on its card, is its default and its
    // ceiling both, as a hand-added model's is.
    const caps = presetCapabilities(providerId as ProviderPresetId, modelOverride || undefined);
    const ownBudget = presetModelOutputTokens(providerId, modelOverride, overrides);
    const outputTokens = resolveOutputTokens(
        readRunLimits().outputTokens,
        ownBudget ?? caps.defaultMaxTokens ?? 4000,
        ownBudget !== undefined && caps.maxOutputTokens !== undefined
            ? Math.min(ownBudget, caps.maxOutputTokens)
            : ownBudget ?? caps.maxOutputTokens,
    );
    const tiers = modelThinkingTiers(providerId, modelOverride, overrides);
    const provider = providerFromPreset(
        providerId as ProviderPresetId,
        apiKey,
        fetchImpl as any,
        {
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(baseUrlOverride ? { baseUrl: baseUrlOverride } : {}),
            ...reasoningEffortBody(providerId as ProviderPresetId, modelOverride || undefined),
            supportsReasoningEffort: tiers.length > 0,
            ...(tiers.length > 0 ? { leastReasoningEffort: tiers[0] } : {}),
            maxTokens: outputTokens,
        },
    );
    return finishAgentConfig(provider, fetchImpl, outputTokens, modelReadsImages(providerId, modelOverride));
}

/**
 * The context window of the model the next question will use, when the user
 * or its preset knows it. Read where a conversation is compacted.
 */
export function currentModelContextWindow(): number | undefined {
    const { provider, model } = retireChoice(trimmedPref('llmProvider'), trimmedPref('llmModel'));
    return provider ? modelContextWindow(provider, model) : undefined;
}

/** Everything after the chat provider: embeddings, warnings, and the tool set. */
function finishAgentConfig(
    provider: ChatProvider,
    fetchImpl: typeof fetch,
    outputTokenLimit: number,
    readsImages: boolean,
): AgentConfigResult {
    const semantic = semanticSearchState();
    const semanticAvailable = semantic.status === 'ready';
    const embeddings = semantic.status === 'ready' ? embeddingProviderForPreset(semantic.provider, fetchImpl) : null;

    /*
     * Topic search is flagged only when it is broken, not when it is off.
     *
     * A user who left the embedding provider off chose that, and the setting
     * already says what it means; a note above every answer repeating it is
     * noise. A provider that is chosen and cannot be used is a fault with a
     * fix, and the note says which. Either way the model is told in the system
     * prompt.
     */
    const warnings: Array<{ type: string; message: string }> = [];
    if (semantic.status === 'needs_key' || semantic.status === 'unreachable') {
        warnings.push({
            type: 'semantic_search_unavailable',
            message: semanticSearchUnavailableReason(),
        });
    }

    return {
        ok: true,
        provider,
        // The topic tool is withheld rather than offered-and-broken: a tool that
        // always returns nothing teaches the model the library is empty. The
        // image tools are withheld from a model that cannot read what they
        // return.
        tools: toolSchemas(
            LIBRARY_TOOL_NAMES.filter((name) =>
                (semanticAvailable || name !== 'item_search_by_topic')
                && (readsImages || !IMAGE_TOOLS.has(name))),
        ),
        embeddings,
        warnings,
        outputTokenLimit,
        readsImages,
    };
}

/**
 * System prompt for a run, with the current configuration folded in.
 *
 * Each input here is a setting, not something about the turn, so the prompt
 * stays identical from one message to the next until the user changes one.
 */
export function buildAgentSystemPrompt(
    context: Omit<PromptContext, 'semanticSearchAvailable' | 'literatureLookups' | 'writesAllowed' | 'readsImages' | 'interfaceLanguage'> = {},
): string {
    return buildSystemPrompt({
        ...context,
        semanticSearchAvailable: isSemanticSearchAvailable(),
        literatureLookups: readRunLimits().literatureLookups,
        // The same preference that decides whether the write tools are offered.
        writesAllowed: getPref('allowAgentWrites') === true,
        readsImages: currentModelReadsImages(),
        interfaceLanguage: currentUiLanguage(),
    });
}

/**
 * The configured embedding provider, or null when topic search is off.
 *
 * Separate from `buildAgentFromPrefs` because the indexer needs embeddings
 * without needing a chat model: indexing a library and answering a question are
 * different jobs that happen to share a settings page.
 */
export function buildEmbeddingProviderFromPrefs(
    fetchImpl: typeof fetch = boundFetch,
): EmbeddingProvider | null {
    const semantic = semanticSearchState();
    return semantic.status === 'ready' ? embeddingProviderForPreset(semantic.provider, fetchImpl) : null;
}

/**
 * A provider for a given preset, whatever the settings choose — with its key,
 * the health record and the pacing, as the indexers get it. For the dev
 * endpoints that build one model's index without switching the preference,
 * which would travel to the user's other computers with the settings.
 */
export function buildEmbeddingProviderForPreset(
    id: EmbeddingPresetId,
    fetchImpl: typeof fetch = boundFetch,
): EmbeddingProvider {
    return embeddingProviderForPreset(id, fetchImpl);
}

/**
 * The embedding model currently in use, or null when topic search is off.
 *
 * The index stores which model produced each vector, and vectors from different
 * models cannot be compared — so this is what decides whether an existing entry
 * still counts.
 */
export function currentEmbeddingModelId(): string | null {
    if (!isSemanticSearchAvailable()) return null;
    const id = trimmedPref('embeddingProvider') as EmbeddingPresetId;
    return EMBEDDING_PRESETS[id]?.model ?? null;
}


