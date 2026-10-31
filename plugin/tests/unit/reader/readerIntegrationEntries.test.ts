// @vitest-environment jsdom
/**
 * The reader's own entry points: the annotation menu, the view menu, and the
 * question field in the selection popup.
 *
 * Driven through the listeners the module registers with the reader, with a
 * stand-in reader whose shapes follow Zotero's: the annotation menu names
 * annotations by item key; the PDF view keeps its selection in
 * `_selectionRanges`; Reading Mode is a DOM view over the PDF, used last.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initReaderIntegration } from '../../../src/modules/readerIntegration';

type Handler = (event: any) => void;

let handlers: Record<string, Handler>;
let dispatched: Array<{ type: string; detail: any }>;
let bus: EventTarget;

function mainWindowWithBus() {
    return { __alphainzEventBus: bus, CustomEvent };
}

beforeEach(() => {
    handlers = {};
    dispatched = [];
    bus = new EventTarget();
    const deliver = bus.dispatchEvent.bind(bus);
    bus.dispatchEvent = (event: Event) => {
        dispatched.push({ type: event.type, detail: (event as CustomEvent).detail });
        return deliver(event);
    };
    (globalThis as any).addon = { data: { config: { addonID: 'alphainz@test' } } };
    (Zotero as any).Reader = {
        _registeredListeners: [],
        registerEventListener: vi.fn((type: string, handler: Handler) => {
            handlers[type] = handler;
        }),
    };
    (Zotero as any).getMainWindow = vi.fn(() => mainWindowWithBus());
    (Zotero as any).Items = {
        getLibraryAndKeyFromID: vi.fn(() => false),
        getByLibraryAndKey: vi.fn(() => false),
    };
    initReaderIntegration();
});

afterEach(() => {
    vi.useRealTimers();
});

/** Build a menu the way the reader does: collect what the listener appends. */
function openMenu(type: string, event: Record<string, unknown>): any[] {
    const items: any[] = [];
    handlers[type]({ ...event, append: (...entries: any[]) => items.push(...entries) });
    return items;
}

const highlight = (overrides: Record<string, unknown> = {}) => ({
    isAnnotation: () => true,
    annotationType: 'highlight',
    annotationText: 'the tunnel sets the distance',
    ...overrides,
});

describe('the annotation menu', () => {
    it('offers to chat about one highlight, looked up by its key in the open file\'s library', () => {
        // The reader's annotation ids are item keys. Read as a number, the key
        // is NaN and the entry never appeared.
        (Zotero.Items.getByLibraryAndKey as any) = vi.fn((libraryID: number, key: string) =>
            libraryID === 3 && key === 'ABCD2345' ? highlight() : false);
        const items = openMenu('createAnnotationContextMenu', {
            reader: { type: 'pdf', itemID: 204, _item: { libraryID: 3 } },
            params: { ids: ['ABCD2345'] },
        });

        const chat = items.find((item) => item.label === 'Chat about this highlight');
        expect(chat).toBeDefined();
        chat.onCommand();
        expect(dispatched).toContainEqual({
            type: 'alphainChatAboutAnnotation',
            detail: { annotationKey: 'ABCD2345', libraryId: 3, readerItemID: 204 },
        });
    });

    it('takes the library from the attachment id when the reader does not carry its item', () => {
        (Zotero.Items.getLibraryAndKeyFromID as any) = vi.fn((id: number) =>
            id === 204 ? { libraryID: 5, key: 'ATTACH01' } : false);
        (Zotero.Items.getByLibraryAndKey as any) = vi.fn((libraryID: number) =>
            libraryID === 5 ? highlight() : false);
        const items = openMenu('createAnnotationContextMenu', {
            reader: { type: 'pdf', itemID: 204 },
            params: { ids: ['ABCD2345'] },
        });
        expect(items.map((item) => item.label)).toContain('Chat about this highlight');
    });

    it('offers Ask instead of chat for a boxed area, which has no passage to quote', () => {
        (Zotero.Items.getByLibraryAndKey as any) = vi.fn(() =>
            highlight({ annotationType: 'image', annotationText: '' }));
        const items = openMenu('createAnnotationContextMenu', {
            reader: { type: 'pdf', itemID: 204, _item: { libraryID: 3 } },
            params: { ids: ['IMG00001'] },
        });

        expect(items.map((item) => item.label)).toEqual(['Explain with AlphainZ', 'Ask AlphainZ...']);
        items[1].onCommand();
        expect(dispatched).toContainEqual({
            type: 'readerAnnotationAction',
            detail: { action: 'ask', annotationIds: ['IMG00001'], readerItemID: 204 },
        });
    });

    it('explains and asks about several annotations at once, by key', () => {
        const items = openMenu('createAnnotationContextMenu', {
            reader: { type: 'pdf', itemID: 204, _item: { libraryID: 3 } },
            params: { ids: ['KEY00001', 'KEY00002'] },
        });
        expect(items.map((item) => item.label)).toEqual(['Explain with AlphainZ', 'Ask AlphainZ...']);
        items[0].onCommand();
        expect(dispatched).toContainEqual({
            type: 'readerAnnotationAction',
            detail: { action: 'explain', annotationIds: ['KEY00001', 'KEY00002'], readerItemID: 204 },
        });
    });
});

