/**
 * Letting the agent ask the user something, with no server.
 *
 * The question card, its chips, its "Other" field, the system notification when
 * the panel is not on screen — all of it has been in this tree since the fork
 * and none of it could ever appear, because `ask_user_question` was a tool
 * Beaver's backend offered and this fork does not have a backend. The model
 * noticed the absence before we did: asked to colour-code a paper under a
 * constraint it could not satisfy, it spent a whole turn deliberating and then
 * wrote the question into its answer, where answering it meant starting again.
 *
 * Same shape as `localApprovals`: the tool suspends on a promise, the card
 * appears, the answer resumes it. The difference is that this one is *meant* to
 * block — a question with the run already finished is a question the user
 * cannot usefully answer.
 */

import { logger } from '@beaver/agent-core/platform/logger';

import type { AskUserQuestionAnswer } from '@beaver/agent-core/protocol/agentProtocol';

export interface QuestionOutcome {
    answers: AskUserQuestionAnswer[];
    cancelled: boolean;
}

const waiting = new Map<string, (outcome: QuestionOutcome) => void>();

let counter = 0;

/** An id for one question, matching the counter style `localApprovals` uses. */
export function nextQuestionId(): string {
    counter += 1;
    return `local-question-${counter}`;
}

/** Register a waiting tool and hand back the promise it should await. */
export function awaitAnswer(questionId: string): Promise<QuestionOutcome> {
    return new Promise<QuestionOutcome>((resolve) => {
        waiting.set(questionId, resolve);
    });
}

/**
 * Deliver the user's answers to the tool waiting on them.
 *
 * Returns false when no local tool is waiting, which is how the shared
 * response path knows to fall through to the socket instead.
 */
export function resolveLocalQuestion(
    questionId: string,
    answers: AskUserQuestionAnswer[],
    cancelled: boolean,
): boolean {
    const resolve = waiting.get(questionId);
    if (!resolve) return false;
    waiting.delete(questionId);
    logger(`localQuestions: ${questionId} ${cancelled ? 'skipped' : `answered (${answers.length})`}`, 1);
    resolve({ answers, cancelled });
    return true;
}

/**
 * Answer everything still waiting, as skipped.
 *
 * A run that ends without the user answering must not leave a promise nobody
 * will resolve: that is a run that never finishes and a composer that never
 * unlocks. Skipped rather than answered, because no answer was given.
 */
export function resolveAllLocalQuestions(reason: string): number {
    if (waiting.size === 0) return 0;
    logger(`localQuestions: skipping ${waiting.size} pending on ${reason}`, 1);
    const resolvers = [...waiting.values()];
    waiting.clear();
    for (const resolve of resolvers) resolve({ answers: [], cancelled: true });
    return resolvers.length;
}
