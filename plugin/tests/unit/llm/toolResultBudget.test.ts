/**
 * A tool result is not paid for once.
 *
 * It stays in the message array for every later request in the run, so a
 * 60,000-character search payload costs its ~17k tokens again on each of them
 * — measured at 106k–151k input tokens for a three-tool library question. A
 * page of a paper is worth that; a list of search hits is not.
 */
import { describe, expect, it } from 'vitest';

import { runAgentLoop } from '../../../src/services/llm/agentLoop';
import type { ChatMessage, ChatProvider, StreamEvent } from '../../../src/services/llm/types';

function twoTurnProvider(toolName: string): ChatProvider & { calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    let turn = 0;
    return {
        label: 'Fake', model: 'fake-1', wireFormat: 'openai', calls,
        async stream(request, onEvent: (e: StreamEvent) => void) {
            calls.push(request.messages.map((m) => ({ ...m })));
            if (turn++ === 0) {
                const call = { id: 'c1', name: toolName, argumentsJson: '{}', index: 0 };
                onEvent({ type: 'tool_call_start', index: 0, id: call.id, name: call.name });
                onEvent({ type: 'tool_call_args', index: 0, delta: '{}' });
                onEvent({ type: 'done', stopReason: 'tool_calls', toolCalls: [call] });
                return;
            }
            onEvent({ type: 'text', text: 'done' });
            onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        },
    };
}

/** Far larger than any budget, so what comes back is the budget itself. */
const hugeResult = {
    hits: Array.from({ length: 400 }, (_, i) => ({ title: `Paper ${i} — ${'x'.repeat(400)}` })),
};

async function resultSizeFor(toolName: string): Promise<number> {
    const provider = twoTurnProvider(toolName);
    await runAgentLoop([{ role: 'user', content: 'go' }], {
        provider,
        dispatch: async () => hugeResult,
    });
    const second = provider.calls[1] ?? [];
    const toolMessage = second.find((m: any) => m.role === 'tool');
    return String((toolMessage as any)?.content ?? '').length;
}

describe('how much of a tool result the model is handed', () => {
    it('keeps a literature search short', async () => {
        expect(await resultSizeFor('search_web_literature')).toBeLessThanOrEqual(12_500);
    });

    it('caps the library searches the same way', async () => {
        for (const name of ['item_search_by_topic', 'item_search_by_metadata']) {
            expect(await resultSizeFor(name)).toBeLessThanOrEqual(12_500);
        }
    });

    it('caps a single-paper lookup tighter still', async () => {
        expect(await resultSizeFor('lookup_paper')).toBeLessThanOrEqual(8_500);
    });

    it('leaves a document read the large budget', async () => {
        // This is the case the 60k budget exists for: a page of a paper.
        expect(await resultSizeFor('read_document')).toBeGreaterThan(20_000);
    });
});
