/**
 * Settings that travel with the conversations.
 *
 * One JSON document per backend (`settings.json`), holding a fixed whitelist
 * of portable preferences. Whole-document last-write-wins by `exportedAt` —
 * the same discipline the threads use — with a stored stamp so a document is
 * applied at most once and a machine never re-applies its own export. A
 * machine with no stamp yet has never exchanged settings with the backend:
 * it takes what is there before it writes anything, and keeps its own
 * settings wherever the document only holds its writer's install defaults.
 *
 * The whitelist is the security boundary: keys are plaintext and a synced
 * folder is exactly the kind of place they leak from, so no secret, no
 * machine-specific path, and none of the sync configuration itself may ever
 * appear here. Applying also iterates OUR list, never the file's keys — a
 * tampered document cannot write a preference the list does not name.
 */
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref, setPref } from '../../utils/prefs';
import { normalizeTheme } from '../../utils/appearance';
import { joinList, msg, normalizeUiLanguageSetting, t } from '../../utils/i18n';
import { isWelcomeWizardComplete } from '../../utils/welcomeWizard';
import { conversationSyncMode, getConversationBackend, machineId } from './index';
import type { ConversationBackend } from './types';
import config from '../../../package.json';

export const SETTINGS_EXPORT_FORMAT = 'alphainz.settings';
export const SETTINGS_EXPORT_VERSION = 1;

/**
 * Every preference the settings document carries. Portable by construction:
 * no secrets (llmKey*, *ApiKey), no endpoints that may point at localhost
 * (llmBaseUrl, customChatModels), no machine identity (lastUsedModel snapshot,
 * excludedLibraries — numeric per-machine ids and an access boundary), no
 * OS-specific behaviour (notifications, IME), and none of the sync or wizard
 * configuration, which each machine must own for itself.
 *
 * Typography stays local too. The theme is a choice about colour and travels;
 * the font, its size and the leading are choices about *this* screen — a 13px
 * serif that reads well on a 27-inch monitor is small on a laptop, and the
 * font stacks resolve to different faces on macOS and Windows anyway.
 */
export const PORTABLE_SETTINGS_PREFS = [
    // Appearance: the palette and the interface language — uiFont, uiFontSize
    // and uiLineHeight are per computer. A language left on "auto" follows each
    // computer's own Zotero.
    'uiTheme', 'uiColorScheme', 'uiLanguage',
    // Composition / UX
    'streamDisplay', 'conversationRail', 'keyboardShortcut', 'statefulChat',
    'addSelectedItemsOnOpen', 'addSelectedItemsOnNewThread',
    'addBeaverProvenanceNote', 'focusResponseForScreenReaders',
    'annotationToolEnabled', 'annotationAuthorName',
    'maxAddAttachmentToMessage', 'maxAttachmentFileSizeMB',
    'showDiffPreviewInNoteEditor', 'addAnnotationsOnOpen', 'selectionChatAutoComment',
    // Permissions / agent behaviour
    'allowAgentWrites', 'autoApplyAnnotations', 'autoCreateNotes', 'autoImportItems',
    'confirmExtractionCosts', 'confirmExternalSearchCosts', 'confirmCredits',
    'creditConfirmThreshold', 'deferredToolPreferences', 'requestPlusTools',
    'accessRemoteFiles',
    // Model configuration (non-secret)
    'llmProvider', 'llmModel', 'embeddingProvider', 'reasoningEffort',
    // Content
    'customInstructions', 'customPrompts', 'actions', 'readerExplainPrompt',
    // Citations
    'citationFormat', 'citationStyle', 'citationLocale',
    'useTemporaryCitationAnnotations', 'usePageLabels',
    // Search
    'fulltextSearchEnabled', 'contextCompactionEnabled', 'contextPruneOldToolDetail', 'contextCompactionThreshold', 'contextCompactionAfterRuns',
    // Limits per question: the user's policy, the same on every machine.
    'maxOutputTokens', 'maxModelRequests', 'maxLibrarySearches', 'maxLiteratureLookups', 'composerEngine',
] as const;

