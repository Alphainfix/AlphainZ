/**
 * A tool call comes back from history as it was made, not as it looked while
 * its arguments were still arriving.
 *
 * While a call streams, its part carries a preview parsed from the partial
 * arguments, and the note views prefer that preview to the real arguments. A
 * run stored with one would show the half-written preview every time the
 * conversation is opened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { loadLocalThreadRuns } from '../../../react/atoms/loadLocalThreadRuns';

const REAL_ARGS = { note_id: '1-NOTEKEY', old_string: 'teh', new_string: 'the' };

function storedRun(callPart: Record<string, unknown>) {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        user_id: 'local-user',
        status: 'completed',
        user_prompt: { content: 'fix the typo in my note' },
        model_messages: [
            {
                kind: 'response',
                parts: [
                    { part_kind: 'text', content: 'Fixing it.' },
                    callPart,
                ],
            },
            {
                kind: 'request',
                parts: [
                    { part_kind: 'tool-return', tool_name: 'edit_note', tool_call_id: 'call-1', content: 'Edited.' },
                ],
            },
        ],
    };
}

let stored: any[] = [];

beforeEach(() => {
    stored = [];
    (Zotero as any).AlphainZ = { db: { getRunsForThread: vi.fn(async () => structuredClone(stored)) } };
});

describe('a stored tool call', () => {
    it('comes back without the preview it was saved with, and with its real arguments', async () => {
        stored = [storedRun({
            part_kind: 'tool-call',
            tool_name: 'edit_note',
            tool_call_id: 'call-1',
            args: REAL_ARGS,
            streaming_args: { _partial: '{"note_id":"1-NOTE' },
        })];

        const { runs } = await loadLocalThreadRuns('thread-1');

        const [text, call] = runs[0].model_messages[0].parts as any[];
        expect(call).not.toHaveProperty('streaming_args');
        expect(call).toMatchObject({ tool_name: 'edit_note', tool_call_id: 'call-1', args: REAL_ARGS });
        expect(text).toEqual({ part_kind: 'text', content: 'Fixing it.' });
    });

    it('hands the tool-return walk the real arguments', async () => {
        stored = [storedRun({
            part_kind: 'tool-call',
            tool_name: 'edit_note',
            tool_call_id: 'call-1',
            args: REAL_ARGS,
            streaming_args: { _partial: '{"note_id"' },
        })];
        const onToolReturn = vi.fn(async () => {});

        await loadLocalThreadRuns('thread-1', { onToolReturn });

        expect(onToolReturn).toHaveBeenCalledWith(
            expect.objectContaining({ tool_call_id: 'call-1' }),
            REAL_ARGS,
        );
    });

    it('is left as stored when it carries no preview', async () => {
        const call = { part_kind: 'tool-call', tool_name: 'edit_note', tool_call_id: 'call-1', args: REAL_ARGS };
        stored = [storedRun(call)];

        const { runs } = await loadLocalThreadRuns('thread-1');

        expect(runs[0].model_messages[0].parts[1]).toEqual(call);
    });
});
