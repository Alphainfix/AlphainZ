import { describe, expect, it } from 'vitest';

import {
    explainVerifyFailure,
    verifyChatProvider,
    verifyCustomEndpoint,
    verifyEmbeddingProvider,
} from '@beaver/agent-llm/verifyKey';
import type { FetchLike } from '@beaver/agent-llm/openAICompatible';
import { ModelRequestError } from '@beaver/agent-llm/sse';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function sseFetch(lines: string[], opts: { ok?: boolean; status?: number; body?: string } = {}) {
    const calls: any[] = [];
    const fn = (async (url: string, init: any) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const encoder = new TextEncoder();
        let i = 0;
        return {
            ok: opts.ok ?? true,
            status: opts.status ?? 200,
            statusText: 'OK',
            text: async () => opts.body ?? '',
            body: {
                getReader: () => ({
                    async read() {
                        if (i >= lines.length) return { done: true, value: undefined };
                        return { done: false, value: encoder.encode(lines[i++]) };
                    },
                }),
            },
        };
    }) as FetchLike & { calls: any[] };
    fn.calls = calls;
    return fn;
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

function embeddingFetch(dims: number, opts: { ok?: boolean; body?: unknown } = {}) {
    return (async () => ({
        ok: opts.ok ?? true,
        status: opts.ok === false ? 401 : 200,
        statusText: 'OK',
        text: async () =>
            JSON.stringify(
                opts.body ?? { data: [{ index: 0, embedding: new Array(dims).fill(0.5) }] },
            ),
    })) as FetchLike;
}

// ---------------------------------------------------------------------------
// explainVerifyFailure
// ---------------------------------------------------------------------------

describe('explainVerifyFailure', () => {
    const http = (status: number, detail?: string, code?: string) =>
        new ModelRequestError(`request failed: ${status}`, { kind: 'http', status, detail, code });

    it('points at the key for an auth failure', () => {
        expect(explainVerifyFailure(http(401, 'unauthorized'), 'DeepSeek')).toContain('copied all of it');
    });

    it('points at the model and base URL for a 404', () => {
        const message = explainVerifyFailure(http(404, 'not found'), 'OpenAI');
        expect(message).toContain('model name');
        expect(message).toContain('base URL');
    });

    it('says the key works when the problem is quota', () => {
        // Distinguishing "wrong key" from "right key, no quota" is the whole
        // point of a settings-panel error message.
        expect(explainVerifyFailure(http(429, 'rate limited'), 'OpenAI')).toContain('key works');
        expect(explainVerifyFailure(http(402, 'can only afford 4012 tokens'), 'OpenRouter')).toContain('key works');
    });

    it('names the provider for a network failure', () => {
        const failure = new ModelRequestError('could not be reached', { kind: 'network', detail: 'refused' });
        expect(explainVerifyFailure(failure, 'Ollama')).toContain('Ollama');
        expect(explainVerifyFailure(failure, 'Ollama')).not.toContain('refused');
    });

    it('does not quote the browser\'s own error when the endpoint cannot be reached', async () => {
        // In Zotero every failed connection reads "NetworkError when attempting
        // to fetch resource.", which names no cause; what to check does.
        const result = await verifyChatProvider('deepseek', 'sk-test', (async () => {
            throw new TypeError('NetworkError when attempting to fetch resource.');
        }) as unknown as FetchLike);
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Could not reach DeepSeek.*base URL/);
        expect(result.message).not.toMatch(/NetworkError|TypeError/);
    });

    it('passes an unrecognised message through unchanged', () => {
        expect(explainVerifyFailure('something specific and odd', 'X')).toBe(
            'something specific and odd',
        );
    });
});

// ---------------------------------------------------------------------------
// verifyChatProvider
// ---------------------------------------------------------------------------

