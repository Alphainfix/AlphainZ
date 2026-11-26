/**
 * What the next request is shown of each earlier run.
 *
 * - A finished run replays in full, as it always has.
 * - A stopped run, or one that failed partway, replays its question, what the
 *   assistant wrote, and each tool call that got its result — so "try again"
 *   or "continue" reaches the model with the question it failed on and what it
 *   had already found. A call that never got a result is left out.
 * - A run that overflowed the context window keeps its question and prose but
 *   not its tool traffic, which is what overflowed it.
 * - The error itself is never replayed as something the assistant said.
 * - A tool result that answers no call before it is dropped.
 * - The same stored runs always give the same messages (the prompt cache
 *   covers only an unchanged prefix).
 */
import { describe, expect, it } from 'vitest';

import {
    buildRunMessages,
    replayFor,
    runToMessages,
    type RunLike,
} from '@beaver/agent-llm/runRequestToMessages';
import type { ChatMessage } from '@beaver/agent-llm/types';

/** A run that searched, read one paper, and was cut off while reading a second. */
function partialRun(overrides: Partial<RunLike> = {}): RunLike {
    return {
        id: 'r-failed',
        status: 'error',
        error: { type: 'llm_service_unavailable' },
        user_prompt: { content: 'Which of my papers discuss waggle-dance odometry?' },
        model_messages: [
            {
                kind: 'response',
                parts: [
                    { part_kind: 'text', content: 'Searching your library.' },
                    { part_kind: 'tool-call', tool_name: 'item_search_by_metadata', tool_call_id: 'c-search', args: { title: 'waggle dance' } },
                ],
            },
            {
                kind: 'request',
                parts: [{ part_kind: 'tool-return', tool_name: 'item_search_by_metadata', tool_call_id: 'c-search', content: { items: ['u-AAAA1111'] } }],
            },
            {
                kind: 'response',
                parts: [
                    { part_kind: 'text', content: 'Found one; reading it.' },
                    { part_kind: 'tool-call', tool_name: 'read_document', tool_call_id: 'c-read', args: { attachment_id: 'u-AAAA1111' } },
                ],
            },
            // The run ended before read_document returned.
        ],
        ...overrides,
    };
}

const completedRun = (id: string, question: string, answer: string): RunLike => ({
    id,
    status: 'completed',
    user_prompt: { content: question },
    model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: answer }] }],
});

/** Every assistant tool call is answered by the tool messages right after it, and every tool message answers one. */
function pairsCleanly(messages: ChatMessage[]): boolean {
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i] as any;
        if (message.role === 'tool') {
            // Only reachable when a tool message is not part of a block that follows a call.
            return false;
        }
        if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
        const open = new Set(message.toolCalls.map((call: any) => call.id));
        let j = i + 1;
        while (j < messages.length && (messages[j] as any).role === 'tool') {
            if (!open.delete((messages[j] as any).toolCallId)) return false;
            j++;
        }
        if (open.size > 0) return false;
        i = j - 1;
    }
    return true;
}

describe('which replay a run gets', () => {
    it('follows its status and, for a failure, the kind of failure', () => {
        expect(replayFor({ status: 'completed' })).toBe('full');
        expect(replayFor({ status: 'awaiting_deferred' })).toBe('full');
        expect(replayFor({ status: 'canceled' })).toBe('answered');
        expect(replayFor({ status: 'error', error: { type: 'llm_rate_limit' } })).toBe('answered');
        expect(replayFor({ status: 'error', error: { type: 'llm_context_window_exceeded' } })).toBe('text');
        // With no type there is no telling an overflow from anything else.
        expect(replayFor({ status: 'error' })).toBe('text');
        expect(replayFor({ status: 'error', error: null })).toBe('text');
    });
});

describe('a run that was stopped or failed partway', () => {
    it.each([
        ['stopped', { status: 'canceled', error: undefined }],
        ['failed', {}],
    ] as const)('when %s, replays the question, the prose and each call that got its result', (_label, overrides) => {
        const messages = runToMessages(partialRun(overrides as Partial<RunLike>), replayFor(partialRun(overrides as Partial<RunLike>)));
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(messages[0].content).toBe('Which of my papers discuss waggle-dance odometry?');
        expect((messages[1] as any).toolCalls.map((call: any) => call.id)).toEqual(['c-search']);
        expect((messages[2] as any).toolCallId).toBe('c-search');
        // The read that never returned is gone, not answered as interrupted.
        expect(messages[3]).toEqual({ role: 'assistant', content: 'Found one; reading it.' });
        expect(JSON.stringify(messages)).not.toContain('c-read');
        expect(JSON.stringify(messages)).not.toContain('did not complete');
        expect(pairsCleanly(messages)).toBe(true);
    });

    it('reaches the next request ahead of "try again", with the question it failed on', () => {
        const messages = buildRunMessages({
            priorRuns: [completedRun('r1', 'Hello?', 'Hi.'), partialRun()],
            prompt: { content: 'try again' },
            systemPrompt: 'sys',
        });
        expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user']);
        expect(messages[3].content).toBe('Which of my papers discuss waggle-dance odometry?');
        expect(messages[messages.length - 1].content).toBe('try again');
        expect(pairsCleanly(messages)).toBe(true);
    });

    it('replays just the question when it failed before any reply', () => {
        const messages = buildRunMessages({
            priorRuns: [partialRun({ model_messages: [], error: { type: 'not_configured' } })],
            prompt: { content: 'try again' },
            systemPrompt: 'sys',
        });
        expect(messages.map((m) => m.content)).toEqual([
            'sys', 'Which of my papers discuss waggle-dance odometry?', 'try again',
        ]);
    });

    it('never replays the error as something the assistant said', () => {
        const failed = partialRun({
            error: { type: 'llm_quota_exceeded', message: 'OpenRouter says the quota or balance is used up.' } as any,
        });
        const text = JSON.stringify(buildRunMessages({ priorRuns: [failed], prompt: { content: 'continue' }, systemPrompt: 'sys' }));
        expect(text).not.toContain('quota');
        expect(text).not.toContain('llm_quota_exceeded');
    });
});

