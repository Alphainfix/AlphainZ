/**
 * Highlights that anchor a conversation.
 *
 * A conversation started from the reader gets a real Zotero highlight, and the
 * link between the two is stored locally. Zotero owns the durable half: the
 * highlight is stored and synced by the host, so it survives restarts and shows
 * up wherever the library goes. The plugin only has to remember which
 * conversation belongs to it.
 *
 * There is deliberately no synchronous cache of which highlights are anchored.
 * The reader builds its menus synchronously and cannot await a query, so a cache
 * was the only way to vary the menu label — but keeping it warm across restored
 * tabs, closed panels and plugin reloads proved fragile, and all it ever decided
 * was a label. The menu now shows one entry whose handler does the real lookup,
 * and an anchored passage is identifiable in the document anyway: anchors carry
 * their own highlight colour.
 */

import { logger } from '@beaver/agent-core/platform/logger';

import { ALPHAIN_ANCHOR_AUTHOR, ALPHAIN_ANCHOR_COLOR } from '../../src/constants/annotations';
import { markBeaverAnnotationWrite } from '../../src/services/annotations/beaverAnnotationRegistry';

/**
 * Save the reader's prospective annotation as a real highlight.
 *
 * The reader hands over a fully-formed annotation for the current selection —
 * position, sort index, page label — which is why the anchor is built from it
 * rather than re-derived by searching the document for the text: the same phrase
 * can occur several times, and only the reader knows which one is selected.
 *
 * Built as a `Zotero.Item` directly rather than through `saveFromJSON`, matching
 * how the rest of this plugin writes annotations. `saveFromJSON` expects a
 * complete round-tripped annotation and rejects a partial one, and the failure
 * arrives as a rejected promise with nothing on screen to explain it.
 *
 * Colour and author are the plugin's own: the author is what keeps the anchor
 * out of the observer that treats a new annotation as context for the current
 * message, which would otherwise attach the anchor to the very conversation
 * that created it.
 */
export async function createAnchorAnnotation(
    attachment: Zotero.Item,
    annotation: Record<string, any>,
): Promise<Zotero.Item | null> {
    if (!annotation?.position) {
        // Without a position there is nothing to anchor to. The conversation can
        // still happen; it just will not be reopenable from the page.
        logger('createAnchorAnnotation: annotation has no position, skipping anchor', 1);
        return null;
    }

    try {
        const item = new Zotero.Item('annotation');
        item.libraryID = attachment.libraryID;
        item.parentID = attachment.id;
        item.annotationType = 'highlight';
        item.annotationColor = ALPHAIN_ANCHOR_COLOR;
        item.annotationAuthorName = ALPHAIN_ANCHOR_AUTHOR;
        if (typeof annotation.text === 'string') item.annotationText = annotation.text;
        if (annotation.pageLabel != null) item.annotationPageLabel = String(annotation.pageLabel);
        if (annotation.sortIndex) {
            Object.assign(item, { annotationSortIndex: annotation.sortIndex });
        }
        item.annotationPosition =
            typeof annotation.position === 'string'
                ? annotation.position
                : JSON.stringify(annotation.position);

        // Registered as this plugin's own write, so the reader-sync observer does
        // not treat it as something the user just did by hand.
        markBeaverAnnotationWrite(item);
        await item.saveTx();
        return item;
    } catch (error) {
        logger(`createAnchorAnnotation: failed to save anchor: ${error}`, 1);
        return null;
    }
}

/**
 * A position as a comparable string: key by key, numbers to a tenth of a point,
 * so the same selection made twice compares equal. Accepts the serialized form
 * an annotation stores.
 */
function positionKey(position: unknown): string | null {
    let value = position;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object') return null;
    try {
        return JSON.stringify(value, (_key, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v));
    } catch {
        return null;
    }
}

/** Whether an item is an anchor highlight this plugin placed. */
function isAnchorHighlight(item: any): boolean {
    return !!item?.isAnnotation?.()
        && !item.deleted
        && item.annotationType === 'highlight'
        && item.annotationAuthorName === ALPHAIN_ANCHOR_AUTHOR;
}

/**
 * The anchor already covering this position on the attachment, if any.
 *
 * Asking about the same passage twice — again after a failed question, or a
 * follow-up from the popup — would otherwise stack a second magenta highlight
 * exactly on top of the first.
 */
export function findAnchorAt(attachment: Zotero.Item, position: unknown): Zotero.Item | null {
    const wanted = positionKey(position);
    if (!wanted) return null;
    let annotations: unknown[] = [];
    try {
        annotations = (attachment as any).getAnnotations?.() ?? [];
    } catch (error) {
        logger(`findAnchorAt: ${error}`, 1);
        return null;
    }
    for (const item of annotations) {
        if (!isAnchorHighlight(item)) continue;
        if (positionKey((item as any).annotationPosition) === wanted) return item as Zotero.Item;
    }
    return null;
}

/**
 * The anchor for a selection: the one already on that passage, or a new one.
 * `created` says which — only a highlight placed here may be taken back.
 */
export async function placeAnchor(
    attachment: Zotero.Item,
    annotation: Record<string, any>,
): Promise<{ anchor: Zotero.Item; created: boolean } | null> {
    const existing = findAnchorAt(attachment, annotation?.position);
    if (existing) return { anchor: existing, created: false };
    const anchor = await createAnchorAnnotation(attachment, annotation);
    return anchor ? { anchor, created: true } : null;
}

