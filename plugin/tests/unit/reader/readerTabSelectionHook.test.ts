// @vitest-environment jsdom
/**
 * The reader tracker, mounted: what it stages as the user selects in a PDF,
 * and what it leaves alone.
 *
 * A PDF selection made while the panel is open has to reach the message, for
 * the PDF view never fires `selectionchange`. A highlight staged for a
 * question ("Chat about this highlight") has no selection behind it — picking
 * the highlight cleared it — so neither the watcher that takes down a
 * vanished selection nor a fresh setup of the same paper may drop it.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn(async () => {}) },
}));
vi.mock('../../../react/agents/agentActions', () => ({
    threadAgentActionsAtom: atom([]),
    getZoteroItemReferenceFromAgentAction: vi.fn(() => null),
    hasAppliedBulkAnnotations: vi.fn(() => false),
}));
// The stand-in attachment is readable; checking that needs far more of Zotero.
vi.mock('../../../react/atoms/itemValidation', () => ({
    getItemValidationAtom: atom(() => () => undefined),
    itemValidationResultsAtom: atom(new Map()),
    isHardBlockedValidation: () => false,
    isRejectedItemValidation: () => false,
    validateItemsAtom: atom(null, async () => {}),
    validateRegularItemAtom: atom(null, async () => {}),
}));

import { store } from '../../../react/store';
import { useReaderTabSelection } from '../../../react/hooks/useReaderTabSelection';
import { currentReaderAttachmentAtom, readerTextSelectionAtom } from '../../../react/atoms/messageComposition';
import { excludedLibrariesAtom, localZoteroLibrariesAtom } from '../../../react/atoms/profile';
import { isSidebarVisibleAtom } from '../../../react/atoms/ui';

const libraries = [
    { library_id: 1, group_id: null, name: 'My Library', is_group: false, type: 'user', type_id: 1, read_only: false },
];

function range(text: string, pageIndex: number) {
    return { text, collapsed: false, position: { pageIndex, rects: [[1, 2, 3, 4]] } };
}

let view: any;
let reader: any;
let root: Root | null;

const attachment = {
    id: 204,
    key: 'ATTACH01',
    libraryID: 1,
    isAttachment: () => true,
    isRegularItem: () => false,
    isAnnotation: () => false,
    isNote: () => false,
    parentItem: null,
};

function Probe() {
    useReaderTabSelection();
    return null;
}

async function settle(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

async function mount() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, React.createElement(Probe)));
    });
    await settle(0);
    await settle(0);
}

const highlightPassage = () => ({
    text: 'the gap closes at the transition',
    page: 1,
    page_index: 41,
    highlight: { libraryID: 1, key: 'HIGHLT01', attachmentID: 204 },
});

beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    root = null;
    view = {
        _selectionRanges: [],
        _iframeWindow: {
            PDFViewerApplication: { pdfViewer: { currentPageNumber: 1 } },
            document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        },
    };
    reader = { type: 'pdf', itemID: 204, _internalReader: { _primaryView: view } };
    const mainWindow = {
        Zotero_Tabs: {
            selectedID: 'tab-1',
            selectedType: 'reader',
            _tabs: [{ id: 'tab-1', type: 'reader', data: { itemID: 204 } }],
        },
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: (id: any) => clearInterval(id),
    };
    (Zotero as any).getMainWindow = vi.fn(() => mainWindow);
    (Zotero as any).Reader = { getByTabID: vi.fn(() => reader) };
    (Zotero as any).Items = {
        getAsync: vi.fn(async (id: number) => (id === 204 ? attachment : null)),
        getLibraryAndKeyFromID: vi.fn((id: number) => (id === 204 ? { libraryID: 1, key: 'ATTACH01' } : false)),
        get: vi.fn(() => null),
    };
    store.set(localZoteroLibrariesAtom, libraries as any);
    store.set(excludedLibrariesAtom, []);
    store.set(readerTextSelectionAtom, null);
    store.set(isSidebarVisibleAtom, true);
});

afterEach(async () => {
    if (root) {
        await act(async () => root!.unmount());
    }
    store.set(isSidebarVisibleAtom, false);
    vi.useRealTimers();
});

describe('the reader tracker', () => {
    it('stages a PDF selection made while the panel is open', async () => {
        await mount();
        expect(store.get(currentReaderAttachmentAtom)?.id).toBe(204);
        expect(store.get(readerTextSelectionAtom)).toBeNull();

        view._selectionRanges = [range('picked after the panel opened', 3)];
        await settle(400);
        await settle(0);

        expect(store.get(readerTextSelectionAtom)).toMatchObject({
            text: 'picked after the panel opened',
            page_index: 3,
        });
    });

    it('still takes a selection down once it is gone from the PDF', async () => {
        view._selectionRanges = [range('selected, then clicked away', 2)];
        await mount();
        expect(store.get(readerTextSelectionAtom)).toMatchObject({ text: 'selected, then clicked away' });

        view._selectionRanges = [];
        await settle(2000);
        expect(store.get(readerTextSelectionAtom)).toBeNull();
    });

    it('keeps a passage selected in the first pane of a split view when the second is focused', async () => {
        view._selectionRanges = [range('selected in the first pane', 2)];
        const second = { ...view, _selectionRanges: [] };
        reader._internalReader._secondaryView = second;
        await mount();
        expect(store.get(readerTextSelectionAtom)).toMatchObject({ text: 'selected in the first pane' });

        reader._internalReader._lastView = second;
        await settle(3000);
        expect(store.get(readerTextSelectionAtom)).toMatchObject({ text: 'selected in the first pane' });
    });

    it('leaves a highlight staged for a question alone while nothing is selected', async () => {
        await mount();
        await act(async () => {
            store.set(readerTextSelectionAtom, highlightPassage() as any);
        });
        await settle(3000);
        expect(store.get(readerTextSelectionAtom)).toMatchObject({ text: 'the gap closes at the transition' });
    });

    it('keeps that highlight when opening the panel starts tracking the same paper', async () => {
        // The question opened the panel, which starts tracking — and setting a
        // reader up starts from a clean slate.
        store.set(isSidebarVisibleAtom, false);
        store.set(readerTextSelectionAtom, highlightPassage() as any);
        await mount();

        await act(async () => {
            store.set(isSidebarVisibleAtom, true);
        });
        await settle(0);
        await settle(0);
        await settle(3000);

        expect(store.get(currentReaderAttachmentAtom)?.id).toBe(204);
        expect(store.get(readerTextSelectionAtom)).toMatchObject({ text: 'the gap closes at the transition' });
    });

    it('lets a highlight on another paper go when this one is set up', async () => {
        store.set(isSidebarVisibleAtom, false);
        store.set(readerTextSelectionAtom, {
            ...highlightPassage(),
            highlight: { libraryID: 1, key: 'HIGHLT01', attachmentID: 999 },
        } as any);
        await mount();
        await act(async () => {
            store.set(isSidebarVisibleAtom, true);
        });
        await settle(0);
        await settle(0);
        expect(store.get(readerTextSelectionAtom)).toBeNull();
    });
});
