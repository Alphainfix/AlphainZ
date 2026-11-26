/**
 * Settings → Model → Providers: one card per provider, built in or hand-added.
 *
 * The same shape for both, because the user's question is the same for both:
 * where is it, what key opens it, which models does it serve. A card reads as
 * a row until it is edited; edited, it shows the key, an optional address, and
 * the model catalogue — rows of id and display name, each openable for what a
 * list cannot tell us: does it read images (with a Check that asks the
 * endpoint), which thinking tiers it takes, how large its context window is,
 * and the most one answer may use. A built-in model starts from what its
 * preset knows; a hand-added one knows only what it is told. Save writes the
 * draft; Cancel drops it. A built-in card's new key is the exception, because
 * some vendors show a key only once: it is kept as soon as a Test succeeds
 * with it, and when the card closes any way other than Cancel — unless its
 * Test failed and another key is stored. An empty key field keeps the stored
 * key.
 *
 * Only configured providers are listed. The rest wait behind "Add provider",
 * so the page is as long as the user's setup, not as long as the catalogue of
 * vendors this plugin knows.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import {
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    DeleteIcon,
    Icon,
    InformationCircleIcon,
    PlusSignIcon,
    Spinner,
    TickIcon,
} from '../icons/icons';

import { getPref, setPref } from '../../../src/utils/prefs';
import { conversationSyncMode } from '../../../src/services/conversationSync';
import { PROVIDER_PRESETS, presetSupportsVision, retireChoice, type ProviderPresetId } from '../../../src/services/llm/openAICompatible';
import { boundFetch, migrateLegacyBaseUrl, ollamaBaseUrlFromPrefs } from '../../../src/services/llm/agentConfig';
import { verifyChatProvider, verifyCustomEndpoint, type VerifyResult } from '../../../src/services/llm/verifyKey';
import { probeVision, type VisionProbeVerdict } from '../../../src/services/llm/visionProbe';
import { fetchModelIds } from '../../../src/services/llm/listModels';
import {
    currentEndpointId,
    customModelTiers,
    customProviderId,
    isCustomProviderId,
    newEndpointId,
    readCustomEndpoints,
    writeCustomEndpoints,
    type CustomEndpoint,
    type CustomEndpointModel,
} from '../../../src/services/llm/customEndpoints';
import {
    catalogueFor,
    defaultCatalogue,
    ollamaModelVision,
    readProviderOverrides,
    setOllamaModelVision,
    writeProviderOverrides,
    type CatalogueModel,
    type ProviderOverride,
    type ProviderOverrides,
} from '../../../src/services/llm/providerOverrides';
import { tuningDefaults, type TuningDefaults } from '../../../src/services/llm/modelTuning';
import { THINKING_TIERS, THINKING_TIER_NAMES, type ModelTuning, type ThinkingTier } from '../../../src/services/llm/thinkingTiers';
import type { WireFormat } from '../../../src/services/llm/types';
import {
    availableModelsAtom,
    modelAfterRemoving,
    ollamaModelsFromPrefs,
    refreshLocalModelAtom,
    releaseRemovedProvidersAtom,
} from '../../atoms/models';
import { isOllamaEmbeddingModel, normalizeOllamaBase, onOllamaStatus, type OllamaStatus } from '../../utils/ollama';
import { OllamaGuide, refreshOllamaStatus } from './OllamaGuide';
import { VENDORS, type KeyPrefName, type Vendor } from './vendors';
import { SectionDescription, SectionHeader, SettingsGroup } from './components/SettingsElements';
import { t, tn } from '../../../src/utils/i18n';
import { tr } from '../../utils/i18nNodes';

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

type Status = 'idle' | 'busy' | 'ok' | 'error';
interface Outcome { status: Status; message?: string }
const BUTTON_ICON = { idle: ArrowRightIcon, busy: Spinner, ok: TickIcon, error: AlertIcon } as const;

const readPref = (key: 'llmProvider' | 'llmModel' | 'llmBaseUrl' | KeyPrefName): string => {
    const value = getPref(key);
    return typeof value === 'string' ? value.trim() : '';
};

/** The provider and model in use now, as the runner will resolve them. */
const choiceInUse = () => retireChoice(readPref('llmProvider'), readPref('llmModel'));

/**
 * What removing these providers does to the model in use, for the confirm
 * dialog; empty when the model in use is elsewhere.
 */
function removalConsequence(providerIds: readonly string[]): string {
    if (!providerIds.includes(choiceInUse().provider)) return '';
    const next = modelAfterRemoving(providerIds);
    if (!next) return '\n\n' + t('It is the provider in use and no other provider is set up, so no model is selected until you add one.');
    // The model choice is among the settings that sync; keys and providers are not.
    const synced = conversationSyncMode() !== 'off'
        ? ' ' + t('With settings sync on, your other computers switch to it too, so it has to be set up on each of them.')
        : '';
    return '\n\n' + t('It is the provider in use, so the sidebar switches to {name}.', { name: next.name }) + synced;
}

/** A Test's outcome as the card shows it, naming the model it asked. */
function testOutcome(result: VerifyResult, model: string, cancelled: boolean): Outcome {
    if (cancelled) return { status: 'idle', message: t('Test cancelled.') };
    if (!result.ok) return { status: 'error', message: result.message };
    return {
        status: 'ok',
        message: model ? t('{message} with {model}.', { message: result.message.replace(/[.。]$/, ''), model }) : result.message,
    };
}

const OutcomeLine: React.FC<{ outcome?: Outcome }> = ({ outcome }) =>
    outcome?.message ? (
        <span
            className={`text-sm ${outcome.status === 'error' ? 'font-color-error' : 'font-color-secondary'}`}
            role={outcome.status === 'error' ? 'alert' : undefined}
        >
            {outcome.message}
        </span>
    ) : null;

const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-sm font-color-secondary display-flex flex-row items-start gap-1">
        <Icon icon={InformationCircleIcon} className="scale-90 mt-015 font-color-secondary" />
        <span>{children}</span>
    </div>
);

/** What a Check found, as one sentence. */
export function describeVerdict(verdict: VisionProbeVerdict): string {
    const when = new Date(verdict.checkedAt).toLocaleString();
    return verdict.seesImages
        ? t('Reads figures — checked {when}.', { when })
        : t('Does not read figures — checked {when} ({detail}).', { when, detail: verdict.detail });
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="display-flex flex-col gap-1">
        <div className="text-sm font-semibold font-color-primary">{label}</div>
        {children}
    </div>
);

/** The card's row: name, id badge, status dot, actions. */
const CardHeader: React.FC<{
    title: string;
    badge: string;
    configured: boolean;
    editing: boolean;
    onEdit: () => void;
    onRemove?: () => void;
    removeLabel?: string;
}> = ({ title, badge, configured, editing, onEdit, onRemove, removeLabel = t('Remove') }) => (
    <div className="display-flex flex-row items-center gap-2" data-testid="provider-card-header">
        <span className="text-base font-semibold font-color-primary">{title}</span>
        <span className="text-xs font-color-tertiary px-1 border-quinary rounded-sm" style={{ fontFamily: 'monospace' }}>{badge}</span>
        <span
            aria-label={configured ? t('Configured') : t('Not configured')}
            title={configured ? t('Configured') : t('Not configured')}
            style={{ width: 8, height: 8, borderRadius: 4, background: configured ? 'var(--accent-green, #3fa24a)' : 'var(--fill-quinary, #bbb)', display: 'inline-block' }}
        />
        <span className="flex-1" />
        {!editing && (
            <Button variant="outline" style={{ padding: '2px 8px' }} onClick={onEdit} ariaLabel={t('Edit {title}', { title })}>
                {t('Edit')}
            </Button>
        )}
        {!editing && onRemove && (
            <Button variant="ghost-secondary" style={{ padding: '2px 6px' }} onClick={onRemove} ariaLabel={`${removeLabel} ${title}`}>
                {removeLabel}
            </Button>
        )}
    </div>
);

