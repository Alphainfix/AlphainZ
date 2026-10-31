/**
 * How a question asked from the reader reaches the chat panel.
 *
 * Four entry points ask one: the selection popup, "Explain"/"Ask" on selected
 * text, and "Explain" on an annotation. Each one used to clear the panel and
 * start over, so asking about a second passage threw away the conversation the
 * first one produced — which is nearly always the context that makes the second
 * question worth asking.
 *
 * The rule is one line of policy, and it was copied into three handlers before
 * it lived here.
 *
 * Whatever the user was writing in the composer is theirs, not the reader's:
 * none of these entry points may discard it or send it. The draft survives a
 * new conversation being started here, the attachments staged for it are
 * marked so the reader's question does not take them, and a question staged
 * mid-run is added after the draft rather than written over it.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { PromptOrigin } from '@beaver/agent-core/agents/types';

import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import {
    composerDraftAtom,
    currentMessageContentAtom,
    isComposerDraftEmpty,
    markComposerDraftAtom,
    restoreComposerDraftAtom,
    stagedReaderPromptAtom,
} from '../atoms/messageComposition';
import { currentThreadIdAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';
import { store } from '../store';
import { drainPendingAnchor } from './selectionAnchors';

/**
 * Use the conversation already on screen; start one only when there is none.
 *
 * Returns whether an existing conversation was continued, which callers need
 * when something has to be attached to the thread id.
 *
 * Starting a conversation clears the panel, and the composer with it. The
 * user's draft — text, pills, staged papers — is put back afterwards: it was
 * written for a question they have not asked yet, not for the chat that is
 * being replaced.
 */
export async function continueOrStartThread(
    startThread: (options: { skipAutoPopulate: boolean }) => Promise<unknown>,
): Promise<{ continued: boolean }> {
    if (store.get(currentThreadIdAtom)) {
        store.set(markComposerDraftAtom);
        return { continued: true };
    }
    const draft = store.get(composerDraftAtom);
    await startThread({ skipAutoPopulate: true });
    if (!isComposerDraftEmpty(draft)) store.set(restoreComposerDraftAtom, draft);
    store.set(markComposerDraftAtom);
    return { continued: false };
}

/**
 * Send a prompt, or hand it to the composer when a run is already in flight.
 *
 * Sending refuses concurrent requests and returns without a word, so a menu
 * item clicked mid-run looked like it did nothing at all. Staging the prompt
 * where the user can see it costs them one keypress instead of the question.
 *
 * A staged prompt goes after whatever the user had already typed, and keeps
 * its origin (a selection question stays one when it is finally sent). The
 * highlight a selection question anchors to is linked to the conversation it
 * was staged in now, rather than to whichever run happens to start next.
 */
export async function deliverPrompt<Options>(
    send: (message: string, options?: Options) => Promise<unknown>,
    prompt: string,
    options?: Options,
): Promise<'sent' | 'staged'> {
    if (store.get(isWSChatPendingAtom)) {
        logger('readerChatDelivery: run in flight — staging the prompt in the composer', 1);
        const draft = store.get(currentMessageContentAtom);
        store.set(
            currentMessageContentAtom,
            draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${prompt}` : prompt,
        );
        const origin = (options as { origin?: PromptOrigin } | undefined)?.origin;
        store.set(stagedReaderPromptAtom, { text: prompt, ...(origin ? { origin } : {}) });
        const threadId = store.get(currentThreadIdAtom);
        if (threadId) void drainPendingAnchor(threadId);
        eventManager.dispatch('focusInput', {});
        return 'staged';
    }
    await send(prompt, options);
    return 'sent';
}
