// @vitest-environment jsdom
 
/**
 * The "Add to" picker on a card proposing papers.
 *
 * It lists only where the agent may put a paper, shows exactly where Apply will
 * put it, and keeps a pick for the run it was made in: last run's folder must
 * not override the folder this run's proposal names.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const zotero = globalThis as any;
const original = { Libraries: zotero.Zotero.Libraries, Collections: zotero.Zotero.Collections, pane: zotero.Zotero.getActiveZoteroPane };

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    zotero.Zotero.AlphainZ = { data: { env: 'test' } };
    zotero.Zotero.Libraries = {
        ...original.Libraries,
        userLibraryID: 1,
        getAll: () => [
            { libraryID: 1, name: 'My Library', editable: true },
            { libraryID: 2, name: 'Excluded group', editable: true },
            { libraryID: 3, name: 'Read-only group', editable: false },
        ],
    };
    zotero.Zotero.Collections = {
        getByLibrary: (libraryId: number) => (libraryId === 1
            ? [{ id: 10, key: 'AAAA1111', name: 'Project A' }, { id: 11, key: 'BBBB2222', name: 'Project B' }]
            : libraryId === 2 ? [{ id: 20, key: 'GGGG2222', name: 'Group folder' }] : []),
        getByParent: () => [],
    };
    // The read-only group library is what is selected in Zotero.
    zotero.Zotero.getActiveZoteroPane = () => ({ getSelectedLibraryID: () => 3, getSelectedCollection: () => null });
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    zotero.Zotero.Libraries = original.Libraries;
    zotero.Zotero.Collections = original.Collections;
    zotero.Zotero.getActiveZoteroPane = original.pane;
});

async function mount(runId: string, proposal: Record<string, unknown>) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const { localZoteroLibrariesAtom } = await import('../../../react/atoms/profile');
    const { CreateItemsPreview } = await import('../../../react/host/zotero/components/CreateItemsPreview');
    // Library 2 is excluded from AlphainZ: it is not among the local libraries the agent may use.
    store.set(localZoteroLibrariesAtom, [
        { library_id: 1, is_group: false, group_id: null, name: 'My Library' } as any,
        { library_id: 3, is_group: true, group_id: 33, name: 'Read-only group' } as any,
    ]);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, React.createElement(CreateItemsPreview, {
            actions: [{
                id: `${runId}-paper`,
                run_id: runId,
                toolcall_id: `${runId}-call`,
                action_type: 'create_item',
                status: 'pending',
                proposed_data: { item: { title: 'A paper' }, ...proposal },
            } as any],
            status: 'awaiting',
            runId,
        })));
    });
    return store;
}

const select = () => host!.querySelector('select[aria-label="Collection to add these papers to"]') as HTMLSelectElement;
const optionLabels = () => Array.from(select().options).map((option) => option.textContent?.trim());

describe('the Add to picker', () => {
    it('offers no excluded or read-only library', async () => {
        await mount('run-a', {});
        expect(optionLabels()).toEqual(['My Library', 'Project A', 'Project B']);
    });

    it('shows where Apply will put the paper when Zotero has a library it cannot use selected', async () => {
        await mount('run-a', {});
        // Not the first option by accident: the value names My Library's root.
        expect(select().value).toBe('1:');
    });

    it('keeps a pick for its own run only', async () => {
        const store = await mount('run-a', { collection_keys: ['AAAA1111'] });
        expect(host!.textContent).toContain('Add to (suggested)');
        await act(async () => {
            select().value = '1:BBBB2222';
            select().dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(select().value).toBe('1:BBBB2222');
        act(() => root?.unmount());
        host?.remove();

        // The next run proposes Project A again; last run's pick does not override it.
        await mount('run-b', { collection_keys: ['AAAA1111'] });
        expect(select().value).toBe('1:AAAA1111');
        expect(host!.textContent).toContain('Add to (suggested)');
        void store;
    });
});
