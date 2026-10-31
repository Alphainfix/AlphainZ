/**
 * The library-wide full-text pass.
 *
 * It costs money per document and can run for a long time, so the properties
 * that matter are: it skips what is already done, it stops when asked, one bad
 * document does not end the run, and progress is honest about all of it.
 */
import { describe, expect, it, vi } from 'vitest';

import {
    coverageNote,
    pendingCandidates,
    runFulltextIndex,
    type FulltextCandidate,
} from '../../../src/services/llm/fulltextIndexer';

const candidate = (key: string): FulltextCandidate => ({
    libraryId: 1,
    attachmentKey: key,
    parentKey: `P${key}`,
    title: `Paper ${key}`,
});

/** A store that records what was written, with a fixed already-indexed set. */
function makeStore(already: string[] = []) {
    const written: string[] = [];
    return {
        written,
        getChunkedAttachmentKeys: vi.fn(async () => new Set(already)),
        replaceChunks: vi.fn(async (libraryId: number, attachmentKey: string) => {
            written.push(`${libraryId}-${attachmentKey}`);
        }),
    } as any;
}

// Matches the real provider contract: entries carry `item_id`, and the caller
// indexes chunks by it. A double with `index` instead silently produced zero
// rows — the loop skipped every entry and reported the document as having no
// extractable text.
const provider = {
    generateEmbeddings: vi.fn(async (inputs: Array<{ item_id: number }>) => ({
        embeddings: inputs.map((input) => ({
            item_id: input.item_id,
            embedding: new Array(512).fill(1),
            dimensions: 512,
        })),
    })),
    generateQueryEmbedding: vi.fn(),
} as any;

const page = (markdown: string) => ({ pages: [{ index: 0, label: '1', markdown }] });
const LONG = 'Honeybees gauge their flight distance from the image motion of the scenery. '.repeat(8);

describe('pendingCandidates', () => {
    it('drops what is already indexed for this model', async () => {
        const store = makeStore(['1-A', '1-C']);
        const pending = await pendingCandidates(store, 'm1', ['A', 'B', 'C', 'D'].map(candidate));
        expect(pending.map((c) => c.attachmentKey)).toEqual(['B', 'D']);
    });

    it('asks about the model in use, not any model', async () => {
        // Vectors from different models cannot be compared, so a document
        // indexed under an old model still needs doing.
        const store = makeStore([]);
        await pendingCandidates(store, 'voyage-3', [candidate('A')]);
        expect(store.getChunkedAttachmentKeys).toHaveBeenCalledWith('voyage-3');
    });
});

describe('pendingCandidates — upgrading page-level passages to sentence level', () => {
    it('re-queues a document whose chunks lack sentence ranges when the cache can now provide them', async () => {
        const store = {
            ...makeStore(['1-A', '1-B']),
            getAttachmentKeysLackingRanges: vi.fn(async () => new Set(['1-A'])),
        };
        const pending = await pendingCandidates(store as any, 'm1', ['A', 'B', 'C'].map(candidate), {
            canUpgrade: async (c) => c.attachmentKey === 'A',
        });
        expect(pending.map((c) => c.attachmentKey)).toEqual(['A', 'C']);
    });

    it('leaves such a document alone when the cache still has no structure, or when nobody asks', async () => {
        const store = {
            ...makeStore(['1-A']),
            getAttachmentKeysLackingRanges: vi.fn(async () => new Set(['1-A'])),
        };
        expect(await pendingCandidates(store as any, 'm1', [candidate('A')], { canUpgrade: async () => false })).toEqual([]);
        expect(await pendingCandidates(store as any, 'm1', [candidate('A')])).toEqual([]);
        // Without the check there is no query for range-less documents either.
        expect(store.getAttachmentKeysLackingRanges).toHaveBeenCalledTimes(1);
    });
});

