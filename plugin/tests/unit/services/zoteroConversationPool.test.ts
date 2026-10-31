/**
 * The Zotero-attachments backend against a fake library: which "AlphainZ
 * Conversations" item files go under, what a read may create (nothing), how
 * archived threads are rewritten, what happens to files Zotero has not
 * downloaded, and how "Delete forever" reaches the other computers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    findOrCreateParentItem,
    findParentItems,
    importThreadAttachments,
    listThreadAttachments,
    reconcileArchiveState,
    untrashThreadAttachment,
    writeJsonAttachmentFile,
    writeThreadAttachment,
} from '../../../src/services/threadZoteroSync';
import { ZoteroConversationBackend } from '../../../src/services/conversationSync/zoteroBackend';
import { getSyncHealth, resetSyncHealth } from '../../../src/services/conversationSync/syncHealth';

const TAG = 'alphainz-conversations';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

const IN_SYNC = 2;
const TO_DOWNLOAD = 1;
const FORCE_DOWNLOAD = 4;
const TO_UPLOAD = 0;

/** Files on this disk, by path. */
let disk: Record<string, string>;
/** Files only Zotero's server has, by attachment key — what a download brings. */
let server: Record<string, string>;
let items: Map<number, any>;
let nextId: number;
let clock: number;
let parentsCreated: number;

function tick(): string {
    clock += 1;
    return `2026-09-24 10:00:${String(clock).padStart(2, '0')}`;
}

function addParent(dateAdded: string, key: string) {
    const parent: any = {
        id: nextId++, key, libraryID: 1, deleted: false, dateAdded, dateModified: dateAdded,
        children: [] as number[], tags: [TAG],
        isRegularItem: () => true,
        getAttachments(includeTrashed: boolean) {
            return parent.children.filter((id: number) => includeTrashed || !items.get(id)?.deleted);
        },
        async saveTx() { parent.dateModified = tick(); },
    };
    items.set(parent.id, parent);
    return parent;
}

function addAttachment(parent: any, filename: string, options: {
    content?: string;
    deleted?: boolean;
    dateModified?: string;
    syncState?: number;
} = {}) {
    const id = nextId++;
    const attachment: any = {
        id, key: `ATT${id}`, libraryID: 1, deleted: !!options.deleted,
        dateModified: options.dateModified ?? tick(),
        attachmentFilename: filename,
        attachmentSyncState: options.syncState ?? IN_SYNC,
        tags: [TAG],
        fields: { title: filename } as Record<string, string>,
        path: `/storage/ATT${id}/${filename}`,
        parentID: parent.id,
        isRegularItem: () => false,
        async getFilePathAsync() { return attachment.path in disk ? attachment.path : false; },
        getField(field: string) { return attachment.fields[field]; },
        setField(field: string, value: string) { attachment.fields[field] = value; },
        addTag() {},
        async saveTx() { attachment.dateModified = tick(); },
        eraseTx: vi.fn(async () => {
            items.delete(id);
            const owner = items.get(attachment.parentID);
            if (owner) owner.children = owner.children.filter((c: number) => c !== id);
            delete disk[attachment.path];
        }),
    };
    if (options.content !== undefined) disk[attachment.path] = options.content;
    parent.children.push(id);
    items.set(id, attachment);
    return attachment;
}

function threadFile(id: string, updatedAt: string, over: Record<string, unknown> = {}) {
    return JSON.stringify({
        format: 'alphainz.conversation', version: 1,
        thread: { id, name: `thread ${id.slice(0, 4)}`, createdAt: '2026-09-01T00:00:00Z', updatedAt },
        runs: [], exportedBy: 'machine-B', exportedAt: updatedAt, ...over,
    });
}

