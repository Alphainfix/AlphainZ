/**
 * The wizard gate: shows for a fresh install and after a version bump, never
 * twice for the same version, and completing it also silences the floating
 * welcome popup so nobody is greeted twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));

/* The sync steps the completion runs, recorded in the order they happen. */
const calls: string[] = [];
/** What the next settings import takes from the other computer; null = nothing there. */
let settingsTaken: { firstContact: boolean; changed: string[]; kept: string[] } | null = null;
const popups: any[] = [];
/** The listeners the module registered, told what an import took as the real one tells them. */
let takenListeners: Array<(taken: any) => void> = [];
function deliverTaken(taken: { firstContact: boolean; changed: string[]; kept: string[] }): void {
    for (const listener of takenListeners) listener(taken);
}
vi.mock('../../../react/utils/settingsSyncClient', () => ({
    importSettingsNow: async () => {
        calls.push('import settings');
        if (!settingsTaken) return false;
        prefs.settingsSyncStamp = '2026-09-20T00:00:00Z';
        deliverTaken(settingsTaken);
        return settingsTaken.changed.length > 0;
    },
}));
vi.mock('../../../src/services/conversationSync/settingsSync', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    flushSettingsExportNow: async () => { calls.push('write settings'); return true; },
    onSettingsTaken: (listener: (taken: any) => void) => {
        takenListeners.push(listener);
        return () => { takenListeners = takenListeners.filter((l) => l !== listener); };
    },
}));
/** Whether the model the preferences name can run here: its key is on this computer. */
let modelRunsHere = true;
vi.mock('../../../src/services/llm/agentConfig', () => ({
    isAgentConfigured: () => modelRunsHere,
}));
vi.mock('@beaver/agent-llm/openAICompatible', () => ({
    PROVIDER_PRESETS: { zhipu: { label: 'Zhipu' }, deepseek: { label: 'DeepSeek' } },
}));
vi.mock('../../../react/atoms/loadLocalThreads', () => ({
    syncConversationsNow: async () => { calls.push('import conversations'); },
}));
vi.mock('../../../src/services/conversationSync/exportAll', () => ({
    exportAllThreads: async () => {
        calls.push('write conversations');
        return { written: 2, failed: 0, skipped: 0 };
    },
}));
vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    return { addPopupMessageAtom: atom(null, (_get, _set, message: any) => { popups.push(message); }) };
});

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    calls.length = 0;
    popups.length = 0;
    settingsTaken = null;
    takenListeners = [];
    modelRunsHere = true;
    (globalThis as any).Zotero.AlphainZ = { db: {} };
    vi.resetModules();
});

async function load() {
    const atoms = await import('../../../react/atoms/welcomeWizard');
    const { createStore } = await import('jotai');
    return { ...atoms, store: createStore() };
}

describe('welcomeWizardVisibleAtom', () => {
    it('shows on a fresh install', async () => {
        const { welcomeWizardVisibleAtom, store } = await load();
        expect(store.get(welcomeWizardVisibleAtom)).toBe(true);
    });

    it('shows again after a wizard-version bump, not after a mere app upgrade', async () => {
        prefs.welcomeWizardShownForVersion = '0';   // an older wizard was seen
        const bumped = await load();
        expect(bumped.store.get(bumped.welcomeWizardVisibleAtom)).toBe(true);

        vi.resetModules();
        const { WIZARD_VERSION } = await import('../../../src/utils/welcomeWizard');
        prefs.welcomeWizardShownForVersion = WIZARD_VERSION;
        const current = await load();
        expect(current.store.get(current.welcomeWizardVisibleAtom)).toBe(false);
    });

    it('is forced back by the dev override', async () => {
        const { WIZARD_VERSION } = await import('../../../src/utils/welcomeWizard');
        prefs.welcomeWizardShownForVersion = WIZARD_VERSION;
        const { welcomeWizardVisibleAtom, welcomeWizardForcedAtom, store } = await load();
        expect(store.get(welcomeWizardVisibleAtom)).toBe(false);
        store.set(welcomeWizardForcedAtom, true);
        expect(store.get(welcomeWizardVisibleAtom)).toBe(true);
    });
});

describe('completeWelcomeWizardAtom', () => {
    it('stamps the wizard version and silences the floating welcome', async () => {
        prefs.conversationSyncBackend = 'off';  // keep the async tail inert
        const { completeWelcomeWizardAtom, welcomeWizardVisibleAtom, store } = await load();
        const { WIZARD_VERSION } = await import('../../../src/utils/welcomeWizard');

        store.set(completeWelcomeWizardAtom);

        expect(prefs.welcomeWizardShownForVersion).toBe(WIZARD_VERSION);
        expect(prefs.onboardingWelcomeShown).toBe(true);
        expect(typeof prefs.onboardingWelcomeShownAt).toBe('string');
        expect(store.get(welcomeWizardVisibleAtom)).toBe(false);
    });

    it('does not rewrite an already-recorded floating welcome', async () => {
        prefs.conversationSyncBackend = 'off';
        prefs.onboardingWelcomeShown = true;
        prefs.onboardingWelcomeShownAt = 'long-ago';
        const { completeWelcomeWizardAtom, store } = await load();
        store.set(completeWelcomeWizardAtom);
        expect(prefs.onboardingWelcomeShownAt).toBe('long-ago');
    });
});

