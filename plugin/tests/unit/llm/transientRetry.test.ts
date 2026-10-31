/**
 * A transient failure is retried before it is shown.
 *
 * A long run makes a dozen requests, and one 503, 429 or dropped connection
 * among them must not end the whole run: Retry on the error card redoes every
 * step from the start. A request that fails before anything reached the
 * screen is sent again, with backoff and the provider's Retry-After, and the
 * card appears only once the retries are spent.
 */
import { describe, expect, it } from 'vitest';

import { runAgentLoop, type LoopEvent } from '../../../src/services/llm/agentLoop';
import { runLocalAgent, type LocalRunCallbacks } from '../../../src/services/llm/localRunner';
import { OpenAICompatibleProvider, parseRetryAfter, type FetchLike } from '../../../src/services/llm/openAICompatible';
import { ModelRequestError, type StreamEvent } from '../../../src/services/llm/sse';
import type { ChatProvider } from '../../../src/services/llm/types';

const user = (content: string) => ({ role: 'user' as const, content });
const FAST = { baseDelayMs: 0 };

const busy = (retryAfterMs?: number) =>
    new ModelRequestError('DeepSeek request failed: 503', {
        kind: 'http',
        status: 503,
        label: 'DeepSeek',
        detail: 'Server busy',
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });

function scripted(script: Array<(emit: (e: StreamEvent) => void) => void>) {
    let turn = 0;
    const calls: number[] = [];
    const provider: ChatProvider = {
        label: 'DeepSeek',
        model: 'm',
        wireFormat: 'openai',
        async stream(_request, onEvent) {
            calls.push(turn);
            const step = script[turn++];
            if (step) step(onEvent);
            else onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        },
    };
    return { provider, calls };
}

const fail = (error: Error) => (emit: (e: StreamEvent) => void) => emit({ type: 'error', error });
const answer = (text: string) => (emit: (e: StreamEvent) => void) => {
    emit({ type: 'text', text });
    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
};

function recorder() {
    const events: Array<{ kind: string; payload?: any }> = [];
    const push = (kind: string) => (payload?: any) => {
        events.push({ kind, payload });
    };
    const callbacks: LocalRunCallbacks = {
        onThread: () => undefined,
        onReady: () => undefined,
        onPart: push('part'),
        onToolCallArgsStream: push('args'),
        onToolReturn: push('toolReturn'),
        onToolCallProgress: push('progress'),
        onRunComplete: push('runComplete'),
        onDone: () => events.push({ kind: 'done' }),
        onError: push('error'),
        onWarning: push('warning'),
        onRetry: push('retry'),
    };
    return { callbacks, events };
}

describe('runAgentLoop / retrying a transient failure', () => {
    it('sends the request again and finishes the run', async () => {
        const { provider, calls } = scripted([fail(busy()), answer('Here it is.')]);
        const events: LoopEvent[] = [];
        const result = await runAgentLoop([user('go')], { provider, retry: FAST, onEvent: (e) => events.push(e) });

        expect(result).toMatchObject({ reason: 'completed', text: 'Here it is.' });
        expect(result.error).toBeUndefined();
        expect(calls).toHaveLength(2);
        expect(events.filter((e) => e.type === 'retry')).toEqual([
            expect.objectContaining({ type: 'retry', attempt: 2, maxAttempts: 4 }),
        ]);
        // Still one iteration: the retry is the same step, not a new one.
        expect(result.iterations).toBe(1);
    });

    it('waits as long as Retry-After asks', async () => {
        const { provider } = scripted([fail(busy(5)), answer('ok')]);
        const events: LoopEvent[] = [];
        await runAgentLoop([user('go')], { provider, retry: FAST, onEvent: (e) => events.push(e) });
        expect(events.find((e) => e.type === 'retry')).toMatchObject({ waitMs: 5 });
    });

    it('shows the error rather than wait out a very long Retry-After', async () => {
        const { provider, calls } = scripted([fail(busy(10 * 60_000)), answer('never')]);
        const result = await runAgentLoop([user('go')], { provider, retry: FAST });
        expect(result.error).toBeDefined();
        expect(calls).toHaveLength(1);
    });

    it('does not retry a failure that will fail the same way again', async () => {
        const rejected = new ModelRequestError('401', { kind: 'http', status: 401 });
        const { provider, calls } = scripted([fail(rejected), answer('never')]);
        const result = await runAgentLoop([user('go')], { provider, retry: FAST });
        expect(result.error).toBe(rejected);
        expect(calls).toHaveLength(1);
    });

    it('does not retry once part of the reply is on screen', async () => {
        // Sending it again would show the same words twice.
        const { provider, calls } = scripted([
            (emit) => {
                emit({ type: 'text', text: 'The first half' });
                emit({ type: 'error', error: new ModelRequestError('reset', { kind: 'stream' }) });
            },
            answer('never'),
        ]);
        const result = await runAgentLoop([user('go')], { provider, retry: FAST });
        expect(result.error).toBeDefined();
        expect(calls).toHaveLength(1);
    });

    it('gives up after the last attempt and says how many it took', async () => {
        const { provider, calls } = scripted([fail(busy()), fail(busy()), fail(busy()), fail(busy()), answer('never')]);
        const result = await runAgentLoop([user('go')], { provider, retry: FAST });
        expect(calls).toHaveLength(4);
        expect(result.error).toBeDefined();
        expect(result.attempts).toBe(4);
    });

    it('retries a timeout only once', async () => {
        const stalled = () => new ModelRequestError('no data', { kind: 'timeout' });
        const { provider, calls } = scripted([fail(stalled()), fail(stalled()), answer('never')]);
        const result = await runAgentLoop([user('go')], { provider, retry: FAST });
        expect(calls).toHaveLength(2);
        expect(result.error).toBeDefined();
    });

    it('stops at once when the run is stopped during the wait', async () => {
        const controller = new AbortController();
        const { provider, calls } = scripted([fail(busy()), answer('never')]);
        const running = runAgentLoop([user('go')], {
            provider,
            signal: controller.signal,
            retry: { baseDelayMs: 60_000 },
            onEvent: (e) => {
                if (e.type === 'retry') controller.abort();
            },
        });
        const result = await running;
        expect(result.reason).toBe('cancelled');
        expect(result.error).toBeUndefined();
        expect(calls).toHaveLength(1);
    });
});

