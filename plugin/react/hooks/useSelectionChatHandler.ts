/**
 * Conversations started from a highlight in the reader.
 *
 * Three entry points land here: typing into the reader's selection popup, asking
 * about a highlight that already exists, and reopening the conversation behind
 * one. The first two leave an anchor behind; the third loads the thread the
 * anchor points at.
 *
 * A question from a highlight continues the conversation already on screen, and
 * only starts a thread when there is none. Highlighting a second passage while a
 * chat is open is nearly always a follow-up, and starting over would discard the
 * context that makes it one. Several highlights anchoring to the same thread is
 * expected, not a conflict.
 *
 * The anchor is created before the message is sent, so the conversation has
 * somewhere to be reopened from even if the run fails. It is parked rather than
 * linked immediately: the runner reports the thread id at the start of every run
 * — existing thread or new one — and the report from the run that asks the
 * question is where the link is written. A question that waits in the composer
 * parks its anchor only once the run sending it has started, so a highlight
 * the user opens but never asks about does not end up claiming to belong to a
 * conversation. A question that never becomes a run takes its new anchor back,
 * and asking about a passage that already has one reuses it rather than
 * stacking a second highlight on it — without taking it from the conversation
 * it already opens.
 *
 * Every reader entry point stops at a library the user excluded from AlphainZ,
 * before it writes anything there or sends anything about it.
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';
import { isSelectionChatOrigin, type AgentRun, type PromptOrigin } from '@beaver/agent-core/agents/types';
import { activeRunAtom, currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';

import { isWSChatPendingAtom, isWSReadyAtom, sendWSMessageAtom, wsErrorAtom } from '../atoms/agentRunAtoms';
import { LOCAL_USER_ID, userAtom } from '../atoms/auth';
import {
    currentReaderAttachmentAtom,
    isReaderLibrarySearchable,
    readerTextSelectionAtom,
    stagedReaderPromptAtom,
    updateReaderAttachmentAtom,
    type StagedReaderPrompt,
} from '../atoms/messageComposition';
import { excludedLibraryIdsAtom, searchableLibraryIdsAtom } from '../atoms/profile';
import { loadThreadAtom, newThreadAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';
import type { BeaverEventDetail } from '../events/types';
import { store } from '../store';
import type { SelectionChatOutcome } from '../../src/modules/readerIntegration';
import {
    addExcludedLibraryPopupAtom,
    addPopupMessageAtom,
    EXCLUDED_LIBRARY_READER_POPUP_ID,
} from '../utils/popupMessageUtils';
import type { ReaderTextSelection } from '../utils/readerUtils';
import {
    clearPendingAnchor,
    discardAnchor,
    linkAnchorToThread,
    placeAnchor,
    stashPendingAnchor,
    threadForAnchor,
} from '../utils/selectionAnchors';
import { continueOrStartThread, deliverPrompt } from '../utils/readerChatDelivery';
import { useEventSubscription } from './useEventSubscription';
import { revealChatForReaderQuestion } from './useToggleSidebar';
import { t } from '../../src/utils/i18n';

/** The attachment the reader has open, loading it if the store is behind. */
async function resolveAttachment(readerItemID: number): Promise<Zotero.Item | null> {
    const staged = store.get(currentReaderAttachmentAtom);
    if (staged && staged.id === readerItemID) return staged;
    const item = await Zotero.Items.getAsync(readerItemID);
    return item ?? null;
}

/**
 * Make the reader's attachment the message's "Current File", unless it
 * already is.
 *
 * Through `updateReaderAttachmentAtom`, the one place that refuses an
 * attachment from an excluded library and stages the paper's highlights with
 * it — never by writing the atom directly.
 */
export async function ensureReaderAttachment(readerItemID: number): Promise<void> {
    const staged = store.get(currentReaderAttachmentAtom);
    if (staged && staged.id === readerItemID) return;
    await store.set(updateReaderAttachmentAtom, { itemID: readerItemID });
}

const READER_QUESTION_NOT_ASKED_POPUP_ID = 'reader-question-not-asked';

/**
 * Refuse a question asked from the reader about a file AlphainZ may not use,
 * and say why. Returns the reason when it refused, null when the question may
 * go ahead.
 *
 * Asked first, before anything else happens: past this point a popup question
 * places a highlight — a write into the library — and a question sent anyway
 * would have its passage and file stripped when it is sent, leaving the model
 * a bare "what does this mean?".
 *
 * A menu entry has nowhere of its own to give the reason, so the chat is shown
 * with a notice. For an excluded library that is the reader's own notice
 * about the file, by its id: the panel opening for it raises that notice too,
 * and one exclusion gets one notice. `notify: false` only returns the reason,
 * for the selection popup, which shows it under its field.
 */
