/**
 * The models a client offers in its model picker, and how it names them.
 *
 * Every model the keys on this computer reach, from the provider presets (the
 * user's edited catalogue where there is one), the Ollama models found here,
 * and the endpoints added by hand. Derived from the same presets and settings
 * the runner reads, so the list cannot drift from what would actually answer,
 * and shared by every client so each offers the same models under the same
 * names. Where a client keeps its keys is its own business: it says, per
 * preset, whether it holds one.
 */
import type { ModelConfig } from '@beaver/agent-core/types/models';
import {
    PROVIDER_PRESETS,
    presetCapabilities,
    presetSupportsVision,
    retireChoice,
    type ProviderPresetId,
} from './openAICompatible';
import { catalogueFor, hydrateProviderOverrides, readProviderOverrides, type CatalogueModel } from './providerOverrides';
import { hydrateVisionVerdicts } from './visionProbe';
import {
    customEndpointLabel,
    customProviderId,
    findCustomEndpoint,
    findCustomModel,
    isCustomProviderId,
    readCustomEndpoints,
} from './customEndpoints';
import { getPref, setPref } from './prefs';
import { msg, t } from './i18n';

/** What the client knows that the shared settings do not. */
export interface ModelChoiceSources {
    /** Whether this computer holds a key for a preset; Ollama needs none. */
    hasKey(providerId: ProviderPresetId): boolean;
    /** The Ollama chat models found on this computer. */
    ollamaModels(): string[];
}

/**
 * Every model the stored keys make reachable, as picker entries.
 *
 * The composer's list once came from a backend, so with none it held exactly
 * one entry — whichever provider the settings had last written. Switching model
 * meant opening settings, which is not where anyone looks for it, and a second
 * provider's models never appeared at all despite a key being present.
 */
export function localModelChoices(sources: ModelChoiceSources): ModelConfig[] {
    // Verdicts the Check button earned earlier, and flags declared in a
    // provider's catalogue, so the rows below can say "reads figures" from the
    // first build. Verdicts are recorded after declarations so they win.
    const overrides = readProviderOverrides();
    hydrateProviderOverrides(overrides);
    hydrateVisionVerdicts();

    const out: ModelConfig[] = [];
    for (const id of Object.keys(PROVIDER_PRESETS) as ProviderPresetId[]) {
        if (!sources.hasKey(id)) continue;
        const preset = PROVIDER_PRESETS[id];
        // Ollama lists what is installed here, not a fixed catalogue; with
        // nothing detected yet there is nothing to offer. Every other preset
        // offers its catalogue — the user's edited one when they have one.
        const rows: CatalogueModel[] = id === 'ollama'
            ? sources.ollamaModels().map((model) => ({ id: model }))
            : catalogueFor(id, overrides);
        for (const row of rows) {
            const model = row.id;
            if (!model) continue;
            out.push({
                id: `local-${id}::${model}`,
                provider: id as ModelConfig['provider'],
                name: `${preset.label} · ${row.label || model}`,
                ...(row.label ? { label: row.label } : {}),
                snapshot: model,
                is_default: false,
                credit_cost: 0,
                allow_byok: true,
                allow_app_key: false,
                is_custom: true,
                // Resolved per model, not per preset: the attachment checks
                // read this flag to decide whether an image may be attached,
                // and one gateway can host a vision model next to a text-only
                // one. Left unset, every preset model read as "no vision" and
                // image attachments were refused even for models that see.
                supports_vision: presetSupportsVision(id, model) === true,
            });
        }
    }

    /*
     * Hand-added endpoints, each under its own name. The entry carries what
     * the user said about the model (vision) rather than anything inferred,
     * and `custom_model.api_base` so the picker's endpoint dedupe sees where
     * it points. Never the key: this object is snapshotted into a setting.
     */
    for (const endpoint of readCustomEndpoints()) {
        if (!endpoint.baseUrl) continue;
        const provider = customProviderId(endpoint.id);
        const vendor = endpoint.name || endpoint.baseUrl;
        for (const model of endpoint.models) {
            out.push({
                id: `local-${provider}::${model.id}`,
                provider: provider as ModelConfig['provider'],
                name: `${vendor} · ${model.label || model.id}`,
                ...(model.label ? { label: model.label } : {}),
                snapshot: model.id,
                is_default: false,
                credit_cost: 0,
                allow_byok: true,
                allow_app_key: false,
                is_custom: true,
                supports_vision: model.supportsVision,
                custom_model: { api_base: endpoint.baseUrl, format: 'openai', api_key: '', name: vendor, snapshot: model.id },
            });
        }
    }
    return out;
}