beforeEach(() => {
    disk = {};
    server = {};
    items = new Map();
    nextId = 1;
    clock = 0;
    parentsCreated = 0;
    resetSyncHealth();
    delete (Zotero as any).__alphainzConversationsParentCreation;

    (Zotero as any).Search = function () {
        return {
            addCondition() {},
            async search() {
                return [...items.values()].filter((item) => item.tags?.includes(TAG)).map((item) => item.id);
            },
        };
    };
    (Zotero as any).Items = {
        async getAsync(arg: number | number[]) {
            return Array.isArray(arg)
                ? arg.map((id) => items.get(id)).filter(Boolean)
                : items.get(arg);
        },
    };
    (Zotero as any).Item = function FakeItem() {
        const fields: Record<string, string> = {};
        const created: any = {
            libraryID: 1, deleted: false, tags: [] as string[],
            setField(field: string, value: string) { fields[field] = value; },
            addTag(tag: string) { created.tags.push(tag); },
            async saveTx() {
                // Slow enough for two creations to overlap if nothing stops them.
                await new Promise((resolve) => setTimeout(resolve, 5));
                parentsCreated += 1;
                const parent = addParent(tick(), `NEW${parentsCreated}`);
                Object.assign(created, parent);
            },
        };
        return created;
    };
    (Zotero as any).Attachments = {
        ...(Zotero as any).Attachments,
        importFromFile: vi.fn(async ({ file, parentItemID, title }: any) => {
            const parent = items.get(parentItemID);
            const filename = String(file).split('/').pop()!;
            const attachment = addAttachment(parent, filename, { content: disk[file], syncState: TO_UPLOAD });
            attachment.fields.title = title;
            return attachment;
        }),
    };
    (Zotero as any).getTempDirectory = () => ({ path: '/tmp' });
    (Zotero as any).Libraries = {
        ...(Zotero as any).Libraries,
        userLibraryID: 1,
        get: () => ({ lastSync: new Date('2026-09-24T10:30:00Z') }),
    };
    (Zotero as any).Users = { getLocalUserKey: () => 'machine-A' };
    (Zotero as any).Sync = {
        Runner: {
            syncInProgress: false,
            downloadFile: vi.fn(async (item: any) => {
                if (!(item.key in server)) return false;
                disk[item.path] = server[item.key];
                item.attachmentSyncState = IN_SYNC;
                return { localChanges: true };
            }),
        },
        Storage: {
            Local: {
                SYNC_STATE_TO_UPLOAD: TO_UPLOAD,
                SYNC_STATE_TO_DOWNLOAD: TO_DOWNLOAD,
                SYNC_STATE_IN_SYNC: IN_SYNC,
                SYNC_STATE_FORCE_UPLOAD: 3,
                SYNC_STATE_FORCE_DOWNLOAD: FORCE_DOWNLOAD,
                getEnabledForLibrary: () => true,
            },
        },
    };
    (Zotero as any).getActiveZoteroPane = () => ({ selectItem: vi.fn(async () => {}) });
    (Zotero as any).getMainWindow = () => ({ focus() {} });

    (IOUtils.exists as any).mockImplementation(async (p: string) => p in disk);
    (IOUtils.readUTF8 as any).mockImplementation(async (p: string) => {
        if (!(p in disk)) throw new Error(`missing ${p}`);
        return disk[p];
    });
    (IOUtils.writeUTF8 as any).mockImplementation(async (p: string, text: string) => { disk[p] = text; });
    (IOUtils.remove as any).mockImplementation(async (p: string) => { delete disk[p]; });
});

afterEach(() => {
    vi.clearAllMocks();
});

/** The structural db the import needs; records what reached it. */
function importDb(local: Record<string, { updatedAt: string; archivedAt?: string | null }> = {}) {
    const saved: string[] = [];
    return {
        saved,
        async getThread(_u: string, id: string) {
            return local[id] ? { id, name: 'n', createdAt: 'c', updatedAt: local[id].updatedAt } : null;
        },
        async threadArchivedAt(_u: string, id: string) {
            return id in local ? (local[id].archivedAt ?? null) : undefined;
        },
        async archiveThread(_u: string, id: string) { saved.push(`archive:${id}`); },
        async restoreThread(_u: string, id: string) { saved.push(`restore:${id}`); },
        async saveRun() {},
        async upsertThread(thread: any) { saved.push(`upsert:${thread.id}`); },
        async getRunsForThread() { return []; },
    } as any;
}