export interface SettingsExport {
    format: string;
    version: number;
    generator?: { name: string; version: string };
    exportedBy: string;
    exportedAt: string;
    values: Record<string, unknown>;
    /**
     * The keys whose value was the writer's install default: nothing chosen
     * there. Absent from older writers, whose values are then compared with
     * this build's defaults instead.
     */
    defaults?: string[];
    /**
     * Written by a computer that had not taken settings from another one at
     * this location, so its values are its own and its defaults are not
     * choices about anything synced. Absent means an ordinary document.
     */
    firstDocument?: boolean;
}

/**
 * A reader of this build's registered defaults, which answers undefined for a
 * preference whose default it cannot read — or null instead of a reader when
 * there is no default branch at all.
 */
function installDefaults(): ((key: string) => unknown) | null {
    let branch: any;
    try {
        branch = Services.prefs.getDefaultBranch('');
    } catch {
        return null;
    }
    return (key: string) => {
        const name = `${config.config.prefsPrefix}.${key}`;
        try {
            switch (branch.getPrefType(name)) {
                case branch.PREF_STRING: return branch.getStringPref(name);
                case branch.PREF_INT: return branch.getIntPref(name);
                case branch.PREF_BOOL: return branch.getBoolPref(name);
                default: return undefined;
            }
        } catch {
            return undefined;
        }
    };
}

/**
 * A value as this build reads it. The "zotero" theme — Beaver's unthemed look,
 * offered until 0.1.78 — is Fresh. Applied to what arrives, to what is compared
 * and to what is written, so an older computer's theme neither reads as a
 * change here nor travels on.
 */
function portableValue(key: string, value: unknown): unknown {
    if (key === 'uiTheme' && typeof value === 'string') return normalizeTheme(value);
    if (key === 'uiLanguage') return normalizeUiLanguageSetting(value);
    return value;
}

export function buildSettingsExport(
    exportedAt: string,
    options: { firstDocument?: boolean } = {},
): SettingsExport {
    const defaultOf = installDefaults();
    const values: Record<string, unknown> = {};
    const defaults: string[] = [];
    for (const key of PORTABLE_SETTINGS_PREFS) {
        const value = portableValue(key, getPref(key as any));
        if (value === undefined) continue;
        values[key] = value;
        if (defaultOf && defaultOf(key) === value) defaults.push(key);
    }
    return {
        format: SETTINGS_EXPORT_FORMAT,
        version: SETTINGS_EXPORT_VERSION,
        generator: { name: config.config.addonName, version: config.version },
        exportedBy: machineId(),
        exportedAt,
        values,
        // Only when the defaults could be read: an empty list would claim
        // that every value here was chosen.
        ...(defaultOf ? { defaults } : {}),
        ...(options.firstDocument ? { firstDocument: true } : {}),
    };
}

export function parseSettingsExport(text: string): SettingsExport | null {
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.format !== SETTINGS_EXPORT_FORMAT) return null;
    if (typeof parsed.version !== 'number' || parsed.version > SETTINGS_EXPORT_VERSION) return null;
    if (!parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) return null;
    if (typeof parsed.exportedAt !== 'string' || !parsed.exportedAt) return null;
    // The two hints are taken only in their own shape; anything else is dropped.
    const doc: SettingsExport = { ...parsed, values: { ...parsed.values } };
    for (const key of Object.keys(doc.values)) doc.values[key] = portableValue(key, doc.values[key]);
    if (Array.isArray(parsed.defaults)) {
        doc.defaults = parsed.defaults.filter((key: unknown): key is string => typeof key === 'string');
    } else {
        delete doc.defaults;
    }
    if (parsed.firstDocument !== true) delete doc.firstDocument;
    return doc;
}

/** True while an import is writing prefs, so the export observer stays quiet. */
let applyingImport = false;

/** What applying another computer's document did here. */
export interface SettingsTaken {
    /** This computer had not exchanged settings with the location before. */
    firstContact: boolean;
    /** The preferences whose value changed here. */
    changed: string[];
    /** The preferences where this computer kept its own setting over the document's install default. */
    kept: string[];
}

