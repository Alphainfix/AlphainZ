/**
 * The Zotero-attachments backend: files live under the "AlphainZ
 * Conversations" item, Zotero's own sync moves them between machines, and
 * Zotero's trash is the archive. All the mechanics live in
 * `threadZoteroSync.ts`; this class only gives them the backend shape.
 */
import type { BeaverDB } from '../database';
import {
    attachmentFilename,
    attachmentsByFilename,
    countStuckUploads,
    ensureAttachmentFile,
    findAttachmentsByFilename,
    findParentItems,
    findThreadAttachment,
    importThreadAttachments,
    listThreadAttachments,
    parseThreadExport,
    parseThreadTimestamp,
    reconcileArchiveState,
    remoteCopyState,
    trashThreadAttachment,
    untrashThreadAttachment,
    writeJsonAttachmentFile,
    writeThreadAttachment,
    zoteroMayStillDeliver,
} from '../threadZoteroSync';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    DELETED_LEDGER_FILENAME,
    mergeLedgerTexts,
    recordDeletion,
    syncDeletionLedger,
    type LedgerIO,
} from './deletionLedger';
import { recordPassHealth, recordWriteOutcome } from './syncHealth';
import type { ConversationBackend, ImportCounts, SettingsDocumentPresence } from './types';

export const SETTINGS_FILENAME = 'settings.json';
const SETTINGS_TITLE = 'AlphainZ Settings';
const LEDGER_TITLE = 'AlphainZ Deleted Conversations';

/** Whether Zotero syncs files for this library; without that, no attachment leaves this computer. */
function fileSyncEnabled(libraryID: number): boolean {
    try {
        const local = (Zotero as any).Sync?.Storage?.Local;
        if (typeof local?.getEnabledForLibrary !== 'function') return true;
        return !!local.getEnabledForLibrary(libraryID);
    } catch {
        return true;
    }
}

/**
 * Whether a copy of a deleted thread was written after the deletion, which
 * makes it another computer's later work. An attachment untouched since the
 * deletion cannot be; one changed since is read to tell, and counts as later
 * while it cannot be read — erasing is not undone.
 */
async function writtenAfterDeletion(copy: Zotero.Item, deletedAt: string): Promise<boolean> {
    const deleted = parseThreadTimestamp(deletedAt);
    const modified = parseThreadTimestamp(String((copy as any).dateModified ?? ''));
    if (Number.isFinite(modified) && Number.isFinite(deleted) && modified <= deleted) return false;
    try {
        const path = await ensureAttachmentFile(copy);
        if (!path || !(await IOUtils.exists(path))) return true;
        const payload = parseThreadExport(await IOUtils.readUTF8(path));
        return !payload || !(parseThreadTimestamp(payload.thread.updatedAt) <= deleted);
    } catch {
        return true;
    }
}

/** A settings document's `exportedAt`, for choosing between two of them; 0 when unreadable. */
function exportedAtOf(text: string): number {
    try {
        const at = Date.parse(JSON.parse(text)?.exportedAt);
        return Number.isFinite(at) ? at : 0;
    } catch {
        return 0;
    }
}

export class ZoteroConversationBackend implements ConversationBackend {
    readonly kind = 'zotero' as const;

    private get libraryID(): number {
        return Zotero.Libraries.userLibraryID;
    }

    async writeThread(db: BeaverDB, userId: string, threadId: string, now: string): Promise<boolean> {
        try {
            const written = await writeThreadAttachment(db, userId, threadId, this.libraryID, now);
            if (written) {
                recordWriteOutcome(true);
                return true;
            }
            // Nothing written for a thread that exists is a failed write (its
            // file is still downloading, or Zotero is mid-sync); a thread that
            // is gone simply has nothing to write.
            if (await db.getThread(userId, threadId)) {
                recordWriteOutcome(false, 'Zotero did not accept the latest change yet; the next change retries it');
            }
            return false;
        } catch (error) {
            logger(`zoteroBackend: could not write ${threadId}: ${error}`, 1);
            recordWriteOutcome(false, `Could not save a conversation into Zotero: ${error}`);
            return false;
        }
    }

