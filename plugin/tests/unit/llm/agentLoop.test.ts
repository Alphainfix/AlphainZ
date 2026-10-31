import { describe, expect, it, vi } from 'vitest';

import { runAgentLoop, serializeToolResult, type LoopEvent } from '../../../src/services/llm/agentLoop';
import type { ChatMessage, ChatProvider, StreamEvent, ToolSchema } from '../../../src/services/llm/types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Script = Array<(emit: (e: StreamEvent) => void) => void>;

/**
 * A provider that replays one scripted turn per call, so a multi-iteration run
 * is expressed as a list of turns.
 */
function scriptedProvider(script: Script): ChatProvider & { calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    let turn = 0;
    return {
        label: 'Fake',
        model: 'fake-1',
        wireFormat: 'openai',
        calls,
        async stream(request, onEvent) {
            calls.push(request.messages.map((m) => ({ ...m })));
            const step = script[turn++];
            if (!step) {
                onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                return;
            }
            step(onEvent);
        },
    };
}

const say = (text: string) => (emit: (e: StreamEvent) => void) => {
    emit({ type: 'text', text });
    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
};

const callTool = (
    calls: Array<{ id: string; name: string; argumentsJson: string }>,
    text = '',
) => (emit: (e: StreamEvent) => void) => {
    if (text) emit({ type: 'text', text });
    calls.forEach((c, index) => {
        emit({ type: 'tool_call_start', index, id: c.id, name: c.name });
        if (c.argumentsJson) {
            emit({ type: 'tool_call_args', index, delta: c.argumentsJson });
        }
    });
    emit({
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: calls.map((c, index) => ({ ...c, index })),
    });
};

const TOOLS: ToolSchema[] = [
    {
        name: 'item_search',
        description: 'Search the library',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
];

const user = (content: string): ChatMessage => ({ role: 'user', content });

// ---------------------------------------------------------------------------
// serializeToolResult
// ---------------------------------------------------------------------------

describe('serializeToolResult', () => {
    it('passes a string through unchanged', () => {
        expect(serializeToolResult('plain', 100)).toBe('plain');
    });

    it('serializes objects as JSON', () => {
        expect(serializeToolResult({ items: [1, 2] }, 100)).toBe('{"items":[1,2]}');
    });

    it('renders undefined as null rather than dropping it', () => {
        expect(serializeToolResult(undefined, 100)).toBe('null');
    });

    it('marks truncation visibly so the model knows data is missing', () => {
        const out = serializeToolResult('x'.repeat(50), 10);
        expect(out.startsWith('x'.repeat(10))).toBe(true);
        expect(out).toContain('truncated 40 characters');
    });

    it('survives a circular structure', () => {
        const circular: any = { name: 'loop' };
        circular.self = circular;
        expect(serializeToolResult(circular, 100)).toContain('could not be serialized');
    });
});

// ---------------------------------------------------------------------------
// Plain turns
// ---------------------------------------------------------------------------

describe('runAgentLoop / no tools', () => {
    it('returns the assistant text and completes in one iteration', async () => {
        const result = await runAgentLoop([user('hi')], {
            provider: scriptedProvider([say('hello')]),
        });
        expect(result).toMatchObject({ text: 'hello', reason: 'completed', iterations: 1 });
    });

    it('appends the assistant reply to the transcript', async () => {
        const result = await runAgentLoop([user('hi')], {
            provider: scriptedProvider([say('hello')]),
        });
        expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'hello' });
    });

    it('reports a truncated turn as length', async () => {
        const provider = scriptedProvider([
            (emit) => {
                emit({ type: 'text', text: 'cut off' });
                emit({ type: 'done', stopReason: 'length', toolCalls: [] });
            },
        ]);
        expect((await runAgentLoop([user('hi')], { provider })).reason).toBe('length');
    });

    it('keeps partial prose when the stream errors late', async () => {
        const provider = scriptedProvider([
            (emit) => {
                emit({ type: 'text', text: 'partial' });
                emit({ type: 'error', error: new Error('socket reset') });
            },
        ]);
        const result = await runAgentLoop([user('hi')], { provider });
        expect(result.text).toBe('partial');
        expect(result.error?.message).toBe('socket reset');
    });

    it('does not throw on provider failure', async () => {
        const provider = scriptedProvider([
            (emit) => emit({ type: 'error', error: new Error('boom') }),
        ]);
        await expect(runAgentLoop([user('hi')], { provider })).resolves.toMatchObject({
            error: expect.any(Error),
        });
    });
});

