/**
 * Nothing waits on the network forever.
 *
 * A lab server behind a VPN that is off, an Ollama still loading a large
 * model, a stream that stops mid-reply: without a deadline each holds its
 * spinner until the network stack gives up, which can take minutes, and a
 * stalled stream never ends at all. The chat stream has a response deadline
 * and an idle limit, and the settings Test, embeddings and OpenAlex each have
 * a deadline of their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleProvider, type FetchLike } from '@beaver/agent-llm/openAICompatible';
import { EmbeddingProvider } from '@beaver/agent-llm/embeddings';
import { verifyChatProvider, verifyEmbeddingProvider } from '@beaver/agent-llm/verifyKey';
import { OpenAlexClient, type FetchJson } from '../../../src/services/literature/openalex';
import type { StreamEvent } from '@beaver/agent-llm/sse';

const user = (content: string) => ({ role: 'user' as const, content });
const config = { label: 'Lab server', baseUrl: 'http://10.0.0.5:8000/v1', apiKey: '', model: 'm', wireFormat: 'openai' as const };
const encoder = new TextEncoder();

/** A fetch whose response never arrives, and which ignores abort. */
const neverAnswers = (() => new Promise(() => undefined)) as unknown as FetchLike;

/** A stream that delivers `chunks`, then goes silent without closing. */
function stallingStream(chunks: string[]): FetchLike {
    return (async () => {
        let i = 0;
        return {
            ok: true,
            status: 200,
            text: async () => '',
            body: {
                getReader: () => ({
                    read: () =>
                        i < chunks.length
                            ? Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) })
                            : new Promise(() => undefined),
                    cancel: async () => undefined,
                }),
            },
        };
    }) as unknown as FetchLike;
}

async function streamOnce(provider: OpenAICompatibleProvider): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    await provider.stream({ messages: [user('hi')] }, (e) => events.push(e));
    return events;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('chat stream deadlines', () => {
    it('fails a request whose response never starts, as a retryable timeout', async () => {
        const provider = new OpenAICompatibleProvider(config, neverAnswers, { responseMs: 20, idleMs: 1_000 });
        const events = await streamOnce(provider);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'timeout', retryable: true } });
    });

    it('fails a stream that stops arriving mid-reply', async () => {
        const provider = new OpenAICompatibleProvider(
            config,
            stallingStream([`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half' } }] })}\n\n`]),
            { responseMs: 1_000, idleMs: 20 },
        );
        const events = await streamOnce(provider);
        expect(events.map((e) => e.type)).toEqual(['text', 'error']);
        expect(events[1]).toMatchObject({ error: { kind: 'timeout', label: 'Lab server' } });
    });

    it('counts keep-alive comments as a live connection', async () => {
        // A provider that is queueing the request sends keep-alives; that is
        // not a stall.
        let i = 0;
        const frames = [': keep-alive\n\n', ': keep-alive\n\n', ': keep-alive\n\n',
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`];
        const fetchImpl = (async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            body: {
                getReader: () => ({
                    read: () =>
                        new Promise((resolve) =>
                            setTimeout(
                                () => resolve(i < frames.length
                                    ? { done: false, value: encoder.encode(frames[i++]) }
                                    : { done: true, value: undefined }),
                                15,
                            ),
                        ),
                    cancel: async () => undefined,
                }),
            },
        })) as unknown as FetchLike;
        const provider = new OpenAICompatibleProvider(config, fetchImpl, { responseMs: 1_000, idleMs: 40 });
        const events = await streamOnce(provider);
        expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    });
});

describe('settings Test deadline', () => {
    it('ends a chat Test that gets no answer, and says what to check', async () => {
        const result = await verifyChatProvider('deepseek', 'k', neverAnswers, { timeoutMs: 20 });
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/No answer from DeepSeek within/);
    });

    it('ends an embedding Test that gets no answer', async () => {
        const result = await verifyEmbeddingProvider('openai', 'k', neverAnswers as any, { timeoutMs: 20 });
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/No answer from OpenAI within/);
    });

    it('can be cancelled by the caller', async () => {
        const controller = new AbortController();
        const pending = verifyChatProvider('deepseek', 'k', neverAnswers, { signal: controller.signal });
        controller.abort();
        expect(await pending).toMatchObject({ ok: false, message: 'Test cancelled.' });
    });
});

describe('embedding request deadline', () => {
    it('fails a request that never answers instead of holding the search', async () => {
        const provider = new EmbeddingProvider(
            { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', dimensions: 512, timeoutMs: 20 },
            neverAnswers as any,
        );
        await expect(provider.generateQueryEmbedding('q')).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    });

    it('passes a signal to the request and stops when it aborts', async () => {
        let seen: AbortSignal | undefined;
        const fetchImpl = ((_url: string, init: any) => {
            seen = init.signal;
            return new Promise(() => undefined);
        }) as any;
        const provider = new EmbeddingProvider(
            { label: 'OpenAI', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', dimensions: 512 },
            fetchImpl,
        );
        const controller = new AbortController();
        const pending = provider.generateQueryEmbedding('q', controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
        expect(seen?.aborted).toBe(true);
    });
});

describe('OpenAlex request deadline', () => {
    it('fails a lookup that never answers, even when the caller passed no signal', async () => {
        vi.useFakeTimers();
        let seen: AbortSignal | undefined;
        const fetchJson = ((_url: string, init: any) => {
            seen = init.signal;
            return new Promise(() => undefined);
        }) as unknown as FetchJson;

        const pending = new OpenAlexClient(fetchJson).search('honeybee navigation');
        const settled = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
        await vi.advanceTimersByTimeAsync(20_000);
        await settled;
        // The request itself was aborted, not just abandoned.
        expect(seen?.aborted).toBe(true);
    });

    it('carries the status on a failed request, so a rejected key is not read as an outage', async () => {
        const fetchJson = (async () => ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => JSON.stringify({ message: 'Invalid API key' }),
        })) as unknown as FetchJson;
        await expect(new OpenAlexClient(fetchJson).search('x')).rejects.toMatchObject({ kind: 'http', status: 401 });
    });

    it('treats only a 404 status as an unknown DOI, not a 404 in the text', async () => {
        // A 500 whose body happens to mention 404 is still a failure.
        const fetchJson = (async () => ({
            ok: false,
            status: 500,
            statusText: 'Server Error',
            text: async () => JSON.stringify({ message: 'upstream answered 404 for shard 3' }),
        })) as unknown as FetchJson;
        await expect(new OpenAlexClient(fetchJson).byDoi('10.1234/abc')).rejects.toMatchObject({ status: 500 });
    });
});
