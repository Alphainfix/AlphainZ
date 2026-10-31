/**
 * Which model the composer and the run record name.
 *
 * Two things describe the selected model: `lastUsedModel`, a JSON snapshot the
 * picker writes, and `llmProvider` / `llmModel`, which the runner actually
 * reads. The picker writes both, so they normally agree — but anything that
 * moves the preferences on their own leaves the snapshot behind, and then the
 * request goes to one model while the transcript names another. Observed
 * exactly that: a run whose answer said "I am ox-alpha" recorded as DeepSeek.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    vi.resetModules();
});

async function selected() {
    const { selectedModelAtom } = await import('../../../react/atoms/models');
    const { createStore } = await import('jotai');
    return createStore().get(selectedModelAtom);
}

describe('the selected model', () => {
    it('follows the preferences when the snapshot is stale', async () => {
        // The snapshot says DeepSeek; the runner would use OpenRouter.
        prefs['lastUsedModel'] = JSON.stringify({
            id: 'local-deepseek-vision', provider: 'deepseek-vision',
            snapshot: 'deepseek-v4-flash-vision-exp', is_custom: true,
        });
        prefs['llmProvider'] = 'openrouter';
        prefs['llmModel'] = 'stealth/ox-alpha';

        const model = await selected();
        expect(model?.provider).toBe('openrouter');
        // …and a retired stored model surfaces as its successor — the same
        // mapping the runner applies, so the composer names what will answer.
        expect(model?.snapshot).toBe('z-ai/glm-5.3-flash');
    });

    it('keeps a model the user typed in, which preferences cannot rebuild', async () => {
        // Its own base URL lives on the snapshot; there is nothing in
        // llmProvider/llmModel that could reconstruct it.
        prefs['lastUsedModel'] = JSON.stringify({
            id: 'user-custom-1', provider: 'custom', snapshot: 'my-model', is_custom: true,
        });
        prefs['llmProvider'] = 'openrouter';
        prefs['llmModel'] = 'stealth/ox-alpha';

        expect((await selected())?.id).toBe('user-custom-1');
    });

    it('falls back to the snapshot when no provider is configured', async () => {
        prefs['lastUsedModel'] = JSON.stringify({
            id: 'local-deepseek-vision', provider: 'deepseek-vision', is_custom: true,
        });
        expect((await selected())?.provider).toBe('deepseek-vision');
    });

    it('is null when neither says anything', async () => {
        expect(await selected()).toBeNull();
    });
});

describe('vision flag on preset-derived models', () => {
    it('is resolved per model, so the attachment checks can tell a vision model from a text-only one', async () => {
        prefs.llmKeyOpenrouter = 'or-key';
        prefs.llmKeyDeepseek = 'ds-key';
        const { localModelsFromPrefs } = await import('../../../react/atoms/models');
        const byId = new Map(localModelsFromPrefs().map((m) => [m.id, m]));
        expect(byId.get('local-openrouter::z-ai/glm-5.3-flash')?.supports_vision).toBe(true);
        expect(byId.get('local-openrouter::deepseek/deepseek-v4.1-flash')?.supports_vision).toBe(true);
        // DeepSeek's one model reads images; Ollama's local models are declared text-only.
        expect(byId.get('local-deepseek::deepseek-flash')?.supports_vision).toBe(true);
        prefs.ollamaModels = JSON.stringify(['qwen2.5:7b']);
        const withOllama = new Map(localModelsFromPrefs().map((m) => [m.id, m]));
        expect(withOllama.get('local-ollama::qwen2.5:7b')?.supports_vision).toBe(false);
    });

    it('carries the same flag on the preferences-derived selected model', async () => {
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'qwen2.5:7b';
        const { localModelFromPrefs } = await import('../../../react/atoms/models');
        expect(localModelFromPrefs()?.supports_vision).toBe(false);
        prefs.llmProvider = 'openrouter';
        prefs.llmModel = 'z-ai/glm-5.3-flash';
        expect(localModelFromPrefs()?.supports_vision).toBe(true);
    });
});

describe('Ollama in the model list', () => {
    it('offers exactly the models Detect models found, and nothing before that', async () => {
        const { localModelsFromPrefs, ollamaModelsFromPrefs } = await import('../../../react/atoms/models');
        // Nothing detected yet: no key to gate on, but also nothing to offer.
        expect(ollamaModelsFromPrefs()).toEqual([]);
        expect(localModelsFromPrefs().filter((m) => m.provider === 'ollama')).toEqual([]);

        prefs['ollamaModels'] = JSON.stringify(['qwen3:8b', 'llama3.1:8b']);
        const ollama = localModelsFromPrefs().filter((m) => m.provider === 'ollama');
        expect(ollama.map((m) => m.snapshot)).toEqual(['qwen3:8b', 'llama3.1:8b']);
        expect(ollama[0].id).toBe('local-ollama::qwen3:8b');
        expect(ollama[0].name).toBe('Ollama (local) · qwen3:8b');
    });

    it('survives a corrupt models preference', async () => {
        const { ollamaModelsFromPrefs } = await import('../../../react/atoms/models');
        prefs['ollamaModels'] = '{not json';
        expect(ollamaModelsFromPrefs()).toEqual([]);
    });
});

describe('a fresh install with one key', () => {
    it('auto-selects a model AND persists it, so the very first message runs locally', async () => {
        // The welcome wizard stores only the key. The composer then picks the
        // first available model by itself; that choice must reach the
        // preferences the runner reads, or Send is enabled for a run that
        // ends as "no model configured".
        prefs['llmKeyDeepseek'] = 'sk-fresh';
        const { selectedModelAtom, validateSelectedModelAtom } = await import('../../../react/atoms/models');
        const { isAgentConfigured } = await import('../../../src/services/llm/agentConfig');
        const { createStore } = await import('jotai');
        const store = createStore();

        expect(isAgentConfigured()).toBe(false);
        store.set(validateSelectedModelAtom);

        const chosen = store.get(selectedModelAtom);
        expect(chosen).not.toBeNull();
        expect(chosen!.id.startsWith('local-')).toBe(true);
        expect(prefs['llmProvider']).toBe(chosen!.provider);
        expect(prefs['llmModel']).toBe(chosen!.snapshot);
        expect(isAgentConfigured()).toBe(true);
    });

    it('does not offer a model typed into the legacy custom list, since the runner cannot run it', async () => {
        // Such an entry used to sit first in the list: with no key yet it became
        // the automatic default, and because it is not a `local-` model nothing
        // reached the preferences — the first message ended as "not configured"
        // even after a key was pasted.
        prefs['customChatModels'] = JSON.stringify([{
            name: 'Mine', snapshot: 'my-model', provider: 'custom', base_url: 'http://x/v1', api_key: 'k',
        }]);
        const { selectedModelAtom, supportedModelsAtom, validateSelectedModelAtom } = await import('../../../react/atoms/models');
        const { createStore } = await import('jotai');
        const store = createStore();
        expect(store.get(supportedModelsAtom).some((m) => m.id.startsWith('custom:'))).toBe(false);
        store.set(validateSelectedModelAtom);
        expect(store.get(selectedModelAtom)).toBeNull();
        expect(prefs['llmProvider']).toBeUndefined();
    });

    it('lets a remembered custom entry give way to the configured local model', async () => {
        prefs['lastUsedModel'] = JSON.stringify({ id: 'custom:custom:my-model:Mine', provider: 'custom', snapshot: 'my-model', name: 'Mine', is_custom: true });
        prefs['llmKeyDeepseek'] = 'sk-fresh';
        const { selectedModelAtom, validateSelectedModelAtom } = await import('../../../react/atoms/models');
        const { createStore } = await import('jotai');
        const store = createStore();
        store.set(validateSelectedModelAtom);
        const chosen = store.get(selectedModelAtom);
        expect(chosen?.id.startsWith('local-deepseek')).toBe(true);
        expect(prefs['llmProvider']).toBe('deepseek');
    });
});
