/**
 * The plain-folder backend: what it reads, what it refuses, and the archive
 * reconcile rule a folder needs because it has no trash of its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));

import { FolderConversationBackend } from '../../../src/services/conversationSync/folderBackend';
import { getSyncHealth, resetSyncHealth } from '../../../src/services/conversationSync/syncHealth';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

/** A file map the IOUtils stubs serve from. */
let files: Record<string, string>;

function envelope(over: Record<string, unknown> = {}, thread: Record<string, unknown> = {}) {
    return JSON.stringify({
        format: 'alphainz.conversation',
        version: 1,
        thread: {
            id: U1, name: 'T', createdAt: '2026-08-01T00:00:00Z',
            updatedAt: '2026-08-20T00:00:00Z', archivedAt: null, ...thread,
        },
        runs: [],
        exportedBy: 'other-machine',
        exportedAt: '2026-08-20T00:00:00Z',
        ...over,
    });
}

function fakeDb(threads: Record<string, { updatedAt: string; archivedAt?: string | null }>) {
    const calls: string[] = [];
    return {
        calls,
        getThread: vi.fn(async (_u: string, id: string) =>
            threads[id] ? { id, updatedAt: threads[id].updatedAt } : null),
        threadArchivedAt: vi.fn(async (_u: string, id: string) =>
            id in threads ? (threads[id].archivedAt ?? null) : undefined),
        archiveThread: vi.fn(async (_u: string, id: string) => { calls.push(`archive:${id}`); }),
        restoreThread: vi.fn(async (_u: string, id: string) => { calls.push(`restore:${id}`); }),
        saveRun: vi.fn(async () => { calls.push('saveRun'); }),
        upsertThread: vi.fn(async (t: any) => { calls.push(`upsert:${t.id}`); }),
        getRunsForThread: vi.fn(async () => []),
    };
}

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    files = {};
    resetSyncHealth();
    (IOUtils.makeDirectory as any).mockClear();
    const dir = '/sync/conversations';
    (IOUtils.exists as any).mockImplementation(async (p: string) =>
        p === dir || p === '/sync' || p in files);
    (IOUtils.getChildren as any).mockImplementation(async (p: string) => {
        if (p !== dir) throw new Error('no dir');
        return Object.keys(files);
    });
    (IOUtils.stat as any).mockImplementation(async (p: string) => {
        if (!(p in files)) throw new Error('missing');
        return { size: files[p].length, lastModified: 1 };
    });
    (IOUtils.readUTF8 as any).mockImplementation(async (p: string) => {
        if (!(p in files)) throw new Error('missing');
        return files[p];
    });
    (IOUtils.writeUTF8 as any).mockImplementation(async (p: string, text: string) => {
        files[p] = text;
    });
    (IOUtils.makeDirectory as any).mockResolvedValue(undefined);
});

describe('importAll', () => {
    it('reads exactly-named files and counts conflict copies instead of importing them', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope();
        files[`/sync/conversations/${U1} 2.json`] = envelope();      // iCloud conflict copy
        files['/sync/conversations/settings.json'] = '{}';           // not a thread
        files['/sync/conversations/notes.txt'] = 'x';                // not even json
        const db = fakeDb({});
        const backend = new FolderConversationBackend('/sync');
        const counts = await backend.importAll(db as any, 'u');
        expect(counts.imported).toBe(1);
        expect(counts.conflictCopies).toBe(2);  // the copy AND settings.json
        expect(db.calls).toContain(`upsert:${U1}`);
    });

    it('returns zeros when the folder does not exist, and never creates it', async () => {
        (IOUtils.exists as any).mockResolvedValue(false);
        const backend = new FolderConversationBackend('/gone');
        const counts = await backend.importAll(fakeDb({}) as any, 'u');
        expect(counts).toEqual({ imported: 0, skipped: 0, unreadable: 0, conflictCopies: 0, waiting: 0 });
        expect(IOUtils.makeDirectory).not.toHaveBeenCalled();
    });

    it('counts an unreadable file as skipped — the retry signal — not as broken', async () => {
        // An evicted iCloud placeholder: listed, but stat/read fail.
        files[`/sync/conversations/${U1}.json`] = envelope();
        (IOUtils.stat as any).mockImplementation(async () => { throw new Error('evicted'); });
        const backend = new FolderConversationBackend('/sync');
        const counts = await backend.importAll(fakeDb({}) as any, 'u');
        expect(counts.skipped).toBe(1);
        expect(counts.unreadable).toBe(0);
    });

    it('counts a corrupt file as unreadable', async () => {
        files[`/sync/conversations/${U1}.json`] = 'not json';
        const backend = new FolderConversationBackend('/sync');
        const counts = await backend.importAll(fakeDb({}) as any, 'u');
        expect(counts.unreadable).toBe(1);
    });

    it('does not resurrect a remotely-archived thread this machine has never seen', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope({}, { archivedAt: '2026-08-19T00:00:00Z' });
        const db = fakeDb({});
        const backend = new FolderConversationBackend('/sync');
        const counts = await backend.importAll(db as any, 'u');
        expect(counts.skipped).toBe(1);
        expect(db.calls).toEqual([]);
    });
});

