// @vitest-environment jsdom
 
/**
 * A proposal to add several papers, on one card.
 *
 * Adding papers proposes one approval per paper under one tool call. The card
 * shows every paper, lets each be added or left out on its own row, and stays
 * waiting while any is undecided; its own Apply and Reject answer all that
 * remain. The decision buttons are named for assistive technology.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));

import { awaitApproval, resolveAllLocalApprovals, type ApprovalOutcome } from '../../../react/utils/localApprovals';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    resolveAllLocalApprovals('test reset');
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

const TITLES = ['Waggle-dance odometry in honeybees', 'Optic flow in a patterned tunnel', 'Distance coding in foraging bees'];

async function mount() {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const agentActions = await import('../../../react/agents/agentActions');
    const { AgentActionView } = await import('../../../react/host/zotero/components/AgentActionView');

    const records = TITLES.map((title, index) => ({
        id: `paper-${index + 1}`,
        run_id: 'run-1',
        toolcall_id: 'call-papers',
        action_type: 'create_item',
        status: 'pending',
        proposed_data: { item: { title, authors: ['A. Author'], year: 2020 + index } },
    }));
    store.set(agentActions.threadAgentActionsAtom, records as any);
    store.set(agentActions.pendingApprovalsAtom, new Map(records.map((record) => [record.id, {
        actionId: record.id,
        toolcallId: 'call-papers',
        actionType: 'create_item',
        actionData: record.proposed_data,
        runId: 'run-1',
        threadId: 'thread-1',
    }])) as any);

    // What the proposal's own task does with an answer: the card goes, and
    // the record takes the decision.
    const outcomes = new Map<string, ApprovalOutcome>();
    for (const record of records) {
        void awaitApproval(record.id, 'call-papers', 'create_item').then((outcome) => {
            outcomes.set(record.id, outcome);
            store.set(agentActions.removePendingApprovalAtom, record.id);
            store.set(agentActions.upsertAgentActionsAtom, [{
                ...record,
                status: outcome.approved ? 'applied' : 'rejected',
            } as any]);
        });
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const first = store.get(agentActions.pendingApprovalsAtom).get('paper-1')!;
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, React.createElement(AgentActionView, {
            toolcallId: 'call-papers',
            toolName: 'create_item',
            runId: 'run-1',
            responseIndex: 0,
            pendingApproval: first,
            hasToolReturn: true,
            runStatus: 'completed',
        })));
    });
    return { outcomes, store, agentActions };
}

const byLabel = (label: string) => host!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

describe('a card proposing several papers', () => {
    it('shows every paper, each with its own decision', async () => {
        await mount();

        for (const title of TITLES) {
            expect(host!.textContent).toContain(title);
            expect(byLabel(`Add “${title}”`)).not.toBeNull();
            expect(byLabel(`Don't add “${title}”`)).not.toBeNull();
        }
    });

    it('stays waiting on the rest once one paper is decided', async () => {
        const { outcomes } = await mount();

        await act(async () => { byLabel(`Don't add “${TITLES[0]}”`)!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(outcomes.get('paper-1')).toMatchObject({ approved: false });
        // Papers 2 and 3 are still on the card, still decidable.
        expect(byLabel(`Add “${TITLES[1]}”`)).not.toBeNull();
        expect(byLabel(`Add “${TITLES[2]}”`)).not.toBeNull();
        // The one left out can still be added after all.
        expect(byLabel(`Add “${TITLES[0]}”`)).not.toBeNull();
        expect(byLabel(`Don't add “${TITLES[0]}”`)).toBeNull();
    });

    it('answers every remaining paper from the card’s own Apply', async () => {
        const { outcomes } = await mount();

        await act(async () => { byLabel(`Don't add “${TITLES[0]}”`)!.click(); });
        await act(async () => { await Promise.resolve(); });
        const apply = byLabel('Apply Import · 3 Items') ?? byLabel(`Apply Import · ${3} Items`);
        expect(apply).not.toBeNull();
        await act(async () => { apply!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(outcomes.get('paper-1')).toMatchObject({ approved: false });
        expect(outcomes.get('paper-2')).toMatchObject({ approved: true });
        expect(outcomes.get('paper-3')).toMatchObject({ approved: true });
    });

    it('names its header buttons', async () => {
        await mount();

        expect(byLabel('Reject Import · 3 Items')).not.toBeNull();
        expect(byLabel('Apply Import · 3 Items')).not.toBeNull();
    });
});
