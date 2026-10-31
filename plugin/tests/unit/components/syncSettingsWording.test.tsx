// @vitest-environment jsdom
/**
 * What the delete and sync controls say, against what they do: the header's
 * "Delete chat" archives (so it must not say "cannot be undone"), switching
 * sync asks whether to keep the old copies (so the settings must not say it
 * removes them), and turning sync on in Settings backs the history up and
 * says so.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

const joinSyncBackend = vi.fn(async () => ({
    adoptedSettings: true,
    exported: { written: 12, failed: 0, skipped: 2, upToDate: 0 },
}));
vi.mock('../../../react/utils/syncModeSwitch', async (importOriginal) => {
    const real = await importOriginal<any>();
    return { ...real, joinSyncBackend: () => joinSyncBackend() };
});
let pickedFolder: string | null = null;
vi.mock('../../../react/utils/folderPicker', () => ({
    pickFolder: async () => (pickedFolder ? { ok: true, path: pickedFolder } : { ok: false, reason: 'cancelled' }),
}));

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    (Zotero as any).Prompt = {
        confirm: vi.fn(() => 1),
        BUTTON_TITLE_YES: 'Yes', BUTTON_TITLE_NO: 'No', BUTTON_TITLE_CANCEL: 'Cancel',
    };
    joinSyncBackend.mockClear();
    pickedFolder = null;
    vi.resetModules();
});

async function render(element: React.ReactElement): Promise<HTMLDivElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(element); });
    await act(async () => { await Promise.resolve(); });
    return host;
}

describe('the header menu\'s "Delete chat"', () => {
    it('says the chat moves to the archive, because that is what it does', async () => {
        prefs[`${PREFIX}.llmProvider`] = 'deepseek';
        // The menu reads the open chat from the shared store, not from a hook.
        const { store } = await import('../../../react/store');
        const { currentThreadIdAtom } = await import('../../../react/atoms/threads');
        store.set(currentThreadIdAtom, 'th-1');
        // Nothing selected in the library, no reader open.
        (Zotero as any).getActiveZoteroPane = () => ({
            getSelectedItems: () => [],
            getSelectedLibraryID: () => 1,
            getSelectedCollection: () => null,
        });
        (Zotero as any).getMainWindow = () => ({ Zotero_Tabs: { selectedType: 'library' } });
        const { default: ThreadMenuButton } = await import('../../../react/components/ui/buttons/ThreadMenuButton');
        const host = await render(React.createElement(ThreadMenuButton));

        await act(async () => { (host.querySelector('[aria-label="Chat actions"]') as HTMLElement).click(); });
        const item = [...document.querySelectorAll('[role="menuitem"]')]
            .find((el) => el.textContent?.includes('Delete chat')) as HTMLElement;
        expect(item).toBeTruthy();
        await act(async () => { item.click(); });

        const prompt = (Zotero.Prompt.confirm as any).mock.calls[0][0];
        expect(prompt.text).toContain('archive');
        expect(prompt.text).not.toMatch(/cannot be undone/i);
    });
});

describe('Settings → Advanced → Conversation Sync', () => {
    it('says switching asks about the old copies, not that it removes them', async () => {
        const { default: AdvancedSection } = await import('../../../react/components/preferences/AdvancedSection');
        const host = await render(React.createElement(AdvancedSection));
        const text = host.textContent ?? '';
        expect(text).not.toContain('switching removes the copies');
        expect(text).toContain('asked whether to keep the copies');
    });

    it('turning sync on joins the location and says what it did', async () => {
        prefs[`${PREFIX}.conversationSyncBackend`] = 'off';
        const { default: AdvancedSection } = await import('../../../react/components/preferences/AdvancedSection');
        const host = await render(React.createElement(AdvancedSection));
        const radio = host.querySelector('input[aria-label="Sync through Zotero"]') as HTMLInputElement;
        await act(async () => { radio.click(); });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(joinSyncBackend).toHaveBeenCalledTimes(1);
        const text = host.textContent ?? '';
        expect(text).toContain('Settings taken from your other computer');
        expect(text).toContain('Exported 12 conversations');
        expect(text).toContain('2 left alone');
    });

    it('choosing another folder joins it as a new location, forgetting the old one\'s settings stamp', async () => {
        // Kept, the stamp would make the new folder's settings look older
        // than something this computer never took from it.
        prefs[`${PREFIX}.conversationSyncBackend`] = 'folder';
        prefs[`${PREFIX}.conversationSyncFolderPath`] = '/old';
        prefs[`${PREFIX}.settingsSyncStamp`] = '2026-09-21T00:00:00Z';
        pickedFolder = '/iCloud/AlphainZ';
        const { default: AdvancedSection } = await import('../../../react/components/preferences/AdvancedSection');
        const host = await render(React.createElement(AdvancedSection));
        const choose = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose…') as HTMLButtonElement;
        await act(async () => { choose.click(); });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(prefs[`${PREFIX}.conversationSyncFolderPath`]).toBe('/iCloud/AlphainZ');
        expect(prefs[`${PREFIX}.settingsSyncStamp`]).toBe('');
        expect(joinSyncBackend).toHaveBeenCalledTimes(1);
    });
});

describe('describeJoinOutcome', () => {
    it('reports failures and a plain first join', async () => {
        const { describeJoinOutcome } = await import('../../../react/components/preferences/AdvancedSection');
        expect(describeJoinOutcome({ adoptedSettings: false, exported: { written: 1, failed: 2, skipped: 0, upToDate: 0 } }))
            .toBe('Exported 1 conversation; 2 failed — see the debug log.');
        expect(describeJoinOutcome({ adoptedSettings: false, exported: null })).toBe('Sync is on.');
    });

    it('does not call copies that are already there exported', async () => {
        // A new computer that just imported everything has nothing of its own to add.
        const { describeJoinOutcome } = await import('../../../react/components/preferences/AdvancedSection');
        expect(describeJoinOutcome({ adoptedSettings: true, exported: { written: 0, failed: 0, skipped: 0, upToDate: 12 } }))
            .toBe('Settings taken from your other computer. Nothing new to export; 12 already there.');
        expect(describeJoinOutcome({ adoptedSettings: false, exported: { written: 3, failed: 0, skipped: 1, upToDate: 12 } }))
            .toBe('Exported 3 conversations; 12 already there; 1 left alone (newer on another computer, or still downloading).');
    });
});