/** A DOM view (EPUB, snapshot, Reading Mode) holding a selection of `text`. */
function domView(text: string, selector: Record<string, unknown> | null) {
    const range = {};
    return {
        _iframeWindow: {
            getSelection: () => ({ toString: () => text, rangeCount: text ? 1 : 0, getRangeAt: () => range }),
        },
        toSelector: vi.fn(() => selector),
    };
}

/** The PDF base view: its own selection model, and the page in view. */
function pdfView(ranges: any[], pageInView: number) {
    return {
        _selectionRanges: ranges,
        _iframeWindow: { PDFViewerApplication: { pdfViewer: { currentPageNumber: pageInView } } },
    };
}

describe('the view menu', () => {
    it('reads the selection in Reading Mode, where the base view has none', () => {
        const position = { pageIndex: 5, rects: [[10, 20, 30, 40]] };
        const reader = {
            type: 'pdf',
            itemID: 204,
            _internalReader: {
                _primaryView: pdfView([], 5),
                _lastView: domView('a passage read in Reading Mode', position),
            },
        };
        const items = openMenu('createViewContextMenu', { reader, params: {} });
        const explain = items.find((item) => item.label === 'Explain with AlphainZ');
        const ask = items.find((item) => item.label === 'Ask AlphainZ...');
        expect(explain.disabled).toBe(false);
        expect(ask.disabled).toBe(false);

        explain.onCommand();
        expect(dispatched).toContainEqual({
            type: 'readerSelectionAction',
            detail: {
                action: 'explain',
                text: 'a passage read in Reading Mode',
                page: 5,
                pageIndex: 5,
                position,
                readerItemID: 204,
            },
        });
    });

    it('reads the second pane of a split view, and sends the page the selection is on', () => {
        // Page 5 is in view in the primary pane; the passage was selected on
        // page 7 in the second one.
        const range = { text: 'selected on page seven', collapsed: false, position: { pageIndex: 6, rects: [[1, 2, 3, 4]] } };
        const reader = {
            type: 'pdf',
            itemID: 204,
            _internalReader: {
                _primaryView: pdfView([], 5),
                _lastView: pdfView([range], 7),
            },
        };
        const items = openMenu('createViewContextMenu', { reader, params: {} });
        items.find((item) => item.label === 'Ask AlphainZ...').onCommand();

        const detail = dispatched.find((event) => event.type === 'readerSelectionAction')!.detail;
        expect(detail.text).toBe('selected on page seven');
        expect(detail.pageIndex).toBe(6);
        expect(detail.position).toEqual(range.position);
    });

    it('reads only the pane it was opened on, not a selection left in the other one', () => {
        // Right-clicked in the second pane, which has nothing selected; the
        // first pane still shows a selection.
        const second = pdfView([], 3);
        const reader = {
            type: 'pdf',
            itemID: 204,
            _internalReader: {
                _primaryView: pdfView([{ text: 'left in the first pane', collapsed: false, position: { pageIndex: 1 } }], 2),
                _secondaryView: second,
                _lastView: second,
            },
        };
        const items = openMenu('createViewContextMenu', { reader, params: {} });
        expect(items.every((item) => item.disabled)).toBe(true);
    });

    it('greys the entries out when nothing is selected in the view in use', () => {
        const reader = {
            type: 'pdf',
            itemID: 204,
            _internalReader: {
                _primaryView: pdfView([{ text: '', collapsed: true, position: { pageIndex: 0 } }], 1),
            },
        };
        const items = openMenu('createViewContextMenu', { reader, params: {} });
        expect(items.every((item) => item.disabled)).toBe(true);
    });
});