const confirmDialog = (title: string, text: string, button0: string): boolean => {
    if (typeof (Zotero as any)?.Prompt?.confirm !== 'function') return true;
    return Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text,
        button0,
        button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
        defaultButton: 1,
    }) === 0;
};

// ---------------------------------------------------------------------------
// The catalogue editor, shared by both kinds of card
// ---------------------------------------------------------------------------

interface CatalogueRow {
    /** Built-in: which preset the row belongs to. Custom: the endpoint's provider id. */
    providerId: string;
    id: string;
    label: string;
    /** Explicit flag; undefined means "whatever the provider says". */
    supportsVision?: boolean;
    /** The thinking tiers it takes; undefined means "whatever the provider says". */
    efforts?: ThinkingTier[];
    /** Its context window in tokens; undefined means "whatever the provider says". */
    contextWindow?: number;
    /** The most one answer may use; undefined means the provider's default. */
    maxOutputTokens?: number;
    /** The last Check's sentence, for this session. */
    checkNote?: string;
}

interface CatalogueTarget {
    baseUrl: string;
    apiKey: string;
    authStyle?: 'bearer' | 'x-api-key';
    /** A built-in card's preset, so a Check goes out on the wire its runs use. */
    presetId?: ProviderPresetId;
    /** A hand-added endpoint's wire, likewise. */
    wireFormat?: WireFormat;
}

/** "272,000": a token count as the settings show it. */
const tokens = (count: number) => count.toLocaleString('en-US');

/** A token count typed into a field: its digits, or undefined for none (or zero). */
function typedTokens(text: string): number | undefined {
    const digits = text.replace(/\D/g, '');
    const count = digits ? Number(digits) : 0;
    return Number.isSafeInteger(count) && count >= 1 ? count : undefined;
}

/** The tiers a row offers: its own list, or what applies when it has none. */
const rowTiers = (row: CatalogueRow, defaults: TuningDefaults): ThinkingTier[] => row.efforts ?? defaults.efforts;

/**
 * A model's thinking tiers, context window and output cap, inside its
 * catalogue row. Empty fields show what applies anyway; a built-in model can
 * go back to its preset's values in one click.
 */
const TuningFields: React.FC<{
    row: CatalogueRow;
    defaults: TuningDefaults;
    /** Whether the defaults are a preset's, which "Use the preset's values" restores. */
    fromPreset: boolean;
    onChange: (patch: Partial<CatalogueRow>) => void;
}> = ({ row, defaults, fromPreset, onChange }) => {
    const name = row.id || t('this model');
    const tiers = rowTiers(row, defaults);
    const toggle = (tier: ThinkingTier, on: boolean) =>
        onChange({ efforts: THINKING_TIERS.filter((level) => (level === tier ? on : tiers.includes(level))) });
    const ceiling = defaults.outputCeiling;
    const tuned = row.efforts !== undefined || row.contextWindow !== undefined || row.maxOutputTokens !== undefined;
    return (
        <div className="display-flex flex-col gap-1" data-testid="model-tuning">
            <div className="display-flex flex-row items-center gap-2 flex-wrap" role="group" aria-label={t('Thinking settings {name} takes', { name })}>
                <span className="text-sm font-color-primary">{t('Thinking')}</span>
                {THINKING_TIERS.map((tier) => (
                    <label key={tier} className="display-flex flex-row items-center gap-05 text-sm font-color-primary">
                        <input
                            type="checkbox"
                            checked={tiers.includes(tier)}
                            onChange={(e) => toggle(tier, e.target.checked)}
                            aria-label={t('{name} takes {value}', { name, value: t(THINKING_TIER_NAMES[tier]) })}
                        />
                        {t(THINKING_TIER_NAMES[tier])}
                    </label>
                ))}
            </div>
            {tiers.length === 0 && (
                <span className="text-xs font-color-tertiary">{t('None ticked: no thinking setting is sent, and the composer offers none.')}</span>
            )}
            <div className="display-flex flex-row items-center gap-3 flex-wrap">
                <label className="display-flex flex-row items-center gap-1 text-sm font-color-primary">
                    {t('Context window')}
                    <input
                        type="text"
                        inputMode="numeric"
                        value={row.contextWindow ?? ''}
                        onChange={(e) => onChange({ contextWindow: typedTokens(e.target.value) })}
                        placeholder={defaults.contextWindow ? tokens(defaults.contextWindow) : t('Not set')}
                        className="p-1 m-0 preference-input text-sm"
                        style={{ width: '7.5em' }}
                        aria-label={t('Context window of {name}, in tokens', { name })}
                    />
                </label>
                <label className="display-flex flex-row items-center gap-1 text-sm font-color-primary">
                    {t('Max output')}
                    <input
                        type="text"
                        inputMode="numeric"
                        value={row.maxOutputTokens ?? ''}
                        onChange={(e) => onChange({ maxOutputTokens: typedTokens(e.target.value) })}
                        placeholder={defaults.maxOutputTokens ? tokens(defaults.maxOutputTokens) : ''}
                        className="p-1 m-0 preference-input text-sm"
                        style={{ width: '6.5em' }}
                        aria-label={t('Most output one answer from {name} may use, in tokens', { name })}
                    />
                </label>
                {fromPreset && tuned && (
                    <button
                        type="button"
                        className="bg-transparent border-none p-0 text-sm font-color-secondary cursor-pointer"
                        onClick={() => onChange({ efforts: undefined, contextWindow: undefined, maxOutputTokens: undefined })}
                        aria-label={t('Use the preset\'s values for {name}', { name })}
                    >
                        {t('Use the preset\'s values')}
                    </button>
                )}
            </div>
            <span className="text-xs font-color-tertiary">
                {t('A long chat is summarized before it fills 70% of the context window. Max output is this model\'s ceiling: '
                    + 'Limits per Question can lower it, not raise it.')}
                {ceiling && row.maxOutputTokens && row.maxOutputTokens > ceiling
                    ? ' ' + t('This endpoint accepts at most {tokens}, so answers stop there.', { tokens: tokens(ceiling) })
                    : ''}
            </span>
        </div>
    );
};

