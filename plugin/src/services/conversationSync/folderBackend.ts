/**
 * The plain-folder backend: conversations are files in a directory the user
 * chose, and whatever cloud client watches that directory does the moving.
 * The plugin never knows or cares which — the Obsidian model.
 *
 * Layout:
 *   <folder>/conversations/<uuid>.json     one file per thread
 *   <folder>/settings.json                 the settings envelope
 *
 * Archive state travels IN the file (`thread.archivedAt`) because a folder
 * has no trash of its own — that field is this backend's whole reason the
 * envelope grew it.
 */
import { logger } from '@beaver/agent-core/platform/logger';
import type { BeaverDB } from '../database';
import {
    importParsedThread,
    parseThreadExport,
    parseThreadTimestamp,
    remoteCopyState,
    serializeThread,
    usedSince,
} from '../threadZoteroSync';
import { CONVERSATION_FILE } from '../../utils/conversationItems';
import {
    DELETED_LEDGER_FILENAME,
    recordDeletion,
    syncDeletionLedger,
    type LedgerIO,
} from './deletionLedger';
import { recordPassHealth, recordWriteOutcome } from './syncHealth';
import type { ConversationBackend, ImportCounts, SettingsDocumentPresence } from './types';

const SETTINGS_FILENAME = 'settings.json';

/*
 * The deletion ledger (`deleted-threads.json`, see deletionLedger.ts) lives
 * BESIDE the conversations dir, not inside it: `listConversationFiles` counts
 * any non-UUID json in there as an iCloud conflict copy, and older plugin
 * versions scan that dir too.
 */

/**
 * Read a file that may not really be here.
 *
 * A cloud-synced folder can hold evicted placeholders — iCloud especially —
 * and reading one can stall while the client re-downloads it, or fail
 * outright. The race keeps one slow file from stalling the whole import; the
 * caller counts a timeout as `skipped`, which arms the existing retry, and by
 * the retry the download has usually finished.
 */
async function readUTF8WithTimeout(path: string, ms = 5000): Promise<string | null> {
    try {
        const read = IOUtils.readUTF8(path);
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
        return await Promise.race([read, timeout]);
    } catch {
        return null;
    }
}

/** iCloud's stand-in for a conversation file it has not downloaded: ".<uuid>.json.icloud". */
function isCloudPlaceholder(name: string): boolean {
    return name.startsWith('.') && name.endsWith('.icloud')
        && CONVERSATION_FILE.test(name.slice(1, -'.icloud'.length));
}

export class FolderConversationBackend implements ConversationBackend {
    readonly kind = 'folder' as const;

    constructor(private readonly folderPath: string) {}

    private get conversationsDir(): string {
        return PathUtils.join(this.folderPath, 'conversations');
    }

    private threadPath(threadId: string): string {
        return PathUtils.join(this.conversationsDir, `${threadId}.json`);
    }

    private get ledgerPath(): string {
        return PathUtils.join(this.folderPath, DELETED_LEDGER_FILENAME);
    }

    /** The deletion ledger as a plain file beside the conversations dir. */
    private ledgerIO(): LedgerIO {
        return {
            read: async () => {
                if (!(await IOUtils.exists(this.ledgerPath).catch(() => false))) {
                    // iCloud knows the ledger but has not downloaded it: there,
                    // and not to be replaced by one holding only this
                    // computer's deletions.
                    const placeholder = PathUtils.join(this.folderPath, `.${DELETED_LEDGER_FILENAME}.icloud`);
                    const evicted = await IOUtils.exists(placeholder).catch(() => false);
                    return { present: evicted, text: null };
                }
                return { present: true, text: await readUTF8WithTimeout(this.ledgerPath) };
            },
            write: async (json) => {
                try {
                    await IOUtils.makeDirectory(this.folderPath, {
                        createAncestors: true,
                        ignoreExisting: true,
                    });
                    await IOUtils.writeUTF8(this.ledgerPath, json);
                    return true;
                } catch (error) {
                    logger(`folderBackend: could not write deletion ledger: ${error}`, 1);
                    return false;
                }
            },
            removeRemoteCopy: async (threadId, deletedAt) => {
                const path = this.threadPath(threadId);
                if (!(await IOUtils.exists(path).catch(() => false))) return;
                const text = await readUTF8WithTimeout(path);
                const payload = text === null ? null : parseThreadExport(text);
                // Unreadable this pass, or edited after the deletion: kept.
                if (!payload) return;
                if (parseThreadTimestamp(payload.thread.updatedAt) > parseThreadTimestamp(deletedAt)) return;
                await IOUtils.remove(path).catch(() => {});
            },
        };
    }

