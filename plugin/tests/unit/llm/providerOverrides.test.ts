/**
 * A built-in provider's address and catalogue can be edited, per provider.
 *
 * The previous shape — one global base URL and one "model not listed?" box —
 * applied to whichever provider was selected at the time. Edits now live on
 * the provider they belong to, and reach the picker and the run together.
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
    baseUrlOverrideFor,
    catalogueFor,
    catalogueIsCustom,
    defaultCatalogue,
    hydrateProviderOverrides,
    readProviderOverrides,
    updateProviderOverride,
    writeProviderOverrides,
} from '../../../src/services/llm/providerOverrides';
import { fetchModelIds } from '../../../src/services/llm/listModels';
import { buildAgentFromPrefs } from '../../../src/services/llm/agentConfig';
import { presetSupportsVision, recordProbedVision, resetDeclaredVision, resetProbedVision } from '../../../src/services/llm/openAICompatible';
import { localModelsFromPrefs } from '../../../react/atoms/models';
import { rowLabel } from '../../../react/components/ui/buttons/ModelSelectionButton';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    resetProbedVision();
    resetDeclaredVision();
});

describe('the override store', () => {
    it('keeps only what changed, normalised, for presets that exist', () => {
        writeProviderOverrides({
            deepseek: { baseUrl: 'https://proxy.example.com/v1/', models: [{ id: ' deepseek-v4.1-flash ', label: 'V4.1', supportsVision: true }, { id: '' }] },
            openai: {},
            nonsense: { baseUrl: 'x' },
        } as any);
        const stored = readProviderOverrides();
        expect(Object.keys(stored)).toEqual(['deepseek']);
        expect(stored.deepseek?.baseUrl).toBe('https://proxy.example.com/v1');
        expect(stored.deepseek?.models).toEqual([{ id: 'deepseek-v4.1-flash', label: 'V4.1', supportsVision: true }]);
    });

    it('falls back to the preset catalogue until the user replaces it — even with an empty list', () => {
        expect(catalogueFor('deepseek')).toEqual(defaultCatalogue('deepseek'));
        expect(defaultCatalogue('deepseek').map((m) => m.id)).toEqual(['deepseek-flash']);
        expect(catalogueIsCustom('deepseek')).toBe(false);
        updateProviderOverride('deepseek', { models: [] });
        expect(catalogueFor('deepseek')).toEqual([]);
        expect(catalogueIsCustom('deepseek')).toBe(true);
        updateProviderOverride('deepseek', null);
        expect(catalogueIsCustom('deepseek')).toBe(false);
    });

    it('reads an unreadable preference as no overrides', () => {
        prefs.providerOverrides = '[1,2';
        expect(readProviderOverrides()).toEqual({});
        prefs.providerOverrides = '[]';
        expect(readProviderOverrides()).toEqual({});
    });
});

describe('what the overrides change', () => {
    it('lists the edited catalogue in the picker, with its labels and declared vision', () => {
        prefs.llmKeyDeepseek = 'k';
        writeProviderOverrides({ deepseek: { models: [{ id: 'deepseek-flash', label: 'Flash' }, { id: 'deepseek-legacy', supportsVision: false }] } });
        const rows = localModelsFromPrefs().filter((m) => String(m.provider) === 'deepseek');
        expect(rows.map((m) => m.snapshot)).toEqual(['deepseek-flash', 'deepseek-legacy']);
        expect(rows[0].name).toBe('DeepSeek · Flash');
        // No flag on the first row: the preset's own answer (reads images) stands.
        expect(rows[0].supports_vision).toBe(true);
        expect(rows[1].supports_vision).toBe(false);
        expect(rowLabel(rows[0])).toBe('Flash · reads figures');
        expect(rowLabel(rows[1])).toBe('deepseek-legacy');
    });

    it('lets a Check outrank a declared flag, and a declared flag outrank the preset', () => {
        // Ollama declares no vision; a declared "yes" on one of its models lifts it.
        writeProviderOverrides({ ollama: { models: [{ id: 'llava:7b', supportsVision: true }] } });
        hydrateProviderOverrides();
        expect(presetSupportsVision('ollama', 'llava:7b')).toBe(true);
        recordProbedVision('ollama', 'llava:7b', false);
        expect(presetSupportsVision('ollama', 'llava:7b')).toBe(false);
        // A declared "no" on a vision preset's model turns it off too.
        writeProviderOverrides({ deepseek: { models: [{ id: 'deepseek-flash', supportsVision: false }] } });
        hydrateProviderOverrides();
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(false);
    });

    it('sends the run to the provider\'s own address override', () => {
        prefs.llmKeyOpenai = 'k';
        prefs.llmProvider = 'openai';
        prefs.llmModel = 'mock-1';
        writeProviderOverrides({ openai: { baseUrl: 'http://127.0.0.1:8765/v1', models: [{ id: 'mock-1' }] } });
        const result = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect((result.provider as any).config.baseUrl).toBe('http://127.0.0.1:8765/v1');
        expect(result.provider.model).toBe('mock-1');
        expect(baseUrlOverrideFor('openai')).toBe('http://127.0.0.1:8765/v1');
        // Another provider is untouched by it.
        expect(baseUrlOverrideFor('deepseek')).toBe('');
    });

    it('still honours the legacy global address when the provider has none of its own', () => {
        prefs.llmKeyOpenai = 'k';
        prefs.llmProvider = 'openai';
        prefs.llmModel = 'gpt-4o-mini';
        prefs.llmBaseUrl = 'https://legacy.example.com/v1';
        const result = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok && (result.provider as any).config.baseUrl).toBe('https://legacy.example.com/v1');
    });
});

describe('fetchModelIds', () => {
    it('reads the OpenAI listing shape, sorted and de-duplicated, sending the key as asked', async () => {
        const calls: any[] = [];
        const fetchImpl = vi.fn(async (url: string, init: any) => {
            calls.push({ url, init });
            return { status: 200, text: async () => JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }] }) };
        });
        expect(await fetchModelIds({ baseUrl: 'https://x.example.com/v1/', apiKey: 'k', authStyle: 'x-api-key' }, fetchImpl as any)).toEqual(['a-model', 'b-model']);
        expect(calls[0].url).toBe('https://x.example.com/v1/models');
        expect(calls[0].init.headers).toEqual({ 'X-Api-Key': 'k' });
    });

    it('sends no auth header without a key, and explains a refusal', async () => {
        const noKey = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ data: [{ id: 'm' }] }) }));
        await fetchModelIds({ baseUrl: 'http://127.0.0.1:8765/v1', apiKey: '' }, noKey as any);
        expect((noKey.mock.calls[0] as any)[1].headers).toEqual({});
        const refused = vi.fn(async () => ({ status: 401, text: async () => JSON.stringify({ error: { message: 'bad key' } }) }));
        await expect(fetchModelIds({ baseUrl: 'https://x/v1', apiKey: 'k' }, refused as any)).rejects.toThrow(/bad key/);
    });
});
