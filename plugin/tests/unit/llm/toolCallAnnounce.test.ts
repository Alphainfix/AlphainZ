/**
 * Tool calls from endpoints that stream them loosely.
 *
 * Some OpenAI-compatible servers leave `id` off their tool-call deltas, or
 * repeat the function name on every chunk. Such a call is still announced
 * before it runs, under the id it runs with, and its name is read once. Were
 * it not, the call would run with no tool card, the next step's text would
 * start with a copy of the previous step's, and the saved run would replay as
 * a tool result with no call before it — which strict endpoints reject on
 * every later message in the thread.
 */
import { describe, expect, it } from 'vitest';

import { runLocalAgent, type LocalRunCallbacks } from '../../../src/services/llm/localRunner';
import { toOpenAIMessages } from '../../../src/services/llm/openAICompatible';
import { ToolCallAssembler, parseSseStream, type StreamEvent } from '../../../src/services/llm/sse';
import type { ChatMessage, ChatProvider, ToolSchema } from '../../../src/services/llm/types';

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

const oa = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

async function collect(chunks: string[]): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    await parseSseStream(readerOf(chunks), 'openai', (e) => events.push(e));
    return events;
}

describe('tool calls streamed without an id', () => {
    it('are announced before the turn ends, under the id they will run with', async () => {
        const events = await collect([
            oa({ tool_calls: [{ index: 0, function: { name: 'read_document' } }] }),
            oa({ tool_calls: [{ index: 0, function: { arguments: '{"attachment_id":"1-AB"}' } }] }),
            oa({}, 'tool_calls'),
        ]);
        const starts = events.filter((e) => e.type === 'tool_call_start') as Array<Extract<StreamEvent, { type: 'tool_call_start' }>>;
        const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;
        expect(starts).toHaveLength(1);
        expect(starts[0].name).toBe('read_document');
        expect(done.toolCalls[0].id).toBe(starts[0].id);
        // Announced before `done`, so the loop knows the call before it runs it.
        expect(events.indexOf(starts[0])).toBeLessThan(events.indexOf(done));
    });

    it('are announced once, not again when an id-carrying call is also present', async () => {
        const events = await collect([
            oa({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }] }),
            oa({ tool_calls: [{ index: 1, function: { name: 'b', arguments: '{}' } }] }),
            oa({}, 'tool_calls'),
        ]);
        const starts = events.filter((e) => e.type === 'tool_call_start') as any[];
        expect(starts.map((s) => s.name)).toEqual(['a', 'b']);
    });
});

describe('a function name repeated on every chunk', () => {
    it('is the name once, not the name twice', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 0, id: 'c1', name: 'read_document' });
        a.ingest({ index: 0, name: 'read_document', argumentsDelta: '{"p":' });
        a.ingest({ index: 0, name: 'read_document', argumentsDelta: '1}' });
        expect(a.finalize()[0]).toMatchObject({ name: 'read_document', argumentsJson: '{"p":1}' });
    });

    it('is taken whole when the provider re-sends it growing', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 0, id: 'c1', name: 'read' });
        a.ingest({ index: 0, name: 'read_doc' });
        a.ingest({ index: 0, name: 'read_document' });
        expect(a.finalize()[0].name).toBe('read_document');
    });

    it('still joins a name that really was split across chunks', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 0, id: 'c1', name: 'item_' });
        a.ingest({ index: 0, name: 'search' });
        expect(a.finalize()[0].name).toBe('item_search');
    });
});

describe('runLocalAgent / a call the stream never announced', () => {
    const TOOLS: ToolSchema[] = [
        { name: 'read_document', description: 'Read', parameters: { type: 'object', properties: {} } },
    ];

    it('does not start the next step with the previous step\'s text', async () => {
        const parts: any[] = [];
        const callbacks: LocalRunCallbacks = {
            onThread: () => undefined,
            onReady: () => undefined,
            onPart: (e) => {
                parts.push(e);
            },
            onToolCallArgsStream: () => undefined,
            onToolReturn: () => undefined,
            onToolCallProgress: () => undefined,
            onRunComplete: () => undefined,
            onDone: () => undefined,
            onError: () => undefined,
        };
        let turn = 0;
        const provider: ChatProvider = {
            label: 'Fake',
            model: 'm',
            wireFormat: 'openai',
            async stream(_request, emit) {
                turn += 1;
                if (turn === 1) {
                    // A call that arrives only in `done`, with no tool_call_start.
                    emit({ type: 'text', text: 'Let me look. ' });
                    emit({
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ index: 0, id: 'call_0', name: 'read_document', argumentsJson: '{}' }],
                    });
                    return;
                }
                emit({ type: 'text', text: 'Found it.' });
                emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
            },
        };

        await runLocalAgent({
            runId: 'r',
            threadId: 't',
            messages: [{ role: 'user', content: 'go' }],
            provider,
            tools: TOOLS,
            dispatch: async () => 'page',
            callbacks,
        });

        const finalText = parts.filter((p) => p.message_index === 2 && p.part.part_kind === 'text').at(-1);
        expect(finalText.part.content).toBe('Found it.');
    });
});

describe('toOpenAIMessages / pairing calls with results', () => {
    it('drops a tool result that no preceding call asked for', () => {
        // What a saved run with an unannounced call replays as: the result is
        // there, the call is not. A strict endpoint rejects the whole request.
        const wire = toOpenAIMessages([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'Let me look.' },
            { role: 'tool', toolCallId: 'call_0', name: 'read_document', content: 'page 3 of 12' },
            { role: 'assistant', content: 'Found it.' },
            { role: 'user', content: 'next question' },
        ] as ChatMessage[]);
        expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
    });

    it('answers a call the history left without a result', () => {
        const wire = toOpenAIMessages([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'a', name: 'read_document', argumentsJson: '{}' },
                    { id: 'b', name: 'get_metadata', argumentsJson: '{}' },
                ],
            },
            { role: 'tool', toolCallId: 'a', name: 'read_document', content: 'ok' },
            { role: 'user', content: 'next' },
        ] as ChatMessage[]);
        expect(wire.map((m) => [m.role, m.tool_call_id ?? null])).toEqual([
            ['user', null],
            ['assistant', null],
            ['tool', 'a'],
            ['tool', 'b'],
            ['user', null],
        ]);
    });

    it('drops a duplicate result for a call already answered', () => {
        const wire = toOpenAIMessages([
            { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', argumentsJson: '{}' }] },
            { role: 'tool', toolCallId: 'a', name: 'x', content: 'first' },
            { role: 'tool', toolCallId: 'a', name: 'x', content: 'second' },
        ] as ChatMessage[]);
        expect(wire.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['first']);
    });
});