describe('two "AlphainZ Conversations" items', () => {
    it('reads the conversations under every one of them', async () => {
        const mine = addParent('2026-09-01 00:00:00', 'MINE');
        const theirs = addParent('2026-08-01 00:00:00', 'THEIRS');
        addAttachment(mine, `${T1}.json`, { content: threadFile(T1, '2026-09-10T00:00:00Z') });
        addAttachment(theirs, `${T2}.json`, { content: threadFile(T2, '2026-09-11T00:00:00Z') });

        expect((await listThreadAttachments(1)).map((a) => a.attachmentFilename).sort())
            .toEqual([`${T1}.json`, `${T2}.json`]);
        const db = importDb();
        const counts = await importThreadAttachments(db, 'u', 1);
        expect(counts.imported).toBe(2);
        expect(db.saved).toEqual(expect.arrayContaining([`upsert:${T1}`, `upsert:${T2}`]));
    });

    it('puts new files under the oldest one, which every computer agrees on', async () => {
        const newer = addParent('2026-09-01 00:00:00', 'NEWER');
        const oldest = addParent('2026-08-01 00:00:00', 'OLDEST');
        expect((await findOrCreateParentItem(1))?.key).toBe('OLDEST');
        await writeJsonAttachmentFile(1, `${T1}.json`, 'title', '{}');
        expect(oldest.children).toHaveLength(1);
        expect(newer.children).toHaveLength(0);
    });

    it('reads the settings exported last when each item carries a settings.json', async () => {
        const a = addParent('2026-08-01 00:00:00', 'A');
        const b = addParent('2026-09-01 00:00:00', 'B');
        addAttachment(a, 'settings.json', { content: JSON.stringify({ exportedAt: '2026-09-20T00:00:00Z', values: { v: 'late' } }) });
        addAttachment(b, 'settings.json', { content: JSON.stringify({ exportedAt: '2026-09-01T00:00:00Z', values: { v: 'early' } }) });
        const text = await new ZoteroConversationBackend().readSettingsDocument();
        expect(JSON.parse(text!).values.v).toBe('late');
    });
});

describe('creating the item', () => {
    it('never happens on a read', async () => {
        const backend = new ZoteroConversationBackend();
        await reconcileArchiveState(importDb(), 'u', 1, 'now');
        await importThreadAttachments(importDb(), 'u', 1);
        await backend.readSettingsDocument();
        await backend.settingsDocumentPresence();
        await backend.revealThread(T1);
        await backend.remoteThreadUpdatedAt(T1);
        await backend.countRemoteCopies();
        expect(parentsCreated).toBe(0);
        expect(await findParentItems(1)).toEqual([]);
    });

    it('happens once when two writes on a fresh computer race', async () => {
        await Promise.all([
            writeJsonAttachmentFile(1, `${T1}.json`, 'one', '{}'),
            writeJsonAttachmentFile(1, `${T2}.json`, 'two', '{}'),
        ]);
        expect(parentsCreated).toBe(1);
        expect((await findParentItems(1))[0].children).toHaveLength(2);
    });

    it('waits while Zotero may still be delivering another computer\'s item', async () => {
        (Zotero as any).Sync.Runner.syncInProgress = true;
        expect(await writeJsonAttachmentFile(1, `${T1}.json`, 'title', '{}')).toBeNull();
        expect(parentsCreated).toBe(0);
        // And a joining computer is told a settings document may be on its way.
        expect(await new ZoteroConversationBackend().settingsDocumentPresence()).toBe('unknown');
    });

    it('happens when the library is simply empty', async () => {
        expect(await new ZoteroConversationBackend().settingsDocumentPresence()).toBe('absent');
        expect(await writeJsonAttachmentFile(1, `${T1}.json`, 'title', '{}')).not.toBeNull();
        expect(parentsCreated).toBe(1);
    });
});

