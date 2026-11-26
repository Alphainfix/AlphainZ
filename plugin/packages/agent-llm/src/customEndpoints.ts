/**
 * Endpoints the user adds by hand, and the models filed under them.
 *
 * The presets cover the vendors this plugin knows. Everything else — a cloud
 * provider that is not listed, a proxy in front of one, a server on this
 * computer — is an OpenAI-compatible endpoint the user describes once (name,
 * base URL, key, how the key is sent) and then adds models to. The endpoint is
 * the unit, not the model: one key, one address, many models, which is how
 * every other agent client lays this out and how a user thinks about it.
 *
 * Stored in one per-computer preference. It carries keys, so it is never part
 * of the settings that sync between machines; the model choice (`llmProvider`
 * naming the endpoint) does sync. A second machine that has the same endpoint
 * under an id of its own recognises it by the chosen model (see
 * `findCustomEndpoint`), and one that lacks it is told so instead of failing a
 * request.
 *
 * Nothing here is inferred. Whether a model reads images, which thinking tiers
 * it takes, how large its context is — all of it is what the user said, or
 * what the Check button found, because a hand-typed endpoint tells us nothing
 * about the model behind it. So is the wire: plain Chat Completions, which
 * every such server speaks, or the Responses API, where OpenAI's newer models
 * think and call tools in the same request.
 */

import { getPref, setPref } from './prefs';
import { logger } from '@beaver/agent-core/platform/logger';
import { OpenAICompatibleProvider, type FetchLike } from './openAICompatible';
import { LEGACY_THINKING_TIERS, normalizeTiers, positiveInt, type ThinkingTier } from './thinkingTiers';
import type { AuthStyle, WireFormat } from './types';

export interface CustomEndpointModel {
    /** The model id exactly as the endpoint spells it. */
    id: string;
    /** Optional display name; the id is shown when empty. */
    label?: string;
    /** Whether images may be sent — the user's word, or the Check button's. */
    supportsVision: boolean;
    /**
     * Whether a thinking setting is sent at all. Kept beside `efforts`, which
     * replaced it: a model saved before tiers existed has only this, and it
     * meant the four tiers the composer offered then.
     */
    reasoningEffort: boolean;
    /** The thinking tiers it takes, in scale order; empty sends none. */
    efforts?: ThinkingTier[];
    /** Its context window in tokens, when the user said. */
    contextWindow?: number;
    /** Output budget per answer, and its ceiling. Defaults to DEFAULT_CUSTOM_MAX_TOKENS. */
    maxTokens?: number;
    /** The last Check, kept as evidence beside the switch it set. */
    visionChecked?: { at: number; seesImages: boolean; detail: string };
}

export interface CustomEndpoint {
    /** Stable id; the provider id is `custom:<id>`. */
    id: string;
    name: string;
    /** OpenAI-compatible root, e.g. `https://host/v1`. */
    baseUrl: string;
    /** May be empty: a server on this computer usually takes none. */
    apiKey: string;
    authStyle: AuthStyle;
    /** The API it speaks: Chat Completions unless the user chose Responses. */
    wireFormat?: WireFormat;
    models: CustomEndpointModel[];
}

export const CUSTOM_PROVIDER_PREFIX = 'custom:';

/** Same budget logic as the DeepSeek presets: a thinking model shares it with its reasoning. */
export const DEFAULT_CUSTOM_MAX_TOKENS = 8000;

export function customProviderId(endpointId: string): string {
    return `${CUSTOM_PROVIDER_PREFIX}${endpointId}`;
}

export function isCustomProviderId(providerId: string): boolean {
    return providerId.startsWith(CUSTOM_PROVIDER_PREFIX) && providerId.length > CUSTOM_PROVIDER_PREFIX.length;
}

/** The endpoint id inside a provider id, or null when it is not a custom one. */
export function parseCustomProviderId(providerId: string): string | null {
    return isCustomProviderId(providerId) ? providerId.slice(CUSTOM_PROVIDER_PREFIX.length) : null;
}

