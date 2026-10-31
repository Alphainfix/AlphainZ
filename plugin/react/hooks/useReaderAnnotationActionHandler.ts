/**
 * Hook that listens for "readerAnnotationAction" events dispatched from the
 * esbuild bundle's reader integration and orchestrates the sidebar-open →
 * continue-or-start-thread → add-annotations-to-message → send-message /
 * focus-input flow.
 *
 * "Continue" rather than "new": explaining a second annotation adds to the
 * conversation about the first instead of discarding it. See
 * `readerChatDelivery`.
 *
 * The question names the annotations it is about (an `annotation_question`
 * origin). They are attached beside every highlight staged from the open
 * paper, and without the name the model is left to guess which one the user
 * clicked.
 */

import { useSetAtom } from 'jotai';
import type { PromptOrigin } from '@beaver/agent-core/agents/types';
import { newThreadAtom } from '../atoms/threads';
import { addItemsToCurrentMessageItemsAtom, stagedReaderPromptAtom } from '../atoms/messageComposition';
import { sendWSMessageAtom } from '../atoms/agentRunAtoms';
import { eventManager } from '../events/eventManager';
import type { BeaverEventDetail } from '../events/types';
import { useEventSubscription } from './useEventSubscription';
import { store } from '../store';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../src/utils/prefs';
import { continueOrStartThread, deliverPrompt } from '../utils/readerChatDelivery';
import { ensureReaderAttachment, refuseReaderQuestion, releaseHighlightQuestion } from './useSelectionChatHandler';
import { revealChatForReaderQuestion } from './useToggleSidebar';

/** The origin that names the annotations a reader question is about. */
export function annotationQuestionOrigin(annotations: Zotero.Item[], libraryID: number): PromptOrigin {
    return {
        kind: 'annotation_question',
        annotation_keys: annotations.map((annotation) => annotation.key),
        library_id: libraryID,
    };
}

/** Explain or Ask on annotations picked in the reader. */
export async function handleReaderAnnotationAction(
    detail: BeaverEventDetail<'readerAnnotationAction'>,
    deps: {
        newThread: (options: { skipAutoPopulate: boolean }) => Promise<unknown>;
        sendWSMessage: (message: string, options?: { origin?: PromptOrigin }) => Promise<unknown>;
    },
): Promise<void> {
    const { action, annotationIds, readerItemID } = detail;

    // The sign-in gate that stood here made these reader entries dead in a
    // build with no account: the model runs locally, so there is nothing to
    // authenticate against.

    logger(`useReaderAnnotationActionHandler: Received action "${action}" for ${annotationIds.length} annotation(s)`);

    // A file in a library excluded from AlphainZ is not asked about: its
    // annotations would be removed from the message as it is sent, leaving
    // the canned prompt with nothing attached.
    if (refuseReaderQuestion(readerItemID)) return;
    releaseHighlightQuestion();

    // 1. Show the chat
    revealChatForReaderQuestion();

    // 2. Continue the conversation on screen, or start one if the panel is empty
    await continueOrStartThread(deps.newThread);

    // 3. Load annotation items, add to message, and send/focus (after the
    // sidebar-open state settles)
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        // Resolve the attachment (also used for libraryID in key lookups below)
        const attachment = await Zotero.Items.getAsync(readerItemID);
        if (!attachment) {
            logger('useReaderAnnotationActionHandler: Could not resolve reader item', 1);
            return;
        }

        // Ensure reader attachment is set
        await ensureReaderAttachment(readerItemID);

        // Load annotation Zotero.Items by key
        const annotationItems: Zotero.Item[] = [];
        for (const key of annotationIds) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                attachment.libraryID,
                key,
            );
            if (item) {
                annotationItems.push(item);
            } else {
                logger(`useReaderAnnotationActionHandler: Could not find annotation with key ${key}`, 2);
            }
        }

        if (annotationItems.length === 0) {
            logger('useReaderAnnotationActionHandler: No valid annotation items found', 1);
            return;
        }

        // Add annotations to current message items
        await store.set(addItemsToCurrentMessageItemsAtom, annotationItems);

        const origin = annotationQuestionOrigin(annotationItems, attachment.libraryID);
        if (action === 'explain') {
            const defaultPrompt = 'Explain the selected annotation(s) from this paper in plain language. '
                + 'Provide context for any technical terms, statistical methods, or domain-specific concepts. '
                + 'If it references other work, briefly explain that context too.';
            const prompt = getPref('readerExplainPrompt') || defaultPrompt;
            await deliverPrompt(deps.sendWSMessage, prompt, { origin });
        } else {
            // "Ask...": the user types the question. The staged origin gives
            // the composer's next send the same name for what it is about;
            // with no text of its own it matches any message.
            store.set(stagedReaderPromptAtom, { text: '', origin });
            eventManager.dispatch('focusInput', {});
        }
    } catch (error) {
        logger(`useReaderAnnotationActionHandler: Error: ${error}`, 1);
    }
}

export function useReaderAnnotationActionHandler() {
    const newThread = useSetAtom(newThreadAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);

    useEventSubscription(
        'readerAnnotationAction',
        (detail) => {
            void handleReaderAnnotationAction(detail, { newThread, sendWSMessage });
        },
        [newThread, sendWSMessage],
    );
}
