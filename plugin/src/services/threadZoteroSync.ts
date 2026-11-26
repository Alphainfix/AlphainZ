/**
 * Conversations, carried between machines by Zotero's own sync.
 *
 * The upstream plugin syncs threads through Beaver's backend
 * (`/api/v1/threads/...`), which is the dependency this fork exists to remove.
 * Zotero's sync is already paid for and already running, so the conversations
 * ride along with it instead — but only where it can see them.
 *
 * Zotero's file sync moves the `storage/<key>/` directory belonging to an
 * *attachment item*. Files dropped anywhere else in the data directory are
 * invisible to it, so "hide a file in the sync folder" is not an option: a
 * conversation has to be a real attachment to travel at all.
 *
 * So each thread is one JSON attachment, `<threadId>.json`, hanging off a
 * parent item found by tag — normally one; see `findParentItems` for when
 * there are two.
 *
 * ## The file has two layers, on purpose
 *
 * `messages` is the transcript in **OpenAI chat-completions form** — the shape
 * every coding agent already ingests. That is what makes the file useful away
 * from this plugin: hand it to Codex to draw a figure from, feed it to a
 * script, paste it into another model. A private shape would have made the
 * file a backup and nothing else.
 *
 * `runs` is our own payload, unabridged. Chat-completions cannot express what
 * this plugin needs back — citation tags bound to attachments, approval
 * records, reasoning parts, per-run usage — so restoring from `messages` alone
 * would quietly return a lesser conversation. It is the fidelity layer, and
 * the reason it sits last in the file is that nobody reads it by eye.
 *
 * Around both: a named envelope. `format` and `version` are there so a reader
 * can recognise the file and refuse one it does not understand, rather than
 * inferring from the presence of fields.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { BeaverDB } from './database';
import { runToMessages } from '@beaver/agent-llm/runRequestToMessages';
import { toOpenAIMessages } from '@beaver/agent-llm/openAICompatible';
import config from '../../package.json';

/**
 * Every run's transcript, flattened into one chat-completions conversation.
 *
 * A run that cannot be converted is skipped rather than aborting the export:
 * one malformed transcript should cost its own messages, not the whole file,
 * and `runs` still carries it verbatim either way.
 */
function portableMessages(runs: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const run of runs) {
        try {
            out.push(...toOpenAIMessages(runToMessages(run as any)));
        } catch (error) {
            logger(`threadZoteroSync: could not convert a run to messages: ${error}`, 1);
        }
    }
    return out;
}

export { CONVERSATIONS_TAG } from '../utils/conversationItems';
import { CONVERSATIONS_TAG, CONVERSATION_FILE } from '../utils/conversationItems';
export const CONVERSATIONS_TITLE = 'AlphainZ Conversations';

/** Bumped when the payload shape changes in a way a reader must notice. */
export const THREAD_EXPORT_VERSION = 1;

/** Identifies the file to anything that reads it. */
export const THREAD_EXPORT_FORMAT = 'alphainz.conversation';

export interface ThreadExport {
    /** Constant; lets a reader tell this file from any other JSON. */
    format?: string;
    version: number;
    generator?: { name: string; version: string };
    thread: {
        id: string;
        name: string;
        createdAt: string;
        updatedAt: string;
        zoteroUserId?: string | null;
        zoteroLocalId?: string | null;
        /*
         * Archive state, carried in the file for backends with no trash of
         * their own (a plain folder; the Zotero backend keeps using the item's
         * trash bit). Additive and optional: absent from older writers, and
         * absence means "no claim" — never "not archived".
         */
        archivedAt?: string | null;
        /*
         * The rolling summary standing in for the oldest runs, so the other
         * machine replays the same window this one does. Same additive
         * doctrine as archivedAt: absent from older writers means "no claim",
         * never "not compacted".
         */
        compaction?: {
            summary: string;
            throughRunId: string;
            createdAt: string;
            runCount: number;
        } | null;
    };
    /**
     * The transcript in OpenAI chat-completions form — portable, and the half
     * worth reading. Absent in files written before the format had it.
     */
    messages?: unknown[];
    /** Native payload, lossless, for restoring into the plugin. */
    runs: unknown[];
    /**
     * Runs taken out of this thread on purpose — by a retry, a regenerate or
     * an edit-and-resend — with when. The import only ever adds runs, so
     * without this another computer keeps a replaced answer and writes it
     * back. Additive: absent from older writers, and absence removes nothing.
     */
    removedRuns?: Array<{ id: string; deletedAt: string }>;
    /** Which machine wrote this copy, for the conflict note. */
    exportedBy: string;
    exportedAt: string;
}

