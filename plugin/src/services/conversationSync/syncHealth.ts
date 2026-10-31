/**
 * What the last sync pass could not do, for the chat history's footer.
 *
 * "Last synced 1 minute ago" only says a pass ran. This says whether it got
 * anywhere: files still downloading, conflict copies left aside, a sync
 * folder that is not there, Zotero not carrying files at all, a write that
 * failed. Each backend reports into it; the footer subscribes.
 *
 * Kept on the Zotero global rather than in module state, because both bundles
 * carry a copy of this module — the startup pass runs in one, the history
 * list and the mirror after every answer in the other — and the footer has
 * to see what either of them found.
 */

export interface SyncHealth {
    /** Remote conversations known about but not readable yet (downloading, cloud placeholders). */
    waiting: number;
    /** Remote files that could be read but are not conversations this build understands. */
    unreadable: number;
    /** iCloud-style conflict copies ("<id> 2.json") left in the folder, unimported. */
    conflictCopies: number;
    /** The sync folder itself is missing: moved, renamed, or on a drive that is not plugged in. */
    folderMissing: boolean;
    /** Zotero is not syncing files for My Library, so attachments cannot travel. */
    fileSyncOff: boolean;
    /** Files written here that Zotero failed to upload although a sync finished since. */
    stuckUploads: number;
    /** The most recent failed write, cleared by the next write that succeeds. */
    lastWriteError: string | null;
}

const EMPTY: SyncHealth = Object.freeze({
    waiting: 0,
    unreadable: 0,
    conflictCopies: 0,
    folderMissing: false,
    fileSyncOff: false,
    stuckUploads: 0,
    lastWriteError: null,
}) as SyncHealth;

interface HealthStore {
    snapshot: SyncHealth;
    listeners: Set<() => void>;
}

function healthStore(): HealthStore {
    const global = (typeof Zotero !== 'undefined' ? Zotero : globalThis) as any;
    if (!global.__alphainzSyncHealth) {
        global.__alphainzSyncHealth = { snapshot: EMPTY, listeners: new Set() } satisfies HealthStore;
    }
    return global.__alphainzSyncHealth as HealthStore;
}

function update(patch: Partial<SyncHealth>): void {
    const store = healthStore();
    const next = { ...store.snapshot, ...patch };
    const changed = (Object.keys(next) as Array<keyof SyncHealth>)
        .some((key) => next[key] !== store.snapshot[key]);
    if (!changed) return;
    store.snapshot = Object.freeze(next) as SyncHealth;
    for (const listener of [...store.listeners]) {
        try { listener(); } catch { /* a listener's failure is its own */ }
    }
}

/** The current record. The same object until something changes, as `useSyncExternalStore` needs. */
export function getSyncHealth(): SyncHealth {
    return healthStore().snapshot;
}

export function subscribeSyncHealth(listener: () => void): () => void {
    const store = healthStore();
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
}

/** What one import pass found. Fields it does not mention keep their value. */
export function recordPassHealth(found: Partial<Omit<SyncHealth, 'lastWriteError'>>): void {
    update(found);
}

/** A mirror write's outcome: a failure is kept until a later write succeeds. */
export function recordWriteOutcome(ok: boolean, error?: string): void {
    update({ lastWriteError: ok ? null : (error || 'A conversation could not be written to the sync location') });
}

/** Back to nothing known — the backend changed, so the old findings describe another place. */
export function resetSyncHealth(): void {
    update({ ...EMPTY });
}

/**
 * The longer explanation of the most serious problem, and what to do about
 * it — the footer's tooltip. Null when there is nothing to explain.
 */
export function syncHealthHint(health: SyncHealth, mode: 'off' | 'zotero' | 'folder'): string | null {
    if (health.folderMissing) {
        return 'The sync folder is not there: it may have been moved or renamed, or be on a drive '
            + 'that is not connected. Choose it again in Settings → Advanced → Conversation Sync.';
    }
    if (health.fileSyncOff) {
        return 'Zotero is not syncing attachment files, so conversations cannot reach your other '
            + 'computers. Turn on file syncing in Zotero\'s Settings → Sync.';
    }
    if (health.lastWriteError) return health.lastWriteError;
    if (health.stuckUploads > 0) {
        return 'Zotero has synced since these conversation files were written but has not uploaded '
            + 'them — its file storage may be full. Check Zotero\'s Settings → Sync.';
    }
    if (health.waiting > 0) {
        return mode === 'zotero'
            ? 'These conversations have arrived, but their files have not downloaded yet. AlphainZ '
                + 'asks Zotero for them on every pass; they appear once the download finishes.'
            : 'Your cloud service has not downloaded these conversation files to this computer yet. '
                + 'They are imported once they are here.';
    }
    if (health.conflictCopies > 0) {
        return 'Your cloud service left conflict copies (like "… 2.json") in the sync folder. They '
            + 'are not imported; open the folder to compare them and delete the ones you do not need.';
    }
    if (health.unreadable > 0) {
        return 'Some conversation files could not be read — damaged, or written by a newer version '
            + 'of AlphainZ. They are left untouched.';
    }
    return null;
}

/**
 * The footer's words for what is wrong, most serious first. Empty when the
 * last pass found nothing to report.
 */
export function describeSyncHealth(health: SyncHealth): string[] {
    const out: string[] = [];
    if (health.folderMissing) out.push('sync folder not found');
    if (health.fileSyncOff) out.push('Zotero is not syncing files');
    if (health.lastWriteError) out.push('last change not saved to the sync location');
    if (health.stuckUploads > 0) {
        out.push(`${health.stuckUploads} not uploaded by Zotero`);
    }
    if (health.waiting > 0) {
        out.push(`${health.waiting} waiting to download`);
    }
    if (health.conflictCopies > 0) {
        out.push(`${health.conflictCopies} conflict cop${health.conflictCopies === 1 ? 'y' : 'ies'} ignored`);
    }
    if (health.unreadable > 0) {
        out.push(`${health.unreadable} unreadable`);
    }
    return out;
}