export function refuseReaderQuestion(
    readerItemID: number,
    options: { notify?: boolean } = {},
): string | null {
    if (isReaderLibrarySearchable(store.get(searchableLibraryIdsAtom), { itemID: readerItemID })) {
        return null;
    }
    const notify = options.notify !== false;
    if (notify) revealChatForReaderQuestion();
    const libraryAndKey = Zotero.Items.getLibraryAndKeyFromID(readerItemID);
    const libraryID = libraryAndKey ? libraryAndKey.libraryID : null;
    if (libraryID !== null && store.get(excludedLibraryIdsAtom).includes(libraryID)) {
        if (notify) {
            store.set(addExcludedLibraryPopupAtom, {
                id: EXCLUDED_LIBRARY_READER_POPUP_ID,
                libraryIDs: [libraryID],
                title: t('Not asked'),
                // As long as the reader's notice would stay: until the user
                // leaves the tab or dismisses it.
                expire: false,
            });
        }
        return t('This library is excluded from AlphainZ. You can change that in AlphainZ Settings.');
    }
    // Not excluded, just not readable yet: the libraries are still being read.
    const reason = t('AlphainZ is still reading your Zotero libraries. Try again in a moment.');
    if (notify) {
        store.set(addPopupMessageAtom, {
            id: READER_QUESTION_NOT_ASKED_POPUP_ID,
            type: 'warning',
            title: t('Not asked'),
            text: reason,
            expire: true,
            duration: 4000,
        });
    }
    return reason;
}

