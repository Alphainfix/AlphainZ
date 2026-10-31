// @vitest-environment jsdom
 
/**
 * The bar above the composer that counts proposed changes.
 *
 * It speaks for this conversation only: its count, Approve All and Reject All
 * cover the cards on screen. Another conversation's proposals are pointed at
 * with a link that opens that conversation — never approved or rejected from
 * here, where nobody can see them. And Approve All leaves deletions and
 * destructive note rewrites for their own click, as the review card does.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('../../../react/utils/noteEditorDiffPreview', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    dismissDiffPreview: vi.fn().mockResolvedValue(undefined),
}));

import { eventManager } from '../../../react/events/eventManager';
import { awaitApproval, isLocalApprovalWaiting, resolveAllLocalApprovals, type ApprovalOutcome } from '../../../react/utils/localApprovals';
import { heldBackNote, planBulkApproval } from '../../../react/components/input/PendingActionsBar';

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
    vi.restoreAllMocks();
});

interface Proposal {
    id: string;
    runId: string;
    threadId: string;
    threadName?: string;
    actionType?: string;
    actionData?: Record<string, unknown>;
}

/** Mount the bar with the open chat at `thread-open` / `run-open`. */
async function mount(proposals: Proposal[]) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const { pendingApprovalsAtom } = await import('../../../react/agents/agentActions');
    const { currentThreadIdAtom, threadRunsAtom, activeRunAtom } = await import('@beaver/agent-core/run-state/atoms');
    const { recentThreadsAtom } = await import('../../../react/atoms/threads');
    const { default: PendingActionsBar } = await import('../../../react/components/input/PendingActionsBar');

    const outcomes = new Map<string, ApprovalOutcome | 'waiting'>();
    for (const proposal of proposals) {
        outcomes.set(proposal.id, 'waiting');
        void awaitApproval(proposal.id, `call-${proposal.id}`, proposal.actionType ?? 'create_highlight_annotations')
            .then((outcome) => { outcomes.set(proposal.id, outcome); });
    }
    store.set(pendingApprovalsAtom as any, new Map(proposals.map((proposal) => [proposal.id, {
        actionId: proposal.id,
        toolcallId: `call-${proposal.id}`,
        actionType: proposal.actionType ?? 'create_highlight_annotations',
        actionData: proposal.actionData ?? {},
        runId: proposal.runId,
        threadId: proposal.threadId,
        threadName: proposal.threadName ?? null,
    }])) as any);
    store.set(currentThreadIdAtom, 'thread-open');
    store.set(threadRunsAtom, [{ id: 'run-open', thread_id: 'thread-open', status: 'completed' } as any]);
    store.set(activeRunAtom, null);
    store.set(recentThreadsAtom, [{ id: 'thread-lab', name: 'Lab notes on forgetting', createdAt: '', updatedAt: '' }]);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, React.createElement(PendingActionsBar)));
    });
    return { outcomes };
}

const button = (label: string) =>
    Array.from(host!.querySelectorAll('button')).find((candidate) => candidate.textContent === label) as HTMLButtonElement | undefined;

const here = (id: string, extra: Partial<Proposal> = {}): Proposal => ({ id, runId: 'run-open', threadId: 'thread-open', ...extra });
const inLab = (id: string): Proposal => ({ id, runId: 'run-lab', threadId: 'thread-lab', threadName: 'old name' });

describe('the pending actions bar', () => {
    it('counts only this chat’s proposals, and points at the other chat’s', async () => {
        await mount([here('a'), here('b'), inLab('c')]);

        expect(host!.textContent).toContain('2 proposed changes');
        // Named as the chat history names it.
        expect(host!.textContent).toContain('1 proposed change in ‘Lab notes on forgetting’');
        expect(button('Open')).toBeDefined();
    });

    it('shows no Approve All or Reject All for another chat’s proposals', async () => {
        await mount([inLab('c')]);

        expect(button('Approve All')).toBeUndefined();
        expect(button('Reject All')).toBeUndefined();
        expect(host!.textContent).toContain('1 proposed change in ‘Lab notes on forgetting’');
    });

    it('opens the other chat at the run that proposed them', async () => {
        await mount([inLab('c')]);
        const dispatch = vi.spyOn(eventManager, 'dispatch').mockImplementation(() => {});

        await act(async () => { button('Open')!.click(); });

        expect(dispatch).toHaveBeenCalledWith('loadThread', { threadId: 'thread-lab', runId: 'run-lab' });
    });

    it('approves this chat’s proposals and nothing else, leaving deletions for their own click', async () => {
        const { outcomes } = await mount([
            here('h1'),
            here('h2'),
            here('del', { actionType: 'edit_annotations', actionData: { operation: 'delete' } }),
            inLab('c'),
        ]);

        expect(host!.textContent).toContain('3 proposed changes');
        expect(host!.textContent).toContain('The annotation deletion needs its own Apply on its card.');
        await act(async () => { button('Approve 2')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(outcomes.get('h1')).toMatchObject({ approved: true });
        expect(outcomes.get('h2')).toMatchObject({ approved: true });
        expect(isLocalApprovalWaiting('del')).toBe(true);
        expect(isLocalApprovalWaiting('c')).toBe(true);
    });

    it('rejects this chat’s proposals and leaves the other chat’s waiting', async () => {
        const { outcomes } = await mount([here('h1'), inLab('c')]);

        await act(async () => { button('Reject All')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(outcomes.get('h1')).toMatchObject({ approved: false });
        expect(isLocalApprovalWaiting('c')).toBe(true);
    });
});

describe('planBulkApproval', () => {
    it('holds back deletions and destructive rewrites, and says so', () => {
        const approvals = [
            { actionId: 'a', toolcallId: 'x', actionType: 'create_highlight_annotations', actionData: {} },
            { actionId: 'b', toolcallId: 'y', actionType: 'edit_note', actionData: { destructive_rewrite: true } },
        ] as any[];
        const plan = planBulkApproval(approvals);
        expect(plan.approvable.map((a) => a.actionId)).toEqual(['a']);
        expect(plan.heldBack.map((a) => a.actionId)).toEqual(['b']);
        expect(heldBackNote(plan.heldBack)).toBe('The note rewrite needs its own Apply on its card.');
    });
});
