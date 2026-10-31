/**
 * The settings document: what it carries, what it refuses, and the LWW rule.
 * The whitelist is a security boundary — these tests are what keeps a key or a
 * machine path from ever ending up in a synced folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));

/** The backend the flush sees; null = sync off. */
let backend: any = null;
vi.mock('../../../src/services/conversationSync', async (importOriginal) => {
    const real = await importOriginal<any>();
    return { ...real, getConversationBackend: () => backend };
});

import {
    PORTABLE_SETTINGS_PREFS,
    applySettingsExport,
    buildSettingsExport,
    describeSettingsTaken,
    flushSettingsExportNow,
    forgetSettingsExchange,
    importSettingsNow,
    onSettingsTaken,
    parseSettingsExport,
} from '../../../src/services/conversationSync/settingsSync';
import { WIZARD_VERSION } from '../../../src/utils/welcomeWizard';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    (globalThis as any).Zotero.Users = { getLocalUserKey: () => 'machine-A' };
});

afterEach(() => {
    delete (globalThis as any).Services;
    vi.useRealTimers();
});

/*
 * The install defaults of the preferences these tests use, as Zotero's
 * default branch holds them (addon/prefs.js).
 */
const CUSTOM_ACTIONS = '{"version":1,"overrides":{},"custom":[{"id":"x","title":"Referee report"}]}';
const INSTALL_DEFAULTS: Record<string, string | number | boolean> = {
    customInstructions: '',
    actions: '{"version":1,"overrides":{},"custom":[]}',
    allowAgentWrites: false,
    llmProvider: '',
    llmModel: '',
    embeddingProvider: '',
    uiTheme: 'fresh',
    maxModelRequests: 24,
};

/** Give the module a default branch to read, the way Zotero's `Services.prefs` has one. */
function installDefaultBranch(): void {
    const valueOf = (name: string) => INSTALL_DEFAULTS[name.slice(`${pkg.config.prefsPrefix}.`.length)];
    (globalThis as any).Services = {
        prefs: {
            getDefaultBranch: () => ({
                PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128,
                getPrefType: (name: string) => {
                    const value = valueOf(name);
                    if (typeof value === 'string') return 32;
                    if (typeof value === 'number') return 64;
                    if (typeof value === 'boolean') return 128;
                    return 0;
                },
                getStringPref: valueOf,
                getIntPref: valueOf,
                getBoolPref: valueOf,
            }),
        },
    };
}

/** One sync location both computers see, holding one settings document. */
function sharedLocation() {
    let doc: string | null = null;
    return {
        readSettingsDocument: vi.fn(async () => doc),
        settingsDocumentPresence: vi.fn(async () => (doc ? 'present' as const : 'absent' as const)),
        writeSettingsDocument: vi.fn(async (json: string) => { doc = json; return true; }),
        get doc() { return doc; },
    };
}

/** A computer: its machine id and its preferences, starting from install defaults. */
function computer(id: string, own: Record<string, unknown> = {}) {
    return {
        id,
        prefs: { welcomeWizardShownForVersion: WIZARD_VERSION, ...INSTALL_DEFAULTS, ...own } as Record<string, unknown>,
    };
}

/** Sit at this computer: its preferences become the ones the module reads and writes. */
function sitAt(machine: ReturnType<typeof computer>): void {
    for (const k of Object.keys(prefs)) delete prefs[k];
    Object.assign(prefs, machine.prefs);
    (globalThis as any).Zotero.Users = { getLocalUserKey: () => machine.id };
}

/** Leave this computer, keeping what happened to its preferences. */
function leave(machine: ReturnType<typeof computer>): void {
    machine.prefs = { ...prefs };
}