describe('runFulltextIndex', () => {
    const base = (over: Record<string, unknown> = {}) => ({
        store: makeStore(),
        provider,
        modelId: 'm1',
        candidates: ['A', 'B', 'C'].map(candidate),
        extract: vi.fn(async () => page(LONG)),
        ...over,
    });

    it('indexes everything that needs it', async () => {
        const options = base();
        const result = await runFulltextIndex(options as any);
        expect(result.indexed).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.chunks).toBeGreaterThan(0);
        expect(result.canceled).toBe(false);
    });

    it('resumes rather than restarting', async () => {
        // A run stopped halfway should be progress, not waste.
        const options = base({ store: makeStore(['1-A', '1-B']) });
        const result = await runFulltextIndex(options as any);
        expect(result.indexed).toBe(1);
        expect((options.extract as any).mock.calls[0][0].attachmentKey).toBe('C');
    });

    it('re-indexes everything when forced', async () => {
        const options = base({ store: makeStore(['1-A', '1-B', '1-C']), force: true });
        expect((await runFulltextIndex(options as any)).indexed).toBe(3);
    });

    it('stops when asked, and says so', async () => {
        const controller = new AbortController();
        const extract = vi.fn(async (c: FulltextCandidate) => {
            if (c.attachmentKey === 'B') controller.abort();
            return page(LONG);
        });
        const result = await runFulltextIndex(base({ extract, signal: controller.signal }) as any);
        expect(result.canceled).toBe(true);
        // A and B finished; C was never started.
        expect(result.indexed).toBe(2);
    });

    it('keeps going after one document fails', async () => {
        // A single unreadable PDF must not end a library-wide pass.
        const extract = vi.fn(async (c: FulltextCandidate) => {
            if (c.attachmentKey === 'B') throw new Error('extraction timed out');
            return page(LONG);
        });
        const result = await runFulltextIndex(base({ extract }) as any);
        expect(result.indexed).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.errors[0]).toMatchObject({ attachmentKey: 'B' });
        expect(result.errors[0].message).toContain('timed out');
    });

    it('does not count a document with no text as a failure', async () => {
        // Scans without OCR are common; counting them red would make a healthy
        // library look broken.
        const extract = vi.fn(async (c: FulltextCandidate) =>
            c.attachmentKey === 'B' ? null : page(LONG),
        );
        const result = await runFulltextIndex(base({ extract }) as any);
        expect(result.failed).toBe(0);
        expect(result.indexed).toBe(3);
    });

    it('reports progress that ends at the total', async () => {
        const seen: Array<{ done: number; total: number }> = [];
        await runFulltextIndex(
            base({ onProgress: (p: any) => seen.push({ done: p.done, total: p.total }) }) as any,
        );
        expect(seen[0]).toEqual({ done: 0, total: 3 });
        expect(seen[seen.length - 1]).toEqual({ done: 3, total: 3 });
        // Never claims more done than there is to do.
        expect(seen.every((p) => p.done <= p.total)).toBe(true);
    });

    it('names the document it is working on', async () => {
        const names: string[] = [];
        await runFulltextIndex(
            base({
                onProgress: (p: any) => { if (p.current) names.push(p.current); },
            }) as any,
        );
        expect(names).toContain('Paper A');
    });

    it('honours a limit', async () => {
        const result = await runFulltextIndex(base({ limit: 2 }) as any);
        expect(result.indexed).toBe(2);
    });

    it('does nothing, gracefully, when everything is indexed', async () => {
        const options = base({ store: makeStore(['1-A', '1-B', '1-C']) });
        const result = await runFulltextIndex(options as any);
        expect(result).toMatchObject({ indexed: 0, failed: 0, canceled: false });
        expect(options.extract).not.toHaveBeenCalled();
    });
});

describe('coverageNote', () => {
    it('says nothing when the whole library is indexed', () => {
        // Silence is the signal that the result can be trusted as complete.
        expect(coverageNote(191, 191)).toBeNull();
        expect(coverageNote(200, 191)).toBeNull();
    });

    it('says nothing when there is nothing to index', () => {
        expect(coverageNote(0, 0)).toBeNull();
    });

    it('states both numbers when coverage is partial', () => {
        const note = coverageNote(44, 191);
        expect(note).toContain('44');
        expect(note).toContain('191');
    });

    it('tells the model a miss is not evidence of absence', () => {
        // The whole point: a thin result must not read as "your library has
        // nothing on this".
        expect(coverageNote(44, 191)).toMatch(/may still discuss/);
    });

    it('asks the model to pass it on when it matters', () => {
        expect(coverageNote(1, 100)).toMatch(/Say so/);
    });
});