/** A string setting, trimmed; '' when unset. Read defensively: a stubbed one in tests is not necessarily a string. */
function trimmedChoice(key: 'llmProvider' | 'llmModel'): string {
    const value = getPref(key);
    return typeof value === 'string' ? value.trim() : '';
}

/** The model the settings name (`llmProvider` / `llmModel`), as a picker entry; null when none is chosen. */
export function currentModelChoice(): ModelConfig | null {
    if (!trimmedChoice('llmProvider')) return null;
    // A stored provider or model that has been retired shows and runs as its
    // successor — the same mapping the runner applies, so the picker names
    // what will actually answer instead of a model that no longer exists.
    const { provider, model } = retireChoice(trimmedChoice('llmProvider'), trimmedChoice('llmModel'));
    // The same id the picker's list uses, so the two agree on which entry is
    // current even for a model name that is not in the preset catalogue.
    const endpoint = isCustomProviderId(provider) ? findCustomEndpoint(provider) : null;
    const customModel = endpoint && model ? findCustomModel(endpoint, model) : null;
    const label = endpoint
        ? (endpoint.name || endpoint.baseUrl || 'Custom endpoint')
        : provider in PROVIDER_PRESETS ? PROVIDER_PRESETS[provider as ProviderPresetId].label : provider;
    // The display name the catalogue gives this model, so the picker and the
    // settings page call it the same thing.
    const displayName = endpoint
        ? customModel?.label
        : provider in PROVIDER_PRESETS
            ? catalogueFor(provider as ProviderPresetId).find((row) => row.id === model)?.label
            : undefined;
    return {
        id: model ? `local-${provider}::${model}` : `local-${provider}`,
        provider: provider as ModelConfig['provider'],
        name: model ? `${label} · ${displayName || model}` : label,
        ...(displayName ? { label: displayName } : {}),
        snapshot: model,
        is_default: true,
        credit_cost: 0,
        allow_byok: true,
        allow_app_key: false,
        is_custom: true,
        ...(provider in PROVIDER_PRESETS
            ? { supports_vision: presetSupportsVision(provider as ProviderPresetId, model || undefined) === true }
            : endpoint
                ? { supports_vision: customModel?.supportsVision === true }
                : {}),
    };
}

/**
 * Write a locally-configured choice to the settings the runner reads. Only for
 * the `local-` entries; anything else has no setting pair to write.
 */
export function saveModelChoice(model: ModelConfig | null): void {
    if (!model || !model.id.startsWith('local-') || !model.provider) return;
    const provider = String(model.provider);
    const snapshot = model.snapshot ? String(model.snapshot) : '';
    if (trimmedChoice('llmProvider') !== provider) setPref('llmProvider', provider);
    if (snapshot && trimmedChoice('llmModel') !== snapshot) setPref('llmModel', snapshot);
}

/** What each thinking setting means where the user is choosing it. */
export const EFFORT_LABELS: Record<string, string> = {
    none: msg('Off — answer straight away'),
    minimal: msg('Minimal'),
    low: msg('Low — brief planning'),
    medium: msg('Medium'),
    high: msg('High — think it through'),
    xhigh: msg('Extra high'),
    max: msg('Max — the longest thinking'),
};

/**
 * Which heading a model sits under.
 *
 * The list is every model the stored keys reach, which is a dozen rows across
 * three vendors — flat, that is a wall of `provider · model` strings with no
 * shape. Grouping by vendor is the shape the user already thinks in, and it
 * lets the row itself drop the vendor prefix. Headings are English; a client
 * shows them through its translator.
 */
export const VENDOR_OF_PRESET: Partial<Record<ProviderPresetId, string>> = {
    deepseek: 'DeepSeek',
    'opencode-go': 'OpenCode Go',
    openrouter: 'OpenRouter',
    zhipu: msg('Zhipu (BigModel)'),
    google: 'Google Gemini',
    openai: 'OpenAI',
    ollama: msg('Ollama (local)'),
};

/** The heading for models whose vendor is not known. */
export const OTHER_VENDOR = msg('Added by you');