export function newEndpointId(): string {
    const bytes = new Uint8Array(4);
    (globalThis.crypto ?? ({ getRandomValues: (b: Uint8Array) => b.map(() => Math.floor(Math.random() * 256)) } as any)).getRandomValues(bytes);
    return `ep-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function normalizeModel(raw: unknown): CustomEndpointModel | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    const id = asString(m.id);
    if (!id) return null;
    const label = asString(m.label);
    const maxTokens = positiveInt(m.maxTokens);
    const contextWindow = positiveInt(m.contextWindow);
    const efforts = normalizeTiers(m.efforts);
    const checked = m.visionChecked && typeof m.visionChecked === 'object' ? (m.visionChecked as Record<string, unknown>) : null;
    return {
        id,
        ...(label ? { label } : {}),
        supportsVision: m.supportsVision === true,
        reasoningEffort: efforts ? efforts.length > 0 : m.reasoningEffort === true,
        ...(efforts ? { efforts } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(checked && typeof checked.at === 'number' && typeof checked.seesImages === 'boolean'
            ? { visionChecked: { at: checked.at, seesImages: checked.seesImages, detail: asString(checked.detail) } }
            : {}),
    };
}

function normalizeEndpoint(raw: unknown): CustomEndpoint | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    const id = asString(e.id);
    if (!id) return null;
    const models = Array.isArray(e.models) ? e.models.map(normalizeModel).filter((m): m is CustomEndpointModel => m !== null) : [];
    return {
        id,
        name: asString(e.name),
        baseUrl: asString(e.baseUrl).replace(/\/+$/, ''),
        apiKey: asString(e.apiKey),
        authStyle: e.authStyle === 'x-api-key' ? 'x-api-key' : 'bearer',
        ...(e.wireFormat === 'openai-responses' ? { wireFormat: 'openai-responses' as const } : {}),
        models,
    };
}

/** Every endpoint on record, malformed entries dropped rather than thrown on. */
export function readCustomEndpoints(): CustomEndpoint[] {
    try {
        const raw = getPref('customEndpoints');
        const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeEndpoint).filter((e): e is CustomEndpoint => e !== null);
    } catch (error) {
        logger(`customEndpoints: preference unreadable: ${error}`, 1);
        return [];
    }
}

export function writeCustomEndpoints(endpoints: CustomEndpoint[]): void {
    const cleaned = endpoints.map(normalizeEndpoint).filter((e): e is CustomEndpoint => e !== null);
    setPref('customEndpoints', JSON.stringify(cleaned));
}

/**
 * The endpoint a provider id names on this computer.
 *
 * Each endpoint is filed under an id drawn when it was added, on the computer
 * it was added on, while the model choice (`custom:<id>`) syncs. The same
 * relay added by hand on two computers therefore has two ids, and a synced
 * choice names the other computer's. When the id is not found here, the one
 * endpoint on this computer that lists the chosen model stands in for it: the
 * model id is the part of the choice both computers share. Two such endpoints
 * are ambiguous, and neither is guessed.
 *
 * `modelId` defaults to the stored model when `providerId` is the stored
 * provider, which is the lookup made for the model in use.
 */
export function findCustomEndpoint(
    providerId: string,
    endpoints: CustomEndpoint[] = readCustomEndpoints(),
    modelId?: string,
): CustomEndpoint | null {
    const id = parseCustomProviderId(providerId);
    if (!id) return null;
    const exact = endpoints.find((e) => e.id === id);
    if (exact) return exact;
    const model = modelId ?? storedModelFor(providerId);
    return model ? soleEndpointListing(endpoints, model) : null;
}

/** The stored model, when `providerId` is the stored provider. */
function storedModelFor(providerId: string): string | undefined {
    if (asString(getPref('llmProvider')) !== providerId) return undefined;
    return asString(getPref('llmModel')) || undefined;
}

/** The only endpoint with an address that lists `modelId`, or null for none or several. */
function soleEndpointListing(endpoints: CustomEndpoint[], modelId: string): CustomEndpoint | null {
    const matches = endpoints.filter((e) => e.baseUrl && findCustomModel(e, modelId));
    return matches.length === 1 ? matches[0] : null;
}

/** An id another computer's choice may hand over: the shape `newEndpointId` draws, or close to it. */
const ADOPTABLE_ENDPOINT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Ids `adoptSyncedEndpointId` replaced this session, old → new, so something
 * that read the endpoints before a rename (a Settings card left open) still
 * writes to the endpoint it shows. See `currentEndpointId`.
 */
const adoptedIds = new Map<string, string>();

/** The id an endpoint is filed under now, following any rename by adoption this session. */
export function currentEndpointId(id: string): string {
    let next = id;
    for (let hops = 0; hops < 8 && adoptedIds.has(next); hops += 1) next = adoptedIds.get(next)!;
    return next;
}

/**
 * File the endpoint that stands in for a synced choice (see
 * `findCustomEndpoint`) under the id that choice names, so both computers use
 * the same id for it from then on.
 *
 * Without this each computer's picker writes its own id, sync carries it to
 * the other, and the choice keeps flipping between two ids that each
 * computer only half recognises. Returns whether an endpoint was renamed.
 */
export function adoptSyncedEndpointId(providerId: string, modelId: string): boolean {
    const id = parseCustomProviderId(providerId);
    if (!id || !ADOPTABLE_ENDPOINT_ID.test(id) || !modelId) return false;
    const endpoints = readCustomEndpoints();
    if (endpoints.some((e) => e.id === id)) return false;
    const standIn = soleEndpointListing(endpoints, modelId);
    if (!standIn) return false;
    adoptedIds.delete(id);
    adoptedIds.set(standIn.id, id);
    writeCustomEndpoints(endpoints.map((e) => (e === standIn ? { ...e, id } : e)));
    logger(`customEndpoints: endpoint ${standIn.id} now uses ${id}, the id the synced model choice names`, 2);
    return true;
}

export function findCustomModel(endpoint: CustomEndpoint, modelId: string): CustomEndpointModel | null {
    return endpoint.models.find((m) => m.id === modelId) ?? null;
}

/** What the picker shows as the vendor heading: the endpoint's name. */
export function customEndpointLabel(providerId: string): string | null {
    const endpoint = findCustomEndpoint(providerId);
    if (!endpoint) return null;
    return endpoint.name || endpoint.baseUrl || 'Custom endpoint';
}

/** The thinking tiers a hand-added model takes: its list, or the old switch's four. */
export function customModelTiers(model: Pick<CustomEndpointModel, 'efforts' | 'reasoningEffort'>): ThinkingTier[] {
    return model.efforts ?? (model.reasoningEffort ? [...LEGACY_THINKING_TIERS] : []);
}

/**
 * What the user (or the Check button) said this model can do, or null when the
 * provider id is not a custom endpoint or the model is not filed under it.
 */
export function customModelCapabilities(
    providerId: string,
    modelId: string,
): { supportsVision: boolean; supportsReasoningEffort: boolean; efforts: ThinkingTier[]; maxTokens: number; contextWindow?: number } | null {
    const endpoint = findCustomEndpoint(providerId, readCustomEndpoints(), modelId);
    const model = endpoint ? findCustomModel(endpoint, modelId) : null;
    if (!model) return null;
    const efforts = customModelTiers(model);
    return {
        supportsVision: model.supportsVision,
        supportsReasoningEffort: efforts.length > 0,
        efforts,
        maxTokens: model.maxTokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    };
}

/** Persist a change to one model; false when the endpoint or model is gone. */
export function updateCustomModel(providerId: string, modelId: string, patch: Partial<CustomEndpointModel>): boolean {
    const endpoints = readCustomEndpoints();
    const endpoint = findCustomEndpoint(providerId, endpoints, modelId);
    const model = endpoint ? findCustomModel(endpoint, modelId) : null;
    if (!endpoint || !model) return false;
    Object.assign(model, patch);
    writeCustomEndpoints(endpoints);
    return true;
}

/**
 * A chat provider for one model of a hand-added endpoint.
 *
 * The wire the user chose — Chat Completions, or Responses — with images lifted
 * into a user message (the shape every such endpoint accepts) and the key sent
 * the way the user said. Nothing is assumed about reasoning: an effort goes out
 * only when the model has tiers, because an endpoint that does not know the
 * field may 400 on it. On Responses the thinking summary is asked for too, and
 * an address with no /responses falls back to Chat Completions by itself.
 */
export function customProviderFromEndpoint(
    endpoint: CustomEndpoint,
    modelId: string,
    fetchImpl: FetchLike,
    overrides: { maxTokens?: number; extraBody?: Record<string, unknown> } = {},
): OpenAICompatibleProvider {
    const model = findCustomModel(endpoint, modelId);
    const tiers = model ? customModelTiers(model) : [];
    const responses = endpoint.wireFormat === 'openai-responses';
    return new OpenAICompatibleProvider(
        {
            label: endpoint.name || endpoint.baseUrl,
            baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey,
            model: modelId,
            wireFormat: responses ? 'openai-responses' : 'openai',
            authStyle: endpoint.authStyle,
            maxTokens: overrides.maxTokens ?? model?.maxTokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
            imagesInToolResults: false,
            supportsVision: model?.supportsVision === true,
            ...(responses
                ? {
                    supportsReasoningEffort: tiers.length > 0,
                    ...(tiers.length > 0 ? { leastReasoningEffort: tiers[0], reasoningSummary: true } : {}),
                    // Used only if the address has no /responses after all.
                    maxTokensParam: 'max_completion_tokens' as const,
                }
                : {}),
            ...(overrides.extraBody ? { extraBody: overrides.extraBody } : {}),
        },
        fetchImpl,
    );
}