describe('the whitelist', () => {
    it('carries no secret, no machine path, and none of the sync config itself', () => {
        const banned = [
            /^llmKey/, /ApiKey$/, /^conversationSync/, /^welcomeWizard/,
            /^settingsSyncStamp$/, /^llmBaseUrl$/, /^customChatModels$/,
            /^lastUsedModel$/, /^excludedLibraries$/, /^onboarding/,
        ];
        for (const key of PORTABLE_SETTINGS_PREFS) {
            for (const pattern of banned) {
                expect(key).not.toMatch(pattern);
            }
        }
    });

    it('exports exactly the whitelist and nothing else', () => {
        prefs.uiTheme = 'warm';
        prefs.llmKeyDeepseek = 'sk-SECRET';           // must not travel
        prefs.conversationSyncFolderPath = '/Users/x'; // must not travel
        const doc = buildSettingsExport('2026-08-26T00:00:00Z');
        expect(doc.values.uiTheme).toBe('warm');
        expect(JSON.stringify(doc)).not.toContain('SECRET');
        expect(JSON.stringify(doc)).not.toContain('/Users/x');
    });
});

describe('parseSettingsExport', () => {
    it('rejects the wrong format, a newer version, and non-object values', () => {
        expect(parseSettingsExport('not json')).toBeNull();
        expect(parseSettingsExport(JSON.stringify({ format: 'x', version: 1, exportedAt: 't', values: {} }))).toBeNull();
        expect(parseSettingsExport(JSON.stringify({ format: 'alphainz.settings', version: 2, exportedAt: 't', values: {} }))).toBeNull();
        expect(parseSettingsExport(JSON.stringify({ format: 'alphainz.settings', version: 1, exportedAt: 't', values: [] }))).toBeNull();
    });

    it('takes the defaults list and the first-document mark only in their own shape', () => {
        const base = { format: 'alphainz.settings', version: 1, exportedBy: 'B', exportedAt: 't', values: {} };
        const good = parseSettingsExport(JSON.stringify({ ...base, defaults: ['uiTheme', 7], firstDocument: true }))!;
        expect(good.defaults).toEqual(['uiTheme']);
        expect(good.firstDocument).toBe(true);
        const odd = parseSettingsExport(JSON.stringify({ ...base, defaults: 'uiTheme', firstDocument: 'yes' }))!;
        expect(odd).not.toHaveProperty('defaults');
        expect(odd).not.toHaveProperty('firstDocument');
    });
});