describe('an archived conversation', () => {
    function archivedDb(archivedAt: string | null) {
        return {
            async getThread() {
                return { id: T1, name: 'Renamed in the archive', createdAt: 'c', updatedAt: '2026-09-20T00:00:00Z' };
            },
            async getRunsForThread() { return []; },
            async threadArchivedAt() { return archivedAt; },
        } as any;
    }

    it('is rewritten in its trashed attachment, not given a live twin', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const trashed = addAttachment(parent, `${T1}.json`, { content: '{}', deleted: true });
        const written = await writeThreadAttachment(archivedDb('2026-09-19T00:00:00Z'), 'u', T1, 1, 'now');
        expect(written).toEqual({ created: false, key: trashed.key });
        expect(parent.children).toHaveLength(1);
        expect((Zotero as any).Attachments.importFromFile).not.toHaveBeenCalled();
        expect(trashed.deleted).toBe(true);
        expect(JSON.parse(disk[trashed.path]).thread.name).toBe('Renamed in the archive');
    });

    it('comes out of the trash when a write says it is active again', async () => {
        // Sending a message in an archived chat restores it here; its next
        // write carries that to the other computers.
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const trashed = addAttachment(parent, `${T1}.json`, { content: '{}', deleted: true });
        await writeThreadAttachment(archivedDb(null), 'u', T1, 1, 'now');
        expect(trashed.deleted).toBe(false);
    });

    it('is decided once per thread, by the copy written last', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, `${T1}.json`, { content: '{}', deleted: true, dateModified: '2026-09-01 00:00:00' });
        addAttachment(parent, `${T1}.json`, { content: '{}', deleted: false, dateModified: '2026-09-02 00:00:00' });
        const restoredDb = importDb({ [T1]: { updatedAt: 'x', archivedAt: '2026-08-30T00:00:00Z' } });
        const out = await reconcileArchiveState(restoredDb, 'u', 1, 'now');
        expect(out).toEqual({ archived: 0, restored: 1 });
        expect(restoredDb.saved).toEqual([`restore:${T1}`]);

        const activeDb = importDb({ [T1]: { updatedAt: 'x', archivedAt: null } });
        expect(await reconcileArchiveState(activeDb, 'u', 1, 'now')).toEqual({ archived: 0, restored: 0 });
    });

    it('stays active when this computer used it after it was trashed', async () => {
        // A message sent in the archived chat restored it here; a pass
        // running before its next write must not archive it again.
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const trashed = addAttachment(parent, `${T1}.json`, {
            content: '{}', deleted: true, dateModified: '2026-09-20 10:00:00',
        });
        const db = importDb({ [T1]: { updatedAt: '2026-09-24T09:00:00Z', archivedAt: null } });
        expect(await reconcileArchiveState(db, 'u', 1, 'now')).toEqual({ archived: 0, restored: 0 });
        expect(db.saved).toEqual([]);
        expect(trashed.deleted).toBe(false);

        // Trashed after this computer last used it: another computer's archive.
        trashed.deleted = true;
        trashed.dateModified = '2026-09-24 10:00:00';
        expect((await reconcileArchiveState(db, 'u', 1, 'now')).archived).toBe(1);
    });

    it('stays archived when its attachment has not heard of the archiving yet', async () => {
        // Archived here, but the trash did not reach the attachment (the
        // library was busy): an attachment untouched since is not a restore.
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const live = addAttachment(parent, `${T1}.json`, { content: '{}', dateModified: '2026-09-20 10:00:00' });
        const db = importDb({ [T1]: { updatedAt: '2026-09-20T09:00:00Z', archivedAt: '2026-09-22T00:00:00Z' } });
        expect(await reconcileArchiveState(db, 'u', 1, 'now')).toEqual({ archived: 0, restored: 0 });
        expect(live.deleted).toBe(true);

        // Taken out of the trash after the archiving: a restore made elsewhere.
        live.deleted = false;
        live.dateModified = '2026-09-23 10:00:00';
        expect((await reconcileArchiveState(db, 'u', 1, 'now')).restored).toBe(1);
    });

    it('is restored whole: every trashed copy comes out, so no twin sends it back', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const a = addAttachment(parent, `${T1}.json`, { content: '{}', deleted: true });
        const b = addAttachment(parent, `${T1}.json`, { content: '{}', deleted: true });
        expect(await untrashThreadAttachment(T1, 1)).toBe(true);
        expect([a.deleted, b.deleted]).toEqual([false, false]);
    });

    it('can still be shown in Zotero', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, `${T1}.json`, { content: '{}', deleted: true });
        expect(await new ZoteroConversationBackend().revealThread(T1)).toBe('revealed');
    });
});

