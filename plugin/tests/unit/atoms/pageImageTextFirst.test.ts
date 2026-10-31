/**
 * The page-image run lets the text index go first.
 *
 * - Before each document it waits while titles, abstracts or passages are
 *   being indexed, so a paper added during a long picture run is searchable by
 *   its words first; it goes on as soon as the text index is done.
 * - Stopping it while it waits ends the run without starting another document.
 * - A pass that found work is followed by another, which picks up PDFs added
 *   while it ran.
 * - A figure search is told how much of the library has page images while
 *   some PDFs still have none, not counting PDFs that could not be read.
 * - A PDF that could not be rendered is set aside for the session with the
 *   reason, named by its paper: one whose file is not on this computer says
 *   whether Zotero can download it. Index leaves it alone; a retry tries again.
 */
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jotaiStore = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../../react/store', () => ({
    get store() { return jotaiStore.current; },
}));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom: makeAtom } = await import('jotai');
    return { searchableLibraryIdsAtom: makeAtom([1]) };
});
const config = vi.hoisted(() => ({ provider: null as any, modelId: 'gemini-embedding-2', auto: true, fulltextAuto: true }));
vi.mock('../../../src/services/llm/agentConfig', () => ({
    buildEmbeddingProviderFromPrefs: () => config.provider,
    currentEmbeddingModelId: () => config.modelId,
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => (key === 'pageImageIndexAuto' ? config.auto : key === 'fulltextIndexAuto' ? config.fulltextAuto : undefined),
}));
const library = vi.hoisted(() => ({ keys: [] as string[][], calls: 0, parents: {} as Record<string, string> }));
vi.mock('../../../react/atoms/fulltextIndex', async () => {
    const { atom: makeAtom } = await import('jotai');
    return {
        fulltextIndexStateAtom: makeAtom({ status: 'idle' }),
        listAllCandidates: vi.fn(async () => {
            const keys = library.keys[Math.min(library.calls, library.keys.length - 1)];
            library.calls += 1;
            return keys.map((key) => ({ libraryId: 1, attachmentKey: key, parentKey: library.parents[key] ?? null, title: key }));
        }),
    };
});
const extractor = vi.hoisted(() => ({ rendered: [] as string[], onRender: null as null | ((key: string) => void), unreadable: new Set<string>() }));
vi.mock('../../../src/beaver-extract', () => ({
    BeaverExtractor: class {
        async getPageCount(bytes: Uint8Array) {
            const key = new TextDecoder().decode(bytes);
            if (extractor.unreadable.has(key)) throw new Error('no readable pages');
            return 1;
        }
        async renderPages(bytes: Uint8Array) {
            const key = new TextDecoder().decode(bytes);
            extractor.rendered.push(key);
            extractor.onRender?.(key);
            return { pages: [{ pageIndex: 0, data: new Uint8Array([1, 2, 3]) }] };
        }
    },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { EmbeddingProvider, type FetchLike } from '../../../src/services/llm/embeddings';
import { fulltextIndexStateAtom } from '../../../react/atoms/fulltextIndex';
import { embeddingIndexStateAtom } from '../../../react/atoms/embeddingIndex';
import { fulltextSweepDueAtom } from '../../../react/atoms/indexSchedule';
import {
    WAITING_FOR_TEXT,
    figureCoverageNoteFor,
    missingFileReason,
    pageImageIndexStateAtom,
    resetPageImageFailures,
    startPageImageIndexAtom,
    stopPageImageIndexAtom,
} from '../../../react/atoms/pageImageIndex';

const imageFetch: FetchLike = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ embeddings: body.requests.map(() => ({ values: [1, 0, 0, 0] })) }),
    };
}) as FetchLike;

