/**
 * Calling `return_suggestions` ends the run.
 *
 * The prompt tells the model to call it last and it has nothing to report back
 * — the chips are already on screen. Looping anyway bought a whole extra
 * request whose only job was a sign-off, and a model that did not want to sign
 * off restated its entire answer instead: the transcript showed the same
 * answer twice, differing by a word, because it had been generated twice.
 */
import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '@beaver/agent-llm/agentLoop';
import type { ChatMessage, ChatProvider, StreamEvent } from '@beaver/agent-llm/types';

function provider(turns: Array<{ text?: string; tool?: string }>): ChatProvider & { calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    let turn = 0;
    return {
        label: 'Fake', model: 'fake-1', wireFormat: 'openai', calls,
        async stream(request, onEvent: (e: StreamEvent) => void) {
            calls.push(request.messages.map((m) => ({ ...m })));
            const step = turns[Math.min(turn, turns.length - 1)];
            turn += 1;
            if (step.text) onEvent({ type: 'text', text: step.text });
            if (step.tool) {
                const call = { id: `c${turn}`, name: step.tool, argumentsJson: '{}', index: 0 };
                onEvent({ type: 'tool_call_start', index: 0, id: call.id, name: call.name });
                onEvent({ type: 'tool_call_args', index: 0, delta: '{}' });
                onEvent({ type: 'done', stopReason: 'tool_calls', toolCalls: [call] });
                return;
            }
            onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        },
    };
}

const run = (p: ChatProvider) => runAgentLoop([{ role: 'user', content: 'go' }], {
    provider: p, dispatch: async () => 'ok',
});

describe('the suggestions tool', () => {
    it('stops the loop, so the answer is never generated twice', async () => {
        const p = provider([
            { text: 'The full answer, with citations.', tool: 'return_suggestions' },
            { text: 'The full answer, with citations.' },   // never asked for
        ]);
        const result = await run(p);
        expect(p.calls).toHaveLength(1);
        expect(result.reason).toBe('completed');
        expect(result.text).toBe('The full answer, with citations.');
    });

    it('still runs the tool before stopping', async () => {
        const seen: string[] = [];
        const p = provider([{ text: 'answer', tool: 'return_suggestions' }]);
        await runAgentLoop([{ role: 'user', content: 'go' }], {
            provider: p,
            dispatch: async (name: string) => { seen.push(name); return 'ok'; },
        });
        expect(seen).toEqual(['return_suggestions']);
    });

    it('keeps looping for a tool that has something to report', async () => {
        const p = provider([
            { tool: 'read_document' },
            { text: 'now I can answer' },
        ]);
        const result = await run(p);
        expect(p.calls).toHaveLength(2);
        expect(result.text).toBe('now I can answer');
    });

    it('stops when the suggestions come in the same turn as the answer text', async () => {
        // No request is spent to find out there is nothing left.
        const p = provider([{ text: 'answer', tool: 'return_suggestions' }, { text: 'extra' }]);
        await run(p);
        expect(p.calls).toHaveLength(1);
    });
});
