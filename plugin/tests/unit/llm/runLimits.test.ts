/**
 * The limits on one question come from Settings, sanitized.
 *
 * Each limit was a constant; each stopped real questions short. The settings
 * decide now, and what reaches the run is always a usable number: a stored
 * value from another machine, a hand edit or a missing pref must not become a
 * zero-step run or an unbounded one.
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
    DEFAULT_MAX_LIBRARY_SEARCHES,
    DEFAULT_MAX_LITERATURE_LOOKUPS,
    DEFAULT_MAX_MODEL_REQUESTS,
    formatTokenCount,
    readRunLimits,
    resolveOutputTokens,
} from '../../../src/services/llm/runLimits';
import { buildAgentFromPrefs } from '../../../src/services/llm/agentConfig';
import { buildSystemPrompt } from '../../../src/services/llm/systemPrompt';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('readRunLimits', () => {
    it('falls back to the defaults when nothing is set', () => {
        expect(readRunLimits()).toEqual({
            outputTokens: 'auto',
            modelRequests: DEFAULT_MAX_MODEL_REQUESTS,
            librarySearches: DEFAULT_MAX_LIBRARY_SEARCHES,
            literatureLookups: DEFAULT_MAX_LITERATURE_LOOKUPS,
        });
        expect([DEFAULT_MAX_MODEL_REQUESTS, DEFAULT_MAX_LIBRARY_SEARCHES, DEFAULT_MAX_LITERATURE_LOOKUPS]).toEqual([24, 20, 20]);
    });

    it('reads what the user chose', () => {
        Object.assign(prefs, { maxOutputTokens: 64000, maxModelRequests: 60, maxLibrarySearches: 20, maxLiteratureLookups: 10 });
        expect(readRunLimits()).toEqual({ outputTokens: 64000, modelRequests: 60, librarySearches: 20, literatureLookups: 10 });
    });

    it('reads 0 as "provider default" for output and "no limit" for searches', () => {
        Object.assign(prefs, { maxOutputTokens: 0, maxLibrarySearches: 0, maxLiteratureLookups: 0 });
        const limits = readRunLimits();
        expect(limits.outputTokens).toBe('auto');
        expect(limits.librarySearches).toBeNull();
        expect(limits.literatureLookups).toBeNull();
    });

    it('never lets the request limit reach zero or run away', () => {
        // Every request is billed; an unbounded loop would bill without end.
        prefs.maxModelRequests = 0;
        expect(readRunLimits().modelRequests).toBe(DEFAULT_MAX_MODEL_REQUESTS);
        prefs.maxModelRequests = 1;
        expect(readRunLimits().modelRequests).toBe(4);
        prefs.maxModelRequests = 100_000;
        expect(readRunLimits().modelRequests).toBe(200);
    });

    it('treats junk as unset', () => {
        Object.assign(prefs, { maxOutputTokens: 'lots', maxModelRequests: null, maxLibrarySearches: -3, maxLiteratureLookups: undefined });
        expect(readRunLimits()).toEqual({
            outputTokens: 'auto',
            modelRequests: DEFAULT_MAX_MODEL_REQUESTS,
            librarySearches: DEFAULT_MAX_LIBRARY_SEARCHES,
            literatureLookups: DEFAULT_MAX_LITERATURE_LOOKUPS,
        });
    });
});

describe('resolveOutputTokens', () => {
    it('takes the provider default on auto, and the choice otherwise', () => {
        expect(resolveOutputTokens('auto', 32_000, 393_216)).toBe(32_000);
        expect(resolveOutputTokens(64_000, 32_000, 393_216)).toBe(64_000);
    });

    it('holds a choice to what the provider accepts', () => {
        // A request over the ceiling is a 400 on every provider measured.
        expect(resolveOutputTokens(128_000, 16_000, 16_384)).toBe(16_384);
    });

    it('passes a choice through when the ceiling is unknown', () => {
        expect(resolveOutputTokens(64_000, 4_000)).toBe(64_000);
    });

    it('reads a count the way a warning should', () => {
        expect(formatTokenCount(32_000)).toBe('32k');
        expect(formatTokenCount(393_216)).toBe('393k');
        expect(formatTokenCount(512)).toBe('512');
    });
});

describe('the output cap a run actually sends', () => {
    const maxTokensFor = (provider: string, key: string, extra: Record<string, unknown> = {}) => {
        Object.assign(prefs, { llmProvider: provider, [key]: 'k', ...extra });
        const result = buildAgentFromPrefs(vi.fn() as any);
        if (!result.ok) throw new Error(result.problem.message);
        return { sent: (result.provider as any).config.maxTokens, reported: result.outputTokenLimit };
    };

    it('gives a thinking model room to think and still answer', () => {
        // 8,000 on DeepSeek ended a long, high-effort run inside its reasoning.
        expect(maxTokensFor('deepseek', 'llmKeyDeepseek')).toEqual({ sent: 32_000, reported: 32_000 });
    });

    it('follows the setting, held under the provider ceiling', () => {
        expect(maxTokensFor('deepseek', 'llmKeyDeepseek', { maxOutputTokens: 128_000 }).sent).toBe(128_000);
        expect(maxTokensFor('openai', 'llmKeyOpenai', { maxOutputTokens: 128_000 }).sent).toBe(16_384);
    });

    it('uses a custom model\'s own cap as both its default and its ceiling', () => {
        prefs.customEndpoints = JSON.stringify([{
            id: 'ep1', name: 'Mine', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', authStyle: 'bearer',
            models: [{ id: 'small', supportsVision: false, reasoningEffort: false, maxTokens: 2048 }, { id: 'big', supportsVision: false, reasoningEffort: false }],
        }]);
        Object.assign(prefs, { llmProvider: 'custom:ep1', llmModel: 'small', maxOutputTokens: 64_000 });
        let result: any = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok && result.provider.config.maxTokens).toBe(2048);
        prefs.llmModel = 'big';
        result = buildAgentFromPrefs(vi.fn() as any);
        expect(result.ok && result.provider.config.maxTokens).toBe(64_000);
    });
});

describe('the prompt states the literature budget the tools enforce', () => {
    it('names the number', () => {
        expect(buildSystemPrompt({ literatureLookups: 10 })).toContain('All four share one budget of 10 lookups per question.');
        expect(buildSystemPrompt({})).toContain(`one budget of ${DEFAULT_MAX_LITERATURE_LOOKUPS} lookups`);
    });

    it('says something sensible with no limit', () => {
        const prompt = buildSystemPrompt({ literatureLookups: null });
        expect(prompt).not.toMatch(/budget of \d+ lookups/);
        expect(prompt).toContain('stop once what came back settles it');
    });

    it('leaves no placeholder behind and stays the same from turn to turn', () => {
        const a = buildSystemPrompt({ literatureLookups: 6 });
        expect(a).not.toContain('{{');
        expect(buildSystemPrompt({ literatureLookups: 6 })).toBe(a);
    });
});
