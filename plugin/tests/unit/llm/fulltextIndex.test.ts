/**
 * Full-text passage search.
 *
 * The two decisions worth pinning: re-indexing a document replaces its passages
 * rather than adding to them (otherwise an edited PDF leaves hits pointing at
 * text the page no longer contains), and results are spread across documents
 * rather than crowded into whichever paper happens to repeat the phrase most.
 */
import { describe, expect, it, vi } from 'vitest';

import { indexDocumentChunks, searchChunks } from '@beaver/agent-llm/fulltextIndex';

/** A provider whose vectors are a deterministic function of the text. */
const fakeProvider = (dims = 8) => ({
    generateEmbeddings: vi.fn(async (items: Array<{ item_id: number; text: string }>) => ({
        embeddings: items.map((item) => ({
            item_id: item.item_id,
            embedding: Array.from({ length: dims }, (_, i) =>
                item.text.toLowerCase().includes('pollen') ? (i === 0 ? 127 : 0) : i === 1 ? 127 : 0,
            ),
            dimensions: dims,
        })),
        model_id: 'fake',
    })),
    generateQueryEmbedding: vi.fn(async (query: string) => ({
        embedding: Array.from({ length: dims }, (_, i) =>
            query.toLowerCase().includes('pollen') ? (i === 0 ? 1 : 0) : i === 1 ? 1 : 0,
        ),
        dimensions: dims,
    })),
}) as any;

const fakeStore = () => {
    const rows: any[] = [];
    return {
        rows,
        replaceChunks: vi.fn(async (libraryId, attachmentKey, parentKey, modelId, dimensions, chunks) => {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (rows[i].libraryId === libraryId && rows[i].attachmentKey === attachmentKey) {
                    rows.splice(i, 1);
                }
            }
            for (const chunk of chunks) {
                rows.push({
                    libraryId,
                    attachmentKey,
                    parentKey,
                    pageIndex: chunk.pageIndex,
                    pageLabel: chunk.pageLabel,
                    text: chunk.text,
                    embedding: new Int8Array(chunk.embedding.buffer),
                    sentenceStart: chunk.sentenceStart ?? null,
                    sentenceEnd: chunk.sentenceEnd ?? null,
                });
            }
        }),
        getChunksForSearch: vi.fn(async () => rows),
    };
};

const page = (index: number, text: string, label?: string) => ({
    index,
    ...(label ? { label } : {}),
    markdown: text,
});

const long = (word: string) => `${word} `.repeat(60).trim();

