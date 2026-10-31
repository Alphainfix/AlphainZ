/**
 * The live preview of a tool call being written.
 *
 * While the model streams a long `create_note`, the card previews the note as
 * it grows, from the arguments received so far — not from the latest fragment
 * alone, which carries no title and no content. Once the real arguments are
 * written, the preview is dropped, so it is neither saved with the run nor
 * preferred over what was actually sent.
 */
import { describe, expect, it } from 'vitest';

import { runLocalAgent, type LocalRunCallbacks } from '../../../src/services/llm/localRunner';
import { parsePartialToolArguments } from '../../../src/services/llm/sse';
import type { ChatProvider, StreamEvent, ToolSchema } from '../../../src/services/llm/types';
import { updateRunWithPart, updateRunWithToolCallArgsStream } from '@beaver/agent-core/run-state/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';

describe('parsePartialToolArguments', () => {
    it('closes an open string where it stands', () => {
        expect(parsePartialToolArguments('{"title": "Key find')).toEqual({ title: 'Key find' });
    });

    it('keeps complete members and drops a key still waiting for its value', () => {
        expect(parsePartialToolArguments('{"title": "Summary", "cont')).toEqual({ title: 'Summary' });
        expect(parsePartialToolArguments('{"title": "Summary", "content":')).toEqual({ title: 'Summary' });
        expect(parsePartialToolArguments('{"title": "Summary",')).toEqual({ title: 'Summary' });
    });

    it('closes nested containers', () => {
        expect(parsePartialToolArguments('{"edits": [{"old": "a", "new": "b"}, {"old": "c')).toEqual({
            edits: [{ old: 'a', new: 'b' }, { old: 'c' }],
        });
    });

    it('drops a half-typed literal back to the last complete member', () => {
        expect(parsePartialToolArguments('{"n": 3, "flag": tr')).toEqual({ n: 3 });
    });

    it('does not turn a half-received escape into garbage', () => {
        expect(parsePartialToolArguments('{"content": "line one\\')).toEqual({ content: 'line one' });
        expect(parsePartialToolArguments('{"content": "caf\\u00')).toEqual({ content: 'caf' });
        expect(parsePartialToolArguments('{"content": "a\\\\\\u00')).toEqual({ content: 'a\\' });
    });

    it('keeps an escaped backslash followed by "u", as in LaTeX, as text', () => {
        // JSON `\\uparrow` is a backslash and the word "uparrow", not a
        // unicode escape; the note's content must not drop out of the preview.
        expect(parsePartialToolArguments('{"content": "trend $\\\\u')).toEqual({ content: 'trend $\\u' });
        expect(parsePartialToolArguments('{"content": "trend $\\\\up')).toEqual({ content: 'trend $\\up' });
    });

    it('parses a complete object exactly', () => {
        expect(parsePartialToolArguments('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] });
    });

    it('leaves out an identifier until it is complete, since a prefix names another item', () => {
        expect(parsePartialToolArguments('{"note_id": "u-AB')).toEqual({});
        expect(parsePartialToolArguments('{"edits": [{"old": "a", "new": "b"}], "note_id": "u-AB')).toEqual({
            edits: [{ old: 'a', new: 'b' }],
        });
        expect(parsePartialToolArguments('{"note_id": "u-ABCD1234", "edits": [{"old": "some te')).toEqual({
            note_id: 'u-ABCD1234',
            edits: [{ old: 'some te' }],
        });
    });

    it('leaves out an identifier in a list until it is complete', () => {
        expect(parsePartialToolArguments('{"item_ids": ["u-AAAA1111", "u-BB')).toEqual({ item_ids: ['u-AAAA1111'] });
    });

    it('leaves out a number that may still gain digits', () => {
        expect(parsePartialToolArguments('{"text": "x", "page": 1')).toEqual({ text: 'x' });
        expect(parsePartialToolArguments('{"text": "x", "page": 12,')).toEqual({ text: 'x', page: 12 });
        expect(parsePartialToolArguments('{"pages": [3, 4, 1')).toEqual({ pages: [3, 4] });
    });

    it('still shows prose under a key that merely contains "id"', () => {
        expect(parsePartialToolArguments('{"idea": "A long thou')).toEqual({ idea: 'A long thou' });
        expect(parsePartialToolArguments('{"valid_reason": "because')).toEqual({ valid_reason: 'because' });
    });

    it('returns null when nothing usable has arrived', () => {
        expect(parsePartialToolArguments('')).toBeNull();
        expect(parsePartialToolArguments('not json')).toBeNull();
    });
});

describe('runLocalAgent / argument preview', () => {
    const TOOLS: ToolSchema[] = [
        { name: 'create_note', description: 'Note', parameters: { type: 'object', properties: {} } },
    ];

    it('sends the arguments received so far, parsed, rather than the latest fragment', async () => {
        const previews: Array<Record<string, unknown>> = [];
        const callbacks: LocalRunCallbacks = {
            onThread: () => undefined,
            onReady: () => undefined,
            onPart: () => undefined,
            onToolCallArgsStream: (e) => {
                previews.push(e.args);
            },
            onToolReturn: () => undefined,
            onToolCallProgress: () => undefined,
            onRunComplete: () => undefined,
            onDone: () => undefined,
            onError: () => undefined,
        };
        const fragments = ['{"ti', 'tle": "Main fin', 'dings", "content": "<p>Bee colo', 'nies are…</p>"}'];
        let turn = 0;
        const provider: ChatProvider = {
            label: 'Fake',
            model: 'm',
            wireFormat: 'openai',
            async stream(_request, emit: (e: StreamEvent) => void) {
                turn += 1;
                if (turn > 1) {
                    emit({ type: 'text', text: 'Drafted.' });
                    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                    return;
                }
                emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'create_note' });
                for (const delta of fragments) emit({ type: 'tool_call_args', index: 0, delta });
                emit({
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ index: 0, id: 'c1', name: 'create_note', argumentsJson: fragments.join('') }],
                });
            },
        };

        await runLocalAgent({
            runId: 'r',
            threadId: 't',
            messages: [{ role: 'user', content: 'write it up' }],
            provider,
            tools: TOOLS,
            dispatch: async () => 'proposed',
            callbacks,
        });

        expect(previews.every((p) => !('_partial' in p))).toBe(true);
        expect(previews).toContainEqual({ title: 'Main fin' });
        expect(previews).toContainEqual({ title: 'Main findings', content: '<p>Bee colo' });
        expect(previews.at(-1)).toEqual({ title: 'Main findings', content: '<p>Bee colonies are…</p>' });
    });

    it('never previews an edit against a note id that is still arriving', async () => {
        const previews: Array<Record<string, unknown>> = [];
        const callbacks: LocalRunCallbacks = {
            onThread: () => undefined,
            onReady: () => undefined,
            onPart: () => undefined,
            onToolCallArgsStream: (e) => {
                previews.push(e.args);
            },
            onToolReturn: () => undefined,
            onToolCallProgress: () => undefined,
            onRunComplete: () => undefined,
            onDone: () => undefined,
            onError: () => undefined,
        };
        const json = '{"note_id": "u-ABCD1234", "edits": [{"old": "first draft", "new": "second draft"}]}';
        let turn = 0;
        const provider: ChatProvider = {
            label: 'Fake',
            model: 'm',
            wireFormat: 'openai',
            async stream(_request, emit: (e: StreamEvent) => void) {
                turn += 1;
                if (turn > 1) {
                    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                    return;
                }
                emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'edit_note' });
                // One character at a time: every prefix of the id goes by.
                for (const ch of json) emit({ type: 'tool_call_args', index: 0, delta: ch });
                emit({
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ index: 0, id: 'c1', name: 'edit_note', argumentsJson: json }],
                });
            },
        };
        await runLocalAgent({
            runId: 'r',
            threadId: 't',
            messages: [{ role: 'user', content: 'reword it' }],
            provider,
            tools: [{ name: 'edit_note', description: 'Edit', parameters: { type: 'object', properties: {} } }],
            dispatch: async () => 'proposed',
            callbacks,
        });

        expect(previews.length).toBeGreaterThan(0);
        for (const preview of previews) {
            if ('note_id' in preview) expect(preview.note_id).toBe('u-ABCD1234');
        }
        expect(previews).toContainEqual({ note_id: 'u-ABCD1234', edits: [{ old: 'first d' }] });
    });

    it('does not re-read a long note on every token', async () => {
        let previews = 0;
        const callbacks: LocalRunCallbacks = {
            onThread: () => undefined,
            onReady: () => undefined,
            onPart: () => undefined,
            onToolCallArgsStream: () => {
                previews += 1;
            },
            onToolReturn: () => undefined,
            onToolCallProgress: () => undefined,
            onRunComplete: () => undefined,
            onDone: () => undefined,
            onError: () => undefined,
        };
        const json = JSON.stringify({ title: 'Long', content: 'word '.repeat(4000) });
        let turn = 0;
        const provider: ChatProvider = {
            label: 'Fake',
            model: 'm',
            wireFormat: 'openai',
            async stream(_request, emit: (e: StreamEvent) => void) {
                turn += 1;
                if (turn > 1) {
                    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                    return;
                }
                emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'create_note' });
                for (let i = 0; i < json.length; i += 4) {
                    emit({ type: 'tool_call_args', index: 0, delta: json.slice(i, i + 4) });
                }
                emit({
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ index: 0, id: 'c1', name: 'create_note', argumentsJson: json }],
                });
            },
        };
        await runLocalAgent({
            runId: 'r',
            threadId: 't',
            messages: [{ role: 'user', content: 'go' }],
            provider,
            tools: TOOLS,
            dispatch: async () => 'proposed',
            callbacks,
        });
        // Thousands of fragments; a few hundred previews at most.
        expect(json.length / 4).toBeGreaterThan(4000);
        expect(previews).toBeGreaterThan(20);
        expect(previews).toBeLessThan(500);
    });
});

