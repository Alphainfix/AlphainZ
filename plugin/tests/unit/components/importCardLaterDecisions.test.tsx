// @vitest-environment jsdom
 
/**
 * Deciding papers on a card after some of them were already decided.
 *
 * A card proposing several papers lets each be added or left out on its own
 * row. What the card's own buttons do afterwards must respect those choices:
 * Try Again retries the papers that failed, never one the user left out, and a
 * paper added later on its own row goes where the card's "Add to" picker
 * points, like the papers approved beside it.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { written } = vi.hoisted(() => ({ written: [] as any[][] }));

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('../../../react/utils/createItemActions', () => ({
    executeCreateItemActions: vi.fn(async (actions: any[]) => {
        written.push(actions.map((action) => ({
            id: action.id,
            library_id: action.proposed_data?.library_id ?? null,
            collection_keys: action.proposed_data?.collection_keys ?? null,
        })));
        return {
            successes: actions.map((action) => ({ action, result: { library_id: 1, zotero_key: `K${action.id}` } })),
            failures: [],
        };
    }),
    undoCreateItemActions: vi.fn(async () => ({ successes: [], failures: [] })),
}));
vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn().mockResolvedValue({ success: true, errors: [] }),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { awaitApproval, resolveAllLocalApprovals } from '../../../react/utils/localApprovals';
import { actionsToApply } from '../../../react/host/zotero/components/agentActionViewHelpers';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const zotero = globalThis as any;
const original = {
    Libraries: zotero.Zotero.Libraries,
    Collections: zotero.Zotero.Collections,
    pane: zotero.Zotero.getActiveZoteroPane,
};

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    zotero.Zotero.AlphainZ = { data: { env: 'test' } };
    zotero.Zotero.Libraries = {
        ...original.Libraries,
        userLibraryID: 1,
        get: (id: number) => (id === 1 ? { libraryID: 1, name: 'My Library', editable: true } : false),
        getAll: () => [{ libraryID: 1, name: 'My Library', editable: true }],
    };
    zotero.Zotero.Collections = {
        getByLibrary: (libraryId: number) => (libraryId === 1
            ? [{ id: 10, key: 'AAAA1111', name: 'Project A' }, { id: 11, key: 'BBBB2222', name: 'Project B' }]
            : []),
        getByParent: () => [],
    };
    zotero.Zotero.getActiveZoteroPane = () => ({ getSelectedLibraryID: () => 1, getSelectedCollection: () => null });
    resolveAllLocalApprovals('test reset');
    written.length = 0;
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

const paper = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
    id: `paper-${n}`,
    run_id: 'run-1',
    toolcall_id: 'call-papers',
    action_type: 'create_item',
    status,
    proposed_data: { item: { title: `Paper ${n}`, authors: ['A. Author'], year: 2020 } },
    ...extra,
});

/** The card for one call proposing these papers; `live` are still waiting on their approval. */
async function mount(records: any[], live: string[] = []) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const agentActions = await import('../../../react/agents/agentActions');
    const { localZoteroLibrariesAtom } = await import('../../../react/atoms/profile');
    const { importDestinationAtom } = await import('../../../react/atoms/importDestination');
    const { AgentActionView } = await import('../../../react/host/zotero/components/AgentActionView');

    store.set(localZoteroLibrariesAtom, [{ library_id: 1, is_group: false, group_id: null, name: 'My Library' } as any]);
    store.set(importDestinationAtom, {});
    store.set(agentActions.threadAgentActionsAtom, records as any);
    store.set(agentActions.inFlightAgentActionIdsAtom, new Set<string>());
    store.set(agentActions.answeredApprovalIdsAtom, new Set<string>());
    store.set(agentActions.pendingApprovalsAtom, new Map(records
        .filter((record) => live.includes(record.id))
        .map((record) => [record.id, {
            actionId: record.id,
            toolcallId: 'call-papers',
            actionType: 'create_item',
            actionData: record.proposed_data,
            runId: 'run-1',
            threadId: 'thread-1',
        }])) as any);
    for (const id of live) void awaitApproval(id, 'call-papers', 'create_item');

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const first = store.get(agentActions.pendingApprovalsAtom).values().next().value ?? null;
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
    return store;
}

const byLabel = (label: string) => host!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const byText = (text: string) =>
    Array.from(host!.querySelectorAll('button')).find((button) => button.textContent?.trim() === text);
const click = async (element: HTMLElement) => {
    await act(async () => { element.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};

describe('Try Again on a card with a paper left out', () => {
    it('retries the paper that failed and does not add the one the user left out', async () => {
        await mount([paper(1, 'rejected'), paper(2, 'error', { error_message: 'network' })]);
        // A failed card folds to one line; open it to reach Try Again.
        await click(host!.querySelector('button[data-settled-action="true"]') as HTMLElement);

        await click(byText('Try Again')!);

        expect(written.flat().map((entry) => entry.id)).toEqual(['paper-2']);
    });
});

describe('a paper added on its own row after it was left out', () => {
    it('goes to the collection picked on the card, like the papers approved beside it', async () => {
        await mount([paper(1, 'rejected'), paper(2, 'pending')], ['paper-2']);
        const picker = host!.querySelector('select[aria-label="Collection to add these papers to"]') as HTMLSelectElement;
        expect(picker).not.toBeNull();
        await act(async () => {
            picker.value = '1:BBBB2222';
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(picker.value).toBe('1:BBBB2222');

        await click(byLabel('Add “Paper 1”')!);

        expect(written.flat()).toEqual([{ id: 'paper-1', library_id: 1, collection_keys: ['BBBB2222'] }]);
    });
});

describe('the permission button on an import card', () => {
    const explanation = () => {
        const button = byLabel('Adding papers always asks')!;
        return (button.getAttribute('aria-describedby') ?? '')
            .split(' ')
            .map((id) => (id ? document.getElementById(id)?.textContent ?? '' : ''))
            .join(' ');
    };

    it('points to "Allow for this run" while the approval is waiting, where Apply offers it', async () => {
        await mount([paper(1, 'pending')], ['paper-1']);
        expect(explanation()).toContain('Allow for this run');
    });

    it('does not point to it on a card restored from its record, whose Apply is plain', async () => {
        await mount([paper(1, 'pending')]);
        expect(explanation()).not.toContain('Allow for this run');
        expect(explanation()).toContain('Adding papers always asks');
    });
});

describe('actionsToApply', () => {
    const records = (...statuses: string[]) => statuses.map((status, index) => paper(index + 1, status) as any);
    const ids = (actions: any[]) => actions.map((action) => action.id);

    it('takes the undecided papers while any are undecided', () => {
        expect(ids(actionsToApply(records('rejected', 'pending', 'error')))).toEqual(['paper-2']);
    });

    it('takes only the failed papers once none are undecided', () => {
        expect(ids(actionsToApply(records('rejected', 'error', 'undone')))).toEqual(['paper-2']);
    });

    it('takes every paper when all were rejected or undone', () => {
        expect(ids(actionsToApply(records('rejected', 'undone')))).toEqual(['paper-1', 'paper-2']);
    });

    it('never takes a paper already added', () => {
        expect(ids(actionsToApply(records('applied', 'rejected')))).toEqual(['paper-2']);
    });
});