describe('a conversation whose file Zotero has not downloaded', () => {
    it('is fetched, the way opening it would, and imported', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const attachment = addAttachment(parent, `${T1}.json`, { syncState: TO_DOWNLOAD });
        server[attachment.key] = threadFile(T1, '2026-09-10T00:00:00Z');
        const counts = await importThreadAttachments(importDb(), 'u', 1);
        expect((Zotero as any).Sync.Runner.downloadFile).toHaveBeenCalledWith(attachment);
        expect(counts).toMatchObject({ imported: 1, waiting: 0 });
    });

    it('is refreshed when the copy here is older than the server\'s', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const attachment = addAttachment(parent, `${T1}.json`, {
            content: threadFile(T1, '2026-09-01T00:00:00Z'), syncState: FORCE_DOWNLOAD,
        });
        server[attachment.key] = threadFile(T1, '2026-09-10T00:00:00Z');
        const db = importDb({ [T1]: { updatedAt: '2026-09-05T00:00:00Z' } });
        expect((await importThreadAttachments(db, 'u', 1)).imported).toBe(1);
    });

    it('counts as waiting while the download fails, and keeps the retry signal', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, `${T1}.json`, { syncState: TO_DOWNLOAD });   // nothing on the server yet
        const counts = await importThreadAttachments(importDb(), 'u', 1);
        expect(counts).toMatchObject({ imported: 0, skipped: 1, waiting: 1 });
    });

    it('is not written over while Zotero is still to replace it', async () => {
        // Overwriting a file Zotero is about to download is a sync conflict.
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const stale = addAttachment(parent, `${T1}.json`, { content: 'older', syncState: FORCE_DOWNLOAD });
        expect(await writeJsonAttachmentFile(1, `${T1}.json`, 'title', 'newer')).toBeNull();
        expect(disk[stale.path]).toBe('older');
    });

    it('tells a backfill what the copy here is: current, still to come, from a newer version, or damaged', async () => {
        const backend = new ZoteroConversationBackend();
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const copy = addAttachment(parent, `${T1}.json`, { content: threadFile(T1, '2026-09-10T00:00:00Z') });
        expect(await backend.remoteThreadUpdatedAt(T1)).toBe('2026-09-10T00:00:00Z');
        disk[copy.path] = threadFile(T1, '2026-09-10T00:00:00Z', { version: 99 });
        expect(await backend.remoteThreadUpdatedAt(T1)).toBe('unreadable');
        disk[copy.path] = threadFile(T1, '2026-09-10T00:00:00Z').slice(0, 40);   // cut short
        expect(await backend.remoteThreadUpdatedAt(T1)).toBe('damaged');
        delete disk[copy.path];   // the file has not arrived
        expect(await backend.remoteThreadUpdatedAt(T1)).toBe('unreadable');
    });

    it('is reported by the backend\'s pass, with file syncing and stuck uploads', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, `${T1}.json`, { syncState: TO_DOWNLOAD });
        // Written before the last sync finished, and still not uploaded.
        addAttachment(parent, `${T2}.json`, {
            content: threadFile(T2, '2026-09-10T00:00:00Z'), syncState: TO_UPLOAD, dateModified: '2026-09-24 09:00:00',
        });
        await new ZoteroConversationBackend().importAll(importDb(), 'u');
        expect(getSyncHealth()).toMatchObject({ waiting: 1, stuckUploads: 1, fileSyncOff: false });

        (Zotero as any).Sync.Storage.Local.getEnabledForLibrary = () => false;
        await new ZoteroConversationBackend().importAll(importDb(), 'u');
        expect(getSyncHealth().fileSyncOff).toBe(true);
    });

    it('does not call a file stuck while a Zotero sync is still uploading', async () => {
        // Zotero stamps the library's last sync when its data is done, before
        // the files go up: mid-sync, a file written just before looks stuck.
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, `${T2}.json`, {
            content: threadFile(T2, '2026-09-10T00:00:00Z'), syncState: TO_UPLOAD, dateModified: '2026-09-24 09:00:00',
        });
        (Zotero as any).Sync.Runner.syncInProgress = true;
        await new ZoteroConversationBackend().importAll(importDb(), 'u');
        expect(getSyncHealth().stuckUploads).toBe(0);

        (Zotero as any).Sync.Runner.syncInProgress = false;
        await new ZoteroConversationBackend().importAll(importDb(), 'u');
        expect(getSyncHealth().stuckUploads).toBe(1);
    });
});