describe('applySettingsExport', () => {
    const doc = (over: Record<string, unknown> = {}) => ({
        format: 'alphainz.settings', version: 1,
        exportedBy: 'machine-B', exportedAt: '2026-08-26T12:00:00Z',
        values: { uiTheme: 'quiet' }, ...over,
    });

    it('applies a newer document, stamps the clock, and says what changed', () => {
        prefs.uiTheme = 'fresh';
        prefs.settingsSyncStamp = '2026-08-26T00:00:00Z';
        expect(applySettingsExport(doc() as any))
            .toEqual({ firstContact: false, changed: ['uiTheme'], kept: [] });
        expect(prefs.uiTheme).toBe('quiet');
        expect(prefs.settingsSyncStamp).toBe('2026-08-26T12:00:00Z');
    });

    it('skips its own machine and anything not newer', () => {
        prefs.settingsSyncStamp = '2026-08-26T12:00:00Z';
        expect(applySettingsExport(doc() as any)).toBeNull();                     // tie
        expect(applySettingsExport(doc({ exportedBy: 'machine-A' }) as any)).toBeNull(); // own echo
    });

    it('ignores keys outside the whitelist — a tampered file writes nothing extra', () => {
        prefs.settingsSyncStamp = '';
        applySettingsExport(doc({
            values: { uiTheme: 'warm', llmKeyDeepseek: 'injected', dataProviderEnabled: true },
        }) as any);
        expect(prefs.uiTheme).toBe('warm');
        expect(prefs.llmKeyDeepseek).toBeUndefined();
        expect(prefs.dataProviderEnabled).toBeUndefined();
    });

    it('refuses a value whose type differs from what this build stores', () => {
        prefs.contextCompactionThreshold = 80000;
        prefs.settingsSyncStamp = '';
        applySettingsExport(doc({ values: { contextCompactionThreshold: 'huge' } }) as any);
        expect(prefs.contextCompactionThreshold).toBe(80000);
    });

    it('reads the retired "zotero" theme as Fresh: written as Fresh, and no change when this computer is on it', () => {
        // Beaver's unthemed look was offered until 0.1.78; a computer that has
        // not updated still stores and writes it.
        prefs.uiTheme = 'warm';
        prefs.settingsSyncStamp = '2026-08-26T00:00:00Z';
        const old = JSON.stringify(doc({ values: { uiTheme: 'zotero' } }));
        expect(applySettingsExport(parseSettingsExport(old)!)).toEqual({ firstContact: false, changed: ['uiTheme'], kept: [] });
        expect(prefs.uiTheme).toBe('fresh');

        prefs.uiTheme = 'zotero';
        prefs.settingsSyncStamp = '2026-08-26T00:00:00Z';
        const fresh = JSON.stringify(doc({ values: { uiTheme: 'fresh' } }));
        expect(applySettingsExport(parseSettingsExport(fresh)!)!.changed).toEqual([]);
    });

    it('writes the retired "zotero" theme as Fresh, an install default', () => {
        installDefaultBranch();
        prefs.uiTheme = 'zotero';
        const written = buildSettingsExport('2026-08-26T12:00:00Z');
        expect(written.values.uiTheme).toBe('fresh');
        expect(written.defaults).toContain('uiTheme');
    });

    it('keeps typography on this computer: the theme travels, the font and its size do not', () => {
        // A 13px serif that suits a 27-inch monitor is small on a laptop, and
        // the font stacks resolve to different faces per OS — so a document
        // from another machine (or an older build that still exported them)
        // must leave these alone, while the palette still follows.
        for (const key of ['uiFont', 'uiFontSize', 'uiLineHeight']) {
            expect(PORTABLE_SETTINGS_PREFS).not.toContain(key);
        }
        expect(PORTABLE_SETTINGS_PREFS).toContain('uiTheme');
        expect(PORTABLE_SETTINGS_PREFS).toContain('uiColorScheme');
        // The limits per question are a policy, the same on every machine.
        for (const key of ['maxOutputTokens', 'maxModelRequests', 'maxLibrarySearches', 'maxLiteratureLookups']) {
            expect(PORTABLE_SETTINGS_PREFS).toContain(key);
        }
        prefs.uiTheme = 'fresh'; prefs.uiFont = 'sans'; prefs.uiFontSize = 15; prefs.uiLineHeight = 'compact';
        expect(buildSettingsExport('2026-09-10T00:00:00Z').values).not.toHaveProperty('uiFont');
        expect(buildSettingsExport('2026-09-10T00:00:00Z').values).not.toHaveProperty('uiFontSize');
        applySettingsExport(doc({ values: { uiTheme: 'sky', uiFont: 'serif', uiFontSize: 11, uiLineHeight: 'relaxed' } }) as any);
        expect(prefs.uiTheme).toBe('sky');
        expect(prefs.uiFont).toBe('sans');
        expect(prefs.uiFontSize).toBe(15);
        expect(prefs.uiLineHeight).toBe('compact');
    });

    it('carries the question rail choice between computers', () => {
        // Ticks or a scroll bar is a way of reading a chat, not a fact about one screen.
        expect(PORTABLE_SETTINGS_PREFS.filter((key) => key === 'conversationRail')).toHaveLength(1);
        prefs.conversationRail = false;
        expect(buildSettingsExport('2026-10-09T00:00:00Z').values.conversationRail).toBe(false);
        prefs.settingsSyncStamp = '2026-08-26T00:00:00Z';
        applySettingsExport(doc({ values: { conversationRail: true } }) as any);
        expect(prefs.conversationRail).toBe(true);
    });
});

/*
 * A second computer joining. Its preferences are install defaults plus what
 * the wizard set; the document is whole-document last-write-wins. Written
 * over the first computer's document, it would replace that computer's
 * custom instructions, Actions and permissions at its next pass — so a
 * machine that has never exchanged settings writes only where nothing is.
 */
