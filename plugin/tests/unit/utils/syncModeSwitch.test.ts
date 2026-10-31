/**
 * Switching sync backends: the confirm, the cleanup, and the one bug this
 * exists to prevent — a switch that writes the preference and strands the old
 * backend's remote copies (the wizard's first version did exactly that).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));

const deleteAllRemote = vi.fn(async () => ({ removed: 3 }));
const countRemoteCopies = vi.fn(async () => 7);
vi.mock('../../../src/services/conversationSync', async (importOriginal) => {
    const real = await importOriginal<any>();
    return {
        ...real,
        getConversationBackend: () => (real.conversationSyncMode() === 'off'
            ? null
            : { kind: real.conversationSyncMode(), deleteAllRemote, countRemoteCopies }),
    };
});

import { confirmAndSwitchSyncMode } from '../../../react/utils/syncModeSwitch';

/*
 * The answers the dialogs give, in order. An empty queue answers 1: that is
 * what Services.prompt.confirmEx returns when the user presses Esc or closes
 * the window.
 */
let answers: number[] = [];
const ESC = 1;
const KEEP = 0;
const DELETE_THEM = 2;
const CONFIRM_DELETE = 0;

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    deleteAllRemote.mockClear();
    countRemoteCopies.mockClear();
    answers = [];
    (globalThis as any).Zotero.Prompt = {
        confirm: vi.fn(() => (answers.length ? answers.shift()! : ESC)),
        BUTTON_TITLE_YES: 'yes', BUTTON_TITLE_CANCEL: 'cancel',
    };
    (globalThis as any).Zotero.getMainWindow = () => ({});
});