    async reconcileArchive(db: BeaverDB, userId: string, now: string) {
        return reconcileArchiveState(db as any, userId, this.libraryID, now);
    }

    async importAll(db: BeaverDB, userId: string): Promise<ImportCounts> {
        // Deletions first: a thread deleted forever elsewhere must not be
        // imported below, and its stale local copy leaves now.
        try {
            // One walk of the library for all the ledger's claims.
            const index = await attachmentsByFilename(this.libraryID);
            await syncDeletionLedger(db, userId, this.ledgerIO(index));
        } catch (error) {
            logger(`zoteroBackend: could not sync the deletion ledger: ${error}`, 1);
        }
        const counts = await importThreadAttachments(db, userId, this.libraryID);
        recordPassHealth({
            waiting: counts.waiting,
            unreadable: counts.unreadable,
            conflictCopies: 0,
            folderMissing: false,
            fileSyncOff: !fileSyncEnabled(this.libraryID),
            stuckUploads: await countStuckUploads(this.libraryID).catch(() => 0),
        });
        return { ...counts, conflictCopies: 0 };
    }

    async archiveThread(_db: BeaverDB, _userId: string, threadId: string): Promise<boolean> {
        return trashThreadAttachment(threadId, this.libraryID);
    }

    async restoreThread(_db: BeaverDB, _userId: string, threadId: string): Promise<boolean> {
        return untrashThreadAttachment(threadId, this.libraryID);
    }

    async readSettingsDocument(): Promise<string | null> {
        try {
            /*
             * Normally one document. Two computers that each wrote before
             * seeing the other's "AlphainZ Conversations" item leave two; the
             * one exported last is the settings.
             */
            let best: { text: string; at: number } | null = null;
            for (const copy of await findAttachmentsByFilename(this.libraryID, SETTINGS_FILENAME)) {
                const path = await ensureAttachmentFile(copy);
                // No file yet = the item synced ahead of it; the next pass reads it.
                if (!path) continue;
                const text = await IOUtils.readUTF8(path);
                const at = exportedAtOf(text);
                if (!best || at > best.at) best = { text, at };
            }
            return best?.text ?? null;
        } catch (error) {
            logger(`zoteroBackend: could not read settings: ${error}`, 1);
            return null;
        }
    }

    async settingsDocumentPresence(): Promise<SettingsDocumentPresence> {
        try {
            const copies = await findAttachmentsByFilename(this.libraryID, SETTINGS_FILENAME);
            if (copies.length > 0) return 'present';
            // None visible while Zotero may still be delivering another
            // computer's items is not the same as none at all.
            return zoteroMayStillDeliver(this.libraryID) ? 'unknown' : 'absent';
        } catch {
            return 'unknown';
        }
    }

    async writeSettingsDocument(json: string): Promise<boolean> {
        try {
            const written = await writeJsonAttachmentFile(
                this.libraryID, SETTINGS_FILENAME, SETTINGS_TITLE, json, { trashed: false },
            );
            return written !== null;
        } catch (error) {
            logger(`zoteroBackend: could not write settings: ${error}`, 1);
            return false;
        }
    }

    async revealThread(threadId: string): Promise<'revealed' | 'missing'> {
        // Archived conversations are found too: Zotero opens its trash to
        // show an attachment that is in it.
        const attachment = await findThreadAttachment(this.libraryID, threadId);
        if (!attachment) return 'missing';
        const pane = Zotero.getActiveZoteroPane();
        await pane?.selectItem(attachment.id);
        Zotero.getMainWindow()?.focus();
        return 'revealed';
    }

