/**
 * The picker starts on the model that is actually configured.
 *
 * `localModelFromPrefs` synthesises `local-deepseek`; the picker's list is
 * built by `localModelsFromPrefs`, whose ids read `local-deepseek::deepseek-
 * v4-flash`. Both describe the same model and neither matches the other, so on
 * every start the menu could not find the current entry to mark — the settings
 * page said one thing and the picker showed another.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const PREFS: Record<string, any> = {};

beforeEach(() => {
    for (const key of Object.keys(PREFS)) delete PREFS[key];
    (Zotero.Prefs as any).get = (key: string) => PREFS[key.split('.').pop() as string];
    (Zotero.Prefs as any).set = (key: string, value: any) => {
        PREFS[key.split('.').pop() as string] = value;
    };
    vi.resetModules();
});

async function selectedModel(prefs: Record<string, any>) {
    Object.assign(PREFS, prefs);
    const models = await import('../../../react/atoms/models');
    const { createStore } = await import('jotai');
    return createStore().get(models.selectedModelAtom);
}

describe('which model the composer starts on', () => {
    it('is the list entry for the configured provider and model', async () => {
        const model = await selectedModel({
            llmKeyDeepseek: 'sk-test', llmProvider: 'deepseek', llmModel: 'deepseek-flash',
        });
        expect(model?.provider).toBe('deepseek');
        expect(model?.snapshot).toBe('deepseek-flash');
        // The id has to be the list's, or the menu cannot mark it.
        expect(model?.id).toBe('local-deepseek::deepseek-flash');
    });

    it('survives the round trip the picker writes', async () => {
        // The picker writes llmProvider/llmModel; the next launch reads them.
        const first = await selectedModel({
            llmKeyOpenrouter: 'sk-or', llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash',
        });
        expect(first?.id).toBe('local-openrouter::z-ai/glm-5.3-flash');
        vi.resetModules();
        const second = await selectedModel({
            llmKeyOpenrouter: 'sk-or', llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash',
        });
        expect(second?.id).toBe(first?.id);
    });

    it('lands a retired stored model on the provider default, not a ghost entry', async () => {
        // `stealth/ox-alpha` left OpenRouter's roster on 2026-08-26. A stored
        // preference naming it must not synthesise a picker entry for a model
        // that no longer answers; the provider-default entry (its successor)
        // is what the runner will actually use, and the composer must say so.
        const model = await selectedModel({
            llmKeyOpenrouter: 'sk-or', llmProvider: 'openrouter', llmModel: 'stealth/ox-alpha',
        });
        // Mapped snapshot matches a real list entry, so the canonical `::` id
        // is what the composer lands on.
        expect(model?.id).toBe('local-openrouter::z-ai/glm-5.3-flash');
        expect(model?.snapshot).toBe('z-ai/glm-5.3-flash');
    });

    it('falls back to the synthesised entry when the key is missing', async () => {
        // No key means the provider is not in the list at all, but the run path
        // still reads the preferences — so the composer must name what will
        // actually answer rather than showing nothing.
        const model = await selectedModel({ llmProvider: 'deepseek', llmModel: 'deepseek-flash' });
        expect(model?.provider).toBe('deepseek');
        expect(model?.snapshot).toBe('deepseek-flash');
    });
});
