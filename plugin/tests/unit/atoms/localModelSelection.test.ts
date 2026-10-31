/**
 * The model shown in the composer has to be the model the runner will call.
 *
 * The local runner reads the provider and model straight from preferences,
 * while the composer renders `selectedModelAtom`. Nothing links the two on its
 * own, so the settings panel calls `refreshLocalModelAtom` after every change —
 * without it the label would keep advertising the previous model while requests
 * went to the new one.
 */
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;

/** Preference store backing the Zotero stub for one test. */
let prefs: Record<string, unknown> = {};

beforeEach(() => {
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => {
        prefs[key] = value;
    });
    vi.resetModules();
});

const setPrefs = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
        prefs[`${PREFIX}.${key}`] = value;
    }
};

/** Import `models.ts` fresh, so its module-scope preference reads see `prefs`. */
const loadModels = () => import('../../../react/atoms/models');

describe('local model selection', () => {
    it('has no model to offer until a provider is configured', async () => {
        const { localModelFromPrefs } = await loadModels();
        expect(localModelFromPrefs()).toBeNull();
    });

    it('describes the configured provider and model', async () => {
        setPrefs({ llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash' });
        const { localModelFromPrefs } = await loadModels();

        const model = localModelFromPrefs();
        expect(model).toMatchObject({
            id: 'local-openrouter::z-ai/glm-5.3-flash',
            provider: 'openrouter',
            snapshot: 'z-ai/glm-5.3-flash',
            // No credits are involved: the call is made from this client with
            // the user's own key.
            credit_cost: 0,
            allow_app_key: false,
        });
        expect(model!.name).toContain('z-ai/glm-5.3-flash');
    });

    it('selects the configured model at startup', async () => {
        setPrefs({ llmProvider: 'deepseek', llmModel: 'deepseek-flash' });
        const { selectedModelAtom } = await loadModels();

        expect(createStore().get(selectedModelAtom)).toMatchObject({
            id: 'local-deepseek::deepseek-flash',
            snapshot: 'deepseek-flash',
        });
    });

    it('follows a provider change made after startup', async () => {
        setPrefs({ llmProvider: 'deepseek', llmModel: 'deepseek-flash' });
        const { refreshLocalModelAtom, selectedModelAtom } = await loadModels();
        const { setPref } = await import('../../../src/utils/prefs');
        const store = createStore();

        setPref('llmProvider', 'openrouter');
        setPref('llmModel', 'z-ai/glm-5.3-flash');
        store.set(refreshLocalModelAtom);

        expect(store.get(selectedModelAtom)).toMatchObject({
            id: 'local-openrouter::z-ai/glm-5.3-flash',
            snapshot: 'z-ai/glm-5.3-flash',
        });
    });

    it('replaces the local entries instead of stacking ghosts', async () => {
        setPrefs({ llmProvider: 'deepseek', llmModel: 'deepseek-flash', llmKeyDeepseek: 'k' });
        const { refreshLocalModelAtom, supportedModelsAtom } = await loadModels();
        const store = createStore();

        store.set(refreshLocalModelAtom);
        const first = store.get(supportedModelsAtom).filter((m) => m.id.startsWith('local-'));
        store.set(refreshLocalModelAtom);
        const second = store.get(supportedModelsAtom).filter((m) => m.id.startsWith('local-'));

        expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
        expect(new Set(second.map((m) => m.id)).size).toBe(second.length);
    });

    it('lists every model the stored keys reach, not just the selected one', async () => {
        // The composer's list used to hold one entry — whichever provider the
        // settings panel had last written — so a configured OpenRouter key was
        // invisible there and switching model meant a trip to settings.
        setPrefs({
            llmProvider: 'deepseek',
            llmModel: 'deepseek-flash',
            llmKeyDeepseek: 'k1',
            llmKeyOpenrouter: 'k2',
        });
        const { refreshLocalModelAtom, supportedModelsAtom } = await loadModels();
        const store = createStore();
        store.set(refreshLocalModelAtom);

        const providers = new Set(
            store.get(supportedModelsAtom)
                .filter((m) => m.id.startsWith('local-'))
                .map((m) => m.provider),
        );
        expect(providers).toContain('openrouter');
        expect(providers).toContain('deepseek');
        // No key for OpenAI, so nothing that would fail on send is offered.
        expect(providers).not.toContain('openai');
    });

    it('writes the pair the runner reads when a model is picked in the composer', async () => {
        // Selecting in the composer used to move a label and nothing else, so
        // the next request still went to the previous model.
        setPrefs({ llmProvider: 'deepseek', llmModel: 'deepseek-flash', llmKeyOpenrouter: 'k' });
        const { updateSelectedModelAtom } = await loadModels();
        createStore().set(updateSelectedModelAtom, {
            id: 'local-openrouter::z-ai/glm-5.3-flash',
            provider: 'openrouter',
            snapshot: 'z-ai/glm-5.3-flash',
            name: 'OpenRouter · z-ai/glm-5.3-flash',
            is_custom: true,
        } as any);

        expect(prefs[`${PREFIX}.llmProvider`]).toBe('openrouter');
        expect(prefs[`${PREFIX}.llmModel`]).toBe('z-ai/glm-5.3-flash');
    });

    it('remembers the choice across a restart', async () => {
        setPrefs({ llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash' });
        const { refreshLocalModelAtom } = await loadModels();
        createStore().set(refreshLocalModelAtom);

        expect(JSON.parse(prefs[`${PREFIX}.lastUsedModel`] as string)).toMatchObject({
            id: 'local-openrouter::z-ai/glm-5.3-flash',
        });
    });

    it('names no model once the provider is cleared and nothing else can run', async () => {
        // The composer then reads "None Selected" and the home page says no
        // model is set up, instead of naming a model nothing here can run.
        setPrefs({ llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash' });
        const { refreshLocalModelAtom, selectedModelAtom } = await loadModels();
        const { setPref } = await import('../../../src/utils/prefs');
        const store = createStore();
        expect(store.get(selectedModelAtom)).toMatchObject({ id: 'local-openrouter::z-ai/glm-5.3-flash' });

        setPref('llmProvider', '');
        store.set(refreshLocalModelAtom);

        expect(store.get(selectedModelAtom)).toBeNull();
    });

    it('keeps a selection that is still on offer when the provider is cleared', async () => {
        setPrefs({ llmKeyOpenrouter: 'k', llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash' });
        const { refreshLocalModelAtom, selectedModelAtom } = await loadModels();
        const { setPref } = await import('../../../src/utils/prefs');
        const store = createStore();

        setPref('llmProvider', '');
        store.set(refreshLocalModelAtom);

        expect(store.get(selectedModelAtom)).toMatchObject({ id: 'local-openrouter::z-ai/glm-5.3-flash' });
    });
});
