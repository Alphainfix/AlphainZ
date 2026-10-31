/**
 * A configured provider whose requests fail is reported to the person, not
 * only to the model: after a search that embeds the query, the run asks
 * whether embedding failed since it began, and warns once.
 */
import { describe, expect, it } from 'vitest';

import { runLocalAgent, type LocalRunCallbacks } from '../../../src/services/llm/localRunner';
import type { ChatProvider, StreamEvent, ToolSchema } from '../../../src/services/llm/types';

function provider(turns: Array<Array<{ id: string; name: string }>>): ChatProvider {
    let turn = 0;
    return {
        label: 'Fake',
        model: 'fake-1',
        wireFormat: 'openai',
        async stream(_request, onEvent: (e: StreamEvent) => void) {
            const calls = turns[turn++];
            if (!calls) {
                onEvent({ type: 'text', text: 'Done.' });
                onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                return;
            }
            calls.forEach((c, index) => onEvent({ type: 'tool_call_start', index, id: c.id, name: c.name }));
            onEvent({ type: 'done', stopReason: 'tool_calls', toolCalls: calls.map((c, index) => ({ ...c, index, argumentsJson: '{}' })) });
        },
    };
}

function run(
    turns: Array<Array<{ id: string; name: string }>>,
    embeddingFailureSince?: (since: number) => string | null,
) {
    const warnings: any[] = [];
    const noop = () => {};
    const callbacks: LocalRunCallbacks = {
        onThread: noop, onReady: noop, onPart: noop, onToolCallArgsStream: noop, onToolReturn: noop,
        onToolCallProgress: noop, onRunComplete: noop, onDone: noop, onError: noop,
        onWarning: (w) => warnings.push(w),
    };
    const tools: ToolSchema[] = ['item_search_by_topic', 'search_library_fulltext', 'list_tags'].map((name) => ({
        name, description: name, parameters: { type: 'object', properties: {}, required: [] },
    }));
    return runLocalAgent({
        runId: 'run-1', threadId: 't-1', messages: [{ role: 'user', content: 'q' }],
        provider: provider(turns), tools, callbacks,
        dispatch: async () => ({ items: [] }),
        embeddingFailureSince,
    }).then(() => warnings);
}

const REASON = 'Google Gemini rejected the API key (403). Check it under Settings → Model.';

describe('the search failure warning in a run', () => {
    it('warns once, however many searches failed', async () => {
        const warnings = await run(
            [[{ id: 'a', name: 'item_search_by_topic' }], [{ id: 'b', name: 'search_library_fulltext' }]],
            () => REASON,
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ type: 'semantic_search_failed', run_id: 'run-1' });
        expect(warnings[0].message).toContain(REASON);
    });

    it('asks from the moment the run began, and only after a search', async () => {
        const asked: number[] = [];
        const before = Date.now();
        const warnings = await run([[{ id: 'a', name: 'list_tags' }], [{ id: 'b', name: 'item_search_by_topic' }]], (since) => {
            asked.push(since);
            return null;
        });
        expect(warnings).toHaveLength(0);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toBeGreaterThanOrEqual(before);
    });
});
