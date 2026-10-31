/**
 * Following what the user selects in the reader, and finding it again.
 *
 * The PDF view keeps its own selection model and never fires
 * `selectionchange`, so a passage selected before asking in the panel has to
 * be read from the view. The view in use is not always the primary one:
 * Reading Mode is a DOM view over the PDF, and a split view has a second
 * pane. And a staged passage is revealed by its own location: an EPUB reads
 * `pageIndex` as an index into its page mapping, so a page number sent there
 * lands at the start of the book.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    addSelectionChangeListener,
    getSelectedText,
    getSelectedTextAsTextSelection,
    revealTextSelectionInCurrentReader,
    textSelectionLocation,
} from '../../../react/utils/readerUtils';

/** The PDF base view: its own selection model, and the page in view. */
function pdfView(ranges: any[], pageInView = 1) {
    return {
        _selectionRanges: ranges,
        _iframeWindow: {
            PDFViewerApplication: { pdfViewer: { currentPageNumber: pageInView } },
            document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        },
    };
}

/** A DOM view (EPUB, snapshot, Reading Mode) whose selection is `text()`. */
function domView(text: () => string, selector: Record<string, unknown> | null = null) {
    return {
        _iframeWindow: {
            getSelection: () => ({ toString: text, rangeCount: text() ? 1 : 0, getRangeAt: () => ({}) }),
            document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        },
        toSelector: vi.fn(() => selector),
    };
}

function range(text: string, pageIndex: number) {
    return { text, collapsed: false, position: { pageIndex, rects: [[1, 2, 3, 4]] } };
}

let mainWindow: any;