/** The JSON one thread becomes. */
export async function serializeThread(
    db: BeaverDB,
    userId: string,
    threadId: string,
    exportedAt: string,
): Promise<ThreadExport | null> {
    const thread = await db.getThread(userId, threadId);
    if (!thread) return null;
    // A permanently deleted thread must not be re-exported by a detached
    // post-run tail (title mirror, compaction mirror). The tombstone loses
    // only to a copy edited after the deletion.
    const tombstone = await (db as any).threadTombstone?.(userId, threadId);
    if (typeof tombstone === 'string'
        && parseThreadTimestamp(tombstone) >= parseThreadTimestamp(thread.updatedAt)) {
        return null;
    }
    const runs = await db.getRunsForThread(threadId);
    const removed = await (db as any).runTombstonesForThread?.(threadId);
    return {
        format: THREAD_EXPORT_FORMAT,
        version: THREAD_EXPORT_VERSION,
        generator: { name: config.config.addonName, version: config.version },
        thread: {
            id: thread.id,
            name: thread.name,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            zoteroUserId: thread.zoteroUserId ?? null,
            zoteroLocalId: thread.zoteroLocalId ?? null,
            // Optional-safe: the structural fakes in tests carry no
            // threadArchivedAt, and a db without it simply omits the field.
            archivedAt: (await (db as any).threadArchivedAt?.(userId, threadId)) ?? null,
            compaction: (await (db as any).threadCompaction?.(userId, threadId)) ?? null,
        },
        // Portable first, native second: this is the half a person or another
        // tool actually reads, and `runs` is bulk.
        messages: portableMessages(runs),
        runs,
        ...(Array.isArray(removed)
            ? {
                removedRuns: removed.map((entry: { run_id: string; deleted_at: string }) => ({
                    id: entry.run_id,
                    deletedAt: entry.deleted_at,
                })),
            }
            : {}),
        exportedBy: String(Zotero.Users?.getLocalUserKey?.() ?? 'unknown'),
        exportedAt,
    };
}

/** Reject anything that is not a thread export before it reaches the database. */
export function parseThreadExport(text: string): ThreadExport | null {
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.thread?.id !== 'string' || !parsed.thread.id) return null;
    if (!Array.isArray(parsed.runs)) return null;
    // A newer writer may have added fields; a newer *version* may have changed
    // what the existing ones mean, and guessing is how a good thread gets
    // overwritten with a bad one.
    if (typeof parsed.version !== 'number' || parsed.version > THREAD_EXPORT_VERSION) return null;
    return parsed as ThreadExport;
}

/**
 * What a remote copy's text says about it, for a backfill deciding whether to
 * write over it: its `updatedAt`; `'unreadable'` for a conversation written by
 * a newer version of the plugin — another computer's work, in a shape this one
 * cannot read; or `'damaged'` when it is not a conversation file at all (cut
 * short, or not JSON), which leaves nothing for a write to lose.
 */
export function remoteCopyState(text: string): string | 'unreadable' | 'damaged' {
    const payload = parseThreadExport(text);
    if (payload) {
        const updatedAt = payload.thread.updatedAt;
        return typeof updatedAt === 'string' && updatedAt ? updatedAt : 'damaged';
    }
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.version === 'number' && parsed.version > THREAD_EXPORT_VERSION) return 'unreadable';
    } catch {
        // Not JSON at all.
    }
    return 'damaged';
}

/**
 * Which of two copies to keep.
 *
 * Last write wins on `updatedAt`, and a tie keeps what is already local —
 * re-importing an identical thread would rewrite every run for nothing.
 */
/**
 * Parse a thread timestamp from either of the two dialects this database has
 * ever held: ISO with a zone ("2026-08-28T19:33:57.041Z", written by exports
 * and imports) and SQLite's `datetime('now')` ("2026-08-28 15:44:35" — UTC,
 * but carrying NO zone marker).
 *
 * The naive form must be pinned to UTC by hand. `Date.parse` reads an
 * unzoned date-time as LOCAL time, so on any machine west of UTC every
 * locally-written row looked up to the UTC offset newer than it really was —
 * and silently outvoted legitimate imports for hours. (A Windows thread
 * refusing to appear on the Mac was this.)
 */
export function parseThreadTimestamp(value: string): number {
    const raw = String(value ?? '').trim();
    const naiveSqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (naiveSqlite.test(raw)) {
        return Date.parse(`${raw.replace(' ', 'T')}Z`);
    }
    return Date.parse(raw);
}

export function shouldImport(
    incoming: { updatedAt: string },
    local: { updatedAt: string } | null,
): boolean {
    if (!local) return true;
    return parseThreadTimestamp(incoming.updatedAt) > parseThreadTimestamp(local.updatedAt);
}

