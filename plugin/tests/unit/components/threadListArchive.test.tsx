// @vitest-environment jsdom
/**
 * The chat history in archive mode, renaming the open chat from the list, and
 * the sync footer — mounted for real against a stub database.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

const row = (id: string, name: string, archivedAt: string | null) => ({
    id,
    name,
    createdAt: '2026-09-20T15:00:00.000Z',
    updatedAt: '2026-09-20T15:00:00.000Z',
    archivedAt,
});

const ACTIVE = [row('a1', 'Active chat about the paper', null)];
const ARCHIVED = [
    row('z1', 'Archived chat about the paper', '2026-09-21T00:00:00.000Z'),
    row('z2', 'Archived pollen chat', '2026-09-22T00:00:00.000Z'),
];

let db: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs = {};
    prefs[`${PREFIX}.llmProvider`] = 'deepseek';
    prefs[`${PREFIX}.llmModel`] = 'deepseek-flash';
    prefs[`${PREFIX}.llmKeyDeepseek`] = 'sk-test';
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => {
        prefs[key] = value;
    });

    db = {
        getThreadsPaginated: vi.fn(async (_u: string, limit: number, offset: number) => ({
            threads: ACTIVE.slice(offset, offset + limit),
        })),
        searchThreadsLocal: vi.fn(async (_u: string, query: string, _l: number, _o: number, scope?: any) =>
            (scope?.archived ? ARCHIVED : ACTIVE).filter((t) => t.name.includes(query))),
        getThreadsForItems: vi.fn(async (_lib: number, _keys: string[], _limit: number, scope?: any) =>
            (scope?.archived ? ARCHIVED.slice(0, 1) : ACTIVE)),
        getArchivedThreads: vi.fn(async (_u: string, limit: number, offset: number) =>
            ARCHIVED.slice(offset, offset + limit)),
        renameThread: vi.fn(async () => {}),
    };
    (Zotero as any).AlphainZ = { data: { env: 'test' }, db };
    (Zotero as any).Prompt = {
        confirm: vi.fn(() => 1),
        BUTTON_TITLE_YES: 'Yes', BUTTON_TITLE_NO: 'No', BUTTON_TITLE_CANCEL: 'Cancel',
    };
    vi.resetModules();
});

/** Mount the list with some atoms preset, and let its fetch settle. */
async function mount(preset: (store: any, atoms: any) => void = () => {}) {
    const { getDefaultStore } = await import('jotai');
    const threads = await import('../../../react/atoms/threads');
    const ui = await import('../../../react/atoms/ui');
    const profile = await import('../../../react/atoms/profile');
    const store = getDefaultStore();
    preset(store, { ...threads, ...ui, ...profile });

    const { default: ThreadListView } = await import('../../../react/components/ThreadListView');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(React.createElement(ThreadListView, { isWindow: false }));
    });
    await settle();
    return { host, store, atoms: { ...threads, ...ui, ...profile } };
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(async () => { await Promise.resolve(); });
    }
}

function button(host: HTMLElement, label: string): HTMLElement[] {
    return [...host.querySelectorAll(`[aria-label="${label}"]`)] as HTMLElement[];
}

