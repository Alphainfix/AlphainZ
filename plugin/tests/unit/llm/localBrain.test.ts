/**
 * Two questions that used to be one.
 *
 * `isLocalBrain()` — where conversations live — is always "here": this build
 * has no account. `isAgentConfigured()` — can a model answer right now — is
 * not. Conflating them routed a fresh or freshly-synced install (model choice
 * synced, key not) to a sign-in server that does not exist, and the user saw
 * "Connection Failed" instead of "paste your key on this computer".
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
    buildAgentFromPrefs,
    isAgentConfigured,
    isLocalBrain,
    ollamaApiBaseUrl,
} from '../../../src/services/llm/agentConfig';
import { PROVIDER_PRESETS, presetSupportsVision } from '../../../src/services/llm/openAICompatible';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('isLocalBrain', () => {
    it('is true regardless of whether a model is configured', () => {
        expect(isLocalBrain()).toBe(true);
        prefs.llmProvider = 'deepseek';
        expect(isLocalBrain()).toBe(true);
    });
});

describe('a synced model choice without its key', () => {
    it('is not configured, and says the key lives on this computer', () => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        expect(isAgentConfigured()).toBe(false);
        const config = buildAgentFromPrefs((() => { throw new Error('no network expected'); }) as any);
        expect(config.ok).toBe(false);
        if (!config.ok) {
            expect(config.problem.needsKey).toBe(true);
            expect(config.problem.message).toMatch(/on this computer/);
            expect(config.problem.message).toMatch(/Settings/);
        }
    });
});

describe('Ollama as a chat provider', () => {
    it('is a keyless preset, text-only', () => {
        expect(PROVIDER_PRESETS.ollama.baseUrl).toBe('http://127.0.0.1:11434/v1');
        expect(KEY_PREF_BY_PROVIDER.ollama).toBeNull();
        expect(presetSupportsVision('ollama')).toBe(false);
    });

    it('counts as configured with no key at all', () => {
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'qwen3:8b';
        expect(isAgentConfigured()).toBe(true);
    });

    it('derives the OpenAI-compatible root from the address the user typed', () => {
        expect(ollamaApiBaseUrl()).toBe('http://127.0.0.1:11434/v1');
        prefs.ollamaBaseUrl = 'http://192.168.1.20:11434/';
        expect(ollamaApiBaseUrl()).toBe('http://192.168.1.20:11434/v1');
        prefs.ollamaBaseUrl = 'http://192.168.1.20:11434/v1';
        expect(ollamaApiBaseUrl()).toBe('http://192.168.1.20:11434/v1');
    });
});
