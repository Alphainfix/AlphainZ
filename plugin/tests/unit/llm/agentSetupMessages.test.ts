/**
 * What the agent's configuration tells the user when something is not set up,
 * and where it sends requests once it is.
 *
 * - Every message names a place that exists: keys and custom providers live
 *   under Settings → Model → Providers.
 * - An embedding provider that is chosen but unusable is reported as such,
 *   never as "none configured" — and only then does a run carry a warning.
 * - Ollama's embeddings go to the address on its card, like its chat and its
 *   availability probe.
 * - A global base URL left by older versions is moved onto the provider it
 *   redirects and stops applying to any other.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    buildAgentFromPrefs,
    buildEmbeddingProviderFromPrefs,
    migrateLegacyBaseUrl,
    refreshSemanticSearchAvailability,
    resetSemanticSearchProbe,
    semanticSearchState,
    semanticSearchUnavailableReason,
} from '../../../src/services/llm/agentConfig';
import { readProviderOverrides, writeProviderOverrides } from '@beaver/agent-llm/providerOverrides';
import { writeCustomEndpoints } from '@beaver/agent-llm/customEndpoints';
import { PROVIDER_PRESETS } from '@beaver/agent-llm/openAICompatible';

const noNetwork = (() => { throw new Error('no network expected'); }) as any;

/** The address a built provider sends to. */
const baseUrlOf = (result: ReturnType<typeof buildAgentFromPrefs>) =>
    result.ok ? (result.provider as any).config.baseUrl : null;

beforeEach(() => {
    for (const key of Object.keys(prefs)) delete prefs[key];
    resetSemanticSearchProbe();
});

describe('configuration problems name places that exist', () => {
    it('sends a missing key to the provider cards, not to an "API keys" tab', () => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        const result = buildAgentFromPrefs(noNetwork);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problem.message).toContain('Settings → Model → Providers');
        expect(result.problem.message).toContain('Add provider');
        expect(result.problem.message).toMatch(/on this computer/);
        expect(result.problem.message).not.toMatch(/API keys/i);
        expect(result.problem.needsKey).toBe(true);
        expect(result.problem.settingsTab).toBe('models');
    });

    it('says keys do not sync only when this computer syncs its settings', () => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';

        prefs.conversationSyncBackend = 'off';
        const alone = buildAgentFromPrefs(noNetwork);
        expect(alone.ok).toBe(false);
        if (alone.ok) return;
        expect(alone.problem.message).not.toMatch(/syncs/);

        prefs.conversationSyncBackend = 'folder';
        const synced = buildAgentFromPrefs(noNetwork);
        expect(synced.ok).toBe(false);
        if (synced.ok) return;
        expect(synced.problem.message).toContain('the model choice syncs, the key does not');
    });

    it('sends a custom provider missing on this computer to "Add custom provider"', () => {
        prefs.llmProvider = 'custom:ep-gone';
        prefs.llmModel = 'm';
        const result = buildAgentFromPrefs(noNetwork);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problem.message).toContain('Settings → Model → Providers → Add custom provider');
        expect(result.problem.message).toMatch(/not set up on this computer/);
        expect(result.problem.message).not.toContain('Your endpoints');
        expect(result.problem.settingsTab).toBe('models');
    });

    it('sends a model missing from a custom provider to that provider\'s card', () => {
        writeCustomEndpoints([{ id: 'ep-1', name: 'Lab box', baseUrl: 'http://10.0.0.2:8000/v1', apiKey: '', authStyle: 'bearer', models: [{ id: 'a', supportsVision: false, reasoningEffort: false }] }] as any);
        prefs.llmProvider = 'custom:ep-1';
        prefs.llmModel = 'b';
        const result = buildAgentFromPrefs(noNetwork);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problem.message).toContain('Lab box');
        expect(result.problem.message).toContain('Settings → Model → Providers');
    });

    it('points at the provider cards when nothing is chosen yet', () => {
        const result = buildAgentFromPrefs(noNetwork);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problem.message).toContain('Settings → Model → Providers');
        expect(result.problem.settingsTab).toBe('models');
    });
});

