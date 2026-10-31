/**
 * Deleting a conversation forever takes its undecided proposals with it.
 *
 * The chat and its records are erased, so a card left waiting would stay
 * listed under a chat that no longer exists, and its Open would lead to an
 * empty one. Proposals of other conversations are left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/conversationSync', () => ({
    conversationSyncMode: () => 'off',
    getConversationBackend: () => null,
}));
vi.mock('../../../react/utils/settingsSyncClient', () => ({ importSettingsNow: vi.fn(async () => false) }));

import { store } from '../../../react/store';
import { addPendingApprovalAtom, pendingApprovalsAtom } from '../../../react/agents/agentActions';
import { awaitApproval } from '../../../react/utils/localApprovals';
import { localPurgeThread } from '../../../react/atoms/loadLocalThreads';

function propose(actionId: string, threadId: string) {
    let outcome: any = null;
    void awaitApproval(actionId, `call-${actionId}`, 'highlight_annotation').then((result) => { outcome = result; });
    store.set(addPendingApprovalAtom, {
        event: 'deferred_approval_request',
        action_id: actionId,
        toolcall_id: `call-${actionId}`,
        action_type: 'highlight_annotation',
        action_data: {},
    } as any, { runId: `run-${threadId}`, threadId } as any);
    return { outcome: () => outcome };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    store.set(pendingApprovalsAtom, new Map());
    (Zotero as any).AlphainZ = {
        db: {
            addThreadTombstone: vi.fn(async () => {}),
            deleteThread: vi.fn(async () => {}),
        },
    };
});

describe('deleting a conversation forever', () => {
    it('settles its undecided proposals and leaves another chat\'s waiting', async () => {
        const gone = propose('in-erased-chat', 'thread-erased');
        const kept = propose('in-other-chat', 'thread-other');

        await localPurgeThread('thread-erased');
        await settle();

        expect(store.get(pendingApprovalsAtom).has('in-erased-chat')).toBe(false);
        expect(gone.outcome()).toMatchObject({ approved: false, settled: true });
        expect(store.get(pendingApprovalsAtom).has('in-other-chat')).toBe(true);
        expect(kept.outcome()).toBeNull();
    });
});
