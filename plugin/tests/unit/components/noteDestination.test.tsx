// @vitest-environment jsdom
 
/**
 * A proposed note says where it will go.
 *
 * A note written for a paper is filed as that paper's child, which the note's
 * own text does not say; the card names the paper before the note is
 * approved, and a note with no paper says which library it lands in.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/zoteroUtils', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    shortItemTitle: vi.fn(async () => 'Valcourt et al. 2017'),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const zotero = globalThis as any;
const original = { Items: zotero.Zotero.Items, Libraries: zotero.Zotero.Libraries };

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    zotero.Zotero.AlphainZ = { data: { env: 'test' } };
    zotero.Zotero.Items = {
        ...original.Items,
        getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) => (key === 'PAPER001'
            ? { libraryID, key, isTopLevelItem: () => true, isRegularItem: () => true }
            : false)),
    };
    zotero.Zotero.Libraries = {
        ...original.Libraries,
        userLibraryID: 1,
        get: (id: number) => (id === 1 ? { libraryID: 1, name: 'My Library' } : false),
    };
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    zotero.Zotero.Items = original.Items;
    zotero.Zotero.Libraries = original.Libraries;
});

async function mount(actionData: Record<string, unknown>, status: string = 'awaiting', resultData?: Record<string, unknown>) {
    const { ActionPreview } = await import('../../../react/host/zotero/components/ActionPreview');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(ActionPreview, {
            toolName: 'create_note',
            previewData: { actionType: 'create_note', actionData: { content: 'The tunnel sets the dance.', ...actionData }, resultData },
            status: status as any,
        }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return host;
}

const destination = () => host!.querySelector('[data-note-destination]')?.textContent ?? null;

describe('a proposed note', () => {
    it('names the paper it will be filed under', async () => {
        await mount({ parent_key: 'PAPER001', library_id: 1 });
        expect(destination()).toBe('Adding to: Valcourt et al. 2017');
    });

    it('names the paper from the id the model gave, before validation resolved it', async () => {
        await mount({ parent_item_id: '1-PAPER001' });
        expect(destination()).toBe('Adding to: Valcourt et al. 2017');
    });

    it('says where it went once saved', async () => {
        await mount({ parent_key: 'PAPER001', library_id: 1 }, 'applied', { parent_key: 'PAPER001', library_id: 1, zotero_key: 'NOTE0001' });
        expect(destination()).toBe('Added to: Valcourt et al. 2017');
    });

    it('says which library a note without a paper lands in', async () => {
        await mount({ library_id: 1 });
        expect(destination()).toBe('A standalone note in My Library');
    });

    // What validation returns when the id names a standalone PDF, which
    // cannot hold child notes: no paper, the note related to the PDF instead.
    const standalone = { parent_item_id: '1-PDF00001', parent_key: null, related_item_key: 'PDF00001', library_id: 1 };
    const standalonePdfInLibrary = () => {
        zotero.Zotero.Items.getByLibraryAndKeyAsync.mockImplementation(async (libraryID: number, key: string) =>
            (key === 'PDF00001' ? { libraryID, key, isTopLevelItem: () => true, isRegularItem: () => false } : false));
    };

    it('does not claim to file it under a standalone PDF the model named', async () => {
        standalonePdfInLibrary();
        await mount(standalone);
        expect(destination()).toBe('A standalone note in My Library');
    });

    it('says it was saved on its own, not under that PDF, once saved', async () => {
        standalonePdfInLibrary();
        await mount(standalone, 'applied', { library_id: 1, zotero_key: 'NOTE0002', related_item_key: 'PDF00001' });
        expect(destination()).toBe('Saved as a standalone note in My Library');
    });
});