// ---------------------------------------------------------------------------
// Tool calling
// ---------------------------------------------------------------------------

describe('runAgentLoop / tool calling', () => {
    it('dispatches a call, feeds the result back, and finishes', async () => {
        const dispatch = vi.fn().mockResolvedValue({ hits: 2 });
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'item_search', argumentsJson: '{"q":"bees"}' }]),
            say('found 2'),
        ]);

        const result = await runAgentLoop([user('search bees')], {
            provider,
            tools: TOOLS,
            dispatch,
        });

        // The call's own id travels with it: a tool that has to address the
        // call it is running under — the write tools attach an approval card to
        // it — cannot do so without this.
        expect(dispatch).toHaveBeenCalledWith('item_search', { q: 'bees' }, { toolCallId: 'c1' });
        expect(result).toMatchObject({ text: 'found 2', reason: 'completed', iterations: 2 });
    });

    it('orders the transcript as assistant-then-tool', async () => {
        // The wire format rejects a tool message that does not follow the
        // assistant message requesting it.
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'item_search', argumentsJson: '{"q":"x"}' }]),
            say('done'),
        ]);
        const result = await runAgentLoop([user('go')], {
            provider,
            tools: TOOLS,
            dispatch: async () => ({ ok: true }),
        });

        const roles = result.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
        const assistant = result.messages[1] as any;
        expect(assistant.toolCalls).toEqual([
            { id: 'c1', name: 'item_search', argumentsJson: '{"q":"x"}' },
        ]);
    });

    it('answers every call even when one fails', async () => {
        // A missing tool_call_id makes the whole next request 400, so a thrown
        // tool must still produce a tool message.
        const dispatch = vi
            .fn()
            .mockResolvedValueOnce({ ok: 1 })
            .mockRejectedValueOnce(new Error('library locked'))
            .mockResolvedValueOnce({ ok: 3 });

        const provider = scriptedProvider([
            callTool([
                { id: 'a', name: 'item_search', argumentsJson: '{"q":"1"}' },
                { id: 'b', name: 'item_search', argumentsJson: '{"q":"2"}' },
                { id: 'c', name: 'item_search', argumentsJson: '{"q":"3"}' },
            ]),
            say('partial answer'),
        ]);

        const result = await runAgentLoop([user('go')], { provider, tools: TOOLS, dispatch });

        const toolMessages = result.messages.filter((m) => m.role === 'tool') as any[];
        expect(toolMessages.map((m) => m.toolCallId)).toEqual(['a', 'b', 'c']);
        expect(toolMessages[1].content).toContain('library locked');
        expect(result.reason).toBe('completed');
    });

    it('feeds malformed arguments back instead of dispatching', async () => {
        const dispatch = vi.fn();
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'item_search', argumentsJson: '{"q":' }]),
            say('recovered'),
        ]);

        const result = await runAgentLoop([user('go')], { provider, tools: TOOLS, dispatch });

        expect(dispatch).not.toHaveBeenCalled();
        const toolMessage = result.messages.find((m) => m.role === 'tool') as any;
        expect(toolMessage.content).toContain('not valid JSON');
        expect(result.reason).toBe('completed');
    });

    it('passes an empty object for a zero-argument call', async () => {
        const dispatch = vi.fn().mockResolvedValue('ok');
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'list_libraries', argumentsJson: '' }]),
            say('listed'),
        ]);

        await runAgentLoop([user('go')], { provider, tools: TOOLS, dispatch });
        expect(dispatch).toHaveBeenCalledWith('list_libraries', {}, { toolCallId: 'c1' });
    });

    it('reports an unknown tool back to the model without crashing', async () => {
        const dispatch = vi.fn().mockRejectedValue(new Error('unknown tool "nope"'));
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'nope', argumentsJson: '{}' }]),
            say('apologies'),
        ]);

        const result = await runAgentLoop([user('go')], { provider, tools: TOOLS, dispatch });
        const toolMessage = result.messages.find((m) => m.role === 'tool') as any;
        expect(toolMessage.content).toContain('unknown tool');
        expect(result.reason).toBe('completed');
    });

    it('fails the call gracefully when no dispatcher is configured', async () => {
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'item_search', argumentsJson: '{}' }]),
            say('oh well'),
        ]);
        const result = await runAgentLoop([user('go')], { provider, tools: TOOLS });
        const toolMessage = result.messages.find((m) => m.role === 'tool') as any;
        expect(toolMessage.content).toContain('No tool dispatcher');
    });

    it('accumulates prose across iterations', async () => {
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'item_search', argumentsJson: '{}' }], 'Looking… '),
            say('found it'),
        ]);
        const result = await runAgentLoop([user('go')], {
            provider,
            tools: TOOLS,
            dispatch: async () => 'x',
        });
        expect(result.text).toBe('Looking… found it');
    });
});