describe('an embedding provider that is chosen but unusable', () => {
    beforeEach(() => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        prefs.llmKeyDeepseek = 'k';
    });

    it('is reported as missing its key on this computer, not as "none configured"', () => {
        // The embedding choice syncs; the OpenAI key stayed on the other computer.
        prefs.embeddingProvider = 'openai';
        expect(semanticSearchState()).toEqual({ status: 'needs_key', provider: 'openai', label: 'OpenAI' });
        const reason = semanticSearchUnavailableReason();
        expect(reason).toContain('OpenAI');
        expect(reason).toContain('this computer');
        expect(reason).toContain('Settings → Model → Providers');
        expect(reason).not.toContain('no embedding provider is configured');
    });

    it('puts that reason on the run as a warning', () => {
        prefs.embeddingProvider = 'openai';
        const built = buildAgentFromPrefs(noNetwork);
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.warnings).toHaveLength(1);
        expect(built.warnings[0].type).toBe('semantic_search_unavailable');
        expect(built.warnings[0].message).toContain('OpenAI');
        expect(built.tools.some((t) => t.name === 'item_search_by_topic')).toBe(false);
    });

    it('warns with the probe\'s reason when Ollama does not answer', async () => {
        prefs.embeddingProvider = 'ollama';
        await refreshSemanticSearchAvailability(vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any);
        const built = buildAgentFromPrefs(noNetwork);
        expect(built.ok && built.warnings.map((w) => w.message)).toEqual([
            expect.stringContaining('Ollama is not running'),
        ]);
    });

    it('names the address it could not reach when Ollama is set to another machine', async () => {
        prefs.embeddingProvider = 'ollama';
        prefs.ollamaBaseUrl = 'http://gpu-box.lab:11434';
        const probe = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        await refreshSemanticSearchAvailability(probe as any);
        expect(probe.mock.calls[0]).toEqual(['http://gpu-box.lab:11434/api/tags', expect.anything()]);
        expect(semanticSearchUnavailableReason()).toContain('Ollama is not running at http://gpu-box.lab:11434');
        expect(semanticSearchUnavailableReason()).not.toContain('on this computer');
    });

    it('says where to get the embedding model when Ollama runs without it', async () => {
        prefs.embeddingProvider = 'ollama';
        await refreshSemanticSearchAvailability(vi.fn(async () => ({
            ok: true,
            json: async () => ({ models: [{ name: 'qwen2.5:7b' }] }),
        })) as any);
        expect(semanticSearchState()).toEqual(expect.objectContaining({ status: 'unreachable' }));
        expect(semanticSearchUnavailableReason()).toContain('embeddinggemma-2:440m-q8_0-text-vision model is not installed');
        expect(semanticSearchUnavailableReason()).toContain('Settings → Model → Topic and full-text search');
    });
});

describe('topic search turned off on purpose', () => {
    it('adds no warning to the run — the setting already says what Off means', () => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        prefs.llmKeyDeepseek = 'k';
        prefs.embeddingProvider = '';
        expect(semanticSearchState()).toEqual({ status: 'off' });
        const built = buildAgentFromPrefs(noNetwork);
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.warnings).toEqual([]);
        // The model is still told, and the topic tool is still withheld.
        expect(built.tools.some((t) => t.name === 'item_search_by_topic')).toBe(false);
    });
});

describe('Ollama embeddings follow the address on the Ollama card', () => {
    const embeddingsAnswer = vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 768 }, () => 0.1) }] }),
    }));

    beforeEach(() => {
        embeddingsAnswer.mockClear();
        prefs.embeddingProvider = 'ollama';
        prefs.ollamaBaseUrl = 'http://192.168.1.20:11434';
    });

    it('for the indexer and the query embedding', async () => {
        const provider = buildEmbeddingProviderFromPrefs(embeddingsAnswer as any);
        expect(provider).not.toBeNull();
        await provider!.generateQueryEmbedding('waggle dance odometry').catch(() => undefined);
        expect(embeddingsAnswer.mock.calls[0][0]).toBe('http://192.168.1.20:11434/v1/embeddings');
    });

    it('for a run', async () => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        prefs.llmKeyDeepseek = 'k';
        const built = buildAgentFromPrefs(embeddingsAnswer as any);
        expect(built.ok && built.embeddings).toBeTruthy();
        if (!built.ok || !built.embeddings) return;
        await built.embeddings.generateQueryEmbedding('waggle dance odometry').catch(() => undefined);
        expect(embeddingsAnswer.mock.calls[0][0]).toBe('http://192.168.1.20:11434/v1/embeddings');
    });

    it('and a cloud provider keeps its own address', async () => {
        prefs.embeddingProvider = 'openai';
        prefs.llmKeyOpenai = 'k';
        const provider = buildEmbeddingProviderFromPrefs(embeddingsAnswer as any);
        await provider!.generateQueryEmbedding('q').catch(() => undefined);
        expect(embeddingsAnswer.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');
    });
});

