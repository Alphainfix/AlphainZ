/**
 * Where a paper applied from its record goes.
 *
 * A paper approved on its card is written where the card's "Add to" picker
 * points. A paper applied from its record instead — the review card's Apply,
 * a card restored after a restart, a paper added on its own row — follows the
 * same rule: the pick made for its run, then the folder the proposal named,
 * then Zotero's selection when the paper may go there, then My Library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

vi.mock('../../../react/utils/createItemActions', () => ({
    executeCreateItemActions: vi.fn(async (actions: any[]) => ({
        successes: actions.map((action) => ({ action, result: { library_id: 1, zotero_key: `K${action.id}` } })),
        failures: [],
    })),
    undoCreateItemActions: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn().mockResolvedValue({ success: true, errors: [] }),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { executeCreateItemActions } from '../../../react/utils/createItemActions';
import { threadAgentActionsAtom } from '../../../react/agents/agentActions';
import { localZoteroLibrariesAtom } from '../../../react/atoms/profile';
import { chooseImportDestinationAtom } from '../../../react/atoms/importDestination';
import { applyAgentActionsAtom } from '../../../react/host/zotero/agentActionExecution';

const zotero = globalThis as any;
const original = {
    Libraries: zotero.Zotero.Libraries,
    Collections: zotero.Zotero.Collections,
    Groups: zotero.Zotero.Groups,
    pane: zotero.Zotero.getActiveZoteroPane,
};

beforeEach(() => {
    vi.clearAllMocks();
    zotero.Zotero.Libraries = {
        ...original.Libraries,
        userLibraryID: 1,
        get: (id: number) => ({ libraryID: id, name: id === 1 ? 'My Library' : 'Lab group', editable: true }),
        getAll: () => [
            { libraryID: 1, name: 'My Library', editable: true },
            { libraryID: 5, name: 'Lab group', editable: true },
        ],
    };
    zotero.Zotero.Groups = { ...original.Groups, getGroupIDFromLibraryID: (id: number) => (id === 5 ? 55 : false) };
    zotero.Zotero.Collections = {
        getByLibrary: (libraryId: number) => (libraryId === 1
            ? [{ id: 10, key: 'AAAA1111', name: 'Project A' }]
            : libraryId === 5 ? [{ id: 50, key: 'GGGG5555', name: 'Pollinators' }] : []),
        getByParent: () => [],
    };
    zotero.Zotero.getActiveZoteroPane = () => ({ getSelectedLibraryID: () => 1, getSelectedCollection: () => null });
});

afterEach(() => {
    zotero.Zotero.Libraries = original.Libraries;
    zotero.Zotero.Collections = original.Collections;
    zotero.Zotero.Groups = original.Groups;
    zotero.Zotero.getActiveZoteroPane = original.pane;
});

const paper = (proposed: Record<string, unknown> = {}): AgentAction => ({
    id: 'paper-1',
    run_id: 'run-1',
    toolcall_id: 'call-papers',
    action_type: 'create_item',
    status: 'pending',
    proposed_data: { item: { title: 'Waggle dances' }, ...proposed },
} as AgentAction);

function storeWith(action: AgentAction, libraries = [1, 5]) {
    const store = createStore();
    store.set(localZoteroLibrariesAtom, libraries.map((id) => ({
        library_id: id,
        is_group: id !== 1,
        group_id: id === 1 ? null : 55,
        name: id === 1 ? 'My Library' : 'Lab group',
    })) as any);
    store.set(threadAgentActionsAtom, [action]);
    return store;
}

const writtenData = () => vi.mocked(executeCreateItemActions).mock.calls[0][0][0].proposed_data as Record<string, any>;

describe('a paper applied from its record', () => {
    it('goes where the picker for its run points', async () => {
        const action = paper();
        const store = storeWith(action);
        store.set(chooseImportDestinationAtom, { runId: 'run-1', destination: { libraryId: 5, collectionKey: 'GGGG5555' } });

        await store.set(applyAgentActionsAtom, { actions: [action], runId: 'run-1' });

        expect(writtenData()).toMatchObject({ library_id: 5, library_ref: 'g55', collection_keys: ['GGGG5555'] });
        // The record keeps what was proposed; only the write is filed.
        expect((store.get(threadAgentActionsAtom)[0].proposed_data as any).collection_keys).toBeUndefined();
        expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
    });

    it('goes to the folder the proposal named, in the library that holds it', async () => {
        const action = paper({ collection_keys: ['GGGG5555'] });
        await storeWith(action).set(applyAgentActionsAtom, { actions: [action], runId: 'run-1' });

        expect(writtenData()).toMatchObject({ library_id: 5, collection_keys: ['GGGG5555'] });
    });

    it('ignores a pick made for another run', async () => {
        const action = paper();
        const store = storeWith(action);
        store.set(chooseImportDestinationAtom, { runId: 'run-other', destination: { libraryId: 5, collectionKey: 'GGGG5555' } });

        await store.set(applyAgentActionsAtom, { actions: [action], runId: 'run-1' });

        // Zotero's selection: My Library, no collection.
        expect(writtenData()).toMatchObject({ library_id: 1, library_ref: 'u', collection_keys: [] });
    });

    it('is written as proposed when there is nowhere it may go', async () => {
        const action = paper({ collection_keys: ['AAAA1111'] });
        await storeWith(action, []).set(applyAgentActionsAtom, { actions: [action], runId: 'run-1' });

        expect(writtenData()).toEqual({ item: { title: 'Waggle dances' }, collection_keys: ['AAAA1111'] });
    });
});
