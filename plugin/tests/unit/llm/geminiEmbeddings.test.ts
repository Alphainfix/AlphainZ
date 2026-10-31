import { describe, expect, it } from 'vitest';

import {
    EmbeddingProvider,
    embeddingProviderFromPreset,
    geminiLimitInfo,
    msUntilPacificMidnight,
    type EmbeddingRequestOutcome,
    type FetchLike,
} from '../../../src/services/llm/embeddings';

/** A 429 body in the shape the Gemini API sends one. */
function limitBody(quotaId: string, retryDelay = '37s', quotaValue = '100') {
    return {
        error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'You exceeded your current quota, please check your plan and billing details.',
            details: [
                {
                    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                    violations: [{
                        quotaMetric: 'generativelanguage.googleapis.com/embed_content_free_tier_requests',
                        quotaId,
                        quotaDimensions: { location: 'global', model: 'gemini-embedding-2' },
                        quotaValue,
                    }],
                },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
            ],
        },
    };
}

/** Answers each `batchEmbedContents` with one vector per request, or the scripted failures first. */
function geminiFetch(failures: Array<{ status: number; body: unknown }> = []): FetchLike & { calls: any[] } {
    const calls: any[] = [];
    const queue = [...failures];
    const fn = (async (url: string, init: any) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const failure = queue.shift();
        if (failure) {
            return { ok: false, status: failure.status, statusText: '', text: async () => JSON.stringify(failure.body) };
        }
        const requests = JSON.parse(init.body).requests;
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                embeddings: requests.map((_: unknown, i: number) => ({ values: [1, i, 0, 0] })),
            }),
        };
    }) as FetchLike & { calls: any[] };
    fn.calls = calls;
    return fn;
}

const gemini = (fetchImpl: FetchLike, extra: Record<string, unknown> = {}) => new EmbeddingProvider({
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza-test',
    model: 'gemini-embedding-2',
    dimensions: 4,
    wire: 'gemini',
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
    ...extra,
}, fetchImpl);

describe('Gemini embeddings', () => {
    it('posts one request per text to batchEmbedContents, keyed by x-goog-api-key', async () => {
        const fetchImpl = geminiFetch();
        await gemini(fetchImpl).generateEmbeddings([{ item_id: 1, text: 'a' }, { item_id: 2, text: 'b' }]);
        const call = fetchImpl.calls[0];
        expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents');
        expect(call.init.headers).toMatchObject({ 'x-goog-api-key': 'AIza-test' });
        expect(call.init.headers).not.toHaveProperty('Authorization');
        // Two requests, not two parts of one content: parts are embedded together.
        expect(call.body.requests).toHaveLength(2);
        expect(call.body.requests[0]).toEqual({
            model: 'models/gemini-embedding-2',
            content: { parts: [{ text: 'title: none | text: a' }] },
            outputDimensionality: 4,
        });
    });

    it('puts the query instruction in front of a search and the document one in front of an indexed text', async () => {
        const fetchImpl = geminiFetch();
        const provider = gemini(fetchImpl);
        await provider.generateQueryEmbedding('waggle dance');
        await provider.generateEmbeddings([{ item_id: 1, text: 'honeybees' }]);
        expect(fetchImpl.calls[0].body.requests[0].content.parts[0].text).toBe('task: search result | query: waggle dance');
        expect(fetchImpl.calls[1].body.requests[0].content.parts[0].text).toBe('title: none | text: honeybees');
    });

    it('keeps vectors in input order and quantizes them', async () => {
        const result = await gemini(geminiFetch()).generateEmbeddings([
            { item_id: 7, text: 'a' },
            { item_id: 8, text: 'b' },
        ]);
        expect(result.embeddings.map((e) => e.item_id)).toEqual([7, 8]);
        expect(result.embeddings[1].embedding).toEqual([127, 127, 0, 0]);
    });

    it('rejects a reply with fewer vectors than texts', async () => {
        const short = (async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ embeddings: [{ values: [1, 0, 0, 0] }] }),
        })) as FetchLike;
        await expect(gemini(short).generateEmbeddings([{ item_id: 1, text: 'a' }, { item_id: 2, text: 'b' }]))
            .rejects.toThrow('returned 1 embeddings for 2 texts');
    });

    it('waits out a per-minute limit while indexing, for as long as the API asks', async () => {
        const fetchImpl = geminiFetch([{ status: 429, body: limitBody('EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier', '0.01s') }]);
        const outcomes: EmbeddingRequestOutcome[] = [];
        const result = await gemini(fetchImpl, { onRequest: (o: EmbeddingRequestOutcome) => outcomes.push(o) })
            .generateEmbeddings([{ item_id: 1, text: 'a' }]);
        expect(result.embeddings).toHaveLength(1);
        expect(fetchImpl.calls).toHaveLength(2);
        expect(outcomes.map((o) => o.ok)).toEqual([false, true]);
        const failed = outcomes[0] as Extract<EmbeddingRequestOutcome, { ok: false }>;
        expect(failed.error).toMatchObject({ status: 429, code: 'rate_limit', quotaTier: 'free', retryAfterMs: 10 });
    });

    it('does not wait out a spent day: it reports it, with the time to the reset', async () => {
        const fetchImpl = geminiFetch([{ status: 429, body: limitBody('EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier', '3600s', '1000') }]);
        const error = await gemini(fetchImpl).generateEmbeddings([{ item_id: 1, text: 'a' }]).catch((e) => e);
        expect(fetchImpl.calls).toHaveLength(1);
        expect(error).toMatchObject({ status: 429, code: 'daily_quota', retryable: false, quotaTier: 'free' });
        expect(error.retryAfterMs).toBeGreaterThan(0);
        expect(error.retryAfterMs).toBeLessThanOrEqual(24 * 3600 * 1000);
    });

    it('lets a search wait once for a short limit, then reports it as not worth an immediate retry', async () => {
        const minute = { status: 429, body: limitBody('EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier', '0.01s') };
        const fetchImpl = geminiFetch([minute, minute]);
        const error = await gemini(fetchImpl).generateQueryEmbedding('q').catch((e) => e);
        expect(fetchImpl.calls).toHaveLength(2);
        expect(error).toMatchObject({ status: 429, code: 'rate_limit', retryable: false });
    });

    it('does not keep a search waiting for a long limit', async () => {
        const fetchImpl = geminiFetch([{ status: 429, body: limitBody('EmbedContentRequestsPerMinutePerUserPerProjectPerModel', '45s') }]);
        const error = await gemini(fetchImpl).generateQueryEmbedding('q').catch((e) => e);
        expect(fetchImpl.calls).toHaveLength(1);
        expect(error).toMatchObject({ code: 'rate_limit', quotaTier: 'paid', retryable: false });
    });

    it('asks before every indexing batch, and not before a search', async () => {
        const asked: number[] = [];
        const provider = gemini(geminiFetch(), {
            batchSize: 2,
            beforeIndexBatch: async (count: number) => { asked.push(count); },
        });
        await provider.generateEmbeddings([1, 2, 3].map((i) => ({ item_id: i, text: `t${i}` })));
        await provider.generateQueryEmbedding('q');
        expect(asked).toEqual([2, 1]);
    });

    it('sends nothing when the admission refuses the batch', async () => {
        const fetchImpl = geminiFetch();
        const refusal = new Error('spent');
        const provider = gemini(fetchImpl, { beforeIndexBatch: async () => { throw refusal; } });
        await expect(provider.generateEmbeddings([{ item_id: 1, text: 'a' }])).rejects.toBe(refusal);
        expect(fetchImpl.calls).toHaveLength(0);
    });
});