describe('the global base URL older versions kept', () => {
    it('moves onto the provider it was redirecting, visible on its card, and is cleared', () => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        prefs.llmKeyDeepseek = 'k';
        prefs.llmBaseUrl = 'https://relay.example.com/v1/';

        expect(baseUrlOf(buildAgentFromPrefs(noNetwork))).toBe('https://relay.example.com/v1');
        expect(readProviderOverrides().deepseek?.baseUrl).toBe('https://relay.example.com/v1');
        expect(prefs.llmBaseUrl).toBe('');
    });

    it('no longer redirects a provider chosen afterwards', () => {
        prefs.llmProvider = 'deepseek';
        prefs.llmKeyDeepseek = 'k';
        prefs.llmBaseUrl = 'https://relay.example.com/v1';
        buildAgentFromPrefs(noNetwork);

        prefs.llmProvider = 'openrouter';
        prefs.llmModel = '';
        prefs.llmKeyOpenrouter = 'k';
        expect(baseUrlOf(buildAgentFromPrefs(noNetwork))).toBe(PROVIDER_PRESETS.openrouter.baseUrl);

        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'qwen3:8b';
        expect(baseUrlOf(buildAgentFromPrefs(noNetwork))).toBe('http://127.0.0.1:11434/v1');
    });

    it('is dropped when the provider already has an address of its own', () => {
        prefs.llmProvider = 'openai';
        prefs.llmKeyOpenai = 'k';
        writeProviderOverrides({ openai: { baseUrl: 'https://mine.example.com/v1' } });
        prefs.llmBaseUrl = 'https://legacy.example.com/v1';

        expect(baseUrlOf(buildAgentFromPrefs(noNetwork))).toBe('https://mine.example.com/v1');
        expect(prefs.llmBaseUrl).toBe('');
        expect(readProviderOverrides().openai?.baseUrl).toBe('https://mine.example.com/v1');
    });

    it('is only cleared when it names the provider\'s own address', () => {
        prefs.llmProvider = 'openai';
        prefs.llmKeyOpenai = 'k';
        prefs.llmBaseUrl = PROVIDER_PRESETS.openai.baseUrl;
        migrateLegacyBaseUrl();
        expect(prefs.llmBaseUrl).toBe('');
        expect(readProviderOverrides().openai).toBeUndefined();
    });

    it('moves onto the Ollama card\'s address, as the server root the card and probe use', () => {
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'qwen3:8b';
        prefs.llmBaseUrl = 'http://10.0.0.5:11434/v1';

        expect(baseUrlOf(buildAgentFromPrefs(noNetwork))).toBe('http://10.0.0.5:11434/v1');
        expect(prefs.ollamaBaseUrl).toBe('http://10.0.0.5:11434');
        expect(prefs.llmBaseUrl).toBe('');
    });

    it('leaves an address already typed on the Ollama card alone', () => {
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'qwen3:8b';
        prefs.ollamaBaseUrl = 'http://gpu-box.lab:11434';
        prefs.llmBaseUrl = 'https://relay.example.com/v1';

        expect(baseUrlOf(buildAgentFromPrefs(noNetwork))).toBe('http://gpu-box.lab:11434/v1');
        expect(prefs.ollamaBaseUrl).toBe('http://gpu-box.lab:11434');
        expect(prefs.llmBaseUrl).toBe('');
    });

    it('waits while a custom provider is selected — it never applied to one', () => {
        writeCustomEndpoints([{ id: 'ep-1', name: 'Lab box', baseUrl: 'http://10.0.0.2:8000/v1', apiKey: '', authStyle: 'bearer', models: [{ id: 'a', supportsVision: false, reasoningEffort: false }] }] as any);
        prefs.llmProvider = 'custom:ep-1';
        prefs.llmModel = 'a';
        prefs.llmBaseUrl = 'https://relay.example.com/v1';

        expect(baseUrlOf(buildAgentFromPrefs(noNetwork))).toBe('http://10.0.0.2:8000/v1');
        expect(prefs.llmBaseUrl).toBe('https://relay.example.com/v1');
    });
});
