/**
 * The model choice stays one that can answer.
 *
 * - A hand-added endpoint set up on two computers is recognised on both, even
 *   though each drew its own id, and the synced choice stops flipping.
 * - An Ollama embedding model is never offered or picked as a chat model.
 * - Removing, on this computer, the provider in use moves the choice to one
 *   that is still configured; with none left, the composer names no model.
 */
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { buildAgentFromPrefs } from '../../../src/services/llm/agentConfig';
import {
    adoptSyncedEndpointId,
    findCustomEndpoint,
    readCustomEndpoints,
    writeCustomEndpoints,
    type CustomEndpoint,
} from '../../../src/services/llm/customEndpoints';

const relay = (id: string, models = ['relay-model']): CustomEndpoint => ({
    id,
    name: 'Lab relay',
    baseUrl: 'https://relay.example.edu/v1',
    apiKey: `key-${id}`,
    authStyle: 'bearer',
    models: models.map((m) => ({ id: m, supportsVision: false, reasoningEffort: false })),
});

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
    vi.resetModules();
});

const loadModels = () => import('../../../react/atoms/models');

describe('a custom endpoint set up by hand on two computers', () => {
    it('answers the other computer\'s synced choice with this computer\'s endpoint', () => {
        // This laptop added the relay itself (ep-laptop); the desktop's choice synced in.
        writeCustomEndpoints([relay('ep-laptop')]);
        prefs.llmProvider = 'custom:ep-desktop';
        prefs.llmModel = 'relay-model';

        expect(findCustomEndpoint('custom:ep-desktop')?.id).toBe('ep-laptop');
        const built = buildAgentFromPrefs(vi.fn() as any);
        expect(built.ok).toBe(true);
        // …with this computer's own key and address.
        expect(built.ok && (built.provider as any).config.apiKey).toBe('key-ep-laptop');
    });

    it('guesses nothing when two endpoints here list the model', () => {
        writeCustomEndpoints([relay('ep-a'), { ...relay('ep-b'), name: 'Other relay', baseUrl: 'https://other.example/v1' }]);
        prefs.llmProvider = 'custom:ep-desktop';
        prefs.llmModel = 'relay-model';

        expect(findCustomEndpoint('custom:ep-desktop')).toBeNull();
        const built = buildAgentFromPrefs(vi.fn() as any);
        expect(built.ok).toBe(false);
        expect(!built.ok && built.problem.message).toMatch(/not set up on this computer/);
        expect(adoptSyncedEndpointId('custom:ep-desktop', 'relay-model')).toBe(false);
    });

    it('files this computer\'s endpoint under the synced id, so the picker lists it once and nothing flips back', async () => {
        writeCustomEndpoints([relay('ep-laptop')]);
        prefs.llmProvider = 'custom:ep-desktop';
        prefs.llmModel = 'relay-model';
        const { refreshLocalModelAtom, selectedModelAtom, supportedModelsAtom } = await loadModels();
        const store = createStore();

        store.set(refreshLocalModelAtom);

        expect(readCustomEndpoints().map((e) => e.id)).toEqual(['ep-desktop']);
        const listed = store.get(supportedModelsAtom).filter((m) => m.snapshot === 'relay-model');
        expect(listed.map((m) => m.id)).toEqual(['local-custom:ep-desktop::relay-model']);
        expect(store.get(selectedModelAtom)?.id).toBe('local-custom:ep-desktop::relay-model');
        // The choice written back is the one both computers now recognise.
        expect(prefs.llmProvider).toBe('custom:ep-desktop');
    });

    it('leaves an endpoint alone once its id is the one chosen', () => {
        writeCustomEndpoints([relay('ep-desktop')]);
        expect(adoptSyncedEndpointId('custom:ep-desktop', 'relay-model')).toBe(false);
        expect(adoptSyncedEndpointId('custom:../etc', 'relay-model')).toBe(false);
    });

    it('lets something that read the endpoint before the rename find it under its id now', async () => {
        const { adoptSyncedEndpointId: adopt, currentEndpointId } = await import('../../../src/services/llm/customEndpoints');
        writeCustomEndpoints([relay('ep-laptop')]);
        expect(adopt('custom:ep-desktop', 'relay-model')).toBe(true);
        expect(currentEndpointId('ep-laptop')).toBe('ep-desktop');
        expect(currentEndpointId('ep-desktop')).toBe('ep-desktop');
        // A later choice names the first id again: both lead to the id in use now.
        expect(adopt('custom:ep-laptop', 'relay-model')).toBe(true);
        expect(currentEndpointId('ep-laptop')).toBe('ep-laptop');
        expect(currentEndpointId('ep-desktop')).toBe('ep-laptop');
        expect(currentEndpointId('ep-other')).toBe('ep-other');
    });
});