function memoryDb() {
    /** Pages stored, by model and then by `<library>-<attachment>`. */
    const byModel = new Map<string, Map<string, number>>();
    const forModel = (modelId: string) => {
        if (!byModel.has(modelId)) byModel.set(modelId, new Map());
        return byModel.get(modelId)!;
    };
    return {
        byModel,
        get done() { return forModel('gemini-embedding-2'); },
        async getPageImagedAttachmentKeys(modelId: string) {
            return new Set(forModel(modelId).keys());
        },
        async replacePageImages(libraryId: number, attachmentKey: string, _p: unknown, modelId: string, _d: number, pages: unknown[]) {
            forModel(modelId).set(`${libraryId}-${attachmentKey}`, pages.length);
        },
        async listEmbeddingModels() {
            return [...byModel].map(([model_id, docs]) => ({ model_id, images: [...docs.values()].reduce((a, b) => a + b, 0) }));
        },
    };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

let db: ReturnType<typeof memoryDb>;

beforeEach(() => {
    jotaiStore.current = createStore();
    config.modelId = 'gemini-embedding-2';
    config.auto = true;
    config.fulltextAuto = true;
    resetPageImageFailures();
    config.provider = new EmbeddingProvider({
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'k',
        model: 'gemini-embedding-2',
        dimensions: 4,
        wire: 'gemini',
        imageWire: 'gemini',
        imageBatchSize: 6,
    }, imageFetch);
    library.keys = [['AAA', 'BBB']];
    library.calls = 0;
    library.parents = {};
    extractor.rendered = [];
    extractor.onRender = null;
    extractor.unreadable = new Set();
    db = memoryDb();
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        AlphainZ: { db },
        Items: {
            ...(globalThis as any).Zotero?.Items,
            getByLibraryAndKeyAsync: async (_lib: number, key: string) => ({ getFilePathAsync: async () => `/pdfs/${key}.pdf` }),
            loadDataTypes: async () => undefined,
        },
    };
    (globalThis as any).IOUtils.read = vi.fn(async (path: string) => new TextEncoder().encode(path.replace(/^\/pdfs\/|\.pdf$/g, '')));
});

describe('the picture run and the text index', () => {
    it('waits at the next document while passages are indexed, then goes on', async () => {
        const store = jotaiStore.current;
        // A passage run starts while the first PDF is being rendered.
        extractor.onRender = (key) => {
            if (key === 'AAA') store.set(fulltextIndexStateAtom, { status: 'indexing' });
        };
        const run = store.set(startPageImageIndexAtom);
        await tick(30);
        expect(extractor.rendered).toEqual(['AAA']);
        expect(store.get(pageImageIndexStateAtom)).toMatchObject({ status: 'indexing', current: WAITING_FOR_TEXT });

        store.set(fulltextIndexStateAtom, { status: 'idle' });
        await run;
        expect(extractor.rendered).toEqual(['AAA', 'BBB']);
        expect(store.get(pageImageIndexStateAtom)).toMatchObject({ status: 'idle', indexed: 2, library: 2 });
    });

    it('waits for titles and abstracts too', async () => {
        const store = jotaiStore.current;
        store.set(embeddingIndexStateAtom, (prev: any) => ({ ...prev, status: 'indexing' }));
        const run = store.set(startPageImageIndexAtom);
        await tick(30);
        expect(extractor.rendered).toEqual([]);
        store.set(embeddingIndexStateAtom, (prev: any) => ({ ...prev, status: 'idle' }));
        await run;
        expect(extractor.rendered).toEqual(['AAA', 'BBB']);
    });

    it('waits while a full-text sweep is due, before its passage run has started', async () => {
        const store = jotaiStore.current;
        store.set(fulltextSweepDueAtom, true);
        const run = store.set(startPageImageIndexAtom);
        await tick(30);
        expect(extractor.rendered).toEqual([]);
        expect(store.get(pageImageIndexStateAtom).current).toBe(WAITING_FOR_TEXT);
        store.set(fulltextSweepDueAtom, false);
        await run;
        expect(extractor.rendered).toEqual(['AAA', 'BBB']);
    });

    it('stops while waiting when asked, without starting another document', async () => {
        const store = jotaiStore.current;
        store.set(fulltextIndexStateAtom, { status: 'counting' });
        const run = store.set(startPageImageIndexAtom);
        await tick(30);
        store.set(stopPageImageIndexAtom);
        await run;
        expect(extractor.rendered).toEqual([]);
        expect(store.get(pageImageIndexStateAtom).status).toBe('idle');
        expect(db.done.size).toBe(0);
    });

    it('picks up a PDF added while it ran', async () => {
        const store = jotaiStore.current;
        library.keys = [['AAA'], ['AAA', 'BBB']];
        await store.set(startPageImageIndexAtom);
        expect(extractor.rendered).toEqual(['AAA', 'BBB']);
        expect([...db.done.keys()]).toEqual(['1-AAA', '1-BBB']);
        // The pass after the second one found nothing to do and ended the start.
        expect(library.calls).toBe(4);
    });
});