describe('reconcileArchive', () => {
    it('archives locally when the file says archived', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope({}, { archivedAt: '2026-08-21T00:00:00Z' });
        const db = fakeDb({ [U1]: { updatedAt: '2026-08-20T00:00:00Z', archivedAt: null } });
        const backend = new FolderConversationBackend('/sync');
        const out = await backend.reconcileArchive(db as any, 'u', 'now');
        expect(out.archived).toBe(1);
        expect(db.calls).toContain(`archive:${U1}`);
    });

    it('restores locally only when the file was written after our archive action', async () => {
        // File exported later than the local archive stamp: someone restored.
        files[`/sync/conversations/${U1}.json`] = envelope(
            { exportedAt: '2026-08-25T00:00:00Z' }, { archivedAt: null },
        );
        const db = fakeDb({ [U1]: { updatedAt: '2026-08-20T00:00:00Z', archivedAt: '2026-08-22T00:00:00Z' } });
        const backend = new FolderConversationBackend('/sync');
        const out = await backend.reconcileArchive(db as any, 'u', 'now');
        expect(out.restored).toBe(1);
        expect(db.calls).toContain(`restore:${U1}`);
    });

    it('pushes local state into a stale file instead of resurrecting the thread', async () => {
        // File is OLDER than our archive: it simply has not heard yet.
        files[`/sync/conversations/${U2}.json`] = envelope(
            { exportedAt: '2026-08-21T00:00:00Z' }, { id: U2, archivedAt: null },
        );
        const db = fakeDb({ [U2]: { updatedAt: '2026-08-20T00:00:00Z', archivedAt: '2026-08-22T00:00:00Z' } });
        const backend = new FolderConversationBackend('/sync');
        const out = await backend.reconcileArchive(db as any, 'u', '2026-08-23T00:00:00Z');
        expect(out.restored).toBe(0);
        expect(db.calls).not.toContain(`restore:${U2}`);
        // Self-heal: the file was rewritten with our archivedAt.
        const rewritten = JSON.parse(files[`/sync/conversations/${U2}.json`]);
        expect(rewritten.thread.archivedAt).toBe('2026-08-22T00:00:00Z');
    });

    it('keeps a chat used here after it was archived elsewhere, and says so in the file', async () => {
        // Sending a message in an archived chat restores it here; a pass
        // running meanwhile must not put it back, and the other machine
        // should hear that it is back.
        files[`/sync/conversations/${U1}.json`] = envelope(
            { exportedAt: '2026-08-21T00:00:00Z' }, { archivedAt: '2026-08-21T00:00:00Z' },
        );
        const db = {
            ...fakeDb({ [U1]: { updatedAt: '2026-08-25T00:00:00Z', archivedAt: null } }),
            getThread: vi.fn(async () => ({
                id: U1, name: 'T', createdAt: 'c', updatedAt: '2026-08-25T00:00:00Z',
            })),
        };
        const out = await new FolderConversationBackend('/sync').reconcileArchive(db as any, 'u', 'now');
        expect(out.archived).toBe(0);
        expect(db.calls).not.toContain(`archive:${U1}`);
        expect(JSON.parse(files[`/sync/conversations/${U1}.json`]).thread.archivedAt).toBeNull();
    });

    it('makes no claim for a file from an older writer with no archivedAt field', async () => {
        const raw = JSON.parse(envelope());
        delete raw.thread.archivedAt;
        files[`/sync/conversations/${U1}.json`] = JSON.stringify(raw);
        const db = fakeDb({ [U1]: { updatedAt: '2026-08-20T00:00:00Z', archivedAt: '2026-08-22T00:00:00Z' } });
        const backend = new FolderConversationBackend('/sync');
        const out = await backend.reconcileArchive(db as any, 'u', 'now');
        expect(out).toEqual({ archived: 0, restored: 0 });
        expect(db.calls).toEqual([]);
    });
});

