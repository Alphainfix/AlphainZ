/**
 * The staged passage as a message carries it.
 *
 * The page the passage starts on (`page_index`) travels, so the model can be
 * told it; what this client keeps beside it to scroll back to the passage —
 * the reader's position, the highlight it came from — stays here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { store } from '../../../react/store';
import { getReaderState } from '../../../react/atoms/applicationState';
import { currentReaderAttachmentAtom, readerTextSelectionAtom } from '../../../react/atoms/messageComposition';

const attachment = { id: 204, key: 'ATTACH01', libraryID: 1 } as any;

function openReader(type: string) {
    const reader = {
        type,
        _internalReader: {
            _primaryView: {
                _iframeWindow: { PDFViewerApplication: { pdfViewer: { currentPageNumber: 5 } } },
                flow: { startSection: { index: 2 }, startRange: {} },
                pageMapping: { getPageIndex: () => 9 },
            },
        },
    };
    (Zotero as any).getMainWindow = vi.fn(() => ({ Zotero_Tabs: { selectedID: 'tab-1' } }));
    (Zotero as any).Reader = { getByTabID: vi.fn(() => reader) };
}

beforeEach(() => {
    store.set(currentReaderAttachmentAtom, attachment);
});

describe('the passage in the reader state', () => {
    it('carries the page the passage is on, and nothing only this client needs', async () => {
        openReader('pdf');
        store.set(readerTextSelectionAtom, {
            text: 'top of page six',
            page: 5,
            page_index: 5,
            position: { pageIndex: 5, rects: [[1, 2, 3, 4]] },
            highlight: { libraryID: 1, key: 'HIGHLT01', attachmentID: 204 },
        } as any);

        const state = await getReaderState(store.get, new Set([1]));

        expect(state?.text_selection).toEqual({ text: 'top of page six', page: 5, page_index: 5 });
        expect(state?.current_page).toBe(5);
    });

    it('sends an EPUB passage as its text alone', async () => {
        openReader('epub');
        store.set(readerTextSelectionAtom, {
            text: 'a sentence in chapter three',
            page: 1,
            position: { type: 'FragmentSelector', value: 'epubcfi(/6/4!/4/2,/1:0,/1:12)' },
        } as any);

        const state = await getReaderState(store.get, new Set([1]));

        expect(state?.text_selection).toEqual({ text: 'a sentence in chapter three' });
    });

    it('shares nothing from a library that is not searchable', async () => {
        openReader('pdf');
        store.set(readerTextSelectionAtom, { text: 'x', page: 1, page_index: 0 });
        expect(await getReaderState(store.get, new Set([2]))).toBeNull();
    });
});
