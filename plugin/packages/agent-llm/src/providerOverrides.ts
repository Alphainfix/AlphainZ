/**
 * What the user changed about a built-in provider: its address, and its model
 * catalogue.
 *
 * A preset ships an address and a list of models; both go stale — a vendor
 * releases a model, a proxy sits in front of the vendor. Rather than a
 * global "base URL" that applied to whichever provider happened to be
 * selected, and a "model not listed?" box that named one model outside every
 * list, each provider carries its own edits: an address override and, when
 * the user has touched it, a catalogue that replaces the preset's list. A row
 * in that catalogue may also say the model reads images, for a model the
 * preset knows nothing about.
 *
 * Each model can also be tuned — the thinking tiers it takes, its context
 * window, the most one answer may use — in a table of its own, keyed by model
 * id. Kept apart from the catalogue on purpose: tuning one model must not turn
 * the preset's list into the user's, or models a later version adds to the
 * preset would never appear.
 *
 * Stored per computer. Addresses may point at this machine, and a catalogue is
 * a local choice; the model *in use* (`llmProvider` / `llmModel`) syncs as
 * before.
 */

import { getPref, setPref } from './prefs';
import { normalizeTuning, type ModelTuning } from './thinkingTiers';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    PROVIDER_PRESETS,
    recordDeclaredVision,
    resetDeclaredVision,
    type ProviderPresetId,
} from './openAICompatible';

export interface CatalogueModel {
    /** The model id as the endpoint spells it. */
    id: string;
    /** Optional display name; the id is shown when empty. */
    label?: string;
    /** Set by the user or by Check; absent means "whatever the preset says". */
    supportsVision?: boolean;
}

export interface ProviderOverride {
    /** Replaces the preset's base URL when set. */
    baseUrl?: string;
    /** Replaces the preset's model list when set — even when empty. */
    models?: CatalogueModel[];
    /** What the user set for each model, by model id. */
    tuning?: Record<string, ModelTuning>;
}

export type ProviderOverrides = Partial<Record<ProviderPresetId, ProviderOverride>>;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function normalizeModel(raw: unknown): CatalogueModel | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    const id = asString(m.id);
    if (!id) return null;
    const label = asString(m.label);
    return {
        id,
        ...(label ? { label } : {}),
        ...(typeof m.supportsVision === 'boolean' ? { supportsVision: m.supportsVision } : {}),
    };
}

function normalizeOverride(raw: unknown): ProviderOverride | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const baseUrl = asString(o.baseUrl).replace(/\/+$/, '');
    const models = Array.isArray(o.models)
        ? o.models.map(normalizeModel).filter((m): m is CatalogueModel => m !== null)
        : undefined;
    const tuning: Record<string, ModelTuning> = {};
    if (o.tuning && typeof o.tuning === 'object' && !Array.isArray(o.tuning)) {
        for (const [model, raw] of Object.entries(o.tuning as Record<string, unknown>)) {
            const normalized = model.trim() ? normalizeTuning(raw) : null;
            if (normalized) tuning[model.trim()] = normalized;
        }
    }
    const out: ProviderOverride = {};
    if (baseUrl) out.baseUrl = baseUrl;
    if (models) out.models = models;
    if (Object.keys(tuning).length > 0) out.tuning = tuning;
    return Object.keys(out).length > 0 ? out : null;
}

export function readProviderOverrides(): ProviderOverrides {
    try {
        const raw = getPref('providerOverrides');
        const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: ProviderOverrides = {};
        for (const [id, value] of Object.entries(parsed)) {
            if (!(id in PROVIDER_PRESETS)) continue;
            const normalized = normalizeOverride(value);
            if (normalized) out[id as ProviderPresetId] = normalized;
        }
        return out;
    } catch (error) {
        logger(`providerOverrides: preference unreadable: ${error}`, 1);
        return {};
    }
}