/** The file a thread lives in, and the title shown in Zotero. */
export function attachmentFilename(threadId: string): string {
    return `${threadId}.json`;
}

export function attachmentTitle(name: string, threadId: string): string {
    const trimmed = (name ?? '').trim();
    return trimmed ? trimmed.slice(0, 120) : `Conversation ${threadId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// The Zotero side
// ---------------------------------------------------------------------------

/** Oldest first, then by key: every computer has to pick the same parent. */
function compareParents(a: Zotero.Item, b: Zotero.Item): number {
    const byDate = String((a as any).dateAdded ?? '').localeCompare(String((b as any).dateAdded ?? ''));
    return byDate !== 0 ? byDate : String(a.key ?? '').localeCompare(String(b.key ?? ''));
}

/** The copy written last first: it is the one read, rewritten and believed. */
function compareNewestFirst(a: Zotero.Item, b: Zotero.Item): number {
    return String((b as any).dateModified ?? '').localeCompare(String((a as any).dateModified ?? ''));
}

/**
 * Every live "AlphainZ Conversations" item in the library, oldest first.
 *
 * Normally one. Two exist when a second computer wrote before Zotero had
 * delivered the first computer's item: each made its own, and both then
 * synced everywhere. Everything below treats all of them as one pool, so a
 * duplicate costs a second row in My Library and nothing else — reads see
 * the files under every parent, and writes put new files under the oldest,
 * which is the same item on every computer.
 *
 * Never creates anything: a read with nothing there reads nothing.
 */
export async function findParentItems(libraryID: number): Promise<Zotero.Item[]> {
    const search = new Zotero.Search();
    (search as any).libraryID = libraryID;
    search.addCondition('tag', 'is', CONVERSATIONS_TAG);
    // Every conversation attachment carries the tag too; only the parents
    // are wanted, and this is called on every read and write.
    search.addCondition('itemType', 'isNot', 'attachment');
    const ids = await search.search();
    const parents: Zotero.Item[] = [];
    for (const id of ids) {
        const item = await Zotero.Items.getAsync(id);
        if (item && !item.deleted && item.isRegularItem()) parents.push(item);
    }
    return parents.sort(compareParents);
}

/**
 * Whether Zotero may still be about to deliver another computer's items: a
 * sync is running, or this computer is linked to a Zotero account and has
 * never finished one. Creating the parent in that window is how a second one
 * comes to exist.
 */
export function zoteroMayStillDeliver(libraryID: number): boolean {
    try {
        if ((Zotero as any).Sync?.Runner?.syncInProgress) return true;
        if (!(Zotero as any).Users?.getCurrentUserID?.()) return false;
        return !(Zotero as any).Libraries?.get?.(libraryID)?.lastSync;
    } catch {
        return false;
    }
}

/**
 * The parent new files go under: the oldest live one, created only when the
 * library has none and Zotero is not in the middle of delivering one. Null
 * means "not now"; the next write tries again.
 *
 * Both bundles carry a copy of this module and can write at the same moment
 * on a fresh machine, so the creation in flight is shared through the Zotero
 * global rather than a module variable.
 */
export async function findOrCreateParentItem(libraryID: number): Promise<Zotero.Item | null> {
    const existing = await findParentItems(libraryID);
    if (existing.length > 0) return existing[0];
    if (zoteroMayStillDeliver(libraryID)) {
        logger('threadZoteroSync: not creating the conversations item while Zotero is still syncing', 3);
        return null;
    }

    const global = Zotero as any;
    const inFlight: Map<number, Promise<Zotero.Item>> =
        global.__alphainzConversationsParentCreation
        ?? (global.__alphainzConversationsParentCreation = new Map());
    const pending = inFlight.get(libraryID);
    if (pending) return pending;

    const creation = (async () => {
        // Looked for once more right before creating: another writer may
        // have finished its creation since the search above.
        const late = await findParentItems(libraryID);
        if (late.length > 0) return late[0];
        const item = new Zotero.Item('document');
        (item as any).libraryID = libraryID;
        item.setField('title', CONVERSATIONS_TITLE);
        item.setField(
            'abstractNote',
            'AlphainZ stores each conversation here as a JSON attachment so Zotero sync '
            + 'carries them between your machines. Deleting an attachment deletes that '
            + 'conversation on every device the next time they sync.',
        );
        item.addTag(CONVERSATIONS_TAG);
        await item.saveTx();
        logger(`threadZoteroSync: created the conversations item in library ${libraryID}`, 3);
        return item;
    })();
    inFlight.set(libraryID, creation);
    try {
        return await creation;
    } finally {
        inFlight.delete(libraryID);
    }
}

/** Every attachment under every parent in the pool; trashed ones only when asked. */
async function poolAttachments(libraryID: number, includeTrashed: boolean): Promise<Zotero.Item[]> {
    const out: Zotero.Item[] = [];
    for (const parent of await findParentItems(libraryID)) {
        const ids = parent.getAttachments(includeTrashed) ?? [];
        if (ids.length === 0) continue;
        const items = (await Zotero.Items.getAsync(ids)) as Zotero.Item[];
        for (const item of items) {
            if (!item) continue;
            if (!includeTrashed && item.deleted) continue;
            out.push(item);
        }
    }
    return out;
}

/**
 * The whole pool indexed by filename, trashed copies included — for a pass
 * that looks up many threads at once, so the library is walked once.
 */
export async function attachmentsByFilename(libraryID: number): Promise<Map<string, Zotero.Item[]>> {
    const byName = new Map<string, Zotero.Item[]>();
    for (const item of await poolAttachments(libraryID, true)) {
        const name = String((item as any).attachmentFilename ?? '');
        const list = byName.get(name);
        if (list) list.push(item); else byName.set(name, [item]);
    }
    return byName;
}

/**
 * Every attachment with exactly this filename across the pool, the copy
 * written last first. Trashed copies only when asked: to the archive they
 * are the thread; to a reader of settings they are gone.
 */
export async function findAttachmentsByFilename(
    libraryID: number,
    wanted: string,
    options: { includeTrashed?: boolean } = {},
): Promise<Zotero.Item[]> {
    const items = await poolAttachments(libraryID, !!options.includeTrashed);
    return items
        .filter((item) => (item as any).attachmentFilename === wanted)
        .sort(compareNewestFirst);
}

/** The live attachment with exactly this filename, written last, if any. */
export async function findAttachmentByFilename(
    libraryID: number,
    wanted: string,
): Promise<Zotero.Item | null> {
    return (await findAttachmentsByFilename(libraryID, wanted))[0] ?? null;
}

/**
 * The attachment holding one thread, archived (trashed) or not — the copy
 * written last when there are two.
 */
export async function findThreadAttachment(
    libraryID: number,
    threadId: string,
): Promise<Zotero.Item | null> {
    const matches = await findAttachmentsByFilename(
        libraryID,
        attachmentFilename(threadId),
        { includeTrashed: true },
    );
    return matches[0] ?? null;
}

/** Zotero knows the server holds a file this disk lacks or holds an older copy of. */
function isQueuedForDownload(item: Zotero.Item): boolean {
    const local = (Zotero as any).Sync?.Storage?.Local;
    if (!local) return false;
    const state = (item as any).attachmentSyncState;
    return state === local.SYNC_STATE_TO_DOWNLOAD || state === local.SYNC_STATE_FORCE_DOWNLOAD;
}

/** Ask Zotero to fetch an attachment's file, the way opening it would. */
async function downloadAttachmentFile(item: Zotero.Item): Promise<void> {
    try {
        const runner = (Zotero as any).Sync?.Runner;
        const local = (Zotero as any).Sync?.Storage?.Local;
        if (typeof runner?.downloadFile !== 'function') return;
        if (typeof local?.getEnabledForLibrary === 'function'
            && !local.getEnabledForLibrary(item.libraryID)) return;
        await runner.downloadFile(item);
    } catch (error) {
        logger(`threadZoteroSync: could not download ${item.key}: ${error}`, 1);
    }
}

/**
 * The attachment's file on this disk, fetched from Zotero's server first when
 * the server holds a newer one or the only one.
 *
 * With Zotero set to download files "as needed", nothing else ever fetches a
 * conversation written on another computer — nobody opens it — so this does
 * what opening it would. Null while there is still nothing current to read.
 * `forWrite` also refuses a stale local copy: writing over a file Zotero is
 * about to replace turns into a sync conflict. `download: false` only reads.
 */
export async function ensureAttachmentFile(
    item: Zotero.Item,
    options: { forWrite?: boolean; download?: boolean } = {},
): Promise<string | null> {
    const path = await (item as any).getFilePathAsync?.();
    if (!isQueuedForDownload(item)) return path || null;
    if (options.download !== false) {
        await downloadAttachmentFile(item);
        if (!isQueuedForDownload(item)) return (await (item as any).getFilePathAsync?.()) || null;
    }
    return options.forWrite ? null : (path || null);
}

/**
 * Tell Zotero the file underneath an attachment changed.
 *
 * Setting the state is the whole of it, and the two neighbouring fields are
 * both traps that were fallen into in turn:
 *
 * `attachmentSyncedModificationTime` throws on anything that is not a number.
 * Assigning `null` threw *after* the file had been written, so the new
 * conversation sat on disk while Zotero went on believing the attachment was
 * in sync, and never uploaded it.
 *
 * `attachmentSyncedHash` takes `null`, and clearing it is worse than useless:
 * that field records *what the server already has*, and it is how Zotero tells
 * "I changed this" from "we both changed this". Blanked, every ordinary edit
 * became an unresolvable-looking conflict, and the user was shown a Conflict
 * Resolution dialog for a file only this machine had ever written. Left alone,
 * it says "the server has X, here is Y" — which is the truth.
 *
 * Its own function so the contract can be tested without a Zotero item.
 */
export function markForUpload(attachment: { attachmentSyncState?: unknown }): void {
    attachment.attachmentSyncState = 'to_upload';
}

/**
 * Write one thread out, creating the attachment or replacing its contents.
 *
 * Replacing in place rather than delete-and-reimport: the attachment key is
 * what every other device already has, and churning it would look like a
 * deletion followed by an unrelated new file on the far side of a sync.
 *
 * Overwriting the file is not enough on its own. Zotero decides what to upload
 * from the stored hash and mtime, so a file changed underneath it reads as
 * unchanged; clearing both and setting the state to `to_upload` is what makes
 * the new contents travel.
 */
export async function writeThreadAttachment(
    db: BeaverDB,
    userId: string,
    threadId: string,
    libraryID: number,
    now: string,
): Promise<{ created: boolean; key: string } | null> {
    const payload = await serializeThread(db, userId, threadId, now);
    if (!payload) return null;

    const title = attachmentTitle(payload.thread.name, threadId);
    const json = JSON.stringify(payload, null, 2);

    /*
     * The trash bit is this backend's archive flag, so every write carries
     * the thread's archive state the way the folder backend's file carries
     * `archivedAt`: renaming a chat inside the archive leaves it there, and
     * sending a message in one (which restores it here) restores it
     * everywhere.
     */
    return writeJsonAttachmentFile(
        libraryID,
        attachmentFilename(threadId),
        title,
        json,
        { trashed: !!payload.thread.archivedAt },
    );
}

/**
 * Create or replace a JSON attachment by filename — the whole item dance in
 * one place, shared by threads and the settings document.
 *
 * Replace-in-place, and the `markForUpload` afterwards, are both load-bearing:
 * see the notes on `markForUpload` for the two sync-field traps, and on
 * `writeThreadAttachment` for why the attachment key must survive a rewrite.
 */
export async function writeJsonAttachmentFile(
    libraryID: number,
    filename: string,
    title: string,
    json: string,
    options: {
        /** Put the attachment in (true) or take it out of (false) Zotero's trash; absent leaves it. */
        trashed?: boolean;
    } = {},
): Promise<{ created: boolean; key: string } | null> {
    /*
     * Trashed copies count. An archived thread's attachment is in the trash,
     * and a lookup that skipped it would add a second, live copy with every
     * rename or answer inside the archive — which the archive reconcile would
     * then read as a restore.
     */
    const existing = (await findAttachmentsByFilename(libraryID, filename, { includeTrashed: true }))[0];
    if (existing) {
        const path = await ensureAttachmentFile(existing, { forWrite: true });
        if (!path) return null;
        await IOUtils.writeUTF8(path, json);
        if (existing.getField('title') !== title) existing.setField('title', title);
        if (options.trashed !== undefined && !!existing.deleted !== options.trashed) {
            existing.deleted = options.trashed;
        }
        markForUpload(existing);
        await existing.saveTx();
        return { created: false, key: existing.key };
    }

    const parent = await findOrCreateParentItem(libraryID);
    if (!parent) return null;

    // importFromFile copies the file into storage, so the source is temporary.
    const tmp = PathUtils.join(Zotero.getTempDirectory().path, filename);
    await IOUtils.writeUTF8(tmp, json);
    try {
        const attachment = await Zotero.Attachments.importFromFile({
            file: tmp,
            parentItemID: parent.id,
            title,
            contentType: 'application/json',
        });
        // Tagged so the item filters can tell it from a paper without walking
        // up to the parent. See `isConversationRecord`.
        attachment.addTag(CONVERSATIONS_TAG);
        if (options.trashed) attachment.deleted = true;
        await attachment.saveTx();
        return { created: true, key: attachment.key };
    } finally {
        try { await IOUtils.remove(tmp); } catch { /* best effort */ }
    }
}

/**
 * Reconcile the archive across machines, in both directions.
 *
 * Zotero's own trash is the signal, because it is already synced and already
 * means "removed but recoverable" — exactly what the archive is. Archiving
 * here trashes the attachment; the other machine sees a trashed attachment and
 * archives its own copy. Restoring from Zotero's trash on either machine puts
 * the conversation back on both.
 *
 * Without this the propagation was one-way: the import only ever added, so a
 * conversation deleted on Windows stayed in the Mac's history for good.
 */
export async function reconcileArchiveState(
    db: {
        threadArchivedAt: (u: string, id: string) => Promise<string | null | undefined>;
        archiveThread: (u: string, id: string, at: string) => Promise<void>;
        restoreThread: (u: string, id: string) => Promise<void>;
        getThread?: (u: string, id: string) => Promise<{ updatedAt: string } | null>;
    },
    userId: string,
    libraryID: number,
    now: string,
): Promise<{ archived: number; restored: number }> {
    let archived = 0;
    let restored = 0;
    try {
        /*
         * One decision per thread, made by the copy written last. A library
         * can hold a live attachment beside a trashed one with the same name;
         * applying each in turn would archive and restore the same thread in
         * one pass, with Zotero's sort order picking the winner.
         */
        const newest = new Map<string, Zotero.Item>();
        const items = (await poolAttachments(libraryID, true)).sort(compareNewestFirst);
        for (const item of items) {
            const filename = String((item as any).attachmentFilename ?? '');
            // Threads only — see listThreadAttachments for why not `.json`.
            if (!CONVERSATION_FILE.test(filename)) continue;
            const threadId = filename.slice(0, -'.json'.length);
            if (!newest.has(threadId)) newest.set(threadId, item);
        }
        for (const [threadId, item] of newest) {
            const localState = await db.threadArchivedAt(userId, threadId);
            // Nothing local to reconcile: the import handles that side.
            if (localState === undefined) continue;

            if (item.deleted && localState === null) {
                /*
                 * Trashed, while active here. Normally another computer
                 * archived it — unless this one has used the chat since (a
                 * message sent in an archived chat restores it here): then
                 * the later of the two wins, and this computer's state goes
                 * back into the attachment.
                 */
                if (await usedSince(db, userId, threadId, (item as any).dateModified)) {
                    await untrashThreadAttachment(threadId, libraryID);
                    continue;
                }
                await db.archiveThread(userId, threadId, now);
                archived += 1;
            } else if (!item.deleted && localState !== null) {
                /*
                 * Live, while archived here: a restore made elsewhere when the
                 * attachment changed after this computer archived the thread.
                 * An attachment untouched since then simply has not heard —
                 * the trash did not happen or has not synced — and gets this
                 * computer's state instead of undoing the archive.
                 */
                const changedAt = parseThreadTimestamp(String((item as any).dateModified ?? ''));
                const archivedAt = parseThreadTimestamp(String(localState));
                if (Number.isFinite(changedAt) && Number.isFinite(archivedAt) && changedAt <= archivedAt) {
                    await trashThreadAttachment(threadId, libraryID);
                    continue;
                }
                await db.restoreThread(userId, threadId);
                restored += 1;
            }
        }
    } catch (error) {
        logger(`threadZoteroSync: could not reconcile the archive: ${error}`, 1);
    }
    if (archived || restored) {
        logger(`threadZoteroSync: archive reconcile — ${archived} archived, ${restored} restored`, 3);
    }
    return { archived, restored };
}

/**
 * Whether this computer used a thread after a remote copy's time: the archive
 * reconcile's tie-breaker when the two disagree. An unknown time on either
 * side (a copy with no date, a database without the lookup) answers no, which
 * keeps the remote claim.
 */
export async function usedSince(
    db: { getThread?: (u: string, id: string) => Promise<{ updatedAt: string } | null> },
    userId: string,
    threadId: string,
    remoteTime: unknown,
): Promise<boolean> {
    const remote = parseThreadTimestamp(String(remoteTime ?? ''));
    if (!Number.isFinite(remote) || typeof db.getThread !== 'function') return false;
    const local = await db.getThread(userId, threadId);
    const used = local ? parseThreadTimestamp(local.updatedAt) : NaN;
    return Number.isFinite(used) && used > remote;
}

/**
 * Put a conversation's attachment back, when it is restored from the archive.
 *
 * Every copy with its name comes out of the trash, not just the first: a
 * trashed twin left behind would send the thread back to the archive on the
 * next reconcile, right after the "Restored" message.
 */
export async function untrashThreadAttachment(
    threadId: string,
    libraryID: number,
): Promise<boolean> {
    try {
        const matches = await findAttachmentsByFilename(
            libraryID,
            attachmentFilename(threadId),
            { includeTrashed: true },
        );
        for (const item of matches) {
            if (!item.deleted) continue;
            item.deleted = false;
            await item.saveTx();
        }
        return matches.length > 0;
    } catch (error) {
        logger(`threadZoteroSync: could not restore the attachment for ${threadId}: ${error}`, 1);
        return false;
    }
}

/**
 * Take a deleted conversation's attachment with it.
 *
 * Otherwise the next startup finds a file with no local thread, treats it as
 * something this machine has not seen, and imports it back — a conversation
 * the user deleted returns on the next launch, and again on the one after
 * that. Trashed rather than erased: this is the user's library, and Zotero's
 * trash is where deleting things puts them.
 */
export async function trashThreadAttachment(
    threadId: string,
    libraryID: number,
): Promise<boolean> {
    try {
        const live = await findAttachmentsByFilename(libraryID, attachmentFilename(threadId));
        if (live.length === 0) return false;
        for (const attachment of live) {
            attachment.deleted = true;
            await attachment.saveTx();
        }
        logger(`threadZoteroSync: trashed the attachment for ${threadId}`, 3);
        return true;
    } catch (error) {
        logger(`threadZoteroSync: could not trash the attachment for ${threadId}: ${error}`, 1);
        return false;
    }
}

/** Every live conversation attachment in the library, under any parent. */
export async function listThreadAttachments(libraryID: number): Promise<Zotero.Item[]> {
    const items = await poolAttachments(libraryID, false);
    return items.filter(
        // The exact `<uuid>.json` shape, not any `.json`: the same parent item
        // also carries `settings.json` (settings sync), and iCloud-style
        // conflict copies ("<uuid> 2.json") must never be read as threads.
        (item) => CONVERSATION_FILE.test(String((item as any).attachmentFilename ?? '')),
    );
}

/**
 * Conversation files this computer wrote that Zotero has still not uploaded
 * although a sync has finished since: the upload is failing (storage full,
 * file syncing off), and the other computers are not getting them.
 *
 * Nothing is counted while a sync runs. Zotero stamps the library's last sync
 * when its data is done, before the files go up, so mid-sync every file
 * written just before it looks stuck.
 */
export async function countStuckUploads(libraryID: number): Promise<number> {
    const local = (Zotero as any).Sync?.Storage?.Local;
    if (!local) return 0;
    if ((Zotero as any).Sync?.Runner?.syncInProgress) return 0;
    const lastSync = (Zotero as any).Libraries?.get?.(libraryID)?.lastSync;
    const lastSyncMs = lastSync instanceof Date ? lastSync.getTime() : Number(lastSync);
    if (!Number.isFinite(lastSyncMs) || lastSyncMs <= 0) return 0;
    let stuck = 0;
    for (const item of await poolAttachments(libraryID, false)) {
        const state = (item as any).attachmentSyncState;
        if (state !== local.SYNC_STATE_TO_UPLOAD && state !== local.SYNC_STATE_FORCE_UPLOAD) continue;
        const modified = parseThreadTimestamp(String((item as any).dateModified ?? ''));
        if (Number.isFinite(modified) && modified < lastSyncMs) stuck += 1;
    }
    return stuck;
}

/**
 * Take out of the local thread the runs the file says were removed on
 * purpose. Returns how many were still here.
 */
async function applyRemovedRuns(db: BeaverDB, payload: ThreadExport): Promise<number> {
    const apply = (db as any).applyRunRemovals;
    if (typeof apply !== 'function' || !Array.isArray(payload.removedRuns)) return 0;
    const removals = payload.removedRuns
        .filter((entry) => typeof entry?.id === 'string' && entry.id)
        .map((entry) => ({
            run_id: entry.id,
            deleted_at: typeof entry.deletedAt === 'string' ? entry.deletedAt : '',
        }));
    if (removals.length === 0) return 0;
    return apply.call(db, payload.thread.id, removals);
}

/**
 * Write one parsed export into the database, if it is newer than what we hold.
 *
 * The shared half of every backend's import: Zotero attachments and folder
 * files differ only in how the text is found and read — what happens to a
 * parsed envelope must not fork, or the two backends drift.
 */
export async function importParsedThread(
    db: BeaverDB,
    userId: string,
    payload: ThreadExport,
): Promise<'imported' | 'skipped' | 'unreadable'> {
    /*
     * A tombstone outranks any copy written up to the deletion moment: the
     * deletion was the user's last word on those bytes. A copy edited AFTER
     * the deletion is newer information — the thread revives, and the
     * tombstone is dropped first so saveRun's guard lets the rows through.
     */
    const tombstone = await (db as any).threadTombstone?.(userId, payload.thread.id);
    if (typeof tombstone === 'string') {
        if (parseThreadTimestamp(tombstone) >= parseThreadTimestamp(payload.thread.updatedAt)) {
            return 'skipped';
        }
        await (db as any).removeThreadTombstone?.(userId, payload.thread.id);
    }

    /*
     * Removals first, and whichever copy is newer: run ids are never reused,
     * so a marker is unambiguous — the user replaced that answer — even in a
     * file older than what is here. The markers are also what keep `saveRun`
     * below from putting those runs back.
     */
    let removedHere = 0;
    try {
        removedHere = await applyRemovedRuns(db, payload);
    } catch (error) {
        logger(`threadZoteroSync: could not apply run removals for ${payload.thread.id}: ${error}`, 1);
    }

    const local = await db.getThread(userId, payload.thread.id);
    if (!shouldImport(payload.thread, local)) return removedHere > 0 ? 'imported' : 'skipped';

    try {
        for (const run of payload.runs) {
            const record = run as any;
            if (!record?.id) continue;
            // Imported: the archive state travels on its own, through the
            // archive reconcile, never with the runs.
            await db.saveRun({
                id: record.id,
                thread_id: payload.thread.id,
                user_id: userId,
                created_at: record.created_at,
                payload: record,
            }, { imported: true });
        }
        // saveRun upserts the thread but leaves it unnamed; the name and the
        // timestamps are what the list view reads.
        await db.upsertThread({
            id: payload.thread.id,
            user_id: userId,
            name: payload.thread.name,
            created_at: payload.thread.createdAt,
            updated_at: payload.thread.updatedAt,
        });
        /*
         * Compaction rides the same whole-thread LWW as everything above —
         * unlike archive state it has no independent timeline, so no separate
         * reconcile pass. Applied only when the writer made a claim: an older
         * writer's file simply lacks the key, and clearing local state over
         * that would un-compact the thread on every sync from an old machine.
         */
        if ('compaction' in payload.thread) {
            await (db as any).setThreadCompaction?.(
                userId,
                payload.thread.id,
                payload.thread.compaction ?? null,
            );
        }
        return 'imported';
    } catch (error) {
        logger(`threadZoteroSync: could not import ${payload.thread.id}: ${error}`, 1);
        return 'unreadable';
    }
}

/** How many conversation files one import pass asks Zotero to download. */
const MAX_DOWNLOADS_PER_PASS = 50;

/**
 * Pull in anything this machine does not have, or has an older copy of.
 *
 * Runs after Zotero's own sync has had a chance to bring the files down, and
 * is safe to run again: `shouldImport` keeps whichever copy was written last,
 * and a tie changes nothing.
 */
export async function importThreadAttachments(
    db: BeaverDB,
    userId: string,
    libraryID: number,
): Promise<{ imported: number; skipped: number; unreadable: number; waiting: number }> {
    let imported = 0;
    let skipped = 0;
    let unreadable = 0;
    let waiting = 0;
    // Downloads are one request each; a first pass over a large history in
    // "as needed" mode fetches in instalments, a minute apart.
    let downloadsLeft = MAX_DOWNLOADS_PER_PASS;

    for (const attachment of await listThreadAttachments(libraryID)) {
        let payload: ThreadExport | null = null;
        try {
            const download = downloadsLeft > 0 && isQueuedForDownload(attachment);
            if (download) downloadsLeft -= 1;
            const path = await ensureAttachmentFile(attachment, { download });
            // Not on this disk yet: counted as skipped (the retry signal) and
            // as waiting (what the history footer reports).
            if (!path || !(await IOUtils.exists(path))) { skipped += 1; waiting += 1; continue; }
            payload = parseThreadExport(await IOUtils.readUTF8(path));
        } catch (error) {
            logger(`threadZoteroSync: could not read ${attachment.key}: ${error}`, 1);
        }
        if (!payload) { unreadable += 1; continue; }

        // A trashed attachment is the archive, not new material.
        if (attachment.deleted) { skipped += 1; continue; }

        const outcome = await importParsedThread(db, userId, payload);
        if (outcome === 'imported') imported += 1;
        else if (outcome === 'skipped') skipped += 1;
        else unreadable += 1;
    }

    logger(
        `threadZoteroSync: imported ${imported}, skipped ${skipped}, unreadable ${unreadable}, `
        + `waiting for download ${waiting}`,
        3,
    );
    return { imported, skipped, unreadable, waiting };
}
