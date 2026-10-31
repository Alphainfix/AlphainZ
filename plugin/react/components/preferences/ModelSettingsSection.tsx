/**
 * Where the user points AlphainZ at a model.
 *
 * Ordered the way the task actually runs: paste the keys you have, then pick a
 * model from what those keys unlock. The earlier version asked for a provider
 * first and then a key, which meant choosing from a list of eight where seven
 * were unusable — a menu of things that will not work is worse than a shorter
 * menu.
 *
 * Everything is stored in Zotero preferences and read back by `agentConfig.ts`.
 * There is no account and nothing is sent anywhere except to the endpoint the
 * key belongs to.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { ProgressBar } from '../status/ProgressBar';
import {
    AlertIcon,
    ArrowRightIcon,
    Icon,
    InformationCircleIcon,
    Spinner,
    TickIcon,
} from '../icons/icons';

import { getPref, setPref } from '../../../src/utils/prefs';
import { EMBEDDING_PRESETS } from '../../../src/services/llm/embeddings';
import { PROVIDER_PRESETS, retireChoice } from '../../../src/services/llm/openAICompatible';
import { verifyEmbeddingProvider } from '../../../src/services/llm/verifyKey';
import { OpenAlexClient, OpenAlexRequestError } from '../../../src/services/literature/openalex';
import {
    currentEmbeddingModelId,
    embeddingKeyFor,
    ollamaApiBaseUrl,
    ollamaBaseUrlFromPrefs,
    semanticSearchState,
} from '../../../src/services/llm/agentConfig';
import { clearEmbeddingHealth } from '../../../src/services/llm/embeddingHealth';
import { failureTimeText, useEmbeddingHealth } from '../../hooks/useEmbeddingHealth';
import {
    pageImageIndexStateAtom,
    pageImageProvider,
    refreshPageImageCoverageAtom,
    startPageImageIndexAtom,
    stopPageImageIndexAtom,
} from '../../atoms/pageImageIndex';
import { onOllamaStatus } from '../../utils/ollama';
import { OllamaGuide } from './OllamaGuide';
import ProviderCards, { type OpenCardRequest } from './ProviderCards';
import { forceReindexAtom } from '../../atoms/embeddingIndex';
import { availableModelsAtom, refreshLocalModelAtom } from '../../atoms/models';
import {
    embeddingProviderProblem,
    fulltextIndexStateAtom,
    refreshFulltextCoverageAtom,
    startFulltextIndexAtom,
    stopFulltextIndexAtom,
} from '../../atoms/fulltextIndex';
import { SectionDescription, SectionHeader, SectionLabel, SettingsGroup } from './components/SettingsElements';

// ---------------------------------------------------------------------------
// Vendors and the providers they unlock
// ---------------------------------------------------------------------------

export { VENDORS, type Vendor, type KeyPrefName, type ProviderId } from './vendors';
import { VENDORS, type KeyPrefName, type ProviderId, type Vendor } from './vendors';

export const EMBEDDING_OPTIONS: Array<{ id: '' | keyof typeof EMBEDDING_PRESETS; label: string; keyPref?: KeyPrefName }> = [
    { id: '', label: 'Off — keyword search only' },
    { id: 'openai', label: 'OpenAI', keyPref: 'llmKeyOpenai' },
    { id: 'google', label: 'Google Gemini · online', keyPref: 'llmKeyGoogle' },
    { id: 'ollama', label: 'Ollama · EmbeddingGemma 2, on this computer' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PrefName =
    | 'llmProvider'
    | 'llmModel'
    | 'llmBaseUrl'
    | 'embeddingProvider'
    | 'embeddingKeyGoogle'
    | KeyPrefName;

function readPref(key: PrefName): string {
    const value = getPref(key);
    return typeof value === 'string' ? value.trim() : '';
}

/** `fetch` bound to its global — see the note in agentConfig. */
const boundFetch = ((url: string, init?: any) => fetch(url, init)) as any;

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
interface TestState {
    status: TestStatus;
    message?: string;
}

const TEST_BUTTON = {
    idle: { text: 'Test', icon: ArrowRightIcon },
    testing: { text: 'Test', icon: Spinner },
    ok: { text: 'Works', icon: TickIcon },
    error: { text: 'Failed', icon: AlertIcon },
} as const;

const isIndexingFulltext = (status: string) => status === 'counting' || status === 'indexing';

