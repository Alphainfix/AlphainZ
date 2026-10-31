/**
 * Opening the plugin's database leaves the Zotero pane usable.
 *
 * - When the last session did not close the database (its write-ahead log is
 *   not empty), Zotero checks it on opening and covers the pane while it does;
 *   the cover comes down once the open is over, also when the open fails.
 * - A database closed cleanly is opened without touching the pane.
 * - The pane is left alone if it was locked before the open, or now shows
 *   another operation's message.
 * - Closing the database is for good, so a late query cannot reopen it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { BeaverDB } from '../../../src/services/database';
import { openPluginDatabase, releaseIntegrityCheckCover } from '../../../src/services/pluginDatabaseOpen';

const INTEGRITY = 'Checking database integrity…';
const REPAIRING = 'Repairing database…';

function pane(label: { value: string; hidden: boolean } | null, overlay = { hidden: true }) {
    const elements: Record<string, unknown> = { 'zotero-pane-progress-label': label, 'zotero-pane-overlay': overlay };
    return { document: { getElementById: (id: string) => elements[id] ?? null } };
}

let zotero: any;
let walSize: number | null;

beforeEach(() => {
    walSize = 0;
    zotero = {
        locked: false,
        ftl: { formatValueSync: (id: string) => ({ 'db-checking-integrity': INTEGRITY, 'db-repairing': REPAIRING } as any)[id] ?? id },
        windows: [] as any[],
        getMainWindows() { return this.windows; },
        hideZoteroPaneOverlays: vi.fn(function (this: any) { this.locked = false; }),
    };
    (globalThis as any).Zotero = zotero;
    (globalThis as any).IOUtils.stat = vi.fn(async () => {
        if (walSize === null) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        return { size: walSize };
    });
});

/** A connection whose opening, like Zotero's, checks and covers the pane when told to. */
function connection(options: { checks: boolean; fails?: boolean }) {
    return {
        test: vi.fn(async () => {
            if (options.checks) {
                zotero.locked = true;
                for (const win of zotero.windows) {
                    const label = win.document.getElementById('zotero-pane-progress-label');
                    if (label) {
                        label.value = INTEGRITY;
                        label.hidden = false;
                    }
                    win.document.getElementById('zotero-pane-overlay').hidden = false;
                }
            }
            if (options.fails) throw new Error('database disk image is malformed');
        }),
    };
}

describe('opening the plugin database', () => {
    it('takes down the check cover when the last session left the log behind', async () => {
        walSize = 4096;
        zotero.windows = [pane({ value: '', hidden: true })];
        await openPluginDatabase(connection({ checks: true }), '/data/alphainz.sqlite');
        expect((globalThis as any).IOUtils.stat).toHaveBeenCalledWith('/data/alphainz.sqlite-wal');
        expect(zotero.hideZoteroPaneOverlays).toHaveBeenCalledTimes(1);
        expect(zotero.locked).toBe(false);
    });

    it('takes it down before the main window exists, too', async () => {
        walSize = 4096;
        await openPluginDatabase(connection({ checks: true }), '/data/alphainz.sqlite');
        expect(zotero.hideZoteroPaneOverlays).toHaveBeenCalledTimes(1);
    });

    it('takes it down when the check finds damage and the open fails', async () => {
        walSize = 4096;
        await expect(openPluginDatabase(connection({ checks: true, fails: true }), '/d/a.sqlite')).rejects.toThrow(/malformed/);
        expect(zotero.hideZoteroPaneOverlays).toHaveBeenCalledTimes(1);
    });

    it('leaves the pane alone after a clean close, or with no log at all', async () => {
        walSize = 0;
        zotero.locked = false;
        const cleanOpen = connection({ checks: false });
        await openPluginDatabase(cleanOpen, '/d/a.sqlite');
        walSize = null;
        await openPluginDatabase(cleanOpen, '/d/a.sqlite');
        expect(cleanOpen.test).toHaveBeenCalledTimes(2);
        expect(zotero.hideZoteroPaneOverlays).not.toHaveBeenCalled();
    });

    it('leaves a pane that was already locked before the open', async () => {
        walSize = 4096;
        zotero.locked = true;
        await openPluginDatabase(connection({ checks: true }), '/d/a.sqlite');
        expect(zotero.hideZoteroPaneOverlays).not.toHaveBeenCalled();
    });

    it('leaves a pane that shows another operation\'s message', () => {
        zotero.locked = true;
        zotero.windows = [pane({ value: 'Syncing…', hidden: false }, { hidden: false })];
        expect(releaseIntegrityCheckCover(false)).toBe(false);
        expect(zotero.hideZoteroPaneOverlays).not.toHaveBeenCalled();
    });

    it('does not mistake an old message under a hidden cover for another operation', () => {
        zotero.locked = true;
        zotero.windows = [pane({ value: 'Syncing…', hidden: false }, { hidden: true })];
        expect(releaseIntegrityCheckCover(false)).toBe(true);
    });
});

describe('a cover Zotero puts up for a repair', () => {
    it('comes down too, though the log was empty', async () => {
        walSize = 0;
        zotero.windows = [pane({ value: '', hidden: true })];
        const repairing = {
            test: vi.fn(async () => {
                zotero.locked = true;
                const label = zotero.windows[0].document.getElementById('zotero-pane-progress-label');
                label.value = REPAIRING;
                label.hidden = false;
                zotero.windows[0].document.getElementById('zotero-pane-overlay').hidden = false;
            }),
        };
        await openPluginDatabase(repairing, '/d/a.sqlite');
        expect(zotero.hideZoteroPaneOverlays).toHaveBeenCalledTimes(1);
    });
});

describe('closing the plugin database', () => {
    it('waits for an open still under way, so that the open cannot leave a connection behind', async () => {
        const order: string[] = [];
        const conn = { closeDatabase: vi.fn(async () => { order.push('close'); }) };
        const db = new BeaverDB(conn as any);
        let finishOpen!: () => void;
        const open = db.whileOpening(new Promise<void>((resolve) => { finishOpen = () => { order.push('opened'); resolve(); }; }));
        const closing = db.closeDatabase();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(order).toEqual([]);
        finishOpen();
        await Promise.all([open, closing]);
        expect(order).toEqual(['opened', 'close']);
    });

    it('closes it for good', async () => {
        const conn = { closeDatabase: vi.fn(async () => {}) };
        await new BeaverDB(conn as any).closeDatabase();
        expect(conn.closeDatabase).toHaveBeenCalledWith(true);
    });
});
