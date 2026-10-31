// @vitest-environment jsdom

/**
 * Both indexes act on what the readiness watcher hears.
 *
 * - The full-text sweep runs a few seconds after the embedding provider
 *   becomes usable, which is also what resumes a run paused on it.
 * - The titles-and-abstracts index, asleep because the provider could not be
 *   used, starts when it can — and a running one is not restarted by news
 *   that changes nothing for it.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
/*
 * `available` is what the shared probe last found (semanticSearchState);
 * `probe`, when set, is what the next probe finds — the two differ when
 * Ollama goes down or comes back between looks.
 */
const state = vi.hoisted(() => ({ available: false, probe: undefined as boolean | undefined, provider: 'openai', store: null as any }));
const calls = vi.hoisted(() => ({ start: 0, refresh: 0, indexers: 0, passes: 0 }));

vi.mock('../../../react/store', () => ({ get store() { return state.store; } }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom: makeAtom } = await import('jotai');
    return { searchableLibraryIdsAtom: makeAtom([1]) };
});
vi.mock('../../../react/atoms/fulltextIndex', async () => {
    const { atom: makeAtom } = await import('jotai');
    const fulltextIndexStateAtom = makeAtom({ status: 'idle', indexed: 0, library: 0 });
    return {
        fulltextIndexStateAtom,
        refreshFulltextCoverageAtom: makeAtom(null, (_get: any, set: any) => {
            calls.refresh += 1;
            set(fulltextIndexStateAtom, { status: 'idle', indexed: 0, library: 3 });
        }),
        startFulltextIndexAtom: makeAtom(null, () => { calls.start += 1; }),
    };
});
vi.mock('../../../src/services/llm/agentConfig', () => ({
    isSemanticSearchAvailable: () => state.available,
    refreshSemanticSearchAvailability: async () => {
        if (state.probe !== undefined) state.available = state.probe;
        return state.available;
    },
    resetSemanticSearchProbe: () => undefined,
    semanticSearchState: () => (state.available
        ? { status: 'ready', provider: state.provider }
        : state.provider === 'ollama'
            ? { status: 'unreachable', provider: 'ollama', reason: 'Ollama is not running on this computer' }
            : { status: 'needs_key', provider: state.provider, label: 'OpenAI' }),
    keyPrefForProvider: (id: string) => ({ openai: 'llmKeyOpenai', ollama: null } as any)[id],
    embeddingKeyPrefs: (id: string) => ({ openai: ['llmKeyOpenai'], google: ['embeddingKeyGoogle', 'llmKeyGoogle'], ollama: [] } as any)[id] ?? [],
}));
vi.mock('../../../src/services/embeddingIndexer', () => ({
    EmbeddingIndexer: class {
        constructor() { calls.indexers += 1; }
        cleanupUnsyncedLibraries = async () => {
            calls.passes += 1;
            return { librariesRemoved: 0, embeddingsRemoved: 0 };
        };
        shouldRunFullDiff = async () => ({ needsDiff: false, reason: 'unchanged' });
        getItemsReadyForRetry = async () => [];
        getFailedStats = async () => ({ totalFailed: 0, readyForRetry: 0, permanentlyFailed: 0 });
    },
    MIN_CONTENT_LENGTH: 10,
    INDEX_BATCH_SIZE: 10,
    mergeIndexingErrors: () => undefined,
}));
vi.mock('@beaver/agent-core/transport/clients/embeddingsService', () => ({
    embeddingsService: { reportIndexingComplete: async () => undefined },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { useEmbeddingIndex } from '../../../react/hooks/useEmbeddingIndex';
import { useFulltextIndex } from '../../../react/hooks/useFulltextIndex';
import { fulltextIndexStateAtom } from '../../../react/atoms/fulltextIndex';
import { publishOllamaStatus } from '../../../react/utils/ollama';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let observers: Map<string, Array<() => void>>;

async function mount(hook: () => void) {
    const Probe = () => { hook(); return null; };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(Provider, { store: state.store }, React.createElement(Probe)));
    });
}

/** A preference changed: run what observes it. */
const changed = (key: string) => {
    for (const callback of observers.get(`${PREFIX}.${key}`) ?? []) callback();
};

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    state.store = createStore();
    state.available = false;
    state.probe = undefined;
    state.provider = 'openai';
    calls.start = 0;
    calls.refresh = 0;
    calls.indexers = 0;
    calls.passes = 0;
    observers = new Map();
    (Zotero.Prefs.registerObserver as any).mockImplementation((key: string, callback: () => void) => {
        observers.set(key, [...(observers.get(key) ?? []), callback]);
        return Symbol(key);
    });
    (Zotero as any).AlphainZ = { db: {} };
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
    delete (Zotero as any).AlphainZ;
});

describe('the full-text sweep', () => {
    it('runs soon after the key the embedding provider needs is pasted', async () => {
        await mount(useFulltextIndex);
        state.available = true;
        await act(async () => { changed('llmKeyOpenai'); });
        await wait(3_000);
        expect(calls.refresh).toBe(1);
        expect(calls.start).toBe(1);
    });

    it('resumes a run that paused on an Ollama that stopped, once it answers again', async () => {
        state.provider = 'ollama';
        state.available = true;
        await mount(useFulltextIndex);
        await wait(20_000);
        expect(calls.start).toBe(1);

        // That run paused, and its fresh look at Ollama found it down.
        state.available = false;
        await act(async () => {
            state.store.set(fulltextIndexStateAtom, {
                status: 'idle', indexed: 0, library: 3,
                paused: 'Indexing paused: Ollama embeddings could not be reached. It picks up where it stopped on the next pass.',
            } as any);
        });
        // A question asked a moment later finds it answering again.
        state.available = true;
        await wait(40_000);
        await wait(4_000);
        expect(calls.start).toBe(2);
    });
});

describe('the titles-and-abstracts index', () => {
    it('wakes when a provider it could not use becomes usable', async () => {
        await mount(useEmbeddingIndex);
        await wait(1_000);
        expect(calls.indexers).toBe(0);

        state.available = true;
        await act(async () => { changed('llmKeyOpenai'); });
        await wait(1_000);
        expect(calls.indexers).toBe(1);
    });

    it('is not restarted by news that changes nothing for a running index, but is by another provider', async () => {
        state.available = true;
        state.provider = 'ollama';
        await mount(useEmbeddingIndex);
        await wait(1_000);
        expect(calls.indexers).toBe(1);

        await act(async () => {
            publishOllamaStatus('http://127.0.0.1:11434', { running: true, version: '0.12.0', models: ['bge-m3:latest'] });
        });
        await wait(1_000);
        expect(calls.indexers).toBe(1);

        await act(async () => { changed('embeddingProvider'); });
        await wait(1_000);
        expect(calls.indexers).toBe(2);
    });

    it('wakes within a minute of Ollama answering, even when a question found it answering first', async () => {
        // Its first pass finds Ollama not answering yet.
        state.provider = 'ollama';
        state.available = true;
        state.probe = false;
        await mount(useEmbeddingIndex);
        await wait(1_000);
        expect(calls.passes).toBe(0);

        // A question asked meanwhile finds Ollama answering: the shared probe says ready.
        state.probe = true;
        state.available = true;
        await wait(60_000);
        await wait(1_000);
        expect(calls.passes).toBe(1);
    });
});
