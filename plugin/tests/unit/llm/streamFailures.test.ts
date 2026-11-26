/**
 * A stream that failed is not a finished answer.
 *
 * Providers report trouble inside a 200 stream in ways a plain reader takes for
 * a normal ending: OpenRouter sends a frame with a top-level `error` when the
 * upstream model drops out, Zhipu and DeepSeek end with finish reasons of their
 * own. Read as `end_turn`, a reply cut off mid-sentence would show as complete,
 * with no error and nothing to retry. Separately, some compatible servers end a
 * tool-calling turn with `stop`, which must not end the run with the call unrun.
 */
import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '@beaver/agent-llm/agentLoop';
import { runLocalAgent, type LocalRunCallbacks } from '@beaver/agent-llm/localRunner';
import { WRITE_TOOL_NAMES } from '../../../src/services/llm/writeTools';
import { parseSseStream, type StreamEvent } from '@beaver/agent-llm/sse';
import type { ChatProvider, ToolSchema } from '@beaver/agent-llm/types';

function readerOf(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[i++]) };
        },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function collect(chunks: string[]): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    await parseSseStream(readerOf(chunks), 'openai', (e) => events.push(e), { label: 'OpenRouter' });
    return events;
}

const frame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
const oa = (delta: Record<string, unknown>, finish: string | null = null) =>
    frame({ choices: [{ delta, finish_reason: finish }] });

const terminal = (events: StreamEvent[]) => events.filter((e) => e.type === 'done' || e.type === 'error');

describe('parseSseStream / failures reported inside the stream', () => {
    it('turns an OpenRouter error frame into an error that keeps the provider\'s reason', async () => {
        const events = await collect([
            oa({ content: 'The paper argues that' }),
            frame({
                error: { code: 502, message: 'Upstream provider disconnected' },
                choices: [{ delta: { content: '' }, finish_reason: 'error' }],
            }),
        ]);
        const ends = terminal(events);
        expect(ends).toHaveLength(1);
        expect(ends[0]).toMatchObject({
            type: 'error',
            error: { kind: 'provider', status: 502, detail: 'Upstream provider disconnected', retryable: true },
        });
    });

    it('reads an error object sent without choices', async () => {
        const events = await collect([oa({ content: 'x' }), frame({ error: { message: 'overloaded', code: 'server_error' } })]);
        expect(terminal(events)[0]).toMatchObject({ type: 'error', error: { detail: 'overloaded' } });
    });

    it.each(['error', 'network_error', 'insufficient_system_resource'])(
        'fails a reply that ended with finish_reason "%s"',
        async (reason) => {
            const events = await collect([oa({ content: 'half an ans' }), oa({}, reason)]);
            const ends = terminal(events);
            expect(ends).toHaveLength(1);
            expect(ends[0]).toMatchObject({ type: 'error', error: { kind: 'provider', code: reason, retryable: true } });
        },
    );

    it('treats Zhipu\'s "sensitive" as the content filter, not a normal stop', async () => {
        const events = await collect([oa({ content: 'x' }), oa({}, 'sensitive')]);
        expect(terminal(events)[0]).toMatchObject({ type: 'done', stopReason: 'content_filter' });
    });

    it('reports a turn that assembled a call as a tool turn, whatever finish reason came with it', async () => {
        const events = await collect([
            oa({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_document', arguments: '{}' } }] }),
            oa({}, 'stop'),
        ]);
        expect(terminal(events)[0]).toMatchObject({ type: 'done', stopReason: 'tool_calls' });
    });
});

// ---------------------------------------------------------------------------
// The loop and the runner
// ---------------------------------------------------------------------------

const TOOLS: ToolSchema[] = [
    { name: 'read_document', description: 'Read', parameters: { type: 'object', properties: {} } },
    { name: 'create_note', description: 'Note', parameters: { type: 'object', properties: {} } },
];

function scripted(script: Array<(emit: (e: StreamEvent) => void) => void>): ChatProvider {
    let turn = 0;
    return {
        label: 'Fake',
        model: 'm',
        wireFormat: 'openai',
        async stream(_request, onEvent) {
            const step = script[turn++];
            if (step) step(onEvent);
            else onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        },
    };
}

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
    };
    return { callbacks, events };
}