describe('flushSettingsExportNow on a machine that has never synced settings', () => {
    function fakeBackend(stored: string | null, presence: 'present' | 'absent' | 'unknown') {
        const writes: string[] = [];
        return {
            writes,
            readSettingsDocument: vi.fn(async () => stored),
            settingsDocumentPresence: vi.fn(async () => presence),
            writeSettingsDocument: vi.fn(async (json: string) => { writes.push(json); return true; }),
        };
    }
    const otherComputersDocument = JSON.stringify({
        format: 'alphainz.settings', version: 1,
        exportedBy: 'machine-B', exportedAt: '2026-09-20T12:00:00Z',
        values: { customInstructions: 'Answer like a referee', actions: '{"custom":[1]}' },
    });

    beforeEach(() => {
        prefs.customInstructions = '';   // this machine: install defaults
        prefs.actions = '{"version":1,"overrides":{},"custom":[]}';
    });

    it('does not write over another computer\'s document', async () => {
        backend = fakeBackend(otherComputersDocument, 'present');
        expect(await flushSettingsExportNow()).toBe(false);
        expect(backend.writes).toEqual([]);
        expect(prefs.settingsSyncStamp).toBeUndefined();
    });

    it('does not write over a document it cannot read yet, or may not see yet', async () => {
        backend = fakeBackend(null, 'present');       // still downloading
        expect(await flushSettingsExportNow()).toBe(false);
        backend = fakeBackend(null, 'unknown');       // folder missing / Zotero mid-sync
        expect(await flushSettingsExportNow()).toBe(false);
        expect(backend.writes).toEqual([]);
    });

    it('writes the first document where there is none', async () => {
        backend = fakeBackend(null, 'absent');
        expect(await flushSettingsExportNow()).toBe(true);
        expect(backend.writes).toHaveLength(1);
        expect(typeof prefs.settingsSyncStamp).toBe('string');
    });

    it('rewrites a document this machine wrote itself', async () => {
        backend = fakeBackend(JSON.stringify({
            format: 'alphainz.settings', version: 1,
            exportedBy: 'machine-A', exportedAt: '2026-09-20T12:00:00Z', values: {},
        }), 'present');
        expect(await flushSettingsExportNow()).toBe(true);
        expect(backend.writes).toHaveLength(1);
    });

    it('once it has exchanged settings, a change here is written as before', async () => {
        prefs.settingsSyncStamp = '2026-09-20T12:00:00Z';
        backend = fakeBackend(otherComputersDocument, 'present');
        expect(await flushSettingsExportNow()).toBe(true);
        expect(backend.writes).toHaveLength(1);
    });

    it('after taking the other computer\'s document, the next change is written with its values', async () => {
        // The import applies the document and starts the stamp; from then on
        // this machine's document carries the first computer's settings.
        backend = fakeBackend(otherComputersDocument, 'present');
        expect(applySettingsExport(parseSettingsExport(otherComputersDocument)!)?.changed)
            .toContain('customInstructions');
        expect(prefs.customInstructions).toBe('Answer like a referee');
        expect(await flushSettingsExportNow()).toBe(true);
        const written = JSON.parse(backend.writes[0]);
        expect(written.values.customInstructions).toBe('Answer like a referee');
    });
});

/*
 * A computer that already synced settings somewhere else, moving to another
 * location. Its stamp was earned with the old location and says nothing
 * about the new one: kept, it refused the new location's document for being
 * older than something it never came from, while the first-document rule
 * refused to write over it — the two computers silently kept different
 * settings. The switch forgets the stamp; the new location is first contact.
 */
