/**
 * Which run-blocking request, if any, owns the composer.
 *
 * Several states can block a run at once, and only one of them can occupy the
 * footer. The order below is the whole rule; it lives here rather than inline
 * in a client's sidebar so it stays a single, testable decision that every
 * client answers the same way.
 */

import type { PendingBatchApproval } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import type { PendingQuestion } from '@beaver/agent-core/run-state/pendingQuestions';

export type ComposerTakeover =
    | { kind: 'input' }
    | { kind: 'batch-approval'; approval: PendingBatchApproval }
    | { kind: 'credit-confirmation'; confirmation: PendingCreditConfirmation }
    | { kind: 'question'; question: PendingQuestion };

/**
 * The blocking state a client actually has.
 *
 * Every member is optional because clients render different subsets of these
 * surfaces: one without an ask_user_question panel, say, has no value to
 * report rather than an empty map it invented. Omitting a member means "this
 * client has no such state" and behaves exactly like the empty value, so the
 * precedence between whatever remains is unchanged.
 *
 * Agent-action approvals are not among them. They are answered on the action
 * cards in the stream, which stay on screen whatever occupies the footer, and
 * a proposed change does not hold its run — the run can go on to ask a
 * question while proposals wait. Letting them keep the input area in place
 * would hide that question behind them, with the run waiting on an answer
 * nobody can see.
 */
export interface ComposerTakeoverInput {
    batchApprovals?: ReadonlyMap<string, PendingBatchApproval>;
    creditConfirmations?: ReadonlyMap<string, PendingCreditConfirmation>;
    questions?: ReadonlyMap<string, PendingQuestion>;
}

const INPUT: ComposerTakeover = { kind: 'input' };

/**
 * Pick the composer's occupant.
 *
 * Precedence, highest first:
 *
 * 1. A pending batch approval. It gates the work a credit confirmation would
 *    charge for, so deciding it first is what makes the cost decision
 *    meaningful — and a declined batch may remove the cost entirely.
 * 2. A pending credit confirmation. It gates the run's spending decision, so
 *    nothing else the run is waiting on can make progress behind it.
 * 3. A pending ask_user_question. Answering it cannot unblock a run that is
 *    already stopped on a credit decision, so it waits its turn.
 *
 * Only one entry of each map is ever live per run; the first is taken when
 * several exist so the choice does not depend on iteration luck.
 */
export function selectComposerTakeover(input: ComposerTakeoverInput): ComposerTakeover {
    const approval = input.batchApprovals?.values().next().value;
    if (approval) return { kind: 'batch-approval', approval };

    const confirmation = input.creditConfirmations?.values().next().value;
    if (confirmation) return { kind: 'credit-confirmation', confirmation };

    const question = input.questions?.values().next().value;
    if (question) return { kind: 'question', question };

    return INPUT;
}
