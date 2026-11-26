import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = new Map<string, unknown>();
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key) ?? '',
    setPref: (key: string, value: unknown) => { prefs.set(key, value); },
}));

import {
    clearEmbeddingHealth,
    describeEmbeddingFailure,
    embeddingFailureSince,
    noteEmbeddingOutcome,
    readEmbeddingHealth,
} from '@beaver/agent-llm/embeddingHealth';
import { ModelRequestError } from '@beaver/agent-llm/sse';

const http = (status: number, extra: Record<string, unknown> = {}) =>
    new ModelRequestError(`failed: ${status}`, { kind: 'http', status, label: 'Google Gemini', ...extra });

describe('embedding health', () => {
    beforeEach(() => prefs.clear());

    it('keeps the last failure, for the model it happened to', () => {
        noteEmbeddingOutcome('gemini-embedding-2', 'Google Gemini', { ok: false, purpose: 'query', count: 1, error: http(403) });
        expect(readEmbeddingHealth('gemini-embedding-2')?.reason).toMatch(/rejected the API key \(403\)/);
        // Another model's failure says nothing about this one.
        expect(readEmbeddingHealth('embeddinggemma-2:440m-q8_0-text-vision')).toBeNull();
    });

    it('is cleared by the next request that works', () => {
        noteEmbeddingOutcome('m', 'L', { ok: false, purpose: 'index', count: 32, error: http(503) });
        noteEmbeddingOutcome('m', 'L', { ok: true, purpose: 'index', count: 32 });
        expect(readEmbeddingHealth('m')).toBeNull();
    });

    it('ignores what was one document’s fault, and a stop', () => {
        noteEmbeddingOutcome('m', 'L', { ok: false, purpose: 'index', count: 32, error: http(400) });
        noteEmbeddingOutcome('m', 'L', {
            ok: false, purpose: 'query', count: 1,
            error: new ModelRequestError('stopped', { kind: 'cancelled' }),
        });
        expect(readEmbeddingHealth('m')).toBeNull();
    });

    it('answers whether something failed since a run began', () => {
        const before = Date.now();
        noteEmbeddingOutcome('m', 'L', { ok: false, purpose: 'query', count: 1, error: http(401) });
        expect(embeddingFailureSince('m', before)).toMatch(/rejected the API key/);
        expect(embeddingFailureSince('m', Date.now() + 1000)).toBeNull();
        clearEmbeddingHealth();
        expect(embeddingFailureSince('m', before)).toBeNull();
    });

    it('says when a spent day comes back', () => {
        const reason = describeEmbeddingFailure(http(429, { code: 'daily_quota', retryAfterMs: 3_600_000 }), 'Google Gemini');
        expect(reason).toMatch(/used up today’s embedding allowance/);
        expect(reason).toMatch(/midnight Pacific time \(\d{1,2}:\d{2} here\)/);
    });

    it('tells a limited minute from a dead server', () => {
        expect(describeEmbeddingFailure(http(429, { code: 'rate_limit' }), 'X')).toMatch(/limiting requests/);
        expect(describeEmbeddingFailure(new ModelRequestError('down', { kind: 'network', label: 'Ollama' }), 'Ollama'))
            .toMatch(/could not be reached/);
    });
});

describe('a failure just after another', () => {
    beforeEach(() => prefs.clear());

    it('still counts for a run that began between them', async () => {
        noteEmbeddingOutcome('m', 'L', { ok: false, purpose: 'query', count: 1, error: http(401) });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const runStart = Date.now();
        noteEmbeddingOutcome('m', 'L', { ok: false, purpose: 'query', count: 1, error: http(401) });
        expect(embeddingFailureSince('m', runStart)).toMatch(/rejected the API key/);
    });

    it('names a key Google does not know without the status it was reported under', () => {
        const reason = describeEmbeddingFailure(http(401, { code: 'invalid_api_key' }), 'Google Gemini');
        expect(reason).toBe('Google Gemini does not accept the API key. Check it under Settings → Model.');
    });
});
