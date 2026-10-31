/**
 * Hook that listens for "readerSelectionAction" events dispatched from the
 * esbuild bundle's reader integration and orchestrates the sidebar-open →
 * continue-or-start-thread → set-text-selection → send-message / focus-input
 * flow.
 *
 * "Continue" rather than "new": a second passage explained from the same paper
 * adds to the conversation instead of replacing it. See `readerChatDelivery`.
 */

import { useSetAtom } from 'jotai';
import { newThreadAtom } from '../atoms/threads';
import { readerTextSelectionAtom } from '../atoms/messageComposition';
import { sendWSMessageAtom } from '../atoms/agentRunAtoms';
import { eventManager } from '../events/eventManager';
import type { BeaverEventDetail } from '../events/types';
import { useEventSubscription } from './useEventSubscription';
import { store } from '../store';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../src/utils/prefs';
import { continueOrStartThread, deliverPrompt } from '../utils/readerChatDelivery';
import type { ReaderTextSelection } from '../utils/readerUtils';
import { ensureReaderAttachment, refuseReaderQuestion, releaseHighlightQuestion } from './useSelectionChatHandler';
import { revealChatForReaderQuestion } from './useToggleSidebar';

/**
 * The menu's event as the reader integration sends it: besides the text, the
 * page the selection starts on and where it is, when the reader says.
 */
type ReaderSelectionActionDetail = BeaverEventDetail<'readerSelectionAction'> & {
    pageIndex?: number;
    position?: Record<string, any>;
};

/** The passage an Explain or Ask stages, located where the reader put it. */
export function selectionFromReaderAction(detail: ReaderSelectionActionDetail): ReaderTextSelection {
    const { text, page, pageIndex, position } = detail;
    return {
        text,
        page,
        ...(typeof pageIndex === 'number' && Number.isInteger(pageIndex) && pageIndex >= 0
            ? { page_index: pageIndex }
            : {}),
        ...(position && typeof position === 'object' ? { position } : {}),
    };
}

/** Explain or Ask on text selected in the reader. */
export async function handleReaderSelectionAction(
    detail: ReaderSelectionActionDetail,
    deps: {
        newThread: (options: { skipAutoPopulate: boolean }) => Promise<unknown>;
        sendWSMessage: (message: string) => Promise<unknown>;
    },
): Promise<void> {
    const { action, readerItemID } = detail;

    // The sign-in gate that stood here made these reader entries dead in a
    // build with no account: the model runs locally, so there is nothing to
    // authenticate against.

    logger(`useReaderSelectionActionHandler: Received action "${action}" for item ${readerItemID}`);

    // A file in a library excluded from AlphainZ is not asked about.
    if (refuseReaderQuestion(readerItemID)) return;
    releaseHighlightQuestion();

    // 1. Show the chat
    revealChatForReaderQuestion();

    // 2. Continue the conversation on screen, or start one if the panel is empty
    await continueOrStartThread(deps.newThread);

    // 3. Set text selection and send message (after sidebar-open state settles)
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        // Set text selection
        store.set(readerTextSelectionAtom, selectionFromReaderAction(detail));

        // Ensure reader attachment is set
        await ensureReaderAttachment(readerItemID);

        // Either send explain prompt or focus input
        if (action === 'explain') {
            const defaultPrompt = 'Explain the selected passage from this paper in plain language. '
                + 'Provide context for any technical terms, statistical methods, or domain-specific concepts. '
                + 'If it references other work, briefly explain that context too.';
            const prompt = getPref('readerExplainPrompt') || defaultPrompt;
            await deliverPrompt(deps.sendWSMessage, prompt);
        } else {
            // Focus the input textarea for "Ask..."
            eventManager.dispatch('focusInput', {});
        }
    } catch (error) {
        logger(`useReaderSelectionActionHandler: Error: ${error}`, 1);
    }
}

export function useReaderSelectionActionHandler() {
    const newThread = useSetAtom(newThreadAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);

    useEventSubscription(
        'readerSelectionAction',
        (detail) => {
            void handleReaderSelectionAction(detail as ReaderSelectionActionDetail, { newThread, sendWSMessage });
        },
        [newThread, sendWSMessage],
    );
}
