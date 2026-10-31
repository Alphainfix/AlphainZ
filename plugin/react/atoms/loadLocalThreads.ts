/**
 * Listing conversations from the local database.
 *
 * `threadService` fetches the list over REST — Beaver kept threads on its
 * server. With the model running here the list lives on this machine, so these
 * are the local counterparts of the two calls the thread lists make: recent
 * conversations, and conversations that touched a particular paper.
 *
 * Instance scoping is deliberately absent. It exists upstream because one
 * account's threads can span several Zotero installs; a local database belongs
 * to exactly one, so every thread in it is this install's by construction.
 */

import { atom } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';
import { activeRunAtom, currentThreadIdAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { isRunActive } from '@beaver/agent-core/agents/types';

import { LOCAL_USER_ID } from './auth';
import { store } from '../store';
import { getPref, setPref } from '../../src/utils/prefs';
import { conversationSyncMode } from '../../src/services/conversationSync';
import { getConversationBackend } from '../../src/services/conversationSync';
import { importSettingsNow } from '../utils/settingsSyncClient';
import { isConversationRecord } from '../../src/utils/conversationItems';
import type { ThreadData } from './threads';
import { refreshThreadInPlaceAtom, threadsChangedAtom } from './threads';
import { pendingApprovalsAtom, removePendingApprovalsAtom } from '../agents/agentActions';
import { settleLocalApproval } from '../utils/localApprovals';

function db(): any | null {
    return (Zotero as any).AlphainZ?.db ?? null;
}

/** Recent conversations, newest first. */
export async function localRecentThreads(
    limit: number,
    userId = LOCAL_USER_ID,
    offset = 0,
): Promise<ThreadData[]> {
    const conn = db();
    if (!conn?.getThreadsPaginated) return [];
    try {
        const { threads } = await conn.getThreadsPaginated(userId, limit, offset);
        return threads;
    } catch (error) {
        logger(`localRecentThreads: ${error}`, 1);
        return [];
    }
}

/**
 * Conversations that referenced any of these items, newest first.
 *
 * The keys are a paper plus its attachments and notes: a conversation may have
 * referenced the PDF while the user is asking from the parent item, and either
 * should count as "this paper".
 */
export async function localThreadsForItem(
    libraryId: number,
    itemKeys: string[],
    limit: number,
): Promise<ThreadData[]> {
    const conn = db();
    if (!conn?.getThreadsForItems || itemKeys.length === 0) return [];
    try {
        return await conn.getThreadsForItems(libraryId, itemKeys, limit);
    } catch (error) {
        logger(`localThreadsForItem: ${error}`, 1);
        return [];
    }
}

/** What one conversation referenced, resolved to Zotero items. */
export async function localThreadReferences(threadId: string): Promise<Zotero.Item[]> {
    const conn = db();
    if (!conn?.getThreadItems) return [];
    try {
        const rows = await conn.getThreadItems(threadId);
        const items: Zotero.Item[] = [];
        for (const row of rows) {
            const item = Zotero.Items.getByLibraryAndKey(row.libraryId, row.itemKey) as
                | Zotero.Item
                | false;
            // A referenced item can be deleted after the fact; the conversation
            // is still valid, it just has one fewer resolvable reference.
            if (item) items.push(item);
        }
        return items;
    } catch (error) {
        logger(`localThreadReferences: ${error}`, 1);
        return [];
    }
}

/** Search conversations by name or by anything said in them. */
export async function localSearchThreads(
    query: string,
    limit: number,
    userId = LOCAL_USER_ID,
    offset = 0,
): Promise<ThreadData[]> {
    const conn = db();
    if (!conn?.searchThreadsLocal) return [];
    try {
        return await conn.searchThreadsLocal(userId, query, limit, offset);
    } catch (error) {
        logger(`localSearchThreads: ${error}`, 1);
        return [];
    }
}

/**
 * Rename a conversation.
 *
 * The open conversation's name is also held in memory, and that copy is what
 * saved notes are titled with — so renaming the open one updates it too, from
 * whichever list the rename came from.
 */
export async function localRenameThread(
    threadId: string,
    name: string,
    userId = LOCAL_USER_ID,
): Promise<void> {
    await db()?.renameThread?.(userId, threadId, name);
    if (store.get(currentThreadIdAtom) === threadId) {
        store.set(currentThreadNameAtom, name);
    }
    await mirrorThread(threadId, userId, 'rename');
}

/**
 * Rewrite a conversation's mirrored copy right now.
 *
 * The mirror was only written when an answer finished, so anything that
 * changed a conversation *between* answers never travelled — renaming one on
 * the Mac left the old title on Windows indefinitely, because nothing was
 * going to rewrite that file until the next question.
 *
 * Swallowed: a rename that succeeded locally must not report failure because
 * the library was busy, and the next answer rewrites the file anyway.
 */
async function mirrorThread(threadId: string, userId: string, why: string): Promise<void> {
    try {
        const backend = getConversationBackend();
        if (!backend) return;
        await backend.writeThread(db() as any, userId, threadId, new Date().toISOString());
    } catch (error) {
        logger(`mirrorThread(${why}): ${threadId}: ${error}`, 1);
    }
}

/** Delete a conversation and everything hanging off it. */
export async function localDeleteThread(
    threadId: string,
    userId = LOCAL_USER_ID,
): Promise<void> {
    /*
     * Archived, not destroyed.
     *
     * A conversation is work, and the delete button used to be the only door
     * out of the list with nothing behind it. It now goes to the archive, from
     * which it comes back whole — `thread_anchors` and `thread_items` are left
     * in place for exactly that reason.
     */
    await db()?.archiveThread?.(userId, threadId, new Date().toISOString());

    /*
     * Zotero's trash is the archive as far as the other machines are
     * concerned: it is already synced, and it already means "removed but
     * recoverable". Trashing the attachment is what makes the archive travel.
     */
    try {
        const backend = getConversationBackend();
        if (!backend) return;
        await backend.archiveThread(db() as any, userId, threadId, new Date().toISOString());
    } catch (error) {
        logger(`localDeleteThread: could not mirror the archive: ${error}`, 1);
    }
}

/**
 * Catch up with the mirrored conversations: archive state first, then new ones.
 *
 * This used to run only at startup, and Zotero's sync does not keep to that
 * schedule — a conversation written on the other machine arrived minutes
 * later, its file sitting in the library unread until the next launch. The
 * user watched the JSON appear in Zotero while the sidebar kept insisting the
 * conversation did not exist.
 *
 * Cheap enough to run whenever the history is opened: a few file reads, and
 * `shouldImport` makes every repeat a no-op.
 */
/**
 * What the history footer shows: whether a pass is running, and when one last
 * finished. The stamp survives restarts in a machine-local pref — it describes
 * this machine's last look, so it has no business in the synced settings.
 */
export const conversationSyncStatusAtom = atom<{ lastAt: string | null; running: boolean }>({
    lastAt: (() => {
        const stored = getPref('conversationSyncLastAt');
        return typeof stored === 'string' && stored ? stored : null;
    })(),
    running: false,
});

let conversationSyncInFlight: Promise<void> | null = null;
/** Files seen but not yet downloaded, which is what makes a retry worth doing. */
let conversationSyncPending = 0;
let conversationRetryTimer: number | null = null;

export function syncConversationsNow(userId = LOCAL_USER_ID): Promise<void> {
    // Opening the list twice in a second must not run two passes over the
    // same files, each writing what the other just wrote.
    if (conversationSyncInFlight) return conversationSyncInFlight;

    conversationSyncInFlight = (async () => {
        try {
            const database = db();
            if (!database) return;
            const backend = getConversationBackend();
            if (!backend) return;
            store.set(conversationSyncStatusAtom, (s: { lastAt: string | null; running: boolean }) => ({ ...s, running: true }));
            await backend.reconcileArchive(database as any, userId, new Date().toISOString());
            // Taken just before the import, so a change to the open
            // conversation can be told from any other arrival.
            const openThreadId = store.get(currentThreadIdAtom);
            const openBefore = openThreadId ? await threadStamp(database, userId, openThreadId) : null;
            const result = await backend.importAll(database as any, userId);
            const stamp = new Date().toISOString();
            setPref('conversationSyncLastAt', stamp);
            store.set(conversationSyncStatusAtom, { lastAt: stamp, running: false });
            // Only files still on their way are worth coming back for. A
            // backend that cannot tell those apart reports them within
            // `skipped`, together with the files this machine already has, so
            // there that count is a retry signal only when nothing was
            // imported.
            conversationSyncPending = result.waiting
                ?? (result.imported === 0 ? result.skipped : 0);
            scheduleConversationRetry(userId);
            if (result.imported > 0) {
                // The lists learn about new arrivals...
                store.set(threadsChangedAtom, (n: number) => n + 1);
                /*
                 * ...and so does the OPEN conversation, when it is one of
                 * them. Importing only writes the database, so a thread on
                 * screen would keep showing its stale runs until it was
                 * re-opened. Its runs are refreshed in place: the composer,
                 * the staged attachments and the scroll position are the
                 * user's, and a message half-typed while the other computer's
                 * answer arrives stays where it is. Never while a run is
                 * streaming here.
                 */
                if (
                    openThreadId
                    && store.get(currentThreadIdAtom) === openThreadId
                    && !isRunActive(store.get(activeRunAtom))
                ) {
                    const openAfter = await threadStamp(database, userId, openThreadId);
                    if (openAfter !== openBefore) {
                        void store.set(refreshThreadInPlaceAtom, { userId, threadId: openThreadId });
                    }
                }
            }
            /*
             * Settings ride the same triggers as conversations: whatever just
             * caused a catch-up pass (history opened, notifier fired, folder
             * poll ticked) is also the moment a newer settings document would
             * have arrived.
             */
            try {
                await importSettingsNow();
            } catch (error) {
                logger(`syncConversationsNow: settings import failed: ${error}`, 1);
            }
        } catch (error) {
            logger(`syncConversationsNow: ${error}`, 1);
        } finally {
            store.set(conversationSyncStatusAtom, (s: { lastAt: string | null; running: boolean }) => ({ ...s, running: false }));
            conversationSyncInFlight = null;
        }
    })();
    return conversationSyncInFlight;
}

/**
 * What an import would change about a thread: when its row was last updated,
 * its name, and which runs it holds. The runs count on their own because an
 * import can take out answers a retry replaced, from a copy older than the
 * local one, without touching the row. Null when there is no such thread.
 */
async function threadStamp(database: any, userId: string, threadId: string): Promise<string | null> {
    try {
        const thread = await database.getThread?.(userId, threadId);
        if (!thread) return null;
        const runIds: string[] = (await database.getRunIdsForThread?.(threadId)) ?? [];
        return JSON.stringify([thread.updatedAt ?? null, thread.name ?? null, runIds]);
    } catch (error) {
        logger(`syncConversationsNow: could not read thread ${threadId}: ${error}`, 1);
        return null;
    }
}

/**
 * Come back for files Zotero has not finished fetching.
 *
 * The item arrives before its file does — Zotero syncs metadata and storage
 * separately — so a conversation can be known about for minutes before it can
 * be read. One retry a minute while anything is outstanding, and none at all
 * once everything readable has been read.
 */
function scheduleConversationRetry(userId: string): void {
    const win = Zotero.getMainWindow();
    if (!win) return;
    if (conversationRetryTimer !== null) {
        win.clearTimeout(conversationRetryTimer);
        conversationRetryTimer = null;
    }
    if (conversationSyncPending === 0) return;
    conversationRetryTimer = win.setTimeout(() => {
        conversationRetryTimer = null;
        void syncConversationsNow(userId);
    }, 60_000);
}

/**
 * Follow Zotero's own sync instead of guessing when it has finished.
 *
 * Importing at startup was wrong for the reason the user gave: Zotero does not
 * sync that fast. A conversation written on the other machine landed in the
 * library minutes later, and nothing looked at it again until the next launch.
 *
 * The notifier fires when the item arrives, which is the earliest this can
 * know; debounced because a sync delivers items in bursts, and paired with the
 * retry above because the file follows the item rather than arriving with it.
 */
export function watchForSyncedConversations(userId = LOCAL_USER_ID): () => void {
    let debounce: number | null = null;
    const observer = {
        notify: (event: string, type: string, ids: (number | string)[]) => {
            if (type !== 'item') return;
            if (event !== 'add' && event !== 'modify' && event !== 'trash') return;
            // The item notifier is a Zotero-backend signal only; the folder
            // backend has its own triggers (startup, history open, retry).
            if (conversationSyncMode() !== 'zotero') return;
            const win = Zotero.getMainWindow();
            if (!win) return;
            // Only for our own files: every item edit in the library would
            // otherwise re-read every conversation.
            const touchesConversations = ids.some((id) => {
                try {
                    const item = Zotero.Items.get(id as number);
                    return item ? isConversationRecord(item) : false;
                } catch { return false; }
            });
            if (!touchesConversations) return;
            if (debounce !== null) win.clearTimeout(debounce);
            debounce = win.setTimeout(() => {
                debounce = null;
                void syncConversationsNow(userId);
            }, 2000);
        },
    };
    const handle = Zotero.Notifier.registerObserver(
        observer, ['item'], 'alphainz-conversation-sync',
    );
    return () => {
        try { Zotero.Notifier.unregisterObserver(handle); } catch { /* already gone */ }
    };
}

/** Take a conversation back out of the archive, here and everywhere. */
export async function localRestoreThread(
    threadId: string,
    userId = LOCAL_USER_ID,
): Promise<void> {
    await db()?.restoreThread?.(userId, threadId);
    try {
        const backend = getConversationBackend();
        if (!backend) return;
        await backend.restoreThread(db() as any, userId, threadId, new Date().toISOString());
    } catch (error) {
        logger(`localRestoreThread: could not mirror the restore: ${error}`, 1);
    }
}

/** The archive, most recently archived first. */
export async function localArchivedThreads(
    userId = LOCAL_USER_ID,
): Promise<ThreadData[]> {
    return (await db()?.getArchivedThreads?.(userId, 200)) ?? [];
}

/**
 * Erase a conversation for good — the archive's own delete.
 *
 * The tombstone is written FIRST: the detached post-run tails (title mirror,
 * compaction) and the sync import all consult it, so a row delete alone would
 * quietly come back from any surviving copy — the folder JSON, the loaded UI
 * state, or another machine. With the tombstone, deletion is the newest fact
 * about the thread and outranks every copy written before it.
 *
 * The sync backend then removes its copy for good and records the deletion
 * where the other computers read it, so they delete theirs: on the Zotero
 * backend every copy of the thread's attachment is erased, trashed ones too.
 */
export async function localPurgeThread(
    threadId: string,
    userId = LOCAL_USER_ID,
): Promise<void> {
    const deletedAt = new Date().toISOString();
    await (db() as any)?.addThreadTombstone?.(userId, threadId, deletedAt);
    await db()?.deleteThread?.(userId, threadId);
    settleProposalsOfErasedThread(threadId);
    try {
        const backend = getConversationBackend();
        await backend?.purgeThread?.(db() as any, userId, threadId, deletedAt);
    } catch (error) {
        logger(`localPurgeThread: could not propagate the deletion: ${error}`, 1);
    }
}

/**
 * Proposals still waiting in a conversation that has been erased go with it.
 *
 * Their records went with the chat, but their cards would stay listed under it
 * ("N proposed changes in …", with an Open that leads to an empty chat).
 * Settling drops each card without writing or recording anything.
 */
function settleProposalsOfErasedThread(threadId: string): void {
    const erased = [...store.get(pendingApprovalsAtom).values()]
        .filter((approval) => approval.threadId === threadId);
    if (erased.length === 0) return;
    for (const approval of erased) settleLocalApproval(approval.actionId);
    store.set(removePendingApprovalsAtom, erased.map((approval) => approval.actionId));
}
