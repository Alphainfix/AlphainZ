/**
 * One semantic index per embedding model.
 *
 * Vectors from different models are not comparable, so the user's choice of
 * embedding provider used to overwrite the index: switching to a local model
 * threw away the cloud model's vectors, and switching back rebuilt them. Each
 * model now keeps its own set — keyed per model in every table — so a switch
 * only decides which set is searched and which set the scan fills in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/clients/embeddingsService', () => ({
    embeddingsService: { generateEmbeddingsWithRetry: vi.fn() },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getClientDateModifiedAsISOString: vi.fn(),
    getClientDateModifiedBatch: vi.fn(),
}));

import pkg from '../../../package.json';
import { BeaverDB } from '../../../src/services/database';
import { EmbeddingIndexer } from '../../../src/services/embeddingIndexer';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const PREFIX = pkg.config.prefsPrefix;
const A = 'text-embedding-3-large';
const B = 'embeddinggemma-2:440m-q8_0-text-vision';

const vector = (fill: number) => BeaverDB.embeddingToBlob(new Int8Array(4).fill(fill));

function itemRecord(itemId: number, modelId: string, hash = `hash-${itemId}`) {
    return {
        item_id: itemId,
        library_id: 1,
        zotero_key: `KEY${itemId}`,
        version: 1,
        client_date_modified: '2026-01-01T00:00:00.000Z',
        content_hash: hash,
        embedding: vector(itemId),
        dimensions: 4,
        model_id: modelId,
    };
}

function chunk(index: number, fill: number) {
    return { pageIndex: 0, pageLabel: '1', chunkIndex: index, text: `passage ${index}`, embedding: vector(fill) };
}

describe('embeddings are stored per model', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
    });
    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('keeps one item vector per model, and answers per model', async () => {
        await db.upsertEmbedding(itemRecord(11, A));
        await db.upsertEmbedding(itemRecord(11, B, 'hash-11-b'));

        expect(await db.getEmbeddingCount(1)).toBe(2);
        expect(await db.getEmbeddingCount(1, A)).toBe(1);
        expect(await db.getEmbeddingCount(1, B)).toBe(1);
        expect((await db.getEmbedding(11, A))?.content_hash).toBe('hash-11');
        expect((await db.getEmbedding(11, B))?.content_hash).toBe('hash-11-b');
        expect((await db.getAllEmbeddings(A)).map((r) => r.model_id)).toEqual([A]);
        expect((await db.getEmbeddingsByItemIds([11], [1], B)).map((r) => r.model_id)).toEqual([B]);
        expect(await db.getContentHashes([11], A)).toEqual(new Map([[11, 'hash-11']]));
        // A second write for the same model replaces, as before.
        await db.upsertEmbedding(itemRecord(11, A, 'hash-11-new'));
        expect(await db.getEmbeddingCount(1, A)).toBe(1);
        expect((await db.getEmbedding(11, A))?.content_hash).toBe('hash-11-new');
    });

    it('removes every model\'s vector when the item itself goes away', async () => {
        await db.upsertEmbedding(itemRecord(11, A));
        await db.upsertEmbedding(itemRecord(11, B));
        await db.deleteEmbedding(11);
        expect(await db.getEmbeddingCount()).toBe(0);
    });

    it('replaces only the active model\'s passages of a document', async () => {
        await db.replaceChunks(1, 'ATT1', 'PARENT', A, 4, [chunk(0, 1), chunk(1, 2)]);
        await db.replaceChunks(1, 'ATT1', 'PARENT', B, 4, [chunk(0, 3)]);
        expect((await db.getChunksForSearch(A)).length).toBe(2);
        expect((await db.getChunksForSearch(B)).length).toBe(1);

        // Re-indexing the document for model A leaves model B's passages alone.
        await db.replaceChunks(1, 'ATT1', 'PARENT', A, 4, [chunk(0, 9)]);
        expect((await db.getChunksForSearch(A)).map((c) => c.text)).toEqual(['passage 0']);
        expect((await db.getChunksForSearch(B)).length).toBe(1);
        expect(await db.getChunkStats(B)).toEqual({ chunks: 1, attachments: 1 });
        expect(await db.getChunkedAttachmentKeys(B)).toEqual(new Set(['1-ATT1']));
    });

    it('records the last scan per model', async () => {
        const state = (modelId: string) => ({
            library_id: 1, model_id: modelId, last_scan_timestamp: '2026-01-02T00:00:00.000Z',
            max_client_date_modified: '2026-01-01T00:00:00.000Z', item_count: 3, embedding_count: 3,
        });
        await db.upsertEmbeddingIndexState(state(A));
        await db.upsertEmbeddingIndexState({ ...state(B), embedding_count: 1 });
        expect((await db.getEmbeddingIndexState(1, A))?.embedding_count).toBe(3);
        expect((await db.getEmbeddingIndexState(1, B))?.embedding_count).toBe(1);
        await db.deleteEmbeddingIndexState(1, B);
        expect(await db.getEmbeddingIndexState(1, B)).toBeNull();
        expect(await db.getEmbeddingIndexState(1, A)).not.toBeNull();
        await db.deleteEmbeddingIndexState(1);
        expect(await db.getEmbeddingIndexState(1, A)).toBeNull();
    });
});

describe('migrating an index built before vectors were kept per model', () => {
    let conn: MockDBConnection;

    beforeEach(async () => {
        conn = new MockDBConnection();
        // The old shape: one vector per item, one passage per position, one
        // scan record per library — and no sentence columns yet on the chunks.
        await conn.queryAsync(`
            CREATE TABLE embeddings (
                item_id INTEGER NOT NULL, library_id INTEGER NOT NULL, zotero_key TEXT NOT NULL,
                version INTEGER NOT NULL, client_date_modified TEXT NOT NULL, content_hash TEXT NOT NULL,
                embedding BLOB NOT NULL, dimensions INTEGER NOT NULL, model_id TEXT NOT NULL,
                indexed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_id)
            )`);
        for (const id of [11, 12]) {
            await conn.queryAsync(
                `INSERT INTO embeddings (item_id, library_id, zotero_key, version, client_date_modified, content_hash, embedding, dimensions, model_id)
                 VALUES (?, 1, ?, 1, '2026-01-01T00:00:00.000Z', ?, ?, 4, ?)`,
                [id, `KEY${id}`, `hash-${id}`, vector(id), A],
            );
        }
        await conn.queryAsync(`
            CREATE TABLE chunk_embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER NOT NULL, attachment_key TEXT NOT NULL,
                parent_key TEXT, page_index INTEGER NOT NULL, page_label TEXT, chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL, embedding BLOB NOT NULL, dimensions INTEGER NOT NULL, model_id TEXT NOT NULL,
                indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (library_id, attachment_key, page_index, chunk_index)
            )`);
        for (const index of [0, 1]) {
            await conn.queryAsync(
                `INSERT INTO chunk_embeddings (library_id, attachment_key, parent_key, page_index, page_label, chunk_index, text, embedding, dimensions, model_id)
                 VALUES (1, 'ATT1', 'PARENT', 0, '1', ?, ?, ?, 4, ?)`,
                [index, `passage ${index}`, vector(index + 1), A],
            );
        }
        await conn.queryAsync(`
            CREATE TABLE embedding_index_state (
                library_id INTEGER PRIMARY KEY, last_scan_timestamp TEXT NOT NULL,
                max_client_date_modified TEXT NOT NULL, item_count INTEGER NOT NULL, embedding_count INTEGER NOT NULL
            )`);
        await conn.queryAsync(
            `INSERT INTO embedding_index_state VALUES (1, '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 2, 2)`,
        );
    });
    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('keeps every vector, widens the keys, and forgets only the scan record', async () => {
        const db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');

        expect(await db.getEmbeddingCount(1, A)).toBe(2);
        expect((await db.getEmbedding(11, A))?.content_hash).toBe('hash-11');
        expect((await db.getChunksForSearch(A)).map((c) => c.text)).toEqual(['passage 0', 'passage 1']);
        // Widened: the same item and the same passage can now be stored under another model.
        await db.upsertEmbedding(itemRecord(11, B));
        await db.replaceChunks(1, 'ATT1', 'PARENT', B, 4, [chunk(0, 7)]);
        expect(await db.getEmbeddingCount(1)).toBe(3);
        expect((await db.getChunksForSearch(A)).length).toBe(2);
        expect((await db.getChunksForSearch(B)).length).toBe(1);
        // The scan record is a cache and is not carried over; the next scan
        // re-establishes it without re-embedding anything.
        expect(await db.getEmbeddingIndexState(1, A)).toBeNull();

        // Opening again is a no-op.
        const again = new BeaverDB(conn as any);
        await again.initDatabase('0.99.0');
        expect(await again.getEmbeddingCount(1)).toBe(3);
    });
});

describe('switching the embedding provider', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;
    let prefs: Record<string, unknown>;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
        prefs = { [`${PREFIX}.embeddingProvider`]: 'openai', [`${PREFIX}.llmKeyOpenai`]: 'k' };
        (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
        // The library has 5 unchanged items.
        (globalThis as any).Zotero.DB = {
            queryAsync: vi.fn(async (_sql: string, _params: unknown[], options: any) => {
                options?.onRow?.({ getResultByIndex: (i: number) => (i === 0 ? '2026-01-01 00:00:00' : 5) });
            }),
        };
        (globalThis as any).Zotero.Date = { sqlToISO8601: (d: string) => d.replace(' ', 'T') + 'Z' };
    });
    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('starts a scan for the new model, and finds the old model\'s index intact on the way back', async () => {
        const indexer = new EmbeddingIndexer(db);
        await indexer.saveIndexState(1, { maxClientDateModified: '2026-01-01T00:00:00Z', itemCount: 5 });
        expect((await indexer.shouldRunFullDiff(1)).needsDiff).toBe(false);

        // The user picks the local model: nothing is known about its index yet.
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        const forNewModel = await indexer.shouldRunFullDiff(1);
        expect(forNewModel.needsDiff).toBe(true);
        expect(forNewModel.reason).toContain(B);
        await indexer.saveIndexState(1, { maxClientDateModified: '2026-01-01T00:00:00Z', itemCount: 5 });
        expect((await db.getEmbeddingIndexState(1, B))?.model_id).toBe(B);

        // …and back: the cloud model's scan record is still there, so no rebuild.
        prefs[`${PREFIX}.embeddingProvider`] = 'openai';
        expect((await indexer.shouldRunFullDiff(1)).needsDiff).toBe(false);
    });
});

describe('freeing the space one model takes', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
        await db.upsertEmbedding(itemRecord(11, A));
        await db.upsertEmbedding(itemRecord(12, A));
        await db.upsertEmbedding(itemRecord(11, B));
        await db.replaceChunks(1, 'ATT1', 'PARENT', A, 4, [chunk(0, 1), chunk(1, 2)]);
        await db.replaceChunks(1, 'ATT1', 'PARENT', B, 4, [chunk(0, 3)]);
        await db.upsertEmbeddingIndexState({ library_id: 1, model_id: A, last_scan_timestamp: 't', max_client_date_modified: 't', item_count: 2, embedding_count: 2 });
        await db.upsertEmbeddingIndexState({ library_id: 1, model_id: B, last_scan_timestamp: 't', max_client_date_modified: 't', item_count: 2, embedding_count: 1 });
    });
    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('lists every model with what it holds', async () => {
        const models = await db.listEmbeddingModels();
        expect(models.map((m) => [m.model_id, m.items, m.chunks])).toEqual([[B, 1, 1], [A, 2, 2]]);
        // 4 int8 values per vector: (2 items + 2 chunks) × 4 bytes.
        expect(models.find((m) => m.model_id === A)?.bytes).toBe(16);
    });

    it('deletes one model\'s vectors, passages and scan record, and nothing else', async () => {
        expect(await db.deleteEmbeddingsForModel(A)).toEqual({ items: 2, chunks: 2 });
        expect(await db.getEmbeddingCount(1, A)).toBe(0);
        expect((await db.getChunksForSearch(A)).length).toBe(0);
        expect(await db.getEmbeddingIndexState(1, A)).toBeNull();
        expect(await db.getEmbeddingCount(1, B)).toBe(1);
        expect((await db.getChunksForSearch(B)).length).toBe(1);
        expect((await db.getEmbeddingIndexState(1, B))?.embedding_count).toBe(1);
        expect((await db.listEmbeddingModels()).map((m) => m.model_id)).toEqual([B]);
    });
});

describe('documents whose passages have no sentence ranges', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
    });
    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('lists only documents with no ranged passage at all, not a sentence-aware index with a heading or two', async () => {
        // OLD: indexed before sentence-aware chunking — every passage unranged.
        await db.replaceChunks(1, 'OLD', 'P', A, 4, [chunk(0, 1), chunk(1, 2)]);
        // MIXED: sentence-aware, but a heading carries no range. Normal.
        await db.replaceChunks(1, 'MIXED', 'P', A, 4, [
            { ...chunk(0, 1), sentenceStart: 1, sentenceEnd: 3 },
            chunk(1, 2),
        ]);
        // NEW: fully ranged.
        await db.replaceChunks(1, 'NEW', 'P', A, 4, [{ ...chunk(0, 1), sentenceStart: 4, sentenceEnd: 5 }]);
        expect(await db.getAttachmentKeysLackingRanges(A)).toEqual(new Set(['1-OLD']));
        // Another model's index is a separate question.
        expect(await db.getAttachmentKeysLackingRanges(B)).toEqual(new Set());
    });
});