/** Each reason documents failed for, once, with how many: the most common first. */
function failureReasons(failures: Array<{ message: string }>): Array<{ message: string; count: number }> {
    const counts = new Map<string, number>();
    for (const { message } of failures) counts.set(message, (counts.get(message) ?? 0) + 1);
    return [...counts].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
}

const asSentence = (message: string) => {
    const text = message.charAt(0).toUpperCase() + message.slice(1);
    return /[.!?]$/.test(text) ? text : `${text}.`;
};

const formatIndexBytes = (bytes: number) =>
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;

const TestResult: React.FC<{ state: TestState }> = ({ state }) =>
    state.message ? (
        <span
            className={`text-sm ${state.status === 'error' ? 'font-color-error' : 'font-color-secondary'}`}
            role={state.status === 'error' ? 'alert' : undefined}
        >
            {state.message}
        </span>
    ) : null;

const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="text-sm font-color-secondary display-flex flex-row items-start gap-1">
        <Icon icon={InformationCircleIcon} className="scale-90 mt-015 font-color-secondary" />
        <span>{children}</span>
    </div>
);

/** Whether an OpenAlex failure means the key was refused, from the status it answered with. */
function openAlexRejectedKey(error: unknown): boolean {
    const status = error instanceof OpenAlexRequestError || (error as { name?: unknown } | null)?.name === 'OpenAlexRequestError'
        ? (error as OpenAlexRequestError).status
        : undefined;
    return status === 401 || status === 403;
}

/** The vendor whose key an embedding option uses, for "Add the key". */
const vendorForKey = (keyPref: KeyPrefName | undefined): Vendor | undefined =>
    keyPref ? VENDORS.find((vendor) => vendor.keyPref === keyPref) : undefined;

