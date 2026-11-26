/**
 * How long the model may think, and who is allowed to ask.
 *
 * The setting reaches every model that takes an effort — on the Responses wire
 * for OpenAI and gateways in front of it, where thinking and tools go
 * together — and never one that rejects the field. And it is not only about
 * answer quality: thinking is spent from the same output budget as the answer,
 * so a high value on a long tool-using run can end the turn inside the
 * reasoning with no text and no tool call — which is what made colour-coding
 * silently do nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));

import {
    KEY_PREF_BY_PROVIDER,
    reasoningEffortBody,
    REASONING_EFFORTS,
} from '../../../src/services/llm/agentConfig';
import { modelThinkingTiers } from '@beaver/agent-llm/modelTuning';
import {
    PROVIDER_PRESETS,
    RETIRED_OPENROUTER_MODELS,
    presetCapabilities,
    presetSupportsVision,
} from '@beaver/agent-llm/openAICompatible';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('reasoningEffortBody', () => {
    it('sends the chosen effort to a provider that takes one', () => {
        prefs.reasoningEffort = 'high';
        expect(reasoningEffortBody('deepseek')).toEqual({ extraBody: { reasoning_effort: 'high' } });
        expect(reasoningEffortBody('deepseek', 'deepseek-flash')).toEqual({ extraBody: { reasoning_effort: 'high' } });
    });

    it('sends the chosen effort to OpenAI\'s GPT-6 models, defaulting to low', () => {
        expect(reasoningEffortBody('openai', 'gpt-6-luna')).toEqual({ extraBody: { reasoning_effort: 'low' } });
        prefs.reasoningEffort = 'high';
        expect(reasoningEffortBody('openai', 'gpt-6-luna')).toEqual({ extraBody: { reasoning_effort: 'high' } });
        expect(reasoningEffortBody('openai', 'gpt-6-sol')).toEqual({ extraBody: { reasoning_effort: 'high' } });
    });

    it('sends nothing to a model with no reasoning setting at all', () => {
        prefs.reasoningEffort = 'high';
        expect(reasoningEffortBody('openai')).toEqual({});
        expect(reasoningEffortBody('openai', 'gpt-4o-mini')).toEqual({});
        expect(reasoningEffortBody('ollama')).toEqual({});
    });

    it('respells the tier an OpenAI model refuses', () => {
        prefs.reasoningEffort = 'none';
        expect(reasoningEffortBody('openai', 'gpt-5.1')).toEqual({ extraBody: { reasoning_effort: 'none' } });
        expect(reasoningEffortBody('openai', 'gpt-5')).toEqual({ extraBody: { reasoning_effort: 'minimal' } });
        expect(reasoningEffortBody('openai', 'o3')).toEqual({ extraBody: { reasoning_effort: 'low' } });
        // astra takes low/medium/high/xhigh only.
        expect(reasoningEffortBody('openai', 'gpt-6-astra')).toEqual({ extraBody: { reasoning_effort: 'low' } });
        expect(reasoningEffortBody('openai', 'gpt-6-luna')).toEqual({ extraBody: { reasoning_effort: 'none' } });
        // A dated snapshot is the same model.
        expect(reasoningEffortBody('openai', 'gpt-5-mini-2025-08-07')).toEqual({ extraBody: { reasoning_effort: 'minimal' } });
        expect(reasoningEffortBody('openai', 'gpt-5-codex')).toEqual({ extraBody: { reasoning_effort: 'low' } });
        // The -pro models think at high and nothing less.
        expect(reasoningEffortBody('openai', 'gpt-5-pro')).toEqual({ extraBody: { reasoning_effort: 'high' } });
        prefs.reasoningEffort = 'medium';
        expect(reasoningEffortBody('openai', 'o3-pro')).toEqual({ extraBody: { reasoning_effort: 'high' } });
    });

    it('accepts "none", so thinking can be turned off entirely', () => {
        // Measured against the endpoint: `none` drops reasoning_tokens to zero
        // rather than merely shortening the chain.
        prefs.reasoningEffort = 'none';
        expect(reasoningEffortBody('deepseek')).toEqual({ extraBody: { reasoning_effort: 'none' } });
    });

    it('falls back to low for an unset or unrecognised value', () => {
        expect(reasoningEffortBody('deepseek')).toEqual({ extraBody: { reasoning_effort: 'low' } });
        prefs.reasoningEffort = 'extreme';
        expect(reasoningEffortBody('deepseek')).toEqual({ extraBody: { reasoning_effort: 'low' } });
    });

    it('knows every tier any model takes, narrowest first', () => {
        expect([...REASONING_EFFORTS]).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    });
});

describe('the OpenAI preset, per model', () => {
    const tool = {
        name: 'search_library',
        description: 'Search the library.',
        parameters: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] },
    };
    const bodyFor = async (model: string, effort?: string) => {
        const { providerFromPreset } = await import('@beaver/agent-llm/openAICompatible');
        return providerFromPreset('openai', 'k', (() => {}) as any, {
            model,
            ...(effort ? { extraBody: { reasoning_effort: effort } } : {}),
        }).buildBody({ messages: [{ role: 'user', content: 'hi' }], tools: [tool] });
    };

    it('thinks with tools on the Responses wire for the gpt-5 and gpt-6 families', async () => {
        // On /chat/completions "Function tools with reasoning_effort are not
        // supported for gpt-6-luna … To use function tools, use /v1/responses"
        // (2026-09-22, again 2026-10-13); on /responses tools and every effort
        // tier go together (verified live 2026-10-13).
        for (const model of ['gpt-5.1', 'gpt-6-luna', 'gpt-6-sol']) {
            const body = await bodyFor(model, 'low');
            // No thinking summary: some organisations must be verified for one.
            expect(body.reasoning).toEqual({ effort: 'low' });
            expect(body.include).toEqual(['reasoning.encrypted_content']);
            expect(body.tools).toHaveLength(1);
            expect(body).not.toHaveProperty('reasoning_effort');
            expect(body).not.toHaveProperty('messages');
        }
    });

    it('turns thinking off explicitly, without encrypted reasoning', async () => {
        const body = await bodyFor('gpt-6-luna', 'none');
        expect(body.reasoning).toEqual({ effort: 'none' });
        expect(body).not.toHaveProperty('include');
        // With no effort configured (the key test), it is off rather than the model's own default.
        expect((await bodyFor('gpt-6-luna')).reasoning).toEqual({ effort: 'none' });
    });

    it('sends no reasoning at all to gpt-4o-mini, which rejects the field', async () => {
        // "Unsupported parameter: 'reasoning.effort' is not supported with this
        // model" on /responses (2026-10-13); on /chat/completions it was
        // "Unrecognized request argument supplied: reasoning_effort".
        const body = await bodyFor('gpt-4o-mini', 'low');
        expect(body).not.toHaveProperty('reasoning');
        expect(body).not.toHaveProperty('reasoning_effort');
        expect(body).not.toHaveProperty('include');
    });
});

/**
 * OpenRouter, for GLM 5.3 Flash.
 *
 * The slot has hosted a succession of models: added for Qwen3.8-27B (dropped —
 * no `tools` in its supported parameters, and an agent loop cannot run on a
 * model that cannot be given tools), then Ox Alpha (retired from OpenRouter's
 * roster entirely), now GLM 5.3 Flash — which lists `tools`, `tool_choice`,
 * `reasoning` and `reasoning_effort`, takes images, and carries a 1.3M
 * context. All read from https://openrouter.ai/api/v1/models on 2026-08-26,
 * and the tool call verified live the same day.
 */
