/**
 * Dev-only entry points for the reader's anchored conversations.
 *
 * The three events these dispatch normally originate from a click in the
 * reader — typing into the selection popup, or a context-menu entry on a
 * highlight. None of that is reachable over HTTP, so without this seam the
 * anchor flow could only be checked by hand.
 *
 * The event payloads are the real ones; only the trigger is synthetic.
 */

import { logger } from '@beaver/agent-core/platform/logger';

import { eventManager } from '../../events/eventManager';
import { store } from '../../store';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { isWSChatPendingAtom } from '../../atoms/agentRunAtoms';

const SETTLE_TIMEOUT_MS = 60000;

async function waitFor(condition: () => boolean, timeoutMs = SETTLE_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return condition();
}

/**
 * Drive the selection popup's send path.
 *
 * `attachment_id` is a Zotero item id; `position` is what the reader would have
 * computed for the selection. A caller that omits the position gets a run with
 * no anchor, which is the degraded case worth being able to test too.
 */
export async function handleTestSelectionChatHttpRequest(request: any): Promise<any> {
    const { attachment_id, prompt, text, page, position } = request ?? {};
    if (!attachment_id || !prompt || !text) {
        return { ok: false, error: 'attachment_id, prompt and text are required' };
    }


    /*
     * A caller must supply a real position.
     *
     * This handler used to invent plausible-looking rects when none was given,
     * which produced highlights sitting in the wrong place on the page — visible
     * in the library, indistinguishable from a placement bug, and mine rather
     * than the product's. The reader always has a real position for a selection;
     * a test that cannot supply one should test the unanchored path explicitly.
     */
    if (position && !Array.isArray((position as any).rects)) {
        return { ok: false, error: 'position must carry a rects array from the reader' };
    }

    eventManager.dispatch('alphainSelectionChat', {
        prompt,
        selectedText: text,
        annotation: {
            type: 'highlight',
            text,
            color: '#ffd400',
            pageLabel: String(page ?? 1),
            sortIndex: `${String((page ?? 1) - 1).padStart(5, '0')}|000000|00000`,
            ...(position ? { position } : {}),
        },
        page,
        readerItemID: Number(attachment_id),
    });

    // The handler opens the sidebar, starts a thread and sends; the run being
    // pending is the first observable sign it got that far.
    await waitFor(() => store.get(isWSChatPendingAtom) === true, 10000);
    const settled = await waitFor(() => store.get(isWSChatPendingAtom) === false);

    const threadId = store.get(currentThreadIdAtom);
    return {
        ok: settled,
        thread_id: threadId,
        // Read back from the database rather than tracked in memory: the point of
        // the check is that the link was actually written.
        anchors: threadId ? await anchorsForThread(threadId, Number(attachment_id)) : [],
    };
}

/** Reopen the conversation behind a highlight. */
export async function handleTestReopenAnchorHttpRequest(request: any): Promise<any> {
    const { library_id, annotation_key } = request ?? {};
    if (library_id == null || !annotation_key) {
        return { ok: false, error: 'library_id and annotation_key are required' };
    }

    eventManager.dispatch('alphainReopenAnchor', {
        libraryId: Number(library_id),
        annotationKey: String(annotation_key),
    });

    const loaded = await waitFor(() => !!store.get(currentThreadIdAtom), 20000);
    return { ok: loaded, thread_id: store.get(currentThreadIdAtom) };
}

/**
 * The anchor rows pointing at one thread.
 *
 * The attachment comes from the caller, not from `currentReaderAttachmentAtom`.
 * That atom tracks the reader, and a headless driver has no reader tab open —
 * the tab tracker clears it, and the readback reported no anchor for a link that
 * had in fact been written.
 */
async function anchorsForThread(threadId: string, attachmentId: number): Promise<unknown[]> {
    const conn = (Zotero as any).AlphainZ?.db;
    if (!conn?.getThreadAnchorsForAttachment) return [];
    try {
        const attachment = await Zotero.Items.getAsync(attachmentId);
        if (!attachment) return [];
        const anchors = await conn.getThreadAnchorsForAttachment(
            attachment.libraryID,
            attachment.key,
        );
        return anchors.filter((anchor: any) => anchor.threadId === threadId);
    } catch (error) {
        logger(`testSelectionChatHandlers: anchor lookup failed: ${error}`, 1);
        return [];
    }
}
