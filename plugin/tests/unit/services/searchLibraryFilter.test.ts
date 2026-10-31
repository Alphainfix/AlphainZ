/**
 * Passage and figure search read only the libraries they are given.
 *
 * Exclusion is an access-control boundary: an excluded library's passages and
 * pages must not reach the model. A list of libraries narrows the search; an
 * empty list means no library is searchable and finds nothing — it must never
 * be read as "no filter".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/clients/embeddingsService', () => ({
    embeddingsService: { generateEmbeddingsWithRetry: vi.fn() },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getClientDateModifiedAsISOString: vi.fn(),
    getClientDateModifiedBatch: vi.fn(),
}));

import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const MODEL = 'gemini-embedding-2';
const vector = (fill: number) => new Uint8Array(new Int8Array(4).fill(fill).buffer);

describe('searching passages and pages by library', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
        for (const libraryId of [1, 2]) {
            await db.replaceChunks(libraryId, `PDF${libraryId}`, null, MODEL, 4, [
                { pageIndex: 0, chunkIndex: 0, text: `passage in library ${libraryId}`, embedding: vector(libraryId) },
            ]);
            await db.replacePageImages(libraryId, `PDF${libraryId}`, null, MODEL, 4, [
                { pageIndex: 0, embedding: vector(libraryId) },
            ]);
        }
    });
    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('reads only the libraries listed', async () => {
        expect((await db.getChunksForSearch(MODEL, [2])).map((c) => c.libraryId)).toEqual([2]);
        expect((await db.getPageImagesForSearch(MODEL, [2])).map((p) => p.libraryId)).toEqual([2]);
    });

    it('finds nothing when no library is searchable', async () => {
        expect(await db.getChunksForSearch(MODEL, [])).toEqual([]);
        expect(await db.getPageImagesForSearch(MODEL, [])).toEqual([]);
    });

    it('reads every library only when no list is given at all', async () => {
        expect((await db.getChunksForSearch(MODEL)).map((c) => c.libraryId).sort()).toEqual([1, 2]);
        expect((await db.getPageImagesForSearch(MODEL)).map((p) => p.libraryId).sort()).toEqual([1, 2]);
    });
});
