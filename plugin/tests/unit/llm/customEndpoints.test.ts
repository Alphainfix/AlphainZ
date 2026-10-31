/**
 * Endpoints the user adds by hand: stored per computer, filed under their own
 * name in the picker, and run exactly as described — nothing inferred.
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

import {
    customModelCapabilities,
    customProviderFromEndpoint,
    customProviderId,
    findCustomEndpoint,
    isCustomProviderId,
    newEndpointId,
    parseCustomProviderId,
    readCustomEndpoints,
    updateCustomModel,
    writeCustomEndpoints,
    type CustomEndpoint,
} from '../../../src/services/llm/customEndpoints';
import { buildAgentFromPrefs, isAgentConfigured, providerSupportsReasoningEffort } from '../../../src/services/llm/agentConfig';
import { localModelFromPrefs, localModelsFromPrefs } from '../../../react/atoms/models';
import { rowLabel, vendorFor } from '../../../react/components/ui/buttons/ModelSelectionButton';

const proxy: CustomEndpoint = {
    id: 'ep-1',
    name: 'My proxy',
    baseUrl: 'https://proxy.example.com/v1/',
    apiKey: 'k-proxy',
    authStyle: 'x-api-key',
    models: [
        { id: 'big-model', label: 'Big', supportsVision: true, reasoningEffort: true },
        { id: 'small-model', supportsVision: false, reasoningEffort: false, maxTokens: 2048 },
    ],
};

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('the endpoint store', () => {
    it('round-trips, normalising what it keeps and dropping what it cannot use', () => {
        writeCustomEndpoints([proxy, { id: '', name: 'no id', baseUrl: 'x', apiKey: '', authStyle: 'bearer', models: [] }]);
        const [stored, ...rest] = readCustomEndpoints();
        expect(rest).toEqual([]);
        expect(stored.baseUrl).toBe('https://proxy.example.com/v1'); // trailing slash gone
        expect(stored.authStyle).toBe('x-api-key');
        expect(stored.models.map((m) => m.id)).toEqual(['big-model', 'small-model']);
        expect(stored.models[1].maxTokens).toBe(2048);
    });

    it('drops a model with no id — a row still being typed — rather than keeping a blank', () => {
        writeCustomEndpoints([{ ...proxy, models: [{ id: '', supportsVision: false, reasoningEffort: false }, proxy.models[0]] }]);
        expect(readCustomEndpoints()[0].models.map((m) => m.id)).toEqual(['big-model']);
    });

    it('reads an unreadable preference as no endpoints', () => {
        prefs.customEndpoints = '{not json';
        expect(readCustomEndpoints()).toEqual([]);
        prefs.customEndpoints = JSON.stringify({ id: 'x' });
        expect(readCustomEndpoints()).toEqual([]);
    });

    it('names providers custom:<id> and finds them back', () => {
        writeCustomEndpoints([proxy]);
        expect(customProviderId('ep-1')).toBe('custom:ep-1');
        expect(parseCustomProviderId('custom:ep-1')).toBe('ep-1');
        expect(parseCustomProviderId('deepseek')).toBeNull();
        expect(isCustomProviderId('custom:')).toBe(false);
        expect(findCustomEndpoint('custom:ep-1')?.name).toBe('My proxy');
        expect(findCustomEndpoint('custom:ep-9')).toBeNull();
        expect(newEndpointId()).toMatch(/^ep-[0-9a-f]{8}$/);
    });

    it('updates one model in place and says when the model is gone', () => {
        writeCustomEndpoints([proxy]);
        expect(updateCustomModel('custom:ep-1', 'small-model', { supportsVision: true })).toBe(true);
        expect(customModelCapabilities('custom:ep-1', 'small-model')?.supportsVision).toBe(true);
        expect(updateCustomModel('custom:ep-1', 'nope', { supportsVision: true })).toBe(false);
        expect(customModelCapabilities('custom:ep-1', 'nope')).toBeNull();
    });
});

describe('running a hand-added model', () => {
    it('sends the key the way the user said, and reasoning only when the model takes it', () => {
        const fetchImpl = vi.fn();
        const big = customProviderFromEndpoint(proxy, 'big-model', fetchImpl as any, { extraBody: { reasoning_effort: 'low' } });
        expect(big.buildHeaders()).toMatchObject({ 'X-Api-Key': 'k-proxy' });
        expect(big.buildHeaders()).not.toHaveProperty('Authorization');
        const body = big.buildBody({ messages: [{ role: 'user', content: 'hi' }] } as any);
        expect(body.model).toBe('big-model');
        expect(body.reasoning_effort).toBe('low');
        expect((big as any).config.supportsVision).toBe(true);
        expect((big as any).config.baseUrl).toBe('https://proxy.example.com/v1/');

        const small = customProviderFromEndpoint(proxy, 'small-model', fetchImpl as any);
        expect((small as any).config.supportsVision).toBe(false);
        expect((small as any).config.maxTokens).toBe(2048);
        expect(small.buildBody({ messages: [{ role: 'user', content: 'hi' }] } as any)).not.toHaveProperty('reasoning_effort');
    });

    it('is configured when the endpoint and model exist, key or no key', () => {
        writeCustomEndpoints([{ ...proxy, apiKey: '' }]);
        prefs.llmProvider = 'custom:ep-1';
        prefs.llmModel = 'big-model';
        expect(isAgentConfigured()).toBe(true);
        prefs.llmModel = 'not-there';
        expect(isAgentConfigured()).toBe(false);
        prefs.llmProvider = 'custom:ep-2';
        expect(isAgentConfigured()).toBe(false);
    });

    it('builds the agent from the endpoint, honouring the thinking switch', () => {
        writeCustomEndpoints([proxy]);
        prefs.llmProvider = 'custom:ep-1';
        prefs.llmModel = 'big-model';
        prefs.reasoningEffort = 'high';
        const result = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.provider.model).toBe('big-model');
        expect((result.provider as any).buildBody({ messages: [{ role: 'user', content: 'hi' }] }).reasoning_effort).toBe('high');
        expect(providerSupportsReasoningEffort('custom:ep-1', 'big-model')).toBe(true);
        expect(providerSupportsReasoningEffort('custom:ep-1', 'small-model')).toBe(false);

        prefs.llmModel = 'small-model';
        const plain = buildAgentFromPrefs(vi.fn() as any);
        expect(plain.ok && !('reasoning_effort' in (plain.provider as any).buildBody({ messages: [{ role: 'user', content: 'hi' }] }))).toBe(true);
    });

    it('explains a synced choice whose endpoint is not on this computer', () => {
        prefs.llmProvider = 'custom:ep-1';
        prefs.llmModel = 'big-model';
        const result = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.problem.message).toMatch(/not set up on this computer/);
        expect(result.problem.needsKey).toBe(true);
    });
});

describe('in the picker', () => {
    it('files each model under the endpoint\'s name, saying what the user said about it', () => {
        writeCustomEndpoints([proxy]);
        const models = localModelsFromPrefs().filter((m) => String(m.provider) === 'custom:ep-1');
        expect(models.map((m) => m.snapshot)).toEqual(['big-model', 'small-model']);
        expect(models[0].name).toBe('My proxy · Big');
        expect(models[0].supports_vision).toBe(true);
        expect(models[1].supports_vision).toBe(false);
        expect(vendorFor(models[0])).toBe('My proxy');
        expect(rowLabel(models[0])).toBe('Big · reads figures');
        expect(rowLabel(models[1])).toBe('small-model');
        // The key never rides on the entry: it is snapshotted into a preference.
        expect(JSON.stringify(models)).not.toContain('k-proxy');
    });

    it('describes the configured custom model the same way', () => {
        writeCustomEndpoints([proxy]);
        prefs.llmProvider = 'custom:ep-1';
        prefs.llmModel = 'big-model';
        const chosen = localModelFromPrefs();
        expect(chosen?.id).toBe('local-custom:ep-1::big-model');
        expect(chosen?.name).toBe('My proxy · Big');
        expect(chosen?.supports_vision).toBe(true);
    });

    it('skips an endpoint that has no address yet', () => {
        writeCustomEndpoints([{ ...proxy, baseUrl: '' }]);
        expect(localModelsFromPrefs().some((m) => String(m.provider) === 'custom:ep-1')).toBe(false);
    });
});
