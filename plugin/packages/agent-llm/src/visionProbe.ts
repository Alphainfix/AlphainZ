/**
 * Asking an endpoint whether a model reads images, instead of assuming.
 *
 * A model id is not a capability. DeepSeek routes retired ids to whatever
 * model currently answers for them, and `deepseek-flash` is itself a floating
 * name — so a vision flag pinned to an id can be wrong the morning the vendor
 * moves it, and everything keyed on it (the picker's "reads figures", whether
 * an image may be attached, whether a scanned PDF is worth offering) is wrong
 * with it. The endpoint itself is the only source that is right on both sides
 * of such a switch; this is what the Check button asks it.
 *
 * The probe is one tiny request: a small picture of a three-digit number and
 * the instruction to reply with that number. A model that reads images answers
 * it; one that does not says so, or makes a number up — and a made-up number
 * is not this one. The first cut asked for two colours instead, and a text
 * model guessed "red" and "blue" from the wording alone, which read as a yes.
 * Digits leave nothing to guess, and the endpoint's own token count is the
 * second witness: an image that was actually read is billed, so the prompt
 * comes back well above its text-only size. Thinking is turned off and the
 * answer capped, so a probe costs a few hundred tokens. It runs when the user
 * presses Check — a model's ability to read images is not something to spend
 * their key on unasked — and the verdict is kept in a preference so it stands
 * across restarts until the next Check.
 */

import { getPref, setPref } from './prefs';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    PROVIDER_PRESETS,
    presetSupportsVision,
    presetVisionByProbe,
    recordProbedVision,
    type ProviderPresetId,
} from './openAICompatible';
import { modelThinkingTiers } from './modelTuning';
import type { AuthStyle, WireFormat } from './types';

/** The number drawn in the probe image, in block digits. Never written into the prompt. */
export const PROBE_CODE = '593';

/** 138×66 PNG: `PROBE_CODE` in black block digits on white. */
export const PROBE_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIoAAABCCAIAAAAHXtnqAAAAu0lEQVR42u3YwRGAMAhFQfpvWnuIhvww+xpA2QuTehRcWQEe4cEjPMKDR3jwCI/wDOWpbS1+dPys36bjwYMHDx48ePB85mk9LrctOv8v8ODBgwcPHjx4Th3WePDgwYMHDx48eHbz5J/IYx9k8eDBgwcPHjx4LudxWFsQHjx48ODBg2fSo+RZDDx48ODBgwcPnpzDuvNZcG1656y4J1E8ePDgwYMHDx71n+NWgEd48AiP8OARHjzCIzz39QKEVpYjgtIewgAAAABJRU5ErkJggg==';

export const PROBE_QUESTION =
    'This message includes one image showing a number. Reply with exactly that number and nothing else. '
    + 'If no image is attached, reply exactly: NO IMAGE.';

/**
 * A prompt that was read with its image is billed for the image. The question
 * alone is about 40 tokens on DeepSeek; the picture adds well over a hundred.
 * A count below this means the image never reached the model, whatever the
 * words in the answer.
 */
export const MIN_PROMPT_TOKENS_WITH_IMAGE = 80;

/**
 * The same witness for OpenAI's models on the Responses wire, whose tokenizer
 * bills this small image far more cheaply: the question alone is 36 input
 * tokens on gpt-6-luna and gpt-6-sol, 55 with the image (measured
 * 2026-10-13).
 */
export const MIN_RESPONSES_PROMPT_TOKENS_WITH_IMAGE = 45;

/** Bump when the image or the judging changes: verdicts from an older probe are not trusted. */
export const PROBE_VERSION = 2;

/** How long a verdict stands before the endpoint is asked again. */
export const VISION_PROBE_TTL_MS = 12 * 60 * 60 * 1000;

const PROBE_TIMEOUT_MS = 20_000;

