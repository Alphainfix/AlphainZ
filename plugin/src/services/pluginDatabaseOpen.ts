/**
 * Opening the plugin's database without leaving the Zotero pane covered.
 *
 * Zotero opens a database whose write-ahead log was left non-empty — the last
 * session did not close it — with a full integrity check, and puts "Checking
 * database integrity…" over the Zotero pane while the check runs. Zotero's own
 * startup takes that cover down afterwards. Nothing does for a plugin's
 * database: the pane stays covered, and Zotero locked, long after the check
 * has passed.
 */

import { logger } from '@beaver/agent-core/platform/logger';

/** Whether a database's write-ahead log has anything in it — Zotero's test for an unclean last session. */
export async function hasLeftoverLog(dbPath: string): Promise<boolean> {
    try {
        return ((await IOUtils.stat(`${dbPath}-wal`)).size ?? 0) > 0;
    } catch {
        return false;
    }
}

/** What Zotero writes on the pane while it checks or repairs a database it is opening. */
const DATABASE_MESSAGES = ['db-checking-integrity', 'db-repairing'];

/**
 * Take down the cover Zotero put up while opening this database — a check
 * after an unclean quit, or a repair after a corruption marker — unless the
 * pane was already locked before the open, or now shows a message of some
 * other operation.
 */
export function releaseIntegrityCheckCover(lockedBefore: boolean): boolean {
    const zotero = Zotero as any;
    if (lockedBefore || !zotero.locked) return false;
    const ours = new Set<string>();
    for (const id of DATABASE_MESSAGES) {
        try {
            const text = zotero.ftl?.formatValueSync?.(id);
            if (text) ours.add(text);
        } catch {
            // No string to compare with: the lock appearing while the database
            // opened is enough to tell whose it is.
        }
    }
    for (const win of zotero.getMainWindows?.() ?? []) {
        const doc = win?.document;
        const overlay = doc?.getElementById?.('zotero-pane-overlay');
        const label = doc?.getElementById?.('zotero-pane-progress-label');
        const showing = overlay ? !overlay.hidden : true;
        if (showing && label && !label.hidden && ours.size > 0 && !ours.has(label.value)) return false;
    }
    zotero.hideZoteroPaneOverlays();
    return true;
}

/**
 * Open the plugin's database. When Zotero checks or repairs it first, take the
 * cover down afterwards — also when the open throws, since Zotero then reports
 * the damage in a dialog of its own. Whatever locked the pane during the open
 * is taken to be the open's, unless the pane shows another operation's message.
 */
export async function openPluginDatabase(conn: { test(): Promise<unknown> }, dbPath: string): Promise<void> {
    const leftOver = await hasLeftoverLog(dbPath);
    const lockedBefore = Boolean((Zotero as any).locked);
    try {
        await conn.test();
    } finally {
        if (releaseIntegrityCheckCover(lockedBefore)) {
            logger(`database: Zotero ${leftOver ? 'checked it first (the last session did not close it)' : 'covered the pane while opening it'}; took the cover down`, 2);
        }
    }
}