describe('the saved tool-call part', () => {
    const run = (): AgentRun => ({
        id: 'r',
        user_id: 'u',
        thread_id: 't',
        agent_name: 'beaver',
        user_prompt: { content: 'q', is_resume: false } as any,
        status: 'in_progress',
        model_messages: [],
        model_name: 'm',
        created_at: new Date().toISOString(),
    } as AgentRun);

    const callPart = (args: Record<string, unknown> | null) => ({
        event: 'part' as const,
        run_id: 'r',
        message_index: 0,
        part_index: 0,
        part: { part_kind: 'tool-call', tool_name: 'create_note', tool_call_id: 'c1', args },
    });

    it('drops the live preview once the real arguments arrive', () => {
        let state = updateRunWithPart(run(), callPart(null) as any);
        state = updateRunWithToolCallArgsStream(state, {
            event: 'tool_call_args_stream',
            run_id: 'r',
            tool_call_id: 'c1',
            tool_name: 'create_note',
            args: { title: 'Main fin' },
        } as any);
        state = updateRunWithPart(state, callPart({ title: 'Main findings', content: '<p>…</p>' }) as any);

        const part = (state.model_messages[0] as any).parts[0];
        expect(part.args).toEqual({ title: 'Main findings', content: '<p>…</p>' });
        expect(part.streaming_args).toBeUndefined();
    });

    it('keeps the preview while the part still has no arguments', () => {
        let state = updateRunWithPart(run(), callPart(null) as any);
        state = updateRunWithToolCallArgsStream(state, {
            event: 'tool_call_args_stream',
            run_id: 'r',
            tool_call_id: 'c1',
            tool_name: 'create_note',
            args: { title: 'Main fin' },
        } as any);
        state = updateRunWithPart(state, callPart(null) as any);
        expect((state.model_messages[0] as any).parts[0].streaming_args).toEqual({ title: 'Main fin' });
    });
});