describe('deletion ledger', () => {
    /** fakeDb plus the tombstone surface the ledger sync needs. */
    function tombstoneDb(
        threads: Record<string, { updatedAt: string }>,
        tombstones: Record<string, string> = {},
    ) {
        const base = fakeDb(threads as any);
        const deleted: string[] = [];
        return {
            ...base,
            deleted,
            tombstones,
            threadTombstone: vi.fn(async (_u: string, id: string) => tombstones[id] ?? null),
            threadTombstones: vi.fn(async () =>
                Object.entries(tombstones).map(([thread_id, deleted_at]) => ({ thread_id, deleted_at }))),
            addThreadTombstone: vi.fn(async (_u: string, id: string, at: string) => {
                const prev = tombstones[id];
                if (!prev || Date.parse(at) > Date.parse(prev)) tombstones[id] = at;
            }),
            removeThreadTombstone: vi.fn(async (_u: string, id: string) => { delete tombstones[id]; }),
            deleteThread: vi.fn(async (_u: string, id: string) => { deleted.push(id); }),
        };
    }

    const ledger = (entries: Record<string, string>, over: Record<string, unknown> = {}) =>
        JSON.stringify({
            format: 'alphainz.deleted-threads', version: 1, entries,
            exportedBy: 'other', exportedAt: '2026-08-28T00:00:00Z', ...over,
        });

    beforeEach(() => {
        (IOUtils.remove as any).mockImplementation(async (p: string) => { delete files[p]; });
    });

    it('applies a folder deletion claim: local thread gone, file gone, tombstone kept', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope();
        files['/sync/deleted-threads.json'] = ledger({ [U1]: '2026-08-25T00:00:00Z' });
        const db = tombstoneDb({ [U1]: { updatedAt: '2026-08-20T00:00:00Z' } });
        const backend = new FolderConversationBackend('/sync');
        await backend.importAll(db as any, 'u');
        expect(db.deleted).toEqual([U1]);
        expect(files[`/sync/conversations/${U1}.json`]).toBeUndefined();
        expect(db.tombstones[U1]).toBe('2026-08-25T00:00:00Z');
    });

    it('a copy edited after the recorded deletion revives instead', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope({}, { updatedAt: '2026-08-27T00:00:00Z' });
        files['/sync/deleted-threads.json'] = ledger({ [U1]: '2026-08-25T00:00:00Z' });
        // The local copy is older than the file AND newer than the deletion:
        // the ledger claim loses, the tombstone drops, and the file imports.
        const db = tombstoneDb(
            { [U1]: { updatedAt: '2026-08-26T00:00:00Z' } },
            { [U1]: '2026-08-25T00:00:00Z' },
        );
        const backend = new FolderConversationBackend('/sync');
        const counts = await backend.importAll(db as any, 'u');
        expect(db.deleted).toEqual([]);
        expect(db.tombstones[U1]).toBeUndefined();
        expect(counts.imported).toBe(1);
    });

    it('leaves another computer\'s file edited after the deletion, and the thread comes back here', async () => {
        // Deleted here on the 25th; the other computer went on in the chat on
        // the 27th before it heard. Its file is the newest fact about it.
        files[`/sync/conversations/${U1}.json`] = envelope({}, { updatedAt: '2026-08-27T00:00:00Z' });
        files['/sync/deleted-threads.json'] = ledger({ [U1]: '2026-08-25T00:00:00Z' });
        const db = tombstoneDb({}, { [U1]: '2026-08-25T00:00:00Z' });
        const counts = await new FolderConversationBackend('/sync').importAll(db as any, 'u');
        expect(files[`/sync/conversations/${U1}.json`]).toBeDefined();
        expect(counts.imported).toBe(1);
        expect(db.tombstones[U1]).toBeUndefined();
    });

    it('does not replace a ledger iCloud has not downloaded yet', async () => {
        files['/sync/.deleted-threads.json.icloud'] = '';
        const db = tombstoneDb({}, { [U2]: '2026-08-26T00:00:00Z' });
        await new FolderConversationBackend('/sync').importAll(db as any, 'u');
        expect(files['/sync/deleted-threads.json']).toBeUndefined();
    });

    it('pushes local tombstones into the ledger, keeping the later time per id', async () => {
        files['/sync/deleted-threads.json'] = ledger({ [U1]: '2026-08-25T00:00:00Z' });
        const db = tombstoneDb({}, {
            [U1]: '2026-08-24T00:00:00Z',   // older than the folder's — folder wins
            [U2]: '2026-08-26T00:00:00Z',   // new claim — joins the ledger
        });
        const backend = new FolderConversationBackend('/sync');
        await backend.importAll(db as any, 'u');
        const written = JSON.parse(files['/sync/deleted-threads.json']);
        expect(written.entries[U1]).toBe('2026-08-25T00:00:00Z');
        expect(written.entries[U2]).toBe('2026-08-26T00:00:00Z');
    });

    it('never rewrites a ledger from a newer plugin version', async () => {
        const future = ledger({ [U1]: '2026-08-25T00:00:00Z' }, { version: 9 });
        files['/sync/deleted-threads.json'] = future;
        const db = tombstoneDb({}, { [U2]: '2026-08-26T00:00:00Z' });
        const backend = new FolderConversationBackend('/sync');
        await backend.importAll(db as any, 'u');
        expect(files['/sync/deleted-threads.json']).toBe(future);
    });

    it('a corrupt ledger reads as empty and is healed by the next merge', async () => {
        files['/sync/deleted-threads.json'] = '{not json';
        const db = tombstoneDb({}, { [U2]: '2026-08-26T00:00:00Z' });
        const backend = new FolderConversationBackend('/sync');
        await backend.importAll(db as any, 'u');
        const written = JSON.parse(files['/sync/deleted-threads.json']);
        expect(written.entries[U2]).toBe('2026-08-26T00:00:00Z');
        expect(written.version).toBe(1);
    });

    it('purgeThread removes the file and records the claim', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope();
        const db = tombstoneDb({});
        const backend = new FolderConversationBackend('/sync');
        const ok = await backend.purgeThread(db as any, 'u', U1, '2026-08-29T00:00:00Z');
        expect(ok).toBe(true);
        expect(files[`/sync/conversations/${U1}.json`]).toBeUndefined();
        expect(JSON.parse(files['/sync/deleted-threads.json']).entries[U1]).toBe('2026-08-29T00:00:00Z');
    });

    it('a stray file for a tombstoned thread is skipped and removed, not imported', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope({}, { updatedAt: '2026-08-20T00:00:00Z' });
        const db = tombstoneDb({}, { [U1]: '2026-08-25T00:00:00Z' });
        const backend = new FolderConversationBackend('/sync');
        const counts = await backend.importAll(db as any, 'u');
        expect(counts.imported).toBe(0);
        expect(files[`/sync/conversations/${U1}.json`]).toBeUndefined();
        expect(db.calls).not.toContain(`upsert:${U1}`);
    });

    it('a db without the tombstone surface skips the ledger entirely — old fakes, old callers', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope();
        files['/sync/deleted-threads.json'] = ledger({ [U1]: '2026-08-25T00:00:00Z' });
        const db = fakeDb({});
        const backend = new FolderConversationBackend('/sync');
        const counts = await backend.importAll(db as any, 'u');
        expect(counts.imported).toBe(1);
    });
});

