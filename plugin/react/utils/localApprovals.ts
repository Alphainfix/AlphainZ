/**
 * Asking the user before the agent writes to their library, with no server.
 *
 * Beaver's flow is a round trip: the backend proposes an action, the client
 * shows a card, the user decides, the decision goes back over the socket, and
 * the backend executes. Locally the executor and the UI are the same process,
 * so the middle of that is a promise — the tool suspends, the card appears, and
 * the tool resumes with the answer.
 *
 * The card itself is Beaver's. `deferred_approval_request` is matched to a tool
 * call by `toolcall_id`, which the runner has already emitted, so the existing
 * preview and its Reject/Apply footer render unchanged. Nothing about the UI is
 * new; only where the decision travels.
 *
 * A proposal does not hold its run open: the tool returns at once, and a
 * detached task waits on the promise here. So a run ending — finishing,
 * failing, being stopped, or the user sending the next message — leaves its
 * proposals waiting; they are decisions the user has not made yet, and only
 * the user's click declines one. The exception is a run removed from the
 * thread by a retry, whose cards go with it (`resolveLocalApprovalsForToolCalls`).
 */

import { logger } from '@beaver/agent-core/platform/logger';

export interface ApprovalOutcome {
    approved: boolean;
    userInstructions?: string | null;
    /**
     * The change was decided some other way — added from another surface —
     * so the waiter has nothing left to write or record.
     */
    settled?: boolean;
}

interface Waiting {
    resolve: (outcome: ApprovalOutcome) => void;
    toolcallId: string;
    actionType: string;
    onAnswer?: (outcome: ApprovalOutcome) => void;
}

const waiting = new Map<string, Waiting>();

/**
 * Hand an outcome to its waiter: the synchronous hook first, then the promise.
 *
 * The promise's continuation runs a microtask later, after whatever the click
 * that answered it renders; the hook runs before that, so the waiter can mark
 * its write as under way before any surface redraws.
 */
function answer(entry: Waiting, outcome: ApprovalOutcome): void {
    try {
        entry.onAnswer?.(outcome);
    } catch (error) {
        logger(`localApprovals: answer hook for ${entry.actionType} threw: ${error}`, 1);
    }
    entry.resolve(outcome);
}

let counter = 0;

/**
 * A per-session id, for requests that never outlive the session that made them.
 *
 * Counter rather than a random id: `Math.random` and `Date.now` are both things
 * this codebase avoids in code that has to be replayable. A proposal that is
 * kept with its run needs an id unique across sessions instead, and brings its
 * own.
 */
export function nextApprovalId(): string {
    counter += 1;
    return `local-approval-${counter}`;
}

/**
 * Register a waiting tool and hand back the promise it should await.
 *
 * @param options.onAnswer  Called synchronously when the outcome arrives,
 *   before the promise settles — for state that has to change in the same
 *   tick as the click that answered it.
 */
export function awaitApproval(
    actionId: string,
    toolcallId: string,
    actionType: string,
    options: { onAnswer?: (outcome: ApprovalOutcome) => void } = {},
): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
        waiting.set(actionId, { resolve, toolcallId, actionType, onAnswer: options.onAnswer });
    });
}

/**
 * Deliver the user's decision to the tool waiting on it.
 *
 * Returns false when no local tool is waiting, which is how the shared
 * approval-response path knows to fall through to the socket instead.
 */
export function resolveLocalApproval(
    actionId: string,
    approved: boolean,
    userInstructions?: string | null,
): boolean {
    const entry = waiting.get(actionId);
    if (!entry) return false;
    waiting.delete(actionId);
    logger(`localApprovals: ${entry.actionType} ${approved ? 'approved' : 'rejected'}`, 1);
    answer(entry, { approved, userInstructions: userInstructions ?? null });
    return true;
}

/**
 * Release a waiter whose change was made some other way, so it neither writes
 * nor records anything: its record already says what happened.
 *
 * Returns false when nothing local is waiting on this id.
 */
export function settleLocalApproval(actionId: string): boolean {
    const entry = waiting.get(actionId);
    if (!entry) return false;
    waiting.delete(actionId);
    logger(`localApprovals: ${entry.actionType} settled elsewhere`, 1);
    answer(entry, { approved: false, userInstructions: null, settled: true });
    return true;
}

/**
 * Answer everything still waiting, as declined.
 *
 * For tearing the whole approval state down; no run boundary does that, since
 * proposals outlive their runs. Declining rather than approving is the only
 * safe default: the writes have not happened, and nothing may apply a change
 * the user did not ask for.
 */
export function resolveAllLocalApprovals(reason: string): number {
    if (waiting.size === 0) return 0;
    logger(`localApprovals: declining ${waiting.size} pending on ${reason}`, 1);
    const entries = [...waiting.values()];
    waiting.clear();
    for (const entry of entries) {
        answer(entry, { approved: false, userInstructions: null });
    }
    return entries.length;
}

/**
 * Decline the proposals made by these tool calls, and only those.
 *
 * For a run that is being removed from the thread (a retry replaces it): its
 * cards go with it, so a proposal of its left waiting would count as pending
 * with nothing on screen to decide. Every other proposal — including those of
 * runs that finished or were stopped — stays the user's to decide.
 *
 * Returns the ids of the approvals it declined, so the caller can retire their
 * cards.
 */
export function resolveLocalApprovalsForToolCalls(
    toolcallIds: ReadonlySet<string>,
    reason: string,
): string[] {
    const declined: string[] = [];
    for (const [actionId, entry] of waiting) {
        if (!toolcallIds.has(entry.toolcallId)) continue;
        waiting.delete(actionId);
        declined.push(actionId);
        answer(entry, { approved: false, userInstructions: null });
    }
    if (declined.length > 0) {
        logger(`localApprovals: declining ${declined.length} pending on ${reason}`, 1);
    }
    return declined;
}

/** How many writes are waiting on the user. */
export function pendingLocalApprovalCount(): number {
    return waiting.size;
}

/**
 * Whether this approval belongs to a proposal that is still waiting locally.
 *
 * Asked by the tool-return handler, which inherited a rule from the blocking
 * design: a tool call that returns has, by definition, already had its approval
 * answered, so any card still tied to that call is stale and gets dropped.
 *
 * That rule is exactly wrong once proposals stop blocking. The call now returns
 * the instant the card is registered, so the return deleted the card it had
 * just created — every highlight, every paper, every filing change vanished
 * microseconds after being proposed, leaving the promise nobody would ever
 * answer. Nothing the agent proposed could be approved.
 */
export function isLocalApprovalWaiting(actionId: string): boolean {
    return waiting.has(actionId);
}
