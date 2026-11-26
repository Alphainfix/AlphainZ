/**
 * A stored choice that names a retired provider or model runs as its successor.
 *
 * DeepSeek replaced its V4 line with `deepseek-flash` on 2026-09-10 and folded
 * the vision preset away; a preference written last week still has to open the
 * composer on a model that exists, and send requests under the new name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { KEY_PREF_BY_PROVIDER, buildAgentFromPrefs, isAgentConfigured } from '../../../src/services/llm/agentConfig';
import { PROVIDER_PRESETS, RETIRED_MODELS, retireChoice } from '@beaver/agent-llm/openAICompatible';
import { localModelFromPrefs, localModelsFromPrefs } from '../../../react/atoms/models';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('retireChoice', () => {
    it('maps every retired DeepSeek id, and the vision preset, to deepseek-flash', () => {
        for (const old of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash']) {
            expect(retireChoice('deepseek', old)).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
        }
        expect(retireChoice('deepseek-vision', 'deepseek-v4-flash-vision-exp')).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    });

    it('maps the retired OpenRouter ids, and leaves everything else alone', () => {
        expect(retireChoice('openrouter', 'deepseek/deepseek-v4-flash')).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' });
        expect(retireChoice('openrouter', 'stealth/ox-alpha')).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash' });
        expect(retireChoice('openai', 'gpt-4o-mini')).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
        expect(retireChoice('custom:ep-1', 'deepseek-v4-pro')).toEqual({ provider: 'custom:ep-1', model: 'deepseek-flash' });
        expect(Object.values(RETIRED_MODELS).every((id) => !(id in RETIRED_MODELS))).toBe(true);
    });

    it('leaves an id alone on a provider that still serves it', () => {
        // OpenCode Go still lists ids DeepSeek's own API retired.
        for (const live of ['deepseek-v4.1-flash', 'deepseek-v4-pro']) {
            expect(PROVIDER_PRESETS['opencode-go'].models).toContain(live);
            expect(retireChoice('opencode-go', live)).toEqual({ provider: 'opencode-go', model: live });
        }
        // ...while on DeepSeek's own API the same ids still resolve to their successor.
        expect(retireChoice('deepseek', 'deepseek-v4.1-flash')).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
        // And no preset's own model is ever renamed into another id.
        for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
            for (const model of (preset as { models?: readonly string[] }).models ?? []) {
                expect(retireChoice(id, model).model).toBe(model);
            }
        }
    });

    it('has no vision preset left, and the DeepSeek preset carries one model that reads images', () => {
        expect('deepseek-vision' in PROVIDER_PRESETS).toBe(false);
        expect('deepseek-vision' in KEY_PREF_BY_PROVIDER).toBe(false);
        expect(PROVIDER_PRESETS.deepseek.models).toEqual(['deepseek-flash']);
        expect(PROVIDER_PRESETS.deepseek.supportsVision).toBe(true);
    });
});

describe('a preference from before the change', () => {
    beforeEach(() => {
        prefs.llmKeyDeepseek = 'k';
        prefs.llmProvider = 'deepseek-vision';
        prefs.llmModel = 'deepseek-v4-flash-vision-exp';
    });

    it('is configured, and shows in the composer as DeepSeek · deepseek-flash', () => {
        expect(isAgentConfigured()).toBe(true);
        const chosen = localModelFromPrefs();
        expect(chosen?.id).toBe('local-deepseek::deepseek-flash');
        expect(chosen?.name).toBe('DeepSeek · deepseek-flash');
        expect(chosen?.supports_vision).toBe(true);
        // ...and that entry is the one the list offers, so the picker can mark it.
        expect(localModelsFromPrefs().some((m) => m.id === 'local-deepseek::deepseek-flash')).toBe(true);
        expect(localModelsFromPrefs().some((m) => String(m.snapshot).includes('v4'))).toBe(false);
    });

    it('runs against deepseek-flash at DeepSeek\'s endpoint', () => {
        const result = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.provider.model).toBe('deepseek-flash');
        expect((result.provider as any).config.baseUrl).toBe('https://api.deepseek.com/v1');
        expect((result.provider as any).config.supportsVision).toBe(true);
    });
});