/** A model the user can actually select: a provider plus one of its models. */
interface ModelChoice {
    /** `provider::model`, the value carried by the dropdown. */
    value: string;
    label: string;
    provider: string;
    model: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ModelSettingsSection: React.FC = () => {
    const refreshLocalModel = useSetAtom(refreshLocalModelAtom);
    const availableModels = useAtomValue(availableModelsAtom);
    const fulltext = useAtomValue(fulltextIndexStateAtom);
    const startFulltext = useSetAtom(startFulltextIndexAtom);
    const stopFulltext = useSetAtom(stopFulltextIndexAtom);
    const refreshCoverage = useSetAtom(refreshFulltextCoverageAtom);
    const forceReindex = useSetAtom(forceReindexAtom);
    const pageImages = useAtomValue(pageImageIndexStateAtom);
    const startPageImages = useSetAtom(startPageImageIndexAtom);
    const stopPageImages = useSetAtom(stopPageImageIndexAtom);
    const refreshPageImages = useSetAtom(refreshPageImageCoverageAtom);
    const [pageImagesAuto, setPageImagesAuto] = useState(() => getPref('pageImageIndexAuto') !== false);

    // What each embedding model has stored here, so an index that is no longer
    // wanted can be dropped to free space.
    const [storedIndexes, setStoredIndexes] = useState<Array<{ model_id: string; items: number; chunks: number; images?: number; bytes: number }>>([]);
    const refreshStoredIndexes = useCallback(async () => {
        const db = (Zotero as any).AlphainZ?.db;
        if (!db?.listEmbeddingModels) return;
        try {
            setStoredIndexes(await db.listEmbeddingModels());
        } catch {
            // Leave the previous list; the next refresh will try again.
        }
    }, []);
    const deleteStoredIndex = useCallback(async (modelId: string, label: string, active: boolean) => {
        const db = (Zotero as any).AlphainZ?.db;
        if (!db?.deleteEmbeddingsForModel) return;
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: 'Delete this index?',
            text:
                `Delete the ${label} index? Its vectors are removed from this computer only.\n\n` +
                (active
                    ? 'This is the model in use, so the index will be rebuilt from scratch — that costs time (and, for a cloud model, its quota).'
                    : 'Switching back to this model later will rebuild it.'),
            button0: 'Delete',
            button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;
        await db.deleteEmbeddingsForModel(modelId);
        await refreshStoredIndexes();
        await refreshCoverage();
        if (active) {
            forceReindex();
            if (getPref('fulltextIndexAuto') !== false) void startFulltext();
        }
    }, [refreshStoredIndexes, refreshCoverage, forceReindex, startFulltext]);

    const [provider, setProvider] = useState(() => readPref('llmProvider'));
    const [model, setModel] = useState(() => readPref('llmModel'));
    const [fulltextAuto, setFulltextAuto] = useState(() => getPref('fulltextIndexAuto') !== false);
    const [embeddingProvider, setEmbeddingProvider] = useState(() => readPref('embeddingProvider'));
    const [autoComment, setAutoComment] = useState(() => getPref('selectionChatAutoComment') === true);
    const [embeddingTest, setEmbeddingTest] = useState<TestState>({ status: 'idle' });
    const [googleEmbeddingKey, setGoogleEmbeddingKey] = useState(() => readPref('embeddingKeyGoogle'));
    const embeddingHealth = useEmbeddingHealth();
    const [openalexKey, setOpenalexKey] = useState(() => {
        const stored = getPref('openalexApiKey');
        return typeof stored === 'string' ? stored.trim() : '';
    });
    const [openalexTest, setOpenalexTest] = useState<TestState>({ status: 'idle' });
    const [cardRequest, setCardRequest] = useState<OpenCardRequest | null>(null);

    /*
     * Whether the chosen embedding provider can be used, read at render. It
     * changes with the keys (which rebuild the model list, re-rendering this
     * panel) and with what Ollama has: every fresh read of Ollama re-renders.
     */
    const [, bumpOllamaReads] = useState(0);
    useEffect(() => onOllamaStatus(() => bumpOllamaReads((n) => n + 1)), []);
    const semantic = semanticSearchState();
    const embeddingReady = semantic.status === 'ready';

    // Counted when the panel opens, whenever the provider changes — vectors
    // from different models are not comparable, so switching provider means a
    // different index and a different coverage number — and when the chosen
    // provider becomes usable.
    useEffect(() => {
        if (embeddingProvider) void refreshCoverage();
        if (embeddingProvider) void refreshPageImages();
        void refreshStoredIndexes();
    }, [embeddingProvider, embeddingReady, refreshCoverage, refreshPageImages, refreshStoredIndexes]);

    // The pair the runner reads can change under this panel — a Use button on a
    // provider card, the picker in the composer — so it is re-read whenever the
    // list it is drawn from changes.
    useEffect(() => {
        setProvider(readPref('llmProvider'));
        setModel(readPref('llmModel'));
    }, [availableModels]);

    /**
     * Every model the configured providers offer — the same list the composer's
     * picker shows, so the two cannot disagree.
     */
    const choices = useMemo<ModelChoice[]>(
        () => availableModels
            .filter((entry) => entry.id.startsWith('local-') && entry.snapshot)
            .map((entry) => ({
                value: `${String(entry.provider)}::${entry.snapshot}`,
                label: entry.name,
                provider: String(entry.provider),
                model: entry.snapshot,
            })),
        [availableModels],
    );

    // A stored pair naming a retired provider or model is shown as its
    // successor — the same resolution the composer applies — so this select and
    // the sidebar's picker highlight the same row.
    const resolved = retireChoice(provider, model);
    const currentValue = resolved.provider ? `${resolved.provider}::${resolved.model}` : '';
    // A stored model that is not in the list (a new release, or a key since
    // removed) is still offered, so opening this panel cannot silently change
    // which model is in use.
    const showsCurrent = !currentValue || choices.some((c) => c.value === currentValue);

    const handleOpenalexKeyChange = useCallback((value: string) => {
        setOpenalexKey(value);
        setPref('openalexApiKey', value.trim());
        setOpenalexTest({ status: 'idle' });
    }, []);

    const testOpenalexKey = useCallback(async () => {
        setOpenalexTest({ status: 'testing' });
        try {
            const client = new OpenAlexClient(boundFetch, { apiKey: openalexKey.trim() });
            const started = Date.now();
            await client.search('test', { perPage: 1 });
            setOpenalexTest({ status: 'ok', message: `Connected in ${Date.now() - started} ms.` });
        } catch (error) {
            // Decided from the status OpenAlex answered with, never from the
            // text, which can hold any digits.
            const raw = error instanceof Error ? error.message : String(error);
            setOpenalexTest({
                status: 'error',
                message: openAlexRejectedKey(error)
                    ? 'The key was rejected. Check that you copied all of it.'
                    : raw.slice(0, 200),
            });
        }
    }, [openalexKey]);

    const applyModel = useCallback(
        (value: string) => {
            const [nextProvider, nextModel] = value.split('::');
            setProvider(nextProvider ?? '');
            setModel(nextModel ?? '');
            setPref('llmProvider', nextProvider ?? '');
            setPref('llmModel', nextModel ?? '');
            refreshLocalModel();
        },
        [refreshLocalModel],
    );

    const runEmbeddingTest = useCallback(async () => {
        if (!embeddingProvider) return;
        const option = EMBEDDING_OPTIONS.find((o) => o.id === embeddingProvider);
        const id = embeddingProvider as keyof typeof EMBEDDING_PRESETS;
        const key = embeddingKeyFor(id);
        if (option?.keyPref && !key) {
            // Nothing to send: the key lives on the provider's card above.
            setEmbeddingTest({
                status: 'error',
                message: id === 'google'
                    ? 'This computer has no Google key yet. Add it on the Google Gemini card above, or below.'
                    : `This computer has no ${option.label} key yet. Add it under Providers, above.`,
            });
            return;
        }
        setEmbeddingTest({ status: 'testing' });
        const result = await verifyEmbeddingProvider(
            embeddingProvider as keyof typeof EMBEDDING_PRESETS,
            key,
            boundFetch,
            // Ollama is tested at the address on its card, where the index
            // will send its requests, not at the default local port.
            embeddingProvider === 'ollama' ? { baseUrl: ollamaApiBaseUrl() } : {},
        );
        setEmbeddingTest({ status: result.ok ? 'ok' : 'error', message: result.message });
        // A test that went through is a request that worked: whatever failed
        // before is no longer the state of things.
        if (result.ok) clearEmbeddingHealth();
    }, [embeddingProvider]);

    const embeddingButton = TEST_BUTTON[embeddingTest.status];

    const isIndexing = fulltext.status === 'counting' || fulltext.status === 'indexing';
    const remainingDocs = Math.max(0, fulltext.library - fulltext.indexed);
    // Coverage, not pass progress — the same figure the toolbar shows. While a
    // pass runs, the documents it has finished count as indexed already.
    const coveredNow = isIndexingFulltext(fulltext.status)
        ? Math.max(fulltext.indexed, fulltext.library - Math.max(0, fulltext.total - fulltext.done))
        : fulltext.indexed;
    const fulltextPercent =
        fulltext.library > 0 ? Math.round(Math.min(100, (coveredNow / fulltext.library) * 100)) : 0;
    const fulltextCoverage = !fulltext.counted
        ? 'Counting the PDFs in your libraries…'
        : fulltext.library + fulltext.skipped === 0
            ? 'No PDFs found in the libraries you have enabled.'
            : `${coveredNow} of ${fulltext.library} PDFs indexed${isIndexingFulltext(fulltext.status) && fulltext.total > 0
                ? ` · this pass: ${fulltext.done}/${fulltext.total}`
                : ''}.`;
    // PDFs that could not be read this session, and why, when the last run said.
    const unreadable = fulltext.skipped || fulltext.failed;
    // Figures still to render, leaving out the PDFs that could not be rendered
    // this session: pressing Index again would only fail them again.
    const imagesRemaining = Math.max(0, pageImages.library - pageImages.indexed - pageImages.skipped);
    const imageFailureReasons = failureReasons(pageImages.failures);

    // What stands in the way of the chosen embedding provider, and the way
    // past it when it is a key this computer lacks.
    const embeddingProblem = embeddingProvider ? embeddingProviderProblem(semantic) : null;
    const keyVendor = semantic.status === 'needs_key'
        ? vendorForKey(EMBEDDING_OPTIONS.find((o) => o.id === semantic.provider)?.keyPref)
        : undefined;
    const optionLabel = (option: (typeof EMBEDDING_OPTIONS)[number]) =>
        option.id && option.keyPref && !embeddingKeyFor(option.id) ? `${option.label} — no key on this computer yet` : option.label;

    return (
        <>
            <ProviderCards openRequest={cardRequest} />

            <SectionLabel>Literature search</SectionLabel>
            <SettingsGroup>
                <div className="display-flex flex-col gap-1 p-3">
                    <div className="display-flex flex-row items-center gap-2">
                        <label
                            htmlFor="alphain-key-openalex"
                            className="text-base font-semibold font-color-primary"
                        >
                            OpenAlex
                        </label>
                        <a
                            href="https://openalex.org/settings/api"
                            onClick={(e) => {
                                e.preventDefault();
                                Zotero.getActiveZoteroPane().loadURI('https://openalex.org/settings/api');
                            }}
                            className="font-color-secondary text-sm"
                        >
                            Get a key
                        </a>
                    </div>
                    <div className="display-flex flex-row items-start gap-2">
                        <input
                            id="alphain-key-openalex"
                            type="password"
                            value={openalexKey}
                            onChange={(e) => handleOpenalexKeyChange(e.target.value)}
                            placeholder="Paste your key"
                            className={`flex-1 p-1 m-0 preference-input text-sm ${
                                openalexTest.status === 'error' ? 'border-error' : 'border-quinary'
                            }`}
                            aria-invalid={openalexTest.status === 'error'}
                        />
                        <Button
                            variant="outline"
                            style={{ padding: '3px 6px' }}
                            rightIcon={TEST_BUTTON[openalexTest.status].icon}
                            onClick={() => void testOpenalexKey()}
                            disabled={openalexTest.status === 'testing' || !openalexKey.trim()}
                        >
                            {TEST_BUTTON[openalexTest.status].text}
                        </Button>
                    </div>
                    <TestResult state={openalexTest} />
                    <Note>
                        Literature search (OpenAlex) — a free key, made in 30 seconds. OpenAlex
                        requires one from February 2026; without it, searches are rate-limited
                        whenever their servers are busy.
                    </Note>
                </div>
            </SettingsGroup>

            <SectionLabel>Model</SectionLabel>
            <SectionDescription>
                The model the sidebar uses. Every model in a provider's catalogue is listed; the
                picker in the composer changes the same setting.
            </SectionDescription>

            <SettingsGroup>
                <div className="display-flex flex-col gap-2 p-3">
                    <select
                        id="alphain-model"
                        value={currentValue}
                        onChange={(e) => applyModel(e.target.value)}
                        className="p-1 m-0 preference-input text-sm"
                        aria-label="Model"
                    >
                        <option value="">Choose a model…</option>
                        {!showsCurrent && (
                            <option value={currentValue}>{`${provider} · ${model} (stored)`}</option>
                        )}
                        {choices.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                                {choice.label}
                            </option>
                        ))}
                    </select>