/*
 * Finishing the wizard on a second computer, pointed at the sync location
 * the first one already uses. What is there is the first computer's work;
 * this one's preferences are install defaults. So the completion takes
 * before it writes — the first computer's settings arrive here instead of
 * this one's defaults replacing them there.
 */
describe('completing the wizard with sync on', () => {
    it('takes the settings already there and writes none of this computer\'s over them', async () => {
        prefs.conversationSyncBackend = 'folder';
        prefs.conversationSyncFolderPath = '/iCloud/AlphainZ';
        settingsTaken = { firstContact: true, changed: ['customInstructions', 'actions'], kept: [] };
        const { completeWelcomeWizardAtom, store } = await load();
        await store.set(completeWelcomeWizardAtom);
        expect(calls[0]).toBe('import settings');
        expect(calls).not.toContain('write settings');
        // And the user is told where their settings came from.
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        expect(popups[0].title).toContain('other computer');
    });

    it('says which settings it took, the theme and the search index included', async () => {
        prefs.conversationSyncBackend = 'zotero';
        settingsTaken = {
            firstContact: true,
            changed: ['customInstructions', 'embeddingProvider', 'uiTheme'],
            kept: ['allowAgentWrites'],
        };
        const { completeWelcomeWizardAtom, store } = await load();
        await store.set(completeWelcomeWizardAtom);
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        expect(popups[0].text).toContain('custom instructions, the search index and the theme');
        // What it kept of its own goes to the other computer, and it says so.
        expect(popups[0].text).toContain('Kept from this computer, and sent to the other one: permissions');
        expect(popups[0].text).toContain('API keys stay on each computer');
    });

    it('says so up front when the model it took needs a key this computer does not have', async () => {
        // Keys never sync: the wizard's own key was for another vendor.
        prefs.conversationSyncBackend = 'zotero';
        prefs.llmProvider = 'zhipu';
        modelRunsHere = false;
        settingsTaken = { firstContact: true, changed: ['llmProvider', 'llmModel'], kept: [] };
        const { completeWelcomeWizardAtom, store } = await load();
        await store.set(completeWelcomeWizardAtom);
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        expect(popups[0].text).toContain('the model');
        expect(popups[0].text).toContain('needs a Zhipu key');
        expect(popups[0].text).toContain('Settings → Model');
    });

    it('announces settings that arrive later, at a pass after the join, too', async () => {
        // The location's document could not be read when the wizard finished;
        // a catch-up pass takes it once it has downloaded.
        prefs.conversationSyncBackend = 'zotero';
        const { completeWelcomeWizardAtom, store } = await load();
        await store.set(completeWelcomeWizardAtom);
        expect(popups).toEqual([]);
        deliverTaken({ firstContact: true, changed: ['actions'], kept: [] });
        await vi.waitFor(() => expect(popups).toHaveLength(1));
        expect(popups[0].text).toContain('Actions');
    });

    it('stays quiet about an ordinary change from the other computer', async () => {
        await load();
        deliverTaken({ firstContact: false, changed: ['uiTheme'], kept: [] });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(popups).toEqual([]);
    });

    it('writes this computer\'s settings only after finding nothing to take', async () => {
        prefs.conversationSyncBackend = 'zotero';
        const { completeWelcomeWizardAtom, store } = await load();
        await store.set(completeWelcomeWizardAtom);
        expect(calls.slice(0, 2)).toEqual(['import settings', 'write settings']);
        expect(popups).toEqual([]);
    });

    it('imports and reconciles conversations before backing up this computer\'s', async () => {
        prefs.conversationSyncBackend = 'zotero';
        const { completeWelcomeWizardAtom, store } = await load();
        await store.set(completeWelcomeWizardAtom);
        const lastImport = calls.lastIndexOf('import conversations');
        expect(lastImport).toBeGreaterThan(-1);
        expect(lastImport).toBeLessThan(calls.indexOf('write conversations'));
    });

    it('does no sync work with sync off', async () => {
        prefs.conversationSyncBackend = 'off';
        const { completeWelcomeWizardAtom, store } = await load();
        await store.set(completeWelcomeWizardAtom);
        expect(calls).toEqual([]);
    });
});