describe('"Delete forever" under Zotero sync', () => {
    function tombstoneDb(local: Record<string, string>, tombstones: Record<string, string> = {}) {
        const deleted: string[] = [];
        return {
            deleted,
            tombstones,
            async getThread(_u: string, id: string) {
                return local[id] ? { id, name: 'n', createdAt: 'c', updatedAt: local[id] } : null;
            },
            async threadArchivedAt(_u: string, id: string) { return id in local ? '2026-09-01T00:00:00Z' : undefined; },
            async threadTombstone(_u: string, id: string) { return tombstones[id] ?? null; },
            async threadTombstones() {
                return Object.entries(tombstones).map(([thread_id, deleted_at]) => ({ thread_id, deleted_at }));
            },
            async addThreadTombstone(_u: string, id: string, at: string) { tombstones[id] = at; },
            async removeThreadTombstone(_u: string, id: string) { delete tombstones[id]; },
            async deleteThread(_u: string, id: string) { deleted.push(id); delete local[id]; },
            async saveRun() {},
            async upsertThread() {},
        } as any;
    }

    it('erases the transcript — out of the trash too — and records the deletion for the others', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const archived = addAttachment(parent, `${T1}.json`, { content: '{}', deleted: true });
        const ok = await new ZoteroConversationBackend().purgeThread(tombstoneDb({}), 'u', T1, '2026-09-24T12:00:00Z');
        expect(ok).toBe(true);
        expect(archived.eraseTx).toHaveBeenCalled();
        const ledger = [...items.values()].find((item) => item.attachmentFilename === 'deleted-threads.json');
        expect(JSON.parse(disk[ledger.path]).entries[T1]).toBe('2026-09-24T12:00:00Z');
    });

    it('reaches the other computer: its copy leaves at the next pass', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, 'deleted-threads.json', {
            content: JSON.stringify({ format: 'alphainz.deleted-threads', version: 1, entries: { [T1]: '2026-09-24T12:00:00Z' } }),
        });
        const stray = addAttachment(parent, `${T1}.json`, { content: threadFile(T1, '2026-09-20T00:00:00Z'), deleted: true });
        const db = tombstoneDb({ [T1]: '2026-09-20T00:00:00Z' });
        await new ZoteroConversationBackend().importAll(db, 'u');
        expect(db.deleted).toEqual([T1]);
        expect(db.tombstones[T1]).toBe('2026-09-24T12:00:00Z');
        expect(stray.eraseTx).toHaveBeenCalled();
    });

    it('loses to a copy edited after the deletion', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, 'deleted-threads.json', {
            content: JSON.stringify({ format: 'alphainz.deleted-threads', version: 1, entries: { [T1]: '2026-09-24T12:00:00Z' } }),
        });
        const db = tombstoneDb({ [T1]: '2026-09-24T13:00:00Z' });
        await new ZoteroConversationBackend().importAll(db, 'u');
        expect(db.deleted).toEqual([]);
    });

    it('leaves another computer\'s copy edited after the deletion, and the thread comes back here', async () => {
        // Deleted here at 12:00; the other computer, not having heard, went on
        // in the chat at 13:00. Its copy is the newest fact about the thread.
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, 'deleted-threads.json', {
            content: JSON.stringify({ format: 'alphainz.deleted-threads', version: 1, entries: { [T1]: '2026-09-24T12:00:00Z' } }),
        });
        const revived = addAttachment(parent, `${T1}.json`, {
            content: threadFile(T1, '2026-09-24T13:00:00Z'), dateModified: '2026-09-24 13:00:05',
        });
        const db = tombstoneDb({}, { [T1]: '2026-09-24T12:00:00Z' });
        const counts = await new ZoteroConversationBackend().importAll(db, 'u');
        expect(revived.eraseTx).not.toHaveBeenCalled();
        expect(counts.imported).toBe(1);
        expect(db.tombstones[T1]).toBeUndefined();
    });

    it('keeps a copy changed since the deletion while it cannot be read', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        addAttachment(parent, 'deleted-threads.json', {
            content: JSON.stringify({ format: 'alphainz.deleted-threads', version: 1, entries: { [T1]: '2026-09-24T12:00:00Z' } }),
        });
        const pending = addAttachment(parent, `${T1}.json`, {
            syncState: TO_DOWNLOAD, dateModified: '2026-09-24 13:00:05',
        });
        await new ZoteroConversationBackend().importAll(tombstoneDb({}), 'u');
        expect(pending.eraseTx).not.toHaveBeenCalled();
    });

    it('never overwrites a ledger it could not read', async () => {
        const parent = addParent('2026-08-01 00:00:00', 'P');
        const ledger = addAttachment(parent, 'deleted-threads.json', { syncState: TO_DOWNLOAD });
        const db = tombstoneDb({}, { [T2]: '2026-09-24T12:00:00Z' });
        await new ZoteroConversationBackend().importAll(db, 'u');
        expect(ledger.path in disk).toBe(false);
        expect(parent.children).toHaveLength(1);
    });
});
