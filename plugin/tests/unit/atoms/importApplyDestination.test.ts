/**
 * An approved paper goes where its card showed.
 *
 * The apply path resolves the destination by the same rule, from the same
 * choices, as the card's "Add to" picker: the pick made for this run, then the
 * folder the proposal named — in the library that holds it — then Zotero's
 * selection when it is one of the choices, then My Library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));

import { writeTools } from '../../../react/atoms/executeLocalRun';
import { chooseImportDestinationAtom, importDestinationAtom } from '../../../react/atoms/importDestination';
import { localZoteroLibrariesAtom } from '../../../react/atoms/profile';
import { pendingApprovalsAtom, threadAgentActionsAtom } from '../../../react/agents/agentActions';
import { resolveAllLocalApprovals, resolveLocalApproval } from '../../../react/utils/localApprovals';
import { store } from '../../../react/store';

const zotero = globalThis as any;
const original = {
    Libraries: zotero.Zotero.Libraries,
    Collections: zotero.Zotero.Collections,
    pane: zotero.Zotero.getActiveZoteroPane,
};

afterEach(() => {
    zotero.Zotero.Libraries = original.Libraries;
    zotero.Zotero.Collections = original.Collections;
    zotero.Zotero.getActiveZoteroPane = original.pane;
});

function harness(runId: string) {
    const executed: any[] = [];
    const found = new Map<string, any>([
        ['W1', { id: 'W1', title: 'Waggle dances', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
    ]);
    const tools = writeTools({
        agent_action_execute: { handle: async (payload: any) => { executed.push(payload); return { success: true, result_data: {} }; } },
    }, store.set, found, runId, () => false, `thread-${runId}`);
    return { tools, executed };
}

async function proposeAndApprove(runId: string, args: Record<string, unknown>) {
    const { tools, executed } = harness(runId);
    await tools.add_papers_to_library({ openalex_ids: ['W1'], ...args }, { toolCallId: `call-${runId}` });
    const [card] = [...store.get(pendingApprovalsAtom).values()].filter((approval) => approval.runId === runId);
    resolveLocalApproval(card.actionId, true);
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    return executed[0].action_data;
}

beforeEach(async () => {
    zotero.Zotero.AlphainZ = { data: { env: 'test' } };
    zotero.Zotero.Libraries = {
        userLibraryID: 1,
        getAll: () => [
            { libraryID: 1, name: 'My Library', editable: true },
            { libraryID: 2, name: 'Lab group', editable: true },
            { libraryID: 3, name: 'Read-only group', editable: false },
        ],
    };
    zotero.Zotero.Collections = {
        getByLibrary: (libraryId: number) => (libraryId === 1
            ? [{ id: 10, key: 'AAAA1111', name: 'Project A' }]
            : libraryId === 2 ? [{ id: 20, key: 'GGGG2222', name: 'Lab folder' }] : []),
        getByParent: () => [],
    };
    zotero.Zotero.getActiveZoteroPane = () => ({ getSelectedLibraryID: () => 3, getSelectedCollection: () => null });
    resolveAllLocalApprovals('test reset');
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.set(pendingApprovalsAtom, new Map());
    store.set(threadAgentActionsAtom, []);
    store.set(importDestinationAtom, {});
    store.set(localZoteroLibrariesAtom, [
        { library_id: 1, is_group: false, group_id: null, name: 'My Library' } as any,
        { library_id: 2, is_group: true, group_id: 22, name: 'Lab group' } as any,
        { library_id: 3, is_group: true, group_id: 33, name: 'Read-only group' } as any,
    ]);
});

describe('an approved paper', () => {
    it('goes to the folder the proposal named, in the library that holds it', async () => {
        const data = await proposeAndApprove('run-1', { collection_key: 'GGGG2222' });
        expect(data.library_id).toBe(2);
        expect(data.collection_keys).toEqual(['GGGG2222']);
    });

    it('goes to My Library, not a read-only library that happens to be selected', async () => {
        const data = await proposeAndApprove('run-1', {});
        expect(data.library_id).toBe(1);
        expect(data.collection_keys).toEqual([]);
    });

    it('follows the pick made on its own run’s card, and no other run’s', async () => {
        store.set(chooseImportDestinationAtom, { runId: 'run-old', destination: { libraryId: 1, collectionKey: 'AAAA1111' } });
        const unaffected = await proposeAndApprove('run-new', { collection_key: 'GGGG2222' });
        expect(unaffected).toMatchObject({ library_id: 2, collection_keys: ['GGGG2222'] });

        store.set(chooseImportDestinationAtom, { runId: 'run-mine', destination: { libraryId: 1, collectionKey: 'AAAA1111' } });
        const picked = await proposeAndApprove('run-mine', { collection_key: 'GGGG2222' });
        expect(picked).toMatchObject({ library_id: 1, collection_keys: ['AAAA1111'] });
    });
});