    async remoteThreadUpdatedAt(threadId: string): Promise<string | null | 'unreadable' | 'damaged'> {
        const attachment = await findThreadAttachment(this.libraryID, threadId);
        if (!attachment) return null;
        // As a writer would: a copy Zotero is still to replace does not count.
        const path = await ensureAttachmentFile(attachment, { forWrite: true });
        if (!path || !(await IOUtils.exists(path))) return 'unreadable';
        return remoteCopyState(await IOUtils.readUTF8(path));
    }

    /**
     * "Delete forever": erase the thread's attachment — trashed copies too,
     * so the transcript leaves Zotero's trash and, at the next sync, Zotero's
     * server — and record the deletion in the ledger the other computers
     * apply.
     */
    async purgeThread(_db: BeaverDB, _userId: string, threadId: string, deletedAt: string): Promise<boolean> {
        try {
            await this.eraseThreadCopies(threadId);
            return await recordDeletion(this.ledgerIO(), threadId, deletedAt);
        } catch (error) {
            logger(`zoteroBackend: could not purge ${threadId}: ${error}`, 1);
            return false;
        }
    }

    async countRemoteCopies(): Promise<number> {
        return (await listThreadAttachments(this.libraryID)).length;
    }

    async deleteAllRemote(): Promise<{ removed: number }> {
        /*
         * Trash, not erase: "turn sync off" must be as reversible as every
         * other destructive-looking action here. The user empties the trash on
         * their own schedule.
         */
        let removed = 0;
        try {
            for (const item of await listThreadAttachments(this.libraryID)) {
                item.deleted = true;
                await item.saveTx();
                removed += 1;
            }
            for (const name of [SETTINGS_FILENAME, DELETED_LEDGER_FILENAME]) {
                for (const copy of await findAttachmentsByFilename(this.libraryID, name)) {
                    copy.deleted = true;
                    await copy.saveTx();
                    removed += 1;
                }
            }
            for (const parent of await findParentItems(this.libraryID)) {
                parent.deleted = true;
                await parent.saveTx();
            }
        } catch (error) {
            logger(`zoteroBackend: deleteAllRemote stopped early: ${error}`, 1);
        }
        return { removed };
    }

    private async eraseThreadCopies(threadId: string): Promise<void> {
        const copies = await findAttachmentsByFilename(
            this.libraryID, attachmentFilename(threadId), { includeTrashed: true },
        );
        for (const copy of copies) await copy.eraseTx();
    }

    /**
     * The deletion ledger as an attachment beside settings.json. `index`, when
     * a pass has one, is the library by filename, so removing the copies of
     * many deleted threads does not walk the library once per thread.
     */
    private ledgerIO(index?: Map<string, Zotero.Item[]>): LedgerIO {
        return {
            read: async () => {
                const copies = await findAttachmentsByFilename(this.libraryID, DELETED_LEDGER_FILENAME);
                if (copies.length === 0) return { present: false, text: null };
                const texts: string[] = [];
                for (const copy of copies) {
                    const path = await ensureAttachmentFile(copy);
                    // One copy still downloading: apply nothing, write nothing.
                    if (!path) return { present: true, text: null };
                    texts.push(await IOUtils.readUTF8(path));
                }
                return { present: true, text: texts.length === 1 ? texts[0] : mergeLedgerTexts(texts) };
            },
            write: async (json) => (await writeJsonAttachmentFile(
                this.libraryID, DELETED_LEDGER_FILENAME, LEDGER_TITLE, json, { trashed: false },
            )) !== null,
            removeRemoteCopy: async (threadId, deletedAt) => {
                const name = attachmentFilename(threadId);
                const copies = index
                    ? (index.get(name) ?? [])
                    : await findAttachmentsByFilename(this.libraryID, name, { includeTrashed: true });
                const kept: Zotero.Item[] = [];
                for (const copy of copies) {
                    if (await writtenAfterDeletion(copy, deletedAt)) kept.push(copy);
                    else await copy.eraseTx();
                }
                if (index) {
                    if (kept.length > 0) index.set(name, kept); else index.delete(name);
                }
            },
        };
    }
}
