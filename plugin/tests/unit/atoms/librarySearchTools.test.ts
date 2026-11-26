/**
 * The two index searches shared by the assistant and the MCP server: which
 * libraries and PDFs they search, what they refuse, how they read titles, and
 * the run bookkeeping that only a run gets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    ready: true,
    libraryIds: [1, 5] as number[],
    candidates: [] as any[],
    hits: [] as any[],
    pageHits: [] as any[],
}));

const searchChunks = vi.hoisted(() => vi.fn(async () => state.hits));
const searchPageImages = vi.hoisted(() => vi.fn(async () => state.pageHits));
const listAllCandidates = vi.hoisted(() => vi.fn(async () => state.candidates));
const recordShownLocators = vi.hoisted(() => vi.fn());
const recordShownPassage = vi.hoisted(() => vi.fn());

vi.mock('../../../react/store', () => ({ store: { get: () => state.libraryIds } }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: 'searchableLibraryIdsAtom' }));
vi.mock('../../../react/atoms/fulltextIndex', () => ({ listAllCandidates }));
vi.mock('../../../react/atoms/pageImageIndex', () => ({
    figureCoverageNoteFor: vi.fn(async () => null),
    pageImageProvider: vi.fn(() => ({ embedsImages: true })),
}));
vi.mock('../../../react/utils/highlightCitations', () => ({
    recordShownLocators,
    recordShownPassage,
    sentenceRangeNumbers: (start: number, end: number) => [start, end],
}));
vi.mock('@beaver/agent-llm/fulltextIndexer', () => ({
    candidateKey: (candidate: any) => `${candidate.libraryId}/${candidate.key}`,
    coverageNote: () => null,
}));
vi.mock('@beaver/agent-llm/fulltextIndex', () => ({ searchChunks }));
vi.mock('../../../src/services/llm/pageImageIndex', () => ({ searchPageImages }));
vi.mock('../../../src/services/llm/agentConfig', () => ({
    buildEmbeddingProviderFromPrefs: () => ({ name: 'provider' }),
    currentEmbeddingModelId: () => 'model-x',
    isSemanticSearchAvailable: () => true,
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : `g${id * 100}`),
}));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => undefined }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({ isLibraryAccessReady: () => state.ready }));

import { figureSearchAvailable, figuresTool, fulltextTool } from '../../../react/atoms/librarySearchTools';

/** An item whose fields, like Zotero's, cannot be read before its data is loaded. */
function lazyItem(key: string, title: string, { titleThrows = false } = {}) {
    const item: any = {
        key,
        loaded: false,
        getField: vi.fn((field: string) => {
            if (!item.loaded || titleThrows) throw new Error("Item data not loaded and 'itemData' not set");
            return field === 'title' ? title : '';
        }),
        getDisplayTitle: vi.fn(() => {
            if (!item.loaded) throw new Error('Item data not loaded');
            return `${title} (PDF)`;
        }),
    };
    return item;
}

const zotero = (globalThis as any).Zotero;
let items: Map<string, any>;
let db: any;

beforeEach(() => {
    vi.clearAllMocks();
    state.ready = true;
    state.libraryIds = [1, 5];
    state.candidates = [{ libraryId: 1, key: 'PDF00001' }, { libraryId: 5, key: 'PDF00005' }];
    state.hits = [];
    state.pageHits = [];
    items = new Map([
        ['5/PARENT05', lazyItem('PARENT05', 'A paper in a group')],
        ['5/PDF00005', lazyItem('PDF00005', 'its PDF')],
        ['1/PDF00001', lazyItem('PDF00001', 'A standalone PDF')],
    ]);
    zotero.Items = {
        getByLibraryAndKey: vi.fn((libraryId: number, key: string) => items.get(`${libraryId}/${key}`) ?? false),
        loadDataTypes: vi.fn(async (list: any[]) => { for (const item of list) item.loaded = true; }),
    };
    db = {
        getChunkedAttachmentKeys: vi.fn(async () => new Set(['1/PDF00001', '5/PDF00005'])),
        getPageImagedAttachmentKeys: vi.fn(async () => new Set<string>()),
    };
    zotero.AlphainZ = { db };
});

const groupHit = {
    libraryId: 5,
    attachmentKey: 'PDF00005',
    parentKey: 'PARENT05',
    page: 4,
    pageLabel: '204',
    text: 'The passage.',
    similarity: 0.61234,
    sentenceStart: 12,
    sentenceEnd: 14,
};