    async writeThread(db: BeaverDB, userId: string, threadId: string, now: string): Promise<boolean> {
        try {
            const payload = await serializeThread(db, userId, threadId, now);
            if (!payload) return false;
            await IOUtils.makeDirectory(this.conversationsDir, {
                createAncestors: true,
                ignoreExisting: true,
            });
            await IOUtils.writeUTF8(this.threadPath(threadId), JSON.stringify(payload, null, 2));
            recordWriteOutcome(true);
            return true;
        } catch (error) {
            logger(`folderBackend: could not write ${threadId}: ${error}`, 1);
            recordWriteOutcome(false, `Could not write to the sync folder: ${error}`);
            return false;
        }
    }

    /*
     * Archive and restore are the same operation here: the caller flipped the
     * database row first, and rewriting the file embeds the new `archivedAt`.
     * One code path; no partial edits of a file another machine may be reading.
     */
    async archiveThread(db: BeaverDB, userId: string, threadId: string, now: string): Promise<boolean> {
        return this.writeThread(db, userId, threadId, now);
    }

    async restoreThread(db: BeaverDB, userId: string, threadId: string, now: string): Promise<boolean> {
        return this.writeThread(db, userId, threadId, now);
    }

    /**
     * Every exactly-named conversation file, with conflict copies and
     * not-yet-downloaded cloud placeholders counted.
     */
    private async listConversationFiles(): Promise<{
        paths: string[];
        conflictCopies: number;
        placeholders: number;
    }> {
        const children = await IOUtils.getChildren(this.conversationsDir).catch(() => [] as string[]);
        const paths: string[] = [];
        let conflictCopies = 0;
        let placeholders = 0;
        for (const child of children) {
            const name = PathUtils.filename(child);
            if (CONVERSATION_FILE.test(name)) {
                paths.push(child);
            } else if (isCloudPlaceholder(name)) {
                // ".<uuid>.json.icloud": iCloud knows the file but has not
                // downloaded it. Nothing to read until it has.
                placeholders += 1;
            } else if (name.endsWith('.json')) {
                /*
                 * "<uuid> 2.json" is what iCloud leaves after a sync conflict.
                 * Importing it would double a conversation under a broken id;
                 * deleting it would destroy the user's tie-breaker. Count it,
                 * name it, leave it.
                 */
                conflictCopies += 1;
                logger(`folderBackend: ignoring conflict copy ${name}`, 2);
            }
        }
        return { paths, conflictCopies, placeholders };
    }

