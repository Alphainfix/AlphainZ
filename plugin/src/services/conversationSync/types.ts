/**
 * The seam between "what a synced conversation is" and "where it lives".
 *
 * Two backends implement this: Zotero attachments (the original — Zotero's own
 * sync moves the files, its trash is the archive) and a plain folder (the
 * Obsidian model — the user points at a directory, a cloud client of their
 * choosing moves the files, and the plugin neither knows nor cares which).
 * Exactly one is active at a time; `'off'` is a real mode, not an absence.
 */
import type { BeaverDB } from '../database';

export type ConversationSyncMode = 'off' | 'zotero' | 'folder';

export interface ImportCounts {
    imported: number;
    /**
     * Present remotely but not applied — already current, or not yet readable
     * (a cloud placeholder still downloading). Non-zero arms the retry timer.
     */
    skipped: number;
    unreadable: number;
    /**
     * Files shaped like a sync conflict ("<uuid> 2.json") and ignored. Always
     * 0 on the Zotero backend; the folder backend counts them so the log can
     * say what iCloud did instead of silently double-importing.
     */
    conflictCopies: number;
    /**
     * Of `skipped`: files present remotely that could not be read yet — a
     * cloud placeholder still downloading, a Zotero file not fetched yet.
     */
    waiting?: number;
}

/**
 * Whether the backend holds a settings document. `unknown` when it cannot
 * tell yet — the sync folder is missing, or Zotero is still delivering
 * another computer's items — which a machine joining must treat as "maybe".
 */
export type SettingsDocumentPresence = 'present' | 'absent' | 'unknown';

export interface ConversationBackend {
    readonly kind: Exclude<ConversationSyncMode, 'off'>;

    /** Create or replace the remote copy of one thread. */
    writeThread(db: BeaverDB, userId: string, threadId: string, now: string): Promise<boolean>;

    /** Two-way archive reconcile — run before importAll, as today. */
    reconcileArchive(db: BeaverDB, userId: string, now: string): Promise<{ archived: number; restored: number }>;

    /** Pull anything newer than local (LWW via shouldImport). */
    importAll(db: BeaverDB, userId: string): Promise<ImportCounts>;

    /** Push a local archive / restore into the remote copy. */
    archiveThread(db: BeaverDB, userId: string, threadId: string, now: string): Promise<boolean>;
    restoreThread(db: BeaverDB, userId: string, threadId: string, now: string): Promise<boolean>;

    /** The settings envelope (settings sync). null = absent or not readable yet. */
    readSettingsDocument(): Promise<string | null>;
    writeSettingsDocument(json: string): Promise<boolean>;
    /**
     * Whether a settings document is there at all, readable or not — what a
     * machine joining needs to know before it may write the first one.
     */
    settingsDocumentPresence?(): Promise<SettingsDocumentPresence>;

    /** The history list's "show me the file" button. */
    revealThread(threadId: string): Promise<'revealed' | 'missing'>;

    /**
     * The `updatedAt` of the remote copy of one thread: null when there is
     * none, `'unreadable'` when there is one this pass cannot read (still
     * downloading, or written by a newer version), and `'damaged'` when it
     * was read but is not a conversation file at all. Lets a backfill skip
     * threads whose remote copy is as new as the local one, and repair the
     * damaged ones.
     */
    remoteThreadUpdatedAt?(threadId: string): Promise<string | null | 'unreadable' | 'damaged'>;

    /**
     * Propagate a permanent deletion: remove the remote copy and record the
     * claim in the deletion ledger, so other machines delete theirs instead
     * of re-exporting. Optional — a backend without it still gets local
     * protection from the database tombstone.
     */
    purgeThread?(db: BeaverDB, userId: string, threadId: string, deletedAt: string): Promise<boolean>;

    /** How many remote copies `deleteAllRemote` would remove, for its confirmation. */
    countRemoteCopies?(): Promise<number>;

    /**
     * Delete every remote copy this backend owns. The local database is never
     * touched — this is what "turn sync off" means: stop mirroring, keep work.
     */
    deleteAllRemote(): Promise<{ removed: number }>;
}