describe('a computer moving to another sync location', () => {
    function fakeBackend(stored: string | null, presence: 'present' | 'absent' | 'unknown') {
        const writes: string[] = [];
        return {
            writes,
            readSettingsDocument: vi.fn(async () => stored),
            settingsDocumentPresence: vi.fn(async () => presence),
            writeSettingsDocument: vi.fn(async (json: string) => { writes.push(json); return true; }),
        };
    }
    const document = (exportedBy: string, exportedAt: string) => JSON.stringify({
        format: 'alphainz.settings', version: 1, exportedBy, exportedAt,
        values: { customInstructions: 'Answer like a referee' },
    });

    beforeEach(() => {
        prefs.welcomeWizardShownForVersion = WIZARD_VERSION;
        // Synced with the old location a day after the document below.
        prefs.settingsSyncStamp = '2026-09-21T12:00:00Z';
        forgetSettingsExchange();
    });

    it('takes the new location\'s settings, however old against the stamp it had', async () => {
        backend = fakeBackend(document('machine-B', '2026-09-20T12:00:00Z'), 'present');
        expect(await importSettingsNow()).toBe(true);
        expect(prefs.customInstructions).toBe('Answer like a referee');
        // And writes its own back, so the other computer knows it joined.
        expect(backend.writes).toHaveLength(1);
        expect(JSON.parse(backend.writes[0]).values.customInstructions).toBe('Answer like a referee');
    });

    it('does not write over another computer\'s document, nor over one it cannot read yet', async () => {
        backend = fakeBackend(document('machine-B', '2026-09-20T12:00:00Z'), 'present');
        expect(await flushSettingsExportNow()).toBe(false);
        backend = fakeBackend(null, 'present');
        expect(await flushSettingsExportNow()).toBe(false);
        expect(backend.writes).toEqual([]);
    });

    it('writes where there is none, and over its own', async () => {
        backend = fakeBackend(null, 'absent');
        expect(await flushSettingsExportNow()).toBe(true);
        forgetSettingsExchange();
        backend = fakeBackend(document('machine-A', '2026-09-20T12:00:00Z'), 'present');
        expect(await flushSettingsExportNow()).toBe(true);
        expect(backend.writes).toHaveLength(1);
    });

    it('marks only what it writes where nothing was as a first document', async () => {
        // Back at a location where it had taken another computer's settings,
        // its own earlier document was an ordinary one — and so is the next,
        // or a permission it turned off meanwhile would not reach the others.
        backend = fakeBackend(null, 'absent');
        await flushSettingsExportNow();
        expect(JSON.parse(backend.writes[0]).firstDocument).toBe(true);
        forgetSettingsExchange();
        backend = fakeBackend(document('machine-A', '2026-09-20T12:00:00Z'), 'present');
        await flushSettingsExportNow();
        expect(JSON.parse(backend.writes[0]).firstDocument).toBeUndefined();
        forgetSettingsExchange();
        backend = fakeBackend(JSON.stringify({ ...JSON.parse(document('machine-A', '2026-09-20T12:00:00Z')), firstDocument: true }), 'present');
        await flushSettingsExportNow();
        expect(JSON.parse(backend.writes[0]).firstDocument).toBe(true);
    });
});

/*
 * The reverse of the usual join: a new computer set the location up first,
 * so the document there holds its install defaults and its wizard's model,
 * and an established computer turns sync on afterwards. Taken wholesale, that
 * document replaced the established computer's custom instructions, Actions
 * and permissions with blanks.
 */