                    {choices.length === 0 && (
                        <Note>
                            No models are listed because no provider is configured yet. Add one above
                            and its catalogue appears here.
                        </Note>
                    )}
                </div>
            </SettingsGroup>

            <SectionLabel>Highlight questions</SectionLabel>
            <SectionDescription>
                Questions asked from the reader's selection popup use the model the sidebar is
                set to, so changing the model in the sidebar changes it for them too.
            </SectionDescription>

            <SettingsGroup>
                <div className="display-flex flex-col gap-2 p-3">
                    <label className="display-flex flex-row items-center gap-2 text-sm font-color-primary">
                        <input
                            type="checkbox"
                            checked={autoComment}
                            onChange={(e) => {
                                setAutoComment(e.target.checked);
                                setPref('selectionChatAutoComment', e.target.checked);
                            }}
                        />
                        Save answers into the highlight's comment without asking
                    </label>
                    <Note>
                        Answers are appended to the highlight's own Zotero comment, so they show up
                        when you click the highlight and travel with your library.
                    </Note>
                </div>
            </SettingsGroup>

            <SectionLabel>Topic and full-text search</SectionLabel>
            <SectionDescription>
                Searching your library by meaning needs an embedding provider. Leave it off and the
                agent is told so, instead of reading an empty result as proof your library holds
                nothing on the subject. This is the deeper of the two indexes — the one that reads
                inside your PDFs. Titles and abstracts are handled separately, under Search.
            </SectionDescription>

