/**
 * Embeddings, generated with your own key.
 *
 * This is the last cloud dependency in the retrieval path. Upstream sent every
 * text to Beaver's backend, which returned int8 vectors from `voyage-3-int8`;
 * the vectors were then stored and compared locally. Only the generation step
 * was remote, and this module replaces it.
 *
 * Two callers, and both matter: the indexer embeds titles and abstracts once
 * per item, and every search embeds the query. Miss either and semantic search
 * silently returns nothing.
 *
 * Pure apart from the injected `fetch`.
 */

import {
    ModelRequestError,
    childAbortController,
    describeErrorBody,
    describeWait,
    isModelRequestError,
    untilAborted,
} from './sse';

/** One embedded text, in the shape the existing storage layer expects. */
export interface EmbeddingResult {
    item_id: number;
    /** int8 components, in [-127, 127]. */
    embedding: number[];
    dimensions: number;
}

export interface EmbeddingsResponse {
    embeddings: EmbeddingResult[];
    model_id: string;
}

export type FetchLike = (
    url: string,
    init: Record<string, any>,
) => Promise<{ ok: boolean; status: number; statusText?: string; text: () => Promise<string> }>;

export interface EmbeddingProviderConfig {
    label: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    /**
     * Output dimensionality. 512 matches the existing `embeddings` table layout,
     * so switching provider needs no schema change — only a re-index, which is
     * required anyway because vectors from different models are incomparable.
     */
    dimensions: number;
    authStyle?: 'bearer' | 'x-api-key';
    /** Texts per request. Providers cap both count and total tokens. */
    batchSize?: number;
    /**
     * Longest one request may take, in ms. A stalled request otherwise holds a
     * search's tool step, or the indexer, for as long as the network stack
     * cares to wait.
     */
    timeoutMs?: number;
    /**
     * How the endpoint is spoken to. `openai` posts `{model, input,
     * dimensions}` to `/embeddings` (OpenAI, Ollama); `gemini` is the
     * Gemini API's own `models/<id>:batchEmbedContents`, keyed by
     * `x-goog-api-key`, which also reports which of its limits a 429 hit.
     */
    wire?: 'openai' | 'gemini';
    /**
     * What some models are trained to see in front of the text. EmbeddingGemma
     * and Gemini Embedding 2 tell a search query from an indexed document this
     * way, and retrieve measurably worse without it. Changing either changes
     * every vector, so it is part of what the model id stands for.
     */
    queryPrefix?: string;
    documentPrefix?: string;
    /**
     * Asked before each indexing batch goes out. It may wait (pacing a key's
     * per-minute limit) or throw (a daily allowance spent). Searches do not
     * pass through it: one query is never what exhausts a limit. `kind` tells
     * a batch of pictures from one of texts, which share a key's allowance.
     */
    beforeIndexBatch?: (count: number, signal?: AbortSignal, kind?: 'text' | 'image') => Promise<void>;
    /** Told how every request ended, for the quota bookkeeping and Settings. */
    onRequest?: (outcome: EmbeddingRequestOutcome) => void;
    /**
     * How a picture is embedded, for a model that takes them: `gemini` sends it
     * as `inline_data` on the same batch endpoint; `ollama` posts it to
     * Ollama's own `/api/embed` (its OpenAI-compatible route takes text only).
     * Absent, the model embeds text only and no page images are indexed.
     */
    imageWire?: 'gemini' | 'ollama';
    /** Pictures per request: a rendered page is large, so fewer than texts. */
    imageBatchSize?: number;
}

/** One thing to embed: a text, or a picture as base64 with its MIME type. */
type EmbedInput = { text: string } | { image: { mimeType: string; base64: string } };

/** How one embedding request ended. */
export type EmbeddingRequestOutcome =
    | { ok: true; purpose: 'index' | 'query'; count: number }
    | { ok: false; purpose: 'index' | 'query'; count: number; error: unknown };

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