/** Whether the document's value for `key` was its writer's install default. */
function writersDefault(
    doc: SettingsExport,
    key: string,
    defaultOf: ((key: string) => unknown) | null,
): boolean {
    if (Array.isArray(doc.defaults)) return doc.defaults.includes(key);
    const fallback = defaultOf?.(key);
    return fallback !== undefined && doc.values[key] === fallback;
}

/** Whether this computer's value is a setting made here rather than its install default. */
function setHere(current: unknown, key: string, defaultOf: ((key: string) => unknown) | null): boolean {
    if (current === undefined) return false;
    const fallback = defaultOf?.(key);
    // A default that cannot be read counts the value as set: keeping it loses nothing.
    return fallback === undefined || current !== fallback;
}

/**
 * Preferences that only mean something together, so they are kept or taken
 * as one: a provider from one computer with a model id from another names a
 * model that provider does not have.
 */
const COUPLED_PREFS: ReadonlyArray<readonly string[]> = [['llmProvider', 'llmModel']];

/**
 * Whether this computer keeps its own value of `key` over the document's:
 * the document has only its writer's install default there — for all of the
 * key's companions — and this computer has a setting of its own.
 */
function keepsOwnSetting(doc: SettingsExport, key: string, defaultOf: ((key: string) => unknown) | null): boolean {
    const group = (COUPLED_PREFS.find((keys) => keys.includes(key)) ?? [key])
        .filter((member) => member in doc.values);
    return group.every((member) => writersDefault(doc, member, defaultOf))
        && group.some((member) => setHere(portableValue(member, getPref(member as any)), member, defaultOf));
}

/**
 * Apply a parsed document to this machine's preferences.
 *
 * Returns null when the document is this machine's own or not newer than what
 * it last exchanged; otherwise what changed — the caller uses that to poke the
 * pref-mirroring atoms (model picker, stream display) that would otherwise
 * keep their stale hydration.
 */
export function applySettingsExport(doc: SettingsExport): SettingsTaken | null {
    if (doc.exportedBy === machineId()) return null;
    const stamp = String(getPref('settingsSyncStamp') ?? '');
    if (stamp && !(Date.parse(doc.exportedAt) > Date.parse(stamp))) return null;
    const firstContact = !stamp;

    /*
     * Until two computers have exchanged settings — this one is joining the
     * location, or the document's writer has taken nothing from another
     * computer there (it wrote without seeing this one's) — an install
     * default in the document is not a choice. It never replaces a setting
     * made here: a new computer's blank custom instructions, empty Actions
     * list and writes-off permission must not wipe an established computer's.
     * Once they have exchanged, a default is as deliberate as any value (a
     * permission turned back off, instructions cleared) and applies like one.
     */
    const keepOwn = firstContact || doc.firstDocument === true;
    const defaultOf = keepOwn ? installDefaults() : null;
    const taken: SettingsTaken = { firstContact, changed: [], kept: [] };

    applyingImport = true;
    try {
        for (const key of PORTABLE_SETTINGS_PREFS) {
            if (!(key in doc.values)) continue;
            const incoming = doc.values[key];
            const current = portableValue(key, getPref(key as any));
            // Type-checked against what this build stores there; a document
            // from a newer build with a retyped pref cannot corrupt this one.
            if (current !== undefined && typeof incoming !== typeof current) continue;
            if (incoming === current) continue;
            if (keepOwn && keepsOwnSetting(doc, key, defaultOf)) {
                taken.kept.push(key);
                continue;
            }
            setPref(key as any, incoming as any);
            taken.changed.push(key);
        }
        setPref('settingsSyncStamp', doc.exportedAt);
        return taken;
    } finally {
        applyingImport = false;
    }
}

type SettingsTakenListener = (taken: SettingsTaken) => void;
const takenListeners = new Set<SettingsTakenListener>();

/**
 * Be told whenever another computer's document changes a setting here — at
 * a join, or at a later pass, when a document that could not be read at the
 * join arrives. Returns the unsubscribe.
 *
 * Module state, so only the bundle that runs the imports hears them: the
 * React one, where every import runs.
 */
export function onSettingsTaken(listener: SettingsTakenListener): () => void {
    takenListeners.add(listener);
    return () => { takenListeners.delete(listener); };
}