// The plugin tells the runner which of its tools are writes; so do these tests.
const base = { runId: 'run-1', threadId: 't', messages: [{ role: 'user' as const, content: 'go' }], writeTools: WRITE_TOOL_NAMES };

describe('parseSseStream / a stream that simply stops', () => {
    it('reports a reply cut off with no finish reason and no end marker as interrupted', async () => {
        const events = await collect([oa({ content: 'The answer ' }), oa({ content: 'is ' })]);
        expect(terminal(events)).toEqual([expect.objectContaining({ type: 'done', stopReason: 'interrupted' })]);
    });

    it('still reads a finish reason without the end marker as a normal end', async () => {
        const events = await collect([oa({ content: 'Done.' }), oa({}, 'stop')]);
        expect(terminal(events)).toEqual([expect.objectContaining({ type: 'done', stopReason: 'end_turn' })]);
    });

    it('still reads the end marker without a finish reason as a normal end', async () => {
        const events = await collect([oa({ content: 'Done.' }), 'data: [DONE]\n\n']);
        expect(terminal(events)).toEqual([expect.objectContaining({ type: 'done', stopReason: 'end_turn' })]);
    });
});

describe('runAgentLoop / a tool call that came with the wrong finish reason', () => {
    it('runs the call instead of ending the run with it unrun', async () => {
        const dispatched: string[] = [];
        const result = await runAgentLoop([{ role: 'user', content: 'go' }], {
            tools: TOOLS,
            dispatch: async (name) => {
                dispatched.push(name);
                return { pages_returned: '1', total_pages: 3 };
            },
            provider: scripted([
                (emit) => {
                    emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'read_document' });
                    emit({
                        type: 'done',
                        stopReason: 'end_turn',
                        toolCalls: [{ index: 0, id: 'c1', name: 'read_document', argumentsJson: '{}' }],
                    });
                },
                (emit) => {
                    emit({ type: 'text', text: 'It says so on page 1.' });
                    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                },
            ]),
        });
        expect(dispatched).toEqual(['read_document']);
        expect(result.text).toBe('It says so on page 1.');
    });
});

