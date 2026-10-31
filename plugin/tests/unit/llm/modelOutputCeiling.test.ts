/**
 * A reply's output cap is held under the chosen model's own ceiling.
 *
 * One preset can host models with very different limits — OpenAI's gpt-5
 * accepts 128k output tokens where gpt-4o accepts 16k — so a cap resolved
 * against the preset's default model either fails every request (too high) or
 * cuts a reasoning model's answer short (too low).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { buildAgentFromPrefs, resetSemanticSearchProbe } from '../../../src/services/llm/agentConfig';

const noNetwork = (() => { throw new Error('no network expected'); }) as any;

/** The cap a built run carries, and the one its request body sends. */
function capFor(provider: string, model?: string) {
    prefs.llmProvider = provider;
    if (model) prefs.llmModel = model;
    const result = buildAgentFromPrefs(noNetwork);
    if (!result.ok) throw new Error(result.problem.message);
    const body = (result.provider as any).buildBody({ messages: [{ role: 'user', content: 'hi' }] });
    return { limit: result.outputTokenLimit, sent: body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens };
}

beforeEach(() => {
    for (const key of Object.keys(prefs)) delete prefs[key];
    resetSemanticSearchProbe();
    prefs.llmKeyOpenai = 'sk-test';
    prefs.llmKeyDeepseek = 'k';
    // Settings → Advanced: "Reply length" set to 100k.
    prefs.maxOutputTokens = 100_000;
});

describe('the output cap follows the chosen model', () => {
    it('lets an OpenAI reasoning model have the length the user asked for', () => {
        expect(capFor('openai', 'gpt-5')).toEqual({ limit: 100_000, sent: 100_000 });
        expect(capFor('openai', 'o3').limit).toBe(100_000);
    });

    it('holds each OpenAI model to its own ceiling', () => {
        expect(capFor('openai', 'gpt-4.1')).toEqual({ limit: 32_768, sent: 32_768 });
        expect(capFor('openai', 'gpt-4o-mini').limit).toBe(16_384);
    });

    it('uses the preset default model when none is chosen', () => {
        expect(capFor('openai').limit).toBe(16_384);
    });

    it('leaves a preset with one ceiling for all its models as it was', () => {
        expect(capFor('deepseek', 'deepseek-flash')).toEqual({ limit: 100_000, sent: 100_000 });
    });
});
