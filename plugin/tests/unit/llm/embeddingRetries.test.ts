/**
 * Which failed embedding requests are sent again.
 *
 * Topic search and the indexer retry a failed request, which is right for a
 * 503 or a dropped connection and pointless for a rejected key. That is told
 * from the status the request reported, not from the message, which quotes the
 * provider's body and can hold any digits. A timeout has already waited out a
 * full deadline, so it is sent again only once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
    generateQueryEmbedding: vi.fn(),
    generateEmbeddings: vi.fn(),
}));
vi.mock('../../../src/services/llm/agentConfig', () => ({
    buildEmbeddingProviderFromPrefs: () => provider,
}));

import { localEmbeddingsService } from '../../../src/services/llm/localEmbeddingsService';
import { ModelRequestError } from '../../../src/services/llm/sse';

const http = (status: number, message = `OpenAI embeddings failed: ${status}`) =>
    new ModelRequestError(message, { kind: 'http', status, label: 'OpenAI' });
const timeout = () =>
    new ModelRequestError('OpenAI embeddings did not answer within 60 s', { kind: 'timeout', label: 'OpenAI' });
const vector = { embedding: [1, 2, 3], dimensions: 3 };

/** Settle `promise` while the retry waits run on fake time. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: any }> {
    const outcome = promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return outcome;
}

beforeEach(() => {
    vi.useFakeTimers();
    provider.generateQueryEmbedding.mockReset();
    provider.generateEmbeddings.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('embedding retries', () => {
    it('does not send a request the provider rejected outright', async () => {
        provider.generateQueryEmbedding.mockRejectedValue(http(401));
        const { error } = await settle(localEmbeddingsService.generateQueryEmbeddingWithRetry('q'));
        expect(error).toMatchObject({ status: 401 });
        expect(provider.generateQueryEmbedding).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 404, whatever its message says', async () => {
        provider.generateQueryEmbedding.mockRejectedValue(http(404, 'model "bge-m3" is not loaded'));
        await settle(localEmbeddingsService.generateQueryEmbeddingWithRetry('q'));
        expect(provider.generateQueryEmbedding).toHaveBeenCalledTimes(1);
    });

    it('retries a server error even when its message quotes a 404', async () => {
        provider.generateQueryEmbedding
            .mockRejectedValueOnce(http(503, 'OpenAI embeddings failed: 503 upstream answered 404 for shard 3'))
            .mockResolvedValueOnce(vector);
        const { value } = await settle(localEmbeddingsService.generateQueryEmbeddingWithRetry('q'));
        expect(value).toMatchObject({ embedding: [1, 2, 3] });
        expect(provider.generateQueryEmbedding).toHaveBeenCalledTimes(2);
    });

    it('gives up on a server error once the retries are spent', async () => {
        provider.generateQueryEmbedding.mockRejectedValue(http(503));
        await settle(localEmbeddingsService.generateQueryEmbeddingWithRetry('q', 3));
        expect(provider.generateQueryEmbedding).toHaveBeenCalledTimes(4);
    });

    it('sends a request that timed out again only once', async () => {
        provider.generateQueryEmbedding.mockRejectedValue(timeout());
        const { error } = await settle(localEmbeddingsService.generateQueryEmbeddingWithRetry('q', 3));
        expect(error).toMatchObject({ kind: 'timeout' });
        expect(provider.generateQueryEmbedding).toHaveBeenCalledTimes(2);
    });

    it('applies the same rules to indexing', async () => {
        provider.generateEmbeddings.mockRejectedValue(timeout());
        await settle(localEmbeddingsService.generateEmbeddingsWithRetry(['a'], [1], 3));
        expect(provider.generateEmbeddings).toHaveBeenCalledTimes(2);
    });
});
