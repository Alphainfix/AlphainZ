import { atom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { PROVIDER_PRESETS, presetSupportsVision, retireChoice, type ProviderPresetId } from '@beaver/agent-llm/openAICompatible';
import { KEY_PREF_BY_PROVIDER } from '../../src/services/llm/agentConfig';
import { hydrateVisionVerdicts } from '@beaver/agent-llm/visionProbe';
import { catalogueFor, hydrateProviderOverrides, readProviderOverrides, type CatalogueModel } from '@beaver/agent-llm/providerOverrides';
import {
    adoptSyncedEndpointId,
    customProviderId,
    findCustomEndpoint,
    findCustomModel,
    isCustomProviderId,
    readCustomEndpoints,
} from '@beaver/agent-llm/customEndpoints';
import { isOllamaEmbeddingModel, ollamaChatModels } from '../utils/ollama';
import { currentModelChoice, localModelChoices, saveModelChoice, type ModelChoiceSources } from '@beaver/agent-llm/modelChoices';

/**
 * The Ollama chat models found on this machine, if any.
 *
 * Embedding-only models are never listed: they cannot answer a question, and
 * listed, the embedding model would be picked as the chat model on a fresh install. The
 * guide and Detect models store only chat models; any other stored list is
 * filtered here by name.
 */
export function ollamaModelsFromPrefs(): string[] {
    try {
        const raw = getPref('ollamaModels');
        const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? ollamaChatModels(parsed.map(String).filter(Boolean)) : [];
    } catch {
        return [];
    }
}
/**
 * What the shared model list needs from this plugin: which providers have a
 * key in Zotero's preferences, and the Ollama models found here.
 */
const MODEL_SOURCES: ModelChoiceSources = {
    hasKey(id) {
        const keyPref = KEY_PREF_BY_PROVIDER[id];
        // `null` means the provider runs locally and needs no key.
        if (keyPref === null) return true;
        const value = getPref(keyPref);
        return typeof value === 'string' && value.trim() !== '';
    },
    ollamaModels: ollamaModelsFromPrefs,
};
import { logger } from '@beaver/agent-core/platform/logger';
import { ProviderType, ReasoningEffort, AccessMode, ModelPricing, ModelConfig } from '@beaver/agent-core/types/models';

export type { ProviderType, ReasoningEffort, AccessMode, ModelPricing, ModelConfig };

/**
 * Core atoms for model state management
 */

// Stores all models supported by the backend
const googleApiKeyAtom = atom(getPref('googleGenerativeAiApiKey') ?? '');
const openAiApiKeyAtom = atom(getPref('openAiApiKey') ?? '');
const anthropicApiKeyAtom = atom(getPref('anthropicApiKey') ?? '');

const initialLocalModels = localModelsFromPrefs();

/**
 * Every model the composer may offer: the locally configured providers only.
 * Entries from the upstream `customChatModels` preference are not listed — the
 * local runner reads its provider from `llmProvider`, so such an entry could be
 * selected but never run, and a stale one shadowed the automatic default.
 */
export const supportedModelsAtom = atom<ModelConfig[]>([...initialLocalModels]);

// Stores the currently selected model
let lastUsedModel = null;
try {
    const stored = JSON.parse(getPref('lastUsedModel')) as ModelConfig;
    // Validate that stored model has a valid id before using it
    if (!stored?.id) {
        logger('models: Stored lastUsedModel has no id, ignoring', 1);
        lastUsedModel = null;
    } else {
        // Validated against the list once the composer mounts; a stored entry
        // that is no longer offered gives way to the default there.
        lastUsedModel = stored;
    }
} catch (error) {
    lastUsedModel = null
}
/**
 * A model entry describing the locally-configured provider.
 *
 * The send path refuses to start a run with no selected model, and the real
 * list came from the backend's `model_configs`. This synthesises one entry from
 * the local preferences so the composer works before any list is fetched — and
 * it is marked `is_custom` with `allow_app_key: false`, which is the truth: the
 * call is made from this client with the user's own key, and no credits are
 * involved.
 */
/**
 * Every model the stored keys make reachable, as composer entries.
 *
 * The composer's list came from the backend's `model_configs`, so with no
 * backend it held exactly one entry — whichever provider the settings panel had
 * last written. Switching model meant opening settings, which is not where
 * anyone looks for it, and a second provider's models never appeared at all
 * despite a key being present.
 *
 * Derived from the same presets and key preferences the runner reads, so the
 * list cannot drift from what would actually answer.
 */
export function localModelsFromPrefs(): ModelConfig[] {
    return localModelChoices(MODEL_SOURCES);
}

/** The model the preferences name, as a picker entry; null when none is chosen. */
export function localModelFromPrefs(): ModelConfig | null {
    return currentModelChoice();
}

/*
 * Preferences win over the stored snapshot, for a locally-configured model.
 *
 * `lastUsedModel` is a JSON snapshot the picker writes; `llmProvider` /
 * `llmModel` are what the runner actually reads. They are written together by
 * the picker, so normally they agree — but anything that moves the preferences
 * on their own (the settings page, a restored profile, a test) left the
 * snapshot behind, and then the request went to one model while the composer
 * and the run record named another. Observed exactly that: a run answering
 * "I am ox-alpha" recorded as DeepSeek.
 *
 * A `local-*` entry is *derived* from those two preferences, so when they
 * disagree the snapshot is simply out of date. A model the user typed in
 * carries its own base URL and cannot be rebuilt from preferences, so its
 * snapshot still wins.
 */
const storedIsDerived = !lastUsedModel || String(lastUsedModel.id ?? '').startsWith('local-');

/*
 * ...and it has to be the *same object the picker lists*, not an equivalent one.
 *
 * `localModelFromPrefs` synthesises `local-deepseek`; the picker's list is
 * built by `localModelsFromPrefs`, whose ids read `local-deepseek::deepseek-
 * vision`. Both describe the same model and neither matches the other, so on
 * every start the menu could not find the current entry to mark — the setting
 * said one thing and the picker showed another. Match on the pair the two
 * agree about and hand back the list's own entry.
 */
function selectedModelFromPrefs(): ModelConfig | null {
    const chosen = localModelFromPrefs();
    if (!chosen) return null;
    const listed = initialLocalModels.find((model) => model.id === chosen.id);
    return listed ?? chosen;
}

export const selectedModelAtom = atom<ModelConfig | null>(
    storedIsDerived ? (selectedModelFromPrefs() ?? lastUsedModel) : lastUsedModel,
);

/**
 * Derived atom that indicates if the selected model uses the app's API key
 */
export const isAppKeyModelAtom = atom((get) => get(selectedModelAtom)?.allow_app_key || false);

/**
 * Derived atom that indicates if the user is consuming AlphainZ credits (app_key)
 * vs their own API costs (byok/custom). Based on the actual selected access_mode,
 * not just model capability.
 */
export const isUsingBeaverCreditsAtom = atom((get) => {
    const model = get(selectedModelAtom);
    // No model yet is the fresh-install state, and there are no credits here.
    if (!model) return false;
    return model.access_mode === 'app_key' || (!model.access_mode && model.allow_app_key);
});

/**
 * The models the composer may offer. Every entry is locally configured — the
 * key check happened when the list was built — so this is the supported list.
 */
export const availableModelsAtom = atom((get) => get(supportedModelsAtom));


/**
 * Derived atom that returns the default Beaver model from the available models
 */
export const beaverDefaultModelAtom = atom<ModelConfig | null>(
    get => {
        const beaverModels = get(availableModelsAtom).filter((m) => m.allow_app_key && !m.is_custom);
        return beaverModels.find((m) => m.is_default) ?? beaverModels[0] ?? null;
    }
);

/**
 * Validation atom that ensures the selected model is still available
 * If current model is invalid, switches to default model or first available model
 */
/**
 * Write a locally-configured choice to the preferences the runner reads. Only
 * for the `local-` entries; anything else has no preference pair to write.
 */
function persistLocalModelChoice(model: ModelConfig | null): void {
    saveModelChoice(model);
}

/**
 * Keep the composer's selection in step with the preferences the runner reads.
 *
 * `llmProvider` / `llmModel` are the source of truth: the runner reads them
 * and nothing else. The selection and the `lastUsedModel` snapshot follow
 * them — never the other way round. Writing the selection back over the
 * preferences looked harmless but undid every change made elsewhere: settings
 * sync landing on this computer, the settings window writing provider then
 * model as two preferences, a test. Each write woke a refresh that found the
 * old selection, "validated" it, and persisted it over the new value.
 *
 * Only when the preferences name nothing — a fresh install whose first key
 * was just pasted — does this pick a default and write it, so the very first
 * message has a model to run on.
 */
export const validateSelectedModelAtom = atom(
    null,
    (get, set) => {
        // A synced choice naming this computer's copy of a hand-added
        // endpoint by the other computer's id: file the endpoint under that
        // id first, so the list and the choice agree.
        if (adoptSyncedChoice()) set(supportedModelsAtom, withFreshLocalModels(get(supportedModelsAtom)));

        const selectedModel = get(selectedModelAtom);
        let fromPrefs = localModelFromPrefs();

        // An Ollama embedding model cannot chat, so a stored choice of one is
        // no choice at all: every question would fail. Pick again below.
        if (fromPrefs && String(fromPrefs.provider) === 'ollama' && isOllamaEmbeddingModel(String(fromPrefs.snapshot ?? ''))) {
            logger(`models: ${fromPrefs.snapshot} only embeds text; choosing a chat model instead`, 2);
            setPref('llmProvider', '');
            setPref('llmModel', '');
            fromPrefs = null;
        }

        if (fromPrefs) {
            /*
             * A stored pair naming a retired provider or model resolved to its
             * successor above; write that back, so the settings page, the
             * picker and the synced settings document all name the model that
             * actually answers rather than one surface showing the old id.
             */
            persistLocalModelChoice(fromPrefs);
            const supported = get(supportedModelsAtom);
            const listed = supported.find((model) => model.id === fromPrefs.id);
            // A model name outside the preset catalogue (typed into the
            // settings), or a provider whose key is not on this computer, is
            // still what will run — or be reported as missing — so it is
            // offered as its own entry rather than replaced by something else.
            if (!listed) set(supportedModelsAtom, [...supported, fromPrefs]);
            const next = withAccessMode(listed ?? fromPrefs);
            if (selectedModel?.id !== next.id) set(selectedModelAtom, next);
            rememberSelection(next);
            return;
        }

        // No provider chosen yet. Keep a remembered entry that is still on
        // offer, else take the first one — and tell the runner either way.
        const availableModels = get(availableModelsAtom);
        if (availableModels.length === 0) {
            // Nothing to pick. A selection drawn from the preferences, which
            // no longer name it (its provider was just removed), is dropped
            // with its snapshot: the composer then reads "None Selected", as on
            // a fresh install, instead of naming a model nothing here can run,
            // now or after a restart.
            if (selectedModel?.id.startsWith('local-')) {
                set(selectedModelAtom, null);
                forgetSelection();
            }
            return;
        }
        const kept = selectedModel ? availableModels.find((model) => model.id === selectedModel.id) : null;
        const next = withAccessMode(kept ?? defaultChoice(availableModels));
        set(selectedModelAtom, next);
        rememberSelection(next);
        persistLocalModelChoice(next);
    }
);

/** What is chosen when nothing is: the list's default, else its first entry. */
function defaultChoice(models: ModelConfig[]): ModelConfig {
    return models.find((model) => model.is_default) ?? models[0];
}

const trimmedPref = (key: 'llmProvider' | 'llmModel'): string => {
    const value = getPref(key);
    return typeof value === 'string' ? value.trim() : '';
};

/** Adopt a synced custom-endpoint id (see adoptSyncedEndpointId); true when one was renamed. */
function adoptSyncedChoice(): boolean {
    const provider = trimmedPref('llmProvider');
    return isCustomProviderId(provider) && adoptSyncedEndpointId(provider, trimmedPref('llmModel'));
}

/** The list with its locally configured entries rebuilt from preferences. */
function withFreshLocalModels(current: ModelConfig[]): ModelConfig[] {
    return [...localModelsFromPrefs(), ...current.filter((model) => !model.id.startsWith('local-'))];
}

/**
 * The model that is chosen once these providers are gone from this computer,
 * or null when nothing else is configured. What the Remove dialogs name.
 */
export function modelAfterRemoving(providerIds: readonly string[]): ModelConfig | null {
    const remaining = localModelsFromPrefs().filter((model) => !providerIds.includes(String(model.provider)));
    return remaining.length > 0 ? defaultChoice(remaining) : null;
}

/**
 * After providers are removed on this computer (a key cleared, a card
 * removed, an endpoint deleted), move a model choice that used one of them to
 * the first model still on offer, or clear it when nothing is left, so the
 * next question does not go to a provider this computer just gave up.
 *
 * Only for removals made here. A choice synced from another computer whose
 * key this one lacks is kept and reported instead (see
 * validateSelectedModelAtom), since the fix there is to add the key.
 */
export const releaseRemovedProvidersAtom = atom(
    null,
    (_get, set, providerIds: readonly string[]) => {
        const inUse = retireChoice(trimmedPref('llmProvider'), trimmedPref('llmModel')).provider;
        if (inUse && providerIds.includes(inUse)) {
            logger(`models: ${inUse} was removed on this computer; choosing another model`, 2);
            setPref('llmProvider', '');
            setPref('llmModel', '');
        }
        set(refreshLocalModelAtom);
    }
);

/**
 * Keep the `lastUsedModel` snapshot in step with the selection. It is a cache
 * the picker reads at startup, not a source: the preferences decide.
 */
function rememberSelection(model: ModelConfig): void {
    const stored = getPref('lastUsedModel');
    try {
        if (typeof stored === 'string' && stored && (JSON.parse(stored) as ModelConfig).id === model.id) return;
    } catch {
        // Unreadable snapshot: rewrite it below.
    }
    setPref('lastUsedModel', JSON.stringify(model));
}

/** Drop the `lastUsedModel` snapshot, for a selection that is gone. */
function forgetSelection(): void {
    if (getPref('lastUsedModel')) setPref('lastUsedModel', '');
}

/** Every local entry is run with the user's own key: access mode `custom`. */
function withAccessMode(model: ModelConfig): ModelConfig {
    if (model.access_mode) return model;
    const access_mode: AccessMode = model.is_custom ? 'custom' : model.allow_app_key ? 'app_key' : 'byok';
    return { ...model, access_mode };
}

/**
 * Setter atom that updates supported models and validates selected model
 * This handles all atom updates when new models are provided:
 * 1. Updates supportedModelsAtom with new models
 * 2. Validates and updates selected model if needed
 */
export const setModelsAtom = atom(
    null,
    (_get, set, models: ModelConfig[]) => {
        // Update supported models
        set(supportedModelsAtom, models);

        // Validate and update selected model if needed
        set(validateSelectedModelAtom);
    }
);


/**
 * Re-read the locally-configured providers from preferences: rebuild the list
 * the composer offers, then let validation select what the preferences name.
 * Called after any change to the model or key preferences, whichever window
 * wrote them; without it the composer kept naming the previous model while the
 * runner — which reads the preferences directly — used the new one.
 */
export const refreshLocalModelAtom = atom(
    null,
    (get, set) => {
        adoptSyncedChoice();
        set(supportedModelsAtom, withFreshLocalModels(get(supportedModelsAtom)));
        set(validateSelectedModelAtom);
    }
);


// Atom to update selected model
export const updateSelectedModelAtom = atom(
    null,
    (_, set, model: ModelConfig) => {
        set(selectedModelAtom, model);
        setPref('lastUsedModel', JSON.stringify(model));
        // The runner reads `llmProvider`/`llmModel` straight from preferences
        // and never sees this atom, so a selection that stopped here would
        // relabel the composer while the next request still went to the old
        // model. Only for the locally-configured entries: a custom model the
        // user typed in has its own provider and base URL.
        persistLocalModelChoice(model);
    }
);

export const setApiKeyAtom = atom(
    null,
    (_, set, { provider, value }: { provider: ProviderType; value: string }) => {
        switch (provider) {
            case 'google':
                set(googleApiKeyAtom, value ?? '');
                break;
            case 'openai':
                set(openAiApiKeyAtom, value ?? '');
                break;
            case 'anthropic':
                set(anthropicApiKeyAtom, value ?? '');
                break;
            default:
                logger(`Unsupported provider passed to setApiKeyAtom: ${provider}`, 1);
                break;
        }
    }
);

/**
 * Reset in-memory model state to a fresh-install baseline. Used on account
 * switch.
 */
export const resetUserModelStateAtom = atom(
    null,
    (_, set) => {
        set(googleApiKeyAtom, '');
        set(openAiApiKeyAtom, '');
        set(anthropicApiKeyAtom, '');
        set(selectedModelAtom, null);
    }
);
