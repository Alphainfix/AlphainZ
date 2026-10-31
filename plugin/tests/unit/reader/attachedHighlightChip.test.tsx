// @vitest-environment jsdom
 
/**
 * A highlight the user chose Explain or Ask on is shown as its own chip.
 *
 * It is also one of the open paper's highlights, which share one "N
 * Highlights" chip; folded into that one, the composer gave no sign of which
 * highlight the question was about.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/components/ui/menus/AddSourcesMenu', () => ({ default: () => null }));
vi.mock('../../../react/components/input/MessageItemButton', () => ({
    MessageItemButton: ({ item }: { item: any }) => <span data-chip={item.key} />,
}));
vi.mock('../../../react/components/input/ReaderAnnotationsButton', () => ({
    ReaderAnnotationsButton: ({ shownSeparately }: { shownSeparately?: Set<string> }) => (
        <span data-highlights={[...(shownSeparately ?? [])].join(',')} />
    ),
}));
vi.mock('../../../react/components/input/TextSelectionButton', () => ({ TextSelectionButton: () => null }));

import { store } from '../../../react/store';
import {
    currentMessageItemsAtom,
    currentReaderAttachmentAtom,
    readerAnnotationsAtom,
} from '../../../react/atoms/messageComposition';
import MessageAttachmentDisplay from '../../../react/components/messages/MessageAttachmentDisplay';

function annotation(key: string) {
    return { key, libraryID: 1, isAnnotation: () => true } as any;
}

function renderRow(): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <Provider store={store}>
                <MessageAttachmentDisplay
                    isAddAttachmentMenuOpen={false}
                    menuPosition={{ x: 0, y: 0 }}
                    addSourcesSearchQuery=""
                    addSourcesQuerySource={'menu' as any}
                    onAddSourcesQueryChange={() => {}}
                    onOpenAddSourcesMenu={() => {}}
                    onDismissAddSourcesMenu={() => {}}
                    onCommitAddSourcesMenu={() => {}}
                    onResetAddSourcesQuery={() => {}}
                />
            </Provider>,
        );
    });
    return host;
}

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).Libraries = { get: vi.fn(() => null) };
    store.set(currentReaderAttachmentAtom, null);
});

describe('the composer\'s attachment row', () => {
    it('shows the highlight the question is about as a chip of its own', () => {
        const clicked = annotation('HIGHLT01');
        store.set(readerAnnotationsAtom, [clicked, annotation('HIGHLT02'), annotation('HIGHLT03')]);
        store.set(currentMessageItemsAtom, [clicked]);

        const host = renderRow();

        expect(host.querySelector('[data-chip="HIGHLT01"]')).not.toBeNull();
        // And the paper's set is told, so it does not count that one again.
        expect(host.querySelector('[data-highlights]')?.getAttribute('data-highlights')).toBe('1-HIGHLT01');
    });

    it('keeps the rest of the paper\'s highlights to the one chip', () => {
        store.set(readerAnnotationsAtom, [annotation('HIGHLT02'), annotation('HIGHLT03')]);
        store.set(currentMessageItemsAtom, []);
        const host = renderRow();
        expect(host.querySelector('[data-chip]')).toBeNull();
    });
});
