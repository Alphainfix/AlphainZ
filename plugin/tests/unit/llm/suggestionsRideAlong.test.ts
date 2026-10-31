/**
 * `return_suggestions` in the same batch as a real call.
 *
 * Calling it ends the run, because the chips are the last thing an answer
 * needs. When it rides along with a read, though, the model has not yet seen
 * what it asked to read, and ending there would leave the user a one-line
 * preamble and three chips instead of an answer. Alongside writes it still
 * ends the run — their proposal cards are the output.
 */
import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '../../../src/services/llm/agentLoop';
import type { ChatMessage, ChatProvider, StreamEvent } from '../../../src/services/llm/types';

type Turn = { text?: string; tools?: string[] };

function provider(turns: Turn[]): ChatProvider & { calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    let turn = 0;
    return {
        label: 'Fake',
        model: 'fake-1',
        wireFormat: 'openai',
        calls,
        async stream(request, onEvent: (e: StreamEvent) => void) {
            calls.push(request.messages.map((m) => ({ ...m })));
            const step = turns[Math.min(turn, turns.length - 1)];
            turn += 1;
            if (step.text) onEvent({ type: 'text', text: step.text });
            if (step.tools?.length) {
                const toolCalls = step.tools.map((name, index) => ({
                    index,
                    id: `c${turn}-${index}`,
                    name,
                    argumentsJson: '{}',
                }));
                for (const call of toolCalls) {
                    onEvent({ type: 'tool_call_start', index: call.index, id: call.id, name: call.name });
                }
                onEvent({ type: 'done', stopReason: 'tool_calls', toolCalls });
                return;
            }
            onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        },
    };
}

const run = (p: ChatProvider) =>
    runAgentLoop([{ role: 'user', content: 'go' }], { provider: p, dispatch: async () => 'ok' });

describe('return_suggestions alongside other calls', () => {
    it('gives the model another turn when a read rode along with the suggestions', async () => {
        const p = provider([
            { text: "I'll check the methods section.", tools: ['read_document', 'return_suggestions'] },
            { text: 'The methods section says the doughs were proofed at 24 °C.' },
        ]);
        const result = await run(p);
        expect(p.calls).toHaveLength(2);
        // The second request carries the read's result, so the answer can use it.
        expect(p.calls[1].some((m) => m.role === 'tool' && (m as any).name === 'read_document')).toBe(true);
        expect(result.text).toContain('proofed at 24 °C');
    });

    it('still ends the run when everything else in the batch is a write', async () => {
        const p = provider([
            { text: 'I have drafted the note.', tools: ['create_note', 'return_suggestions'] },
            { text: 'A sign-off nobody asked for.' },
        ]);
        await run(p);
        expect(p.calls).toHaveLength(1);
    });

    it('still ends the run when it is the only call', async () => {
        const p = provider([{ text: 'The answer.', tools: ['return_suggestions'] }, { text: 'again' }]);
        await run(p);
        expect(p.calls).toHaveLength(1);
    });
});