describe('confirmAndSwitchSyncMode', () => {
    it('"Keep the copies" (the default) switches without deleting anything', async () => {
        prefs.conversationSyncBackend = 'zotero';
        answers = [KEEP];
        const outcome = await confirmAndSwitchSyncMode('folder', { folderPath: '/sync' });
        expect(outcome).toBe('switched');
        expect(deleteAllRemote).not.toHaveBeenCalled();
        expect(prefs.conversationSyncBackend).toBe('folder');
        expect(prefs.conversationSyncFolderPath).toBe('/sync');
    });

    it('Esc or closing the dialog backs out: nothing deleted, nothing switched', async () => {
        // confirmEx answers 1 on Esc and on close: whatever sits at button1
        // is what backing out does, so it has to be Cancel.
        prefs.conversationSyncBackend = 'folder';
        prefs.conversationSyncFolderPath = '/old';
        answers = [ESC];
        const outcome = await confirmAndSwitchSyncMode('zotero');
        expect(outcome).toBe('cancelled');
        expect(deleteAllRemote).not.toHaveBeenCalled();
        expect(prefs.conversationSyncBackend).toBe('folder');
        const first = (Zotero.Prompt.confirm as any).mock.calls[0][0];
        expect(first.button1).toBe(Zotero.Prompt.BUTTON_TITLE_CANCEL);
        expect(first.button0).toBe('Keep the copies');
        expect(first.defaultButton).toBe(0);
    });

    it('deleting takes a second, explicit confirmation that says how many files go', async () => {
        prefs.conversationSyncBackend = 'folder';
        prefs.conversationSyncFolderPath = '/old';
        answers = [DELETE_THEM, CONFIRM_DELETE];
        const outcome = await confirmAndSwitchSyncMode('zotero');
        expect(outcome).toBe('switched');
        expect(deleteAllRemote).toHaveBeenCalledTimes(1);
        const second = (Zotero.Prompt.confirm as any).mock.calls[1][0];
        expect(second.text).toContain('7 conversation files');
        expect(second.text).toContain('permanently');
        // Esc on the second question lands on Cancel too.
        expect(second.button1).toBe(Zotero.Prompt.BUTTON_TITLE_CANCEL);
        expect(second.defaultButton).toBe(1);
    });

    it('backing out of the second confirmation cancels the whole switch', async () => {
        prefs.conversationSyncBackend = 'zotero';
        answers = [DELETE_THEM, ESC];
        const outcome = await confirmAndSwitchSyncMode('folder', { folderPath: '/sync' });
        expect(outcome).toBe('cancelled');
        expect(deleteAllRemote).not.toHaveBeenCalled();
        expect(prefs.conversationSyncBackend).toBe('zotero');
        expect(prefs.conversationSyncFolderPath).toBeUndefined();
    });

    it('asks keep/delete BEFORE the picker, and deletes only after a folder is chosen', async () => {
        // The questions are about the backend being left, so they come first —
        // but nothing is deleted until the destination is settled.
        prefs.conversationSyncBackend = 'zotero';
        answers = [DELETE_THEM, CONFIRM_DELETE];
        const order: string[] = [];
        ((globalThis as any).Zotero.Prompt.confirm as any).mockImplementation(() => {
            order.push('dialog');
            return answers.length ? answers.shift()! : ESC;
        });
        const outcome = await confirmAndSwitchSyncMode('folder', {
            pickFolder: async () => { order.push('picker'); return '/picked'; },
        });
        expect(outcome).toBe('switched');
        expect(order).toEqual(['dialog', 'dialog', 'picker']);
        expect(deleteAllRemote).toHaveBeenCalled();
        expect(prefs.conversationSyncFolderPath).toBe('/picked');
    });

    it('cancelling the picker aborts the switch with the old copies untouched', async () => {
        prefs.conversationSyncBackend = 'zotero';
        answers = [DELETE_THEM, CONFIRM_DELETE];   // and then back out at the picker
        const outcome = await confirmAndSwitchSyncMode('folder', {
            pickFolder: async () => null,
        });
        expect(outcome).toBe('cancelled');
        expect(deleteAllRemote).not.toHaveBeenCalled();
        expect(prefs.conversationSyncBackend).toBe('zotero');
    });

    it('"Delete them…" then Delete cleans the old backend, then switches', async () => {
        prefs.conversationSyncBackend = 'zotero';
        answers = [DELETE_THEM, CONFIRM_DELETE];
        const outcome = await confirmAndSwitchSyncMode('folder', { folderPath: '/sync' });
        expect(outcome).toBe('switched');
        expect(deleteAllRemote).toHaveBeenCalledTimes(1);
        expect(prefs.conversationSyncBackend).toBe('folder');
    });

    it('cancel aborts everything — no cleanup, no pref writes', async () => {
        prefs.conversationSyncBackend = 'zotero';
        answers = [ESC];   // the Cancel button is button1
        const outcome = await confirmAndSwitchSyncMode('folder', { folderPath: '/sync' });
        expect(outcome).toBe('cancelled');
        expect(deleteAllRemote).not.toHaveBeenCalled();
        expect(prefs.conversationSyncBackend).toBe('zotero');
        expect(prefs.conversationSyncFolderPath).toBeUndefined();
    });

    it('leaving "off" needs no confirm and cleans nothing', async () => {
        prefs.conversationSyncBackend = 'off';
        const outcome = await confirmAndSwitchSyncMode('zotero');
        expect(outcome).toBe('switched');
        expect((Zotero.Prompt.confirm as any)).not.toHaveBeenCalled();
        expect(deleteAllRemote).not.toHaveBeenCalled();
    });

    it('re-choosing the current mode is a no-op', async () => {
        prefs.conversationSyncBackend = 'zotero';
        prefs.settingsSyncStamp = '2026-09-20T00:00:00Z';
        expect(await confirmAndSwitchSyncMode('zotero')).toBe('unchanged');
        expect(deleteAllRemote).not.toHaveBeenCalled();
        expect(prefs.settingsSyncStamp).toBe('2026-09-20T00:00:00Z');
    });

    it('forgets what it knew about the place it left: the footer\'s findings and the settings stamp', async () => {
        // The stamp was earned with the old location; kept, it would refuse
        // the new location's settings for being older than it.
        const { recordPassHealth, getSyncHealth } = await import('../../../src/services/conversationSync/syncHealth');
        prefs.conversationSyncBackend = 'zotero';
        prefs.settingsSyncStamp = '2026-09-20T00:00:00Z';
        recordPassHealth({ waiting: 3 });
        answers = [KEEP];
        expect(await confirmAndSwitchSyncMode('folder', { folderPath: '/sync' })).toBe('switched');
        expect(prefs.settingsSyncStamp).toBe('');
        expect(getSyncHealth().waiting).toBe(0);

        // Another folder is another location too.
        prefs.settingsSyncStamp = '2026-09-21T00:00:00Z';
        expect(await confirmAndSwitchSyncMode('folder', { folderPath: '/elsewhere' })).toBe('switched');
        expect(prefs.settingsSyncStamp).toBe('');
    });

    it('a cleanup failure still completes the switch — leftovers are inert', async () => {
        prefs.conversationSyncBackend = 'zotero';
        answers = [DELETE_THEM, CONFIRM_DELETE];   // Delete, but it fails
        deleteAllRemote.mockRejectedValueOnce(new Error('library locked'));
        const outcome = await confirmAndSwitchSyncMode('off');
        expect(outcome).toBe('switched');
        expect(prefs.conversationSyncBackend).toBe('off');
    });
});

/*
 * Joining a sync location: the order is the whole point. A second computer
 * that writes before it reads replaces the first computer's settings with its
 * own install defaults, and writes its older conversation copies over newer
 * ones — so what is there is taken first, and only then is anything written.
 */