describe('a switch of embedding model during a picture run', () => {
    it('stops at the next document and starts a run for the model now in use', async () => {
        const store = jotaiStore.current;
        extractor.onRender = (key) => {
            if (key === 'AAA' && config.modelId === 'gemini-embedding-2') config.modelId = 'embeddinggemma-2:440m-q8_0-text-vision';
        };
        await store.set(startPageImageIndexAtom);
        // The run for the new model was started as the old one ended.
        for (let i = 0; i < 50 && store.get(pageImageIndexStateAtom).status === 'indexing'; i += 1) await tick(10);
        await tick(10);
        expect([...db.byModel.get('gemini-embedding-2')!.keys()]).toEqual(['1-AAA']);
        expect([...db.byModel.get('embeddinggemma-2:440m-q8_0-text-vision')!.keys()]).toEqual(['1-AAA', '1-BBB']);
        expect(store.get(pageImageIndexStateAtom).status).toBe('idle');
    });

    it('holds a Stop against runs that start by themselves, until the user starts one', async () => {
        const store = jotaiStore.current;
        store.set(fulltextIndexStateAtom, { status: 'indexing' });
        const run = store.set(startPageImageIndexAtom);
        await tick(30);
        store.set(stopPageImageIndexAtom);
        await run;
        store.set(fulltextIndexStateAtom, { status: 'idle' });
        expect(store.get(pageImageIndexStateAtom)).toMatchObject({ status: 'idle', stopped: true });

        await store.set(startPageImageIndexAtom, { automatic: true });
        expect(extractor.rendered).toEqual([]);

        await store.set(startPageImageIndexAtom);
        expect(extractor.rendered).toEqual(['AAA', 'BBB']);
        expect(store.get(pageImageIndexStateAtom).stopped).toBeUndefined();
    });

    it('respects a Stop given while waiting, even when the model changed meanwhile', async () => {
        const store = jotaiStore.current;
        store.set(fulltextIndexStateAtom, { status: 'indexing' });
        const run = store.set(startPageImageIndexAtom);
        await tick(30);
        config.modelId = 'embeddinggemma-2:440m-q8_0-text-vision';
        store.set(stopPageImageIndexAtom);
        await run;
        store.set(fulltextIndexStateAtom, { status: 'idle' });
        await tick(50);
        expect(extractor.rendered).toEqual([]);
        expect(store.get(pageImageIndexStateAtom).status).toBe('idle');
    });

    it('starts nothing when Stop comes after the switch was noticed, before the new run began', async () => {
        const store = jotaiStore.current;
        extractor.onRender = (key) => {
            if (key === 'AAA' && config.modelId === 'gemini-embedding-2') config.modelId = 'embeddinggemma-2:440m-q8_0-text-vision';
        };
        // Stop lands while the ended run recounts its coverage.
        const original = db.listEmbeddingModels.bind(db);
        db.listEmbeddingModels = async () => {
            store.set(stopPageImageIndexAtom);
            return original();
        };
        await store.set(startPageImageIndexAtom);
        await tick(50);
        expect(db.byModel.get('embeddinggemma-2:440m-q8_0-text-vision')?.size ?? 0).toBe(0);
        expect(store.get(pageImageIndexStateAtom).status).toBe('idle');
    });

    it('notices a switch made during the last document, and starts a run for the new model', async () => {
        const store = jotaiStore.current;
        library.keys = [['AAA']];
        extractor.onRender = (key) => {
            if (key === 'AAA' && config.modelId === 'gemini-embedding-2') config.modelId = 'embeddinggemma-2:440m-q8_0-text-vision';
        };
        await store.set(startPageImageIndexAtom);
        for (let i = 0; i < 50 && store.get(pageImageIndexStateAtom).status === 'indexing'; i += 1) await tick(10);
        expect([...db.byModel.get('embeddinggemma-2:440m-q8_0-text-vision')!.keys()]).toEqual(['1-AAA']);
    });

    it('starts nothing for the new model when the text index is not kept up to date by itself', async () => {
        const store = jotaiStore.current;
        config.fulltextAuto = false;
        extractor.onRender = (key) => {
            if (key === 'AAA') config.modelId = 'embeddinggemma-2:440m-q8_0-text-vision';
        };
        await store.set(startPageImageIndexAtom);
        await tick(30);
        expect(extractor.rendered).toEqual(['AAA']);
    });

    it('starts nothing for the new model when figures are not indexed automatically', async () => {
        const store = jotaiStore.current;
        config.auto = false;
        extractor.onRender = (key) => {
            if (key === 'AAA') config.modelId = 'embeddinggemma-2:440m-q8_0-text-vision';
        };
        await store.set(startPageImageIndexAtom);
        await tick(30);
        expect([...db.byModel.get('gemini-embedding-2')!.keys()]).toEqual(['1-AAA']);
        expect(db.byModel.get('embeddinggemma-2:440m-q8_0-text-vision')?.size ?? 0).toBe(0);
        expect(extractor.rendered).toEqual(['AAA']);
    });
});

