/**
 * A slow model server is not a dead one.
 *
 * Ollama sends nothing until it has loaded the model and read the whole prompt
 * (the first request of a run carries every tool's schema), and holds a tool
 * call back until the call is complete. On a large model, or a machine without
 * a GPU, either takes minutes. A hand-added endpoint may be exactly such a
 * server. The hosted presets answer within seconds and keep the line alive, so
 * only they are held to the short deadlines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { providerFromPreset, type FetchLike, type OpenAICompatibleProvider } from '../../../src/services/llm/openAICompatible';
import { customProviderFromEndpoint, type CustomEndpoint } from '../../../src/services/llm/customEndpoints';
import type { StreamEvent } from '../../../src/services/llm/sse';

const encoder = new TextEncoder();
const frame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
const ANSWER = frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] });
/** The same answer on the Responses wire, which OpenAI's own endpoints speak. */
const RESPONSES_ANSWER =
    frame({ type: 'response.output_text.delta', output_index: 0, delta: 'ok' })
    + frame({ type: 'response.completed', response: { status: 'completed', output: [] } });
const TOOL_CALL = frame({
    choices: [{
        delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'create_note', arguments: '{"title":"t"}' } }] },
        finish_reason: 'tool_calls',
    }],
});

/** A response that starts after `headersAfterMs`, then sends each chunk after its delay. */
function slowServer(headersAfterMs: number, chunks: Array<{ afterMs: number; text: string }>): FetchLike {
    return ((_url: string, init: any) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                let i = 0;
                resolve({
                    ok: true,
                    status: 200,
                    text: async () => '',
                    body: {
                        getReader: () => ({
                            read: () =>
                                i < chunks.length
                                    ? new Promise((done) => {
                                          const chunk = chunks[i++];
                                          setTimeout(() => done({ done: false, value: encoder.encode(chunk.text) }), chunk.afterMs);
                                      })
                                    : Promise.resolve({ done: true, value: undefined }),
                            cancel: async () => undefined,
                        }),
                    },
                });
            }, headersAfterMs);
            init.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
            });
        })) as unknown as FetchLike;
}

/** Stream one turn while `elapseMs` of fake time passes. */
async function streamFor(provider: OpenAICompatibleProvider, elapseMs: number): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    let settled = false;
    const pending = provider
        .stream({ messages: [{ role: 'user', content: 'q' }] }, (e) => events.push(e))
        .finally(() => {
            settled = true;
        });
    await vi.advanceTimersByTimeAsync(elapseMs);
    // A chunk scheduled right at the end of that window still needs a tick.
    for (let tick = 0; tick < 5 && !settled; tick += 1) await vi.advanceTimersByTimeAsync(1);
    await pending;
    return events;
}

const terminal = (events: StreamEvent[]) => events.find((e) => e.type === 'done' || e.type === 'error');

const labServer: CustomEndpoint = {
    id: 'ep-lab',
    name: 'Lab server',
    baseUrl: 'http://10.0.0.5:8000/v1',
    apiKey: '',
    authStyle: 'bearer',
    models: [{ id: 'qwen3-32b', supportsVision: false, reasoningEffort: false }],
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('a model server on this computer', () => {
    it('is given time to load the model and read the prompt before it answers', async () => {
        const provider = providerFromPreset('ollama', '', slowServer(3 * 60_000, [{ afterMs: 0, text: ANSWER }]), {
            model: 'qwen3:32b',
        });
        const events = await streamFor(provider, 3 * 60_000);
        expect(terminal(events)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    });

    it('may hold a tool call back for minutes once the reply has started', async () => {
        const preamble = frame({ choices: [{ delta: { content: 'Writing it up.' } }] });
        const provider = providerFromPreset(
            'ollama',
            '',
            slowServer(0, [{ afterMs: 0, text: preamble }, { afterMs: 5 * 60_000, text: TOOL_CALL }]),
            { model: 'qwen3:32b' },
        );
        const events = await streamFor(provider, 5 * 60_000);
        expect(terminal(events)).toMatchObject({ type: 'done', stopReason: 'tool_calls' });
    });

    it('is still given up on once it has been silent far longer than any model needs', async () => {
        const provider = providerFromPreset('ollama', '', slowServer(60 * 60_000, []), { model: 'qwen3:32b' });
        const events = await streamFor(provider, 10 * 60_000);
        expect(terminal(events)).toMatchObject({
            type: 'error',
            error: { kind: 'timeout', retryable: true, message: 'Ollama (local) did not respond within 10 min' },
        });
    });
});

describe('an endpoint added by hand', () => {
    it('is given the same time, since nothing says how fast it is', async () => {
        const provider = customProviderFromEndpoint(labServer, 'qwen3-32b', slowServer(4 * 60_000, [{ afterMs: 0, text: ANSWER }]));
        const events = await streamFor(provider, 4 * 60_000);
        expect(terminal(events)).toMatchObject({ type: 'done' });
    });
});

describe('a hosted preset', () => {
    it('is given up on when its response has not started within a minute', async () => {
        const provider = providerFromPreset('deepseek', 'k', slowServer(90_000, [{ afterMs: 0, text: ANSWER }]));
        const events = await streamFor(provider, 90_000);
        expect(terminal(events)).toMatchObject({
            type: 'error',
            error: { kind: 'timeout', message: 'DeepSeek did not respond within 60 s' },
        });
    });

    it('is given up on when its stream goes silent for three minutes', async () => {
        const provider = providerFromPreset('deepseek', 'k', slowServer(0, [{ afterMs: 4 * 60_000, text: ANSWER }]));
        const events = await streamFor(provider, 4 * 60_000);
        expect(terminal(events)).toMatchObject({ type: 'error', error: { kind: 'timeout' } });
    });

    it('lets an OpenAI reasoning model think out of sight once its reply has started', async () => {
        const provider = providerFromPreset('openai', 'k', slowServer(0, [{ afterMs: 5 * 60_000, text: RESPONSES_ANSWER }]), {
            model: 'gpt-5',
        });
        const events = await streamFor(provider, 5 * 60_000);
        expect(terminal(events)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
        expect(events).toContainEqual({ type: 'text', text: 'ok' });
    });

    it('lets GPT-6 think out of sight as long', async () => {
        const provider = providerFromPreset('openai', 'k', slowServer(0, [{ afterMs: 5 * 60_000, text: RESPONSES_ANSWER }]), {
            model: 'gpt-6-luna',
        });
        const events = await streamFor(provider, 5 * 60_000);
        expect(terminal(events)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    });
});