export function writeProviderOverrides(overrides: ProviderOverrides): void {
    const cleaned: ProviderOverrides = {};
    for (const [id, value] of Object.entries(overrides)) {
        if (!(id in PROVIDER_PRESETS)) continue;
        const normalized = normalizeOverride(value);
        if (normalized) cleaned[id as ProviderPresetId] = normalized;
    }
    setPref('providerOverrides', JSON.stringify(cleaned));
    hydrateProviderOverrides(cleaned);
}

/** Change one provider's override in place. `null` removes it. */
export function updateProviderOverride(id: ProviderPresetId, patch: ProviderOverride | null): void {
    const all = readProviderOverrides();
    if (patch === null) delete all[id];
    else all[id] = { ...(all[id] ?? {}), ...patch };
    writeProviderOverrides(all);
}

/** The preset's own catalogue, as rows. Ollama lists what was detected, elsewhere. */
export function defaultCatalogue(id: ProviderPresetId): CatalogueModel[] {
    const preset = PROVIDER_PRESETS[id] as { models: readonly string[]; defaultModel: string };
    const ids = preset.models.length > 0 ? [...preset.models] : [preset.defaultModel];
    return ids.filter(Boolean).map((model) => ({ id: model }));
}

/** The catalogue in force: the user's, when they have one, else the preset's. */
export function catalogueFor(id: ProviderPresetId, overrides: ProviderOverrides = readProviderOverrides()): CatalogueModel[] {
    return overrides[id]?.models ?? defaultCatalogue(id);
}

/** Whether the user replaced this preset's catalogue. */
export function catalogueIsCustom(id: ProviderPresetId, overrides: ProviderOverrides = readProviderOverrides()): boolean {
    return overrides[id]?.models !== undefined;
}

/**
 * Whether an installed Ollama model reads images, as the user said on the
 * Ollama card; undefined when they said nothing (the preset's text-only
 * answer then stands).
 */
export function ollamaModelVision(model: string, overrides: ProviderOverrides = readProviderOverrides()): boolean | undefined {
    return overrides.ollama?.models?.find((row) => row.id === model)?.supportsVision;
}

/**
 * Record that an installed Ollama model reads images, or with `false` forget
 * it. Ollama's model list comes from what is installed, not from a
 * catalogue, so its rows here carry nothing but this flag — which
 * `hydrateProviderOverrides` hands to `presetSupportsVision`, the answer the
 * picker, the attachment checks and the run all read.
 */
export function setOllamaModelVision(model: string, reads: boolean): void {
    const all = readProviderOverrides();
    const rows = (all.ollama?.models ?? []).filter((row) => row.id !== model);
    const next: ProviderOverride = { ...(all.ollama ?? {}) };
    if (reads) rows.push({ id: model, supportsVision: true });
    if (rows.length > 0) next.models = rows;
    else delete next.models;
    if (Object.keys(next).length > 0) all.ollama = next;
    else delete all.ollama;
    writeProviderOverrides(all);
}

/** What the user set for one model of a preset, or null. */
export function presetModelTuning(
    id: string,
    model: string,
    overrides: ProviderOverrides = readProviderOverrides(),
): ModelTuning | null {
    if (!(id in PROVIDER_PRESETS) || !model) return null;
    return overrides[id as ProviderPresetId]?.tuning?.[model] ?? null;
}

/** The address in force for a preset: the user's override, or nothing. */
export function baseUrlOverrideFor(id: string, overrides: ProviderOverrides = readProviderOverrides()): string {
    return (id in PROVIDER_PRESETS ? overrides[id as ProviderPresetId]?.baseUrl : undefined) ?? '';
}

/**
 * Put every declared "reads figures" back where `presetSupportsVision` reads
 * it. Called whenever the overrides are read for a build of the model list or
 * a run, so a flag set in the catalogue reaches the picker and the run alike.
 */
export function hydrateProviderOverrides(overrides: ProviderOverrides = readProviderOverrides()): void {
    resetDeclaredVision();
    for (const [id, override] of Object.entries(overrides)) {
        for (const model of override?.models ?? []) {
            if (typeof model.supportsVision === 'boolean') {
                recordDeclaredVision(id as ProviderPresetId, model.id, model.supportsVision);
            }
        }
    }
}