/**
 * Quantize a float vector to int8.
 *
 * Scaled by the vector's own largest component, which keeps the direction
 * intact — and direction is all cosine similarity reads. Because each vector is
 * scaled independently the absolute values are not comparable across vectors,
 * but `int8CosineSimilarity` normalizes by magnitude, so that never matters.
 *
 * -127 rather than -128 as the floor: the asymmetry of two's complement would
 * otherwise skew a vector whose extreme component happens to be negative.
 */
export function quantizeToInt8(vector: number[]): number[] {
    let maxAbs = 0;
    for (const value of vector) {
        const abs = Math.abs(value);
        if (abs > maxAbs) maxAbs = abs;
    }
    // An all-zero vector has no direction to preserve; scaling by 0 would make
    // every component NaN.
    if (maxAbs === 0) return vector.map(() => 0);

    const scale = 127 / maxAbs;
    return vector.map((value) => {
        const scaled = Math.round(value * scale);
        return Math.max(-127, Math.min(127, scaled));
    });
}

/** Cosine similarity between two int8 vectors, in [-1, 1]. */
export function int8Cosine(
    a: readonly number[] | Int8Array,
    b: readonly number[] | Int8Array,
): number {
    if (a.length !== b.length) {
        throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The text an item is embedded as.
 *
 * Title first and abstract after, because a truncated tail costs less when it
 * is abstract prose than when it is the title. Kept in one place so the indexer
 * and any future re-indexer cannot drift apart — two different join formats
 * would silently produce two incomparable halves of one index.
 */
export function itemEmbeddingText(item: {
    title?: string | null;
    abstract?: string | null;
    creators?: string[] | null;
    year?: number | null;
}, maxChars = 6000): string {
    const parts: string[] = [];
    if (item.title) parts.push(item.title.trim());
    if (item.creators?.length) parts.push(item.creators.slice(0, 6).join(', '));
    if (item.year) parts.push(String(item.year));
    if (item.abstract) parts.push(item.abstract.trim());
    const joined = parts.filter(Boolean).join('\n');
    return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 64;

/** A hosted embedding endpoint answers a batch in a few seconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * How long a search waits out a per-minute limit before giving up. A query
 * is one text, so the limit was spent by something else — usually the indexer
 * — and the window turns over within the minute; a search left waiting much
 * longer than this is worse than one that says why it failed.
 */
const QUERY_RATE_WAIT_MS = 20_000;

/** Per-minute limits an indexing batch waits out before the run pauses on it. */
const MAX_INDEX_RATE_WAITS = 8;
const MAX_INDEX_RATE_WAIT_MS = 90_000;

/**
 * What a Gemini API error says about the limit it hit: when to try again
 * (`RetryInfo.retryDelay`), and whether the quota that ran out is per minute or
 * per day, and the free tier's (`QuotaFailure` violations, whose `quotaId`
 * reads like `EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier`).
 * The OpenAI-compatible layer wraps the same object in a one-element array.
 */
export function geminiLimitInfo(raw: string): {
    retryAfterMs?: number;
    window?: 'minute' | 'day';
    freeTier?: boolean;
    limit?: number;
} {
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    const error = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    const details: any[] = Array.isArray(error?.details) ? error.details : [];
    const info: { retryAfterMs?: number; window?: 'minute' | 'day'; freeTier?: boolean; limit?: number } = {};
    for (const detail of details) {
        const type = String(detail?.['@type'] ?? '');
        if (type.endsWith('RetryInfo') && typeof detail.retryDelay === 'string') {
            const seconds = Number.parseFloat(detail.retryDelay);
            if (Number.isFinite(seconds) && seconds >= 0) info.retryAfterMs = Math.ceil(seconds * 1000);
        }
        if (type.endsWith('QuotaFailure') && Array.isArray(detail.violations)) {
            for (const violation of detail.violations) {
                const id = String(violation?.quotaId ?? '');
                // A spent day outweighs a spent minute: waiting a minute fixes only one.
                if (/PerDay/i.test(id)) info.window = 'day';
                else if (!info.window && /PerMinute/i.test(id)) info.window = 'minute';
                if (/FreeTier/i.test(id)) info.freeTier = true;
                const value = Number(violation?.quotaValue);
                if (Number.isFinite(value) && value > 0) info.limit = value;
            }
        }
    }
    return info;
}

/** Milliseconds until the next midnight in Pacific time, when Google resets daily limits. */
export function msUntilPacificMidnight(now: Date = new Date()): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    // `hour12: false` writes midnight as 24 in some engines.
    const elapsed = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + now.getMilliseconds();
    return Math.max(1000, 24 * 3600 * 1000 - elapsed);
}

/** The same error, marked as not worth an immediate retry: its wait was already spent. */
function waitedOut(error: ModelRequestError): ModelRequestError {
    return new ModelRequestError(error.message, {
        kind: error.kind,
        ...(error.label !== undefined ? { label: error.label } : {}),
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.code !== undefined ? { code: error.code } : {}),
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.quotaTier !== undefined ? { quotaTier: error.quotaTier } : {}),
        retryable: false,
    });
}