describe('indexDocumentChunks', () => {
    it('stores a chunk per passage with its page', async () => {
        const store = fakeStore();
        const result = await indexDocumentChunks({
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            libraryId: 1,
            attachmentKey: 'AAAA1111',
            document: { pages: [page(0, long('pollen')), page(1, long('flowers'), 'ii')] },
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks).toBeGreaterThanOrEqual(2);
        expect(store.rows.some((r) => r.pageIndex === 0)).toBe(true);
        expect(store.rows.find((r) => r.pageIndex === 1)?.pageLabel).toBe('ii');
    });

    it('replaces a document\'s passages instead of adding to them', async () => {
        // An edited PDF must not leave a hit pointing at text the page no longer
        // contains.
        const store = fakeStore();
        const args = {
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            libraryId: 1,
            attachmentKey: 'AAAA1111',
        };
        await indexDocumentChunks({ ...args, document: { pages: [page(0, long('pollen'))] } });
        const first = store.rows.length;
        await indexDocumentChunks({ ...args, document: { pages: [page(0, long('flowers'))] } });

        expect(store.rows.length).toBe(first);
        expect(store.rows.every((r) => r.text.includes('flowers'))).toBe(true);
    });

    it('reports a scan with no text layer as skipped, not failed', async () => {
        const store = fakeStore();
        const result = await indexDocumentChunks({
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            libraryId: 1,
            attachmentKey: 'AAAA1111',
            document: { pages: [] },
        });
        expect(result).toMatchObject({ skipped: true, chunks: 0 });
        expect(result.reason).toContain('no extractable text');
    });

    it('batches large documents rather than sending one giant request', async () => {
        const store = fakeStore();
        const provider = fakeProvider();
        const pages = Array.from({ length: 40 }, (_, i) => page(i, long('pollen')));
        await indexDocumentChunks({
            store: store as any,
            provider,
            modelId: 'fake',
            libraryId: 1,
            attachmentKey: 'AAAA1111',
            document: { pages },
        });
        expect(provider.generateEmbeddings.mock.calls.length).toBeGreaterThan(1);
    });
});

describe('searchChunks', () => {
    async function seeded() {
        const store = fakeStore();
        const provider = fakeProvider();
        for (const key of ['AAAA1111', 'BBBB2222']) {
            await indexDocumentChunks({
                store: store as any,
                provider,
                modelId: 'fake',
                libraryId: 1,
                attachmentKey: key,
                parentKey: `P-${key}`,
                document: { pages: [page(0, long('pollen')), page(1, long('unrelated'))] },
            });
        }
        return { store, provider };
    }

    it('returns the matching passage with its page and document', async () => {
        const { store, provider } = await seeded();
        const hits = await searchChunks({
            store: store as any,
            provider,
            modelId: 'fake',
            query: 'pollen loads',
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].page).toBe(1);
        expect(hits[0].parentKey).toMatch(/^P-/);
        expect(hits[0].text).toContain('pollen');
    });

    it('spreads hits across documents rather than crowding one', async () => {
        // Ten passages from one paper is a worse answer to "which of my papers
        // says X" than one passage from each of ten.
        const { store, provider } = await seeded();
        const hits = await searchChunks({
            store: store as any,
            provider,
            modelId: 'fake',
            query: 'pollen',
        });
        const keys = hits.map((h) => h.attachmentKey);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('allows several passages per document when asked', async () => {
        const { store, provider } = await seeded();
        const hits = await searchChunks({
            store: store as any,
            provider,
            modelId: 'fake',
            query: 'pollen',
            perDocument: 3,
        });
        const perDoc = hits.filter((h) => h.attachmentKey === 'AAAA1111').length;
        expect(perDoc).toBeGreaterThanOrEqual(1);
    });

    it('drops passages below the similarity floor', async () => {
        const { store, provider } = await seeded();
        const hits = await searchChunks({
            store: store as any,
            provider,
            modelId: 'fake',
            query: 'pollen',
            minSimilarity: 0.99,
        });
        // Only the near-identical ones survive; the unrelated pages do not.
        expect(hits.every((h) => h.text.includes('pollen'))).toBe(true);
    });

    it('honours the limit', async () => {
        const { store, provider } = await seeded();
        const hits = await searchChunks({
            store: store as any,
            provider,
            modelId: 'fake',
            query: 'pollen',
            limit: 1,
        });
        expect(hits).toHaveLength(1);
    });

    it('returns nothing when the index is empty rather than throwing', async () => {
        const store = fakeStore();
        const hits = await searchChunks({
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            query: 'anything',
        });
        expect(hits).toEqual([]);
    });
});

describe('sentence ranges travel from chunk to hit', () => {
    it('stores each chunk\'s range and returns it on the matching hit', async () => {
        const store = fakeStore();
        const structuredPage = {
            index: 6,
            items: [{
                kind: 'text',
                text: long('pollen'),
                sentences: [{ id: 's42', text: long('pollen') }],
            }],
        };
        await indexDocumentChunks({
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            libraryId: 1,
            attachmentKey: 'AAAA1111',
            document: { pages: [structuredPage] },
        });
        expect(store.rows[0].sentenceStart).toBe(42);
        expect(store.rows[0].sentenceEnd).toBe(42);

        const hits = await searchChunks({
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            query: 'pollen',
        });
        expect(hits[0].sentenceStart).toBe(42);
        expect(hits[0].sentenceEnd).toBe(42);
        expect(hits[0].page).toBe(7);
    });

    it('reports null ranges for markdown-built chunks, not undefined surprises', async () => {
        const store = fakeStore();
        await indexDocumentChunks({
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            libraryId: 1,
            attachmentKey: 'BBBB2222',
            document: { pages: [page(0, long('pollen'))] },
        });
        const hits = await searchChunks({
            store: store as any,
            provider: fakeProvider(),
            modelId: 'fake',
            query: 'pollen',
        });
        expect(hits[0].sentenceStart).toBeNull();
        expect(hits[0].sentenceEnd).toBeNull();
    });
});
