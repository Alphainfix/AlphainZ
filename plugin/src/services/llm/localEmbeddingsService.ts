/**
 * The embeddings service, backed by the user's own provider.
 *
 * `embeddingsService` in agent-core posts to Beaver's backend. The two call
 * sites that use it — query embedding for topic search, batch embedding for the
 * index — are given this instead when a local provider is configured. It keeps
 * their exact signatures so neither call site has to know which one it got.
 *
 * The int8 quantization happens on this side of the boundary, as it did on the
 * server: the `embeddings` table stores int8 and the similarity code reads int8,
 * so a float vector reaching either would be silently wrong rather than broken.
 */

import { buildEmbeddingProviderFromPrefs } from './agentConfig';
import type { EmbeddingResult } from './embeddings';
import { isModelRequestError } from './sse';

/** Matches `QueryEmbeddingResponse` in agent-core's client. */
export interface LocalQueryEmbeddingResponse {
    item_id: number;
    embedding: number[];
    dimensions: number;
}

/** Matches `GenerateEmbeddingsResponse` in agent-core's client. */
export interface LocalGenerateEmbeddingsResponse {
    embeddings: EmbeddingResult[];
    model: string;
}

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/**
 * Retries allowed after timeouts. Each attempt already waited out a full
 * deadline (a minute hosted, three for Ollama), so a dead endpoint retried as
 * often as a quick 503 would hold the search or the indexer for many minutes.
 */
const MAX_TIMEOUT_RETRIES = 1;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a failure is worth another attempt.
 *
 * Decided by the provider's status and the kind of failure, as the request
 * reported them: a rejected key or an unknown model fails identically forever,
 * so retrying it only delays the error the user needs to see, while a 503 or a
 * dropped connection may well succeed a moment later. The message is not
 * read, since it quotes the provider's body and a body can hold any digits.
 */
function isTransient(error: unknown): boolean {
    return isModelRequestError(error) ? error.retryable : true;
}

async function withRetry<T>(operation: () => Promise<T>, maxRetries: number): Promise<T> {
    let lastError: unknown;
    let timeouts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (isModelRequestError(error) && error.kind === 'timeout') timeouts += 1;
            if (!isTransient(error) || attempt >= maxRetries || timeouts > MAX_TIMEOUT_RETRIES) break;
            await sleep(BASE_DELAY_MS * 2 ** attempt);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const localEmbeddingsService = {
    async generateQueryEmbedding(query: string): Promise<LocalQueryEmbeddingResponse> {
        const provider = buildEmbeddingProviderFromPrefs();
        if (!provider) throw new Error('No embedding provider is configured.');
        const result = await provider.generateQueryEmbedding(query);
        // item_id is meaningless for a query; the shape carries it because the
        // backend reused one response type for both calls.
        return { item_id: 0, embedding: result.embedding, dimensions: result.dimensions };
    },

    async generateQueryEmbeddingWithRetry(
        query: string,
        maxRetries: number = DEFAULT_MAX_RETRIES,
    ): Promise<LocalQueryEmbeddingResponse> {
        return withRetry(() => this.generateQueryEmbedding(query), maxRetries);
    },

    async generateEmbeddings(
        texts: string[],
        itemIds: number[],
    ): Promise<LocalGenerateEmbeddingsResponse> {
        const provider = buildEmbeddingProviderFromPrefs();
        if (!provider) throw new Error('No embedding provider is configured.');
        if (texts.length !== itemIds.length) {
            // A positional mismatch would attach vectors to the wrong items —
            // the kind of corruption that only shows up as bad search results
            // much later.
            throw new Error(
                `embedding request mismatch: ${texts.length} texts for ${itemIds.length} ids`,
            );
        }
        const response = await provider.generateEmbeddings(
            texts.map((text, index) => ({ item_id: itemIds[index], text })),
        );
        return { embeddings: response.embeddings, model: response.model_id };
    },

    async generateEmbeddingsWithRetry(
        texts: string[],
        itemIds: number[],
        maxRetries: number = DEFAULT_MAX_RETRIES,
    ): Promise<LocalGenerateEmbeddingsResponse> {
        return withRetry(() => this.generateEmbeddings(texts, itemIds), maxRetries);
    },
};
