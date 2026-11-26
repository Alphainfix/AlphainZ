/**
 * What applies to one model: the thinking tiers it takes, its context window,
 * the most one answer may use.
 *
 * Models disagree about the thinking scale, so each has its own list and the
 * one Thinking setting is read through it. A preset model starts from what
 * its preset knows; what the user sets on its card replaces that for that
 * model alone, without turning the preset's catalogue into the user's. A
 * hand-added model knows only what it is told, and may speak the Responses
 * API instead of Chat Completions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { nearestTier, normalizeTiers, normalizeTuning } from '@beaver/agent-llm/thinkingTiers';
import {
    modelContextWindow,
    modelThinkingTiers,
    presetDefaultTiers,
    presetModelOutputTokens,
    tuningDefaults,
} from '@beaver/agent-llm/modelTuning';
import { catalogueIsCustom, readProviderOverrides, writeProviderOverrides } from '@beaver/agent-llm/providerOverrides';
import {
    customModelTiers,
    customProviderFromEndpoint,
    readCustomEndpoints,
    writeCustomEndpoints,
    type CustomEndpoint,
} from '@beaver/agent-llm/customEndpoints';
import { buildAgentFromPrefs, providerSupportsReasoningEffort, reasoningEffortBody } from '../../../src/services/llm/agentConfig';
import { compactionThreshold } from '@beaver/agent-llm/threadCompaction';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('a thinking choice read through a model\'s tiers', () => {
    it('is sent as chosen when the model takes it, else as the nearest it does, going up on a tie', () => {
        expect(nearestTier('high', ['low', 'high', 'max'])).toBe('high');
        expect(nearestTier('none', ['low', 'high', 'max'])).toBe('low');
        expect(nearestTier('medium', ['low', 'high', 'max'])).toBe('high');
        expect(nearestTier('xhigh', ['none', 'low', 'medium', 'high'])).toBe('high');
        expect(nearestTier('minimal', ['none', 'low'])).toBe('low');
    });

    it('reads a choice it does not know as low, and gives nothing for a model with no tiers', () => {
        expect(nearestTier('extreme', ['none', 'medium', 'max'])).toBe('medium');
        expect(nearestTier('high', [])).toBeUndefined();
    });

    it('keeps a stored list in scale order, without repeats or names it does not know', () => {
        expect(normalizeTiers(['max', 'low', 'turbo', 'low', 'none'])).toEqual(['none', 'low', 'max']);
        expect(normalizeTiers('low')).toBeUndefined();
        expect(normalizeTuning({ efforts: [], contextWindow: 0, maxOutputTokens: -5 })).toEqual({ efforts: [] });
        expect(normalizeTuning({ contextWindow: 'big' })).toBeNull();
    });
});

describe('what a preset model takes when the user sets nothing', () => {
    it('lists each tier as its endpoint spells it, and the ones it is known to take beyond the four', () => {
        expect(presetDefaultTiers('deepseek', 'deepseek-flash')).toEqual(['none', 'low', 'medium', 'high', 'max']);
        expect(presetDefaultTiers('openai', 'gpt-6-luna')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
        // "Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'".
        expect(presetDefaultTiers('openai', 'gpt-6.1-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        expect(presetDefaultTiers('openai', 'gpt-4o')).toEqual([]);
        expect(presetDefaultTiers('zhipu', 'glm-5.3-flash')).toEqual(['low', 'high', 'max']);
        expect(presetDefaultTiers('openrouter', 'z-ai/glm-5.3-flash')).toEqual(['minimal', 'low', 'medium', 'high']);
        expect(presetDefaultTiers('google', 'gemini-3.5-flash-lite')).toEqual(['minimal', 'low', 'medium', 'high']);
    });

    it('knows the context window of the models it ships, and nothing of one it does not', () => {
        expect(modelContextWindow('deepseek', 'deepseek-flash')).toBe(1_048_576);
        expect(modelContextWindow('openai', 'gpt-6.1-terra')).toBe(272_000);
        expect(modelContextWindow('deepseek', '')).toBe(1_048_576);
        expect(modelContextWindow('openrouter', 'some/new-model')).toBeUndefined();
        expect(tuningDefaults('openai', 'gpt-4o')).toEqual({
            efforts: [], contextWindow: 128_000, maxOutputTokens: expect.any(Number), outputCeiling: 16_384,
        });
    });
});

describe('what the user sets for a preset model', () => {
    const tune = (tuning: Record<string, unknown>) =>
        writeProviderOverrides({ deepseek: { tuning: { 'deepseek-flash': tuning } } } as any);

    it('replaces the tiers, window and budget of that model only, and leaves the catalogue the preset\'s', () => {
        tune({ efforts: ['none', 'high'], contextWindow: 500_000, maxOutputTokens: 12_000 });
        expect(modelThinkingTiers('deepseek', 'deepseek-flash')).toEqual(['none', 'high']);
        expect(modelContextWindow('deepseek', 'deepseek-flash')).toBe(500_000);
        expect(presetModelOutputTokens('deepseek', 'deepseek-flash')).toBe(12_000);
        // An empty model choice is the preset's default, the same model.
        expect(modelThinkingTiers('deepseek', '')).toEqual(['none', 'high']);
        expect(modelThinkingTiers('deepseek', 'deepseek-other')).toEqual(['none', 'low', 'medium', 'high', 'max']);
        expect(catalogueIsCustom('deepseek')).toBe(false);
        expect(readProviderOverrides().deepseek?.models).toBeUndefined();
    });

    it('sends the nearest tier left ticked, and no thinking setting once none is', () => {
        Object.assign(prefs, { reasoningEffort: 'medium' });
        tune({ efforts: ['none', 'high'] });
        expect(reasoningEffortBody('deepseek', 'deepseek-flash')).toEqual({ extraBody: { reasoning_effort: 'high' } });
        tune({ efforts: [] });
        expect(reasoningEffortBody('deepseek', 'deepseek-flash')).toEqual({});
        expect(providerSupportsReasoningEffort('deepseek', 'deepseek-flash')).toBe(false);
    });

    it('gives each answer the model\'s own budget, which Limits per Question can lower but not raise', () => {
        Object.assign(prefs, { llmProvider: 'deepseek', llmModel: 'deepseek-flash', llmKeyDeepseek: 'k' });
        const sent = () => {
            const result = buildAgentFromPrefs(vi.fn() as any);
            if (!result.ok) throw new Error(result.problem.message);
            return (result.provider as any).config.maxTokens;
        };
        tune({ maxOutputTokens: 12_000 });
        expect(sent()).toBe(12_000);
        prefs.maxOutputTokens = 64_000;
        expect(sent()).toBe(12_000);
        prefs.maxOutputTokens = 8_000;
        expect(sent()).toBe(8_000);
        // Above the preset's own default (32k) it is the default too.
        tune({ maxOutputTokens: 100_000 });
        prefs.maxOutputTokens = 'auto';
        expect(sent()).toBe(100_000);
    });

    it('is held under what the endpoint accepts', () => {
        writeProviderOverrides({ openai: { tuning: { 'gpt-4o': { maxOutputTokens: 50_000 } } } } as any);
        Object.assign(prefs, { llmProvider: 'openai', llmModel: 'gpt-4o', llmKeyOpenai: 'k' });
        const result = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok && (result.provider as any).config.maxTokens).toBe(16_384);
    });
});

describe('when a long chat is summarized', () => {
    it('at the threshold set, or at 70% of the model\'s window when that comes first', () => {
        expect(compactionThreshold(80_000, 100_000)).toBe(70_000);
        expect(compactionThreshold(80_000, 1_048_576)).toBe(80_000);
        expect(compactionThreshold(80_000, undefined)).toBe(80_000);
        expect(compactionThreshold(undefined, 64_000)).toBe(44_800);
    });
});

describe('a hand-added model', () => {
    const relay: CustomEndpoint = {
        id: 'ep-r', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'k', authStyle: 'x-api-key',
        wireFormat: 'openai-responses',
        models: [
            { id: 'thinker', supportsVision: true, reasoningEffort: true, efforts: ['low', 'high', 'max'], contextWindow: 200_000 },
            { id: 'plain', supportsVision: false, reasoningEffort: false, efforts: [] },
        ],
    };
    const body = (model: string, effort?: string) =>
        customProviderFromEndpoint(relay, model, vi.fn() as any, effort ? { extraBody: { reasoning_effort: effort } } : {})
            .buildBody({ messages: [{ role: 'user', content: 'hi' }] } as any);

    it('keeps the API it was saved with, and reads anything else as Chat Completions', () => {
        writeCustomEndpoints([relay, { ...relay, id: 'ep-x', wireFormat: 'anthropic' as any }, { ...relay, id: 'ep-y', wireFormat: undefined }]);
        expect(readCustomEndpoints().map((e) => e.wireFormat)).toEqual(['openai-responses', undefined, undefined]);
    });

    it('goes out on the Responses wire with its thinking, or with none when it takes none', () => {
        const provider = customProviderFromEndpoint(relay, 'thinker', vi.fn() as any);
        expect(provider.wireFormat).toBe('openai-responses');
        expect(body('thinker', 'high')).toMatchObject({ reasoning: { effort: 'high', summary: 'auto' }, store: false });
        expect(body('thinker', 'high')).not.toHaveProperty('messages');
        // Thinking cannot be switched off on it, so its least tier is what goes out.
        expect(body('thinker')).toMatchObject({ reasoning: { effort: 'low' } });
        expect(body('plain')).not.toHaveProperty('reasoning');
        expect(customProviderFromEndpoint({ ...relay, wireFormat: undefined }, 'thinker', vi.fn() as any).wireFormat).toBe('openai');
    });

    it('offers its own tiers in the composer, and tells the compaction its window', () => {
        writeCustomEndpoints([relay]);
        Object.assign(prefs, { reasoningEffort: 'none' });
        expect(modelThinkingTiers('custom:ep-r', 'thinker')).toEqual(['low', 'high', 'max']);
        expect(reasoningEffortBody('custom:ep-r', 'thinker')).toEqual({ extraBody: { reasoning_effort: 'low' } });
        expect(modelContextWindow('custom:ep-r', 'thinker')).toBe(200_000);
        expect(modelContextWindow('custom:ep-r', 'plain')).toBeUndefined();
    });

    it('saved before tiers existed, takes the four the composer offered if its switch was on', () => {
        expect(customModelTiers({ reasoningEffort: true })).toEqual(['none', 'low', 'medium', 'high']);
        expect(customModelTiers({ reasoningEffort: false })).toEqual([]);
        writeCustomEndpoints([{ ...relay, models: [{ id: 'old', supportsVision: false, reasoningEffort: true }] }]);
        expect(readCustomEndpoints()[0].models[0]).not.toHaveProperty('efforts');
        expect(modelThinkingTiers('custom:ep-r', 'old')).toEqual(['none', 'low', 'medium', 'high']);
    });
});