describe('a run that overflowed the context window', () => {
    const overflowed = partialRun({ error: { type: 'llm_context_window_exceeded' } });

    it('keeps the question and the prose, and none of the tool traffic', () => {
        const messages = runToMessages(overflowed, replayFor(overflowed));
        expect(messages).toEqual([
            { role: 'user', content: 'Which of my papers discuss waggle-dance odometry?' },
            // One reply, not two assistant messages back to back.
            { role: 'assistant', content: 'Searching your library.\n\nFound one; reading it.' },
        ]);
    });

    it('is replayed the same way when its error type did not travel with it', () => {
        const untyped = partialRun({ error: undefined });
        expect(runToMessages(untyped, replayFor(untyped))).toEqual(runToMessages(overflowed, replayFor(overflowed)));
    });
});

describe('a finished run', () => {
    it('replays in full, a call it left hanging answered as interrupted', () => {
        const finished = partialRun({ status: 'completed', error: undefined });
        const messages = runToMessages(finished, replayFor(finished));
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
        expect((messages[4] as any).toolCallId).toBe('c-read');
        expect(String(messages[4].content)).toContain('interrupted');
        expect(runToMessages(finished)).toEqual(messages);
    });
});

describe('a tool result that answers no call before it', () => {
    it('is dropped, and the rest of the run is kept', () => {
        const run: RunLike = {
            id: 'r',
            status: 'completed',
            user_prompt: { content: 'q' },
            model_messages: [
                { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'x', tool_call_id: 'c-early', content: 'too soon' }] },
                { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'list_tags', tool_call_id: 'c1', args: {} }] },
                {
                    kind: 'request',
                    parts: [
                        { part_kind: 'tool-return', tool_name: 'ghost', tool_call_id: 'c-ghost', content: 'orphan' },
                        { part_kind: 'tool-return', tool_name: 'list_tags', tool_call_id: 'c1', content: 'tags' },
                        { part_kind: 'retry-prompt', tool_call_id: 'c-ghost-2', content: 'bad args' },
                    ],
                },
                { kind: 'response', parts: [{ part_kind: 'text', content: 'No tags.' }] },
            ],
        };
        const messages = runToMessages(run);
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect((messages[2] as any).toolCallId).toBe('c1');
        expect(JSON.stringify(messages)).not.toMatch(/orphan|too soon|bad args/);
        expect(pairsCleanly(messages)).toBe(true);
    });

    it('does not count as the answer to a call made after it', () => {
        const run: RunLike = {
            id: 'r',
            status: 'canceled',
            model_messages: [
                { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'a', tool_call_id: 'c1', content: 'early' }] },
                { kind: 'response', parts: [{ part_kind: 'text', content: 'Looking.' }, { part_kind: 'tool-call', tool_name: 'a', tool_call_id: 'c1', args: {} }] },
            ],
        };
        // Stopped: the call never got a result, so only the prose is kept.
        expect(runToMessages(run, replayFor(run))).toEqual([{ role: 'assistant', content: 'Looking.' }]);
    });
});

describe('the same stored runs', () => {
    it('always give the same messages, including after a reload', () => {
        const runs = [
            completedRun('r1', 'Hello?', 'Hi.'),
            partialRun(),
            partialRun({ id: 'r3', status: 'canceled', error: undefined }),
            partialRun({ id: 'r4', error: { type: 'llm_context_window_exceeded' } }),
        ];
        const build = (priorRuns: RunLike[]) => JSON.stringify(buildRunMessages({
            priorRuns,
            prompt: { content: 'now' },
            systemPrompt: 'sys',
        }));
        const first = build(runs);
        expect(build(runs)).toBe(first);
        // What the store hands back after a restart is a copy of what was saved.
        expect(build(JSON.parse(JSON.stringify(runs)))).toBe(first);
    });

    it('still start after the summary, with a failed run on either side of its cutoff', () => {
        const messages = buildRunMessages({
            priorRuns: [
                partialRun({ id: 'r0', user_prompt: { content: 'covered and failed' } }),
                completedRun('r1', 'covered', 'yes'),
                partialRun({ id: 'r2', user_prompt: { content: 'after the cutoff' } }),
            ],
            prompt: { content: 'now' },
            systemPrompt: 'sys',
            historySummary: { text: 'What went before.', throughRunId: 'r1', runCount: 1 },
        });
        const text = JSON.stringify(messages);
        expect(text).not.toContain('covered');
        expect(messages[2].content).toBe('after the cutoff');
    });
});
