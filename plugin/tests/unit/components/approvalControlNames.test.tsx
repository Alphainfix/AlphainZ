// @vitest-environment jsdom
 
/**
 * Icon-only approval buttons carry a name.
 *
 * A red × and a green ✓ both read "button" to a screen reader, so Reject and
 * Apply could not be told apart — on the review card's rows, its bulk
 * buttons, and every other card that decides a change.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

const pendingCollection = {
    id: 'action-1',
    run_id: 'run-1',
    toolcall_id: 'call-1',
    action_type: 'create_collection',
    status: 'pending',
    proposed_data: { name: 'Pollinators' },
};

async function render(element: React.ReactElement) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, element));
    });
    return store;
}

const names = () => Array.from(host!.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));

describe('approval controls', () => {
    it('are named on a review row', async () => {
        const { ReviewActionRow } = await import('../../../react/host/zotero/components/reviewChanges/ReviewActionRow');
        await render(React.createElement(ReviewActionRow, {
            runId: 'run-1',
            row: {
                toolcallId: 'call-1',
                actionType: 'create_collection',
                actions: [pendingCollection as any],
                bulkApplicable: true,
                resolved: false,
            },
        }));

        expect(names()).toEqual(expect.arrayContaining([
            'Reject Create Collection · Pollinators',
            'Apply Create Collection · Pollinators',
        ]));
    });

    it('are named on the review card’s bulk buttons', async () => {
        const { ChangesCard } = await import('../../../react/host/zotero/components/reviewChanges/ChangesCard');
        const second = { ...pendingCollection, id: 'action-2', toolcall_id: 'call-2', proposed_data: { name: 'Waggle dances' } };
        await render(React.createElement(ChangesCard, {
            run: { id: 'run-1', status: 'completed' } as any,
            rows: [pendingCollection, second].map((action) => ({
                toolcallId: action.toolcall_id,
                actionType: action.action_type,
                actions: [action as any],
                bulkApplicable: true,
                resolved: false,
            })),
        }));

        expect(names()).toEqual(expect.arrayContaining(['Reject all', 'Apply all']));
    });

    it('are named on an in-stream card waiting for a decision', async () => {
        const { store } = await import('../../../react/store');
        const agentActions = await import('../../../react/agents/agentActions');
        store.set(agentActions.threadAgentActionsAtom, [pendingCollection as any]);
        const { AgentActionView } = await import('../../../react/host/zotero/components/AgentActionView');
        await render(React.createElement(AgentActionView, {
            toolcallId: 'call-1',
            toolName: 'create_collection',
            runId: 'run-1',
            responseIndex: 0,
            pendingApproval: null,
            hasToolReturn: true,
            runStatus: 'completed',
        }));

        expect(names()).toEqual(expect.arrayContaining([
            'Reject Create Collection · Pollinators',
            'Apply Create Collection · Pollinators',
        ]));
        // A change nobody was asked about yet says it is waiting on the user.
        expect(host!.textContent).toContain('Waiting for your review');
    });

    it('show a deletion card the deletion rule, not the annotation-edits rule', async () => {
        const { store } = await import('../../../react/store');
        const agentActions = await import('../../../react/agents/agentActions');
        const deletion = {
            id: 'delete-1',
            run_id: 'run-1',
            toolcall_id: 'call-del',
            action_type: 'edit_annotations',
            status: 'pending',
            proposed_data: { operation: 'delete', annotation_refs: [] },
        };
        store.set(agentActions.threadAgentActionsAtom, [deletion as any]);
        store.set(agentActions.pendingApprovalsAtom, new Map([['delete-1', {
            actionId: 'delete-1',
            toolcallId: 'call-del',
            actionType: 'edit_annotations',
            actionData: deletion.proposed_data,
            runId: 'run-1',
            threadId: 'thread-1',
        }]]) as any);
        const { AgentActionView } = await import('../../../react/host/zotero/components/AgentActionView');
        await render(React.createElement(AgentActionView, {
            toolcallId: 'call-del',
            toolName: 'edit_annotations',
            runId: 'run-1',
            responseIndex: 0,
            pendingApproval: store.get(agentActions.pendingApprovalsAtom).get('delete-1')!,
            hasToolReturn: true,
            runStatus: 'completed',
        }));

        const menu = host!.querySelector('button[aria-label="Select action preference"]') as HTMLButtonElement;
        // Not changeable from the card, and not the edits rule offered in its place.
        expect(menu.disabled).toBe(true);
    });
});
