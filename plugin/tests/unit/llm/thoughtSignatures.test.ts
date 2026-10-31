/**
 * Gemini's thought signatures: every tool call it makes carries one in
 * `extra_content`, and the next request of the same turn is refused unless
 * the call comes back with it ("Function call is missing a thought_signature").
 * Of parallel calls only the first carries one; each goes back as it came.
 */
import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '../../../src/services/llm/agentLoop';
import { toOpenAIMessages } from '../../../src/services/llm/openAICompatible';
import { parseSseStream, type StreamEvent } from '../../../src/services/llm/sse';
import type { ChatMessage, ChatProvider, ToolSchema } from '../../../src/services/llm/types';

const SIGNATURE = { google: { thought_signature: 'EmkKZwFpFH0TGZDc' } };

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

/** The two frames Gemini's OpenAI-compatible endpoint streams for a turn of two calls. */
const GEMINI_FRAMES = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [
        { extra_content: SIGNATURE, function: { arguments: '{"query":"pollen"}', name: 'search_library' }, id: 'call_1', type: 'function' },
        { function: { arguments: '{"key":"ZMX4B3KZ"}', name: 'get_metadata' }, id: 'call_2', type: 'function' },
    ] }, index: 0 }] })}\n\n`,
    // A turn that called tools ends with "stop" on this endpoint.
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop', index: 0 }] })}\n\n`,
    'data: [DONE]\n\n',
];

describe('thought signatures', () => {
    it('are kept on the call that carried one, and only there', async () => {
        const events: StreamEvent[] = [];
        await parseSseStream(readerOf(GEMINI_FRAMES), 'openai', (e) => events.push(e));
        const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;
        expect(done.stopReason).toBe('tool_calls');
        expect(done.toolCalls.map((c) => [c.name, c.extraContent ?? null])).toEqual([
            ['search_library', SIGNATURE],
            ['get_metadata', null],
        ]);
    });

    it('go back on the wire exactly as they came', () => {
        const wire = toOpenAIMessages([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'call_1', name: 'search_library', argumentsJson: '{"query":"pollen"}', extraContent: SIGNATURE },
                    { id: 'call_2', name: 'get_metadata', argumentsJson: '{"key":"ZMX4B3KZ"}' },
                ],
            },
            { role: 'tool', toolCallId: 'call_1', name: 'search_library', content: '[]' },
            { role: 'tool', toolCallId: 'call_2', name: 'get_metadata', content: '{}' },
        ] as ChatMessage[]);
        const calls = wire[1].tool_calls!;
        expect(calls[0].extra_content).toEqual(SIGNATURE);
        expect(calls[1]).not.toHaveProperty('extra_content');
    });

    it('reach the next request of the run', async () => {
        const requests: ChatMessage[][] = [];
        let turn = 0;
        const provider: ChatProvider = {
            label: 'Gemini',
            model: 'gemini-3.8-flash',
            wireFormat: 'openai',
            async stream(request, onEvent) {
                requests.push(request.messages.map((m) => ({ ...m })));
                if (turn++ === 0) {
                    await parseSseStream(readerOf(GEMINI_FRAMES), 'openai', onEvent);
                    return;
                }
                onEvent({ type: 'text', text: 'Found it.' });
                onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
            },
        };
        const tools: ToolSchema[] = ['search_library', 'get_metadata'].map((name) => ({
            name,
            description: name,
            parameters: { type: 'object', properties: {}, required: [] },
        }));
        await runAgentLoop([{ role: 'user', content: 'q' }], {
            provider,
            tools,
            dispatch: async () => ({ ok: true }),
        });
        const assistant = requests[1].find((m) => m.role === 'assistant') as Extract<ChatMessage, { role: 'assistant' }>;
        expect(assistant.toolCalls?.[0].extraContent).toEqual(SIGNATURE);
        expect(toOpenAIMessages(requests[1])[1].tool_calls?.[0].extra_content).toEqual(SIGNATURE);
    });
});
