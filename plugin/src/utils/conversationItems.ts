/**
 * The library items this plugin keeps for its own bookkeeping.
 *
 * Conversations mirrored into Zotero are real attachments — that is the only
 * way Zotero's file sync will carry them — which means every part of the
 * plugin that looks at library items can see them. They are not literature and
 * must never be offered as a source: selecting one (the "show this
 * conversation's JSON" button does exactly that) staged it as an attachment,
 * validation then rejected it, and the user got "File Removed — AlphainZ cannot
 * read other attachments" for a file the plugin had written itself.
 *
 * Kept in its own module so the item filters can recognise them without
 * importing the sync service, which drags in the whole message-conversion
 * chain behind it.
 */

/** Marks both the parent item and each conversation attachment under it. */
export const CONVERSATIONS_TAG = 'alphainz-conversations';

/**
 * A conversation attachment's filename: the thread's uuid, and `.json`.
 *
 * Specific enough that no paper will collide with it, and readable from the
 * attachment path alone.
 */
export const CONVERSATION_FILE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

/**
 * True for the plugin's own conversation records.
 *
 * The filename is checked first, and the tag second, which is the opposite of
 * the obvious order. `hasTag` calls `_requireData('tags')` and *throws* when
 * tags are not loaded — and the items reaching this filter often are not fully
 * loaded, so the tag check failed silently and the attachment sailed through:
 * the user was shown "File Removed — AlphainZ cannot read other attachments"
 * naming one of their own conversations, twice.
 *
 * The filename needs nothing loaded beyond the attachment path, applies to
 * files written before the tag existed and to those written by another
 * machine, and cannot throw. The tag is still consulted because the parent
 * item has no filename of its own.
 */
export function isConversationRecord(item: Zotero.Item | false): boolean {
    if (!item) return false;

    try {
        const filename = (item as any).attachmentFilename;
        if (typeof filename === 'string' && CONVERSATION_FILE.test(filename)) return true;
    } catch { /* not an attachment, or its path is not loaded */ }

    try {
        if (item.hasTag?.(CONVERSATIONS_TAG)) return true;
    } catch { /* tags not loaded — the filename above is the reliable path */ }

    try {
        const parent = (item as any).parentItem;
        if (parent?.hasTag?.(CONVERSATIONS_TAG)) return true;
    } catch { /* same */ }

    return false;
}