describe('a customized computer joining a location a new computer set up', () => {
    beforeEach(() => {
        installDefaultBranch();
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    it('keeps its own settings over the install defaults there, and sends them back out', async () => {
        const location = sharedLocation();
        backend = location;

        // The new computer: its wizard chose a model; everything else is as installed.
        vi.setSystemTime(new Date('2026-09-20T09:00:00Z'));
        const laptop = computer('machine-B', { llmProvider: 'deepseek', llmModel: 'deepseek-flash' });
        sitAt(laptop);
        await importSettingsNow();   // joining an empty location writes the first document
        const first = JSON.parse(location.doc!);
        expect(first.firstDocument).toBe(true);
        expect(first.defaults).toEqual(expect.arrayContaining(['customInstructions', 'actions', 'allowAgentWrites']));
        expect(first.defaults).not.toContain('llmProvider');
        leave(laptop);

        // The established computer turns sync on in Settings, a day later.
        vi.setSystemTime(new Date('2026-09-21T09:00:00Z'));
        const desktop = computer('machine-A', {
            customInstructions: 'Cite equation numbers; answer like a referee',
            actions: CUSTOM_ACTIONS,
            allowAgentWrites: true,
            llmProvider: 'openrouter',
            llmModel: 'z-ai/glm-5.3-flash',
        });
        sitAt(desktop);
        forgetSettingsExchange();
        expect(await importSettingsNow()).toBe(true);
        expect(prefs.customInstructions).toBe('Cite equation numbers; answer like a referee');
        expect(prefs.actions).toBe(CUSTOM_ACTIONS);
        expect(prefs.allowAgentWrites).toBe(true);
        // A choice made on the other computer is a choice: the location's wins.
        expect(prefs.llmProvider).toBe('deepseek');
        // What it kept is at the location now, as an ordinary document.
        const merged = JSON.parse(location.doc!);
        expect(merged.exportedBy).toBe('machine-A');
        expect(merged.firstDocument).toBeUndefined();
        expect(merged.values.customInstructions).toBe('Cite equation numbers; answer like a referee');
        expect(merged.values.allowAgentWrites).toBe(true);
        leave(desktop);

        // The new computer's next pass brings the established one's settings to it.
        vi.setSystemTime(new Date('2026-09-21T09:05:00Z'));
        sitAt(laptop);
        expect(await importSettingsNow()).toBe(true);
        expect(prefs.customInstructions).toBe('Cite equation numbers; answer like a referee');
        expect(prefs.actions).toBe(CUSTOM_ACTIONS);
        expect(prefs.allowAgentWrites).toBe(true);
        expect(prefs.llmProvider).toBe('deepseek');
    });

    it('does not wipe them either when the new computer changed a setting before it could see them', async () => {
        // Zotero on the new computer had not delivered the established one's
        // settings yet (offline, or not synced since): it wrote its own first,
        // and then the user changed the theme there.
        const established = sharedLocation();
        const laptopView = sharedLocation();
        vi.setSystemTime(new Date('2026-09-20T09:00:00Z'));
        backend = laptopView;
        const laptop = computer('machine-B');
        sitAt(laptop);
        await importSettingsNow();
        vi.setSystemTime(new Date('2026-09-20T09:10:00Z'));
        prefs.uiTheme = 'sky';
        expect(await flushSettingsExportNow()).toBe(true);
        // Still the only writer it has seen there: still a first document.
        expect(JSON.parse(laptopView.doc!).firstDocument).toBe(true);
        leave(laptop);

        // Zotero delivers it to the established computer, which has synced there for months.
        vi.setSystemTime(new Date('2026-09-20T09:30:00Z'));
        await established.writeSettingsDocument(laptopView.doc!);
        backend = established;
        const desktop = computer('machine-A', {
            customInstructions: 'Cite equation numbers', allowAgentWrites: true,
            settingsSyncStamp: '2026-06-01T00:00:00Z',
        });
        sitAt(desktop);
        await importSettingsNow();
        expect(prefs.customInstructions).toBe('Cite equation numbers');
        expect(prefs.allowAgentWrites).toBe(true);
        expect(prefs.uiTheme).toBe('sky');
        expect(JSON.parse(established.doc!).values.customInstructions).toBe('Cite equation numbers');
    });

    it('once another computer has taken its first document, a default it sets travels again', async () => {
        // A permission turned back off must reach the other computer, which
        // holds it on only because it took it from this one.
        const location = sharedLocation();
        backend = location;
        vi.setSystemTime(new Date('2026-09-20T09:00:00Z'));
        const desktop = computer('machine-A', { allowAgentWrites: true });
        sitAt(desktop);
        await importSettingsNow();   // the first computer at an empty location
        leave(desktop);

        vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
        const laptop = computer('machine-B');
        sitAt(laptop);
        await importSettingsNow();   // joins, takes the permission, writes back
        expect(prefs.allowAgentWrites).toBe(true);
        expect(JSON.parse(location.doc!).exportedBy).toBe('machine-B');
        leave(laptop);

        vi.setSystemTime(new Date('2026-09-20T11:00:00Z'));
        sitAt(desktop);
        await importSettingsNow();
        prefs.allowAgentWrites = false;
        vi.setSystemTime(new Date('2026-09-20T11:05:00Z'));
        await flushSettingsExportNow();
        expect(JSON.parse(location.doc!).firstDocument).toBeUndefined();
        leave(desktop);

        vi.setSystemTime(new Date('2026-09-20T11:10:00Z'));
        sitAt(laptop);
        await importSettingsNow();
        expect(prefs.allowAgentWrites).toBe(false);
    });

    it('compares an older writer\'s document, which lists no defaults, with this build\'s', () => {
        sitAt(computer('machine-A', { customInstructions: 'Mine', allowAgentWrites: true, uiTheme: 'warm' }));
        const taken = applySettingsExport({
            format: 'alphainz.settings', version: 1, exportedBy: 'machine-B', exportedAt: '2026-09-20T00:00:00Z',
            values: { customInstructions: '', allowAgentWrites: false, uiTheme: 'sky' },
        });
        expect(taken).toEqual({ firstContact: true, changed: ['uiTheme'], kept: ['allowAgentWrites', 'customInstructions'] });
        expect(prefs.customInstructions).toBe('Mine');
        expect(prefs.allowAgentWrites).toBe(true);
        expect(prefs.uiTheme).toBe('sky');
    });

    it('keeps its settings too when the other computer wrote first without seeing them', () => {
        // This computer has exchanged before; the document is the other one's
        // first, written while this one's could not be seen yet.
        sitAt(computer('machine-A', { customInstructions: 'Mine', settingsSyncStamp: '2026-09-01T00:00:00Z' }));
        const taken = applySettingsExport({
            format: 'alphainz.settings', version: 1, exportedBy: 'machine-B', exportedAt: '2026-09-20T00:00:00Z',
            values: { customInstructions: '', uiTheme: 'sky' }, defaults: ['customInstructions'], firstDocument: true,
        });
        expect(taken?.kept).toEqual(['customInstructions']);
        expect(prefs.customInstructions).toBe('Mine');
        expect(prefs.uiTheme).toBe('sky');
    });

    it('takes or keeps the provider and its model as one', () => {
        const here = { llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash' };
        const document = (values: Record<string, unknown>, defaults: string[]) => ({
            format: 'alphainz.settings', version: 1, exportedBy: 'machine-B',
            exportedAt: '2026-09-20T00:00:00Z', values, defaults,
        });

        // The other computer chose DeepSeek and left its model at the preset's
        // default: taking the provider alone would ask DeepSeek for an OpenRouter model.
        sitAt(computer('machine-A', here));
        applySettingsExport(document({ llmProvider: 'deepseek', llmModel: '' }, ['llmModel']));
        expect([prefs.llmProvider, prefs.llmModel]).toEqual(['deepseek', '']);

        // It chose no model at all: this computer's pair stays whole.
        sitAt(computer('machine-A', here));
        const taken = applySettingsExport(document({ llmProvider: '', llmModel: '' }, ['llmProvider', 'llmModel']));
        expect(taken?.kept).toEqual(['llmProvider', 'llmModel']);
        expect([prefs.llmProvider, prefs.llmModel]).toEqual(['openrouter', 'z-ai/glm-5.3-flash']);
    });

    it('between computers that have exchanged, a default travels like any value', () => {
        // Writes turned back off on the other computer must turn them off here.
        sitAt(computer('machine-A', { allowAgentWrites: true, customInstructions: 'Old', settingsSyncStamp: '2026-09-01T00:00:00Z' }));
        const taken = applySettingsExport({
            format: 'alphainz.settings', version: 1, exportedBy: 'machine-B', exportedAt: '2026-09-20T00:00:00Z',
            values: { allowAgentWrites: false, customInstructions: '' }, defaults: ['allowAgentWrites', 'customInstructions'],
        });
        expect(taken).toEqual({ firstContact: false, changed: ['allowAgentWrites', 'customInstructions'], kept: [] });
        expect(prefs.allowAgentWrites).toBe(false);
        expect(prefs.customInstructions).toBe('');
    });

    it('lists its own install defaults only when it can read them', () => {
        sitAt(computer('machine-A', { uiTheme: 'warm' }));
        expect(buildSettingsExport('2026-09-20T00:00:00Z').defaults).toContain('customInstructions');
        expect(buildSettingsExport('2026-09-20T00:00:00Z').defaults).not.toContain('uiTheme');
        delete (globalThis as any).Services;
        // Without a default branch an empty list would claim every value was chosen.
        expect(buildSettingsExport('2026-09-20T00:00:00Z')).not.toHaveProperty('defaults');
    });
});

describe('what taking another computer\'s settings announces', () => {
    beforeEach(() => {
        installDefaultBranch();
        sitAt(computer('machine-A'));
    });

    it('tells listeners what changed on first contact, and nothing when nothing changed', async () => {
        const heard: any[] = [];
        const stop = onSettingsTaken((taken) => heard.push(taken));
        try {
            const other = JSON.stringify({
                format: 'alphainz.settings', version: 1, exportedBy: 'machine-B', exportedAt: '2026-09-20T00:00:00Z',
                values: { customInstructions: 'Answer like a referee', uiTheme: 'zotero' },
            });
            backend = { readSettingsDocument: vi.fn(async () => other), writeSettingsDocument: vi.fn(async () => true) };
            expect(await importSettingsNow()).toBe(true);
            expect(heard).toEqual([{ firstContact: true, changed: ['customInstructions'], kept: [] }]);
            // The same document again is not newer than the stamp it left.
            expect(await importSettingsNow()).toBe(false);
            expect(heard).toHaveLength(1);
        } finally {
            stop();
        }
    });

    it('names what changed in words', () => {
        expect(describeSettingsTaken(['customInstructions', 'actions', 'llmModel', 'embeddingProvider', 'uiTheme']))
            .toBe('custom instructions, Actions, the model, the search index and the theme');
        expect(describeSettingsTaken(['allowAgentWrites'])).toBe('permissions');
        expect(describeSettingsTaken(['uiColorScheme', 'streamDisplay'])).toBe('the theme and other preferences');
        expect(describeSettingsTaken(['streamDisplay'])).toBe('preferences');
    });
});

/*
 * A computer whose first write was put off at joining — the location could
 * not say yet whether another computer's document was coming. If it never
 * wrote, the next computer to join would find the location empty and put its
 * install defaults there, and this computer would take those over its own.
 */
describe('importSettingsNow on a computer that has not exchanged settings yet', () => {
    function fakeBackend(presence: 'present' | 'absent' | 'unknown') {
        const writes: string[] = [];
        return {
            writes,
            readSettingsDocument: vi.fn(async () => null),
            settingsDocumentPresence: vi.fn(async () => presence),
            writeSettingsDocument: vi.fn(async (json: string) => { writes.push(json); return true; }),
        };
    }

    beforeEach(() => {
        prefs.welcomeWizardShownForVersion = WIZARD_VERSION;
        prefs.customInstructions = 'Cite the equation numbers';
    });

    it('writes the first document at its next pass, once the location says there is none', async () => {
        backend = fakeBackend('absent');
        expect(await importSettingsNow()).toBe(false);
        expect(backend.writes).toHaveLength(1);
        expect(JSON.parse(backend.writes[0]).values.customInstructions).toBe('Cite the equation numbers');
        expect(typeof prefs.settingsSyncStamp).toBe('string');
    });

    it('still writes nothing while another computer\'s document may be there', async () => {
        for (const presence of ['unknown', 'present'] as const) {
            backend = fakeBackend(presence);
            await importSettingsNow();
            expect(backend.writes, presence).toEqual([]);
        }
        expect(prefs.settingsSyncStamp).toBeUndefined();
    });

    it('leaves writing to the export once it has exchanged settings', async () => {
        prefs.settingsSyncStamp = '2026-09-20T12:00:00Z';
        backend = fakeBackend('absent');
        await importSettingsNow();
        expect(backend.writes).toEqual([]);
    });
});