/** Resolve after `ms`, or false at once when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export class EmbeddingProvider {
    readonly modelId: string;
    private readonly config: EmbeddingProviderConfig;
    private readonly fetchImpl: FetchLike;

    constructor(config: EmbeddingProviderConfig, fetchImpl: FetchLike) {
        this.config = config;
        this.fetchImpl = fetchImpl;
        // Stored alongside every vector so a later dimension or model change is
        // detectable rather than producing silent nonsense comparisons.
        this.modelId = `${config.model}-int8-${config.dimensions}`;
    }

    private headers(): Record<string, string> {
        if (this.config.wire === 'gemini') {
            return { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.apiKey };
        }
        return {
            'Content-Type': 'application/json',
            ...((this.config.authStyle ?? 'bearer') === 'x-api-key'
                ? { 'X-Api-Key': this.config.apiKey }
                : { Authorization: `Bearer ${this.config.apiKey}` }),
        };
    }

    private request(inputs: EmbedInput[]): { url: string; body: Record<string, unknown> } {
        const root = this.config.baseUrl.replace(/\/+$/, '');
        const images = inputs.some((input) => 'image' in input);
        if (this.config.wire === 'gemini' || (images && this.config.imageWire === 'gemini')) {
            const model = `models/${this.config.model}`;
            return {
                url: `${root}/${model}:batchEmbedContents`,
                body: {
                    // One request per input: parts within one content are embedded as one.
                    requests: inputs.map((input) => ({
                        model,
                        content: {
                            parts: ['image' in input
                                ? { inline_data: { mime_type: input.image.mimeType, data: input.image.base64 } }
                                : { text: input.text }],
                        },
                        ...(this.config.dimensions ? { outputDimensionality: this.config.dimensions } : {}),
                    })),
                },
            };
        }
        if (images) {
            // Ollama's own route, beside its OpenAI-compatible root, takes
            // pictures; the vectors come back whole and are cut to size here.
            return {
                url: `${root.replace(/\/v1$/, '')}/api/embed`,
                body: {
                    model: this.config.model,
                    input: inputs.map((input) => ('image' in input ? { image: input.image.base64 } : input.text)),
                },
            };
        }
        const texts = inputs.map((input) => ('text' in input ? input.text : ''));
        const body: Record<string, unknown> = { model: this.config.model, input: texts };
        // `dimensions` is supported by text-embedding-3-*; a provider that
        // ignores it returns its native size, which the caller then sees as a
        // dimension mismatch rather than as silently wrong results.
        if (this.config.dimensions) body.dimensions = this.config.dimensions;
        return { url: `${root}/embeddings`, body };
    }

    /** The vectors in a successful reply, in input order. */
    private vectorsIn(parsed: any, count: number, images: boolean): number[][] {
        const label = this.config.label;
        if (images && this.config.imageWire === 'ollama') {
            const rows = Array.isArray(parsed?.embeddings) ? parsed.embeddings : [];
            if (rows.length !== count) throw new Error(`${label} returned ${rows.length} embeddings for ${count} images`);
            // A prefix of the vector is a vector for these models: cut to the
            // dimension the index stores.
            return rows.map((row: any) => (Array.isArray(row) ? row.slice(0, this.config.dimensions || row.length) : row));
        }
        if (this.config.wire === 'gemini' || (images && this.config.imageWire === 'gemini')) {
            const rows = Array.isArray(parsed?.embeddings) ? parsed.embeddings : [];
            if (rows.length !== count) throw new Error(`${label} returned ${rows.length} embeddings for ${count} texts`);
            return rows.map((row: any) => row?.values);
        }
        const data = Array.isArray(parsed?.data) ? parsed.data : [];
        if (data.length !== count) {
            throw new Error(`${label} returned ${data.length} embeddings for ${count} texts`);
        }
        // The API documents `index`, but ordering it explicitly costs nothing
        // and a silently permuted batch would mislabel every vector.
        return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((row: any) => row?.embedding);
    }

    /**
     * Embed a batch of texts, returning int8 vectors in input order.
     *
     * Failures are `ModelRequestError`s carrying the status and the provider's
     * own sentence, so a caller can tell a rejected key from a dropped
     * connection without reading the message. A Gemini limit says which one it
     * was: `rate_limit` with the wait the API asked for, or `daily_quota` with
     * the time to the reset.
     */
    private async embedBatch(inputs: EmbedInput[], signal?: AbortSignal): Promise<number[][]> {
        const images = inputs.some((input) => 'image' in input);
        const { url, body } = this.request(inputs);
        const label = this.config.label;

        const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const { controller, release } = childAbortController(signal);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        let response: { ok: boolean; status: number; statusText?: string; text: () => Promise<string> };
        let raw: string;
        try {
            response = await untilAborted(
                this.fetchImpl(url, {
                    method: 'POST',
                    headers: this.headers(),
                    body: JSON.stringify(body),
                    signal: controller.signal,
                }),
                controller.signal,
            );
            raw = await untilAborted(response.text(), controller.signal);
        } catch (error) {
            if (timedOut) {
                const wait = describeWait(timeoutMs);
                throw new ModelRequestError(`${label} embeddings did not answer within ${wait}`, {
                    kind: 'timeout',
                    label,
                    detail: `No answer within ${wait}.`,
                });
            }
            if (signal?.aborted) {
                throw new ModelRequestError(`${label} embeddings request cancelled`, { kind: 'cancelled', label });
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ModelRequestError(`${label} embeddings could not be reached: ${message}`, {
                kind: 'network',
                label,
            });
        } finally {
            clearTimeout(timer);
            release();
        }

        if (!response.ok) {
            const described = describeErrorBody(raw);
            const limit = response.status === 429 && this.config.wire === 'gemini' ? geminiLimitInfo(raw) : {};
            const daily = limit.window === 'day';
            throw new ModelRequestError(
                `${label} embeddings failed: ${response.status} ${response.statusText ?? ''} ${
                    described.detail ?? ''
                }`.replace(/\s+/g, ' ').trim(),
                {
                    kind: 'http',
                    label,
                    // A refused key reported under another status (Google's 400) is a 401.
                    status: described.code === 'invalid_api_key' ? 401 : response.status,
                    ...(described.detail !== undefined ? { detail: described.detail } : {}),
                    ...(limit.window ? { quotaTier: limit.freeTier ? 'free' as const : 'paid' as const } : {}),
                    ...(daily
                        ? { code: 'daily_quota', retryAfterMs: msUntilPacificMidnight() }
                        : limit.window === 'minute'
                          ? { code: 'rate_limit', ...(limit.retryAfterMs !== undefined ? { retryAfterMs: limit.retryAfterMs } : {}) }
                          : {
                                ...(described.code !== undefined ? { code: described.code } : {}),
                                ...(limit.retryAfterMs !== undefined ? { retryAfterMs: limit.retryAfterMs } : {}),
                            }),
                },
            );
        }

        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error(`${this.config.label} embeddings returned non-JSON`);
        }

        return this.vectorsIn(parsed, inputs.length, images).map((vector) => {
            if (!Array.isArray(vector) || vector.length === 0) {
                throw new Error(`${this.config.label} returned an empty embedding`);
            }
            return quantizeToInt8(vector);
        });
    }

    /**
     * One batch, waiting out per-minute limits as the endpoint asks.
     *
     * An indexing batch waits as often as it takes, within reason: the limit
     * turns over, and pausing the whole run on a minute would only restart it
     * later. A search waits once, briefly. A spent day is never waited out
     * here — that is hours, and the caller decides what to do with it. Once a
     * wait has been spent, the error is passed on as not worth retrying at
     * once, so a caller's own quick retries do not hammer the same limit.
     */
    private async limitedBatch(inputs: EmbedInput[], purpose: 'index' | 'query', signal?: AbortSignal): Promise<number[][]> {
        let waits = 0;
        for (;;) {
            try {
                const vectors = await this.embedBatch(inputs, signal);
                this.config.onRequest?.({ ok: true, purpose, count: inputs.length });
                return vectors;
            } catch (error) {
                this.config.onRequest?.({ ok: false, purpose, count: inputs.length, error });
                const limited = isModelRequestError(error) && error.status === 429 && error.code !== 'daily_quota';
                if (!limited) throw error;
                const asked = error.retryAfterMs ?? (purpose === 'query' ? 5_000 : 30_000);
                const wait = purpose === 'query'
                    ? (waits === 0 && asked <= QUERY_RATE_WAIT_MS ? asked : null)
                    : (waits < MAX_INDEX_RATE_WAITS ? Math.min(Math.max(asked, 1_000), MAX_INDEX_RATE_WAIT_MS) : null);
                if (wait === null) throw waits > 0 || purpose === 'query' ? waitedOut(error) : error;
                waits += 1;
                if (!(await pause(wait, signal))) {
                    throw new ModelRequestError(`${this.config.label} embeddings request cancelled`, {
                        kind: 'cancelled',
                        label: this.config.label,
                    });
                }
            }
        }
    }

    /** Embed many items, batching to stay inside the provider's limits. */
    async generateEmbeddings(
        items: Array<{ item_id: number; text: string }>,
        signal?: AbortSignal,
    ): Promise<EmbeddingsResponse> {
        const batchSize = this.config.batchSize ?? DEFAULT_BATCH_SIZE;
        const prefix = this.config.documentPrefix ?? '';
        const out: EmbeddingResult[] = [];

        for (let start = 0; start < items.length; start += batchSize) {
            const batch = items.slice(start, start + batchSize);
            await this.config.beforeIndexBatch?.(batch.length, signal);
            const vectors = await this.limitedBatch(batch.map((entry) => ({ text: prefix + entry.text })), 'index', signal);
            batch.forEach((entry, i) => {
                out.push({
                    item_id: entry.item_id,
                    embedding: vectors[i],
                    dimensions: vectors[i].length,
                });
            });
        }

        return { embeddings: out, model_id: this.modelId };
    }

    /** Embed one search query. */
    async generateQueryEmbedding(
        query: string,
        signal?: AbortSignal,
    ): Promise<{ embedding: number[]; dimensions: number }> {
        const [vector] = await this.limitedBatch([{ text: (this.config.queryPrefix ?? '') + query }], 'query', signal);
        return { embedding: vector, dimensions: vector.length };
    }

    /** Whether this model embeds pictures, in the same space as its texts. */
    get embedsImages(): boolean {
        return this.config.imageWire !== undefined;
    }

    /**
     * Embed pictures — rendered pages — for the page-image index, in the
     * space a query from `generateQueryEmbedding` is compared in. A picture
     * takes no prefix. Paced and limited like an indexing batch of texts.
     */
    async generateImageEmbeddings(
        images: Array<{ item_id: number; mimeType: string; base64: string }>,
        signal?: AbortSignal,
    ): Promise<EmbeddingsResponse> {
        if (!this.embedsImages) throw new Error(`${this.config.label} embeds text only`);
        const batchSize = this.config.imageBatchSize ?? 8;
        const out: EmbeddingResult[] = [];
        for (let start = 0; start < images.length; start += batchSize) {
            const batch = images.slice(start, start + batchSize);
            await this.config.beforeIndexBatch?.(batch.length, signal, 'image');
            const vectors = await this.limitedBatch(
                batch.map((entry) => ({ image: { mimeType: entry.mimeType, base64: entry.base64 } })),
                'index',
                signal,
            );
            batch.forEach((entry, i) => {
                out.push({ item_id: entry.item_id, embedding: vectors[i], dimensions: vectors[i].length });
            });
        }
        return { embeddings: out, model_id: this.modelId };
    }
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Each preset is one index: vectors are stored under the preset's `model`, and
 * vectors from different models are not comparable, so switching preset means
 * building (or reusing) that model's own index. The tables take any length;
 * what must never change under one `model` is its dimension, prefixes or
 * quantization — a change to any of them needs a new model id, or new
 * vectors would be ranked against old ones that mean something else.
 */
