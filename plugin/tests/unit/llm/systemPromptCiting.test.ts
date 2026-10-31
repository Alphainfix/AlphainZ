/**
 * The prompt asks for sentence-level citations from read text — composed from
 * the labels the model saw — instead of forbidding them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;

beforeEach(() => {
    const prefs: Record<string, unknown> = { [`${PREFIX}.llmProvider`]: 'deepseek', [`${PREFIX}.llmKeyDeepseek`]: 'k' };
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    vi.resetModules();
});

describe('system prompt — citing sentences', () => {
    it('tells the model to compose loc from the labels it read, and no longer forbids it', async () => {
        const { buildAgentSystemPrompt } = await import('../../../src/services/llm/agentConfig');
        const prompt = buildAgentSystemPrompt();
        expect(prompt).toContain('compose it from the labels');
        expect(prompt).toContain('loc="s12-s13"');
        expect(prompt).not.toContain('never compose one yourself');
        // Bare labels are still not allowed as text.
        expect(prompt).toContain('never as bare');
    });
});