function isPageIndex(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** An annotation's stored position, parsed; null when it has none. */
function parsePosition(position: unknown): Record<string, any> | null {
    if (position && typeof position === 'object') return position as Record<string, any>;
    if (typeof position !== 'string' || !position) return null;
    try {
        const parsed = JSON.parse(position);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function sameAnnotation(
    a: { libraryID: number; key: string },
    b: { libraryID: number; key: string },
): boolean {
    return a.libraryID === b.libraryID && a.key === b.key;
}

/** Whether a prompt's origin makes it a selection question about this highlight. */
function asksAbout(origin: PromptOrigin | undefined, anchor: { libraryID: number; key: string }): boolean {
    if (origin?.kind !== 'selection_chat') return false;
    return origin.annotation_key === anchor.key && origin.library_id === anchor.libraryID;
}

/**
 * A question about a highlight that waits in the composer — a popup question
 * staged while an answer was still being written, or the one the user is
 * about to type after "Chat about this highlight" — and the anchor it links
 * once it is asked.
 *
 * The anchor is parked when the run sending this question takes the active
 * slot, and that run's thread report links it. Parked any earlier it would go
 * to whichever run reported a thread next: an answer still being prepared, or
 * the next message sent in that chat after the question itself was deleted
 * from the composer — a highlight opening a chat that never had its question.
 */
let questionAwaitingSend: { anchor: Zotero.Item; stop: () => void } | null = null;

/** Stop waiting to link the anchor of the question waiting in the composer. */
export function stopAwaitingQuestionSend(): void {
    const awaiting = questionAwaitingSend;
    if (!awaiting) return;
    questionAwaitingSend = null;
    awaiting.stop();
}

/** Link this anchor through the run that asks its question, whenever that is. */
function awaitQuestionSend(entry: {
    annotation: Zotero.Item;
    attachment: Zotero.Item;
    selectedText: string;
}): void {
    stopAwaitingQuestionSend();
    // The answer being written now was asked before this question.
    const runBefore = store.get(activeRunAtom)?.id ?? null;
    const stop = store.sub(activeRunAtom, () => {
        const run = store.get(activeRunAtom);
        if (!run || run.id === runBefore) return;
        if (!asksAbout(run.user_prompt?.origin, entry.annotation)) return;
        stopAwaitingQuestionSend();
        stashPendingAnchor(entry);
    });
    questionAwaitingSend = { anchor: entry.annotation, stop };
}

/** Whether a question waiting in the composer is about this highlight. */
function isAwaitingSend(annotation: { libraryID: number; key: string }): boolean {
    return !!questionAwaitingSend && sameAnnotation(questionAwaitingSend.anchor, annotation);
}

/**
 * A question about an existing highlight that the user is about to type
 * ("Chat about this highlight"): the passage staged for it, and the origin
 * that makes the next message a selection question anchored to the highlight.
 *
 * It lasts as long as the passage stays staged. Taking the passage off the
 * message, selecting something else, asking from the reader again or leaving
 * the paper lets it go.
 */
let pendingHighlightQuestion: {
    selection: ReaderTextSelection;
    staged: StagedReaderPrompt;
    anchor: Zotero.Item;
} | null = null;

/**
 * Let go of a highlight question the user did not ask. Once asked — the
 * composer's send takes the staged origin with it — the question's own run
 * links the anchor, and nothing here is undone.
 */
export function releaseHighlightQuestion(): void {
    const pending = pendingHighlightQuestion;
    if (!pending) return;
    pendingHighlightQuestion = null;
    if (store.get(stagedReaderPromptAtom) !== pending.staged) return;
    store.set(stagedReaderPromptAtom, null);
    if (isAwaitingSend(pending.anchor)) stopAwaitingQuestionSend();
}

/** A popup question's run, once it has started: the thread it reported. */
interface RunStart {
    threadId: string | null;
}

/**
 * Hand a question over with `deliver`, and follow it until its run starts.
 *
 * `started` gives the thread the run reported once it has started — the
 * local runner reports its thread, and that it is ready, before it asks the
 * model anything — or null when the delivery settles first: the send was
 * turned away, stopped, or failed before its run started, as it does when no
 * model is set up on this computer. Only the ready flag going up after the
 * hand-over counts, and only for this question's run: the flag stays up after
 * a run has ended, and a send turned away at the door never lowers it.
 */
function deliverAndFollowRun<T>(
    deliver: () => Promise<T>,
    isThisQuestion: (run: AgentRun) => boolean,
): { delivery: Promise<T>; started: Promise<RunStart | null> } {
    let settle!: (start: RunStart | null) => void;
    const started = new Promise<RunStart | null>((resolve) => {
        settle = resolve;
    });
    const stop = store.sub(isWSReadyAtom, () => {
        if (!store.get(isWSReadyAtom)) return;
        const run = store.get(activeRunAtom);
        if (!run || !isThisQuestion(run)) return;
        stop();
        settle({ threadId: store.get(currentThreadIdAtom) });
    });
    const delivery = deliver();
    const over = () => {
        stop();
        settle(null);
    };
    delivery.then(over, over);
    return { delivery, started };
}

/** Why a popup question was not sent, in the chat panel's words when it has any. */
function notSentReason(errorBefore: unknown): string {
    const error = store.get(wsErrorAtom);
    const message = error && error !== errorBefore ? String(error.message ?? '').trim() : '';
    return message || t('AlphainZ did not send this question. Try again in a moment.');
}

/** The popup event as the reader integration sends it, with its reply channel. */
type SelectionChatDetail = BeaverEventDetail<'alphainSelectionChat'> & {
    pageIndex?: number;
    onOutcome?: (outcome: SelectionChatOutcome) => void;
};

/**
 * A prompt typed into the selection popup.
 *
 * Answers the popup through `onOutcome`: `sending` once it has the question,
 * then `sent` once the question's run has started — or the question back,
 * with the reason, when it was refused or turned away before its run started.
 * `staged` when an answer is still being written and the question waits in
 * the composer instead.
 */
export async function askFromSelectionPopup(
    detail: SelectionChatDetail,
    deps: {
        newThread: (options: { skipAutoPopulate: boolean }) => Promise<unknown>;
        sendWSMessage: (message: string, options?: { origin?: PromptOrigin }) => Promise<unknown>;
    },
): Promise<void> {
    const { prompt, selectedText, annotation, page, readerItemID } = detail;
    const respond = (outcome: SelectionChatOutcome) => {
        try {
            detail.onOutcome?.(outcome);
        } catch (error) {
            logger(`useSelectionChatHandler: could not answer the popup: ${error}`, 1);
        }
    };
    logger(`useSelectionChatHandler: selection chat for item ${readerItemID}`);

    try {
        // The popup gives the reason under its own field; nothing else opens.
        const refusal = refuseReaderQuestion(readerItemID, { notify: false });
        if (refusal) {
            respond({ status: 'failed', reason: refusal });
            return;
        }

        const attachment = await resolveAttachment(readerItemID);
        if (!attachment) {
            logger(`useSelectionChatHandler: attachment ${readerItemID} not found`, 1);
            respond({ status: 'failed', reason: t('AlphainZ could not find this file in your library.') });
            return;
        }

        releaseHighlightQuestion();

        // Anchor first. If this is left until after the run, a failed or
        // cancelled run leaves a conversation with no way back to it.
        const placed = await placeAnchor(attachment, annotation);
        const anchor = placed?.anchor ?? null;
        // The highlight already on the passage may open a conversation of its
        // own. It keeps that one: this question adds to the highlight without
        // taking it over (see `linkAnchorToThread`).
        const opensConversation = !!placed && !placed.created
            && !!(await threadForAnchor(placed.anchor.libraryID, placed.anchor.key));
        const anchorToLink = anchor && !opensConversation
            ? { annotation: anchor, attachment, selectedText }
            : null;

        revealChatForReaderQuestion();

        await continueOrStartThread(deps.newThread);

        const position = parsePosition(annotation?.position);
        const pageIndex = isPageIndex(detail.pageIndex)
            ? detail.pageIndex
            : isPageIndex(position?.pageIndex) ? position?.pageIndex : undefined;
        const selection: ReaderTextSelection = {
            text: selectedText,
            page: page ?? 1,
            ...(pageIndex !== undefined ? { page_index: pageIndex } : {}),
            ...(position ? { position } : {}),
        };
        store.set(readerTextSelectionAtom, selection);
        await ensureReaderAttachment(readerItemID);

        const origin: PromptOrigin = {
            kind: 'selection_chat',
            ...(anchor
                ? { annotation_key: anchor.key, library_id: anchor.libraryID }
                : {}),
        };

        // An answer is still being written: the question waits in the
        // composer, and its anchor for the run that sends it.
        if (store.get(isWSChatPendingAtom)) {
            await deliverPrompt(deps.sendWSMessage, prompt, { origin });
            if (anchorToLink) awaitQuestionSend(anchorToLink);
            respond({ status: 'staged' });
            return;
        }

        // Park the anchor for the thread id the run is about to report.
        const parked = anchorToLink ? stashPendingAnchor(anchorToLink) : null;

        respond({ status: 'sending' });
        const errorBefore = store.get(wsErrorAtom);
        const { delivery, started } = deliverAndFollowRun(
            () => deliverPrompt(deps.sendWSMessage, prompt, { origin }),
            (run) => run.user_prompt?.content === prompt && isSelectionChatOrigin(run.user_prompt?.origin),
        );
        const start = await started;
        if (start) {
            respond({ status: 'sent' });
            // Its thread report links the parked anchor. Should anything have
            // let go of it first, the question still belongs to that thread.
            if (anchorToLink && parked && parked.state !== 'linked' && start.threadId) {
                clearPendingAnchor(anchorToLink.annotation);
                await linkAnchorToThread({ ...anchorToLink, threadId: start.threadId });
            }
            return;
        }

        const outcome = await delivery.catch((error) => {
            logger(`useSelectionChatHandler: send failed: ${error}`, 1);
            return null;
        });
        if (outcome === 'staged') {
            respond({ status: 'staged' });
            return;
        }
        respond({ status: 'failed', reason: notSentReason(errorBefore) });

        // Turned away before its run started. A highlight placed for it would
        // open nothing, so it goes; one that was already there stays, and so
        // does one a question waiting in the composer is about.
        if (anchorToLink) clearPendingAnchor(anchorToLink.annotation);
        if (placed?.created && !isAwaitingSend(placed.anchor)) {
            await discardAnchor(placed.anchor);
        }
    } catch (error) {
        logger(`useSelectionChatHandler: selection chat failed: ${error}`, 1);
        respond({ status: 'failed', reason: t('Something went wrong. Try again.') });
    }
}

/**
 * A highlight was picked in the reader: reopen its conversation, or get ready
 * for a question about it.
 */
export async function chatAboutAnnotation(
    detail: BeaverEventDetail<'alphainChatAboutAnnotation'>,
    deps: {
        newThread: (options: { skipAutoPopulate: boolean }) => Promise<unknown>;
        loadThread: (options: { user_id: string; threadId: string; skipInstanceMismatchConfirm: boolean }) => Promise<unknown>;
    },
): Promise<void> {
    // Checked here rather than in the menu: the menu is built synchronously
    // and can only consult a best-effort mirror, so the authoritative lookup
    // belongs on this side. A highlight that already has a conversation
    // reopens it instead of starting a second one over the same passage.
    const existing = await threadForAnchor(detail.libraryId, detail.annotationKey);
    if (existing) {
        revealChatForReaderQuestion();
        const userId = store.get(userAtom)?.id ?? LOCAL_USER_ID;
        await deps.loadThread({
            user_id: userId,
            threadId: existing,
            skipInstanceMismatchConfirm: true,
        });
        return;
    }

    if (refuseReaderQuestion(detail.readerItemID)) return;

    const annotationItem = Zotero.Items.getByLibraryAndKey(
        detail.libraryId,
        detail.annotationKey,
    ) as Zotero.Item | false;
    if (!annotationItem || !annotationItem.isAnnotation()) return;
    const selectedText = annotationItem.annotationText || '';
    if (!selectedText.trim()) return;

    const attachment = await resolveAttachment(detail.readerItemID);
    if (!attachment) return;

    releaseHighlightQuestion();
    revealChatForReaderQuestion();
    await continueOrStartThread(deps.newThread);

    /*
     * The highlight is staged as the passage, located by its own position.
     *
     * Marked as a highlight: nothing is selected in the reader behind it —
     * picking the highlight cleared the selection — so the reader's selection
     * coming and going must not take it off the message.
     */
    const position = parsePosition(annotationItem.annotationPosition);
    const selection: ReaderTextSelection = {
        text: selectedText,
        page: Number(annotationItem.annotationPageLabel) || 1,
        ...(isPageIndex(position?.pageIndex) ? { page_index: position?.pageIndex } : {}),
        ...(position ? { position } : {}),
        highlight: {
            libraryID: annotationItem.libraryID,
            key: annotationItem.key,
            attachmentID: attachment.id,
        },
    };
    store.set(readerTextSelectionAtom, selection);
    await ensureReaderAttachment(detail.readerItemID);
    // The user moved on while the file was being staged (another paper, or
    // something else selected); there is no question to get ready for.
    if (store.get(readerTextSelectionAtom) !== selection) return;

    // The existing highlight is the anchor — no new one is created, so a
    // highlight the user made themselves keeps its own colour. It is linked
    // by the run that sends the question the user is about to type.
    awaitQuestionSend({ annotation: annotationItem, attachment, selectedText });

    // No prompt to send: the user opened this to type one. What they type is
    // a question about this highlight, asked the way the popup asks one — a
    // short answer, and the offer to save it into the highlight. The staged
    // origin carries that to the composer's next send; it has no text of its
    // own to match, so any message sent from the composer takes it.
    const staged: StagedReaderPrompt = {
        text: '',
        origin: {
            kind: 'selection_chat',
            annotation_key: annotationItem.key,
            library_id: annotationItem.libraryID,
        },
    };
    store.set(stagedReaderPromptAtom, staged);
    pendingHighlightQuestion = { selection, staged, anchor: annotationItem };

    eventManager.dispatch('focusInput', {});
}

/**
 * Keep a highlight question only as long as its passage stays on the message.
 * Returns the unsubscribe.
 */
export function watchHighlightQuestion(): () => void {
    return store.sub(readerTextSelectionAtom, () => {
        if (!pendingHighlightQuestion) return;
        if (store.get(readerTextSelectionAtom) === pendingHighlightQuestion.selection) return;
        releaseHighlightQuestion();
    });
}

export function useSelectionChatHandler() {
    const newThread = useSetAtom(newThreadAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const sendWSMessage = useSetAtom(sendWSMessageAtom);

    useEffect(() => watchHighlightQuestion(), []);

    // --- A prompt typed into the selection popup ---
    useEventSubscription(
        'alphainSelectionChat',
        (detail) => askFromSelectionPopup(detail, { newThread, sendWSMessage }),
        [newThread, sendWSMessage],
    );

    // --- Reopen the conversation behind a highlight ---
    useEventSubscription(
        'alphainReopenAnchor',
        async (detail) => {
            const threadId = await threadForAnchor(detail.libraryId, detail.annotationKey);
            if (!threadId) {
                logger(
                    `useSelectionChatHandler: no thread anchored to ${detail.annotationKey}`,
                    1,
                );
                return;
            }

            revealChatForReaderQuestion();
            const userId = store.get(userAtom)?.id ?? LOCAL_USER_ID;
            await loadThread({ user_id: userId, threadId, skipInstanceMismatchConfirm: true });
        },
        [loadThread],
    );

    // --- A highlight was picked in the reader: reopen, or start ---
    useEventSubscription(
        'alphainChatAboutAnnotation',
        (detail) => chatAboutAnnotation(detail, { newThread, loadThread }),
        [newThread, loadThread],
    );
}