describe('search_library_fulltext', () => {
    it('searches only the searchable libraries and their PDFs, for the trimmed query', async () => {
        await fulltextTool().search_library_fulltext({ query: '  rise time  ' });
        expect(searchChunks).toHaveBeenCalledTimes(1);
        const call = (searchChunks.mock.calls[0] as any[])[0];
        expect(call.libraryIds).toEqual([1, 5]);
        expect([...call.attachments]).toEqual(['1/PDF00001', '5/PDF00005']);
        expect(call.query).toBe('rise time');
    });

    it('refuses to search before the library list has loaded, instead of calling every library excluded', async () => {
        state.ready = false;
        state.libraryIds = [];
        await expect(fulltextTool().search_library_fulltext({ query: 'x' })).rejects.toThrow('still loading');
        expect(searchChunks).not.toHaveBeenCalled();
    });

    it('says every library is excluded, and searches nothing, when that is so', async () => {
        state.libraryIds = [];
        const result: any = await fulltextTool().search_library_fulltext({ query: 'x' });
        expect(result.matches).toEqual([]);
        expect(result.note).toContain('every library is excluded');
        expect(searchChunks).not.toHaveBeenCalled();
    });

    it('refuses a search for nothing', async () => {
        await expect(fulltextTool().search_library_fulltext({})).rejects.toThrow('search_library_fulltext requires: query.');
        await expect(fulltextTool().search_library_fulltext({ query: '   ' })).rejects.toThrow('requires: query');
        expect(searchChunks).not.toHaveBeenCalled();
    });

    it('loads the hits’ item data in one batch before reading their titles', async () => {
        state.hits = [groupHit];
        const result: any = await fulltextTool().search_library_fulltext({ query: 'x' });
        expect(zotero.Items.loadDataTypes).toHaveBeenCalledTimes(1);
        expect(zotero.Items.loadDataTypes.mock.calls[0][1]).toEqual(['itemData']);
        expect(result.matches[0]).toMatchObject({
            attachment_id: 'g500-PDF00005',
            title: 'A paper in a group',
            page: 4,
            page_label: '204',
            similarity: 0.612,
            cite: '<citation id="g500-PDF00005" page="4" loc="s12-s14"/>',
        });
    });

    it('leaves out a title it still cannot read, and keeps the hit', async () => {
        items.set('5/PARENT05', lazyItem('PARENT05', 'unreadable', { titleThrows: true }));
        state.hits = [groupHit];
        const result: any = await fulltextTool().search_library_fulltext({ query: 'x' });
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].title).toBeNull();
        expect(result.matches[0].passage).toBe('The passage.');
    });

    it('uses the PDF’s own title for a PDF with no paper', async () => {
        state.hits = [{ ...groupHit, libraryId: 1, attachmentKey: 'PDF00001', parentKey: null }];
        const result: any = await fulltextTool().search_library_fulltext({ query: 'x' });
        expect(result.matches[0].title).toBe('A standalone PDF (PDF)');
    });

    it("records what a run was shown, and records nothing for a call that is not a run's", async () => {
        state.hits = [groupHit];
        await fulltextTool('run-1').search_library_fulltext({ query: 'x' });
        expect(recordShownLocators).toHaveBeenCalledWith('run-1', 'g500-PDF00005', [12, 14]);
        expect(recordShownPassage).toHaveBeenCalledTimes(1);

        vi.clearAllMocks();
        await fulltextTool().search_library_fulltext({ query: 'x' });
        expect(recordShownLocators).not.toHaveBeenCalled();
        expect(recordShownPassage).not.toHaveBeenCalled();
    });
});

describe('search_library_figures', () => {
    it('searches only the searchable libraries and their PDFs, and reads titles after loading them', async () => {
        state.pageHits = [{ libraryId: 5, attachmentKey: 'PDF00005', parentKey: 'PARENT05', page: 3, pageLabel: null, similarity: 0.4 }];
        const result: any = await figuresTool().search_library_figures({ query: 'a line chart' });
        const call = (searchPageImages.mock.calls[0] as any[])[0];
        expect(call.libraryIds).toEqual([1, 5]);
        expect([...call.attachments]).toEqual(['1/PDF00001', '5/PDF00005']);
        expect(call.query).toBe('a line chart');
        expect(result.pages[0]).toMatchObject({ attachment_id: 'g500-PDF00005', title: 'A paper in a group', page: 3 });
    });

    it('refuses before the library list has loaded, and refuses a search for nothing', async () => {
        await expect(figuresTool().search_library_figures({ query: '' })).rejects.toThrow('search_library_figures requires: query.');
        state.ready = false;
        await expect(figuresTool().search_library_figures({ query: 'x' })).rejects.toThrow('still loading');
        expect(searchPageImages).not.toHaveBeenCalled();
    });
});

describe('figureSearchAvailable', () => {
    it('is false when the chat model cannot look at what it finds', async () => {
        expect(await figureSearchAvailable(false)).toBe(false);
        expect(db.getPageImagedAttachmentKeys).not.toHaveBeenCalled();
    });

    it('is true only once a searchable PDF has page images', async () => {
        expect(await figureSearchAvailable(true)).toBe(false);
        db.getPageImagedAttachmentKeys.mockResolvedValue(new Set(['9/ELSEWHERE']));
        expect(await figureSearchAvailable(true)).toBe(false);
        db.getPageImagedAttachmentKeys.mockResolvedValue(new Set(['5/PDF00005']));
        expect(await figureSearchAvailable(true)).toBe(true);
    });
});