describe('the OpenRouter preset', () => {
    it('points at OpenRouter and defaults to GLM 5.3 Flash', () => {
        const preset = PROVIDER_PRESETS.openrouter;
        expect(preset.baseUrl).toBe('https://openrouter.ai/api/v1');
        expect(preset.defaultModel).toBe('z-ai/glm-5.3-flash');
    });

    it('routes a preference still naming the retired model to its successor', () => {
        // `llmModel` outlives the catalog: a stored "stealth/ox-alpha" would
        // otherwise 404 on every request, wearing an error about a model the
        // settings page no longer offers.
        expect(RETIRED_OPENROUTER_MODELS['stealth/ox-alpha']).toBe('z-ai/glm-5.3-flash');
    });

    it('offers DeepSeek V4-Flash alongside GLM on the same key', () => {
        // Same model as the DeepSeek preset reaches directly, but routed through
        // OpenRouter's third-party hosts. Measured on one real billed request
        // (4,016 in / 200 out, landed on Baidu, 2026-09-01): $0.00032272 paid
        // against $0.00101552 at DeepSeek's own off-peak price and $0.00203104
        // at its peak price — 68% and 84% cheaper. Unit prices $0.073/M in and
        // $0.146/M out, with no peak/off-peak swing at all.
        expect(PROVIDER_PRESETS.openrouter.models).toContain('deepseek/deepseek-v4.1-flash');
    });

    it('lets both OpenRouter models read figures, and keeps the exception list for a text-only one', () => {
        // V4.1 Flash on OpenRouter takes images (its roster says text+image), so
        // it no longer needs the text-only exception V4-Flash had; the list
        // itself stays, empty, for the next text-only model.
        expect(presetCapabilities('openrouter').supportsVision).toBe(true);
        expect(presetCapabilities('openrouter', 'z-ai/glm-5.3-flash').supportsVision).toBe(true);
        expect(presetSupportsVision('openrouter', 'deepseek/deepseek-v4.1-flash')).toBe(true);
        expect(PROVIDER_PRESETS.openrouter.textOnlyModels).toEqual([]);
    });

    it('does not respell "none" for DeepSeek, which honours it', () => {
        // Verified live 2026-09-01: every tier none→high is accepted and `none`
        // zeroes reasoning_tokens. Applying GLM's alias here would turn thinking
        // back ON for someone who asked for none — the opposite of the setting.
        prefs.reasoningEffort = 'none';
        expect(reasoningEffortBody('openrouter', 'deepseek/deepseek-v4.1-flash'))
            .toEqual({ extraBody: { reasoning_effort: 'none' } });
        // ...while GLM on the same preset still gets the respelling.
        expect(reasoningEffortBody('openrouter', 'z-ai/glm-5.3-flash'))
            .toEqual({ extraBody: { reasoning_effort: 'minimal' } });
    });

    it('respells "none" as "minimal" for GLM, which refuses to stop thinking', () => {
        // Verified live 2026-08-26: reasoning_effort "none" is a 400 —
        // "Reasoning is mandatory for this endpoint" — and "minimal" is
        // accepted. Someone choosing "none" wants the least thinking the
        // model allows, not an error on every request.
        prefs.reasoningEffort = 'none';
        expect(reasoningEffortBody('openrouter')).toEqual({
            extraBody: { reasoning_effort: 'minimal' },
        });
        // The other tiers pass through unrespelled…
        prefs.reasoningEffort = 'high';
        expect(reasoningEffortBody('openrouter')).toEqual({
            extraBody: { reasoning_effort: 'high' },
        });
        // …and DeepSeek's "none" stays "none": that endpoint honours it.
        prefs.reasoningEffort = 'none';
        expect(reasoningEffortBody('deepseek')).toEqual({
            extraBody: { reasoning_effort: 'none' },
        });
    });

    it('does not offer a model that cannot be given tools', () => {
        // Read from https://openrouter.ai/api/v1/models: qwen/qwen3.8-27b lists
        // no `tools` parameter. Offering it would put a model in the picker
        // that fails on the first library search.
        expect(PROVIDER_PRESETS.openrouter.models).not.toContain('qwen/qwen3.8-27b');
    });

    it('takes a thinking level, and a budget big enough to survive one', () => {
        // A reasoning model on a 4000-token cap can spend the whole budget
        // thinking and return neither text nor a tool call, which reads to the
        // loop as a finished turn.
        const caps = presetCapabilities('openrouter');
        expect(caps.supportsReasoningEffort).toBe(true);
        // Sized for thinking plus an answer, under the 131,072 both roster
        // models accept.
        expect(caps.defaultMaxTokens).toBe(32_000);
        expect(caps.maxOutputTokens).toBe(131_072);
        expect(reasoningEffortBody('openrouter')).toHaveProperty('extraBody');
    });

    it('is offered as a vision model', () => {
        expect(presetCapabilities('openrouter').supportsVision).toBe(true);
    });

    it('needs a key before it is listed', () => {
        // The mistake Ollama made: listed unconditionally because it needed no
        // key, so it advertised a model that was usually unreachable.
        expect(KEY_PREF_BY_PROVIDER.openrouter).toBe('llmKeyOpenrouter');
    });
});