/*
 * What a pass could not do is recorded for the history footer, so "last
 * synced" is never the only thing it says while nothing is arriving.
 */
describe('what a pass reports', () => {
    it('says the sync folder is missing, and not when it merely has no conversations yet', async () => {
        (IOUtils.exists as any).mockResolvedValue(false);
        await new FolderConversationBackend('/Volumes/Unplugged/AlphainZ').importAll(fakeDb({}) as any, 'u');
        expect(getSyncHealth().folderMissing).toBe(true);

        // The folder is there, it just holds no conversations dir yet.
        (IOUtils.exists as any).mockImplementation(async (p: string) => p === '/fresh');
        await new FolderConversationBackend('/fresh').importAll(fakeDb({}) as any, 'u');
        expect(getSyncHealth().folderMissing).toBe(false);
    });

    it('counts conflict copies and files still downloading', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope();
        files[`/sync/conversations/${U1} 2.json`] = envelope();
        files[`/sync/conversations/.${U2}.json.icloud`] = '';   // not downloaded yet
        const counts = await new FolderConversationBackend('/sync').importAll(fakeDb({}) as any, 'u');
        expect(counts.waiting).toBe(1);
        expect(counts.skipped).toBeGreaterThanOrEqual(1);       // still the retry signal
        expect(getSyncHealth()).toMatchObject({ conflictCopies: 1, waiting: 1, folderMissing: false });
    });

    it('keeps a failed write until the next one succeeds', async () => {
        const db = { ...fakeDb({ [U1]: { updatedAt: '2026-08-20T00:00:00Z' } }), getThread: vi.fn(async () => ({
            id: U1, name: 'T', createdAt: 'c', updatedAt: '2026-08-20T00:00:00Z',
        })) };
        const backend = new FolderConversationBackend('/sync');
        (IOUtils.writeUTF8 as any).mockRejectedValueOnce(new Error('EACCES: permission denied'));
        expect(await backend.writeThread(db as any, 'u', U1, 'now')).toBe(false);
        expect(getSyncHealth().lastWriteError).toContain('EACCES');
        expect(await backend.writeThread(db as any, 'u', U1, 'now')).toBe(true);
        expect(getSyncHealth().lastWriteError).toBeNull();
    });
});

