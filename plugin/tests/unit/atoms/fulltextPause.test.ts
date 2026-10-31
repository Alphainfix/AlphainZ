/**
 * A failing embedding provider pauses the full-text pass; it does not fail
 * the library.
 *
 * - A rejected key, a spent quota or a dead server stops the run at the first
 *   document and blames none: every document stays pending, in the count, and
 *   in the next sweep.
 * - A document the provider refuses for its own content still fails alone,
 *   and the run goes on.
 * - A server error or a timeout on one document is put to the provider as a
 *   short request of the run's own. Refused too, the run pauses. Answered, the
 *   next document settles it: one that gets through leaves the first failing
 *   alone; one that fails as well pauses the run with both set aside, and
 *   later runs try those last, so they cannot hold up the rest.
 * - Documents that really failed are counted as skipped, not dropped from the
 *   library, and Retry failed gives them another try.
 * - With no usable embedding model, starting says what is wrong with it.
 */
import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelRequestError } from '../../../src/services/llm/sse';

const jotaiStore = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../../react/store', () => ({
    get store() { return jotaiStore.current; },
}));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom: makeAtom } = await import('jotai');
    return { searchableLibraryIdsAtom: makeAtom([1]) };
});
const config = vi.hoisted(() => ({
    provider: null as any,
    modelId: 'bge-m3-int8-1024' as string | null,
    state: { status: 'ready', provider: 'openai' } as any,
    probes: 0,
}));
vi.mock('../../../src/services/llm/agentConfig', () => ({
    buildEmbeddingProviderFromPrefs: () => config.provider,
    currentEmbeddingModelId: () => config.modelId,
    semanticSearchState: () => config.state,
    resetSemanticSearchProbe: () => { config.probes += 1; },
    refreshSemanticSearchAvailability: async () => config.state.status === 'ready',
}));
/** Documents the extractor refuses, by key, with the refusal it gives. */
const refusals = vi.hoisted(() => new Map<string, { error: string; error_code: string }>());
/** Called while a document is being read, to change the world in the middle of it. */
const whileReading = vi.hoisted(() => ({ hook: null as null | ((key: string) => void) }));
vi.mock('../../../src/services/zoteroDataProvider', () => ({
    createZoteroDataProvider: () => ({
        zotero_document_request: {
            handle: vi.fn(async (request: any) => {
                extractCalls.push(request.attachment.zotero_key);
                whileReading.hook?.(request.attachment.zotero_key);
                const refusal = refusals.get(request.attachment.zotero_key);
                if (refusal) return { ...refusal };
                return { result: { document: { pages: [{ index: 0, label: '1', markdown: LONG }] } } };
            }),
        },
    }),
}));
vi.mock('../../../src/services/llm/zoteroToolDispatch', () => ({ flattenProviderResponse: (x: any) => x }));
vi.mock('../../../src/services/llm/zoteroTextCache', () => ({
    readZoteroTextCache: vi.fn(async () => null),
    cachedTextAsDocument: vi.fn(),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    describeIndexingPause,
    embeddingFailureBlame,
    runFulltextIndex,
    type FulltextCandidate,
} from '../../../src/services/llm/fulltextIndexer';

const LONG = 'Honeybees gauge their flight distance from the image motion of the scenery. '.repeat(8);
const extractCalls: string[] = [];

const http = (status: number, code?: string) =>
    new ModelRequestError(`OpenAI embeddings failed: ${status}`, { kind: 'http', status, label: 'OpenAI', ...(code ? { code } : {}) });

const vectors = (inputs: Array<{ item_id: number }>) => ({
    embeddings: inputs.map((input) => ({ item_id: input.item_id, embedding: new Array(8).fill(1), dimensions: 8 })),
});

describe('telling the provider\'s failures from a document\'s', () => {
    it('counts a rejected key, a spent quota, requests limited and no connection as the provider\'s', () => {
        expect(embeddingFailureBlame(http(401))).toBe('provider');
        expect(embeddingFailureBlame(http(403))).toBe('provider');
        expect(embeddingFailureBlame(http(429))).toBe('provider');
        expect(embeddingFailureBlame(http(400, 'insufficient_quota'))).toBe('provider');
        expect(embeddingFailureBlame(new ModelRequestError('no route', { kind: 'network', label: 'Ollama' }))).toBe('provider');
    });

    it('counts a request refused for its content as the document\'s', () => {
        expect(embeddingFailureBlame(http(400))).toBe('document');
        expect(embeddingFailureBlame(http(413))).toBe('document');
        expect(embeddingFailureBlame(http(422))).toBe('document');
    });

    it('leaves a server error, a timeout and an answer that is not embeddings to be settled', () => {
        expect(embeddingFailureBlame(http(500))).toBe('unclear');
        expect(embeddingFailureBlame(http(503))).toBe('unclear');
        expect(embeddingFailureBlame(http(408))).toBe('unclear');
        expect(embeddingFailureBlame(new ModelRequestError('slow', { kind: 'timeout', label: 'Ollama' }))).toBe('unclear');
        expect(embeddingFailureBlame(new Error('OpenAI embeddings returned non-JSON'))).toBe('unclear');
        expect(embeddingFailureBlame(new Error('OpenAI returned an empty embedding'))).toBe('unclear');
    });

    it('says what went wrong and that nothing is lost', () => {
        expect(describeIndexingPause(http(401))).toBe(
            'Indexing paused: OpenAI embeddings rejected the API key (401). Check the key under '
            + 'Settings → Model → Providers; indexing resumes once it works.',
        );
        expect(describeIndexingPause(new ModelRequestError('x', { kind: 'network', label: 'Ollama' })))
            .toBe('Indexing paused: Ollama embeddings could not be reached. It picks up where it stopped on the next pass.');
    });
});

describe('runFulltextIndex with a failing provider', () => {
    const candidate = (key: string): FulltextCandidate => ({ libraryId: 1, attachmentKey: key, parentKey: null, title: `Paper ${key}` });
    const store = () => ({
        getChunkedAttachmentKeys: vi.fn(async () => new Set<string>()),
        replaceChunks: vi.fn(async () => undefined),
    });

    it('stops at the first document and fails none of them when the key is rejected', async () => {
        const extract = vi.fn(async () => ({ pages: [{ index: 0, label: '1', markdown: LONG }] }));
        const result = await runFulltextIndex({
            store: store() as any,
            provider: { generateEmbeddings: vi.fn(async () => { throw http(401); }) } as any,
            modelId: 'm1',
            candidates: ['A', 'B', 'C'].map(candidate),
            extract,
        });
        expect(result.failed).toBe(0);
        expect(result.errors).toEqual([]);
        expect(result.paused).toMatchObject({ attachmentKey: 'A' });
        expect(result.paused?.message).toMatch(/rejected the API key/);
        // B and C were not extracted only to be refused.
        expect(extract).toHaveBeenCalledTimes(1);
    });

    it('fails only the document a provider refuses for its content, and carries on', async () => {
        const provider = {
            generateEmbeddings: vi.fn(async (inputs: Array<{ item_id: number; text: string }>) => {
                if (inputs.some((i) => i.text.includes('ENORMOUS'))) throw http(400);
                return vectors(inputs);
            }),
        };
        const extract = vi.fn(async (c: FulltextCandidate) => ({
            pages: [{ index: 0, label: '1', markdown: c.attachmentKey === 'B' ? `ENORMOUS ${LONG}` : LONG }],
        }));
        const result = await runFulltextIndex({
            store: store() as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C'].map(candidate), extract,
        });
        expect(result.paused).toBeUndefined();
        expect(result.indexed).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.errors[0].attachmentKey).toBe('B');
    });

    /** Answers every request, except with `failure` for any text containing `marker`. */
    const chokesOn = (marker: string, failure: () => unknown) => ({
        generateEmbeddings: vi.fn(async (inputs: Array<{ item_id: number; text: string }>) => {
            if (inputs.some((i) => i.text.includes(marker))) throw failure();
            return vectors(inputs);
        }),
    });
    const withMarker = (marked: string, marker: string) => vi.fn(async (c: FulltextCandidate) => ({
        pages: [{ index: 0, label: '1', markdown: c.attachmentKey === marked ? `${marker} ${LONG}` : LONG }],
    }));

    it('fails only a document the server errors on every time, on every pass, and indexes the rest', async () => {
        const chunked = new Set<string>();
        const db = {
            getChunkedAttachmentKeys: vi.fn(async () => new Set(chunked)),
            replaceChunks: vi.fn(async (libraryId: number, key: string) => { chunked.add(`${libraryId}-${key}`); }),
        };
        const provider = chokesOn('POISON', () => http(500));
        const extract = withMarker('A', 'POISON');
        const run = () => runFulltextIndex({
            store: db as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C'].map(candidate), extract,
        });

        const first = await run();
        expect(first.paused).toBeUndefined();
        expect(first).toMatchObject({ indexed: 2, failed: 1 });
        expect(first.errors.map((e) => e.attachmentKey)).toEqual(['A']);

        // A pass that finds only A pending charges A again, without pausing.
        const second = await run();
        expect(second.paused).toBeUndefined();
        expect(second).toMatchObject({ indexed: 0, failed: 1 });
        expect([...chunked].sort()).toEqual(['1-B', '1-C']);
    });

    it('fails only a document that times out when the provider answers its own short request', async () => {
        const provider = chokesOn('SLOW', () => new ModelRequestError('Ollama embeddings did not answer within 3 minutes', { kind: 'timeout', label: 'Ollama' }));
        const result = await runFulltextIndex({
            store: store() as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C'].map(candidate),
            extract: withMarker('B', 'SLOW'),
        });
        expect(result.paused).toBeUndefined();
        expect(result).toMatchObject({ indexed: 2, failed: 1 });
        expect(result.errors[0]).toMatchObject({ attachmentKey: 'B' });
    });

    it('pauses at the first document, blaming none, when the server errors on every request', async () => {
        const extract = vi.fn(async () => ({ pages: [{ index: 0, label: '1', markdown: LONG }] }));
        const provider = { generateEmbeddings: vi.fn(async () => { throw http(503); }) };
        const result = await runFulltextIndex({
            store: store() as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C'].map(candidate), extract,
        });
        expect(result.failed).toBe(0);
        expect(result.paused).toMatchObject({ attachmentKey: 'A' });
        expect(result.paused?.message).toBe(
            'Indexing paused: OpenAI embeddings had a server error (503). It picks up where it stopped on the next pass.',
        );
        // The first document's request, then the provider's own check; nothing else was extracted.
        expect(provider.generateEmbeddings).toHaveBeenCalledTimes(2);
        expect(extract).toHaveBeenCalledTimes(1);
    });

    it('pauses instead of failing every document when the answers are not embeddings at all', async () => {
        // A proxy or sign-in page answering 200 with HTML.
        const provider = { generateEmbeddings: vi.fn(async () => { throw new Error('OpenAI embeddings returned non-JSON'); }) };
        const result = await runFulltextIndex({
            store: store() as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C'].map(candidate),
            extract: vi.fn(async () => ({ pages: [{ index: 0, label: '1', markdown: LONG }] })),
        });
        expect(result.failed).toBe(0);
        expect(result.paused?.message).toBe(
            'Indexing paused: OpenAI embeddings returned non-JSON. It picks up where it stopped on the next pass.',
        );
    });

    it('pauses, blaming none, when real documents fail one after another though a short request gets through', async () => {
        // A gateway that times out on every full-sized batch but answers a few words.
        const provider = chokesOn('Honeybees', () => http(504));
        const extract = vi.fn(async () => ({ pages: [{ index: 0, label: '1', markdown: LONG }] }));
        const result = await runFulltextIndex({
            store: store() as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C'].map(candidate), extract,
        });
        expect(result.failed).toBe(0);
        expect(result.paused).toMatchObject({ attachmentKey: 'A', setAside: ['1-A', '1-B'] });
        expect(result.paused?.message).toMatch(/server error \(504\)/);
        expect(extract).toHaveBeenCalledTimes(2);
    });

    it('tries documents an earlier pause set aside last, and charges them once others get through', async () => {
        const chunked = new Set<string>();
        const db = {
            getChunkedAttachmentKeys: vi.fn(async () => new Set(chunked)),
            replaceChunks: vi.fn(async (libraryId: number, key: string) => { chunked.add(`${libraryId}-${key}`); }),
        };
        // A and B make the server fail every time; C and D are fine.
        const provider = chokesOn('POISON', () => http(500));
        const extract = vi.fn(async (c: FulltextCandidate) => ({
            pages: [{ index: 0, label: '1', markdown: ['A', 'B'].includes(c.attachmentKey) ? `POISON ${LONG}` : LONG }],
        }));
        const run = (setAsideBefore?: Set<string>) => runFulltextIndex({
            store: db as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C', 'D'].map(candidate), extract,
            ...(setAsideBefore ? { setAsideBefore } : {}),
        });

        const first = await run();
        expect(first).toMatchObject({ indexed: 0, failed: 0 });
        expect(first.paused?.setAside).toEqual(['1-A', '1-B']);

        const second = await run(new Set(first.paused!.setAside));
        expect(second.paused).toBeUndefined();
        expect(second).toMatchObject({ indexed: 2, failed: 2 });
        expect(second.errors.map((e) => e.attachmentKey)).toEqual(['A', 'B']);
        expect([...chunked].sort()).toEqual(['1-C', '1-D']);
    });

    it('does not charge documents set aside while no real document gets through', async () => {
        const provider = chokesOn('Honeybees', () => new ModelRequestError('slow', { kind: 'timeout', label: 'Ollama' }));
        const result = await runFulltextIndex({
            store: store() as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B', 'C'].map(candidate),
            extract: vi.fn(async () => ({ pages: [{ index: 0, label: '1', markdown: LONG }] })),
            setAsideBefore: new Set(['1-A', '1-B']),
        });
        expect(result.failed).toBe(0);
        expect(result.paused).toMatchObject({ attachmentKey: 'C', setAside: ['1-C', '1-A'] });
    });

    it('reports the provider\'s own failure when its check fails differently', async () => {
        // The document's request timed out; the check then found no server at all.
        let calls = 0;
        const provider = {
            generateEmbeddings: vi.fn(async () => {
                calls += 1;
                throw calls === 1
                    ? new ModelRequestError('slow', { kind: 'timeout', label: 'Ollama' })
                    : new ModelRequestError('refused', { kind: 'network', label: 'Ollama' });
            }),
        };
        const result = await runFulltextIndex({
            store: store() as any, provider: provider as any, modelId: 'm1', candidates: ['A', 'B'].map(candidate),
            extract: vi.fn(async () => ({ pages: [{ index: 0, label: '1', markdown: LONG }] })),
        });
        expect(result.paused?.message).toBe('Indexing paused: Ollama embeddings could not be reached. It picks up where it stopped on the next pass.');
    });
});

describe('the full-text atoms', () => {
    let indexed: Set<string>;
    let db: any;

    const pdf = (key: string) => ({
        libraryID: 1, key, parentKey: null, deleted: false,
        isPDFAttachment: () => true, getDisplayTitle: () => `Paper ${key}`,
    });

    beforeEach(() => {
        vi.resetModules();
        jotaiStore.current = createStore();
        extractCalls.length = 0;
        refusals.clear();
        whileReading.hook = null;
        indexed = new Set();
        db = {
            getChunkedAttachmentKeys: vi.fn(async () => new Set(indexed)),
            replaceChunks: vi.fn(async (libraryId: number, key: string) => { indexed.add(`${libraryId}-${key}`); }),
        };
        config.modelId = 'bge-m3-int8-1024';
        config.state = { status: 'ready', provider: 'openai' };
        config.probes = 0;
        config.provider = { generateEmbeddings: vi.fn(async (inputs: any[]) => vectors(inputs)) };
        (Zotero as any).AlphainZ = { db };
        (Zotero as any).Items = {
            getAll: vi.fn(async () => ['A', 'B', 'C'].map(pdf)),
            loadDataTypes: vi.fn(async () => undefined),
            getByLibraryAndKey: vi.fn(() => false),
            getByLibraryAndKeyAsync: vi.fn(async () => null),
        };
    });
    afterEach(() => {
        delete (Zotero as any).AlphainZ;
        delete (Zotero as any).Items;
    });

    const load = () => import('../../../react/atoms/fulltextIndex');

    it('passes over a library excluded while the run goes on, sending none of its text', async () => {
        const { startFulltextIndexAtom } = await load();
        const { searchableLibraryIdsAtom } = await import('../../../react/atoms/profile');
        const sent: string[] = [];
        config.provider = {
            generateEmbeddings: vi.fn(async (inputs: any[]) => {
                sent.push(extractCalls.at(-1) ?? '?');
                // The user excludes the library once A is under way.
                jotaiStore.current.set(searchableLibraryIdsAtom, []);
                return vectors(inputs);
            }),
        };
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(extractCalls).toEqual(['A']);
        expect(new Set(sent)).toEqual(new Set(['A']));
        expect([...indexed]).toEqual(['1-A']);
    });

    it('never answers an access refusal from Zotero\'s text cache', async () => {
        const { startFulltextIndexAtom } = await load();
        const cache = await import('../../../src/services/llm/zoteroTextCache');
        (cache.readZoteroTextCache as any).mockResolvedValue({ text: 'CACHED TEXT OF B '.repeat(40) });
        (cache.cachedTextAsDocument as any).mockReturnValue({ pages: [{ index: 0, label: null, markdown: 'CACHED TEXT OF B '.repeat(40) }] });
        (Zotero as any).Items.getByLibraryAndKey = vi.fn((_lib: number, key: string) => (key === 'B' ? { key } : false));
        refusals.set('B', { error: 'This library is excluded', error_code: 'library_excluded' });
        const texts: string[] = [];
        config.provider = {
            generateEmbeddings: vi.fn(async (inputs: any[]) => {
                texts.push(...inputs.map((i: any) => i.text));
                return vectors(inputs);
            }),
        };
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(texts.some((t) => t.includes('CACHED TEXT OF B'))).toBe(false);
        expect([...indexed].sort()).toEqual(['1-A', '1-C']);
    });

    it('still reads Zotero\'s text cache for a PDF that is only missing its file', async () => {
        const { startFulltextIndexAtom } = await load();
        const cache = await import('../../../src/services/llm/zoteroTextCache');
        (cache.readZoteroTextCache as any).mockResolvedValue({ text: 'CACHED TEXT OF B '.repeat(40) });
        (cache.cachedTextAsDocument as any).mockReturnValue({ pages: [{ index: 0, label: null, markdown: 'CACHED TEXT OF B '.repeat(40) }] });
        (Zotero as any).Items.getByLibraryAndKey = vi.fn((_lib: number, key: string) => (key === 'B' ? { key } : false));
        refusals.set('B', { error: 'The PDF file is not on this computer', error_code: 'file_missing' });
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect([...indexed].sort()).toEqual(['1-A', '1-B', '1-C']);
    });

    it('sends nothing of a document whose library is excluded while it is being read', async () => {
        const { startFulltextIndexAtom } = await load();
        const { searchableLibraryIdsAtom } = await import('../../../react/atoms/profile');
        whileReading.hook = (key) => {
            if (key === 'B') jotaiStore.current.set(searchableLibraryIdsAtom, []);
        };
        const texts: string[] = [];
        config.provider = {
            generateEmbeddings: vi.fn(async (inputs: any[]) => {
                texts.push(`${extractCalls.at(-1)}`);
                return vectors(inputs);
            }),
        };
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(new Set(texts)).toEqual(new Set(['A']));
        expect([...indexed]).toEqual(['1-A']);
    });

    it('leaves out a PDF whose paper is in the trash, read from the trash records when the paper is not loaded', async () => {
        (Zotero as any).Items.getAll = vi.fn(async () => ['A', 'B', 'C'].map((key) => ({
            ...pdf(key),
            id: key.charCodeAt(0),
            parentItemID: key === 'B' ? 900 : null,
            // The trashed parent is not loaded: Zotero's own check would throw.
            isInTrash: () => { throw new Error('Item 900 not loaded'); },
        })));
        const db = (Zotero as any).DB;
        (Zotero as any).DB = {
            queryAsync: vi.fn(async (sql: string, _params: unknown, options?: any) => {
                if (/deletedItems/.test(sql)) options?.onRow?.({ getResultByIndex: () => 900 });
                return [];
            }),
        };
        try {
            const { listAllCandidates } = await load();
            expect((await listAllCandidates()).map((c) => c.attachmentKey)).toEqual(['A', 'C']);
        } finally {
            (Zotero as any).DB = db;
        }
    });

    it('leaves out a PDF whose paper is in the trash', async () => {
        (Zotero as any).Items.getAll = vi.fn(async () => ['A', 'B', 'C'].map((key) => ({
            ...pdf(key),
            isInTrash: () => key === 'B',
        })));
        const { listAllCandidates, startFulltextIndexAtom } = await load();
        expect((await listAllCandidates()).map((c) => c.attachmentKey)).toEqual(['A', 'C']);
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(extractCalls).not.toContain('B');
    });

    it('keeps every document pending after a paused run, and says why it paused', async () => {
        config.provider = { generateEmbeddings: vi.fn(async () => { throw http(401); }) };
        const { fulltextIndexStateAtom, startFulltextIndexAtom } = await load();
        await jotaiStore.current.set(startFulltextIndexAtom);

        const state = jotaiStore.current.get(fulltextIndexStateAtom);
        expect(state.paused).toMatch(/rejected the API key/);
        // The provider is asked again, so a stopped Ollama reads as unreachable.
        expect(config.probes).toBe(1);
        expect(state.failed).toBe(0);
        expect(state).toMatchObject({ library: 3, indexed: 0, skipped: 0, counted: true });

        // The key is fixed: the next run takes all three, not "Everything is indexed".
        config.provider = { generateEmbeddings: vi.fn(async (inputs: any[]) => vectors(inputs)) };
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(jotaiStore.current.get(fulltextIndexStateAtom)).toMatchObject({ indexed: 3, library: 3, paused: undefined });
    });

    it('skips a document the server errors on every time, and indexes the rest in the same pass', async () => {
        config.provider = {
            generateEmbeddings: vi.fn(async (inputs: any[]) => {
                // The server chokes on A's text and answers everything else, its own check included.
                if (extractCalls.at(-1) === 'A' && inputs.some((i) => i.text.includes('Honeybees'))) throw http(500);
                return vectors(inputs);
            }),
        };
        const { fulltextIndexStateAtom, startFulltextIndexAtom } = await load();
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(jotaiStore.current.get(fulltextIndexStateAtom)).toMatchObject({
            paused: undefined, failed: 1, indexed: 2, library: 2, skipped: 1,
        });
        expect(jotaiStore.current.get(fulltextIndexStateAtom).failures[0]).toMatchObject({ title: 'Paper A' });
    });

    it('gets past two documents the server errors on every time on the next pass', async () => {
        config.provider = {
            generateEmbeddings: vi.fn(async (inputs: any[]) => {
                const last = extractCalls.at(-1);
                if ((last === 'A' || last === 'B') && inputs.some((i) => i.text.includes('Honeybees'))) throw http(500);
                return vectors(inputs);
            }),
        };
        const { fulltextIndexStateAtom, startFulltextIndexAtom } = await load();
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(jotaiStore.current.get(fulltextIndexStateAtom)).toMatchObject({ indexed: 0, failed: 0, skipped: 0, library: 3 });
        expect(jotaiStore.current.get(fulltextIndexStateAtom).paused).toMatch(/server error \(500\)/);

        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(jotaiStore.current.get(fulltextIndexStateAtom)).toMatchObject({
            paused: undefined, indexed: 1, failed: 2, skipped: 2, library: 1,
        });
    });

    it('counts a document that could not be read as skipped, and retries it when asked', async () => {
        // B's embeddings are refused for its content: a real document failure.
        config.provider = {
            generateEmbeddings: vi.fn(async (inputs: any[]) => {
                if (extractCalls.at(-1) === 'B') throw http(400);
                return vectors(inputs);
            }),
        };
        const { fulltextIndexStateAtom, startFulltextIndexAtom } = await load();
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(jotaiStore.current.get(fulltextIndexStateAtom)).toMatchObject({
            failed: 1, indexed: 2, library: 2, skipped: 1,
        });

        // A plain run leaves it out; Retry failed brings it back.
        config.provider = { generateEmbeddings: vi.fn(async (inputs: any[]) => vectors(inputs)) };
        await jotaiStore.current.set(startFulltextIndexAtom);
        expect(jotaiStore.current.get(fulltextIndexStateAtom)).toMatchObject({ indexed: 2, skipped: 1 });
        await jotaiStore.current.set(startFulltextIndexAtom, { retryFailed: true });
        expect(jotaiStore.current.get(fulltextIndexStateAtom)).toMatchObject({ indexed: 3, library: 3, skipped: 0, failed: 0 });
    });

    it('marks the counts unknown, not empty, when there is no usable embedding model', async () => {
        config.modelId = null;
        config.provider = null;
        config.state = { status: 'needs_key', provider: 'openai', label: 'OpenAI' };
        const { fulltextIndexStateAtom, refreshFulltextCoverageAtom, startFulltextIndexAtom } = await load();
        await jotaiStore.current.set(refreshFulltextCoverageAtom);
        expect(jotaiStore.current.get(fulltextIndexStateAtom).counted).toBe(false);

        await jotaiStore.current.set(startFulltextIndexAtom);
        const state = jotaiStore.current.get(fulltextIndexStateAtom);
        expect(state.error).toBe(
            'Embeddings are set to OpenAI, but this computer has no OpenAI API key. '
            + 'The full text of your PDFs is indexed once that is fixed.',
        );
        expect(state.error).not.toMatch(/configured/);
    });
});