beforeEach(() => {
    mainWindow = {
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: (id: any) => clearInterval(id),
        Zotero_Tabs: { selectedID: 'tab-1' },
    };
    (Zotero as any).getMainWindow = vi.fn(() => mainWindow);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('reading the selection', () => {
    it('reads Reading Mode, where the hidden base view has nothing selected', () => {
        const reader = {
            type: 'pdf',
            _internalReader: {
                _primaryView: pdfView([]),
                _lastView: domView(() => 'read in Reading Mode', { pageIndex: 4, rects: [[0, 0, 1, 1]] }),
            },
        };
        expect(getSelectedText(reader as any)).toBe('read in Reading Mode');
        expect(getSelectedTextAsTextSelection(reader)).toMatchObject({
            text: 'read in Reading Mode',
            page_index: 4,
        });
    });

    it('reads the second pane of a split view', () => {
        const reader = {
            type: 'pdf',
            _internalReader: { _primaryView: pdfView([]), _lastView: pdfView([range('in the second pane', 9)]) },
        };
        expect(getSelectedText(reader as any)).toBe('in the second pane');
    });

    it('gives the page the passage is on, not the page in view', () => {
        // Page 5 fills the screen; the sentence was selected at the top of page 6.
        const reader = { type: 'pdf', _internalReader: { _primaryView: pdfView([range('top of page six', 5)], 5) } };
        const selection = getSelectedTextAsTextSelection(reader)!;
        expect(selection.page_index).toBe(5);
        expect(selection.page).toBe(5);
        expect((selection as any).position).toEqual({ pageIndex: 5, rects: [[1, 2, 3, 4]] });
    });

    it('starts a selection over two pages on the earlier one', () => {
        const reader = {
            type: 'pdf',
            _internalReader: { _primaryView: pdfView([range('end of page', 8), range('start of page', 7)]) },
        };
        expect(getSelectedTextAsTextSelection(reader)!.page_index).toBe(7);
    });

    it('keeps reading the first pane of a split view once the second is focused', () => {
        // Clicking into the second pane makes it the view in use; the passage
        // is still selected in the first.
        const second = pdfView([]);
        const reader = {
            type: 'pdf',
            _internalReader: {
                _primaryView: pdfView([range('still selected in the first pane', 3)]),
                _secondaryView: second,
                _lastView: second,
            },
        };
        expect(getSelectedText(reader as any)).toBe('still selected in the first pane');
        expect(getSelectedTextAsTextSelection(reader)).toMatchObject({ page_index: 3 });
    });

    it('prefers the pane in use when both panes have a selection', () => {
        const second = pdfView([range('just selected in the second pane', 8)]);
        const reader = {
            type: 'pdf',
            _internalReader: {
                _primaryView: pdfView([range('older, in the first pane', 3)]),
                _secondaryView: second,
                _lastView: second,
            },
        };
        expect(getSelectedText(reader as any)).toBe('just selected in the second pane');
    });

    it('leaves out a base view hidden behind Reading Mode', () => {
        // The base view still holds what was selected before Reading Mode was
        // turned on; it is not on screen.
        const overlay = domView(() => '');
        const base = pdfView([range('selected before Reading Mode', 2)]);
        const reader = {
            type: 'pdf',
            _internalReader: {
                _primaryView: base,
                _primarySDTView: overlay,
                _lastView: overlay,
                _getActiveView: (primary: boolean) => (primary ? overlay : null),
            },
        };
        expect(getSelectedText(reader as any)).toBeNull();
    });

    it('does not count a plain click as a selection', () => {
        const reader = {
            type: 'pdf',
            _internalReader: { _primaryView: pdfView([{ text: '', collapsed: true, position: { pageIndex: 0 } }]) },
        };
        expect(getSelectedText(reader as any)).toBeNull();
    });
});

describe('following the selection', () => {
    it('stages a PDF selection made after the reader was set up', () => {
        // The PDF view never fires selectionchange; without reading it, a
        // passage selected before asking in the panel was never attached.
        vi.useFakeTimers();
        const view = pdfView([]);
        const reader = { type: 'pdf', _internalReader: { _primaryView: view } };
        const reported: any[] = [];
        const stop = addSelectionChangeListener(reader, (selection) => reported.push(selection))!;

        view._selectionRanges = [range('selected afterwards', 2)];
        vi.advanceTimersByTime(400);
        expect(reported).toHaveLength(1);
        expect(reported[0]).toMatchObject({ text: 'selected afterwards', page_index: 2 });

        stop();
    });

    it('reports a change once, so a passage taken off the message stays off while still selected', () => {
        vi.useFakeTimers();
        const view = pdfView([range('the passage', 2)]);
        const reader = { type: 'pdf', _internalReader: { _primaryView: view } };
        const reported: any[] = [];
        const stop = addSelectionChangeListener(reader, (selection) => reported.push(selection))!;
        expect(reported).toHaveLength(1); // what was already selected

        vi.advanceTimersByTime(2000);
        expect(reported).toHaveLength(1);

        view._selectionRanges = [];
        vi.advanceTimersByTime(400);
        expect(reported.at(-1)).toBeNull();

        view._selectionRanges = [range('the passage', 2)];
        vi.advanceTimersByTime(400);
        expect(reported.at(-1)).toMatchObject({ text: 'the passage' });
        expect(reported).toHaveLength(3);
        stop();
    });

    it('follows the Reading Mode overlay, which has its own document', () => {
        vi.useFakeTimers();
        let text = '';
        const reader = {
            type: 'snapshot',
            _internalReader: { _primaryView: domView(() => ''), _lastView: domView(() => text) },
        };
        const reported: any[] = [];
        const stop = addSelectionChangeListener(reader, (selection) => reported.push(selection))!;
        text = 'selected in the overlay';
        vi.advanceTimersByTime(400);
        expect(reported.at(-1)).toMatchObject({ text: 'selected in the overlay' });
        stop();
    });

    it('does not report the passage gone when the other pane of a split view is focused', () => {
        vi.useFakeTimers();
        const first = pdfView([range('selected in the first pane', 4)]);
        const second = pdfView([]);
        const internal: any = { _primaryView: first, _secondaryView: second, _lastView: first };
        const reader = { type: 'pdf', _internalReader: internal };
        const reported: any[] = [];
        const stop = addSelectionChangeListener(reader, (selection) => reported.push(selection))!;
        expect(reported).toHaveLength(1);

        internal._lastView = second;
        vi.advanceTimersByTime(2000);
        expect(reported).toHaveLength(1);
        stop();
    });

    it('stops reading once it is removed', () => {
        vi.useFakeTimers();
        const view = pdfView([]);
        const reader = { type: 'pdf', _internalReader: { _primaryView: view } };
        const reported: any[] = [];
        const stop = addSelectionChangeListener(reader, (selection) => reported.push(selection))!;
        stop();
        view._selectionRanges = [range('too late', 1)];
        vi.advanceTimersByTime(2000);
        expect(reported).toHaveLength(0);
    });

    it('reads nothing once access is gone', () => {
        vi.useFakeTimers();
        let allowed = true;
        const view = pdfView([]);
        const reader = { type: 'pdf', _internalReader: { _primaryView: view } };
        const reported: any[] = [];
        const stop = addSelectionChangeListener(reader, (selection) => reported.push(selection), () => allowed)!;
        allowed = false;
        view._selectionRanges = [range('in an excluded library', 1)];
        vi.advanceTimersByTime(2000);
        expect(reported).toHaveLength(0);
        stop();
    });
});

describe('finding a staged passage again', () => {
    it('goes to the passage itself when its position is known', () => {
        const position = { pageIndex: 13, rects: [[1, 2, 3, 4]] };
        expect(textSelectionLocation({ text: 'x', page: 1, page_index: 13, position } as any, 'pdf'))
            .toEqual({ position });
    });

    it('goes to the page the passage is on, not a page number that was always 1', () => {
        expect(textSelectionLocation({ text: 'x', page: 1, page_index: 13 }, 'pdf')).toEqual({ pageIndex: 13 });
    });

    it('never sends an EPUB a page number', () => {
        // pageIndex 0 in an EPUB is the start of the book.
        expect(textSelectionLocation({ text: 'x', page: 1 }, 'epub')).toBeNull();
        expect(textSelectionLocation({ text: 'x', page: 1 }, 'snapshot')).toBeNull();
    });

    it('reveals an EPUB passage by its selector', () => {
        const navigate = vi.fn();
        (Zotero as any).Reader = { getByTabID: vi.fn(() => ({ type: 'epub', navigate })) };
        const position = { type: 'FragmentSelector', value: 'epubcfi(/6/4!/4/2,/1:0,/1:12)' };

        expect(revealTextSelectionInCurrentReader({ text: 'x', page: 1, position } as any)).toBe(true);
        expect(navigate).toHaveBeenCalledWith({ position });
    });

    it('does nothing for an EPUB passage it cannot locate', () => {
        const navigate = vi.fn();
        (Zotero as any).Reader = { getByTabID: vi.fn(() => ({ type: 'epub', navigate })) };
        expect(revealTextSelectionInCurrentReader({ text: 'x', page: 1 })).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
    });
});