export interface VisionProbeVerdict {
    seesImages: boolean;
    checkedAt: number;
    /** What the model said, clipped — the evidence behind the verdict. */
    detail: string;
    /** Which probe produced it; see PROBE_VERSION. */
    version?: number;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

const inFlight = new Map<string, Promise<VisionProbeVerdict>>();

const key = (id: ProviderPresetId, model: string) => `${id}:${model}`;

/**
 * Read the answer and the bill, not the status.
 *
 * A text-only model answers an image request with 200 and words about not
 * seeing anything — DeepSeek's did exactly that — so only the number in the
 * picture counts as yes; a made-up number does not match it. When the endpoint
 * reports usage, a prompt billed at text-only size means the image was dropped
 * before the model saw it, and that overrides the words.
 */
export function judgeVisionAnswer(
    status: number,
    text: string,
    promptTokens?: number | null,
    minPromptTokens: number = MIN_PROMPT_TOKENS_WITH_IMAGE,
): boolean {
    if (status !== 200) return false;
    const answer = String(text ?? '');
    if (/no image/i.test(answer)) return false;
    if (!new RegExp(`(^|\\D)${PROBE_CODE}(\\D|$)`).test(answer)) return false;
    if (typeof promptTokens === 'number' && Number.isFinite(promptTokens) && promptTokens < minPromptTokens) {
        return false;
    }
    return true;
}

function readCache(): Record<string, VisionProbeVerdict> {
    try {
        const raw = getPref('visionProbeCache');
        const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeCache(cache: Record<string, VisionProbeVerdict>): void {
    try {
        setPref('visionProbeCache', JSON.stringify(cache));
    } catch (error) {
        logger(`visionProbe: could not persist the verdict: ${error}`, 1);
    }
}

/**
 * Put every stored verdict back where `presetSupportsVision` reads it. Called
 * when the model list is built, so a restart shows the same "reads figures"
 * the last Check earned without asking the endpoint again.
 */
export function hydrateVisionVerdicts(): void {
    for (const [k, entry] of Object.entries(readCache())) {
        if (!entry || typeof entry.seesImages !== 'boolean' || entry.version !== PROBE_VERSION) continue;
        const colon = k.indexOf(':');
        if (colon <= 0) continue;
        const providerId = k.slice(0, colon) as ProviderPresetId;
        const model = k.slice(colon + 1);
        if (providerId in PROVIDER_PRESETS && model) recordProbedVision(providerId, model, entry.seesImages);
    }
}

/** Whether this preset:model is one the endpoint is asked about. */
export function visionProbeApplies(providerId: string, model: string): providerId is ProviderPresetId {
    return !!model && providerId in PROVIDER_PRESETS && presetVisionByProbe(providerId as ProviderPresetId);
}

/**
 * The verdict on record for a model, fresh or stale, or null when none.
 * Re-records a cached verdict so `presetSupportsVision` agrees after a restart.
 */
export function cachedVisionVerdict(providerId: ProviderPresetId, model: string): VisionProbeVerdict | null {
    const entry = readCache()[key(providerId, model)];
    if (!entry || typeof entry.seesImages !== 'boolean') return null;
    // A verdict from an older probe was reached by rules since found wanting.
    if (entry.version !== PROBE_VERSION) return null;
    recordProbedVision(providerId, model, entry.seesImages);
    return entry;
}

/**
 * Ask the endpoint whether `model` reads images, unless a fresh verdict exists.
 *
 * Returns the verdict and whether it differs from what was on record — callers
 * that rebuild the model list only need to when something changed. A preset
 * that declares its answer is never probed. Failures (network, 4xx) read as
 * "does not see": the safe direction, since claiming vision a model lacks
 * sends pages to a model that silently ignores them.
 */
export async function refreshVisionCapability(
    providerId: string,
    model: string,
    apiKey: string,
    fetchImpl: FetchLike = (url, init) => fetch(url, init),
    options: { force?: boolean } = {},
): Promise<{ verdict: VisionProbeVerdict; changed: boolean }> {
    if (!visionProbeApplies(providerId, model)) {
        const declared = presetSupportsVision(providerId as ProviderPresetId, model) === true;
        return {
            verdict: { seesImages: declared, checkedAt: Date.now(), detail: 'declared by the preset' },
            changed: false,
        };
    }
    const k = key(providerId, model);
    const before = cachedVisionVerdict(providerId, model);
    if (before && !options.force && Date.now() - before.checkedAt < VISION_PROBE_TTL_MS) {
        return { verdict: before, changed: false };
    }
    if (!apiKey) {
        return { verdict: { seesImages: false, checkedAt: Date.now(), detail: 'no API key' }, changed: false };
    }

    let pending = inFlight.get(k);
    if (!pending) {
        const preset = PROVIDER_PRESETS[providerId] as { baseUrl: string; authStyle?: AuthStyle };
        pending = probeVision({ baseUrl: preset.baseUrl, apiKey, authStyle: preset.authStyle, model, presetId: providerId }, fetchImpl)
            .finally(() => inFlight.delete(k));
        inFlight.set(k, pending);
    }
    const verdict = await pending;
    recordProbedVision(providerId, model, verdict.seesImages);
    const cache = readCache();
    cache[k] = verdict;
    writeCache(cache);
    const changed = before === null || before.seesImages !== verdict.seesImages;
    logger(`visionProbe: ${providerId}/${model} reads images: ${verdict.seesImages} (${verdict.detail})`, changed ? 2 : 1);
    return { verdict, changed };
}

/** Where to send the probe: any OpenAI-compatible endpoint, preset or hand-added. */
export interface VisionProbeTarget {
    baseUrl: string;
    apiKey: string;
    authStyle?: AuthStyle;
    model: string;
    /**
     * The preset behind the endpoint, if any: the probe goes out on the wire
     * that preset's runs use, so a Check answers for the path a question takes.
     */
    presetId?: ProviderPresetId;
    /** A hand-added endpoint's wire, when it is not a preset's. */
    wireFormat?: WireFormat;
    /**
     * The least thinking tier the model takes, on the Responses wire, when the
     * caller knows it better than the saved settings do (a Settings card's
     * draft); null means it takes none. Left out, a preset's model is read from
     * the saved settings and a hand-added one is sent no thinking setting.
     */
    leastEffort?: string | null;
}

/**
 * The probe request on the wire a preset speaks.
 *
 * The question needs no thinking, and thinking is the expensive part of an
 * answer, so a model that takes an effort is given the least it accepts. An
 * endpoint that rejects the field answers 4xx, which reads as "does not see" —
 * the safe direction — and the Check result shows the message.
 */
function probeRequest(target: VisionProbeTarget): { path: string; body: Record<string, unknown>; minPromptTokens: number } {
    const wire: WireFormat = target.presetId
        ? (PROVIDER_PRESETS[target.presetId] as { wireFormat: WireFormat }).wireFormat
        : (target.wireFormat ?? 'openai');
    if (wire === 'openai-responses') {
        const least = target.leastEffort !== undefined
            ? target.leastEffort ?? undefined
            : target.presetId ? modelThinkingTiers(target.presetId, target.model)[0] : undefined;
        return {
            path: '/responses',
            minPromptTokens: MIN_RESPONSES_PROMPT_TOKENS_WITH_IMAGE,
            body: {
                model: target.model,
                input: [{
                    role: 'user',
                    content: [
                        { type: 'input_text', text: PROBE_QUESTION },
                        { type: 'input_image', image_url: PROBE_IMAGE_DATA_URL },
                    ],
                }],
                // A model that cannot stop thinking spends part of the cap on
                // it, and an answer cut off before the number reads as blind.
                max_output_tokens: least === undefined || least === 'none' ? 48 : 2048,
                stream: false,
                store: false,
                ...(least !== undefined ? { reasoning: { effort: least } } : {}),
            },
        };
    }
    return {
        path: '/chat/completions',
        minPromptTokens: MIN_PROMPT_TOKENS_WITH_IMAGE,
        body: {
            model: target.model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: PROBE_QUESTION },
                    { type: 'image_url', image_url: { url: PROBE_IMAGE_DATA_URL } },
                ],
            }],
            max_tokens: 48,
            stream: false,
            // Accepted by every model DeepSeek serves (verified live,
            // 2026-09-09).
            reasoning_effort: 'none',
        },
    };
}