/** Vendor headings in the order they should appear. */
export const VENDOR_ORDER = ['DeepSeek', 'OpenCode Go', 'OpenRouter', 'Zhipu (BigModel)', 'Google Gemini', 'OpenAI', 'Ollama (local)', OTHER_VENDOR];

export function vendorFor(model: ModelConfig): string {
    // A hand-added endpoint is its own vendor, under the name the user gave it.
    if (isCustomProviderId(String(model.provider))) {
        return customEndpointLabel(String(model.provider)) ?? OTHER_VENDOR;
    }
    return VENDOR_OF_PRESET[model.provider as ProviderPresetId] ?? OTHER_VENDOR;
}

/** Where a vendor's heading goes: presets in their fixed order, then the user's endpoints, then the leftovers. */
export function vendorRank(vendor: string): number {
    if (vendor === OTHER_VENDOR) return VENDOR_ORDER.length + 1;
    const i = VENDOR_ORDER.indexOf(vendor);
    return i < 0 ? VENDOR_ORDER.length : i;
}

/**
 * What a model is called on its own, without the vendor: the display name its
 * provider's catalogue gave it, else the model id. The same text everywhere a
 * client names a model — the picker's rows and the composer button — so what
 * was typed under "Display name" in Settings is what the user then sees.
 */
export function displayNameFor(model: Pick<ModelConfig, 'label' | 'snapshot' | 'name'>): string {
    return model.label?.trim() || model.snapshot?.trim() || model.name || '';
}

/** The row label: the model's own name, since the vendor is the heading above it. */
export function rowLabel(model: ModelConfig): string {
    const snapshot = model.snapshot?.trim();
    if (!snapshot) return model.name;
    const own = displayNameFor(model);
    // Per model: a gateway preset can list a text-only model beside one that
    // reads images, and the row must describe the model, not the gateway. A
    // hand-added model says what the user (or the Check button) said.
    const vision = isCustomProviderId(String(model.provider))
        ? model.supports_vision === true
        : presetCapabilities(model.provider as ProviderPresetId, snapshot).supportsVision;
    return vision ? t('{name} · reads figures', { name: own }) : own;
}

/**
 * Drop entries that name the same endpoint and model as another.
 *
 * Two lists feed the picker: the presets, derived from the stored keys, and
 * whatever the user typed into the custom-provider editor. Anyone who
 * configured DeepSeek both ways — which was the only way to reach it before
 * the presets existed — got each of those models twice, under two different
 * names, with nothing to say which one the request would use. Presets win
 * because they carry the endpoint's quirks; a hand-added entry survives only
 * if it points somewhere no preset does.
 */
export function dedupeByEndpoint(models: ModelConfig[]): ModelConfig[] {
    const host = (url?: string) => {
        if (!url) return '';
        try {
            return new URL(url).host.toLowerCase();
        } catch {
            return url.trim().toLowerCase();
        }
    };
    const keyOf = (model: ModelConfig) => {
        const preset = PROVIDER_PRESETS[model.provider as ProviderPresetId];
        const base = preset ? preset.baseUrl : model.custom_model?.api_base;
        return `${host(base)}::${(model.snapshot ?? '').trim().toLowerCase()}`;
    };
    const seen = new Set<string>();
    const out: ModelConfig[] = [];
    // Presets first, so a preset always wins the key over a hand-added twin.
    for (const model of [...models].sort((a, b) => Number(!!a.custom_model) - Number(!!b.custom_model))) {
        const key = keyOf(model);
        // Nothing to compare on — keep it rather than silently dropping a
        // model the user can no longer reach any other way.
        if (key === '::') {
            out.push(model);
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(model);
    }
    return out;
}

/** The models grouped under their vendor headings, headings in display order. */
export function groupByVendor(models: ModelConfig[]): Array<{ vendor: string; models: ModelConfig[] }> {
    const byVendor = new Map<string, ModelConfig[]>();
    for (const model of models) {
        const vendor = vendorFor(model);
        const bucket = byVendor.get(vendor);
        if (bucket) bucket.push(model);
        else byVendor.set(vendor, [model]);
    }
    return [...byVendor.keys()]
        .sort((a, b) => vendorRank(a) - vendorRank(b) || a.localeCompare(b))
        .map((vendor) => ({ vendor, models: byVendor.get(vendor) ?? [] }));
}
