/**
 * OS notifications for the things that stop and wait for you.
 *
 * Never exercised in this fork, which matters twice over: the gate decides
 * whether a notification fires at all — and firing one while the panel is
 * already on screen is pure noise — and the text is one of the few places the
 * plugin speaks its own name outside its own window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const shown: Array<{ title: string; body: string; name: string }> = [];

beforeEach(() => {
    for (const key of Object.keys(prefs)) delete prefs[key];
    shown.length = 0;
    vi.resetModules();

    (globalThis as any).Components = {
        classes: {
            '@mozilla.org/alerts-service;1': {
                getService: () => ({
                    showAlertNotification: (
                        _icon: string, title: string, body: string,
                        _clickable: boolean, _cookie: string, _listener: unknown, name: string,
                    ) => { shown.push({ title, body, name }); },
                    closeAlert: () => {},
                }),
            },
        },
        interfaces: { nsIAlertsService: {} },
    };
    // Zotero in the background: the case a notification exists for.
    (Zotero as any).getMainWindow = () => ({ document: { hasFocus: () => false } });
    (Zotero as any).getMainWindows = () => [];
});

async function load() {
    return await import('../../../src/services/systemNotifications');
}

describe('the gate', () => {
    it('stays quiet when the preference is off', async () => {
        const { notifyRunComplete } = await load();
        notifyRunComplete();
        expect(shown).toHaveLength(0);
    });

    it('notifies when the preference is on and Zotero is not showing the panel', async () => {
        // Run-complete has its own switch, separate from the approval one.
        prefs['enableResponseCompleteNotifications'] = true;
        const { notifyRunComplete } = await load();
        notifyRunComplete();
        expect(shown).toHaveLength(1);
    });
});

describe('what it says', () => {
    it('speaks the plugin\'s own name, not the one it was forked from', async () => {
        // This text appears in the OS notification centre, outside anywhere the
        // rest of the renaming reaches.
        prefs['enableResponseCompleteNotifications'] = true;
        const { notifyRunComplete } = await load();
        notifyRunComplete();
        expect(shown[0].title).toContain('AlphainZ');
        expect(`${shown[0].title} ${shown[0].body}`).not.toContain('Beaver');
    });

    it('replaces rather than stacks, by using one name', async () => {
        prefs['enableResponseCompleteNotifications'] = true;
        const { notifyRunComplete } = await load();
        notifyRunComplete();
        notifyRunComplete();
        expect(shown).toHaveLength(2);
        expect(shown[0].name).toBe(shown[1].name);
    });
});

/**
 * The reason the user never saw one.
 *
 * The notification hung off the `run_complete` event, which only a run
 * orchestrated by a server emits. A run orchestrated locally — every run in
 * this fork — ends at `done` instead, so the code path was live, the
 * preference was on, and nothing ever fired.
 */
describe('a run that only reaches done', () => {
    it('notifies once per run, whichever signal arrives', async () => {
        prefs['enableResponseCompleteNotifications'] = true;
        const { notifyRunComplete } = await load();

        // The server path: run_complete, then done, for the same run.
        notifyRunComplete('run-1');
        notifyRunComplete('run-1');
        expect(shown).toHaveLength(1);

        // The next run is a different run.
        notifyRunComplete('run-2');
        expect(shown).toHaveLength(2);
    });

    it('still notifies a caller that has no run id', async () => {
        prefs['enableResponseCompleteNotifications'] = true;
        const { notifyRunComplete } = await load();
        notifyRunComplete();
        notifyRunComplete();
        expect(shown).toHaveLength(2);
    });
});