const calls: string[] = [];
const importSettingsNow = vi.fn(async () => { calls.push('import settings'); return false; });
const flushSettingsExportNow = vi.fn(async (..._args: any[]) => { calls.push('write settings'); return true; });
const syncConversationsNow = vi.fn(async () => { calls.push('import conversations'); });
const exportAllThreads = vi.fn(async (..._args: any[]) => {
    calls.push('write conversations');
    return { written: 4, failed: 0, skipped: 1, upToDate: 6 };
});
vi.mock('../../../react/utils/settingsSyncClient', () => ({
    importSettingsNow: () => importSettingsNow(),
}));
vi.mock('../../../src/services/conversationSync/settingsSync', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    flushSettingsExportNow: (...args: any[]) => flushSettingsExportNow(...args),
}));
vi.mock('../../../react/atoms/loadLocalThreads', () => ({
    syncConversationsNow: () => syncConversationsNow(),
}));
vi.mock('../../../src/services/conversationSync/exportAll', () => ({
    exportAllThreads: (...args: any[]) => exportAllThreads(...args),
}));

describe('joinSyncBackend', () => {
    beforeEach(() => {
        calls.length = 0;
        importSettingsNow.mockClear();
        flushSettingsExportNow.mockClear();
        syncConversationsNow.mockClear();
        exportAllThreads.mockClear();
        (globalThis as any).Zotero.AlphainZ = { db: { name: 'db' } };
    });

    it('takes the other computer\'s settings and never writes this one\'s over them', async () => {
        prefs.conversationSyncBackend = 'folder';
        prefs.conversationSyncFolderPath = '/shared';
        importSettingsNow.mockImplementationOnce(async () => {
            calls.push('import settings');
            prefs.settingsSyncStamp = '2026-09-20T00:00:00Z';   // took the other computer's document
            return true;
        });
        const { joinSyncBackend } = await import('../../../react/utils/syncModeSwitch');
        const outcome = await joinSyncBackend();
        expect(outcome.adoptedSettings).toBe(true);
        expect(flushSettingsExportNow).not.toHaveBeenCalled();
        expect(calls[0]).toBe('import settings');
    });

    it('does not write either when the document it took changed nothing here', async () => {
        prefs.conversationSyncBackend = 'zotero';
        importSettingsNow.mockImplementationOnce(async () => {
            calls.push('import settings');
            prefs.settingsSyncStamp = '2026-09-20T00:00:00Z';
            return false;
        });
        const { joinSyncBackend } = await import('../../../react/utils/syncModeSwitch');
        await joinSyncBackend();
        expect(flushSettingsExportNow).not.toHaveBeenCalled();
    });

    it('writes this computer\'s settings only when there was nothing to take', async () => {
        prefs.conversationSyncBackend = 'zotero';
        const { joinSyncBackend } = await import('../../../react/utils/syncModeSwitch');
        await joinSyncBackend();
        expect(calls.indexOf('import settings')).toBeLessThan(calls.indexOf('write settings'));
        // The flush itself applies the first-document rule when this
        // computer has not exchanged settings with the location.
        expect(flushSettingsExportNow).toHaveBeenCalledWith();
    });

    it('does not write the settings twice when the import already wrote the first document', async () => {
        prefs.conversationSyncBackend = 'zotero';
        importSettingsNow.mockImplementationOnce(async () => {
            calls.push('import settings');
            prefs.settingsSyncStamp = '2026-09-25T00:00:00Z';   // wrote the first one
            return false;
        });
        const { joinSyncBackend } = await import('../../../react/utils/syncModeSwitch');
        await joinSyncBackend();
        expect(flushSettingsExportNow).not.toHaveBeenCalled();
    });

    it('imports and reconciles conversations before backing up this computer\'s', async () => {
        prefs.conversationSyncBackend = 'zotero';
        const { joinSyncBackend } = await import('../../../react/utils/syncModeSwitch');
        const outcome = await joinSyncBackend();
        expect(calls.indexOf('import conversations')).toBeGreaterThan(-1);
        expect(calls.lastIndexOf('import conversations')).toBeLessThan(calls.indexOf('write conversations'));
        // And the backfill leaves newer (or unreadable) remote copies alone.
        expect(exportAllThreads.mock.calls[0][3]).toEqual({ skipNewerRemote: true });
        expect(outcome.exported).toEqual({ written: 4, failed: 0, skipped: 1, upToDate: 6 });
    });

    it('does nothing with sync off', async () => {
        prefs.conversationSyncBackend = 'off';
        const { joinSyncBackend } = await import('../../../react/utils/syncModeSwitch');
        const outcome = await joinSyncBackend();
        expect(outcome).toEqual({ adoptedSettings: false, exported: null });
        expect(calls).toEqual([]);
    });
});