describe('geminiLimitInfo', () => {
    it('reads the wait, the window and the tier from a 429', () => {
        expect(geminiLimitInfo(JSON.stringify(limitBody('EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier'))))
            .toEqual({ retryAfterMs: 37_000, window: 'minute', freeTier: true, limit: 100 });
    });

    it('reads the same object wrapped in an array, as the OpenAI-compatible layer sends it', () => {
        expect(geminiLimitInfo(JSON.stringify([limitBody('EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier')])).window)
            .toBe('day');
    });

    it('lets a spent day outweigh a spent minute', () => {
        const body = limitBody('EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier');
        body.error.details[0].violations!.push({ ...body.error.details[0].violations![0], quotaId: 'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier' });
        expect(geminiLimitInfo(JSON.stringify(body)).window).toBe('day');
    });

    it('says nothing about a body it cannot read', () => {
        expect(geminiLimitInfo('<html>too many</html>')).toEqual({});
    });
});

describe('msUntilPacificMidnight', () => {
    it('counts to the next midnight in Los Angeles', () => {
        // 2026-10-23 07:00 UTC is 00:00 PDT: a whole day to go.
        expect(msUntilPacificMidnight(new Date('2026-10-23T07:00:00Z'))).toBe(24 * 3600 * 1000);
        // 23:30 PDT: half an hour.
        expect(msUntilPacificMidnight(new Date('2026-10-24T06:30:00Z'))).toBe(30 * 60 * 1000);
    });
});

describe('the Google preset', () => {
    it('is gemini-embedding-2 at 512 dimensions, on the Gemini wire with its prefixes', async () => {
        const fetchImpl = geminiFetch();
        const provider = embeddingProviderFromPreset('google', 'AIza-test', fetchImpl);
        expect(provider.modelId).toBe('gemini-embedding-2-int8-512');
        await provider.generateQueryEmbedding('q');
        expect(fetchImpl.calls[0].url).toContain('/models/gemini-embedding-2:batchEmbedContents');
        expect(fetchImpl.calls[0].body.requests[0].content.parts[0].text).toBe('task: search result | query: q');
    });
});

describe('a key Google does not know', () => {
    const native = {
        error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
        },
    };

    it('is a refused key, not a document the endpoint could not take', async () => {
        const error = await gemini(geminiFetch([{ status: 400, body: native }])).generateQueryEmbedding('q').catch((e) => e);
        // Read as 400 it would fail every document of a full-text pass in turn.
        expect(error).toMatchObject({ status: 401, code: 'invalid_api_key', retryable: false });
        expect(error.detail).toBe('API key not valid. Please pass a valid API key.');
    });

    it('is read the same from the OpenAI-compatible layer, which wraps it in an array and drops the details', async () => {
        const { describeErrorBody } = await import('../../../src/services/llm/sse');
        const { describeHttpFailure } = await import('../../../src/services/llm/openAICompatible');
        const body = JSON.stringify([{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }]);
        expect(describeErrorBody(body)).toEqual({ detail: 'Please pass a valid API key', code: 'invalid_api_key', status: 401 });
        const failure = await describeHttpFailure('Google Gemini', 400, 'Bad Request', async () => body);
        expect(failure).toMatchObject({ status: 401, code: 'invalid_api_key', detail: 'Please pass a valid API key' });
    });

    it('leaves another 400 alone', async () => {
        const { describeErrorBody } = await import('../../../src/services/llm/sse');
        const body = JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } });
        expect(describeErrorBody(body)).toMatchObject({ code: '400', status: 400 });
    });
});
