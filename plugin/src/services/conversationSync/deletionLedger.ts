/**
 * The deletion ledger: which conversations were deleted forever, and when.
 *
 * "Delete forever" removes a thread here and records a tombstone, but the
 * other computers still hold their copy. The ledger is the one shared file
 * every backend keeps beside its conversations (`deleted-threads.json`);
 * each sync pass applies its claims locally and adds this computer's own.
 *
 * A claim wins only while it is the newest fact about a thread: a copy edited
 * after the recorded deletion revives the thread instead, everywhere.
 */
import { logger } from '@beaver/agent-core/platform/logger';
import type { BeaverDB } from '../database';
import { parseThreadTimestamp } from '../threadZoteroSync';

export const DELETED_LEDGER_FILENAME = 'deleted-threads.json';
const DELETED_LEDGER_FORMAT = 'alphainz.deleted-threads';
const DELETED_LEDGER_VERSION = 1;

export interface DeletedLedger {
    /** threadId → ISO deletion time. Entries are never removed, only outdated:
     *  a thread copy edited after its entry's time simply outranks it. */
    entries: Record<string, string>;
    /** False when the file was written by a newer plugin version, or is
     *  there but could not be read — read what we can, never overwrite it. */
    writable: boolean;
}

/**
 * How the ledger file is reached on one backend.
 *
 * `read` answers `{ present: false }` when there is no ledger, and
 * `{ present: true, text: null }` when there is one this pass cannot read yet
 * (a cloud placeholder, a Zotero file still to download).
 */
export interface LedgerIO {
    read(): Promise<{ present: boolean; text: string | null }>;
    write(json: string): Promise<boolean>;
    /**
     * Remove whatever copy of a deleted thread this backend still holds —
     * except a copy edited after `deletedAt`. That one is another computer's
     * later work: it revives the thread, and the import brings it back here.
     * A copy that cannot be read yet is left for a later pass to judge.
     */
    removeRemoteCopy(threadId: string, deletedAt: string): Promise<void>;
}

export function parseDeletedLedger(text: string | null): DeletedLedger {
    if (text === null) return { entries: {}, writable: true };
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.version === 'number' && parsed.version > DELETED_LEDGER_VERSION) {
            return { entries: entriesOf(parsed), writable: false };
        }
        return { entries: entriesOf(parsed), writable: true };
    } catch {
        // Corrupt ledger: treat as empty and let the next merge heal it.
        return { entries: {}, writable: true };
    }
}

function entriesOf(parsed: any): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = parsed?.entries;
    if (raw && typeof raw === 'object') {
        for (const [id, at] of Object.entries(raw)) {
            if (typeof at === 'string' && at) out[id] = at;
        }
    }
    return out;
}

/** Later deletion time wins; unknown ids are unioned in. */
export function mergeLedgerEntries(
    base: Record<string, string>,
    add: Array<{ thread_id: string; deleted_at: string }>,
): { entries: Record<string, string>; changed: boolean } {
    const entries = { ...base };
    let changed = false;
    for (const { thread_id, deleted_at } of add) {
        const existing = entries[thread_id];
        if (!existing || parseThreadTimestamp(deleted_at) > parseThreadTimestamp(existing)) {
            entries[thread_id] = deleted_at;
            changed = true;
        }
    }
    return { entries, changed };
}

/**
 * One ledger out of several copies of it — two "AlphainZ Conversations"
 * items can each carry one. Their claims are one set; a copy from a newer
 * plugin version keeps the merged ledger read-only.
 */
export function mergeLedgerTexts(texts: string[]): string {
    let entries: Record<string, string> = {};
    let readOnly = false;
    for (const text of texts) {
        const parsed = parseDeletedLedger(text);
        if (!parsed.writable) readOnly = true;
        entries = mergeLedgerEntries(
            entries,
            Object.entries(parsed.entries).map(([thread_id, deleted_at]) => ({ thread_id, deleted_at })),
        ).entries;
    }
    return JSON.stringify({
        format: DELETED_LEDGER_FORMAT,
        version: readOnly ? DELETED_LEDGER_VERSION + 1 : DELETED_LEDGER_VERSION,
        entries,
    });
}

export function serializeDeletedLedger(entries: Record<string, string>): string {
    return JSON.stringify({
        format: DELETED_LEDGER_FORMAT,
        version: DELETED_LEDGER_VERSION,
        entries,
        exportedBy: String(Zotero.Users?.getLocalUserKey?.() ?? 'unknown'),
        exportedAt: new Date().toISOString(),
    }, null, 2);
}

/** Read the ledger through a backend's IO, refusing to overwrite what could not be read. */
export async function readDeletedLedger(io: LedgerIO): Promise<DeletedLedger> {
    const { present, text } = await io.read();
    if (!present) return { entries: {}, writable: true };
    if (text === null) return { entries: {}, writable: false };
    return parseDeletedLedger(text);
}

/**
 * Two-way tombstone sync: apply the ledger's claims locally, then add the
 * local tombstones to the ledger.
 */
export async function syncDeletionLedger(db: BeaverDB, userId: string, io: LedgerIO): Promise<void> {
    const dao = db as any;
    if (typeof dao.threadTombstones !== 'function') return;

    const ledger = await readDeletedLedger(io);

    let purgedLocally = 0;
    for (const [threadId, deletedAt] of Object.entries(ledger.entries)) {
        const deletedTs = parseThreadTimestamp(deletedAt);
        const local = await db.getThread(userId, threadId);
        if (local && parseThreadTimestamp(local.updatedAt) > deletedTs) {
            // Edited after the deletion — the thread wins everywhere.
            await dao.removeThreadTombstone?.(userId, threadId);
            continue;
        }
        await dao.addThreadTombstone(userId, threadId, deletedAt);
        if (local) {
            await db.deleteThread(userId, threadId);
            purgedLocally += 1;
        }
        // A remote copy written up to the deletion is outranked too; removing
        // it stops other machines re-importing it (their own ledgers catch up
        // regardless).
        await io.removeRemoteCopy(threadId, deletedAt).catch(() => {});
    }
    if (purgedLocally > 0) {
        logger(`deletionLedger: removed ${purgedLocally} local thread(s)`, 3);
    }

    if (ledger.writable) {
        const localTombstones = await dao.threadTombstones(userId);
        const merged = mergeLedgerEntries(ledger.entries, localTombstones);
        if (merged.changed) await io.write(serializeDeletedLedger(merged.entries));
    }
}

/** Add one claim to the ledger — the propagation half of "Delete forever". */
export async function recordDeletion(io: LedgerIO, threadId: string, deletedAt: string): Promise<boolean> {
    const ledger = await readDeletedLedger(io);
    if (!ledger.writable) return false;
    const merged = mergeLedgerEntries(ledger.entries, [{ thread_id: threadId, deleted_at: deletedAt }]);
    if (!merged.changed) return true;
    return io.write(serializeDeletedLedger(merged.entries));
}
