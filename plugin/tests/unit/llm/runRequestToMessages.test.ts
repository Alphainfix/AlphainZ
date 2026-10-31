import { describe, expect, it } from 'vitest';

import {
    buildRunMessages,
    composeUserContent,
    describePromptContext,
    runToMessages,
    type RunLike,
} from '../../../src/services/llm/runRequestToMessages';

const roles = (messages: ReturnType<typeof runToMessages>) => messages.map((m) => m.role);

// ---------------------------------------------------------------------------
// runToMessages
// ---------------------------------------------------------------------------

describe('runToMessages', () => {
    it('turns a plain question and answer into two messages', () => {
        const run: RunLike = {
            id: 'r1',
            user_prompt: { content: 'How many collections?' },
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'text', content: 'You have 26.' }] },
            ],
        };
        expect(runToMessages(run)).toEqual([
            { role: 'user', content: 'How many collections?' },
            { role: 'assistant', content: 'You have 26.' },
        ]);
    });

    it('joins text parts split across a streamed response', () => {
        const run: RunLike = {
            id: 'r1',
            user_prompt: { content: 'q' },
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'text', content: 'Hello ' },
                        { part_kind: 'text', content: 'world' },
                    ],
                },
            ],
        };
        expect((runToMessages(run)[1] as any).content).toBe('Hello world');
    });

    it('preserves a tool call and its result in order', () => {
        const run: RunLike = {
            id: 'r1',
            user_prompt: { content: 'search' },
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'text', content: 'Looking…' },
                        {
                            part_kind: 'tool-call',
                            tool_name: 'list_tags',
                            tool_call_id: 'c1',
                            args: { limit: 5 },
                        },
                    ],
                },
                {
                    kind: 'request',
                    parts: [
                        { part_kind: 'tool-return', tool_name: 'list_tags', tool_call_id: 'c1', content: { tags: [] } },
                    ],
                },
                { kind: 'response', parts: [{ part_kind: 'text', content: 'No tags.' }] },
            ],
        };

        const messages = runToMessages(run);
        expect(roles(messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect((messages[1] as any).toolCalls).toEqual([
            { id: 'c1', name: 'list_tags', argumentsJson: '{"limit":5}' },
        ]);
        expect((messages[2] as any).toolCallId).toBe('c1');
    });

    it('serializes object args and passes string args through', () => {
        const build = (args: any) =>
            (runToMessages({
                id: 'r',
                model_messages: [
                    {
                        kind: 'response',
                        parts: [{ part_kind: 'tool-call', tool_name: 't', tool_call_id: 'c', args }],
                    },
                ],
            })[0] as any).toolCalls[0].argumentsJson;

        expect(build({ a: 1 })).toBe('{"a":1}');
        expect(build('{"a":1}')).toBe('{"a":1}');
        expect(build(null)).toBe('{}');
    });

    it('closes a tool call the run never answered', () => {
        // An unanswered tool_call_id makes the next request 400 outright, so an
        // interrupted run has to be repaired rather than replayed as-is.
        const run: RunLike = {
            id: 'r1',
            user_prompt: { content: 'q' },
            model_messages: [
                {
                    kind: 'response',
                    parts: [{ part_kind: 'tool-call', tool_name: 'read', tool_call_id: 'c9', args: {} }],
                },
            ],
        };

        const messages = runToMessages(run);
        expect(roles(messages)).toEqual(['user', 'assistant', 'tool']);
        expect((messages[2] as any).content).toContain('interrupted');
        expect((messages[2] as any).toolCallId).toBe('c9');
    });

    it('answers every call when several are left hanging', () => {
        const run: RunLike = {
            id: 'r1',
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'tool-call', tool_name: 'a', tool_call_id: 'c1', args: {} },
                        { part_kind: 'tool-call', tool_name: 'b', tool_call_id: 'c2', args: {} },
                    ],
                },
                {
                    kind: 'request',
                    parts: [{ part_kind: 'tool-return', tool_name: 'a', tool_call_id: 'c1', content: 'ok' }],
                },
            ],
        };
        const toolIds = runToMessages(run)
            .filter((m) => m.role === 'tool')
            .map((m: any) => m.toolCallId);
        expect(toolIds.sort()).toEqual(['c1', 'c2']);
    });

    it('treats a retry prompt as an answer to its call', () => {
        const run: RunLike = {
            id: 'r1',
            model_messages: [
                {
                    kind: 'response',
                    parts: [{ part_kind: 'tool-call', tool_name: 'a', tool_call_id: 'c1', args: {} }],
                },
                {
                    kind: 'request',
                    parts: [{ part_kind: 'retry-prompt', tool_call_id: 'c1', content: 'bad args' }],
                },
            ],
        };
        const tools = runToMessages(run).filter((m) => m.role === 'tool');
        expect(tools).toHaveLength(1);
        expect((tools[0] as any).content).toContain('bad args');
    });

    it('drops thinking parts', () => {
        // Provider scratch space, not conversation — replaying it invites the
        // model to treat old reasoning as established fact.
        const run: RunLike = {
            id: 'r1',
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'thinking', content: 'hmm, maybe…' },
                        { part_kind: 'text', content: 'The answer is 26.' },
                    ],
                },
            ],
        };
        const messages = runToMessages(run);
        expect(messages).toHaveLength(1);
        expect((messages[0] as any).content).toBe('The answer is 26.');
    });

    it('omits an assistant message that produced nothing', () => {
        expect(
            runToMessages({ id: 'r', model_messages: [{ kind: 'response', parts: [] }] }),
        ).toEqual([]);
    });

    it('survives a run with no messages at all', () => {
        expect(runToMessages({ id: 'r' })).toEqual([]);
        expect(runToMessages({ id: 'r', user_prompt: { content: '' } })).toEqual([]);
    });

    it('stringifies a non-string tool result', () => {
        const run: RunLike = {
            id: 'r',
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 't', tool_call_id: 'c', args: {} }] },
                {
                    kind: 'request',
                    parts: [{ part_kind: 'tool-return', tool_name: 't', tool_call_id: 'c', content: { n: 1 } }],
                },
            ],
        };
        expect((runToMessages(run)[1] as any).content).toBe('{"n":1}');
    });
});