describe('runLocalAgent / retry progress', () => {
    it('reports the retry to the UI and never shows an error card when it succeeds', async () => {
        const { provider } = scripted([fail(busy()), answer('Recovered.')]);
        const { callbacks, events } = recorder();
        await runLocalAgent({ runId: 'r', threadId: 't', messages: [user('go')], provider, callbacks, retry: FAST });

        const retry = events.find((e) => e.kind === 'retry')?.payload;
        expect(retry).toMatchObject({ event: 'retry', run_id: 'r', attempt: 2, max_attempts: 4, reset: false });
        expect(events.some((e) => e.kind === 'error')).toBe(false);
        expect(events.some((e) => e.kind === 'runComplete')).toBe(true);
    });

    it('clears the abandoned attempt\'s thinking so the next one starts clean', async () => {
        const { provider } = scripted([
            (emit) => {
                emit({ type: 'reasoning', text: 'first try thinking' });
                emit({ type: 'error', error: busy() });
            },
            (emit) => {
                emit({ type: 'reasoning', text: 'second' });
                emit({ type: 'text', text: 'Answer.' });
                emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
            },
        ]);
        const { callbacks, events } = recorder();
        await runLocalAgent({ runId: 'r', threadId: 't', messages: [user('go')], provider, callbacks, retry: FAST });

        const parts = events.filter((e) => e.kind === 'part').map((e) => e.payload);
        const lastAtZero = parts.filter((p) => p.message_index === 0 && p.part_index === 0).at(-1);
        // The new attempt's thinking replaced the old, rather than being appended to it.
        expect(lastAtZero.part).toEqual({ part_kind: 'thinking', content: 'second' });
    });

    it('says the automatic retries were already made when it finally gives up', async () => {
        const { provider } = scripted([fail(busy()), fail(busy()), fail(busy()), fail(busy())]);
        const { callbacks, events } = recorder();
        await runLocalAgent({ runId: 'r', threadId: 't', messages: [user('go')], provider, callbacks, retry: FAST });
        const error = events.find((e) => e.kind === 'error')!.payload;
        expect(error.message).toContain('Tried 4 times');
        expect(error.is_retryable).toBe(true);
    });
});

describe('OpenAICompatibleProvider / what a retry needs to know', () => {
    it('carries the status and Retry-After on an HTTP failure', async () => {
        const fetchImpl = (async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '7' : null) },
            text: async () => JSON.stringify({ error: { message: 'Rate limit reached' } }),
            body: null,
        })) as unknown as FetchLike;
        const events: StreamEvent[] = [];
        await new OpenAICompatibleProvider(
            { label: 'DeepSeek', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', wireFormat: 'openai' },
            fetchImpl,
        ).stream({ messages: [user('hi')] }, (e) => events.push(e));

        expect(events[0]).toMatchObject({
            type: 'error',
            error: { kind: 'http', status: 429, retryAfterMs: 7000, retryable: true, detail: 'Rate limit reached' },
        });
    });

    it('marks a connection that could not be made as retryable', async () => {
        const fetchImpl = (async () => {
            throw new TypeError('NetworkError when attempting to fetch resource.');
        }) as unknown as FetchLike;
        const events: StreamEvent[] = [];
        await new OpenAICompatibleProvider(
            { label: 'DeepSeek', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', wireFormat: 'openai' },
            fetchImpl,
        ).stream({ messages: [user('hi')] }, (e) => events.push(e));
        expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'network', retryable: true } });
    });

    it('reads Retry-After in seconds and as a date', () => {
        expect(parseRetryAfter('3')).toBe(3000);
        const now = Date.parse('2026-09-24T12:00:00Z');
        expect(parseRetryAfter('Thu, 24 Sep 2026 12:00:10 GMT', now)).toBe(10_000);
        expect(parseRetryAfter(null)).toBeUndefined();
        expect(parseRetryAfter('soon')).toBeUndefined();
    });
});