describe('runLocalAgent / warnings for a reply that went wrong', () => {
    it('says an answer whose stream was cut off may be incomplete', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scripted([(emit) => {
                emit({ type: 'text', text: 'The answer is' });
                emit({ type: 'done', stopReason: 'interrupted', toolCalls: [] });
            }]),
            callbacks,
        });
        const warnings = events.filter((e) => e.kind === 'warning').map((e) => e.payload);
        expect(warnings).toEqual([expect.objectContaining({ type: 'stream_interrupted' })]);
        expect(warnings[0].message).toMatch(/may be incomplete/);
    });

    it('warns when a run completes without a word', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scripted([(emit) => emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] })]),
            callbacks,
        });
        const warning = events.find((e) => e.kind === 'warning')?.payload;
        expect(warning).toMatchObject({ type: 'empty_response' });
    });

    it('does not warn under a proposal card, which is the reply', async () => {
        // [create_note, return_suggestions] with no prose: the card and the
        // chips are the output, and "ask again" would propose the note twice.
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => ({ status: 'proposed' }),
            provider: scripted([
                (emit) => {
                    const calls = [
                        { index: 0, id: 'n1', name: 'create_note', argumentsJson: '{"title":"t","content":"c"}' },
                        { index: 1, id: 's1', name: 'return_suggestions', argumentsJson: '{"suggestions":["a"]}' },
                    ];
                    for (const call of calls) emit({ type: 'tool_call_start', index: call.index, id: call.id, name: call.name });
                    emit({ type: 'done', stopReason: 'tool_calls', toolCalls: calls });
                },
            ]),
            callbacks,
        });
        expect(events.filter((e) => e.kind === 'warning')).toEqual([]);
    });

    it('does not warn when an earlier step proposed a write and the last said nothing more', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => ({ status: 'proposed' }),
            provider: scripted([
                (emit) => {
                    emit({ type: 'tool_call_start', index: 0, id: 'n1', name: 'create_note' });
                    emit({
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ index: 0, id: 'n1', name: 'create_note', argumentsJson: '{"title":"t"}' }],
                    });
                },
                (emit) => emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] }),
            ]),
            callbacks,
        });
        expect(events.some((e) => e.kind === 'warning')).toBe(false);
    });

    it('still warns when the run only read and then said nothing', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => 'page text',
            provider: scripted([
                (emit) => {
                    emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'read_document' });
                    emit({
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ index: 0, id: 'c1', name: 'read_document', argumentsJson: '{}' }],
                    });
                },
                (emit) => emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] }),
            ]),
            callbacks,
        });
        expect(events.find((e) => e.kind === 'warning')?.payload).toMatchObject({ type: 'empty_response' });
    });

    it('does not count a write from an earlier question as this reply', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            messages: [
                { role: 'user', content: 'make a note' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'old', name: 'create_note', argumentsJson: '{"title":"t"}' }],
                } as any,
                { role: 'tool', toolCallId: 'old', name: 'create_note', content: '{"status":"applied"}' },
                { role: 'assistant', content: 'Done.' },
                { role: 'user', content: 'and now?' },
            ],
            provider: scripted([(emit) => emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] })]),
            callbacks,
        });
        expect(events.find((e) => e.kind === 'warning')?.payload).toMatchObject({ type: 'empty_response' });
    });

    it('does not warn about an answer that has text', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scripted([
                (emit) => {
                    emit({ type: 'text', text: 'Answer.' });
                    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                },
            ]),
            callbacks,
        });
        expect(events.some((e) => e.kind === 'warning')).toBe(false);
    });

    it('words the output-limit warning by the turn that was cut off, not by an earlier preamble', async () => {
        // Step 1 wrote a preamble and called a tool; step 2 thought until the
        // cap and wrote nothing. The answer was not "cut off" — it never started.
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => 'page text',
            outputTokenLimit: 32_000,
            provider: scripted([
                (emit) => {
                    emit({ type: 'text', text: 'Let me read the methods section. ' });
                    emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'read_document' });
                    emit({
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ index: 0, id: 'c1', name: 'read_document', argumentsJson: '{}' }],
                    });
                },
                (emit) => {
                    emit({ type: 'reasoning', text: 'thinking at length…' });
                    emit({ type: 'done', stopReason: 'length', toolCalls: [] });
                },
            ]),
            callbacks,
        });
        const warning = events.find((e) => e.kind === 'warning')!.payload;
        expect(warning.type).toBe('output_limit');
        expect(warning.message).toMatch(/spent its whole 32k-token output budget thinking/);
    });

    it('names the tool call the reply was writing when it hit the cap', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            provider: scripted([
                (emit) => {
                    emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'create_note' });
                    emit({ type: 'tool_call_args', index: 0, delta: '{"title":"Summary","content":"Long' });
                    emit({
                        type: 'done',
                        stopReason: 'length',
                        toolCalls: [
                            { index: 0, id: 'c1', name: 'create_note', argumentsJson: '{"title":"Summary","content":"Long' },
                        ],
                    });
                },
            ]),
            callbacks,
        });
        const warning = events.find((e) => e.kind === 'warning')!.payload;
        expect(warning.type).toBe('output_limit');
        expect(warning.message).toContain('create_note');
        expect(warning.message).toContain('that call did not run');
        expect(warning.message).not.toMatch(/thinking/);
    });

    it('says none of the step\'s calls ran when the cap cut the last of several', async () => {
        const dispatched: string[] = [];
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async (name) => {
                dispatched.push(name);
                return 'ok';
            },
            provider: scripted([
                (emit) => {
                    const calls = [
                        { index: 0, id: 'h1', name: 'create_highlight', argumentsJson: '{"text":"a"}' },
                        { index: 1, id: 'h2', name: 'create_highlight', argumentsJson: '{"text":"b"}' },
                        { index: 2, id: 'n1', name: 'create_note', argumentsJson: '{"title":"x","content":"lo' },
                    ];
                    for (const call of calls) emit({ type: 'tool_call_start', index: call.index, id: call.id, name: call.name });
                    emit({ type: 'done', stopReason: 'length', toolCalls: calls });
                },
            ]),
            callbacks,
        });
        expect(dispatched).toEqual([]);
        const warning = events.find((e) => e.kind === 'warning')!.payload;
        expect(warning.message).toContain('while writing a create_note call');
        expect(warning.message).toContain('none of the 3 tool calls in that step ran');
    });
});
