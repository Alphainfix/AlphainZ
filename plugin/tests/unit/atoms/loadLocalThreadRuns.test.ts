/**
 * Reading a thread back off disk.
 *
 * The shared loader fetches run history over REST. With the model running
 * locally this install is the only place the transcript exists, so this path has
 * to reproduce the shared loader's contract exactly — same shape, same
 * `onToolReturn` walk — or a reopened thread renders differently from the one
 * the user just had on screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { loadLocalThreadRuns } from '../../../react/atoms/loadLocalThreadRuns';

let stored: any[] = [];
let getRunsForThread: any;

beforeEach(() => {
    stored = [];
    getRunsForThread = vi.fn(async () => stored);
    (Zotero as any).AlphainZ = { db: { getRunsForThread } };
});

const run = (over: Record<string, any> = {}) => ({
    id: 'run-1',
    thread_id: 'thread-1',
    user_id: 'local-user',
    status: 'completed',
    model_messages: [],
    ...over,
});

/** A run with one tool round: call, return, answer. */
const runWithTool = (id: string, callId: string) =>
    run({
        id,
        model_messages: [
            {
                kind: 'response',
                parts: [
                    {
                        part_kind: 'tool-call',
                        tool_name: 'list_tags',
                        tool_call_id: callId,
                        args: { limit: 5 },
                    },
                ],
            },
            {
                kind: 'request',
                parts: [
                    { part_kind: 'tool-return', tool_name: 'list_tags', tool_call_id: callId, content: 'ok' },
                ],
            },
            { kind: 'response', parts: [{ part_kind: 'text', content: '70 tags' }] },
        ],
    });

describe('loadLocalThreadRuns', () => {
    it('returns the stored runs for the thread', async () => {
        stored = [run()];
        const loaded = await loadLocalThreadRuns('thread-1');
        expect(getRunsForThread).toHaveBeenCalledWith('thread-1');
        expect(loaded.runs).toHaveLength(1);
        expect(loaded.runs[0].id).toBe('run-1');
    });

    it('reports an interrupted run as canceled', async () => {
        // Whatever ended the last session left this run mid-flight. Rendering it
        // as still running shows a spinner that can never resolve.
        stored = [run({ status: 'in_progress' })];
        const loaded = await loadLocalThreadRuns('thread-1');
        expect(loaded.runs[0].status).toBe('canceled');
        expect(loaded.runs[0].completed_at).toBeTruthy();
    });

    it('leaves a completed run untouched', async () => {
        stored = [run({ status: 'completed', completed_at: '2026-08-01T00:00:00Z' })];
        const loaded = await loadLocalThreadRuns('thread-1');
        expect(loaded.runs[0].completed_at).toBe('2026-08-01T00:00:00Z');
    });

    it('stamps each citation with the run it came from', async () => {
        stored = [
            run({ id: 'a', metadata: { citations: [{ citation_id: 'c1' }] } }),
            run({ id: 'b', metadata: { citations: [{ citation_id: 'c2' }] } }),
        ];
        const loaded = await loadLocalThreadRuns('thread-1');
        expect(loaded.citations).toEqual([
            { citation_id: 'c1', run_id: 'a' },
            { citation_id: 'c2', run_id: 'b' },
        ]);
    });

    it('visits every tool return with the args of the call that produced it', async () => {
        // The client hydrates a legacy tool return from the originating call's
        // arguments, so a return visited without them renders as a blank result.
        stored = [runWithTool('a', 'call-1'), runWithTool('b', 'call-2')];
        const seen: Array<[string, unknown]> = [];
        await loadLocalThreadRuns('thread-1', {
            onToolReturn: async (part, args) => {
                seen.push([part.tool_call_id, args]);
            },
        });
        expect(seen).toEqual([
            ['call-1', { limit: 5 }],
            ['call-2', { limit: 5 }],
        ]);
    });

    it('passes undefined args for a return whose call is not in the thread', async () => {
        stored = [
            run({
                model_messages: [
                    {
                        kind: 'request',
                        parts: [
                            { part_kind: 'tool-return', tool_name: 'x', tool_call_id: 'orphan', content: 'ok' },
                        ],
                    },
                ],
            }),
        ];
        const seen: unknown[] = [];
        await loadLocalThreadRuns('thread-1', {
            onToolReturn: async (_part, args) => {
                seen.push(args);
            },
        });
        expect(seen).toEqual([undefined]);
    });

    it('survives a run with no messages', async () => {
        stored = [run({ model_messages: undefined })];
        const loaded = await loadLocalThreadRuns('thread-1', { onToolReturn: async () => {} });
        expect(loaded.runs).toHaveLength(1);
    });

    it('returns an empty history rather than throwing when there is no database', async () => {
        (Zotero as any).AlphainZ = {};
        const loaded = await loadLocalThreadRuns('thread-1');
        expect(loaded).toEqual({ runs: [], citations: [], agentActions: null });
    });

    it('reports no agent actions', async () => {
        // Applied-action reconciliation is a server feature; claiming an empty
        // list would be a different statement from "not available here".
        stored = [run()];
        expect((await loadLocalThreadRuns('thread-1')).agentActions).toBeNull();
    });
});
