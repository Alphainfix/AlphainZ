import { describe, expect, it } from 'vitest';

import {
    ToolCallAssembler,
    parseSseStream,
    parseToolArguments,
    splitSseLines,
    type StreamEvent,
} from '../../../src/services/llm/sse';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a reader over the given chunks verbatim. Chunk boundaries are the point
 * of these tests: real providers split payloads at arbitrary byte offsets, so
 * every case that matters is expressed by *where* the chunks are cut.
 */
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

async function collect(
    chunks: string[],
    format: 'openai' | 'anthropic' = 'openai',
): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    await parseSseStream(readerOf(chunks), format, (e) => events.push(e));
    return events;
}

const text = (events: StreamEvent[]) =>
    events.filter((e) => e.type === 'text').map((e) => (e as any).text).join('');

const reasoning = (events: StreamEvent[]) =>
    events.filter((e) => e.type === 'reasoning').map((e) => (e as any).text).join('');

const doneEvent = (events: StreamEvent[]) =>
    events.find((e) => e.type === 'done') as
        | Extract<StreamEvent, { type: 'done' }>
        | undefined;

/** One OpenAI-shaped `data:` line. */
const oa = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

// ---------------------------------------------------------------------------
// splitSseLines
// ---------------------------------------------------------------------------

describe('splitSseLines', () => {
    it('holds back the trailing partial line', () => {
        expect(splitSseLines('a\nb\npart')).toEqual({ lines: ['a', 'b'], rest: 'part' });
    });

    it('treats CRLF the same as LF', () => {
        expect(splitSseLines('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], rest: '' });
    });

    it('reports an empty buffer as no lines', () => {
        expect(splitSseLines('')).toEqual({ lines: [], rest: '' });
    });
});

// ---------------------------------------------------------------------------
// parseToolArguments
// ---------------------------------------------------------------------------

describe('parseToolArguments', () => {
    it('treats an empty payload as a zero-argument call', () => {
        // A zero-arg tool streams no argument fragments at all, so JSON.parse
        // would throw on the empty accumulator.
        expect(parseToolArguments('')).toEqual({ ok: true, value: {} });
        expect(parseToolArguments('   ')).toEqual({ ok: true, value: {} });
    });

    it('parses an object', () => {
        expect(parseToolArguments('{"q":"bees"}')).toEqual({ ok: true, value: { q: 'bees' } });
    });

    it('reports malformed JSON instead of throwing', () => {
        const result = parseToolArguments('{"q":');
        expect(result.ok).toBe(false);
    });

    it('rejects non-object JSON', () => {
        expect(parseToolArguments('[1,2]').ok).toBe(false);
        expect(parseToolArguments('"hi"').ok).toBe(false);
        expect(parseToolArguments('null').ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ToolCallAssembler
// ---------------------------------------------------------------------------

describe('ToolCallAssembler', () => {
    it('announces a call once id and name arrive in separate fragments', () => {
        // The regression this class exists for: requiring id and name in the
        // same chunk drops calls from providers that split them.
        const a = new ToolCallAssembler();
        expect(a.ingest({ index: 0, id: 'call_1' })).toEqual([]);
        expect(a.ingest({ index: 0, name: 'item_search' })).toEqual([
            { type: 'tool_call_start', index: 0, id: 'call_1', name: 'item_search' },
        ]);
    });

    it('announces only once even when id repeats on every fragment', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 0, id: 'c1', name: 'read' });
        const again = a.ingest({ index: 0, id: 'c1', argumentsDelta: '{}' });
        expect(again.filter((e) => e.type === 'tool_call_start')).toEqual([]);
    });

    it('concatenates a name split across fragments', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 0, id: 'c1', name: 'item_' });
        a.ingest({ index: 0, name: 'search' });
        expect(a.finalize()[0].name).toBe('item_search');
    });

    it('keeps parallel calls in separate slots and orders them by index', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 1, id: 'b', name: 'second', argumentsDelta: '{"i":2}' });
        a.ingest({ index: 0, id: 'a', name: 'first', argumentsDelta: '{"i":1}' });
        expect(a.finalize().map((c) => c.name)).toEqual(['first', 'second']);
    });

    it('stitches argument fragments in arrival order', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 0, id: 'c1', name: 'f' });
        for (const part of ['{"que', 'ry":"waggle ', 'dance"}']) {
            a.ingest({ index: 0, argumentsDelta: part });
        }
        expect(parseToolArguments(a.finalize()[0].argumentsJson)).toEqual({
            ok: true,
            value: { query: 'waggle dance' },
        });
    });

    it('synthesises an id when the provider omits one', () => {
        const a = new ToolCallAssembler();
        a.ingest({ index: 3, name: 'lone_call' });
        const [call] = a.finalize();
        expect(call).toMatchObject({ index: 3, name: 'lone_call', argumentsJson: '' });
        expect(call.id).toMatch(/^call_3_/);
        // Stable: the id the loop runs the call under is the one it was shown under.
        expect(a.finalize()[0].id).toBe(call.id);
    });

    it('never gives two assemblers the same synthesised id', () => {
        // Tool results are keyed by id across a whole thread; two turns that
        // each made an id-less first call must not collide.
        const first = new ToolCallAssembler();
        const second = new ToolCallAssembler();
        first.ingest({ index: 0, name: 'read' });
        second.ingest({ index: 0, name: 'read' });
        expect(first.finalize()[0].id).not.toBe(second.finalize()[0].id);
    });

    it('drops a slot that never learned a name', () => {
        // Arguments with no name are unroutable; surfacing them would make the
        // loop dispatch to `undefined`.
        const a = new ToolCallAssembler();
        a.ingest({ index: 0, argumentsDelta: '{"orphan":true}' });
        expect(a.finalize()).toEqual([]);
        expect(a.isEmpty).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// parseSseStream — OpenAI wire format
// ---------------------------------------------------------------------------

describe('parseSseStream / openai', () => {
    it('assembles text across chunks and ends with one done', async () => {
        const events = await collect([
            oa({ content: 'Hello' }),
            oa({ content: ' world' }),
            oa({}, 'stop'),
            'data: [DONE]\n\n',
        ]);
        expect(text(events)).toBe('Hello world');
        expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
        expect(doneEvent(events)!.stopReason).toBe('end_turn');
    });

    it('reassembles a payload split mid-JSON across chunk boundaries', async () => {
        const line = oa({ content: 'split' });
        const cut = Math.floor(line.length / 2);
        const events = await collect([line.slice(0, cut), line.slice(cut)]);
        expect(text(events)).toBe('split');
    });

    it('reassembles a payload split one byte at a time', async () => {
        const line = oa({ content: 'drip' });
        const events = await collect(line.split(''));
        expect(text(events)).toBe('drip');
    });

    it('separates DeepSeek reasoning_content from answer text', async () => {
        const events = await collect([
            oa({ reasoning_content: 'thinking…' }),
            oa({ content: 'answer' }),
            oa({}, 'stop'),
        ]);
        expect(reasoning(events)).toBe('thinking…');
        expect(text(events)).toBe('answer');
    });

    it('also reads the OpenRouter `reasoning` spelling', async () => {
        const events = await collect([oa({ reasoning: 'hmm' }), oa({}, 'stop')]);
        expect(reasoning(events)).toBe('hmm');
    });

    it('ignores keep-alives, comments and bare data lines', async () => {
        const events = await collect([
            ': keep-alive\n\n',
            'data:\n\n',
            '\n',
            oa({ content: 'ok' }),
            oa({}, 'stop'),
        ]);
        expect(text(events)).toBe('ok');
        expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it('skips an undecodable data line without failing the stream', async () => {
        const events = await collect([
            'data: {"choices":[{"delta":\n\n',
            oa({ content: 'survived' }),
            oa({}, 'stop'),
        ]);
        expect(text(events)).toBe('survived');
        expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it('reports tool_calls as the stop reason and returns the assembled call', async () => {
        const events = await collect([
            oa({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'item_search' } }] }),
            oa({ tool_calls: [{ index: 0, function: { arguments: '{"q":"bees"}' } }] }),
            oa({}, 'tool_calls'),
        ]);
        const done = doneEvent(events)!;
        expect(done.stopReason).toBe('tool_calls');
        expect(done.toolCalls).toEqual([
            { index: 0, id: 'c1', name: 'item_search', argumentsJson: '{"q":"bees"}' },
        ]);
    });

    it('emits tool_call_start once and streams the argument deltas in order', async () => {
        const events = await collect([
            oa({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read' } }] }),
            oa({ tool_calls: [{ index: 0, function: { arguments: '{"p":' } }] }),
            oa({ tool_calls: [{ index: 0, function: { arguments: '3}' } }] }),
            oa({}, 'tool_calls'),
        ]);
        expect(events.filter((e) => e.type === 'tool_call_start')).toHaveLength(1);
        expect(
            events.filter((e) => e.type === 'tool_call_args').map((e) => (e as any).delta),
        ).toEqual(['{"p":', '3}']);
    });

    it('recovers a call whose id and name land in different chunks', async () => {
        const events = await collect([
            oa({ tool_calls: [{ index: 0, id: 'c9' }] }),
            oa({ tool_calls: [{ index: 0, function: { name: 'find_annotations' } }] }),
            oa({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
            oa({}, 'tool_calls'),
        ]);
        expect(doneEvent(events)!.toolCalls).toEqual([
            { index: 0, id: 'c9', name: 'find_annotations', argumentsJson: '{}' },
        ]);
    });

    it('keeps two parallel calls apart when index is absent', async () => {
        // Some compatible providers omit `index`; array position has to stand in
        // or both calls collapse into one slot.
        const events = await collect([
            oa({
                tool_calls: [
                    { id: 'a', function: { name: 'first', arguments: '{"i":1}' } },
                    { id: 'b', function: { name: 'second', arguments: '{"i":2}' } },
                ],
            }),
            oa({}, 'tool_calls'),
        ]);
        expect(doneEvent(events)!.toolCalls.map((c) => c.name)).toEqual(['first', 'second']);
    });

    it('infers tool_calls when the stream ends with no terminal marker', async () => {
        const events = await collect([
            oa({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{}' } }] }),
        ]);
        const done = doneEvent(events)!;
        expect(done.stopReason).toBe('tool_calls');
        expect(done.toolCalls).toHaveLength(1);
    });

    it('fails an empty body rather than calling it a finished turn', async () => {
        // A response with no frames never was a stream. Reporting `done` would
        // turn a rejected request into a blank answer with no error attached.
        const events = await collect([]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: 'error',
            error: {
                message: 'The endpoint returned an empty response instead of a completion stream.',
                kind: 'provider',
            },
        });
    });

    it('surfaces a JSON error body served with a 200 and a stream content type', async () => {
        // Exactly what an API gateway returned for an unknown model: HTTP
        // 200, `content-type: text/event-stream`, and a plain JSON error. The
        // message has to reach the user, or a typo in the model name looks like
        // a model that simply had nothing to say.
        const events = await collect([
            JSON.stringify({
                error: {
                    message: 'The model `gpt-5.6-nonexistent` does not exist or you do not have access to it.',
                    code: 'model_not_found',
                },
            }),
        ]);
        expect(events).toHaveLength(1);
        expect((events[0] as any).error.message).toBe(
            'The model `gpt-5.6-nonexistent` does not exist or you do not have access to it.',
        );
    });

    it('quotes a non-JSON body it cannot interpret', async () => {
        const events = await collect(['<html><body>502 Bad Gateway</body></html>']);
        expect((events[0] as any).error.message).toContain('502 Bad Gateway');
    });

    it('accepts a stream whose only frame is a keep-alive followed by a finish', async () => {
        // A bare `data:` is a spec-legal keep-alive, and proves this really is a
        // stream — so this must not be mistaken for a non-SSE body.
        const events = await collect(['data:\n\n', oa({}, 'stop')]);
        expect(doneEvent(events)!.stopReason).toBe('end_turn');
        expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it('accepts a comment-only stream that later carries a frame', async () => {
        const events = await collect([': keep-alive\n\n', oa({ content: 'hi' }, 'stop')]);
        expect(text(events)).toBe('hi');
        expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it('maps length and content_filter finish reasons', async () => {
        expect(doneEvent(await collect([oa({}, 'length')]))!.stopReason).toBe('length');
        expect(doneEvent(await collect([oa({}, 'content_filter')]))!.stopReason).toBe(
            'content_filter',
        );
    });

    it('surfaces a reader failure as a single error event', async () => {
        const reader = {
            async read() {
                throw new Error('socket reset');
            },
        } as unknown as ReadableStreamDefaultReader<Uint8Array>;

        const events: StreamEvent[] = [];
        await parseSseStream(reader, 'openai', (e) => events.push(e));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'error' });
        expect((events[0] as any).error.message).toBe('socket reset');
    });

    it('never emits both done and error', async () => {
        let calls = 0;
        const reader = {
            async read() {
                calls += 1;
                if (calls === 1) {
                    return { done: false, value: new TextEncoder().encode(oa({ content: 'x' })) };
                }
                throw new Error('mid-stream failure');
            },
        } as unknown as ReadableStreamDefaultReader<Uint8Array>;

        const events: StreamEvent[] = [];
        await parseSseStream(reader, 'openai', (e) => events.push(e));
        const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
        expect(terminals).toHaveLength(1);
        expect(terminals[0].type).toBe('error');
    });
});

// ---------------------------------------------------------------------------
// parseSseStream — Anthropic wire format
// ---------------------------------------------------------------------------

describe('parseSseStream / anthropic', () => {
    const ev = (obj: Record<string, unknown>) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

    it('reads text deltas and stops on message_stop', async () => {
        const events = await collect(
            [
                ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
                ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
                ev({ type: 'message_stop' }),
            ],
            'anthropic',
        );
        expect(text(events)).toBe('Hi');
        expect(doneEvent(events)!.stopReason).toBe('end_turn');
    });

    it('reads extended thinking as reasoning', async () => {
        const events = await collect(
            [
                ev({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'thinking_delta', thinking: 'let me see' },
                }),
                ev({ type: 'message_stop' }),
            ],
            'anthropic',
        );
        expect(reasoning(events)).toBe('let me see');
    });

    it('assembles a tool_use block from input_json_delta fragments', async () => {
        const events = await collect(
            [
                ev({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_metadata' },
                }),
                ev({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"item' },
                }),
                ev({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '_ids":[1]}' },
                }),
                ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
            ],
            'anthropic',
        );
        const done = doneEvent(events)!;
        expect(done.stopReason).toBe('tool_calls');
        expect(done.toolCalls).toEqual([
            { index: 0, id: 'toolu_1', name: 'get_metadata', argumentsJson: '{"item_ids":[1]}' },
        ]);
    });

    it('turns a stream error event into an error and stops', async () => {
        const events = await collect(
            [
                ev({ type: 'error', error: { message: 'overloaded_error' } }),
                ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'nope' } }),
            ],
            'anthropic',
        );
        expect(events).toHaveLength(1);
        expect((events[0] as any).error.message).toBe('overloaded_error');
    });
});
