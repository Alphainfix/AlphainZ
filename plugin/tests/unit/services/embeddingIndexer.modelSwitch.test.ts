/**
 * A provider switch while a batch is in flight.
 *
 * The vectors that come back were computed by the model the request went to,
 * but the index they would land in belongs to the model now selected. They
 * are dropped, and the run ends; the switch itself starts the new model's run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/clients/embeddingsService', () => ({
    embeddingsService: { generateEmbeddingsWithRetry: vi.fn() },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getClientDateModifiedAsISOString: vi.fn(),
    getClientDateModifiedBatch: vi.fn(),
}));
vi.mock('../../../src/services/llm/localEmbeddingsService', () => ({
    localEmbeddingsService: { generateEmbeddingsWithRetry: vi.fn() },
}));

import pkg from '../../../package.json';
import { EmbeddingIndexer } from '../../../src/services/embeddingIndexer';
import { localEmbeddingsService } from '../../../src/services/llm/localEmbeddingsService';
import { getClientDateModifiedBatch } from '../../../src/utils/zoteroUtils';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown>;

const item = (id: number) => ({
    id, libraryID: 1, key: `KEY${id}`, version: 1,
    isRegularItem: () => true,
    getField: (field: string) => field === 'title'
        ? `A sufficiently long title number ${id}`
        : field === 'abstractNote' ? 'An abstract long enough to clear the minimum content threshold for indexing.' : '',
});

function fakeDb() {
    return {
        getContentHashes: vi.fn().mockResolvedValue(new Map()),
        upsertEmbeddingsBatch: vi.fn().mockResolvedValue(undefined),
        removeFailedEmbeddingsBatch: vi.fn().mockResolvedValue(undefined),
        recordFailedEmbeddingsBatch: vi.fn().mockResolvedValue(undefined),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    prefs = { [`${PREFIX}.embeddingProvider`]: 'openai', [`${PREFIX}.llmKeyOpenai`]: 'k' };
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (globalThis as any).Zotero.Items = {
        getAsync: vi.fn().mockResolvedValue([item(11), item(12)]),
        loadDataTypes: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getClientDateModifiedBatch).mockResolvedValue(new Map([[11, '2026-01-01T00:00:00.000Z'], [12, '2026-01-01T00:00:00.000Z']]));
});

describe('EmbeddingIndexer when the embedding provider changes mid-batch', () => {
    it('labels a normal batch with the model that produced it', async () => {
        vi.mocked(localEmbeddingsService.generateEmbeddingsWithRetry as any).mockImplementation(async (_texts: string[], ids: number[]) => ({
            embeddings: ids.map((item_id) => ({ item_id, embedding: [1, 2, 3, 4] })),
        }));
        const db = fakeDb();
        const result = await new EmbeddingIndexer(db as any).indexItemIdsBatch([11, 12], { batchSize: 2 });
        expect(result.indexed).toBe(2);
        expect(db.upsertEmbeddingsBatch).toHaveBeenCalledTimes(1);
        for (const record of (db.upsertEmbeddingsBatch.mock.calls[0] as any)[0]) {
            expect(record.model_id).toBe('text-embedding-3-large');
        }
    });

    it('drops the batch and stops when the provider changed while the request was out', async () => {
        vi.mocked(localEmbeddingsService.generateEmbeddingsWithRetry as any).mockImplementation(async (_texts: string[], ids: number[]) => {
            // The user picks Ollama while OpenAI is still answering.
            prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
            return { embeddings: ids.map((item_id) => ({ item_id, embedding: [1, 2, 3, 4] })) };
        });
        const db = fakeDb();
        const result = await new EmbeddingIndexer(db as any).indexItemIdsBatch([11, 12], { batchSize: 2 });
        expect(db.upsertEmbeddingsBatch).not.toHaveBeenCalled();
        expect(result.indexed).toBe(0);
        expect(result.incomplete).toBe(true);
    });
});