    async importAll(db: BeaverDB, userId: string): Promise<ImportCounts> {
        const counts: ImportCounts = { imported: 0, skipped: 0, unreadable: 0, conflictCopies: 0, waiting: 0 };
        // Missing folder = unplugged drive, moved, or not created yet. Never
        // create the tree from the read path; report nothing to do — and say
        // so when the sync folder itself is gone, which a new, empty one is not.
        if (!(await IOUtils.exists(this.conversationsDir).catch(() => false))) {
            const folderMissing = !(await IOUtils.exists(this.folderPath).catch(() => false));
            recordPassHealth({
                waiting: 0, unreadable: 0, conflictCopies: 0,
                folderMissing, fileSyncOff: false, stuckUploads: 0,
            });
            return counts;
        }

        // Deletions first: a file outranked by a tombstone must not be
        // imported below, and stale local copies leave now.
        await syncDeletionLedger(db, userId, this.ledgerIO());

        const { paths, conflictCopies, placeholders } = await this.listConversationFiles();
        counts.conflictCopies = conflictCopies;
        counts.skipped += placeholders;
        counts.waiting! += placeholders;

        for (const path of paths) {
            // Stat first: an evicted placeholder often fails here cheaply,
            // before the read would stall.
            const stat = await IOUtils.stat(path).catch(() => null);
            if (!stat) { counts.skipped += 1; counts.waiting! += 1; continue; }
            const text = await readUTF8WithTimeout(path);
            if (text === null) { counts.skipped += 1; counts.waiting! += 1; continue; }

            const payload = parseThreadExport(text);
            if (!payload) { counts.unreadable += 1; continue; }
            // A tombstoned thread's stray file: importParsedThread would skip
            // it anyway, but only this layer can also delete the file so the
            // other machines stop seeing it.
            const tombstone = await (db as any).threadTombstone?.(userId, payload.thread.id);
            if (typeof tombstone === 'string'
                && parseThreadTimestamp(tombstone) >= parseThreadTimestamp(payload.thread.updatedAt)) {
                await IOUtils.remove(path).catch(() => {});
                counts.skipped += 1;
                continue;
            }
            // Archived remotely and never seen locally: nothing to resurrect —
            // the mirror of the Zotero path skipping trashed attachments.
            const local = await db.getThread(userId, payload.thread.id);
            if (!local && payload.thread.archivedAt) { counts.skipped += 1; continue; }

            const outcome = await importParsedThread(db, userId, payload);
            counts[outcome === 'imported' ? 'imported' : outcome === 'skipped' ? 'skipped' : 'unreadable'] += 1;
        }
        logger(
            `folderBackend: imported ${counts.imported}, skipped ${counts.skipped}, `
            + `unreadable ${counts.unreadable}, conflict copies ${counts.conflictCopies}, `
            + `waiting ${counts.waiting}`,
            3,
        );
        recordPassHealth({
            waiting: counts.waiting ?? 0,
            unreadable: counts.unreadable,
            conflictCopies: counts.conflictCopies,
            folderMissing: false,
            fileSyncOff: false,
            stuckUploads: 0,
        });
        return counts;
    }

    async reconcileArchive(db: BeaverDB, userId: string, now: string) {
        let archived = 0;
        let restored = 0;
        if (!(await IOUtils.exists(this.conversationsDir).catch(() => false))) {
            return { archived, restored };
        }
        const { paths } = await this.listConversationFiles();
        for (const path of paths) {
            const text = await readUTF8WithTimeout(path);
            if (text === null) continue;
            const payload = parseThreadExport(text);
            if (!payload) continue;
            const threadId = payload.thread.id;

            // A tombstoned thread has no archive state to reconcile, and the
            // stale-file push-back below must not re-export it.
            const tombstone = await (db as any).threadTombstone?.(userId, threadId);
            if (typeof tombstone === 'string'
                && parseThreadTimestamp(tombstone) >= parseThreadTimestamp(payload.thread.updatedAt)) {
                continue;
            }

            /*
             * `archivedAt` absent = an older writer with no opinion; never
             * treat silence as "restore".
             */
            const incoming = payload.thread.archivedAt;
            if (incoming === undefined) continue;

            const localState = await (db as any).threadArchivedAt?.(userId, threadId);
            // Nothing local to reconcile: the import handles that side.
            if (localState === undefined) continue;

            if (incoming && localState === null) {
                /*
                 * Archived in the file, active here. Normally another machine
                 * archived it — unless this one has used the chat since (a
                 * message sent in an archived chat restores it here): then
                 * the later of the two wins, and this machine's state goes
                 * into the file, the same time rule as the restore below.
                 */
                if (await usedSince(db, userId, threadId, payload.exportedAt)) {
                    await this.writeThread(db, userId, threadId, now);
                    continue;
                }
                await (db as any).archiveThread(userId, threadId, now);
                archived += 1;
            } else if (!incoming && localState) {
                /*
                 * The file claims "not archived" while we archived it. The
                 * Zotero backend gets ordering for free from Zotero's sync; a
                 * plain folder does not, so decide by time: a file written
                 * after our archive action is a genuine restore from another
                 * machine; an older file is just stale — push our state into
                 * it instead of resurrecting the thread.
                 */
                if (Date.parse(payload.exportedAt) > Date.parse(String(localState))) {
                    await (db as any).restoreThread(userId, threadId);
                    restored += 1;
                } else {
                    await this.writeThread(db, userId, threadId, now);
                }
            }
        }
        if (archived || restored) {
            logger(`folderBackend: archive reconcile — archived ${archived}, restored ${restored}`, 3);
        }
        return { archived, restored };
    }