            <SettingsGroup>
                <div className="display-flex flex-col gap-2 p-3">
                    <select
                        id="alphain-embedding-provider"
                        value={embeddingProvider}
                        onChange={(e) => {
                            setEmbeddingProvider(e.target.value);
                            setPref('embeddingProvider', e.target.value);
                            setEmbeddingTest({ status: 'idle' });
                        }}
                        className="p-1 m-0 preference-input text-sm"
                        aria-label="Embedding provider"
                    >
                        {EMBEDDING_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                                {optionLabel(option)}
                            </option>
                        ))}
                    </select>

                    {embeddingProblem && (
                        <div className="display-flex flex-row items-center gap-2 flex-wrap" role="status" data-testid="embedding-problem">
                            <span className="text-sm font-color-yellow">
                                {embeddingProblem} Until then nothing is indexed and topic search is off; keyword
                                search still works. Indexing starts by itself once that is fixed.
                            </span>
                            {keyVendor && (
                                <Button
                                    variant="outline"
                                    style={{ padding: '3px 6px' }}
                                    onClick={() => setCardRequest({ vendorId: keyVendor.id, nonce: Date.now() })}
                                >
                                    {`Add the ${keyVendor.label} key`}
                                </Button>
                            )}
                        </div>
                    )}

                    {/* Configured, but the last request failed: said here until one succeeds. */}
                    {embeddingReady && embeddingHealth && (
                        <div className="display-flex flex-row items-start gap-1" role="status" data-testid="embedding-health">
                            <Icon icon={AlertIcon} className="scale-90 mt-015 font-color-yellow flex-shrink-0" />
                            <span className="text-sm font-color-yellow">
                                {`Not working since ${failureTimeText(embeddingHealth.failedAt)}: ${embeddingHealth.reason} `}
                                Topic search falls back to titles meanwhile. This clears by itself once a request
                                goes through — Test checks now.
                            </span>
                        </div>
                    )}

                    {embeddingProvider === 'google' && (
                        <div className="display-flex flex-col gap-1">
                            <label htmlFor="alphain-key-embedding-google" className="text-sm font-color-primary">
                                Key for embeddings (optional)
                            </label>
                            <input
                                id="alphain-key-embedding-google"
                                type="password"
                                value={googleEmbeddingKey}
                                onChange={(e) => {
                                    setGoogleEmbeddingKey(e.target.value);
                                    setPref('embeddingKeyGoogle', e.target.value.trim());
                                    setEmbeddingTest({ status: 'idle' });
                                }}
                                placeholder={readPref('llmKeyGoogle') ? 'Empty: the Google Gemini card’s key is used' : 'Paste a Google AI Studio key'}
                                className="p-1 m-0 preference-input text-sm border-quinary"
                            />
                            <Note>
                                {googleEmbeddingKey.trim()
                                    ? 'Embeddings use this key; chat keeps the Google Gemini card’s.'
                                    : 'Embeddings use the Google Gemini card’s key. A key here is used for topic and '
                                        + 'full-text search only, and wins over the card’s.'}
                                {' '}Gemini Embedding 2. A key from a project with no billing is free but allows
                                about 100 texts a minute and 1000 a day, and Google may use what it is sent to
                                improve its products; when Google reports the free tier, indexing keeps a fifth of
                                each for your searches. A paid key costs about $1 per 20,000 passages.
                            </Note>
                        </div>
                    )}

                    {embeddingProvider && (
                        <>
                            {semantic.status !== 'needs_key' && (
                                <div className="display-flex flex-row items-center gap-2">
                                    <Button
                                        variant="outline"
                                        style={{ padding: '3px 6px' }}
                                        rightIcon={embeddingButton.icon}
                                        onClick={runEmbeddingTest}
                                        disabled={embeddingTest.status === 'testing'}
                                    >
                                        {embeddingButton.text}
                                    </Button>
                                    <TestResult state={embeddingTest} />
                                </div>
                            )}
                            <Note>
                                Each model keeps its own index. Switching starts filling the new
                                model’s index in the background and leaves the previous one in
                                place, so switching back is instant.
                            </Note>
                            {embeddingProvider === 'ollama' && (
                                <OllamaGuide
                                    base={ollamaBaseUrlFromPrefs()}
                                    showEmbedding
                                    compact
                                    onModelsChanged={() => setEmbeddingTest({ status: 'idle' })}
                                />
                            )}
                            {storedIndexes.length > 0 && (
                                <div className="display-flex flex-col gap-1 mt-2 pt-2 border-top-quinary">
                                    <div className="text-base font-semibold font-color-primary">Stored indexes</div>
                                    {storedIndexes.map((index) => {
                                        const active = index.model_id === currentEmbeddingModelId();
                                        const label = Object.values(EMBEDDING_PRESETS).find((p) => p.model === index.model_id)?.label;
                                        return (
                                            <div key={index.model_id} className="display-flex flex-row items-center gap-2 text-sm">
                                                <span className="font-color-primary">
                                                    {label ? `${label} · ` : ''}<code>{index.model_id}</code>
                                                    {active ? <span className="font-color-green"> · in use</span> : null}
                                                </span>
                                                <span className="font-color-tertiary">
                                                    {`${index.items} items · ${index.chunks.toLocaleString()} passages · `
                                                        + `${index.images ? `${index.images.toLocaleString()} page images · ` : ''}${formatIndexBytes(index.bytes)}`}
                                                </span>
                                                <div className="flex-1" />
                                                <Button
                                                    variant="ghost-secondary"
                                                    style={{ padding: '1px 6px' }}
                                                    onClick={() => void deleteStoredIndex(index.model_id, label ?? index.model_id, active)}
                                                >
                                                    Delete
                                                </Button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
<div className="display-flex flex-col gap-2 mt-2 pt-2 border-top-quinary">
                                <div className="text-base font-semibold font-color-primary">
                                    Full text of your PDFs
                                </div>
                                <div className="text-sm font-color-secondary" data-testid="fulltext-coverage">
                                    {embeddingReady
                                        ? fulltextCoverage
                                        : 'Not indexed while the embedding provider cannot be used (see above).'}
                                </div>

                                <label className="display-flex flex-row items-center gap-2 text-sm font-color-primary">
                                    <input
                                        type="checkbox"
                                        checked={fulltextAuto}
                                        onChange={() => {
                                            const next = !fulltextAuto;
                                            setFulltextAuto(next);
                                            setPref('fulltextIndexAuto', next);
                                        }}
                                    />
                                    Keep this up to date by itself
                                </label>

                                {embeddingReady && isIndexing && (
                                    <>
                                        <ProgressBar progress={fulltextPercent} />
                                        <div className="text-sm font-color-tertiary truncate">
                                            {fulltext.current ?? 'Preparing…'}
                                        </div>
                                    </>
                                )}

                                {embeddingReady && (isIndexing || fulltext.counted) && (
                                    <div className="display-flex flex-row items-center gap-2 flex-wrap">
                                        {isIndexing ? (
                                            <Button
                                                variant="outline"
                                                style={{ padding: '3px 6px' }}
                                                onClick={() => stopFulltext()}
                                            >
                                                Stop
                                            </Button>
                                        ) : (remainingDocs > 0 || fulltext.skipped === 0) && (
                                            <Button
                                                variant="outline"
                                                style={{ padding: '3px 6px' }}
                                                onClick={() => void startFulltext()}
                                                disabled={remainingDocs === 0}
                                            >
                                                {remainingDocs > 0
                                                    ? `Index ${remainingDocs} document${remainingDocs === 1 ? '' : 's'}`
                                                    : 'Everything is indexed'}
                                            </Button>
                                        )}
                                        {!isIndexing && fulltext.skipped > 0 && (
                                            <Button
                                                variant="outline"
                                                style={{ padding: '3px 6px' }}
                                                onClick={() => void startFulltext({ retryFailed: true })}
                                            >
                                                {`Retry the ${fulltext.skipped} that could not be read`}
                                            </Button>
                                        )}
                                    </div>
                                )}
                                {embeddingReady && fulltext.paused && (
                                    <span className="text-sm font-color-yellow" role="status">
                                        {fulltext.paused}
                                    </span>
                                )}
                                {embeddingReady && unreadable > 0 && (
                                    <span
                                        className="text-sm font-color-error"
                                        // A bare count cannot be acted on. The
                                        // first reason usually explains the rest.
                                        title={fulltext.failures
                                            .map((f) => `${f.title}: ${f.message}`)
                                            .join('\n')}
                                    >
                                        {`${unreadable} could not be read`}
                                        {fulltext.failures[0]
                                            ? ` — ${fulltext.failures[0].message}`
                                            : ' this session; they are left out until Zotero restarts or you retry them.'}
                                    </span>
                                )}
                                {fulltext.error && (
                                    <span className="text-sm font-color-error" role="alert">
                                        {fulltext.error}
                                    </span>
                                )}

                                <Note>
                                    Searching inside papers needs each one embedded page by page,
                                    which costs about as much as everything else here put together.
                                    Left on, it runs a little after launch and again a few seconds
                                    after you add papers, reading only the papers not indexed yet — so
                                    a paper you add today becomes searchable without you doing
                                    anything. It stops when you ask and picks up where it left off.
                                    Until it finishes, a full-text search says how much of your
                                    library it actually looked at.
                                </Note>
                            </div>

                            <div className="display-flex flex-col gap-2 mt-2 pt-2 border-top-quinary" data-testid="page-image-index">
                                <div className="text-base font-semibold font-color-primary">
                                    Figures in your PDFs
                                </div>
                                {!embeddingReady ? (
                                    <div className="text-sm font-color-secondary">
                                        Not indexed while the embedding provider cannot be used (see above).
                                    </div>
                                ) : !pageImageProvider() ? (
                                    <div className="text-sm font-color-secondary">
                                        Finding a figure by describing it needs an embedding model that also reads
                                        pictures: Google Gemini or Ollama (EmbeddingGemma 2). OpenAI embeds text
                                        only.
                                    </div>
                                ) : (
                                    <>
                                        <div className="text-sm font-color-secondary">
                                            {pageImages.status === 'indexing'
                                                ? `Rendering pages · this pass: ${pageImages.done}/${pageImages.total} PDFs`
                                                : pageImages.counted
                                                    ? `${pageImages.indexed} of ${pageImages.library} PDFs indexed as pictures · ${pageImages.pages.toLocaleString()} pages.`
                                                    : 'Counting…'}
                                        </div>
                                        <label className="display-flex flex-row items-center gap-2 text-sm font-color-primary">
                                            <input
                                                type="checkbox"
                                                checked={pageImagesAuto}
                                                onChange={() => {
                                                    const next = !pageImagesAuto;
                                                    setPageImagesAuto(next);
                                                    setPref('pageImageIndexAuto', next);
                                                }}
                                            />
                                            Index every page as a picture too, after the full text
                                        </label>
                                        {pageImages.status === 'indexing' && (
                                            <>
                                                <ProgressBar
                                                    progress={pageImages.total > 0 ? Math.round((pageImages.done / pageImages.total) * 100) : 0}
                                                />
                                                <div className="text-sm font-color-tertiary truncate">
                                                    {pageImages.current ?? 'Preparing…'}
                                                </div>
                                            </>
                                        )}
                                        <div className="display-flex flex-row items-center gap-2 flex-wrap">
                                            {pageImages.status === 'indexing' ? (
                                                <Button variant="outline" style={{ padding: '3px 6px' }} onClick={() => stopPageImages()}>
                                                    Stop
                                                </Button>
                                            ) : (
                                                <>
                                                    {(imagesRemaining > 0 || pageImages.skipped === 0) && (
                                                        <Button
                                                            variant="outline"
                                                            style={{ padding: '3px 6px' }}
                                                            onClick={() => void startPageImages()}
                                                            disabled={pageImages.counted && imagesRemaining === 0}
                                                        >
                                                            {pageImages.counted && imagesRemaining === 0
                                                                ? 'Every PDF is indexed'
                                                                : `Index ${imagesRemaining} PDF${imagesRemaining === 1 ? '' : 's'}`}
                                                        </Button>
                                                    )}
                                                    {pageImages.skipped > 0 && (
                                                        <Button
                                                            variant="outline"
                                                            style={{ padding: '3px 6px' }}
                                                            onClick={() => void startPageImages({ retryFailed: true })}
                                                        >
                                                            {`Retry the ${pageImages.skipped} that could not be rendered`}
                                                        </Button>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                        {pageImages.skipped > 0 && pageImages.status !== 'indexing' && (
                                            <div className="display-flex flex-col gap-1 text-sm" data-testid="page-image-failures">
                                                <span className="font-color-error">
                                                    {`${pageImages.skipped} could not be rendered on this computer`}
                                                    {imageFailureReasons.length === 1
                                                        ? ` — ${asSentence(imageFailureReasons[0].message)}`
                                                        : ':'}
                                                </span>
                                                {imageFailureReasons.length > 1 && imageFailureReasons.map(({ message, count }) => (
                                                    <span key={message} className="font-color-error">
                                                        {`${count} — ${asSentence(message)}`}
                                                    </span>
                                                ))}
                                                <details>
                                                    <summary className="font-color-secondary cursor-pointer">
                                                        {pageImages.skipped === 1 ? 'Which PDF' : `Which ${pageImages.skipped} PDFs`}
                                                    </summary>
                                                    <div className="display-flex flex-col gap-1 mt-1 ml-4">
                                                        {pageImages.failures.map((failure, index) => (
                                                            <span key={index} className="font-color-secondary">{failure.title}</span>
                                                        ))}
                                                    </div>
                                                </details>
                                            </div>
                                        )}
                                        {pageImages.paused && (
                                            <span className="text-sm font-color-yellow" role="status">{pageImages.paused}</span>
                                        )}
                                        {pageImages.stopped && pageImages.status !== 'indexing' && !pageImages.paused && (
                                            <span className="text-sm font-color-secondary" role="status">
                                                Stopped. It does not start again by itself until you press Index or restart Zotero.
                                            </span>
                                        )}
                                        {pageImages.error && (
                                            <span className="text-sm font-color-error" role="alert">{pageImages.error}</span>
                                        )}
                                        <Note>
                                            Each page is rendered as a picture and turned into one vector — the picture
                                            itself is not kept — so the agent can find a figure by what it shows, then
                                            look at the page before answering. The text always goes first: search works
                                            while pages are still being added, and a paper added meanwhile is read for
                                            its words before its pages. Google charges about $0.12 per 1,000 pages;
                                            EmbeddingGemma 2 runs here, free.
                                        </Note>
                                    </>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </SettingsGroup>
        </>
    );
};

export default ModelSettingsSection;
