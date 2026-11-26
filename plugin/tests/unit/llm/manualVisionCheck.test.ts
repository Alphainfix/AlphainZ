/**
 * The Check button: asks the endpoint whether one model reads images, and
 * records the answer where the picker and the attachment checks read it.
 * Never on its own — pressing it is the only trigger.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: the models module reads preferences while it is being imported.
const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { checkModelVision } from '../../../src/services/llm/agentConfig';
import { PROBE_CODE } from '@beaver/agent-llm/visionProbe';
import { presetSupportsVision, resetProbedVision } from '@beaver/agent-llm/openAICompatible';
import { readCustomEndpoints, writeCustomEndpoints } from '@beaver/agent-llm/customEndpoints';

function endpointAnswering(text: string, promptTokens = 160) {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        return { status: 200, json: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: promptTokens } }) };
    });
    return { fetchImpl, calls };
}

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    resetProbedVision();
});

describe('checkModelVision on a preset model', () => {
    it('records the verdict beside the presets, so the picker row changes', async () => {
        prefs.llmKeyDeepseek = 'k';
        const { fetchImpl, calls } = endpointAnswering(PROBE_CODE);
        const result = await checkModelVision('deepseek', 'deepseek-flash', fetchImpl);
        expect(result.applied).toBe(true);
        expect(result.verdict.seesImages).toBe(true);
        expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(true);
        // Pressing again asks again — a Check is a fresh look, never a cache read.
        await checkModelVision('deepseek', 'deepseek-flash', fetchImpl);
        expect(calls).toHaveLength(2);
    });

    it('does nothing without the vendor\'s key, and says so', async () => {
        const { fetchImpl, calls } = endpointAnswering(PROBE_CODE);
        const result = await checkModelVision('deepseek', 'deepseek-flash', fetchImpl);
        expect(result.applied).toBe(false);
        expect(result.verdict.detail).toBe('no API key');
        expect(calls).toHaveLength(0);
    });

    it('reports a declared model as declared, without a request', async () => {
        const { fetchImpl, calls } = endpointAnswering(PROBE_CODE);
        const result = await checkModelVision('openai', 'gpt-4o', fetchImpl);
        expect(result.verdict.seesImages).toBe(true);
        expect(result.verdict.detail).toBe('declared by the preset');
        expect(calls).toHaveLength(0);
    });
});

describe('checkModelVision on a hand-added model', () => {
    const endpoint = {
        id: 'ep-1', name: 'Local', baseUrl: 'http://127.0.0.1:8765/v1', apiKey: '', authStyle: 'bearer' as const,
        models: [{ id: 'm1', supportsVision: false, reasoningEffort: false }],
    };

    it('sets the model\'s own switch and keeps the evidence, with no auth header for an empty key', async () => {
        writeCustomEndpoints([endpoint]);
        const { fetchImpl, calls } = endpointAnswering(PROBE_CODE);
        const result = await checkModelVision('custom:ep-1', 'm1', fetchImpl);
        expect(result.applied).toBe(true);
        expect(calls[0].url).toBe('http://127.0.0.1:8765/v1/chat/completions');
        expect(calls[0].init.headers).not.toHaveProperty('Authorization');
        const stored = readCustomEndpoints()[0].models[0];
        expect(stored.supportsVision).toBe(true);
        expect(stored.visionChecked?.seesImages).toBe(true);
        expect(stored.visionChecked?.detail).toMatch(/160 prompt tokens/);
    });

    it('turns the switch off again when the model cannot see', async () => {
        writeCustomEndpoints([{ ...endpoint, apiKey: 'secret', authStyle: 'x-api-key', models: [{ ...endpoint.models[0], supportsVision: true }] }]);
        const { fetchImpl, calls } = endpointAnswering('NO IMAGE', 40);
        const result = await checkModelVision('custom:ep-1', 'm1', fetchImpl);
        expect(result.verdict.seesImages).toBe(false);
        expect(calls[0].init.headers['X-Api-Key']).toBe('secret');
        expect(readCustomEndpoints()[0].models[0].supportsVision).toBe(false);
    });

    it('asks nothing for a model that is not on the endpoint', async () => {
        writeCustomEndpoints([endpoint]);
        const { fetchImpl, calls } = endpointAnswering(PROBE_CODE);
        const result = await checkModelVision('custom:ep-1', 'other', fetchImpl);
        expect(result.applied).toBe(false);
        expect(calls).toHaveLength(0);
    });
});
