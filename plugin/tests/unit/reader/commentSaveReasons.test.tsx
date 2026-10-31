// @vitest-environment jsdom
 
/**
 * Saving an answer into its highlight, and saying why when it cannot.
 *
 * Every failure used to read "That highlight no longer exists." — a locked
 * group library, another member's annotation or one embedded in the PDF file
 * each has its own reason, and the card that offered the save says it.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { store } from '../../../react/store';
import { excludedLibrariesAtom, localZoteroLibrariesAtom } from '../../../react/atoms/profile';
import {
    saveCommentToAnnotation,
    saveEntryToAnnotation,
} from '../../../react/utils/selectionChatComment';
import SelectionCommentOfferContent from '../../../react/components/ui/popup/SelectionCommentOfferContent';

const entry = { question: 'what sets R*?', answer: 'the nutrient supply' };
let item: any;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    store.set(localZoteroLibrariesAtom, [
        { library_id: 1, group_id: null, name: 'My Library', is_group: false, type: 'user', type_id: 1, read_only: false },
        { library_id: 2, group_id: 99, name: 'Lab Group', is_group: true, type: 'group', type_id: 2, read_only: false },
    ] as any);
    store.set(excludedLibrariesAtom, []);
    item = {
        libraryID: 1,
        annotationComment: '',
        deleted: false,
        isAnnotation: () => true,
        isEditable: vi.fn(() => true),
        saveTx: vi.fn(async () => undefined),
    };
    (Zotero as any).Items = { getByLibraryAndKey: vi.fn(() => item) };
});

describe('saving an answer into its highlight', () => {
    it('writes it', async () => {
        expect(await saveCommentToAnnotation(1, 'KEY', entry)).toEqual({ saved: true });
        expect(item.annotationComment).toContain('Q: what sets R*?');
    });

    it('says the highlight is gone when it is', async () => {
        (Zotero.Items.getByLibraryAndKey as any) = vi.fn(() => false);
        expect(await saveCommentToAnnotation(1, 'KEY', entry)).toMatchObject({
            saved: false,
            reason: 'missing',
            message: 'That highlight no longer exists.',
        });
    });

    it('says Zotero will not let it be changed, rather than that it is gone', async () => {
        item.isEditable = vi.fn(() => false);
        const result = await saveCommentToAnnotation(1, 'KEY', entry);
        expect(result).toMatchObject({ saved: false, reason: 'read_only' });
        expect((result as any).message).not.toContain('no longer exists');
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('treats an annotation embedded in the PDF file as one that cannot be changed', async () => {
        item.annotationIsExternal = true;
        expect(await saveCommentToAnnotation(1, 'KEY', entry)).toMatchObject({ saved: false, reason: 'read_only' });
    });

    it('does not change a highlight in a library excluded since the question was asked', async () => {
        item.libraryID = 2;
        store.set(excludedLibrariesAtom, [{ type: 'group', group_id: 99 }]);
        expect(await saveCommentToAnnotation(2, 'KEY', entry)).toMatchObject({ saved: false, reason: 'excluded' });
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('passes on what Zotero said when the save itself fails', async () => {
        item.saveTx.mockRejectedValueOnce(new Error('database is locked'));
        expect(await saveCommentToAnnotation(1, 'KEY', entry)).toMatchObject({
            saved: false,
            reason: 'error',
            message: 'Zotero could not save the comment: database is locked',
        });
    });

    it('still answers yes or no for callers that only need that', async () => {
        expect(await saveEntryToAnnotation(1, 'KEY', entry)).toBe(true);
        item.isEditable = vi.fn(() => false);
        expect(await saveEntryToAnnotation(1, 'KEY', entry)).toBe(false);
    });
});

function mountCard(onSave: () => unknown) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
        root.render(React.createElement(SelectionCommentOfferContent, {
            highlightText: 'the R* level',
            pageLabel: '3',
            preview: '— AlphainZ\nQ: q\nA: a',
            onSave: onSave as any,
            onDismiss: () => {},
        }));
    });
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!;
    return { host, save };
}

describe('the offer card', () => {
    it('says why a save failed, in the card', async () => {
        const { host, save } = mountCard(async () => ({
            saved: false,
            reason: 'read_only',
            message: 'Zotero does not let you change that highlight, so the answer could not be added to its comment.',
        }));
        await act(async () => {
            save.click();
        });
        expect(host.textContent).toContain('Zotero does not let you change that highlight');
        expect(host.textContent).not.toContain('no longer exists');
    });

    it('shows nothing extra when the save worked', async () => {
        const { host, save } = mountCard(async () => ({ saved: true }));
        await act(async () => {
            save.click();
        });
        expect(host.querySelector('[role="alert"]')).toBeNull();
    });
});