/**
 * Zhipu's own platform (bigmodel.cn) — the same GLM 5.3 Flash without the
 * OpenRouter hop. Facts from docs.bigmodel.cn, 2026-08-27: the 5.3 models'
 * effort enum is low/high/max only, thinking cannot be disabled, 1M context,
 * 128K max output, image input, function calling.
 */
describe('the Zhipu preset', () => {
    it('points at bigmodel.cn and defaults to GLM 5.3 Flash', () => {
        const preset = PROVIDER_PRESETS.zhipu;
        expect(preset.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
        expect(preset.defaultModel).toBe('glm-5.3-flash');
    });

    it('offers the three tiers the endpoint accepts, and reads any other choice as the nearest', () => {
        // low/high/max is the documented enum for the 5.3 models. "none"
        // cannot be honoured — thinking is mandatory — so it becomes the
        // least thinking on offer; a choice halfway between two goes up.
        expect(modelThinkingTiers('zhipu', 'glm-5.3-flash')).toEqual(['low', 'high', 'max']);
        const expected: Record<string, string> = {
            none: 'low',
            minimal: 'low',
            low: 'low',
            medium: 'high',
            high: 'high',
            xhigh: 'max',
            max: 'max',
        };
        for (const [tier, wire] of Object.entries(expected)) {
            prefs.reasoningEffort = tier;
            expect(reasoningEffortBody('zhipu')).toEqual({
                extraBody: { reasoning_effort: wire },
            });
        }
    });

    it('pins no thinking object: this client never replays reasoning_content', () => {
        // `thinking.type` only accepts `enabled` on this model and
        // `clear_thinking` only governs replayed history reasoning, which we
        // never send — so the preset leaves the whole object to its server
        // defaults rather than pinning fields that do nothing.
        expect((PROVIDER_PRESETS.zhipu as any).extraBody).toBeUndefined();
    });

    it('is offered as a vision model with a survivable budget', () => {
        const caps = presetCapabilities('zhipu');
        expect(caps.supportsVision).toBe(true);
        expect(caps.defaultMaxTokens).toBe(32_000);
        expect(caps.maxOutputTokens).toBe(131_072);
    });

    it('needs its own key before it is listed', () => {
        expect(KEY_PREF_BY_PROVIDER.zhipu).toBe('llmKeyZhipu');
    });
});
