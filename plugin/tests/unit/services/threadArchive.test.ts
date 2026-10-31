/**
 * The archive, and why deletion needed one.
 *
 * Deleting a conversation destroyed it, and the propagation was one-way: the
 * import only ever added, so a conversation deleted on Windows sat in the
 * Mac's history for good while its attachment was already in Zotero's trash.
 *
 * Both are the same fix. Zotero's trash is already synced and already means
 * "removed but recoverable", so it *is* the archive as far as the other
 * machines are concerned: archiving trashes the attachment, and a trashed
 * attachment archives the local copy.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { reconcileArchiveState } from '../../../src/services/threadZoteroSync';

/**
 * A library holding one conversations item with the given children.
 *
 * `getAsync` is called two ways by the code under test — with a single id to
 * resolve the parent, and with an array to load its children — so the double
 * must answer both.
 */
function libraryWith(files: Array<{ name: string; deleted: boolean }>) {
    const children = files.map((f, i) => ({
        id: i + 1, deleted: f.deleted, attachmentFilename: f.name,
    }));
    const parent = {
        id: 99, deleted: false,
        isRegularItem: () => true,
        getAttachments: () => children.map((c) => c.id),
    };
    (Zotero as any).Search = function () {
        return { addCondition() {}, async search() { return [parent.id]; } };
    };
    (Zotero as any).Items = {
        async getAsync(arg: number | number[]) {
            return Array.isArray(arg) ? children : parent;
        },
    };
    return children;
}

function fakeDb(state: Record<string, string | null | undefined>) {
    return {
        calls: [] as string[],
        async threadArchivedAt(_u: string, id: string) { return state[id]; },
        async archiveThread(_u: string, id: string) { this.calls.push(`archive:${id}`); state[id] = 'now'; },
        async restoreThread(_u: string, id: string) { this.calls.push(`restore:${id}`); state[id] = null; },
    };
}

describe('reconciling the archive with Zotero', () => {
    it('archives locally when the attachment was trashed elsewhere', async () => {
        libraryWith([{ name: '11111111-1111-4111-8111-111111111111.json', deleted: true }]);
        const db = fakeDb({ '11111111-1111-4111-8111-111111111111': null });
        const out = await reconcileArchiveState(db as any, 'u', 1, 'now');
        expect(db.calls).toEqual(['archive:11111111-1111-4111-8111-111111111111']);
        expect(out.archived).toBe(1);
    });

    it('restores locally when the attachment came back out of the trash', async () => {
        libraryWith([{ name: '11111111-1111-4111-8111-111111111111.json', deleted: false }]);
        const db = fakeDb({ '11111111-1111-4111-8111-111111111111': '2026-08-24T00:00:00Z' });
        const out = await reconcileArchiveState(db as any, 'u', 1, 'now');
        expect(db.calls).toEqual(['restore:11111111-1111-4111-8111-111111111111']);
        expect(out.restored).toBe(1);
    });

    it('does nothing when the two already agree', async () => {
        libraryWith([{ name: 'a.json', deleted: true }, { name: 'b.json', deleted: false }]);
        const db = fakeDb({ a: 'archived', b: null });
        const out = await reconcileArchiveState(db as any, 'u', 1, 'now');
        expect(db.calls).toEqual([]);
        expect(out).toEqual({ archived: 0, restored: 0 });
    });

    it('leaves a conversation this machine has never seen to the importer', async () => {
        // `undefined` means no local row at all. Archiving it would create one.
        libraryWith([{ name: 'th-new.json', deleted: false }]);
        const db = fakeDb({});
        await reconcileArchiveState(db as any, 'u', 1, 'now');
        expect(db.calls).toEqual([]);
    });

    it('ignores files that are not conversations', async () => {
        // A PDF trashed under the same parent must not archive anything —
        // and neither may the settings document or an iCloud conflict copy,
        // both of which end in .json without being a thread.
        libraryWith([
            { name: 'paper.pdf', deleted: true },
            { name: 'settings.json', deleted: true },
            { name: '11111111-1111-4111-8111-111111111111 2.json', deleted: true },
        ]);
        const db = fakeDb({ paper: null, settings: null });
        const out = await reconcileArchiveState(db as any, 'u', 1, 'now');
        expect(out).toEqual({ archived: 0, restored: 0 });
    });
});

/**
 * The title the model writes, and the cleanup it needs.
 *
 * The name was the first 35 characters of the opening message — a placeholder
 * wearing a title's clothes. "你好呀，帮我归纳一下我划线的句子吧" says nothing
 * about which paper, and a list of them is unreadable.
 */
describe('cleaning up a generated title', () => {
    it('drops the quotes and the prefix models add anyway', async () => {
        const { cleanTitle } = await import('../../../src/services/llm/threadTitle');
        expect(cleanTitle('"CO2 夜间通量"')).toBe('CO2 夜间通量');
        expect(cleanTitle('标题：EEG 测睡眠')).toBe('EEG 测睡眠');
        expect(cleanTitle('Title: Bee odometry')).toBe('Bee odometry');
        expect(cleanTitle('「蜜蜂舞蹈语言」')).toBe('蜜蜂舞蹈语言');
    });

    it('keeps one line, and drops trailing punctuation', async () => {
        const { cleanTitle } = await import('../../../src/services/llm/threadTitle');
        expect(cleanTitle('EEG 测睡眠\n\n（还有更多说明）')).toBe('EEG 测睡眠');
        expect(cleanTitle('EEG 测睡眠。')).toBe('EEG 测睡眠');
    });

    it('clips one that ran long', async () => {
        const { cleanTitle, MAX_TITLE_CHARS } = await import('../../../src/services/llm/threadTitle');
        expect(cleanTitle('题'.repeat(200)).length).toBe(MAX_TITLE_CHARS);
    });

    it('gives back nothing for nothing', async () => {
        const { cleanTitle } = await import('../../../src/services/llm/threadTitle');
        for (const input of ['', '   ', '""', '标题：']) expect(cleanTitle(input)).toBe('');
    });
});