async function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function press(element: HTMLElement, key: string) {
    await act(async () => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
    await settle();
}

describe('the archive', () => {
    it('with a paper filter lists that paper\'s archived chats, not its active ones', async () => {
        const { host } = await mount((store, atoms) => {
            store.set(atoms.localZoteroLibrariesAtom, [{ library_id: 1, is_group: false, name: 'My Library' }]);
            store.set(atoms.showArchiveAtom, true);
            store.set(atoms.threadListFilterAtom, {
                libraryId: 1, itemKey: 'PAPER', keys: ['PAPER', 'PDF'], itemType: 'journalArticle', label: 'The paper',
            });
        });
        expect(db.getThreadsForItems).toHaveBeenCalledWith(1, ['PAPER', 'PDF'], expect.any(Number), { archived: true });
        expect(host.textContent).toContain('Archived chat about the paper');
        expect(host.textContent).not.toContain('Active chat about the paper');
    });

    it('offers "Delete forever" only on rows that are archived', async () => {
        // A row says whether it is archived; the list it sits in does not decide.
        db.getArchivedThreads.mockImplementation(async () => [...ARCHIVED, row('a9', 'Somehow active', null)]);
        const { host } = await mount((store, atoms) => store.set(atoms.showArchiveAtom, true));
        const forever = button(host, 'Delete this chat forever, on every synced computer');
        expect(forever).toHaveLength(2);
        expect(button(host, 'Move this chat to the archive')).toHaveLength(1);
        expect(button(host, 'Restore this chat')).toHaveLength(2);
    });

    it('searches the archive when searching inside it', async () => {
        const { host } = await mount((store, atoms) => store.set(atoms.showArchiveAtom, true));
        const input = host.querySelector('input[aria-label="Search chats"]') as HTMLInputElement;
        await type(input, 'pollen');
        await press(input, 'Enter');
        expect(db.searchThreadsLocal).toHaveBeenLastCalledWith('local-user', 'pollen', expect.any(Number), 0, { archived: true });
        expect(host.textContent).toContain('Archived pollen chat');
        expect(host.textContent).not.toContain('Archived chat about the paper');
    });

    it('pages through the archive with "Show more", never into the active chats', async () => {
        const many = Array.from({ length: 17 }, (_, i) =>
            row(`z${i}`, `Archived ${i}`, `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`));
        db.getArchivedThreads.mockImplementation(async (_u: string, limit: number, offset: number) =>
            many.slice(offset, offset + limit));
        const { host } = await mount((store, atoms) => store.set(atoms.showArchiveAtom, true));
        const more = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Show more'));
        expect(more).toBeTruthy();
        await act(async () => { more!.click(); });
        await settle();
        expect(db.getArchivedThreads).toHaveBeenLastCalledWith('local-user', expect.any(Number), 15);
        expect(db.getThreadsPaginated).not.toHaveBeenCalled();
        expect(host.textContent).toContain('Archived 16');
    });
});

describe('renaming from the chat history', () => {
    async function renameFirstRow(host: HTMLElement, name: string) {
        await act(async () => { button(host, 'Rename thread')[0].click(); });
        const input = host.querySelector('input.thread-rename-input') as HTMLInputElement;
        await type(input, name);
        await press(input, 'Enter');
        return input;
    }

    it('renames the open chat in memory too, so the next answer keeps the new name', async () => {
        const { host, store, atoms } = await mount((s, a) => {
            s.set(a.currentThreadIdAtom, 'a1');
            s.set(a.currentThreadNameAtom, 'Active chat about the paper');
        });
        await renameFirstRow(host, 'Hive survey notes');
        expect(db.renameThread).toHaveBeenCalledWith('local-user', 'a1', 'Hive survey notes');
        expect(store.get(atoms.currentThreadNameAtom)).toBe('Hive survey notes');
    });

    it('keeps the typed name and says why when the rename fails', async () => {
        db.renameThread.mockRejectedValueOnce(new Error('database is locked'));
        const { host, store, atoms } = await mount();
        await renameFirstRow(host, 'Hive survey notes');
        const input = host.querySelector('input.thread-rename-input') as HTMLInputElement | null;
        expect(input?.value).toBe('Hive survey notes');
        const popups = store.get(atoms.popupMessagesAtom);
        expect(popups[0]?.title).toBe('Could not rename the chat');
        expect(popups[0]?.text).toContain('database is locked');
    });
});

describe('the sync footer', () => {
    it('says what the last pass could not do instead of only "last synced"', async () => {
        prefs[`${PREFIX}.conversationSyncBackend`] = 'folder';
        prefs[`${PREFIX}.conversationSyncFolderPath`] = '/Volumes/Unplugged/AlphainZ';
        // Nothing exists on this disk: the folder is gone.
        (IOUtils.exists as any).mockResolvedValue(false);
        const { host } = await mount();
        await settle();
        const footer = [...host.querySelectorAll('.thread-filter-footer-note')]
            .map((el) => el.textContent ?? '').join(' | ');
        expect(footer).toContain('Sync now');
        expect(footer).toContain('sync folder not found');
        expect(footer).not.toContain('last synced');
    });

    it('lists files still downloading and conflict copies from the last pass', async () => {
        prefs[`${PREFIX}.conversationSyncBackend`] = 'folder';
        prefs[`${PREFIX}.conversationSyncFolderPath`] = '/sync';
        const { recordPassHealth } = await import('../../../src/services/conversationSync/syncHealth');
        const { host } = await mount();
        await act(async () => {
            recordPassHealth({ waiting: 3, conflictCopies: 1, folderMissing: false });
        });
        const footer = [...host.querySelectorAll('.thread-filter-footer-note')]
            .map((el) => el.textContent ?? '').join(' | ');
        expect(footer).toContain('3 waiting to download');
        expect(footer).toContain('1 conflict copy ignored');
    });
});