// ---------------------------------------------------------------------------
// buildRunMessages
// ---------------------------------------------------------------------------

describe('buildRunMessages', () => {
    const answered = (id: string, question: string, answer: string): RunLike => ({
        id,
        status: 'completed',
        user_prompt: { content: question },
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: answer }] }],
    });

    it('leads with the system prompt and ends with the new question', () => {
        const messages = buildRunMessages({
            prompt: { content: 'What now?' },
            systemPrompt: 'You are AlphainZ.',
        });
        expect(roles(messages)).toEqual(['system', 'user']);
        expect(messages[0].content).toBe('You are AlphainZ.');
        expect(messages[1].content).toBe('What now?');
    });

    it('replays prior turns so the conversation has memory', () => {
        const messages = buildRunMessages({
            priorRuns: [answered('r1', 'first?', 'first answer')],
            prompt: { content: 'and second?' },
            systemPrompt: 'sys',
        });
        expect(roles(messages)).toEqual(['system', 'user', 'assistant', 'user']);
        expect(messages[3].content).toBe('and second?');
    });

    it('caps history so a long thread cannot outgrow the context window', () => {
        const priorRuns = Array.from({ length: 30 }, (_, i) => answered(`r${i}`, `q${i}`, `a${i}`));
        const messages = buildRunMessages({
            priorRuns,
            prompt: { content: 'now' },
            systemPrompt: 'sys',
            maxPriorRuns: 3,
        });
        // system + 3 runs × (user + assistant) + current user
        expect(messages).toHaveLength(1 + 3 * 2 + 1);
        // The newest kept turns, not the oldest.
        expect(messages[1].content).toBe('q27');
    });

    it('replaces runs up to the summary cutoff with one summary message', () => {
        const priorRuns = ['r1', 'r2', 'r3', 'r4'].map((id) => answered(id, `q-${id}`, `a-${id}`));
        const messages = buildRunMessages({
            priorRuns,
            prompt: { content: 'now' },
            systemPrompt: 'sys',
            historySummary: { text: 'What went before.', throughRunId: 'r2', runCount: 2 },
        });
        // system, summary, r3, r4 (as user+assistant each), current user
        expect(roles(messages)).toEqual(['system', 'user', 'user', 'assistant', 'user', 'assistant', 'user']);
        expect(messages[1].content).toContain('Summary of 2 earlier exchanges');
        expect(messages[1].content).toContain('What went before.');
        // The covered runs are gone from the wire…
        expect(JSON.stringify(messages)).not.toContain('q-r1');
        expect(JSON.stringify(messages)).not.toContain('a-r2');
        // …and the uncovered ones replay in full.
        expect(messages[2].content).toBe('q-r3');
    });

    it('falls back to the full replay when the cutoff run is unknown', () => {
        // A thread imported from another machine can name a cutoff this
        // machine has never seen — repeating history costs tokens, dropping
        // it costs the answer.
        const priorRuns = [answered('r1', 'q1', 'a1'), answered('r2', 'q2', 'a2')];
        const messages = buildRunMessages({
            priorRuns,
            prompt: { content: 'now' },
            systemPrompt: 'sys',
            historySummary: { text: 'S', throughRunId: 'ghost', runCount: 5 },
        });
        expect(messages[1].content).toContain('Summary of 5 earlier exchanges');
        expect(JSON.stringify(messages)).toContain('q1');
        expect(JSON.stringify(messages)).toContain('a2');
    });

    it('clips tool detail on old runs and leaves the newest two intact', () => {
        const longArgs = JSON.stringify({ text: 'x'.repeat(600) });
        const longResult = 'y'.repeat(600);
        const withTools = (id: string): RunLike => ({
            id,
            status: 'completed',
            user_prompt: { content: `q-${id}` },
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'tool-call', tool_name: 'search', tool_call_id: `c-${id}`, args: { text: 'x'.repeat(600) } },
                    ],
                },
                {
                    kind: 'request',
                    parts: [
                        { part_kind: 'tool-return', tool_name: 'search', tool_call_id: `c-${id}`, content: longResult },
                    ],
                },
                { kind: 'response', parts: [{ part_kind: 'text', content: `answer ${id} `.repeat(50) }] },
            ],
        });
        const messages = buildRunMessages({
            priorRuns: [withTools('old'), withTools('mid'), withTools('new')],
            prompt: { content: 'now' },
            systemPrompt: 'sys',
            keepToolDetailRuns: 2,
        });
        const flat = messages as any[];
        const oldCall = flat.find((m) => m.toolCalls?.[0]?.id === 'c-old');
        const newCall = flat.find((m) => m.toolCalls?.[0]?.id === 'c-new');
        expect(oldCall.toolCalls[0].argumentsJson.length).toBeLessThan(longArgs.length);
        expect(oldCall.toolCalls[0].argumentsJson).toContain('…[trimmed]');
        expect(newCall.toolCalls[0].argumentsJson).not.toContain('…[trimmed]');
        const oldResult = flat.find((m) => m.role === 'tool' && m.toolCallId === 'c-old');
        const newResult = flat.find((m) => m.role === 'tool' && m.toolCallId === 'c-new');
        expect(oldResult.content).toContain('…[trimmed]');
        expect(newResult.content).toBe(longResult);
        // Prose is never touched, however old.
        const oldAnswer = flat.find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('answer old'));
        expect(oldAnswer.content.length).toBeGreaterThan(500);
    });

    it('leaves every run intact when clipping is disabled', () => {
        const longResult = 'z'.repeat(600);
        const run: RunLike = {
            id: 'r1',
            status: 'completed',
            user_prompt: { content: 'q' },
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 't', tool_call_id: 'c', args: {} }] },
                { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 't', tool_call_id: 'c', content: longResult }] },
            ],
        };
        const messages = buildRunMessages({
            priorRuns: [run, run, run],
            prompt: { content: 'now' },
            systemPrompt: 'sys',
            keepToolDetailRuns: Number.POSITIVE_INFINITY,
        });
        const results = (messages as any[]).filter((m) => m.role === 'tool');
        expect(results).toHaveLength(3);
        for (const m of results) expect(m.content).toBe(longResult);
    });

    it('keeps the question and the prose of errored and cancelled runs', () => {
        // The message after a failure ("try again", "continue") is about the
        // question that failed. What each kind of run replays is covered in
        // historyReplay.test.ts.
        const messages = buildRunMessages({
            priorRuns: [
                { ...answered('r1', 'ok?', 'yes'), status: 'completed' },
                { ...answered('r2', 'boom?', 'partial'), status: 'error' },
                { ...answered('r3', 'stopped?', 'half'), status: 'canceled' },
            ],
            prompt: { content: 'now' },
            systemPrompt: 'sys',
        });
        expect(messages.map((m) => String(m.content))).toEqual(
            ['sys', 'ok?', 'yes', 'boom?', 'partial', 'stopped?', 'half', 'now'],
        );
    });

    it('puts standing instructions in the system message, not in the question', () => {
        const messages = buildRunMessages({
            prompt: { content: 'summarize', custom_instructions: 'Always answer in Chinese.' },
            systemPrompt: 'sys',
        });
        expect(String(messages[0].content)).toContain('sys');
        expect(String(messages[0].content)).toContain('Always answer in Chinese.');
        expect(messages[1].content).toBe('summarize');
    });

    it('leaves the question exactly as typed, whatever language the instructions are in', () => {
        // The bug this replaces: standing instructions were appended to the
        // question, so a Chinese instruction made an English question stop
        // being an English message. Asked in English, the model then answered
        // in Chinese — correctly, given what it was shown.
        const messages = buildRunMessages({
            prompt: {
                content: 'What limits the rise of a rye-rich dough?',
                custom_instructions: '默认使用中文进行解答。如果我用纯英文问，那就用英文解答。',
            },
            systemPrompt: 'sys',
        });
        const question = String(messages[1].content);
        expect(question).toBe('What limits the rise of a rye-rich dough?');
        expect(question).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it('places the instructions after the rules they are allowed to override', () => {
        const messages = buildRunMessages({
            prompt: { content: 'q', custom_instructions: 'Be terse.' },
            systemPrompt: 'RULES',
        });
        const system = String(messages[0].content);
        expect(system.indexOf('RULES')).toBeLessThan(system.indexOf('Be terse.'));
    });
});