describe('what a machine joining can learn before writing', () => {
    it('knows whether a settings document is there, even one it cannot read', async () => {
        const backend = new FolderConversationBackend('/sync');
        expect(await backend.settingsDocumentPresence()).toBe('absent');
        files['/sync/.settings.json.icloud'] = '';       // iCloud has it, not downloaded
        expect(await backend.settingsDocumentPresence()).toBe('present');
        delete files['/sync/.settings.json.icloud'];
        files['/sync/settings.json'] = '{}';
        expect(await backend.settingsDocumentPresence()).toBe('present');
    });

    it('cannot tell when the folder itself is not there', async () => {
        (IOUtils.exists as any).mockResolvedValue(false);
        expect(await new FolderConversationBackend('/gone').settingsDocumentPresence()).toBe('unknown');
    });

    it('reads the updatedAt of a remote copy, and says when it cannot', async () => {
        const backend = new FolderConversationBackend('/sync');
        expect(await backend.remoteThreadUpdatedAt(U1)).toBeNull();
        files[`/sync/conversations/${U1}.json`] = envelope({}, { updatedAt: '2026-09-01T00:00:00Z' });
        expect(await backend.remoteThreadUpdatedAt(U1)).toBe('2026-09-01T00:00:00Z');
        // Cut short or not JSON: nothing a backfill could lose by replacing it.
        files[`/sync/conversations/${U1}.json`] = '{"format":"alphainz.conversation","version":1,"thread":{"id"';
        expect(await backend.remoteThreadUpdatedAt(U1)).toBe('damaged');
        files[`/sync/conversations/${U1}.json`] = 'garbage';
        expect(await backend.remoteThreadUpdatedAt(U1)).toBe('damaged');
        // Written by a newer version: another computer's work, left alone.
        files[`/sync/conversations/${U1}.json`] = JSON.stringify({ ...JSON.parse(envelope()), version: 99 });
        expect(await backend.remoteThreadUpdatedAt(U1)).toBe('unreadable');
        delete files[`/sync/conversations/${U1}.json`];
        files[`/sync/conversations/.${U1}.json.icloud`] = '';
        expect(await backend.remoteThreadUpdatedAt(U1)).toBe('unreadable');
    });

    it('counts the conversation files a deletion would remove', async () => {
        files[`/sync/conversations/${U1}.json`] = envelope();
        files[`/sync/conversations/${U2}.json`] = envelope({}, { id: U2 });
        files[`/sync/conversations/${U1} 2.json`] = envelope();   // left for the user
        expect(await new FolderConversationBackend('/sync').countRemoteCopies()).toBe(2);
    });
});