function announceSettingsTaken(taken: SettingsTaken): void {
    if (taken.changed.length === 0) return;
    for (const listener of [...takenListeners]) {
        try {
            listener(taken);
        } catch (error) {
            logger(`settingsSync: a settings-taken listener failed: ${error}`, 1);
        }
    }
}

/** The groups of settings the announcement names, in the order it names them. */
const TAKEN_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
    [msg('custom instructions'), ['customInstructions']],
    [msg('Actions'), ['actions']],
    [msg('prompts'), ['customPrompts', 'readerExplainPrompt']],
    [msg('permissions'), [
        'allowAgentWrites', 'autoApplyAnnotations', 'autoCreateNotes', 'autoImportItems',
        'confirmExtractionCosts', 'confirmExternalSearchCosts', 'confirmCredits',
        'creditConfirmThreshold', 'deferredToolPreferences', 'requestPlusTools', 'accessRemoteFiles',
    ]],
    [msg('the model'), ['llmProvider', 'llmModel', 'reasoningEffort']],
    [msg('the search index'), ['embeddingProvider']],
    [msg('the theme'), ['uiTheme', 'uiColorScheme']],
    [msg('the language'), ['uiLanguage']],
    [msg('citations'), ['citationFormat', 'citationStyle', 'citationLocale', 'useTemporaryCitationAnnotations', 'usePageLabels']],
    [msg('limits per question'), ['maxOutputTokens', 'maxModelRequests', 'maxLibrarySearches', 'maxLiteratureLookups']],
];

/** "custom instructions, the model and the theme": what a set of changed preferences amounts to. */
export function describeSettingsTaken(changed: readonly string[]): string {
    const names = TAKEN_GROUPS
        .filter(([, keys]) => keys.some((key) => changed.includes(key)))
        .map(([name]) => t(name));
    const named = new Set(TAKEN_GROUPS.flatMap(([, keys]) => keys));
    if (changed.some((key) => !named.has(key))) names.push(names.length > 0 ? t('other preferences') : t('preferences'));
    return joinList(names);
}

/**
 * Read the backend's settings document and apply it if newer. Resolves true
 * when a setting here changed.
 * No-op before the welcome wizard has run: the wizard is where sync itself is
 * chosen, and a document must never configure the machine ahead of the person.
 */
export async function importSettingsNow(): Promise<boolean> {
    if (!isWelcomeWizardComplete()) return false;
    const backend = getConversationBackend();
    if (!backend) return false;
    const text = await backend.readSettingsDocument();
    if (!text) {
        /*
         * Nothing to take. A computer that has not exchanged settings with
         * this location yet had its first write put off — the location could
         * not say whether another computer's document was on its way — and
         * writes it now if there is still none, so the next computer to join
         * finds this one's settings there instead of an empty location.
         */
        if (!String(getPref('settingsSyncStamp') ?? '')) await flushSettingsExportNow();
        return false;
    }
    const doc = parseSettingsExport(text);
    if (!doc) {
        logger('settingsSync: the settings document did not parse; leaving it alone', 1);
        return false;
    }
    const taken = applySettingsExport(doc);
    if (!taken) return false;
    /*
     * A first exchange between two computers ends with this one's settings
     * written back. What it kept over the document's install defaults is not
     * at the location yet; and the computer that wrote a first document
     * learns from this one's that its settings have been taken, so its next
     * document is an ordinary one, whose defaults travel like any value.
     */
    if (taken.firstContact || doc.firstDocument === true) await flushSettingsExportNow();
    announceSettingsTaken(taken);
    return taken.changed.length > 0;
}

/**
 * Whether, and as what, a machine that has not exchanged settings with this
 * backend yet — never, or not since it started using it — may write its
 * document there.
 *
 * Its preferences may be install defaults plus whatever the wizard just set,
 * and the document is whole-document last-write-wins: written over another
 * computer's settings, it would replace that computer's model choice, and
 * whatever else differs, at its next pass. So only an empty backend, or a
 * document this machine wrote itself, may be written. Another computer's
 * document — or one that is there but cannot be read yet — is left for the
 * import, which applies it here when it is newer and starts the stamp.
 *
 * An empty backend gets a first document. So does this machine's own earlier
 * one only when that was a first document too: a computer back at a location
 * where it had taken other computers' settings writes an ordinary one, whose
 * defaults travel.
 */
