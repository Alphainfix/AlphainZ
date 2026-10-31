// @vitest-environment jsdom
 
/**
 * The composer's reader chips, clicked.
 *
 * "Current File" must not pull the user out of the reader (which would take
 * the staged passage and highlights with it). "N Highlights" jumps to the
 * first highlight itself — its printed page label is not a page number — and
 * does not select it, which would clear the reader's text selection. The
 * passage chip goes back to the passage, and never sends an EPUB to its first
 * page. A highlight the user chose Explain or Ask on keeps a chip of its own.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { store } from '../../../react/store';
import { readerAnnotationCountAtom, readerAnnotationsAtom } from '../../../react/atoms/messageComposition';
import { MessageItemButton } from '../../../react/components/input/MessageItemButton';
import { ReaderAnnotationsButton } from '../../../react/components/input/ReaderAnnotationsButton';
import { TextSelectionButton } from '../../../react/components/input/TextSelectionButton';

function render(element: React.ReactElement): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
        root.render(<Provider store={store}>{element}</Provider>);
    });
    return host;
}

function click(host: HTMLElement) {
    const button = host.querySelector('button')!;
    act(() => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
}

let selectItem: any;
let navigate: any;
let open: any;
let readerType: string;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    selectItem = vi.fn();
    navigate = vi.fn();
    open = vi.fn(async () => undefined);
    readerType = 'pdf';
    const tabs = {
        selectedID: 'tab-reader',
        getTabIDByItemID: (id: number) => (id === 204 ? 'tab-reader' : null),
    };
    (Zotero as any).getMainWindow = vi.fn(() => ({ ZoteroPane: { selectItem }, Zotero_Tabs: tabs }));
    (Zotero as any).getActiveZoteroPane = vi.fn(() => ({ viewAttachment: vi.fn() }));
    (Zotero as any).Reader = {
        getByTabID: vi.fn(() => ({ type: readerType, navigate })),
        open,
    };
    store.set(readerAnnotationsAtom, []);
    store.set(readerAnnotationCountAtom, 0);
});

const pdfAttachment = {
    id: 204,
    key: 'ATTACH01',
    libraryID: 1,
    parentItem: null,
    parentID: null,
    isAnnotation: () => false,
    isRegularItem: () => false,
    isNote: () => false,
    isAttachment: () => true,
    isFileAttachment: () => true,
    getDisplayTitle: () => 'Tang 2023.pdf',
    getItemTypeIconName: () => 'attachmentPDF',
    getField: () => '',
    attachmentContentType: 'application/pdf',
} as any;

describe('the Current File chip', () => {
    it('keeps the user in the reader when clicked', () => {
        const host = render(<MessageItemButton item={pdfAttachment} canEdit={false} tabContextType="reader" />);
        expect(host.textContent).toContain('Current File');
        click(host);
        expect(selectItem).not.toHaveBeenCalled();
    });

    it('still reveals an ordinary attached file in the library', () => {
        const host = render(<MessageItemButton item={{ ...pdfAttachment, id: 555 }} canEdit={false} />);
        click(host);
        expect(selectItem).toHaveBeenCalledWith(555);
    });
});

function highlightItem(key: string, pageLabel: string, position?: Record<string, unknown>) {
    return {
        key,
        libraryID: 1,
        parentID: 204,
        isAnnotation: () => true,
        annotationType: 'highlight',
        annotationText: `highlight ${key}`,
        annotationPageLabel: pageLabel,
        ...(position ? { annotationPosition: JSON.stringify(position) } : {}),
    } as any;
}

describe('the highlights chip', () => {
    it('scrolls to the first highlight without selecting it, so a staged passage stays', () => {
        // Selecting the highlight — what opening the reader at it does —
        // clears the reader's text selection, and the staged passage with it.
        const position = { pageIndex: 41, rects: [[5, 6, 7, 8]] };
        (Zotero as any).Reader.getByTabID = vi.fn(() => ({ type: 'pdf', itemID: 204, navigate }));
        store.set(readerAnnotationsAtom, [highlightItem('HIGHLT01', '1043', position)]);
        const host = render(<ReaderAnnotationsButton />);
        click(host);
        expect(navigate).toHaveBeenCalledWith({ position });
        expect(open).not.toHaveBeenCalled();
    });

    it('jumps to the first highlight itself, not to its printed page label', () => {
        // A journal paginated 1043–1058: "1043" is no page number of this file.
        store.set(readerAnnotationsAtom, [highlightItem('HIGHLT01', '1043'), highlightItem('HIGHLT02', '1044')]);
        const host = render(<ReaderAnnotationsButton />);
        click(host);
        expect(open).toHaveBeenCalledWith(204, { annotationID: 'HIGHLT01' });
        expect(navigate).not.toHaveBeenCalledWith({ pageIndex: 1042 });
    });

    it('leaves out a highlight that has a chip of its own', () => {
        store.set(readerAnnotationsAtom, [highlightItem('HIGHLT01', '3'), highlightItem('HIGHLT02', '4')]);
        const host = render(<ReaderAnnotationsButton shownSeparately={new Set(['1-HIGHLT01'])} />);
        expect(host.textContent).toContain('1 Highlight');
        click(host);
        expect(open).toHaveBeenCalledWith(204, { annotationID: 'HIGHLT02' });
    });
});

describe('the passage chip', () => {
    it('goes back to the page the passage is on', () => {
        const host = render(<TextSelectionButton selection={{ text: 'on page fourteen', page: 1, page_index: 13 }} />);
        click(host);
        expect(navigate).toHaveBeenCalledWith({ pageIndex: 13 });
    });

    it('goes to the passage itself when its position is known', () => {
        const position = { pageIndex: 13, rects: [[1, 2, 3, 4]] };
        const host = render(<TextSelectionButton selection={{ text: 'on page fourteen', page: 1, page_index: 13, position } as any} />);
        click(host);
        expect(navigate).toHaveBeenCalledWith({ position });
    });

    it('does not send an EPUB to its first page', () => {
        readerType = 'epub';
        const host = render(<TextSelectionButton selection={{ text: 'in chapter three', page: 1 }} />);
        click(host);
        expect(navigate).not.toHaveBeenCalled();
    });
});