    async readSettingsDocument(): Promise<string | null> {
        const path = PathUtils.join(this.folderPath, SETTINGS_FILENAME);
        if (!(await IOUtils.exists(path).catch(() => false))) return null;
        return readUTF8WithTimeout(path);
    }

    async settingsDocumentPresence(): Promise<SettingsDocumentPresence> {
        const exists = (path: string) => IOUtils.exists(path).catch(() => false);
        if (await exists(PathUtils.join(this.folderPath, SETTINGS_FILENAME))) return 'present';
        if (await exists(PathUtils.join(this.folderPath, `.${SETTINGS_FILENAME}.icloud`))) return 'present';
        // A folder that is not there (a drive not plugged in, a cloud folder
        // not synced down yet) says nothing about what it holds.
        return (await exists(this.folderPath)) ? 'absent' : 'unknown';
    }

    async writeSettingsDocument(json: string): Promise<boolean> {
        try {
            await IOUtils.makeDirectory(this.folderPath, {
                createAncestors: true,
                ignoreExisting: true,
            });
            await IOUtils.writeUTF8(PathUtils.join(this.folderPath, SETTINGS_FILENAME), json);
            return true;
        } catch (error) {
            logger(`folderBackend: could not write settings: ${error}`, 1);
            return false;
        }
    }

    async revealThread(threadId: string): Promise<'revealed' | 'missing'> {
        const path = this.threadPath(threadId);
        if (!(await IOUtils.exists(path).catch(() => false))) return 'missing';
        Zotero.File.reveal(path);
        return 'revealed';
    }

    async remoteThreadUpdatedAt(threadId: string): Promise<string | null | 'unreadable' | 'damaged'> {
        const path = this.threadPath(threadId);
        if (!(await IOUtils.exists(path).catch(() => false))) {
            const placeholder = PathUtils.join(this.conversationsDir, `.${threadId}.json.icloud`);
            return (await IOUtils.exists(placeholder).catch(() => false)) ? 'unreadable' : null;
        }
        const text = await readUTF8WithTimeout(path);
        if (text === null) return 'unreadable';
        return remoteCopyState(text);
    }

    async purgeThread(
        _db: BeaverDB,
        _userId: string,
        threadId: string,
        deletedAt: string,
    ): Promise<boolean> {
        try {
            await IOUtils.remove(this.threadPath(threadId)).catch(() => {});
            return await recordDeletion(this.ledgerIO(), threadId, deletedAt);
        } catch (error) {
            logger(`folderBackend: could not purge ${threadId}: ${error}`, 1);
            return false;
        }
    }

    async countRemoteCopies(): Promise<number> {
        return (await this.listConversationFiles()).paths.length;
    }

    async deleteAllRemote(): Promise<{ removed: number }> {
        let removed = 0;
        try {
            const { paths, conflictCopies } = await this.listConversationFiles();
            for (const path of paths) {
                await IOUtils.remove(path).catch(() => { removed -= 1; });
                removed += 1;
            }
            const settings = PathUtils.join(this.folderPath, SETTINGS_FILENAME);
            if (await IOUtils.exists(settings).catch(() => false)) {
                await IOUtils.remove(settings);
                removed += 1;
            }
            // Conflict copies stay — they are the user's to judge (the confirm
            // dialog says so). Only a genuinely empty directory is removed.
            if (conflictCopies === 0) {
                await IOUtils.remove(this.conversationsDir, { recursive: false }).catch(() => {});
            }
        } catch (error) {
            logger(`folderBackend: deleteAllRemote stopped early: ${error}`, 1);
        }
        return { removed };
    }
}