/**
 * Take back an anchor placed for a question that never became a conversation
 * — the run was turned away before it started, for example because this
 * computer has no key for the model. Left in place it would be a highlight
 * that opens nothing.
 *
 * Only an anchor that nothing has been written into and that no conversation
 * claims: once it has a comment, or a link, it is no longer only a leftover.
 */
export async function discardAnchor(anchor: Zotero.Item): Promise<boolean> {
    try {
        const item = Zotero.Items.getByLibraryAndKey(anchor.libraryID, anchor.key) as any;
        if (!item || !isAnchorHighlight(item)) return false;
        if (String(item.annotationComment ?? '').trim()) return false;
        if (isAnchorParked(item)) return false;
        if (await threadForAnchor(item.libraryID, item.key)) return false;
        await item.eraseTx();
        return true;
    } catch (error) {
        logger(`discardAnchor: ${error}`, 1);
        return false;
    }
}

/**
 * Record the highlight → conversation link, and mirror it for the reader.
 *
 * A highlight that already opens a conversation keeps opening that one: a
 * later question about the same passage, in this chat or another, adds to the
 * highlight without taking it from the conversation it was first asked in.
 * It is the rule every computer follows for the anchors it reads back from
 * stored runs, so two computers never disagree about which chat it opens.
 */
export async function linkAnchorToThread(options: {
    annotation: Zotero.Item;
    attachment: Zotero.Item;
    threadId: string;
    selectedText: string;
}): Promise<void> {
    const db = (Zotero as any).AlphainZ?.db;
    if (!db?.saveThreadAnchor) return;
    try {
        const existing = await db.getThreadAnchor?.(options.annotation.libraryID, options.annotation.key);
        if (existing?.threadId) return;
        await db.saveThreadAnchor({
            libraryId: options.annotation.libraryID,
            annotationKey: options.annotation.key,
            threadId: options.threadId,
            attachmentKey: options.attachment.key,
            selectedText: options.selectedText,
        });
    } catch (error) {
        logger(`linkAnchorToThread: ${error}`, 1);
    }
}

/**
 * An anchor waiting for its thread id.
 *
 * A new thread has no id until the run starts — `newThread` clears it and the
 * runner assigns one — so the anchor cannot be linked at the moment the
 * highlight is created. It is parked here and drained when the id arrives.
 *
 * Parked only for a run about to start: the one sending the question, or —
 * for a question waiting in the composer — the run that sends it, once it has
 * taken the active slot. Parked any earlier, it would go to whichever run
 * reported a thread next.
 *
 * Single-slot on purpose: only one conversation can be starting at a time, and a
 * queue would only let a stale entry attach itself to the wrong thread.
 */
let pendingAnchor:
    | {
        annotation: Zotero.Item;
        attachment: Zotero.Item;
        selectedText: string;
        parked: { state: ParkedAnchor['state'] };
    }
    | null = null;

/**
 * What became of one parked anchor: still `waiting` in the slot, `linked` to
 * the thread that claimed it, or `released` — cleared, or overtaken by a newer
 * anchor — without ever being linked. Lets whoever parked it tell, once its
 * question is over, whether the highlight got a conversation.
 */
export interface ParkedAnchor {
    readonly state: 'waiting' | 'linked' | 'released';
}

function sameAnnotation(a: { libraryID: number; key: string }, b: { libraryID: number; key: string }): boolean {
    return a.libraryID === b.libraryID && a.key === b.key;
}

export function stashPendingAnchor(entry: {
    annotation: Zotero.Item;
    attachment: Zotero.Item;
    selectedText: string;
}): ParkedAnchor {
    if (pendingAnchor) pendingAnchor.parked.state = 'released';
    const parked: { state: ParkedAnchor['state'] } = { state: 'waiting' };
    pendingAnchor = {
        annotation: entry.annotation,
        attachment: entry.attachment,
        selectedText: entry.selectedText,
        parked,
    };
    return parked;
}

/**
 * Empty the slot. Given an annotation, only when that is the anchor waiting
 * there — so a question can let go of its own anchor without taking a newer
 * question's with it.
 */
export function clearPendingAnchor(annotation?: { libraryID: number; key: string }): void {
    if (!pendingAnchor) return;
    if (annotation && !sameAnnotation(pendingAnchor.annotation, annotation)) return;
    pendingAnchor.parked.state = 'released';
    pendingAnchor = null;
}

/** Whether this annotation is the anchor waiting in the slot. */
export function isAnchorParked(annotation: { libraryID: number; key: string }): boolean {
    return !!pendingAnchor && sameAnnotation(pendingAnchor.annotation, annotation);
}

/** Link whatever anchor is waiting to the thread that just got its id. */
export async function drainPendingAnchor(threadId: string): Promise<void> {
    const entry = pendingAnchor;
    if (!entry) return;
    pendingAnchor = null;
    entry.parked.state = 'linked';
    await linkAnchorToThread({
        annotation: entry.annotation,
        attachment: entry.attachment,
        selectedText: entry.selectedText,
        threadId,
    });
}

/** The conversation behind a highlight, if there is one. */
export async function threadForAnchor(
    libraryId: number,
    annotationKey: string,
): Promise<string | null> {
    const db = (Zotero as any).AlphainZ?.db;
    if (!db?.getThreadAnchor) return null;
    try {
        const anchor = await db.getThreadAnchor(libraryId, annotationKey);
        return anchor?.threadId ?? null;
    } catch (error) {
        logger(`threadForAnchor: ${error}`, 1);
        return null;
    }
}
