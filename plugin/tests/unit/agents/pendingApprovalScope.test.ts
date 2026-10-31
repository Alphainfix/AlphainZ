/**
 * Whose proposals are whose.
 *
 * A proposal outlives the run that made it: it waits on its card across later
 * messages and while other conversations are open. Everything that lists
 * proposals — the bar above the composer, Approve All, the composer itself —
 * has to know which ones belong to the conversation on screen, and nothing
 * but the user may decline one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));

import { activeRunAtom, currentThreadIdAtom, isLoadingThreadAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    addPendingApprovalAtom,
    clearAllPendingApprovalsAtom,
    partitionPendingApprovals,
    pendingApprovalsAtom,
    pendingApprovalsByLocationAtom,
    pendingApprovalsForToolcall,
    type ScopedPendingApproval,
} from '../../../react/agents/agentActions';
import {
    awaitApproval,
    isLocalApprovalWaiting,
    resolveAllLocalApprovals,
} from '../../../react/utils/localApprovals';

const approval = (id: string, scope: Partial<ScopedPendingApproval> = {}): ScopedPendingApproval => ({
    actionId: id,
    toolcallId: `call-${id}`,
    actionType: 'create_highlight_annotations' as any,
    actionData: {},
    ...scope,
});

const request = (id: string, toolcallId = `call-${id}`) => ({
    event: 'deferred_approval_request',
    action_id: id,
    toolcall_id: toolcallId,
    action_type: 'create_highlight_annotations',
    action_data: {},
}) as any;

beforeEach(() => {
    resolveAllLocalApprovals('test reset');
});

describe('partitionPendingApprovals', () => {
    it("puts a proposal with the conversation whose run made it", () => {
        const { here, elsewhere } = partitionPendingApprovals(
            [
                approval('a', { runId: 'run-open', threadId: 'thread-open' }),
                approval('b', { runId: 'run-old', threadId: 'thread-other' }),
            ],
            new Set(['run-open']),
            'thread-open',
            false,
        );
        expect(here.map((a) => a.actionId)).toEqual(['a']);
        expect(elsewhere.map((a) => a.actionId)).toEqual(['b']);
    });

    it('counts a proposal as here while its conversation is still loading its runs', () => {
        const { here } = partitionPendingApprovals(
            [approval('a', { runId: 'run-1', threadId: 'thread-open' })],
            new Set(),
            'thread-open',
            true,
        );
        expect(here).toHaveLength(1);
    });

    it('lists nowhere a proposal of the open chat whose run is not in it once it has loaded', () => {
        // The chat was deleted forever and reopened: its runs are gone, and
        // nothing on screen could show what Approve All would change.
        const { here, elsewhere } = partitionPendingApprovals(
            [approval('a', { runId: 'run-gone', threadId: 'thread-open' })],
            new Set(['run-other']),
            'thread-open',
            false,
        );
        expect(here).toHaveLength(0);
        expect(elsewhere).toHaveLength(0);
    });

    it('sends every earlier proposal elsewhere from a brand-new chat', () => {
        // No thread yet, no runs: the previous chat's cards are not on screen.
        const { here, elsewhere } = partitionPendingApprovals(
            [approval('a', { runId: 'run-1', threadId: 'thread-1' })],
            new Set(),
            null,
            false,
        );
        expect(here).toHaveLength(0);
        expect(elsewhere).toHaveLength(1);
    });

    it('keeps an approval without a run with the conversation on screen', () => {
        const { here } = partitionPendingApprovals([approval('socket')], new Set(), null, false);
        expect(here).toHaveLength(1);
    });
});

describe('pendingApprovalsByLocationAtom', () => {
    it('follows the open conversation', () => {
        const store = createStore();
        store.set(addPendingApprovalAtom, request('a'), { runId: 'run-1', threadId: 'thread-1', threadName: 'Honeybee odometry' });
        store.set(addPendingApprovalAtom, request('b'), { runId: 'run-2', threadId: 'thread-2' });

        store.set(currentThreadIdAtom, 'thread-1');
        store.set(threadRunsAtom, [{ id: 'run-1', thread_id: 'thread-1', status: 'completed' } as any]);
        let split = store.get(pendingApprovalsByLocationAtom);
        expect(split.here.map((a) => a.actionId)).toEqual(['a']);
        expect(split.elsewhere.map((a) => a.actionId)).toEqual(['b']);
        // The scope rides on the approval, name included.
        expect(split.here[0]).toMatchObject({ runId: 'run-1', threadId: 'thread-1', threadName: 'Honeybee odometry' });

        // New chat: nothing of either is here.
        store.set(currentThreadIdAtom, null);
        store.set(threadRunsAtom, []);
        split = store.get(pendingApprovalsByLocationAtom);
        expect(split.here).toHaveLength(0);
        expect(split.elsewhere).toHaveLength(2);

        // The active run's own proposals are here while it streams.
        store.set(activeRunAtom, { id: 'run-2', thread_id: null, status: 'in_progress' } as any);
        split = store.get(pendingApprovalsByLocationAtom);
        expect(split.here.map((a) => a.actionId)).toEqual(['b']);
    });

    it('counts the opened chat’s proposals as here only until its runs are on screen', () => {
        const store = createStore();
        store.set(addPendingApprovalAtom, request('a'), { runId: 'run-1', threadId: 'thread-1' });

        // Opening the chat: its runs are still being read.
        store.set(currentThreadIdAtom, 'thread-1');
        store.set(threadRunsAtom, []);
        store.set(isLoadingThreadAtom, true);
        expect(store.get(pendingApprovalsByLocationAtom).here.map((a) => a.actionId)).toEqual(['a']);

        // Read, and the run that made it is not among them.
        store.set(isLoadingThreadAtom, false);
        const split = store.get(pendingApprovalsByLocationAtom);
        expect(split.here).toHaveLength(0);
        expect(split.elsewhere).toHaveLength(0);
    });
});

describe('pendingApprovalsForToolcall', () => {
    it('returns every approval of one call, not just the first', () => {
        // Adding three papers proposes one approval per paper under one call.
        const approvals = [
            approval('p1', { toolcallId: 'call-papers' }),
            approval('p2', { toolcallId: 'call-papers' }),
            approval('other', { toolcallId: 'call-other' }),
            approval('p3', { toolcallId: 'call-papers' }),
        ];
        expect(pendingApprovalsForToolcall(approvals, 'call-papers').map((a) => a.actionId))
            .toEqual(['p1', 'p2', 'p3']);
    });
});

describe('clearAllPendingApprovalsAtom', () => {
    it('declines no local proposal and keeps its card', async () => {
        const store = createStore();
        const decision = awaitApproval('local-1', 'call-1', 'create_highlight_annotations');
        store.set(addPendingApprovalAtom, request('local-1', 'call-1'), { runId: 'run-1', threadId: 'thread-1' });
        store.set(addPendingApprovalAtom, request('socket-1', 'call-2'));

        store.set(clearAllPendingApprovalsAtom);

        // The socket's approval died with the socket; the proposal is still the user's.
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual(['local-1']);
        expect(isLocalApprovalWaiting('local-1')).toBe(true);
        const settled = await Promise.race([
            decision.then(() => 'answered'),
            new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20)),
        ]);
        expect(settled).toBe('still waiting');
    });
});