// ---------------------------------------------------------------------------
// describePromptContext
// ---------------------------------------------------------------------------

describe('describePromptContext', () => {
    it('is null when there is nothing to describe', () => {
        expect(describePromptContext({ content: 'hi' })).toBeNull();
    });

    it('names attachments with the id the tools need', () => {
        const text = describePromptContext({
            content: 'q',
            attachments: [
                { attachment_id: 'u-ABC123', title: 'Wexley 2022' },
                { library_ref: 'u', zotero_key: 'XYZ789', filename: 'paper.pdf' },
            ],
        })!;
        expect(text).toContain('Wexley 2022 [u-ABC123]');
        expect(text).toContain('paper.pdf [u-XYZ789]');
    });

    it('falls back to a placeholder name rather than omitting an item', () => {
        expect(describePromptContext({ content: 'q', attachments: [{ item_id: 'u-1' }] })).toContain(
            '(untitled) [u-1]',
        );
    });

    it('reports the open document and page', () => {
        const text = describePromptContext({
            content: 'explain this',
            application_state: { reader_state: { title: 'Wexley 2022', current_page: 4 } },
        })!;
        expect(text).toContain('Wexley 2022');
        expect(text).toContain('page 4');
    });

    it('says nothing about the reader when there is no useful detail', () => {
        expect(describePromptContext({ content: 'q', application_state: { reader_state: {} } })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// composeUserContent — the same text on the way out and on replay
// ---------------------------------------------------------------------------

describe('composeUserContent', () => {
    const readerPrompt = (page: number, selection?: string) => ({
        content: 'What does this mean?',
        attachments: [{ attachment_id: 'u-AAAA1111', title: 'Wexley 2022' }],
        application_state: {
            reader_state: {
                library_ref: 'u',
                zotero_key: 'UH6CTDV5',
                current_page: page,
                ...(selection ? { text_selection: { text: selection, page } } : {}),
            },
        },
    });
    const answered = (prompt: ReturnType<typeof readerPrompt>): RunLike => ({
        id: 'r1',
        status: 'completed',
        user_prompt: prompt,
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: 'It means…' }] }],
    });

    it('is just the question when there is nothing else to say', () => {
        expect(composeUserContent({ content: 'hi' })).toBe('hi');
    });

    it('puts the context first and the question last', () => {
        const text = composeUserContent(readerPrompt(3, 'the waggle dance'));
        expect(text).toContain('Wexley 2022 [u-AAAA1111]');
        expect(text).toContain('page 3');
        expect(text).toContain('the waggle dance');
        expect(text.endsWith('What does this mean?')).toBe(true);
    });

    it('states the selection rule in the message, and only for a selection question', () => {
        const asked = { ...readerPrompt(3, 'the waggle dance'), origin: { kind: 'selection_chat' } };
        expect(composeUserContent(asked)).toContain('two or three sentences');
        expect(composeUserContent(readerPrompt(3, 'the waggle dance'))).not.toContain('two or three sentences');
    });

    it('replays a turn exactly as it was sent', () => {
        // A prompt cache covers a request only up to the first byte that differs
        // from an earlier one. Replaying the bare question when a preamble went
        // out with it would turn every earlier turn into a difference.
        const first = readerPrompt(3, 'the waggle dance');
        const sent = buildRunMessages({ prompt: first, systemPrompt: 'sys' });
        const replayed = buildRunMessages({
            priorRuns: [answered(first)],
            prompt: readerPrompt(7),
            systemPrompt: 'sys',
        });
        expect(replayed[1].content).toBe(sent[1].content);
        expect(String(replayed[1].content)).toContain('the waggle dance');
    });

    it('keeps everything before the new question identical when the reader moves', () => {
        const run = answered(readerPrompt(3, 'the waggle dance'));
        const onPage3 = buildRunMessages({ priorRuns: [run], prompt: readerPrompt(3), systemPrompt: 'sys' });
        const onPage7 = buildRunMessages({
            priorRuns: [run],
            prompt: { ...readerPrompt(7, 'another passage'), origin: { kind: 'selection_chat' } },
            systemPrompt: 'sys',
        });
        expect(onPage7.slice(0, -1)).toEqual(onPage3.slice(0, -1));
        expect(onPage7[onPage7.length - 1]).not.toEqual(onPage3[onPage3.length - 1]);
    });
});
