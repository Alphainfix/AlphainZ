/**
 * Applying a stored change with no account to acknowledge it to.
 *
 * Applying from a decided card (after Reject, after Undo, or Try Again) writes
 * the change and then acknowledges it to Beaver's server. Run locally there is
 * no session, and that request fails before it is sent. The write has already
 * happened by then: the change must read as applied, with its Undo, and not as
 * a failure whose Try Again would make it a second time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

vi.mock('../../../react/utils/editNoteActions', () => ({
    executeEditNoteOrBatchAction: vi.fn(),
    undoEditNoteOrBatchAction: vi.fn(),
    getUserFacingErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock('../../../react/host/zotero/editNotePreviewLifecycle', () => ({
    dismissActiveEditNotePreview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../react/utils/createItemActions', () => ({
    executeCreateItemActions: vi.fn(),
    undoCreateItemActions: vi.fn(),
}));

vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn(),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { agentActionsService } from '@beaver/agent-core/transport/clients/agentActionsService';
import { executeEditNoteOrBatchAction } from '../../../react/utils/editNoteActions';
import { executeCreateItemActions } from '../../../react/utils/createItemActions';
import { ackAgentActionsAtom, threadAgentActionsAtom } from '../../../react/agents/agentActions';
import { applyAgentActionsAtom } from '../../../react/host/zotero/agentActionExecution';
import { hasFailedUndo } from '../../../react/host/zotero/components/agentActionViewHelpers';

class SessionExpiredError extends Error {}

const rejected = (id: string, actionType = 'edit_note'): AgentAction => ({
    id,
    run_id: 'run-1',
    toolcall_id: `call-${id}`,
    action_type: actionType as any,
    status: 'rejected',
    proposed_data: actionType === 'create_item' ? { item: { title: 'A paper' } } : {},
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentActionsService.acknowledgeActions).mockRejectedValue(
        new SessionExpiredError('User not authenticated'),
    );
});

describe('applying without an account', () => {
    it('records the change as applied when the acknowledgement cannot be sent', async () => {
        const store = createStore();
        const action = rejected('note-1');
        store.set(threadAgentActionsAtom, [action]);
        vi.mocked(executeEditNoteOrBatchAction).mockResolvedValueOnce({ library_id: 1, zotero_key: 'NOTEKEY1' } as any);

        const result = await store.set(applyAgentActionsAtom, { actions: [action], runId: 'run-1' });

        expect(result.fatalError).toBeUndefined();
        expect(result.applied).toEqual(['note-1']);
        const [record] = store.get(threadAgentActionsAtom);
        expect(record.status).toBe('applied');
        expect(record.result_data).toEqual({ library_id: 1, zotero_key: 'NOTEKEY1' });
        // Nothing marks it failed, so there is no Try Again to write it twice.
        expect(hasFailedUndo([record])).toBe(false);
    });

    it('does the same for papers added in a batch', async () => {
        const store = createStore();
        const paper = rejected('paper-1', 'create_item');
        store.set(threadAgentActionsAtom, [paper]);
        vi.mocked(executeCreateItemActions).mockResolvedValueOnce({
            successes: [{ action: paper, result: { library_id: 1, zotero_key: 'ITEMKEY1' } as any }],
            failures: [],
        });

        const result = await store.set(applyAgentActionsAtom, { actions: [paper], runId: 'run-1' });

        expect(result.failed).toEqual([]);
        expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
    });

    it('never throws from the acknowledgement itself', async () => {
        const store = createStore();
        store.set(threadAgentActionsAtom, [rejected('note-1')]);

        await expect(
            store.set(ackAgentActionsAtom, 'run-1', [{ action_id: 'note-1', result_data: { ok: true } }]),
        ).resolves.toBeUndefined();
        expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
    });
});

describe('Try Again after a change that was written', () => {
    it('is read off the record as an undo, not a second apply', () => {
        // An error that kept its result is a change still in the library.
        expect(hasFailedUndo([{ ...rejected('a'), status: 'error', result_data: { library_id: 1 } } as any])).toBe(true);
        expect(hasFailedUndo([{ ...rejected('a'), status: 'error' } as any])).toBe(false);
    });
});
