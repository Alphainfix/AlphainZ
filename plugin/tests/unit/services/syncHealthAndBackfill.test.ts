/**
 * What the history footer is told about a sync pass, and the backfill that
 * must not write this computer's older copies over another computer's newer
 * ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    describeSyncHealth,
    getSyncHealth,
    recordPassHealth,
    recordWriteOutcome,
    resetSyncHealth,
    subscribeSyncHealth,
    syncHealthHint,
} from '../../../src/services/conversationSync/syncHealth';
import { exportAllThreads } from '../../../src/services/conversationSync/exportAll';

beforeEach(() => resetSyncHealth());

describe('the sync footer\'s record', () => {
    it('is quiet after a clean pass', () => {
        recordPassHealth({ waiting: 0, unreadable: 0, conflictCopies: 0, folderMissing: false });
        expect(describeSyncHealth(getSyncHealth())).toEqual([]);
        expect(syncHealthHint(getSyncHealth(), 'folder')).toBeNull();
    });

    it('names each problem, the most serious first, and says what to do about it', () => {
        recordPassHealth({ folderMissing: true, waiting: 2, conflictCopies: 1 });
        expect(describeSyncHealth(getSyncHealth())).toEqual([
            'sync folder not found', '2 waiting to download', '1 conflict copy ignored',
        ]);
        expect(syncHealthHint(getSyncHealth(), 'folder')).toContain('Choose it again');
    });

    it('keeps a failed write until a later write succeeds', () => {
        recordWriteOutcome(false, 'disk full');
        expect(describeSyncHealth(getSyncHealth())).toContain('last change not saved to the sync location');
        expect(syncHealthHint(getSyncHealth(), 'zotero')).toBe('disk full');
        recordPassHealth({ waiting: 0 });   // a pass does not clear it
        expect(getSyncHealth().lastWriteError).toBe('disk full');
        recordWriteOutcome(true);
        expect(getSyncHealth().lastWriteError).toBeNull();
    });

    it('hands out the same snapshot until something changes, and tells subscribers when it does', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeSyncHealth(listener);
        const before = getSyncHealth();
        recordPassHealth({ waiting: 0 });
        expect(getSyncHealth()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        recordPassHealth({ waiting: 4 });
        expect(getSyncHealth()).not.toBe(before);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('is shared by both bundles through the Zotero global', () => {
        recordPassHealth({ stuckUploads: 3 });
        expect((Zotero as any).__alphainzSyncHealth.snapshot.stuckUploads).toBe(3);
    });
});

describe('exportAllThreads with skipNewerRemote', () => {
    const threads = [
        { id: 'older-here', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'newer-here', updatedAt: '2026-09-20T00:00:00Z' },
        { id: 'only-here', updatedAt: '2026-09-05T00:00:00Z' },
        { id: 'downloading', updatedAt: '2026-09-05T00:00:00Z' },
        // What the join's import just brought in: the same copy on both sides.
        { id: 'just-imported', updatedAt: '2026-09-15T08:30:00.000Z' },
        // The same moment in the database's other timestamp dialect.
        { id: 'same-moment', updatedAt: '2026-09-15 08:30:00' },
        { id: 'damaged-there', updatedAt: '2026-09-02T00:00:00Z' },
    ];
    const remote: Record<string, string | null | 'unreadable' | 'damaged'> = {
        'older-here': '2026-09-10T00:00:00Z',
        'newer-here': '2026-09-10T00:00:00Z',
        'only-here': null,
        downloading: 'unreadable',
        'just-imported': '2026-09-15T08:30:00.000Z',
        'same-moment': '2026-09-15T08:30:00Z',
        'damaged-there': 'damaged',
    };
    const db = { getThreadsPaginated: async () => ({ threads, has_more: false }) } as any;

    function backend() {
        return {
            writeThread: vi.fn(async () => true),
            remoteThreadUpdatedAt: vi.fn(async (id: string) => remote[id]),
        } as any;
    }

    it('writes only what the remote copy lacks, and repairs a damaged one', async () => {
        const b = backend();
        const out = await exportAllThreads(db, b, 'local-user', { skipNewerRemote: true });
        expect(b.writeThread.mock.calls.map((c: any[]) => c[2]).sort())
            .toEqual(['damaged-there', 'newer-here', 'only-here']);
        // A copy that is already this computer's version is not rewritten —
        // on a computer that just joined, that is everything it imported.
        expect(out).toEqual({ written: 3, failed: 0, skipped: 2, upToDate: 2 });
    });

    it('writes everything when not asked to look', async () => {
        const b = backend();
        const out = await exportAllThreads(db, b, 'local-user');
        expect(out.written).toBe(7);
        expect(b.remoteThreadUpdatedAt).not.toHaveBeenCalled();
    });
});