/** The answer text, or the error's own sentence, from either wire's JSON reply. */
function probeAnswerText(body: any): string {
    if (Array.isArray(body?.output)) {
        return body.output
            .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
            .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
            .join('');
    }
    return String(body?.choices?.[0]?.message?.content ?? body?.error?.message ?? '');
}

/**
 * One probe request against any endpoint, judged. No caching here — the
 * caller decides what a verdict is worth keeping.
 */
export async function probeVision(target: VisionProbeTarget, fetchImpl: FetchLike): Promise<VisionProbeVerdict> {
    const { baseUrl, apiKey } = target;
    const auth: Record<string, string> = !apiKey
        ? {}
        : (target.authStyle ?? 'bearer') === 'x-api-key'
            ? { 'X-Api-Key': apiKey }
            : { Authorization: `Bearer ${apiKey}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const { path, body: requestBody, minPromptTokens } = probeRequest(target);
    try {
        const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
        const status = Number(response?.status ?? 0);
        let text = '';
        let promptTokens: number | null = null;
        try {
            const body = await response.json();
            text = probeAnswerText(body);
            if (!text && body?.error?.message) text = String(body.error.message);
            const reported = body?.usage?.prompt_tokens ?? body?.usage?.input_tokens;
            promptTokens = typeof reported === 'number' ? reported : null;
        } catch {
            text = '';
        }
        return {
            seesImages: judgeVisionAnswer(status, text, promptTokens, minPromptTokens),
            checkedAt: Date.now(),
            detail: `HTTP ${status}${promptTokens !== null ? ` · ${promptTokens} prompt tokens` : ''}: ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
            version: PROBE_VERSION,
        };
    } catch (error) {
        return {
            seesImages: false,
            checkedAt: Date.now(),
            detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160),
            version: PROBE_VERSION,
        };
    } finally {
        clearTimeout(timer);
    }
}
