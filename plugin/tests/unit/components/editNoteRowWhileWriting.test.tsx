// @vitest-environment jsdom
 
/**
 * A note edit approved on its row, while the edit is being written.
 *
 * A local proposal's tool call returns the moment the card appears, and the
 * proposal is recorded as pending straight away. Approving it claims the
 * write until the outcome is recorded. Meanwhile the row has to keep waiting
 * on it — spinner on Apply — instead of reading "returned and still pending"
 * as an approval that never arrived and handing back its controls.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logged } = vi.hoisted(() => ({ logged: [] as string[] }));

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn((message: unknown) => { logged.push(String(message)); }),
}));
vi.mock('../../../react/utils/diffPreviewCoordinator', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    updateDiffPreviewForNote: vi.fn(),
}));

import { awaitApproval, resolveAllLocalApprovals } from '../../../react/utils/localApprovals';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    resolveAllLocalApprovals('test reset');
    logged.length = 0;
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

const EDIT = { library_id: 1, zotero_key: 'NOTE0001', old_string: 'T2 is 1 ms', new_string: 'T2 is 1.2 ms' };
const toolCall = {
    part_kind: 'tool-call',
    tool_name: 'edit_note',
    tool_call_id: 'call-note',
    args: { note_id: '1-NOTE0001', old_string: EDIT.old_string, new_string: EDIT.new_string },
} as any;
const record = {
    id: 'edit-1',
    run_id: 'run-1',
    toolcall_id: 'call-note',
    action_type: 'edit_note',
    status: 'pending',
    proposed_data: EDIT,
} as any;

async function mountRow() {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const agentActions = await import('../../../react/agents/agentActions');
    const { threadRunsAtom, activeRunAtom } = await import('@beaver/agent-core/run-state/atoms');
    const { isWSChatPendingAtom } = await import('../../../react/atoms/agentRunAtoms');
    const { useEditNoteActions } = await import('../../../react/host/zotero/components/useEditNoteActions');

    // The run has ended; its edit_note call returned as soon as it proposed.
    store.set(activeRunAtom, null);
    store.set(isWSChatPendingAtom, false);
    store.set(threadRunsAtom, [{
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'completed',
        user_prompt: { content: 'fix the T2 value in my note' },
        model_messages: [
            { kind: 'response', parts: [toolCall] },
            {
                kind: 'request',
                parts: [{ part_kind: 'tool-return', tool_name: 'edit_note', tool_call_id: 'call-note', content: { status: 'PROPOSED' } }],
            },
        ],
    } as any]);
    store.set(agentActions.threadAgentActionsAtom, [record]);
    store.set(agentActions.inFlightAgentActionIdsAtom, new Set<string>());
    store.set(agentActions.answeredApprovalIdsAtom, new Set<string>());
    store.set(agentActions.pendingApprovalsAtom, new Map([['edit-1', {
        actionId: 'edit-1',
        toolcallId: 'call-note',
        actionType: 'edit_note',
        actionData: EDIT,
        runId: 'run-1',
        threadId: 'thread-1',
    }]]) as any);
    // As proposeWrite waits on it: the answer claims the write at once.
    void awaitApproval('edit-1', 'call-note', 'edit_note', {
        onAnswer: () => { store.set(agentActions.beginProposalOutcomeAtom, 'edit-1'); },
    });

    const state: { current: ReturnType<typeof useEditNoteActions> | null } = { current: null };
    const Row: React.FC = () => {
        state.current = useEditNoteActions({ part: toolCall, runId: 'run-1', runStatus: 'completed' });
        return null;
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, React.createElement(Row)));
    });
    return { store, agentActions, state };
}

describe('a note edit approved on its row', () => {
    it('keeps waiting on its write, and settles once the write is recorded', async () => {
        const { store, agentActions, state } = await mountRow();

        await act(async () => { state.current!.handleApprove(); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

        expect(state.current!.clickedButton).toBe('approve');
        expect(state.current!.isProcessing).toBe(true);
        expect(logged.some((message) => message.includes('did not reach the run'))).toBe(false);

        // The write lands: the record takes the outcome and the claim ends.
        await act(async () => {
            store.set(agentActions.upsertAgentActionsAtom, [{ ...record, status: 'applied', result_data: { ok: true } }]);
            store.set(agentActions.endProposalOutcomeAtom, 'edit-1');
        });

        expect(state.current!.isProcessing).toBe(false);
        expect(state.current!.clickedButton).toBeNull();
    });
});
