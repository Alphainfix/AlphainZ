/**
 * What applies to one model: the thinking tiers it takes, its context window,
 * the most one answer may use.
 *
 * The user's own setting for the model wins — on a preset's card or on a
 * hand-added endpoint — and otherwise what the preset knows about the model.
 * A hand-added model knows nothing it was not told.
 */

import { PROVIDER_PRESETS, presetCapabilities, type ProviderPresetId } from './openAICompatible';
import { presetModelTuning, readProviderOverrides, type ProviderOverrides } from './providerOverrides';
import {
    DEFAULT_CUSTOM_MAX_TOKENS,
    customModelTiers,
    findCustomEndpoint,
    findCustomModel,
    isCustomProviderId,
    readCustomEndpoints,
    type CustomEndpointModel,
} from './customEndpoints';
import { LEGACY_THINKING_TIERS, THINKING_TIERS, isThinkingTier, type ThinkingTier } from './thinkingTiers';

/**
 * Context windows of the preset models, from the providers' own catalogues
 * (models.dev, as pi-ai 1.4 ships it, read 2026-10-28). GPT-6.1 Terra is newer
 * than that list and taken to match its siblings. A model missing here has no
 * known window until the user gives one.
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
    'deepseek-flash': 1_048_576,
    'gpt-6-luna': 272_000,
    'gpt-6-sol': 272_000,
    'gpt-6-astra': 272_000,
    'gpt-6.1-sol': 272_000,
    'gpt-6.1-terra': 272_000,
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    'z-ai/glm-5.3-flash': 1_048_575,
    'deepseek/deepseek-v4.1-flash': 1_048_576,
    'glm-5.3-flash': 1_000_000,
    'gemini-3.8-flash': 1_048_576,
    'gemini-3.5-flash-lite': 1_048_576,
    'gemini-4-argon': 1_048_576,
};

/**
 * Tiers a preset model takes beyond the four the composer used to offer.
 * GPT-6 (and 6.1) think at xhigh and max — luna and sol took both on
 * 2026-10-13, terra and 6.1 Sol on 2026-10-28. DeepSeek's scale tops out at
 * max.
 */
function extraTiers(id: ProviderPresetId, model: string): ThinkingTier[] {
    if (id === 'openai' && /^gpt-6(\.\d+)?-/.test(model)) return ['xhigh', 'max'];
    if (id === 'deepseek') return ['max'];
    return [];
}

/**
 * The tiers a preset model takes when the user has said nothing: the four the
 * composer offered, each spelled as the endpoint wants it (a model that refuses
 * "none" starts at what the preset sends instead), and whatever more the model
 * is known to take.
 */
export function presetDefaultTiers(id: ProviderPresetId, model?: string): ThinkingTier[] {
    const caps = presetCapabilities(id, model);
    if (!caps.supportsReasoningEffort) return [];
    const chosen = model || (PROVIDER_PRESETS[id] as { defaultModel?: string }).defaultModel || '';
    const taken = new Set<ThinkingTier>();
    for (const tier of LEGACY_THINKING_TIERS) {
        const sent = caps.reasoningEffortAliases?.[tier] ?? tier;
        if (isThinkingTier(sent)) taken.add(sent);
    }
    for (const tier of extraTiers(id, chosen)) taken.add(tier);
    return THINKING_TIERS.filter((tier) => taken.has(tier));
}

export function presetDefaultContextWindow(id: ProviderPresetId, model?: string): number | undefined {
    const chosen = model || (PROVIDER_PRESETS[id] as { defaultModel?: string }).defaultModel || '';
    return KNOWN_CONTEXT_WINDOWS[chosen];
}

/** What applies to a model when the user sets nothing for it — the settings show these as placeholders. */
export interface TuningDefaults {
    efforts: ThinkingTier[];
    contextWindow?: number;
    /** What one answer may use unless Limits per question says less. */
    maxOutputTokens?: number;
    /** The most the endpoint accepts; a request above it is refused. */
    outputCeiling?: number;
}

export function tuningDefaults(providerId: string, model: string): TuningDefaults {
    if (isCustomProviderId(providerId) || !(providerId in PROVIDER_PRESETS)) {
        return { efforts: [], maxOutputTokens: DEFAULT_CUSTOM_MAX_TOKENS };
    }
    const id = providerId as ProviderPresetId;
    const caps = presetCapabilities(id, model || undefined);
    const contextWindow = presetDefaultContextWindow(id, model || undefined);
    return {
        efforts: presetDefaultTiers(id, model || undefined),
        ...(contextWindow ? { contextWindow } : {}),
        ...(caps.defaultMaxTokens ? { maxOutputTokens: caps.defaultMaxTokens } : {}),
        ...(caps.maxOutputTokens ? { outputCeiling: caps.maxOutputTokens } : {}),
    };
}

/** The model a preset runs when none is chosen: its default. */
function presetModel(id: string, model: string): string {
    return model || (PROVIDER_PRESETS[id as ProviderPresetId] as { defaultModel?: string }).defaultModel || '';
}

function customModel(providerId: string, model: string): CustomEndpointModel | null {
    const endpoint = findCustomEndpoint(providerId, readCustomEndpoints(), model);
    return endpoint ? findCustomModel(endpoint, model) : null;
}

/** The thinking tiers this model takes; empty when no thinking setting may be sent. */
export function modelThinkingTiers(
    providerId: string,
    model: string,
    overrides: ProviderOverrides = readProviderOverrides(),
): ThinkingTier[] {
    if (isCustomProviderId(providerId)) {
        const found = customModel(providerId, model);
        return found ? customModelTiers(found) : [];
    }
    if (!(providerId in PROVIDER_PRESETS)) return [];
    const chosen = presetModel(providerId, model);
    return presetModelTuning(providerId, chosen, overrides)?.efforts
        ?? presetDefaultTiers(providerId as ProviderPresetId, chosen || undefined);
}

/** The model's context window in tokens, when the user or the preset knows it. */
export function modelContextWindow(
    providerId: string,
    model: string,
    overrides: ProviderOverrides = readProviderOverrides(),
): number | undefined {
    if (isCustomProviderId(providerId)) return customModel(providerId, model)?.contextWindow;
    if (!(providerId in PROVIDER_PRESETS)) return undefined;
    const chosen = presetModel(providerId, model);
    return presetModelTuning(providerId, chosen, overrides)?.contextWindow
        ?? presetDefaultContextWindow(providerId as ProviderPresetId, chosen || undefined);
}

/** The output budget the user set for a preset model, or undefined. */
export function presetModelOutputTokens(
    providerId: string,
    model: string,
    overrides: ProviderOverrides = readProviderOverrides(),
): number | undefined {
    if (!(providerId in PROVIDER_PRESETS)) return undefined;
    return presetModelTuning(providerId, presetModel(providerId, model), overrides)?.maxOutputTokens;
}