export const EMBEDDING_PRESETS = {
    openai: {
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-3-large',
        dimensions: 512,
        authStyle: 'bearer' as const,
        batchSize: 64,
    },
    /**
     * Gemini Embedding 2 on the Gemini API, with the Google key (the Gemini
     * card's, unless Settings gives embeddings a key of their own).
     *
     * Trained to tell a query from a document by a short instruction in front
     * of the text, in the form Google documents. 512 of its 3072 dimensions:
     * it is trained so that a prefix of the vector is a vector, and on a
     * research library a 512 prefix ranked papers and passages as the full
     * length did.
     *
     * The free tier counts every text in a batch as a request — about 100 a
     * minute and 1000 a day per model — and may use what is sent to improve
     * Google's products; a paid key has neither limit worth the name.
     */
    google: {
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-embedding-2',
        dimensions: 512,
        wire: 'gemini' as const,
        // Under the API's 100: on a free key the indexer is paced to 80 texts
        // a minute (embeddingQuota.ts), and two batches of 40 fill it.
        batchSize: 40,
        // Pages as pictures: the API takes at most 6 images to a request.
        imageWire: 'gemini' as const,
        imageBatchSize: 6,
        queryPrefix: 'task: search result | query: ',
        documentPrefix: 'title: none | text: ',
    },
    /**
     * EmbeddingGemma 2 (Google's open model, 440M parameters, text and image)
     * on this computer through Ollama 0.40 or later: free, and nothing leaves
     * the machine. The exact q8_0 build, so every computer makes the same
     * vectors.
     *
     * At its full 768 dimensions, with the prefixes it was trained on. In a
     * measured comparison on a research library (15 paraphrased queries in
     * English and Chinese, 19,000 passages) it found the right passage about
     * as often as the hosted models (MRR 0.875) and far more often than
     * bge-m3 (0.556); a 512 prefix of its vector ranked a little worse.
     *
     * The address here is only the default: the one set on the Ollama card is
     * passed in as `baseUrl`, as it is for chat. A machine embedding on its
     * CPU, perhaps after loading the model, gets longer per batch.
     */
    ollama: {
        label: 'Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'embeddinggemma-2:440m-q8_0-text-vision',
        dimensions: 768,
        authStyle: 'bearer' as const,
        batchSize: 16,
        timeoutMs: 180_000,
        queryPrefix: 'task: search result | query: ',
        documentPrefix: 'title: none | text: ',
        // The text-vision build: pages as pictures go to Ollama's own route.
        imageWire: 'ollama' as const,
        imageBatchSize: 4,
    },
} as const;

export type EmbeddingPresetId = keyof typeof EMBEDDING_PRESETS;

/**
 * Ollama's OpenAI-compatible root under a configured address.
 *
 * The Ollama card stores the server address (`http://host:11434`), while the
 * embedding route lives under `/v1`; either form is accepted here.
 */
function ollamaCompatibleRoot(address: string): string {
    const trimmed = address.trim().replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function embeddingProviderFromPreset(
    id: EmbeddingPresetId,
    apiKey: string,
    fetchImpl: FetchLike,
    overrides: Partial<EmbeddingProviderConfig> = {},
): EmbeddingProvider {
    const preset: EmbeddingProviderConfig = { ...EMBEDDING_PRESETS[id], apiKey };
    const baseUrl = overrides.baseUrl?.trim()
        ? id === 'ollama'
            ? ollamaCompatibleRoot(overrides.baseUrl)
            : overrides.baseUrl.trim()
        : preset.baseUrl;
    return new EmbeddingProvider({ ...preset, ...overrides, baseUrl, apiKey }, fetchImpl);
}
