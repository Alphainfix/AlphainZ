/**
 * Fixing the embedding provider starts indexing without a restart.
 *
 * The indexes used to re-run only when the embedding provider preference
 * itself changed. Pasting the vendor's key, downloading the embedding model or starting
 * Ollama changed nothing they listened to, so the index stayed unbuilt until
 * Zotero restarted. The watcher reports each of those.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};
let observers: Map<string, Array<() => void>>;

const setPref = (key: string, value: unknown) => {
    prefs[`${PREFIX}.${key}`] = value;
    for (const callback of observers.get(`${PREFIX}.${key}`) ?? []) callback();
};

/** An Ollama whose installed models the test decides. */
let ollamaModels: string[] | null;

beforeEach(() => {
    vi.resetModules();
    prefs = {};
    observers = new Map();
    ollamaModels = null;
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    (Zotero.Prefs.registerObserver as any).mockImplementation((key: string, callback: () => void) => {
        observers.set(key, [...(observers.get(key) ?? []), callback]);
        return Symbol(key);
    });
    (Zotero.Prefs.unregisterObserver as any).mockClear();
    (globalThis as any).fetch = vi.fn(async (url: string) => {
        if (ollamaModels === null) throw new Error('ECONNREFUSED');
        if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: ollamaModels!.map((name) => ({ name })) }) };
        if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version: '0.12.0' }) };
        return { ok: false, status: 404, json: async () => ({}) };
    });
});
afterEach(() => {
    vi.useRealTimers();
});

const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function watch() {
    const { subscribeSemanticSearchChanges } = await import('../../../react/hooks/useEmbeddingIndex');
    const heard: string[] = [];
    const stop = subscribeSemanticSearchChanges((change) => heard.push(change));
    return { heard, stop };
}

describe('the readiness watcher', () => {
    it('reports a provider that became usable when its key is pasted here', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'openai';
        const { heard, stop } = await watch();

        setPref('llmKeyOpenai', 'k');
        await settle();
        expect(heard).toEqual(['became-ready']);
        stop();
    });

    it('ignores a key the chosen provider does not use', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'google';
        const { heard, stop } = await watch();
        setPref('llmKeyOpenai', 'k');
        await settle();
        expect(heard).toEqual([]);
        stop();
    });

    it('reports a replaced key, which is what resumes a run paused on a rejected one', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'openai';
        prefs[`${PREFIX}.llmKeyOpenai`] = 'old';
        const { heard, stop } = await watch();
        setPref('llmKeyOpenai', 'new');
        await settle();
        expect(heard).toEqual(['key-changed']);
        stop();
    });

    it('reports the embedding model arriving, once a guide or a finished download has read Ollama', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        ollamaModels = ['qwen2.5:7b'];
        const agentConfig = await import('../../../src/services/llm/agentConfig');
        agentConfig.resetSemanticSearchProbe();
        expect(await agentConfig.refreshSemanticSearchAvailability()).toBe(false);
        const { heard, stop } = await watch();

        ollamaModels = ['qwen2.5:7b', 'embeddinggemma-2:440m-q8_0-text-vision'];
        const { refreshOllamaStatus } = await import('../../../react/components/preferences/OllamaGuide');
        await refreshOllamaStatus('http://127.0.0.1:11434');
        await settle();
        expect(heard).toEqual(['became-ready']);
        expect(agentConfig.semanticSearchState().status).toBe('ready');
        stop();
    });

    it('ignores news about Ollama when embeddings do not use it', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'openai';
        prefs[`${PREFIX}.llmKeyOpenai`] = 'k';
        const { heard, stop } = await watch();
        const { publishOllamaStatus } = await import('../../../react/utils/ollama');
        publishOllamaStatus('http://127.0.0.1:11434', { running: true, version: '0.12.0', models: ['qwen2.5:7b'] });
        await settle();
        expect(heard).toEqual([]);
        stop();
    });

    it('asks an Ollama that did not answer again each minute, and reports it once it does', async () => {
        vi.useFakeTimers();
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        const agentConfig = await import('../../../src/services/llm/agentConfig');
        agentConfig.resetSemanticSearchProbe();
        expect(await agentConfig.refreshSemanticSearchAvailability()).toBe(false);
        expect(agentConfig.semanticSearchState().status).toBe('unreachable');
        const { heard, stop } = await watch();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(heard).toEqual([]);

        ollamaModels = ['embeddinggemma-2:440m-q8_0-text-vision'];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(heard).toEqual(['became-ready']);
        stop();
    });

    it('hears Ollama come back after a probe made elsewhere found it down', async () => {
        // Zotero and Ollama start together: the watcher is up before any probe,
        // an index pass finds Ollama not answering yet, and it answers soon after.
        vi.useFakeTimers();
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        const agentConfig = await import('../../../src/services/llm/agentConfig');
        agentConfig.resetSemanticSearchProbe();
        const { heard, stop } = await watch();

        expect(await agentConfig.refreshSemanticSearchAvailability()).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        ollamaModels = ['embeddinggemma-2:440m-q8_0-text-vision'];
        await vi.advanceTimersByTimeAsync(50_000);
        expect(heard).toEqual(['became-ready']);
        expect(agentConfig.semanticSearchState().status).toBe('ready');
        stop();
    });

    it('hears it even when another probe found Ollama back first, once an index said it was waiting', async () => {
        vi.useFakeTimers();
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        const agentConfig = await import('../../../src/services/llm/agentConfig');
        agentConfig.resetSemanticSearchProbe();
        const { heard, stop } = await watch();
        const { noteSemanticSearchUnusable } = await import('../../../react/hooks/useEmbeddingIndex');

        // An index pass finds Ollama down and goes to sleep.
        expect(await agentConfig.refreshSemanticSearchAvailability()).toBe(false);
        noteSemanticSearchUnusable();
        // A question asked a few seconds later finds it answering.
        ollamaModels = ['embeddinggemma-2:440m-q8_0-text-vision'];
        await vi.advanceTimersByTimeAsync(16_000);
        agentConfig.resetSemanticSearchProbe();
        expect(await agentConfig.refreshSemanticSearchAvailability()).toBe(true);

        await vi.advanceTimersByTimeAsync(44_000);
        expect(heard).toEqual(['became-ready']);
        stop();
    });

    it('does not keep reporting an Ollama that has answered all along', async () => {
        vi.useFakeTimers();
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        ollamaModels = ['embeddinggemma-2:440m-q8_0-text-vision'];
        const agentConfig = await import('../../../src/services/llm/agentConfig');
        agentConfig.resetSemanticSearchProbe();
        expect(await agentConfig.refreshSemanticSearchAvailability()).toBe(true);
        const { heard, stop } = await watch();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(heard).toEqual([]);
        stop();
    });

    it('passes on a change of provider, and stops watching when nobody listens', async () => {
        const { heard, stop } = await watch();
        setPref('embeddingProvider', 'openai');
        expect(heard).toEqual(['provider-changed']);
        stop();
        expect((Zotero.Prefs.unregisterObserver as any).mock.calls.length).toBeGreaterThan(0);
    });
});
