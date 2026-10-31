/**
 * An asked proposal leaves a record from the moment its card appears.
 *
 * The card's waiter lives in memory, so without a record a proposal nobody had
 * decided yet was gone after a restart. Recorded as pending, it is stored with
 * its run and comes back with its own Apply and Reject. The decision then
 * supersedes that record — one record per proposal — and while the decision
 * is being carried out the record is claimed, so no other surface offers to
 * apply it a second time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
// No account to acknowledge anything to, as when the model runs locally.
vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn().mockRejectedValue(new Error('User not authenticated')),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { writeTools } from '../../../react/atoms/executeLocalRun';
import {
    ackAgentActionsAtom,
    answeredApprovalIdsAtom,
    inFlightAgentActionIdsAtom,
    pendingApprovalsAtom,
    threadAgentActionsAtom,
} from '../../../react/agents/agentActions';
import { resolveAllLocalApprovals, resolveLocalApproval } from '../../../react/utils/localApprovals';
import { buildReviewRows } from '../../../react/host/zotero/components/reviewChangeRows';
import { store } from '../../../react/store';

const PAGE_TEXT = 'The waggle dance tells nestmates how far away the food source lies.';

function makeProvider(execute: (payload: any) => any = () => ({ success: true, result_data: {} })) {
    return {
        zotero_document_request: {
            handle: async () => ({
                result: {
                    document: {
                        pages: [
                            {
                                index: 0,
                                label: '1',
                                items: [{ sentences: [{ text: PAGE_TEXT, bboxes: [[10, 20, 300, 32]] }] }],
                            },
                        ],
                    },
                },
            }),
        },
        agent_action_execute: { handle: async (payload: any) => execute(payload) },
    };
}

function tools(execute?: (payload: any) => any) {
    return writeTools(makeProvider(execute), store.set, new Map(), 'run-1', () => false, 'thread-1');
}

const records = () => store.get(threadAgentActionsAtom);

beforeEach(async () => {
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    (Zotero as any).Libraries = { ...((Zotero as any).Libraries ?? {}), userLibraryID: 1 };
    (Zotero as any).Items = {
        ...((Zotero as any).Items ?? {}),
        getByLibraryAndKeyAsync: async (libraryID: number, key: string) => ({
            libraryID,
            key,
            isAttachment: () => true,
            isPDFAttachment: () => true,
        }),
    };
    resolveAllLocalApprovals('test reset');
    // Let what an earlier test left waiting record its outcome before the
    // atoms are reset under it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.set(threadAgentActionsAtom, []);
    store.set(pendingApprovalsAtom, new Map());
    store.set(inFlightAgentActionIdsAtom, new Set<string>());
    store.set(answeredApprovalIdsAtom, new Set<string>());
    store.set(currentThreadNameAtom, 'Colour-code the bee paper');
});

describe('an asked proposal', () => {
    it('is recorded as pending, under its card’s own id, when the card appears', async () => {
        await tools().create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });

        const [card] = [...store.get(pendingApprovalsAtom).values()];
        expect(records()).toHaveLength(1);
        expect(records()[0]).toMatchObject({
            id: card.actionId,
            run_id: 'run-1',
            toolcall_id: 'call-1',
            status: 'pending',
            action_type: 'create_highlight_annotations',
        });
        // What reopening the thread needs to show the proposal again.
        expect((records()[0].proposed_data as any).items[0].text).toBe(PAGE_TEXT);
    });

    it('carries the run and conversation it belongs to', async () => {
        await tools().create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });

        const [card] = [...store.get(pendingApprovalsAtom).values()];
        expect(card).toMatchObject({
            runId: 'run-1',
            threadId: 'thread-1',
            threadName: 'Colour-code the bee paper',
        });
    });

    it('is left to the card while the card is up, not listed for review too', async () => {
        await tools().create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });

        const live = new Set(store.get(pendingApprovalsAtom).keys());
        expect(buildReviewRows(records(), { liveApprovalActionIds: live })).toHaveLength(0);
        // With no card behind it — after a restart — it is the review card's.
        expect(buildReviewRows(records())).toHaveLength(1);
    });

    it('is superseded by the decision, not joined by a second record', async () => {
        await tools().create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });
        const [card] = [...store.get(pendingApprovalsAtom).values()];

        resolveLocalApproval(card.actionId, true);
        await vi.waitFor(() => expect(records()[0]?.status).toBe('applied'));

        expect(records()).toHaveLength(1);
        expect(records()[0].id).toBe(card.actionId);
        expect(store.get(pendingApprovalsAtom).size).toBe(0);
    });

    it('keeps its decision when another conversation is open when it lands', async () => {
        await tools().create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });
        const [card] = [...store.get(pendingApprovalsAtom).values()];

        // Another chat is opened: its own actions replace these on screen.
        store.set(threadAgentActionsAtom, []);
        resolveLocalApproval(card.actionId, false);
        await vi.waitFor(() => expect(records()).toHaveLength(1));

        // The whole record arrives, so the saving path can merge it into its
        // run's stored copy by id.
        expect(records()[0]).toMatchObject({ id: card.actionId, status: 'rejected', run_id: 'run-1' });
        expect((records()[0].proposed_data as any).items[0].text).toBe(PAGE_TEXT);
    });

    it('is claimed from the moment it is approved until its write is recorded', async () => {
        let finish!: () => void;
        const written = new Promise<void>((resolve) => { finish = resolve; });
        await tools(async () => {
            await written;
            return { success: true, result_data: {} };
        }).create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });
        const [card] = [...store.get(pendingApprovalsAtom).values()];

        resolveLocalApproval(card.actionId, true);
        // Synchronously: before anything redraws, no surface may offer it again.
        expect(store.get(inFlightAgentActionIdsAtom).has(card.actionId)).toBe(true);
        expect(records()[0].status).toBe('pending');
        // The card is gone, but the review card still leaves it alone while
        // the write runs, rather than listing it as needing review.
        store.set(pendingApprovalsAtom, new Map());
        const owned = new Set([...store.get(pendingApprovalsAtom).keys(), ...store.get(answeredApprovalIdsAtom)]);
        expect(buildReviewRows(records(), { liveApprovalActionIds: owned })).toHaveLength(0);

        finish();
        await vi.waitFor(() => expect(records()[0].status).toBe('applied'));
        expect(store.get(inFlightAgentActionIdsAtom).has(card.actionId)).toBe(false);
        expect(store.get(answeredApprovalIdsAtom).has(card.actionId)).toBe(false);
    });

    it('is settled, not applied again, when the change is made some other way', async () => {
        // A paper the card proposes can also be imported from its reference in
        // the answer, which records it as applied.
        const executed: any[] = [];
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'Waggle dances', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const paperTools = writeTools(
            makeProvider((payload) => { executed.push(payload); return { success: true, result_data: {} }; }),
            store.set,
            found,
            'run-1',
            () => false,
            'thread-1',
        );
        await paperTools.add_papers_to_library({ openalex_ids: ['W1'] }, { toolCallId: 'call-papers' });
        const [card] = [...store.get(pendingApprovalsAtom).values()];

        await store.set(ackAgentActionsAtom, 'run-1', [{ action_id: card.actionId, result_data: { library_id: 1, zotero_key: 'ITEM0001' } as any }]);
        await new Promise((resolve) => setTimeout(resolve, 10));

        // No card left asking, nothing written twice, and the record stays applied.
        expect(store.get(pendingApprovalsAtom).size).toBe(0);
        expect(executed).toHaveLength(0);
        expect(records()).toHaveLength(1);
        expect(records()[0]).toMatchObject({ id: card.actionId, status: 'applied' });
    });
});
