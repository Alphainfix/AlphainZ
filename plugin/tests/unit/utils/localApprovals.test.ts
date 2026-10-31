/**
 * The gate between the agent and the user's library.
 *
 * Two properties matter more than the rest: nothing is written without a yes,
 * and nothing waits forever. The second is the one that bites — a tool
 * suspended on a promise nobody resolves is a run that never ends and a
 * composer that never unlocks.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
    awaitApproval,
    isLocalApprovalWaiting,
    nextApprovalId,
    pendingLocalApprovalCount,
    resolveAllLocalApprovals,
    resolveLocalApproval,
    settleLocalApproval,
} from '../../../react/utils/localApprovals';

beforeEach(() => {
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    resolveAllLocalApprovals('test reset');
});

describe('localApprovals', () => {
    it('hands back distinct ids', () => {
        expect(nextApprovalId()).not.toBe(nextApprovalId());
    });

    it('resolves the waiting write when the user approves', async () => {
        const id = nextApprovalId();
        const decision = awaitApproval(id, 'call-1', 'create_note');
        expect(resolveLocalApproval(id, true)).toBe(true);
        await expect(decision).resolves.toMatchObject({ approved: true });
    });

    it('carries the instructions the user typed on the card', async () => {
        // "No — do it on page 4 instead" is the common case, and it is useless
        // if it does not reach the model.
        const id = nextApprovalId();
        const decision = awaitApproval(id, 'call-1', 'create_highlight_annotations');
        resolveLocalApproval(id, false, 'use page 4 instead');
        await expect(decision).resolves.toEqual({
            approved: false,
            userInstructions: 'use page 4 instead',
        });
    });

    it('reports that it did not handle an id it never saw', () => {
        // This is how the shared path knows to fall through to the socket
        // instead of swallowing a cloud approval.
        expect(resolveLocalApproval('someone-elses-action', true)).toBe(false);
    });

    it('answers a given id only once', async () => {
        const id = nextApprovalId();
        const decision = awaitApproval(id, 'call-1', 'create_note');
        expect(resolveLocalApproval(id, true)).toBe(true);
        expect(resolveLocalApproval(id, false)).toBe(false);
        await expect(decision).resolves.toMatchObject({ approved: true });
    });

    it('declines everything still waiting when the run ends', async () => {
        const a = nextApprovalId();
        const b = nextApprovalId();
        const first = awaitApproval(a, 'call-1', 'create_note');
        const second = awaitApproval(b, 'call-2', 'create_note');
        expect(pendingLocalApprovalCount()).toBe(2);

        expect(resolveAllLocalApprovals('cancelled')).toBe(2);

        // Declined, never approved: a cancelled run must not write on its way out.
        await expect(first).resolves.toMatchObject({ approved: false });
        await expect(second).resolves.toMatchObject({ approved: false });
        expect(pendingLocalApprovalCount()).toBe(0);
    });

    it('is a no-op when nothing is waiting', () => {
        expect(resolveAllLocalApprovals('nothing to do')).toBe(0);
    });

    it('leaves nothing waiting after a decision', async () => {
        const id = nextApprovalId();
        const decision = awaitApproval(id, 'call-1', 'create_note');
        resolveLocalApproval(id, true);
        await decision;
        expect(pendingLocalApprovalCount()).toBe(0);
    });
});

describe('answering a waiting write', () => {
    it('runs the waiter’s hook in the same tick as the answer, before the promise settles', async () => {
        const id = nextApprovalId();
        const seen: string[] = [];
        const decision = awaitApproval(id, 'call-1', 'create_note', {
            onAnswer: (outcome) => { seen.push(`hook:${outcome.approved}`); },
        });
        void decision.then(() => { seen.push('promise'); });

        resolveLocalApproval(id, true);
        // Synchronously, before anything a click renders can read stale state.
        expect(seen).toEqual(['hook:true']);
        await decision;
        expect(seen).toEqual(['hook:true', 'promise']);
    });

    it('settles a write that was made some other way, without approving or declining it', async () => {
        const id = nextApprovalId();
        const decision = awaitApproval(id, 'call-1', 'create_item');

        expect(settleLocalApproval(id)).toBe(true);
        await expect(decision).resolves.toMatchObject({ settled: true });
        expect(isLocalApprovalWaiting(id)).toBe(false);
        expect(settleLocalApproval(id)).toBe(false);
    });
});
