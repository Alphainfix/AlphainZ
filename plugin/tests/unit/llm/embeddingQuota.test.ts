import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = new Map<string, unknown>();
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key) ?? '',
    setPref: (key: string, value: unknown) => { prefs.set(key, value); },
}));

import {
    FREE_INDEX_PER_DAY,
    FREE_INDEX_PER_MINUTE,
    FREE_TEXT_RESERVE_PER_DAY,
    geminiIndexPacing,
    keyFingerprint,
    knownTier,
    pacificDate,
    resetEmbeddingPacing,
} from '../../../src/services/llm/embeddingQuota';
import { ModelRequestError } from '../../../src/services/llm/sse';

const KEY = 'AIzaSy-free-test-key';
const limit = (quotaTier: 'free' | 'paid') => ({
    ok: false as const,
    purpose: 'index' as const,
    count: 32,
    error: new ModelRequestError('429', { kind: 'http', status: 429, code: 'rate_limit', quotaTier }),
});

describe('pacing the indexer on a Google key', () => {
    beforeEach(() => {
        prefs.clear();
        resetEmbeddingPacing();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-23T18:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('learns the tier from a 429, remembering the key only by a fingerprint', () => {
        const pacing = geminiIndexPacing(KEY, 'Google Gemini');
        expect(knownTier(KEY)).toBeUndefined();
        pacing.onRequest(limit('free'));
        expect(knownTier(KEY)).toBe('free');
        expect(String(prefs.get('embeddingQuota'))).not.toContain(KEY);
        expect(String(prefs.get('embeddingQuota'))).toContain(keyFingerprint(KEY));
        // Another key starts unknown.
        expect(knownTier('AIzaSy-another-key')).toBeUndefined();
    });

    it('leaves a paid key, or one whose tier is not known, alone', async () => {
        const pacing = geminiIndexPacing(KEY, 'Google Gemini');
        for (let i = 0; i < 10; i += 1) {
            await pacing.beforeIndexBatch(40);
            pacing.onRequest({ ok: true, purpose: 'index', count: 40 });
        }
        pacing.onRequest(limit('paid'));
        await pacing.beforeIndexBatch(40);
        expect(prefs.get('embeddingQuota')).not.toContain('"day"');
    });

    it(`keeps a free key's indexing to ${FREE_INDEX_PER_MINUTE} texts a minute`, async () => {
        const pacing = geminiIndexPacing(KEY, 'Google Gemini');
        pacing.onRequest(limit('free'));
        await pacing.beforeIndexBatch(40);
        pacing.onRequest({ ok: true, purpose: 'index', count: 40 });
        await pacing.beforeIndexBatch(40);
        pacing.onRequest({ ok: true, purpose: 'index', count: 40 });

        let admitted = false;
        const third = pacing.beforeIndexBatch(40).then(() => { admitted = true; });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(admitted).toBe(false);
        await vi.advanceTimersByTimeAsync(31_000);
        await third;
        expect(admitted).toBe(true);
    });

    it(`stops a free key's indexing for the day at ${FREE_INDEX_PER_DAY} texts, until midnight Pacific`, async () => {
        const pacing = geminiIndexPacing(KEY, 'Google Gemini');
        pacing.onRequest(limit('free'));
        prefs.set('embeddingQuota', JSON.stringify({
            ...JSON.parse(String(prefs.get('embeddingQuota'))),
            day: { date: pacificDate(), key: keyFingerprint(KEY), count: FREE_INDEX_PER_DAY - 10 },
        }));
        const error = await pacing.beforeIndexBatch(32).catch((e) => e);
        expect(error).toMatchObject({ code: 'daily_quota', status: 429, retryable: false });
        // 18:00 UTC is 11:00 PDT: thirteen hours to the reset.
        expect(error.retryAfterMs).toBe(13 * 3600 * 1000);
        // A new Pacific day starts from nothing.
        vi.setSystemTime(new Date('2026-10-24T08:00:00Z'));
        await expect(pacing.beforeIndexBatch(32)).resolves.toBeUndefined();
    });

    it(`leaves ${FREE_TEXT_RESERVE_PER_DAY} of a free key's day to text: pictures stop first`, async () => {
        const pacing = geminiIndexPacing(KEY, 'Google Gemini');
        pacing.onRequest(limit('free'));
        prefs.set('embeddingQuota', JSON.stringify({
            ...JSON.parse(String(prefs.get('embeddingQuota'))),
            day: { date: pacificDate(), key: keyFingerprint(KEY), count: FREE_INDEX_PER_DAY - FREE_TEXT_RESERVE_PER_DAY - 3 },
        }));
        const pictures = await pacing.beforeIndexBatch(6, undefined, 'image').catch((e) => e);
        expect(pictures).toMatchObject({ code: 'daily_quota', status: 429 });
        expect(pictures.message).toMatch(/daily allowance for page images is used/);
        // The text of a paper added now still goes out today.
        await expect(pacing.beforeIndexBatch(40)).resolves.toBeUndefined();
        await expect(pacing.beforeIndexBatch(40, undefined, 'text')).resolves.toBeUndefined();
    });

    it('counts only indexing towards the day', () => {
        const pacing = geminiIndexPacing(KEY, 'Google Gemini');
        pacing.onRequest(limit('free'));
        pacing.onRequest({ ok: true, purpose: 'query', count: 1 });
        pacing.onRequest({ ok: true, purpose: 'index', count: 32 });
        expect(JSON.parse(String(prefs.get('embeddingQuota'))).day.count).toBe(32);
    });
});