/** Render the popup's question field and hand back its parts. */
function renderPopup(annotation: Record<string, unknown>, reader: Record<string, unknown> = { type: 'pdf', itemID: 204 }) {
    const host = document.createElement('div');
    handlers.renderTextSelectionPopup({
        reader,
        doc: document,
        params: { annotation },
        append: (element: Element) => host.appendChild(element),
    });
    return {
        input: host.querySelector('input') as HTMLInputElement,
        status: host.querySelector('.alphain-selection-status') as HTMLElement,
    };
}

function ask(input: HTMLInputElement, question: string) {
    input.value = question;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

const selectionAnnotation = {
    type: 'highlight',
    text: 'a passage on page fourteen',
    pageLabel: '14',
    sortIndex: '00013|000000|00100',
    position: { pageIndex: 13, rects: [[1, 2, 3, 4]] },
};

function lastQuestion() {
    return dispatched.filter((event) => event.type === 'alphainSelectionChat').at(-1)?.detail;
}

describe('the selection popup', () => {
    it('sends the page the selection is on, from its position', () => {
        const { input } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        expect(lastQuestion().pageIndex).toBe(13);
        expect(lastQuestion().annotation.position).toEqual(selectionAnnotation.position);
    });

    it('keeps the question in the field until AlphainZ says what it did with it', () => {
        const { input } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        expect(input.value).toBe('what does this mean?');
        expect(input.disabled).toBe(true);
    });

    it('gives the question back with the reason when it could not be asked', () => {
        const { input, status } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        lastQuestion().onOutcome({ status: 'failed', reason: 'This library is excluded from AlphainZ.' });

        expect(input.value).toBe('what does this mean?');
        expect(input.disabled).toBe(false);
        expect(status.textContent).toBe('This library is excluded from AlphainZ.');
        expect(status.style.display).not.toBe('none');
    });

    it('clears the field for a follow-up once the question is on its way', () => {
        const { input, status } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        lastQuestion().onOutcome({ status: 'sent' });

        expect(input.value).toBe('');
        expect(input.disabled).toBe(false);
        expect(status.textContent).toBe('Sent to AlphainZ →');

        // And a second question about the same passage goes out too.
        ask(input, 'and the next sentence?');
        expect(lastQuestion().prompt).toBe('and the next sentence?');
    });

    it('says the question is waiting when an answer is still being written', () => {
        const { input, status } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        lastQuestion().onOutcome({ status: 'staged' });
        expect(input.value).toBe('');
        expect(status.textContent).toContain('waiting in the AlphainZ message box');
    });

    it('does not lose the question when AlphainZ is not ready to take it', () => {
        (Zotero as any).getMainWindow = vi.fn(() => ({}));
        const { input, status } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        expect(input.value).toBe('what does this mean?');
        expect(input.disabled).toBe(false);
        expect(status.textContent).toContain('not ready');
    });

    it('gives the question back when nothing answers', () => {
        vi.useFakeTimers();
        const { input, status } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        vi.advanceTimersByTime(20000);
        expect(input.disabled).toBe(false);
        expect(input.value).toBe('what does this mean?');
        expect(status.textContent).toContain('did not pick this up');

        // A late answer changes nothing.
        lastQuestion().onOutcome({ status: 'sent' });
        expect(input.value).toBe('what does this mean?');
    });

    it('waits for the send once AlphainZ has the question, without giving it back on a timer', () => {
        vi.useFakeTimers();
        const { input, status } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        lastQuestion().onOutcome({ status: 'sending' });

        expect(status.textContent).toBe('Sending to AlphainZ…');
        vi.advanceTimersByTime(60000);
        expect(input.disabled).toBe(true);
        expect(input.value).toBe('what does this mean?');

        lastQuestion().onOutcome({ status: 'sent' });
        expect(input.value).toBe('');
        expect(status.textContent).toBe('Sent to AlphainZ →');
    });

    it('gives the question back when the send is turned away after AlphainZ took it', () => {
        const { input, status } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        lastQuestion().onOutcome({ status: 'sending' });
        lastQuestion().onOutcome({ status: 'failed', reason: 'OpenRouter has no API key on this computer.' });

        expect(input.value).toBe('what does this mean?');
        expect(input.disabled).toBe(false);
        expect(status.textContent).toBe('OpenRouter has no API key on this computer.');
    });

    it('does not send twice while the first question is still on its way', () => {
        const { input } = renderPopup(selectionAnnotation);
        ask(input, 'what does this mean?');
        input.disabled = false; // a keypress can still arrive
        ask(input, 'what does this mean?');
        expect(dispatched.filter((event) => event.type === 'alphainSelectionChat')).toHaveLength(1);
    });
});