// ---------------------------------------------------------------------------
// Bounds and cancellation
// ---------------------------------------------------------------------------

describe('runAgentLoop / bounds', () => {
    it('stops at the iteration limit when the model never settles', async () => {
        const forever: Script = Array.from({ length: 20 }, () =>
            callTool([{ id: 'c', name: 'item_search', argumentsJson: '{}' }]),
        );
        const result = await runAgentLoop([user('go')], {
            provider: scriptedProvider(forever),
            tools: TOOLS,
            dispatch: async () => 'again',
            maxIterations: 3,
        });
        expect(result).toMatchObject({ reason: 'iteration_limit', iterations: 3 });
    });

    it('does not call the provider when already aborted', async () => {
        const provider = scriptedProvider([say('should not run')]);
        const controller = new AbortController();
        controller.abort();

        const result = await runAgentLoop([user('go')], { provider, signal: controller.signal });
        expect(result.reason).toBe('cancelled');
        expect(provider.calls).toHaveLength(0);
    });

    it('stops after a tool round when cancelled mid-run', async () => {
        const controller = new AbortController();
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'item_search', argumentsJson: '{}' }]),
            say('never reached'),
        ]);

        const result = await runAgentLoop([user('go')], {
            provider,
            tools: TOOLS,
            dispatch: async () => {
                controller.abort();
                return 'done';
            },
            signal: controller.signal,
        });

        expect(result.reason).toBe('cancelled');
        expect(provider.calls).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

describe('runAgentLoop / events', () => {
    it('emits tool_args keyed by call id, not wire index', async () => {
        const events: LoopEvent[] = [];
        const provider = scriptedProvider([
            callTool([{ id: 'c1', name: 'item_search', argumentsJson: '{"q":"a"}' }]),
            say('ok'),
        ]);

        await runAgentLoop([user('go')], {
            provider,
            tools: TOOLS,
            dispatch: async () => 'x',
            onEvent: (e) => events.push(e),
        });

        expect(events).toEqual(
            expect.arrayContaining([
                { type: 'tool_start', id: 'c1', name: 'item_search' },
                { type: 'tool_args', id: 'c1', delta: '{"q":"a"}' },
                // The summary is what the transcript shows the user, so it
                // describes the result rather than the fact that there was one.
                { type: 'tool_result', id: 'c1', name: 'item_search', ok: true, summary: 'x' },
            ]),
        );
    });

    it('ends with exactly one finished or failed event', async () => {
        const events: LoopEvent[] = [];
        await runAgentLoop([user('hi')], {
            provider: scriptedProvider([say('done')]),
            onEvent: (e) => events.push(e),
        });
        const terminals = events.filter((e) => e.type === 'finished' || e.type === 'failed');
        expect(terminals).toEqual([{ type: 'finished', reason: 'completed', text: 'done' }]);
    });

    it('reports reasoning separately from answer text', async () => {
        const events: LoopEvent[] = [];
        const provider = scriptedProvider([
            (emit) => {
                emit({ type: 'reasoning', text: 'thinking' });
                emit({ type: 'text', text: 'answer' });
                emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
            },
        ]);

        const result = await runAgentLoop([user('hi')], { provider, onEvent: (e) => events.push(e) });

        expect(events).toContainEqual({ type: 'reasoning', text: 'thinking' });
        expect(result.text).toBe('answer');
    });
});