describe('Ollama embedding models', () => {
    it('are not listed as chat models, even from a list stored before they were told apart', async () => {
        prefs.ollamaModels = JSON.stringify(['bge-m3:latest', 'qwen2.5:7b']);
        const { localModelsFromPrefs, ollamaModelsFromPrefs } = await loadModels();
        expect(ollamaModelsFromPrefs()).toEqual(['qwen2.5:7b']);
        expect(localModelsFromPrefs().map((m) => m.id)).toEqual(['local-ollama::qwen2.5:7b']);
    });

    it('are never picked as the chat model on a fresh install', async () => {
        // bge-m3 finished downloading first; Ollama lists the newest first.
        prefs.ollamaModels = JSON.stringify(['bge-m3:latest']);
        const { refreshLocalModelAtom } = await loadModels();
        const store = createStore();
        store.set(refreshLocalModelAtom);
        expect(prefs.llmProvider ?? '').toBe('');

        prefs.ollamaModels = JSON.stringify(['bge-m3:latest', 'qwen2.5:7b']);
        store.set(refreshLocalModelAtom);
        expect(prefs.llmProvider).toBe('ollama');
        expect(prefs.llmModel).toBe('qwen2.5:7b');
    });

    it('leave nothing selected when the embedding model was the only one there', async () => {
        prefs.ollamaModels = JSON.stringify(['bge-m3:latest']);
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'bge-m3:latest';
        const { refreshLocalModelAtom, selectedModelAtom } = await loadModels();
        const store = createStore();
        store.set(refreshLocalModelAtom);
        expect(prefs.llmProvider).toBe('');
        expect(store.get(selectedModelAtom)).toBeNull();
    });

    it('give way to a chat model when one was already stored as the choice', async () => {
        prefs.ollamaModels = JSON.stringify(['bge-m3:latest', 'qwen2.5:7b']);
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'bge-m3:latest';
        const { refreshLocalModelAtom, selectedModelAtom } = await loadModels();
        const store = createStore();
        store.set(refreshLocalModelAtom);
        expect(prefs.llmModel).toBe('qwen2.5:7b');
        expect(store.get(selectedModelAtom)?.id).toBe('local-ollama::qwen2.5:7b');
    });
});

describe('removing the provider in use on this computer', () => {
    it('moves the choice to a provider that is still configured', async () => {
        prefs.llmKeyOpenrouter = 'k-or';
        prefs.llmKeyDeepseek = 'k-d';
        prefs.llmProvider = 'openrouter';
        prefs.llmModel = 'z-ai/glm-5.3-flash';
        const { modelAfterRemoving, releaseRemovedProvidersAtom } = await loadModels();
        expect(modelAfterRemoving(['openrouter'])?.id).toBe('local-deepseek::deepseek-flash');

        prefs.llmKeyOpenrouter = '';
        createStore().set(releaseRemovedProvidersAtom, ['openrouter']);
        expect(prefs.llmProvider).toBe('deepseek');
        expect(prefs.llmModel).toBe('deepseek-flash');
    });

    it('leaves a choice that used another provider alone', async () => {
        prefs.llmKeyOpenrouter = 'k-or';
        prefs.llmKeyDeepseek = 'k-d';
        prefs.llmProvider = 'openrouter';
        prefs.llmModel = 'deepseek/deepseek-v4.1-flash';
        const { releaseRemovedProvidersAtom } = await loadModels();
        prefs.llmKeyDeepseek = '';
        createStore().set(releaseRemovedProvidersAtom, ['deepseek']);
        expect(prefs.llmProvider).toBe('openrouter');
        expect(prefs.llmModel).toBe('deepseek/deepseek-v4.1-flash');
    });

    it('clears the choice when nothing else is configured, so the composer says to add one', async () => {
        prefs.llmKeyOpenrouter = 'k-or';
        prefs.llmProvider = 'openrouter';
        prefs.llmModel = 'z-ai/glm-5.3-flash';
        const { modelAfterRemoving, releaseRemovedProvidersAtom } = await loadModels();
        expect(modelAfterRemoving(['openrouter'])).toBeNull();
        prefs.llmKeyOpenrouter = '';
        createStore().set(releaseRemovedProvidersAtom, ['openrouter']);
        expect(prefs.llmProvider).toBe('');
        const built = buildAgentFromPrefs(vi.fn() as any);
        expect(!built.ok && built.problem.message).toMatch(/No model is set up yet/);
    });

    it('stops naming the removed model in the composer, then and after a restart', async () => {
        prefs.llmKeyOpenrouter = 'k-or';
        prefs.llmProvider = 'openrouter';
        prefs.llmModel = 'z-ai/glm-5.3-flash';
        const { refreshLocalModelAtom, releaseRemovedProvidersAtom, selectedModelAtom } = await loadModels();
        const store = createStore();
        store.set(refreshLocalModelAtom);
        expect(store.get(selectedModelAtom)?.id).toBe('local-openrouter::z-ai/glm-5.3-flash');
        expect(String(prefs.lastUsedModel)).toContain('z-ai/glm-5.3-flash');

        prefs.llmKeyOpenrouter = '';
        store.set(releaseRemovedProvidersAtom, ['openrouter']);
        expect(store.get(selectedModelAtom)).toBeNull();
        expect(prefs.lastUsedModel).toBe('');

        vi.resetModules();
        const restarted = await loadModels();
        expect(createStore().get(restarted.selectedModelAtom)).toBeNull();
    });
});