const CatalogueEditor: React.FC<{
    rows: CatalogueRow[];
    onChange: (rows: CatalogueRow[]) => void;
    /** Where Check and Fetch send their requests. */
    target: CatalogueTarget;
    /** Provider id a newly added row gets. */
    newRowProviderId: string;
    /** Whether a row's "reads figures" default comes from a preset. */
    defaultVision: (row: CatalogueRow) => boolean;
    customised?: boolean;
    onRestoreDefaults?: () => void;
    current: { provider: string; model: string };
    onUse: (row: CatalogueRow) => void;
}> = ({ rows, onChange, target, newRowProviderId, defaultVision, customised, onRestoreDefaults, current, onUse }) => {
    const [open, setOpen] = useState<Record<number, boolean>>({});
    const [checks, setChecks] = useState<Record<number, Outcome>>({});
    const [fetched, setFetched] = useState<string[] | null>(null);
    const [fetchState, setFetchState] = useState<Outcome>({ status: 'idle' });
    const [pick, setPick] = useState('');

    const update = (index: number, patch: Partial<CatalogueRow>) =>
        onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

    const check = async (index: number) => {
        const row = rows[index];
        if (!row?.id.trim() || !target.baseUrl) return;
        setChecks((prev) => ({ ...prev, [index]: { status: 'busy' } }));
        // The draft's tiers, not the saved ones: the least of them is what the probe sends.
        const least = rowTiers(row, tuningDefaults(row.providerId, row.id.trim()))[0];
        const verdict = await probeVision({ ...target, model: row.id.trim(), leastEffort: least ?? null }, boundFetch as any);
        update(index, { supportsVision: verdict.seesImages, checkNote: describeVerdict(verdict) });
        setChecks((prev) => ({ ...prev, [index]: { status: verdict.seesImages ? 'ok' : 'idle', message: describeVerdict(verdict) } }));
    };

    const fetchAll = async () => {
        setFetchState({ status: 'busy' });
        try {
            const ids = await fetchModelIds(target, boundFetch as any);
            setFetched(ids);
            setPick(ids.find((id) => !rows.some((r) => r.id === id)) ?? ids[0] ?? '');
            setFetchState({ status: 'ok', message: tn(ids.length, '{count} model available.', '{count} models available.') });
        } catch (error) {
            setFetched(null);
            setFetchState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
    };

    return (
        <div className="display-flex flex-col gap-2" data-testid="catalogue">
            <div className="display-flex flex-row items-center gap-3">
                <div className="display-flex flex-col">
                    <span className="text-sm font-semibold font-color-primary">{t('Model catalogue')}</span>
                    {customised && <span className="text-xs font-color-tertiary">{t('Edited — the preset\'s list is replaced')}</span>}
                </div>
                <span className="flex-1" />
                {onRestoreDefaults && customised && (
                    <button type="button" className="bg-transparent border-none p-0 text-sm font-color-secondary cursor-pointer" onClick={onRestoreDefaults}>
                        {t('Restore default models')}
                    </button>
                )}
                <button
                    type="button"
                    className="bg-transparent border-none p-0 text-sm font-color-secondary cursor-pointer"
                    onClick={() => void fetchAll()}
                    disabled={fetchState.status === 'busy' || !target.baseUrl}
                    aria-label={t('Fetch available models')}
                >
                    {fetchState.status === 'busy' ? t('Fetching…') : t('Fetch available models')}
                </button>
            </div>
            {fetched && (
                <div className="display-flex flex-row items-center gap-2">
                    <select value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1 p-1 m-0 preference-input text-sm" aria-label={t('Available models')}>
                        {fetched.map((id) => (
                            <option key={id} value={id}>{rows.some((r) => r.id === id) ? t('{id} (listed)', { id }) : id}</option>
                        ))}
                    </select>
                    <Button
                        variant="outline"
                        style={{ padding: '2px 8px' }}
                        disabled={!pick || rows.some((r) => r.id === pick)}
                        onClick={() => onChange([...rows, { providerId: newRowProviderId, id: pick, label: '' }])}
                        ariaLabel={t('Add {pick} to the catalogue', { pick })}
                    >
                        {t('Add')}
                    </Button>
                </div>
            )}
            <OutcomeLine outcome={fetchState.status === 'error' ? fetchState : undefined} />

            {rows.map((row, index) => {
                const inUse = !!row.id && current.provider === row.providerId && current.model === row.id;
                const reads = row.supportsVision ?? defaultVision(row);
                const state = checks[index] ?? { status: 'idle' as Status };
                return (
                    <div key={`${row.providerId}-${index}`} className="display-flex flex-col gap-1 p-1 border-quinary rounded-md" data-testid="catalogue-row">
                        <div className="display-flex flex-row items-center gap-2">
                            <input
                                type="text"
                                value={row.id}
                                onChange={(e) => update(index, { id: e.target.value.trim() })}
                                placeholder={t('Model id, exactly as the endpoint spells it')}
                                className="flex-1 p-1 m-0 preference-input text-sm"
                                aria-label={t('Model id')}
                            />
                            <input
                                type="text"
                                value={row.label}
                                onChange={(e) => update(index, { label: e.target.value })}
                                placeholder={t('Display name')}
                                className="p-1 m-0 preference-input text-sm"
                                style={{ width: '36%' }}
                                aria-label={t('Model display name')}
                            />
                            <IconButton
                                icon={open[index] ? ArrowDownIcon : ArrowRightIcon}
                                variant="ghost-secondary"
                                onClick={() => setOpen((prev) => ({ ...prev, [index]: !prev[index] }))}
                                ariaLabel={open[index]
                                    ? t('Hide details for {name}', { name: row.id || t('this model') })
                                    : t('Show details for {name}', { name: row.id || t('this model') })}
                            />
                            <IconButton
                                icon={DeleteIcon}
                                variant="ghost-secondary"
                                onClick={() => onChange(rows.filter((_, i) => i !== index))}
                                ariaLabel={row.id ? t('Remove model {name}', { name: row.id }) : t('Remove this row')}
                            />
                        </div>
                        {open[index] && (
                            <div className="display-flex flex-col gap-1 pl-2">
                                <div className="display-flex flex-row items-center gap-3 flex-wrap">
                                    <label className="display-flex flex-row items-center gap-1 text-sm font-color-primary">
                                        <input
                                            type="checkbox"
                                            checked={reads}
                                            onChange={(e) => update(index, { supportsVision: e.target.checked, checkNote: undefined })}
                                        />
                                        {t('Reads figures')}
                                    </label>
                                    <Button
                                        variant="outline"
                                        style={{ padding: '2px 6px' }}
                                        rightIcon={BUTTON_ICON[state.status]}
                                        onClick={() => void check(index)}
                                        disabled={state.status === 'busy' || !row.id.trim() || !target.baseUrl}
                                        ariaLabel={t('Check whether {id} reads figures', { id: row.id })}
                                    >
                                        {t('Check')}
                                    </Button>
                                    <span className="flex-1" />
                                    {inUse ? (
                                        <span className="text-sm font-color-secondary">{t('In use')}</span>
                                    ) : (
                                        <Button
                                            variant="outline"
                                            style={{ padding: '2px 6px' }}
                                            onClick={() => onUse(row)}
                                            disabled={!row.id.trim()}
                                            ariaLabel={t('Use {id}', { id: row.id })}
                                        >
                                            {t('Use')}
                                        </Button>
                                    )}
                                </div>
                                {state.message ? <OutcomeLine outcome={state} /> : row.checkNote ? (
                                    <span className="text-sm font-color-secondary">{row.checkNote}</span>
                                ) : null}
                                <TuningFields
                                    row={row}
                                    defaults={tuningDefaults(row.providerId, row.id.trim())}
                                    fromPreset={!isCustomProviderId(row.providerId)}
                                    onChange={(patch) => update(index, patch)}
                                />
                            </div>
                        )}
                    </div>
                );
            })}
            <div>
                <Button
                    variant="ghost-secondary"
                    style={{ padding: '2px 6px' }}
                    rightIcon={PlusSignIcon}
                    onClick={() => onChange([...rows, { providerId: newRowProviderId, id: '', label: '' }])}
                    ariaLabel={t('Add model')}
                >
                    {t('Add model')}
                </Button>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Built-in vendor card
// ---------------------------------------------------------------------------

const rowsForVendor = (vendor: Vendor, overrides: ProviderOverrides): CatalogueRow[] =>
    vendor.providers.flatMap((entry) =>
        catalogueFor(entry.id, overrides).map((m) => {
            const tuning = overrides[entry.id]?.tuning?.[m.id];
            return {
                providerId: entry.id,
                id: m.id,
                label: m.label ?? '',
                ...(typeof m.supportsVision === 'boolean' ? { supportsVision: m.supportsVision } : {}),
                ...(tuning?.efforts ? { efforts: tuning.efforts } : {}),
                ...(tuning?.contextWindow ? { contextWindow: tuning.contextWindow } : {}),
                ...(tuning?.maxOutputTokens ? { maxOutputTokens: tuning.maxOutputTokens } : {}),
            };
        }),
    );

/** One provider's rows as its catalogue is stored. */
const catalogueOf = (rows: CatalogueRow[], providerId: string): CatalogueModel[] =>
    rows.filter((r) => r.providerId === providerId && r.id.trim()).map((r) => ({
        id: r.id.trim(),
        ...(r.label.trim() ? { label: r.label.trim() } : {}),
        ...(typeof r.supportsVision === 'boolean' ? { supportsVision: r.supportsVision } : {}),
    }));

const sameCatalogue = (a: CatalogueModel[], b: CatalogueModel[]) =>
    a.length === b.length && a.every((m, i) => m.id === b[i].id && (m.label ?? '') === (b[i].label ?? '') && m.supportsVision === b[i].supportsVision);

const sameTiers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((tier, i) => tier === b[i]);

/**
 * What a row sets that would not apply anyway, or null. Tiers and a window
 * that match the preset's are left out, so values a later version knows
 * better still reach the model. An output cap is kept as typed: setting one
 * also makes it the model's ceiling.
 */
function tuningToStore(row: CatalogueRow, defaults: TuningDefaults): ModelTuning | null {
    const out: ModelTuning = {
        ...(row.efforts && !sameTiers(row.efforts, defaults.efforts) ? { efforts: row.efforts } : {}),
        ...(row.contextWindow && row.contextWindow !== defaults.contextWindow ? { contextWindow: row.contextWindow } : {}),
        ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
    };
    return Object.keys(out).length > 0 ? out : null;
}

/** `rows`, each with the tuning the same model has in `from`. */
const keepTuning = (rows: CatalogueRow[], from: CatalogueRow[]): CatalogueRow[] =>
    rows.map((row) => {
        const was = from.find((r) => r.providerId === row.providerId && r.id.trim() === row.id);
        return was ? { ...row, efforts: was.efforts, contextWindow: was.contextWindow, maxOutputTokens: was.maxOutputTokens } : row;
    });

const BuiltinProviderCard: React.FC<{
    vendor: Vendor;
    editing: boolean;
    onEdit: () => void;
    onClose: () => void;
    current: { provider: string; model: string };
    onUsed: (provider: string, model: string) => void;
    onRemoved: () => void;
}> = ({ vendor, editing, onEdit, onClose, current, onUsed, onRemoved }) => {
    const refreshLocalModel = useSetAtom(refreshLocalModelAtom);
    const releaseRemovedProviders = useSetAtom(releaseRemovedProvidersAtom);
    const storedKey = readPref(vendor.keyPref);
    const primary = vendor.providers[0].id;
    const preset = PROVIDER_PRESETS[primary] as { baseUrl: string; label: string; authStyle?: 'bearer' | 'x-api-key' };

    const load = useCallback(() => {
        const overrides = readProviderOverrides();
        return {
            key: '',
            baseUrl: overrides[primary]?.baseUrl ?? '',
            rows: rowsForVendor(vendor, overrides),
        };
    }, [vendor, primary]);
    const [draft, setDraft] = useState(load);
    const [advanced, setAdvanced] = useState(false);
    const [test, setTest] = useState<Outcome>({ status: 'idle' });
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => { if (editing) { setDraft(load()); setTest({ status: 'idle' }); } }, [editing, load]);

    // An empty key field means "keep the stored key": the placeholder says so,
    // and clearing the field by accident must not erase a key some vendors
    // show only once. Removing a key is Remove's job.
    const newKey = draft.key.trim();
    const effectiveKey = newKey || storedKey;
    const target: CatalogueTarget = {
        baseUrl: draft.baseUrl.trim() || preset.baseUrl,
        apiKey: effectiveKey,
        authStyle: preset.authStyle,
        presetId: primary,
    };

    /** Keep a new key from the field; the rest of the draft waits for Save. */
    const keepNewKey = useCallback((key: string) => {
        if (!key || key === readPref(vendor.keyPref)) return;
        setPref(vendor.keyPref, key);
        refreshLocalModel();
    }, [vendor.keyPref, refreshLocalModel]);

    /*
     * A new key is kept when the card closes any way but Cancel: Edit on
     * another card, another Settings tab, the window closing. Everything else
     * on this page saves as it is typed, so a pasted key that vanished there
     * would read as saved and then turn out missing. The exception is a new
     * key whose Test failed while another key is stored: the stored one may be
     * the key that works, and some vendors show a key only once.
     */
    const draftKeyRef = useRef('');
    draftKeyRef.current = newKey;
    const failedKeyRef = useRef('');
    const cancelledRef = useRef(false);
    useEffect(() => {
        if (!editing) return;
        cancelledRef.current = false;
        failedKeyRef.current = '';
        return () => {
            abortRef.current?.abort();
            const key = draftKeyRef.current;
            const failedOverStored = key === failedKeyRef.current && !!readPref(vendor.keyPref);
            if (!cancelledRef.current && !failedOverStored) keepNewKey(key);
        };
    }, [editing, keepNewKey, vendor.keyPref]);
    const cancel = () => {
        cancelledRef.current = true;
        onClose();
    };

    // The Test asks the model that will actually answer: the one in use when
    // it is this vendor's, else the first in its catalogue — not the preset's
    // default, which may not even be listed.
    const inUseHere = vendor.providers.some((entry) => entry.id === current.provider) && current.model;
    const testProvider = inUseHere ? (current.provider as ProviderPresetId) : primary;
    const testModel = inUseHere ? current.model : (draft.rows.find((r) => r.providerId === primary && r.id.trim())?.id.trim() ?? '');

    // Tuning a model is not editing the list: the preset's list stays in force.
    const customised = vendor.providers.some((entry) => !sameCatalogue(catalogueOf(draft.rows, entry.id), defaultCatalogue(entry.id)));

    const save = () => {
        keepNewKey(newKey);
        const overrides = readProviderOverrides();
        for (const entry of vendor.providers) {
            const models = catalogueOf(draft.rows, entry.id);
            const tuning: Record<string, ModelTuning> = {};
            for (const row of draft.rows) {
                if (row.providerId !== entry.id || !row.id.trim()) continue;
                const kept = tuningToStore(row, tuningDefaults(entry.id, row.id.trim()));
                if (kept) tuning[row.id.trim()] = kept;
            }
            const next: ProviderOverride = { ...(overrides[entry.id] ?? {}) };
            if (sameCatalogue(models, defaultCatalogue(entry.id))) delete next.models;
            else next.models = models;
            if (Object.keys(tuning).length > 0) next.tuning = tuning;
            else delete next.tuning;
            if (draft.baseUrl.trim()) next.baseUrl = draft.baseUrl.trim();
            else delete next.baseUrl;
            if (Object.keys(next).length) overrides[entry.id] = next;
            else delete overrides[entry.id];
        }
        writeProviderOverrides(overrides);
        refreshLocalModel();
        onClose();
    };

    const runTest = async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const key = newKey;
        setTest({ status: 'busy' });
        const result = await verifyChatProvider(testProvider, effectiveKey, boundFetch as any, {
            signal: controller.signal,
            ...(testModel ? { model: testModel } : {}),
            ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
        });
        if (abortRef.current === controller) abortRef.current = null;
        const outcome = testOutcome(result, testModel, controller.signal.aborted);
        // A key that works is kept at once, whatever happens to the card next.
        if (result.ok && key) {
            keepNewKey(key);
            setDraft((d) => (d.key.trim() === key ? { ...d, key: '' } : d));
            outcome.message = `${outcome.message} ${t('The key is saved.')}`;
        }
        failedKeyRef.current = outcome.status === 'error' ? key : '';
        setTest(outcome);
    };

    const remove = () => {
        const ids = vendor.providers.map((entry) => entry.id);
        if (!confirmDialog(
            t('Remove this provider?'),
            t('Forget the {label} key and any catalogue edits on this computer? You can add it again later.', { label: t(vendor.label) })
                + removalConsequence(ids),
            t('Remove'),
        )) return;
        setPref(vendor.keyPref, '');
        const overrides = readProviderOverrides();
        for (const entry of vendor.providers) delete overrides[entry.id];
        writeProviderOverrides(overrides);
        releaseRemovedProviders(ids);
        onRemoved();
    };

    const use = (row: CatalogueRow) => {
        save();
        setPref('llmProvider', row.providerId);
        setPref('llmModel', row.id.trim());
        refreshLocalModel();
        onUsed(row.providerId, row.id.trim());
    };

    return (
        <div className="display-flex flex-col gap-2 p-2 border-quinary rounded-md" data-testid="provider-card" data-provider={vendor.id}>
            <CardHeader title={t(vendor.label)} badge={vendor.id} configured={!!storedKey} editing={editing} onEdit={onEdit} onRemove={remove} />
            {editing && (
                <div className="display-flex flex-col gap-2 mt-1">
                    <Field label={t('API key')}>
                        <div className="display-flex flex-row items-start gap-2">
                            <input
                                type="password"
                                value={draft.key}
                                onChange={(e) => { setDraft({ ...draft, key: e.target.value }); setTest({ status: 'idle' }); }}
                                placeholder={storedKey ? t('Configured — leave empty to keep it, or paste a new key') : t('Paste your key')}
                                className={`flex-1 p-1 m-0 preference-input text-sm ${test.status === 'error' ? 'border-error' : 'border-quinary'}`}
                                aria-label={t('{label} API key', { label: t(vendor.label) })}
                                aria-invalid={test.status === 'error'}
                            />
                            {vendor.keyUrl && (
                                <a
                                    href={vendor.keyUrl}
                                    onClick={(e) => { e.preventDefault(); Zotero.getActiveZoteroPane().loadURI(vendor.keyUrl!); }}
                                    className="font-color-secondary text-sm"
                                    style={{ alignSelf: 'center' }}
                                >
                                    {t('Get a key')}
                                </a>
                            )}
                            <Button
                                variant="outline"
                                style={{ padding: '3px 6px' }}
                                rightIcon={BUTTON_ICON[test.status]}
                                onClick={() => void runTest()}
                                disabled={test.status === 'busy' || !effectiveKey}
                                title={testModel ? t('Sends one short request to {testModel}', { testModel }) : undefined}
                            >
                                {test.status === 'ok' ? t('Works') : test.status === 'error' ? t('Failed') : t('Test')}
                            </Button>
                            {test.status === 'busy' && (
                                <Button
                                    variant="ghost-secondary"
                                    style={{ padding: '3px 6px' }}
                                    onClick={() => abortRef.current?.abort()}
                                    ariaLabel={t('Cancel the {label} test', { label: t(vendor.label) })}
                                >
                                    {t('Cancel')}
                                </Button>
                            )}
                        </div>
                        <OutcomeLine outcome={test} />
                        {vendor.note && <Hint>{t(vendor.note)}</Hint>}
                    </Field>

                    <button
                        type="button"
                        className="bg-transparent border-none p-0 text-sm font-color-secondary text-left cursor-pointer display-flex flex-row items-center gap-1"
                        onClick={() => setAdvanced((v) => !v)}
                        aria-expanded={advanced}
                    >
                        <Icon icon={advanced ? ArrowDownIcon : ArrowRightIcon} className="scale-90" />
                        {t('Custom settings')}
                    </button>

                    {advanced && (
                        <div className="display-flex flex-col gap-2 pl-2 border-left-quinary">
                            <Field label={t('API address')}>
                                <input
                                    type="text"
                                    value={draft.baseUrl}
                                    onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                                    placeholder={preset.baseUrl}
                                    className="p-1 m-0 preference-input text-sm"
                                    aria-label={t('{label} API address', { label: t(vendor.label) })}
                                />
                            </Field>
                            <CatalogueEditor
                                rows={draft.rows}
                                onChange={(rows) => setDraft({ ...draft, rows })}
                                target={target}
                                newRowProviderId={primary}
                                defaultVision={(row) => presetSupportsVision(row.providerId as ProviderPresetId, row.id) === true}
                                customised={customised}
                                onRestoreDefaults={() => setDraft({ ...draft, rows: keepTuning(rowsForVendor(vendor, {}), draft.rows) })}
                                current={current}
                                onUse={use}
                            />
                        </div>
                    )}

                    <div className="display-flex flex-row items-center justify-end gap-2 mt-1">
                        <Button variant="outline" style={{ padding: '3px 10px' }} onClick={cancel} ariaLabel={t('Cancel editing {label}', { label: t(vendor.label) })}>
                            {t('Cancel')}
                        </Button>
                        <Button variant="solid" style={{ padding: '3px 10px' }} onClick={save} ariaLabel={t('Save {label}', { label: t(vendor.label) })}>
                            {t('Save')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Custom endpoint card
// ---------------------------------------------------------------------------

const toRows = (endpoint: CustomEndpoint): CatalogueRow[] =>
    endpoint.models.map((m) => ({
        providerId: customProviderId(endpoint.id),
        id: m.id,
        label: m.label ?? '',
        supportsVision: m.supportsVision,
        efforts: customModelTiers(m),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxOutputTokens: m.maxTokens } : {}),
        ...(m.visionChecked ? { checkNote: describeVerdict({ seesImages: m.visionChecked.seesImages, checkedAt: m.visionChecked.at, detail: m.visionChecked.detail }) } : {}),
    }));

const fromRows = (rows: CatalogueRow[], previous: CustomEndpointModel[]): CustomEndpointModel[] =>
    rows.filter((r) => r.id.trim()).map((r) => {
        const before = previous.find((m) => m.id === r.id.trim());
        const efforts = r.efforts ?? [];
        return {
            id: r.id.trim(),
            ...(r.label.trim() ? { label: r.label.trim() } : {}),
            supportsVision: r.supportsVision === true,
            reasoningEffort: efforts.length > 0,
            efforts,
            ...(r.contextWindow ? { contextWindow: r.contextWindow } : {}),
            ...(r.maxOutputTokens ? { maxTokens: r.maxOutputTokens } : {}),
            ...(r.checkNote && before?.visionChecked && before.supportsVision === r.supportsVision ? { visionChecked: before.visionChecked } : {}),
        };
    });

const CustomProviderCard: React.FC<{
    endpoint: CustomEndpoint;
    isNew?: boolean;
    editing: boolean;
    onEdit: () => void;
    onClose: () => void;
    onSaved: (endpoint: CustomEndpoint) => void;
    onDeleted: () => void;
    current: { provider: string; model: string };
    onUsed: (provider: string, model: string) => void;
}> = ({ endpoint, isNew = false, editing, onEdit, onClose, onSaved, onDeleted, current, onUsed }) => {
    const refreshLocalModel = useSetAtom(refreshLocalModelAtom);
    const releaseRemovedProviders = useSetAtom(releaseRemovedProvidersAtom);
    const [draft, setDraft] = useState(() => ({ ...endpoint, rows: toRows(endpoint) }));
    const [test, setTest] = useState<Outcome>({ status: 'idle' });
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => { if (editing) { setDraft({ ...endpoint, rows: toRows(endpoint) }); setTest({ status: 'idle' }); } }, [editing, endpoint]);
    // A Test still running when the card closes has no one left to report to.
    useEffect(() => (editing ? () => abortRef.current?.abort() : undefined), [editing]);

    /*
     * The id this endpoint is filed under now, read again whenever the card
     * writes: a model choice synced from another computer can rename it while
     * the card is on screen (see adoptSyncedEndpointId), and a write under the
     * old id would add a second copy or delete nothing.
     */
    const liveId = () => currentEndpointId(endpoint.id);
    const providerId = customProviderId(liveId());
    const target: CatalogueTarget = {
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        authStyle: draft.authStyle,
        wireFormat: draft.wireFormat ?? 'openai',
    };
    // The model in use when it is this endpoint's, else its first model.
    const testModel = current.provider === providerId && draft.rows.some((r) => r.id.trim() === current.model)
        ? current.model
        : (draft.rows.find((r) => r.id.trim())?.id.trim() ?? '');

    const toEndpoint = (): CustomEndpoint => ({
        id: liveId(),
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
        apiKey: draft.apiKey.trim(),
        authStyle: draft.authStyle,
        ...(draft.wireFormat === 'openai-responses' ? { wireFormat: 'openai-responses' as const } : {}),
        models: fromRows(draft.rows, endpoint.models),
    });

    const save = (): CustomEndpoint => {
        const next = toEndpoint();
        const all = readCustomEndpoints();
        const index = all.findIndex((e) => e.id === next.id);
        if (index >= 0) all[index] = next;
        else all.push(next);
        writeCustomEndpoints(all);
        refreshLocalModel();
        onSaved(next);
        return next;
    };

    const runTest = async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setTest({ status: 'busy' });
        const result = await verifyCustomEndpoint(toEndpoint(), testModel, boundFetch as any, { signal: controller.signal });
        if (abortRef.current === controller) abortRef.current = null;
        setTest(testOutcome(result, testModel, controller.signal.aborted));
    };

    const remove = () => {
        const label = endpoint.name || endpoint.baseUrl || t('this provider');
        const id = liveId();
        if (!isNew && !confirmDialog(
            t('Delete this provider?'),
            tn(endpoint.models.length,
                'Delete {label} and the {count} model under it? Its key is forgotten with it.',
                'Delete {label} and the {count} models under it? Its key is forgotten with it.',
                { label }) + removalConsequence([customProviderId(id)]),
            t('Delete'),
        )) return;
        writeCustomEndpoints(readCustomEndpoints().filter((e) => e.id !== id));
        releaseRemovedProviders([customProviderId(id)]);
        onDeleted();
    };

    const use = (row: CatalogueRow) => {
        const saved = save();
        const provider = customProviderId(saved.id);
        setPref('llmProvider', provider);
        setPref('llmModel', row.id.trim());
        refreshLocalModel();
        onUsed(provider, row.id.trim());
    };

    return (
        <div className="display-flex flex-col gap-2 p-2 border-quinary rounded-md" data-testid="provider-card" data-provider={providerId}>
            <CardHeader
                title={endpoint.name || endpoint.baseUrl || t('New provider')}
                badge="custom"
                configured={!!endpoint.baseUrl}
                editing={editing}
                onEdit={onEdit}
                onRemove={remove}
                removeLabel={t('Delete')}
            />
            {editing && (
                <div className="display-flex flex-col gap-2 mt-1">
                    <Field label={t('Name')}>
                        <input
                            type="text"
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            placeholder={t('e.g. My proxy')}
                            className="p-1 m-0 preference-input text-sm"
                            aria-label={t('Provider name')}
                        />
                    </Field>
                    <Field label={t('API address')}>
                        <input
                            type="text"
                            value={draft.baseUrl}
                            onChange={(e) => { setDraft({ ...draft, baseUrl: e.target.value }); setTest({ status: 'idle' }); }}
                            placeholder="https://api.example.com/v1"
                            className="p-1 m-0 preference-input text-sm"
                            aria-label={t('Provider API address')}
                        />
                    </Field>
                    <Field label={t('API format')}>
                        <select
                            value={draft.wireFormat === 'openai-responses' ? 'openai-responses' : 'openai'}
                            onChange={(e) => {
                                setDraft({ ...draft, wireFormat: e.target.value === 'openai-responses' ? 'openai-responses' : undefined });
                                setTest({ status: 'idle' });
                            }}
                            className="p-1 m-0 preference-input text-sm"
                            aria-label={t('API format')}
                        >
                            <option value="openai">{t('Chat Completions (/chat/completions)')}</option>
                            <option value="openai-responses">{t('Responses (/responses)')}</option>
                        </select>
                        <Hint>
                            {t('Most compatible servers speak Chat Completions. Responses is OpenAI\'s newer API: choose it when the server offers it and the model should think while it uses tools.')}
                        </Hint>
                    </Field>
                    <Field label={t('API key')}>
                        <div className="display-flex flex-row items-start gap-2">
                            <input
                                type="password"
                                value={draft.apiKey}
                                onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value }); setTest({ status: 'idle' }); }}
                                placeholder={t('Leave empty for a server that takes none')}
                                className={`flex-1 p-1 m-0 preference-input text-sm ${test.status === 'error' ? 'border-error' : 'border-quinary'}`}
                                aria-label={t('Provider API key')}
                            />
                            <select
                                value={draft.authStyle}
                                onChange={(e) => setDraft({ ...draft, authStyle: e.target.value === 'x-api-key' ? 'x-api-key' : 'bearer' })}
                                className="p-1 m-0 preference-input text-sm"
                                aria-label={t('How the key is sent')}
                            >
                                <option value="bearer">{t('Bearer token')}</option>
                                <option value="x-api-key">{t('X-Api-Key header')}</option>
                            </select>
                            <Button
                                variant="outline"
                                style={{ padding: '3px 6px' }}
                                rightIcon={BUTTON_ICON[test.status]}
                                onClick={() => void runTest()}
                                disabled={test.status === 'busy' || !draft.baseUrl.trim() || !testModel}
                                title={testModel ? t('Sends one short request to {testModel}', { testModel }) : t('Add a model first')}
                            >
                                {test.status === 'ok' ? t('Works') : test.status === 'error' ? t('Failed') : t('Test')}
                            </Button>
                            {test.status === 'busy' && (
                                <Button
                                    variant="ghost-secondary"
                                    style={{ padding: '3px 6px' }}
                                    onClick={() => abortRef.current?.abort()}
                                    ariaLabel={t('Cancel the test')}
                                >
                                    {t('Cancel')}
                                </Button>
                            )}
                        </div>
                        <OutcomeLine outcome={test} />
                    </Field>
                    <CatalogueEditor
                        rows={draft.rows}
                        onChange={(rows) => setDraft({ ...draft, rows })}
                        target={target}
                        newRowProviderId={providerId}
                        defaultVision={() => false}
                        current={current}
                        onUse={use}
                    />
                    <div className="display-flex flex-row items-center justify-end gap-2 mt-1">
                        <Button variant="outline" style={{ padding: '3px 10px' }} onClick={isNew ? remove : onClose} ariaLabel={t('Cancel editing provider')}>
                            {t('Cancel')}
                        </Button>
                        <Button variant="solid" style={{ padding: '3px 10px' }} onClick={() => { save(); onClose(); }} ariaLabel={t('Save provider')}>
                            {t('Save')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// Ollama card: a server on this computer, no key, models detected not typed
// ---------------------------------------------------------------------------

const OllamaProviderCard: React.FC<{
    editing: boolean;
    onEdit: () => void;
    onClose: () => void;
    onModels: (models: string[]) => void;
    onRemoved: () => void;
}> = ({ editing, onEdit, onClose, onModels, onRemoved }) => {
    const refreshLocalModel = useSetAtom(refreshLocalModelAtom);
    const releaseRemovedProviders = useSetAtom(releaseRemovedProvidersAtom);
    const [base, setBase] = useState(() => ollamaBaseUrlFromPrefs());
    // Chat models, the ones the picker lists; embedding-only models are shown
    // apart, as what indexing uses.
    const [models, setModels] = useState<string[]>(() => ollamaModelsFromPrefs());
    const [indexing, setIndexing] = useState<string[]>([]);
    const [capabilities, setCapabilities] = useState<Record<string, string[]>>({});
    // Bumped by a Reads figures switch, so the rows re-read what is stored.
    const [, bumpVision] = useState(0);
    const [test, setTest] = useState<Outcome>({ status: 'idle' });
    const onModelsRef = useRef(onModels);
    onModelsRef.current = onModels;

    // Every fresh read of this server (Detect models here, the guide below, a
    // download finishing) updates the lists.
    const root = normalizeOllamaBase(base);
    useEffect(() => onOllamaStatus((server, status: OllamaStatus) => {
        if (server !== root || !status.running) return;
        const caps = status.capabilities ?? {};
        const chat = status.models.filter((tag) => !isOllamaEmbeddingModel(tag, caps[tag]));
        setModels(chat);
        setIndexing(status.models.filter((tag) => !chat.includes(tag)));
        setCapabilities(caps);
        onModelsRef.current(chat);
    }), [root]);

    const detect = async () => {
        setTest({ status: 'busy' });
        const status = await refreshOllamaStatus(root, boundFetch as any);
        if (!status.running) {
            const raw = status.error ?? '';
            setTest({
                status: 'error',
                message: /abort/i.test(raw)
                    ? t('No answer from {address} within 4 s. Is Ollama running?', { address: root })
                    : t('Could not reach Ollama at {address}. Is it running? ({error})', { address: root, error: raw.slice(0, 80) }),
            });
            return;
        }
        const caps = status.capabilities ?? {};
        const chat = status.models.filter((tag) => !isOllamaEmbeddingModel(tag, caps[tag]));
        const embedding = status.models.filter((tag) => !chat.includes(tag));
        setTest({
            status: chat.length > 0 ? 'ok' : 'error',
            message: chat.length > 0
                ? tn(chat.length, 'Found {count} chat model: {models}', 'Found {count} chat models: {models}', { models: chat.join(', ') })
                    + (embedding.length > 0 ? ' · ' + t('used for indexing: {models}', { models: embedding.join(', ') }) : '')
                : embedding.length > 0
                    ? t('Ollama has only {models}, which is used for indexing and cannot chat — download a chat model below.', { models: embedding.join(', ') })
                    : t('Ollama is running but has no models yet — download one below.'),
        });
    };

    const setReadsFigures = (model: string, reads: boolean) => {
        setOllamaModelVision(model, reads);
        bumpVision((n) => n + 1);
        refreshLocalModel();
    };

    const remove = () => {
        if (!confirmDialog(
            t('Remove Ollama?'),
            t('Forget the detected models on this computer? Ollama itself is not touched; you can add it again later.')
                + removalConsequence(['ollama']),
            t('Remove'),
        )) return;
        setPref('ollamaModels', '[]');
        releaseRemovedProviders(['ollama']);
        onRemoved();
    };

    const overrides = readProviderOverrides();

    return (
        <div className="display-flex flex-col gap-2 p-2 border-quinary rounded-md" data-testid="provider-card" data-provider="ollama">
            <CardHeader title={t('Ollama (local)')} badge="ollama" configured={models.length > 0} editing={editing} onEdit={onEdit} onRemove={remove} />
            {editing && (
                <div className="display-flex flex-col gap-2 mt-1">
                    <Field label={t('Address')}>
                        <div className="display-flex flex-row items-start gap-2">
                            <input
                                id="alphain-ollama-base"
                                type="text"
                                value={base}
                                onChange={(e) => { setBase(e.target.value); setPref('ollamaBaseUrl', e.target.value.trim()); setTest({ status: 'idle' }); }}
                                placeholder="http://127.0.0.1:11434"
                                className={`flex-1 p-1 m-0 preference-input text-sm ${test.status === 'error' ? 'border-error' : 'border-quinary'}`}
                                aria-label={t('Ollama address')}
                                aria-invalid={test.status === 'error'}
                            />
                            <Button
                                variant="outline"
                                style={{ padding: '3px 6px' }}
                                rightIcon={BUTTON_ICON[test.status]}
                                onClick={() => void detect()}
                                disabled={test.status === 'busy'}
                            >
                                {test.status === 'ok' ? t('Found') : test.status === 'error' ? t('Retry') : t('Detect models')}
                            </Button>
                        </div>
                        <OutcomeLine outcome={test} />
                    </Field>
                    {(models.length > 0 || indexing.length > 0) && (
                        <Field label={t('Installed models')}>
                            <div className="display-flex flex-col gap-1" data-testid="ollama-models">
                                {models.map((model) => {
                                    const reads = ollamaModelVision(model, overrides) === true;
                                    const saysVision = capabilities[model]?.includes('vision') === true;
                                    return (
                                        <div key={model} className="display-flex flex-row items-center gap-2 flex-wrap text-sm">
                                            <code className="font-color-primary">{model}</code>
                                            <span className="flex-1" />
                                            {saysVision && !reads && (
                                                <span className="font-color-tertiary">{t('Ollama says it reads images')}</span>
                                            )}
                                            <label className="display-flex flex-row items-center gap-1 font-color-primary">
                                                <input
                                                    type="checkbox"
                                                    checked={reads}
                                                    onChange={(e) => setReadsFigures(model, e.target.checked)}
                                                    aria-label={t('{model} reads figures', { model })}
                                                />
                                                {t('Reads figures')}
                                            </label>
                                        </div>
                                    );
                                })}
                                {indexing.map((model) => (
                                    <div key={model} className="display-flex flex-row items-center gap-2 text-sm">
                                        <code className="font-color-secondary">{model}</code>
                                        <span className="font-color-tertiary">{t('used for indexing, not for chat')}</span>
                                    </div>
                                ))}
                            </div>
                        </Field>
                    )}
                    <Hint>
                        {t('No key, and nothing leaves your computer. Models are sent text only unless they are marked “Reads figures”; mark one only if it really reads images, since a model that does not is sent pictures it cannot see. Below: whether Ollama is running, and the models this plugin can use — each downloads with one click.')}
                    </Hint>
                    <OllamaGuide base={base} showChat showEmbedding />
                    <div className="display-flex flex-row items-center justify-end gap-2 mt-1">
                        <Button variant="solid" style={{ padding: '3px 10px' }} onClick={onClose} ariaLabel={t('Done editing Ollama')}>
                            {t('Done')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** A request, from elsewhere on the page, to open one vendor's card. */
export interface OpenCardRequest {
    vendorId: string;
    /** Changes with every request, so asking twice opens the card twice. */
    nonce: number;
}

const ProviderCards: React.FC<{ openRequest?: OpenCardRequest | null }> = ({ openRequest = null }) => {
    /*
     * The global address older versions kept moves onto the provider it
     * redirects before any card reads its address, so the card shows the
     * address its requests really go to — and its Test uses it — from the
     * moment Settings opens, not only after the next question.
     */
    const [legacyBaseUrl, setLegacyBaseUrl] = useState(() => {
        migrateLegacyBaseUrl();
        return readPref('llmBaseUrl');
    });
    // Bumped after every save and remove, so the list of configured vendors is
    // re-read from the preferences the cards just wrote.
    const [keysVersion, bumpKeys] = useState(0);
    const configuredVendors = useMemo(
        () => (keysVersion >= 0 ? VENDORS.filter((v) => !!readPref(v.keyPref)) : []),
        [keysVersion],
    );
    const [added, setAdded] = useState<string[]>([]);
    const [endpoints, setEndpoints] = useState<CustomEndpoint[]>(() => readCustomEndpoints());
    const [newEndpoint, setNewEndpoint] = useState<CustomEndpoint | null>(null);
    const [ollamaShown, setOllamaShown] = useState(() => ollamaModelsFromPrefs().length > 0);
    const [editing, setEditing] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [current, setCurrent] = useState(() => ({ provider: readPref('llmProvider'), model: readPref('llmModel') }));
    const listRef = useRef<HTMLDivElement>(null);

    /*
     * Keys, endpoints and the model in use also change from outside this list:
     * the composer's picker, the wizard, settings sync, a card removed while
     * another was open. Follow them whenever the model list is rebuilt — except
     * under a card being edited, whose draft would be reset.
     */
    const availableModels = useAtomValue(availableModelsAtom);
    useEffect(() => {
        setCurrent({ provider: readPref('llmProvider'), model: readPref('llmModel') });
        if (ollamaModelsFromPrefs().length > 0) setOllamaShown(true);
        if (editing) return;
        setEndpoints(readCustomEndpoints());
        bumpKeys((n) => n + 1);
        // `editing` is read here, not followed: closing a card re-reads on its own.
    }, [availableModels]);

    // Another part of the page asked for a vendor's card: open it, adding it
    // to the list when it has no key yet, and bring it into view.
    const [scrollTo, setScrollTo] = useState<string | null>(null);
    useEffect(() => {
        if (!openRequest) return;
        setAdded((a) => (a.includes(openRequest.vendorId) ? a : [...a, openRequest.vendorId]));
        setEditing(openRequest.vendorId);
        setScrollTo(openRequest.vendorId);
    }, [openRequest]);
    useEffect(() => {
        if (!scrollTo) return;
        const card = listRef.current?.querySelector(`[data-provider="${scrollTo}"]`) as HTMLElement | null;
        card?.scrollIntoView?.({ block: 'center' });
        (card?.querySelector('input[type="password"]') as HTMLInputElement | null)?.focus?.();
        setScrollTo(null);
    }, [scrollTo]);

    const shownVendors = VENDORS.filter((v) => configuredVendors.includes(v) || added.includes(v.id));
    const addable = VENDORS.filter((v) => !shownVendors.includes(v));
    const anyCard = shownVendors.length > 0 || ollamaShown || endpoints.length > 0 || newEndpoint;

    const close = () => { setEditing(null); bumpKeys((n) => n + 1); };
    const used = (provider: string, model: string) => { setCurrent({ provider, model }); bumpKeys((n) => n + 1); };

    return (
        <>
            <SectionHeader>{t('Providers')}</SectionHeader>
            <SectionDescription>
                {t('Where the models come from. Each provider holds a key and a catalogue of models; every model in a catalogue appears in the picker under the provider\'s name. Add the ones you use — a built-in vendor, or any OpenAI-compatible endpoint of your own.')}
            </SectionDescription>
            <SettingsGroup>
                <div className="display-flex flex-col gap-2 p-3" data-testid="provider-cards" ref={listRef}>
                    {!anyCard && <Hint>{t('No providers yet. Add one below and paste its key.')}</Hint>}
                    {legacyBaseUrl && (
                        <div className="display-flex flex-row items-start gap-2" data-testid="legacy-base-url">
                            <Hint>
                                {tr('An API address set in an earlier version is still stored: {address}. The next built-in provider you use sends its requests there instead of to its own address. Clear it unless that is what you want.', {
                                    address: <code>{legacyBaseUrl}</code>,
                                })}
                            </Hint>
                            <Button
                                variant="outline"
                                style={{ padding: '2px 8px' }}
                                onClick={() => { setPref('llmBaseUrl', ''); setLegacyBaseUrl(''); }}
                                ariaLabel={t('Clear the stored address')}
                            >
                                {t('Clear')}
                            </Button>
                        </div>
                    )}
                    {shownVendors.map((vendor) => (
                        <BuiltinProviderCard
                            key={vendor.id}
                            vendor={vendor}
                            editing={editing === vendor.id}
                            onEdit={() => setEditing(vendor.id)}
                            onClose={() => { close(); setAdded((a) => a.filter((id) => id !== vendor.id || !!readPref(vendor.keyPref))); }}
                            current={current}
                            onUsed={used}
                            onRemoved={() => { setAdded((a) => a.filter((id) => id !== vendor.id)); close(); }}
                        />
                    ))}
                    {ollamaShown && (
                        <OllamaProviderCard
                            editing={editing === 'ollama'}
                            onEdit={() => setEditing('ollama')}
                            onClose={close}
                            onModels={() => bumpKeys((n) => n + 1)}
                            onRemoved={() => { setOllamaShown(false); close(); }}
                        />
                    )}
                    {endpoints.map((endpoint) => (
                        <CustomProviderCard
                            key={endpoint.id}
                            endpoint={endpoint}
                            editing={editing === customProviderId(endpoint.id)}
                            onEdit={() => setEditing(customProviderId(endpoint.id))}
                            onClose={close}
                            onSaved={() => setEndpoints(readCustomEndpoints())}
                            onDeleted={() => { setEndpoints(readCustomEndpoints()); close(); }}
                            current={current}
                            onUsed={used}
                        />
                    ))}
                    {newEndpoint && (
                        <CustomProviderCard
                            key={newEndpoint.id}
                            endpoint={newEndpoint}
                            isNew
                            editing
                            onEdit={() => undefined}
                            onClose={() => { setNewEndpoint(null); setEndpoints(readCustomEndpoints()); close(); }}
                            onSaved={() => setEndpoints(readCustomEndpoints())}
                            onDeleted={() => { setNewEndpoint(null); setEndpoints(readCustomEndpoints()); close(); }}
                            current={current}
                            onUsed={used}
                        />
                    )}

                    <div className="display-flex flex-row items-center gap-2 flex-wrap mt-1">
                        <Button
                            variant="outline"
                            style={{ padding: '3px 8px' }}
                            rightIcon={PlusSignIcon}
                            onClick={() => setAdding((v) => !v)}
                            disabled={addable.length === 0 && ollamaShown}
                            ariaLabel={t('Add provider')}
                        >
                            {t('Add provider')}
                        </Button>
                        <Button
                            variant="outline"
                            style={{ padding: '3px 8px' }}
                            rightIcon={PlusSignIcon}
                            onClick={() => {
                                const endpoint: CustomEndpoint = { id: newEndpointId(), name: '', baseUrl: '', apiKey: '', authStyle: 'bearer', models: [] };
                                setNewEndpoint(endpoint);
                                setEditing(customProviderId(endpoint.id));
                                setAdding(false);
                            }}
                            disabled={!!newEndpoint}
                            ariaLabel={t('Add custom provider')}
                        >
                            {t('Add custom provider')}
                        </Button>
                    </div>
                    {adding && (
                        <div className="display-flex flex-row items-center gap-2 flex-wrap" data-testid="add-provider-menu">
                            {addable.map((vendor) => (
                                <Button
                                    key={vendor.id}
                                    variant="ghost-secondary"
                                    style={{ padding: '2px 8px' }}
                                    onClick={() => { setAdded((a) => [...a, vendor.id]); setEditing(vendor.id); setAdding(false); }}
                                    ariaLabel={t('Add {label}', { label: t(vendor.label) })}
                                >
                                    {t(vendor.label)}
                                </Button>
                            ))}
                            {!ollamaShown && (
                                <Button
                                    variant="ghost-secondary"
                                    style={{ padding: '2px 8px' }}
                                    onClick={() => { setOllamaShown(true); setEditing('ollama'); setAdding(false); }}
                                    ariaLabel={t('Add Ollama (local)')}
                                >
                                    {t('Ollama (local)')}
                                </Button>
                            )}
                        </div>
                    )}
                    <Hint>
                        {t('Keys, addresses and catalogues stay on this computer. With settings sync on, the choice of model travels to your other computers and the keys do not, so each computer needs its own. Keys are kept as plain text in Zotero\'s preferences: anyone who can read your Zotero profile folder can read them.')}
                    </Hint>
                </div>
            </SettingsGroup>
        </>
    );
};

export default ProviderCards;