async function firstWrite(backend: ConversationBackend): Promise<'refused' | 'first' | 'ordinary'> {
    const text = await backend.readSettingsDocument();
    if (text !== null) {
        const doc = parseSettingsExport(text);
        if (!doc || doc.exportedBy !== machineId()) return 'refused';
        return doc.firstDocument === true ? 'first' : 'ordinary';
    }
    const presence = backend.settingsDocumentPresence
        ? await backend.settingsDocumentPresence()
        : 'absent';
    return presence === 'absent' ? 'first' : 'refused';
}

/**
 * Whether this computer is still the only one to have written the location's
 * settings: the document there is its own first document, or one that carried
 * that on, and it has taken nothing since. Its next document is then a first
 * document too — nothing in it was ever another computer's, however many
 * times it has changed a setting before another computer's reached it.
 */
async function stillOnlyWriter(backend: ConversationBackend, stamp: string): Promise<boolean> {
    try {
        const text = await backend.readSettingsDocument();
        const doc = text ? parseSettingsExport(text) : null;
        return !!doc && doc.firstDocument === true && doc.exportedBy === machineId() && doc.exportedAt === stamp;
    } catch {
        return false;
    }
}

/**
 * Write this machine's current settings out, stamping the LWW clock. Before
 * this computer has exchanged settings with the location, only by the
 * first-document rule, and marked as a first document for as long as it
 * remains the only writer there.
 */
export async function flushSettingsExportNow(): Promise<boolean> {
    const backend = getConversationBackend();
    if (!backend) return false;
    const stamp = String(getPref('settingsSyncStamp') ?? '');
    let firstDocument: boolean;
    if (!stamp) {
        const verdict = await firstWrite(backend);
        if (verdict === 'refused') {
            logger('settingsSync: leaving the settings document to the import — it is another computer\'s, or not readable yet', 3);
            return false;
        }
        firstDocument = verdict === 'first';
    } else {
        firstDocument = await stillOnlyWriter(backend, stamp);
    }
    const exportedAt = new Date().toISOString();
    const doc = buildSettingsExport(exportedAt, { firstDocument });
    const ok = await backend.writeSettingsDocument(JSON.stringify(doc, null, 2));
    if (ok) setPref('settingsSyncStamp', exportedAt);
    return ok;
}

/**
 * Forget the settings exchange, because the sync location changed. The stamp
 * describes the place just left, and kept, it would make this computer
 * refuse the new location's document for being older than something it never
 * came from. Cleared, the next pass treats the new location as first contact:
 * take what is there, keeping this computer's own settings over install
 * defaults, before writing anything.
 */
export function forgetSettingsExchange(): void {
    setPref('settingsSyncStamp', '');
}

// ---------------------------------------------------------------------------
// The export observer: any portable pref change writes the document, debounced.
// ---------------------------------------------------------------------------

let observerSymbols: any[] = [];
let exportTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleExport(): void {
    if (applyingImport) return;               // an import is not an edit
    if (conversationSyncMode() === 'off') return;
    if (!isWelcomeWizardComplete()) return;   // the wizard flushes explicitly
    if (exportTimer !== null) clearTimeout(exportTimer);
    exportTimer = setTimeout(() => {
        exportTimer = null;
        void flushSettingsExportNow();
    }, 2000);
}

export function startSettingsSyncObserver(): void {
    if (observerSymbols.length) return;
    for (const key of PORTABLE_SETTINGS_PREFS) {
        try {
            observerSymbols.push(
                Zotero.Prefs.registerObserver(
                    `${config.config.prefsPrefix}.${key}`,
                    scheduleExport,
                    true,
                ),
            );
        } catch (e) {
            logger(`settingsSync: could not observe ${key}: ${e}`, 1);
        }
    }
}

export function stopSettingsSyncObserver(): void {
    for (const sym of observerSymbols) {
        try { Zotero.Prefs.unregisterObserver(sym); } catch { /* already gone */ }
    }
    observerSymbols = [];
    if (exportTimer !== null) { clearTimeout(exportTimer); exportTimer = null; }
}