describe('what a figure search is told about coverage', () => {
    it('says how much has pages while some PDFs still have none', async () => {
        library.keys = [['AAA', 'BBB', 'CCC']];
        db.done.set('1-AAA', 3);
        const note = await figureCoverageNoteFor('gemini-embedding-2');
        expect(note).toMatch(/^Only 1 of 3 PDFs in this library have page images/);
        expect(note).toMatch(/2 more have no page images yet/);
    });

    it('counts a PDF that could not be read as unreadable, not as still to come', async () => {
        const store = jotaiStore.current;
        library.keys = [['AAA', 'BBB']];
        extractor.unreadable = new Set(['BBB']);
        await store.set(startPageImageIndexAtom);
        expect([...db.done.keys()]).toEqual(['1-AAA']);
        const note = await figureCoverageNoteFor('gemini-embedding-2');
        expect(note).toMatch(/1 could not be read on this computer/);
        expect(note).not.toMatch(/no page images yet/);
    });

    it('passes over a library excluded while the run goes on', async () => {
        const store = jotaiStore.current;
        const { searchableLibraryIdsAtom } = await import('../../../react/atoms/profile');
        extractor.onRender = (key) => {
            if (key === 'AAA') store.set(searchableLibraryIdsAtom, []);
        };
        await store.set(startPageImageIndexAtom);
        // AAA's library was excluded while it was being rendered: nothing of it
        // went out or was stored, and BBB was not started.
        expect(extractor.rendered).toEqual(['AAA']);
        expect([...db.done.keys()]).toEqual([]);
    });

    it('says nothing when every PDF has its pages', async () => {
        library.keys = [['AAA']];
        db.done.set('1-AAA', 3);
        expect(await figureCoverageNoteFor('gemini-embedding-2')).toBeNull();
    });
});

describe('a PDF that could not be rendered', () => {
    /** BBB is a PDF of the paper PBBB whose file is not on this computer. */
    function withoutFile(attachment: Record<string, unknown>) {
        const lookups = { BBB: 0 };
        library.parents = { BBB: 'PBBB' };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = async (_lib: number, key: string) => {
            if (key === 'PBBB') return { getDisplayTitle: () => 'Observation of a fractional effect' };
            if (key !== 'BBB') return { getFilePathAsync: async () => `/pdfs/${key}.pdf` };
            lookups.BBB += 1;
            return { libraryID: 1, attachmentLinkMode: 1, ...attachment, getFilePathAsync: async () => false };
        };
        return lookups;
    }

    it('is set aside with the reason, named by its paper, and Index alone does not try it again', async () => {
        const store = jotaiStore.current;
        const lookups = withoutFile({ attachmentSyncedHash: null });
        await store.set(startPageImageIndexAtom);
        expect([...db.done.keys()]).toEqual(['1-AAA']);
        const state = store.get(pageImageIndexStateAtom);
        expect(state).toMatchObject({ status: 'idle', indexed: 1, library: 2, skipped: 1 });
        expect(state.failures).toHaveLength(1);
        expect(state.failures[0].title).toBe('Observation of a fractional effect');
        expect(state.failures[0].message).toMatch(/not on this computer, and Zotero never uploaded it/);

        await store.set(startPageImageIndexAtom);
        expect(lookups.BBB).toBe(1);
        expect(store.get(pageImageIndexStateAtom).skipped).toBe(1);

        await store.set(startPageImageIndexAtom, { retryFailed: true });
        expect(lookups.BBB).toBe(2);
        expect(store.get(pageImageIndexStateAtom).skipped).toBe(1);
    });

    it('counts as indexed once it has pages, not as set aside', async () => {
        const store = jotaiStore.current;
        const { refreshPageImageCoverageAtom } = await import('../../../react/atoms/pageImageIndex');
        withoutFile({ attachmentSyncedHash: null });
        await store.set(startPageImageIndexAtom);
        db.done.set('1-BBB', 2);
        await store.set(refreshPageImageCoverageAtom);
        expect(store.get(pageImageIndexStateAtom)).toMatchObject({ indexed: 2, library: 2, skipped: 0, failures: [] });
    });

    it('says whether Zotero can download a missing file, or never had it online', () => {
        const zotero = (globalThis as any).Zotero;
        const syncsFiles = { value: true };
        zotero.Sync = { Storage: { Local: { getEnabledForLibrary: () => syncsFiles.value } } };
        const hash = '819e39e7c24f8974d8c818cbf7cb398c';
        expect(missingFileReason({ attachmentLinkMode: 1, attachmentSyncedHash: hash, libraryID: 1 }))
            .toMatch(/not downloaded to this computer yet\. Open it once in Zotero/);
        syncsFiles.value = false;
        expect(missingFileReason({ attachmentLinkMode: 1, attachmentSyncedHash: hash, libraryID: 1 }))
            .toMatch(/file syncing is off/);
        expect(missingFileReason({ attachmentLinkMode: 0, attachmentSyncedHash: null, libraryID: 1 }))
            .toMatch(/never uploaded it, so it cannot be downloaded/);
        expect(missingFileReason({ attachmentLinkMode: 2, libraryID: 1 })).toMatch(/linked PDF is not at its path/);
        delete zotero.Sync;
    });
});
