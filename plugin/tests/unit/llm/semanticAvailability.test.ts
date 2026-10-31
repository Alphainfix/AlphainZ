/**
 * A local embedding server that is chosen but not there must read exactly like
 * "no embedding provider": the same system prompt, the same tool set, and a
 * warning that says what is missing. Otherwise the model is handed a topic
 * search that returns nothing and concludes the library is empty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

beforeEach(() => {
    prefs = {
        [`${PREFIX}.llmProvider`]: 'deepseek',
        [`${PREFIX}.llmModel`]: 'deepseek-flash',
        [`${PREFIX}.llmKeyDeepseek`]: 'k',
    };
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    vi.resetModules();
});

const load = () => import('../../../src/services/llm/agentConfig');
const running = (models: string[]) => vi.fn(async () => ({ ok: true, json: async () => ({ models: models.map((name) => ({ name })) }) }));
const down = () => vi.fn(async () => { throw new Error('ECONNREFUSED'); });

describe('semantic search availability with Ollama', () => {
    it('is on when Ollama answers and has the embedding model', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        const cfg = await load();
        expect(await cfg.refreshSemanticSearchAvailability(running(['embeddinggemma-2:440m-q8_0-text-vision']) as any)).toBe(true);
        expect(cfg.isSemanticSearchAvailable()).toBe(true);
        const built = cfg.buildAgentFromPrefs(vi.fn() as any);
        expect(built.ok && built.tools.some((t) => t.name === 'item_search_by_topic')).toBe(true);
        expect(built.ok && built.warnings).toEqual([]);
    });

    it('reads exactly like "no embedding provider" when Ollama is not running', async () => {
        const cfg = await load();
        prefs[`${PREFIX}.embeddingProvider`] = '';
        const promptWithoutIndex = cfg.buildAgentSystemPrompt();
        const toolsWithoutIndex = cfg.buildAgentFromPrefs(vi.fn() as any);

        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        expect(await cfg.refreshSemanticSearchAvailability(down() as any)).toBe(false);
        expect(cfg.isSemanticSearchAvailable()).toBe(false);
        expect(cfg.buildAgentSystemPrompt()).toBe(promptWithoutIndex);
        const built = cfg.buildAgentFromPrefs(vi.fn() as any);
        expect(built.ok && toolsWithoutIndex.ok && built.tools.map((t) => t.name)).toEqual(
            toolsWithoutIndex.ok ? toolsWithoutIndex.tools.map((t) => t.name) : null,
        );
        expect(built.ok && built.tools.some((t) => t.name === 'item_search_by_topic')).toBe(false);
        expect(built.ok && built.warnings[0]?.message).toContain('Ollama is not running');
        expect(cfg.currentEmbeddingModelId()).toBeNull();
    });

    it('is off when Ollama runs but the model was never pulled, and says so', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        const cfg = await load();
        expect(await cfg.refreshSemanticSearchAvailability(running(['qwen2.5:7b']) as any)).toBe(false);
        expect(cfg.semanticSearchUnavailableReason()).toContain('embeddinggemma-2:440m-q8_0-text-vision model is not installed');
    });

    it('caches the probe briefly and forgets it on demand', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'ollama';
        const cfg = await load();
        const probe = down();
        await cfg.refreshSemanticSearchAvailability(probe as any);
        await cfg.refreshSemanticSearchAvailability(probe as any);
        expect(probe).toHaveBeenCalledTimes(1);
        cfg.resetSemanticSearchProbe();
        await cfg.refreshSemanticSearchAvailability(running(['embeddinggemma-2:440m-q8_0-text-vision']) as any);
        expect(cfg.isSemanticSearchAvailable()).toBe(true);
    });

    it('does not probe anything for a cloud provider', async () => {
        prefs[`${PREFIX}.embeddingProvider`] = 'openai';
        prefs[`${PREFIX}.llmKeyOpenai`] = 'k';
        const cfg = await load();
        const probe = down();
        expect(await cfg.refreshSemanticSearchAvailability(probe as any)).toBe(true);
        expect(probe).not.toHaveBeenCalled();
    });
});