describe('verifyChatProvider', () => {
    it('reports success and the round-trip time', async () => {
        const result = await verifyChatProvider(
            'deepseek',
            'sk-test',
            sseFetch([chunk({ content: 'ok' }), chunk({}, 'stop')]),
        );
        expect(result.ok).toBe(true);
        expect(result.message).toMatch(/Connected in \d+ ms/);
    });

    it('refuses to call the endpoint with no key', async () => {
        const fetchImpl = sseFetch([]);
        const result = await verifyChatProvider('deepseek', '   ', fetchImpl);
        expect(result).toMatchObject({ ok: false, message: 'Enter a key first.' });
        expect(fetchImpl.calls).toHaveLength(0);
    });

    it('refuses an empty key for every chat provider', async () => {
        // There is no keyless chat provider any more: the local one was listed
        // unconditionally, so it advertised a server that was usually not
        // running. Local models remain an embedding option, where they are
        // genuinely the better choice.
        for (const id of ['deepseek', 'openai', 'zhipu'] as const) {
            const fetchImpl = sseFetch([]);
            expect(await verifyChatProvider(id, '', fetchImpl)).toMatchObject({ ok: false });
            expect(fetchImpl.calls).toHaveLength(0);
        }
    });

    it('caps the reply at a negligible budget', async () => {
        const fetchImpl = sseFetch([chunk({ content: 'ok' })]);
        await verifyChatProvider('deepseek', 'k', fetchImpl);
        // Not 1: an OpenAI-compatible gateway rejects a budget too small to
        // finish a message, which would fail a working key.
        expect(fetchImpl.calls[0].body.max_tokens).toBe(16);
    });

    it('applies the endpoint\'s quirks under test', async () => {
        // A gateway that takes X-Api-Key on the Responses wire: verification has
        // to exercise the same path a real run takes or it proves nothing.
        const fetchImpl = sseFetch([
            `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
        ]);
        const result = await verifyCustomEndpoint({
            id: 'ep-gw', name: 'Gateway', baseUrl: 'https://gateway.example.edu/v2', apiKey: 'k', authStyle: 'x-api-key',
            wireFormat: 'openai-responses',
            models: [{ id: 'gpt-6-luna', supportsVision: true, reasoningEffort: true, efforts: ['none', 'low', 'high'] }],
        }, 'gpt-6-luna', fetchImpl);
        expect(result.ok).toBe(true);
        expect(fetchImpl.calls[0].url).toMatch(/\/responses$/);
        expect(fetchImpl.calls[0].init.headers).toHaveProperty('X-Api-Key');
        expect(fetchImpl.calls[0].body.max_output_tokens).toBe(16);
        // Thinking off: sixteen tokens are not enough to think and answer.
        expect(fetchImpl.calls[0].body.reasoning).toEqual({ effort: 'none' });
    });

    it('tests a model that refuses effort none at the least effort it takes', async () => {
        // o4-mini starts at low: a Test sending `none` would fail a working key.
        const fetchImpl = sseFetch([
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
        ]);
        await verifyChatProvider('openai', 'k', fetchImpl, { model: 'o4-mini' });
        expect(fetchImpl.calls[0].body.reasoning).toMatchObject({ effort: 'low' });
    });

    it('passes a Responses reply that ran out of its tiny budget', async () => {
        const fetchImpl = sseFetch([
            `data: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`,
        ]);
        expect((await verifyChatProvider('openai', 'k', fetchImpl)).ok).toBe(true);
    });

    it('honours a model override', async () => {
        const fetchImpl = sseFetch([chunk({ content: 'ok' })]);
        await verifyChatProvider('openai', 'k', fetchImpl, { model: 'gpt-6-sol' });
        expect(fetchImpl.calls[0].body.model).toBe('gpt-6-sol');
    });

    it('honours a base URL override', async () => {
        const fetchImpl = sseFetch([chunk({ content: 'ok' })]);
        await verifyChatProvider('deepseek', 'k', fetchImpl, { baseUrl: 'http://box.local:1234/v1' });
        expect(fetchImpl.calls[0].url).toBe('http://box.local:1234/v1/chat/completions');
    });

    it('explains an auth failure rather than echoing the status', async () => {
        const result = await verifyChatProvider(
            'deepseek',
            'bad',
            sseFetch([], { ok: false, status: 401, body: '{"error":{"message":"invalid key"}}' }),
        );
        expect(result.ok).toBe(false);
        expect(result.message).toContain('copied all of it');
    });

    it('refuses to call a 2xx with no stream a success', async () => {
        // A status check alone is not enough: one API gateway answers
        // an invalid model with HTTP 200 and a JSON error body, so "Works"
        // would appear for a setup that cannot answer a single question.
        const result = await verifyChatProvider('deepseek', 'k', sseFetch([]));
        expect(result.ok).toBe(false);
    });

    it('reports the provider\'s own words when a 200 carries an error body', async () => {
        const result = await verifyChatProvider(
            'openai',
            'k',
            sseFetch([
                JSON.stringify({
                    error: { message: 'The model `typo-5` does not exist or you do not have access to it.' },
                }),
            ]),
        );
        expect(result.ok).toBe(false);
        // Routed to the model/base-URL advice rather than echoed raw.
        expect(result.message).toMatch(/model/i);
        expect(result.message).toContain('typo-5');
    });

    it('counts a content-free but non-empty stream as success', async () => {
        // maxTokens: 1 legitimately yields no text on some endpoints; the
        // finish_reason frame is still proof the request was accepted.
        const result = await verifyChatProvider('deepseek', 'k', sseFetch([chunk({}, 'length')]));
        expect(result.ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// verifyEmbeddingProvider
// ---------------------------------------------------------------------------

describe('verifyEmbeddingProvider', () => {
    it('reports success with the dimensionality', async () => {
        const result = await verifyEmbeddingProvider('openai', 'k', embeddingFetch(512));
        expect(result.ok).toBe(true);
        expect(result.message).toContain('512 dimensions');
    });

    it('fails loudly when the endpoint ignores the dimensions request', async () => {
        // Otherwise the only symptom is a dimension-mismatch error mid-search,
        // long after the user left this panel.
        const result = await verifyEmbeddingProvider('openai', 'k', embeddingFetch(3072));
        expect(result.ok).toBe(false);
        expect(result.message).toContain('3072');
        expect(result.message).toContain('not fit the existing index');
    });

    it('refuses to call with no key', async () => {
        expect(await verifyEmbeddingProvider('openai', '', embeddingFetch(512))).toMatchObject({
            ok: false,
            message: 'Enter a key first.',
        });
    });

    it('allows an empty key for a local server', async () => {
        expect((await verifyEmbeddingProvider('ollama', '', embeddingFetch(768))).ok).toBe(true);
    });

    it('explains a rejected key', async () => {
        const result = await verifyEmbeddingProvider(
            'openai',
            'bad',
            embeddingFetch(0, { ok: false, body: { error: { message: '401 unauthorized' } } }),
        );
        expect(result.ok).toBe(false);
        expect(result.message).toContain('copied all of it');
    });
});

describe('verifying Ollama', () => {
    it('does not demand a key — it is the one provider that has none', async () => {
        const { verifyChatProvider } = await import('@beaver/agent-llm/verifyKey');
        const fetchImpl = (async () => { throw new Error('connection refused'); }) as any;
        const result = await verifyChatProvider('ollama', '', fetchImpl, { baseUrl: 'http://127.0.0.1:59999/v1' });
        expect(result.ok).toBe(false);
        expect(result.message).not.toBe('Enter a key first.');
    });
});
