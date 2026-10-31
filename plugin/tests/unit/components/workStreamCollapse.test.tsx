// @vitest-environment jsdom
/**
 * Folding the working steps — all of them.
 *
 * The first version of this fold took tool calls only, one model response at a
 * time. Both halves of that were wrong. A fold that stops at a response
 * boundary cannot span the "call, sentence, call, sentence" rhythm a real run
 * has, so a colour-coding run folded into a ladder of one-row groups; and the
 * sentences and thinking rows between them were never folded at all, so the
 * ladder had rungs. It read worse than the wall it replaced.
 *
 * The rule now is the answer versus the work that produced it: everything up
 * to and including the last tool call folds, whatever kind of part it is, and
 * the text after it does not. The exceptions, both checked here:
 *  - a step waiting on the user never folds and is never hidden, because Apply
 *    and Reject are in that row;
 *  - a group of one row never folds, because it is one line already.
 *
 * Mounted rather than asserted on a helper: what can break is the component.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamDisplayMode } from '../../../react/atoms/streamDisplay';

let pending: Map<string, unknown>;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    pending = new Map();
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    vi.resetModules();
});

const toolCall = (id: string, name: string) => ({
    part_kind: 'tool-call' as const,
    tool_name: name,
    tool_call_id: id,
    args: {},
});
const text = (content: string) => ({ part_kind: 'text' as const, content });
const thinking = (content: string) => ({ part_kind: 'thinking' as const, content });

async function mount(msgs: any[], opts: { isStreaming?: boolean; mode?: StreamDisplayMode } = {}) {
    const { isStreaming = false, mode } = opts;
    const { default: ModelMessagesView } = await import(
        '../../../react/components/agentRuns/ModelMessagesView'
    );
    const { store } = await import('../../../react/store');
    const { pendingApprovalsAtom } = await import('../../../react/agents/agentActions');
    const { streamDisplayModeAtom } = await import('../../../react/atoms/streamDisplay');
    const { Provider } = await import('jotai');
    store.set(pendingApprovalsAtom as any, pending as any);
    if (mode) store.set(streamDisplayModeAtom, mode);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(ModelMessagesView, {
                    messages: msgs,
                    runId: 'run-1',
                    isStreaming,
                    status: isStreaming ? 'in_progress' : 'completed',
                } as any),
            ),
        );
    });
    return host;
}

const count = (host: HTMLElement, needle: string) =>
    (host.textContent?.match(new RegExp(needle, 'g')) ?? []).length;

describe('folding the working steps', () => {
    it('folds a run of steps into one line, closed', async () => {
        const host = await mount([
            {
                kind: 'response',
                parts: Array.from({ length: 8 }, (_, i) => toolCall(`h${i}`, 'create_highlight')),
            },
            { kind: 'response', parts: [text('Here is what I propose.')] },
        ]);
        expect(host.textContent).toContain('Proposing a highlight ×8');
        // Closed: the summary stands in for the eight rows, not beside them.
        expect(count(host, 'Proposing a highlight')).toBe(1);
        expect(host.querySelector('[data-step-group][aria-expanded="false"]')).not.toBeNull();
    });

    it('opens on a click', async () => {
        const host = await mount([
            {
                kind: 'response',
                parts: Array.from({ length: 8 }, (_, i) => toolCall(`h${i}`, 'create_highlight')),
            },
        ]);
        const toggle = host.querySelector('[data-step-group][aria-expanded="false"]') as HTMLElement;
        await act(async () => { toggle.click(); });
        expect(count(host, 'Proposing a highlight')).toBeGreaterThan(5);
    });

    it('leaves a lone step alone', async () => {
        // One row is already one line; folding it adds a click and saves
        // nothing.
        const host = await mount([
            { kind: 'response', parts: [toolCall('c0', 'read_document')] },
            { kind: 'response', parts: [text('Done.')] },
        ]);
        expect(host.textContent).toContain('Reading');
        expect(host.querySelector('[data-step-group]')).toBeNull();
    });

    it('folds the model narrating itself between calls, and keeps the answer out', async () => {
        // "Let me look at pages 4 and 7" is not the answer, it is the model
        // talking its way to a tool call — the thing that made the old fold
        // read as a ladder.
        const host = await mount([
            {
                kind: 'response',
                parts: [
                    thinking('Which pages?'),
                    text('Let me look at pages 4 and 7.'),
                    toolCall('c0', 'read_document'),
                    toolCall('c1', 'read_document'),
                ],
            },
            { kind: 'response', parts: [text('Found it.')] },
        ]);
        expect(host.textContent).not.toContain('Let me look at pages 4 and 7.');
        expect(host.textContent).not.toContain('Thinking');
        expect(host.textContent).toContain('Reading ×2');
        // The answer is what the fold exists to make visible.
        expect(host.textContent).toContain('Found it.');
    });

    it('never folds a run that never called a tool', async () => {
        const host = await mount([
            { kind: 'response', parts: [text('95 ms per 100 m.')] },
        ]);
        expect(host.textContent).toContain('95 ms per 100 m.');
        expect(host.querySelector('[data-step-group]')).toBeNull();
    });

    it('keeps a step that is waiting on the user out of the fold', async () => {
        pending.set('a1', {
            actionId: 'a1',
            toolcallId: 'h1',
            actionType: 'create_highlight_annotations',
            actionData: {},
        });
        const host = await mount([
            {
                kind: 'response',
                parts: [
                    toolCall('h0', 'create_highlight'),
                    toolCall('h1', 'create_highlight'),
                    toolCall('h2', 'create_highlight'),
                ],
            },
        ]);
        // The two settled rows fold; the waiting one is on screen beside the
        // summary. It sorts after them rather than staying in source order —
        // the thing needing an answer belongs at the bottom, next to where the
        // user is about to click.
        expect(host.textContent).toContain('Proposing a highlight ×2');
        expect(count(host, 'Proposing a highlight')).toBe(2);
    });

    it('shows a waiting step even in answer-only mode', async () => {
        // "Hidden" is a reading preference. Swallowing an approval would make
        // it a way to lose work.
        pending.set('a1', {
            actionId: 'a1',
            toolcallId: 'h1',
            actionType: 'create_highlight_annotations',
            actionData: {},
        });
        const host = await mount(
            [
                {
                    kind: 'response',
                    parts: [
                        thinking('Which sentence?'),
                        toolCall('h0', 'read_document'),
                        toolCall('h1', 'create_highlight'),
                    ],
                },
                { kind: 'response', parts: [text('Proposed one highlight.')] },
            ],
            { mode: 'answer' },
        );
        expect(host.textContent).toContain('Proposing a highlight');
        expect(host.textContent).toContain('Proposed one highlight.');
        // The work itself is gone: no summary line, no thinking row.
        expect(host.querySelector('[data-step-group]')).toBeNull();
        expect(host.textContent).not.toContain('Reading');
        expect(host.textContent).not.toContain('Thinking');
    });

    it('shows every step inline when set to expanded', async () => {
        const host = await mount(
            [
                {
                    kind: 'response',
                    parts: [
                        text('Reading both pages.'),
                        toolCall('c0', 'read_document'),
                        toolCall('c1', 'read_document'),
                    ],
                },
                { kind: 'response', parts: [text('Done.')] },
            ],
            { mode: 'expanded' },
        );
        expect(host.querySelector('[data-step-group]')).toBeNull();
        expect(host.textContent).toContain('Reading both pages.');
        expect(count(host, 'Reading')).toBeGreaterThanOrEqual(2);
    });
});

/**
 * The preference outlives its own name.
 *
 * `hidden` was renamed `answer` once the mode had a description worth reading.
 * Anyone who had already chosen it has the old spelling on disk, and a rename
 * that quietly reset their choice is a worse bug than the name it fixed.
 */
describe('reading the display preference', () => {
    it('still understands the old name for answer-only', async () => {
        const { readStreamDisplayPref } = await import('../../../react/atoms/streamDisplay');
        (Zotero.Prefs as any).get = (key: string) =>
            key.endsWith('streamDisplay') ? 'hidden' : undefined;
        expect(readStreamDisplayPref()).toBe('answer');
    });

    it('falls back to collapsed for a value it does not know', async () => {
        const { readStreamDisplayPref } = await import('../../../react/atoms/streamDisplay');
        (Zotero.Prefs as any).get = (key: string) =>
            key.endsWith('streamDisplay') ? 'somethingelse' : undefined;
        expect(readStreamDisplayPref()).toBe('collapsed');
    });
});

/**
 * Answer-only shows everything while it works, then nothing.
 *
 * The first cut keyed the reveal to whether a group was the last one, so each
 * stretch of work vanished the moment the next began, and the panel jumped its
 * way to the answer — content appearing and disappearing under the reader. A
 * collapsed summary line jumps for the same reason: its text is rewritten
 * every time a tool lands. One transition, at the end.
 */
describe('answer-only mode', () => {
    it('keeps the earlier steps on screen while the run is still going', async () => {
        /*
         * Consecutive work merges into one group, so two tool calls in a row
         * cannot show the bug. A step waiting on the user splits the run into
         * three groups, and only the last of them used to survive.
         */
        pending.set('a1', {
            actionId: 'a1',
            toolcallId: 'w1',
            actionType: 'create_highlight_annotations',
            actionData: {},
        });
        const host = await mount(
            [
                { kind: 'response', parts: [toolCall('t1', 'read_document')] },
                { kind: 'response', parts: [toolCall('w1', 'create_highlight')] },
                { kind: 'response', parts: [toolCall('t2', 'search_library_fulltext')] },
            ],
            { mode: 'answer', isStreaming: true },
        );
        // The first stretch is no longer the live one, and must still be there.
        expect(host.textContent).toContain('Reading');
        expect(host.textContent).toContain('Searching your library');
    });

    it('shows them expanded rather than as a summary line', async () => {
        const host = await mount(
            [
                {
                    kind: 'response',
                    parts: Array.from({ length: 8 }, (_, i) => toolCall(`h${i}`, 'create_highlight')),
                },
            ],
            { mode: 'answer', isStreaming: true },
        );
        // The collapsed view would say "×8" instead of listing them.
        expect(host.textContent).not.toContain('Proposing a highlight ×8');
    });

    it('takes all of it away once the run stops', async () => {
        const host = await mount(
            [
                { kind: 'response', parts: [toolCall('t1', 'read_document')] },
                { kind: 'response', parts: [text('Here is the answer.')] },
            ],
            { mode: 'answer', isStreaming: false },
        );
        expect(host.textContent).not.toContain('Reading');
        expect(host.textContent).toContain('Here is the answer.');
    });
});

describe('classification holds still while the run streams', () => {
    /*
     * "Text after the last tool call is the answer" is only knowable once the
     * run has ended. Applying it live meant every narration sentence rendered
     * below the fold as the answer-so-far, then got pulled inside the moment
     * the next tool call moved `lastToolIndex` — a paragraph appearing and
     * vanishing at every iteration, and the disclosure ids resetting with it.
     * These pin the streaming rule: with a tool call anywhere in the run,
     * trailing text is work until completion; with none, it is the answer
     * throughout, because folding a plain reply would hide the thing being
     * watched.
     */
    it('keeps trailing narration inside the fold while streaming', async () => {
        const { planRunStream } = await import(
            '../../../react/components/agentRuns/workStream'
        );
        const messages = [
            { kind: 'response', parts: [toolCall('c0', 'read_document'), toolCall('c1', 'read_document')] },
            { kind: 'response', parts: [text('Let me count the results properly.')] },
        ] as any[];
        const live = planRunStream(messages, () => false, { streaming: true });
        expect(live.map((u) => u.role)).toEqual(['work', 'work']);

        // The same messages after completion: the trailing text becomes the
        // answer — one flip, at the one moment the answer exists.
        const done = planRunStream(messages, () => false);
        expect(done.map((u) => u.role)).toEqual(['work', 'answer']);
    });

    it('still streams a tool-free reply as the answer', async () => {
        const { planRunStream } = await import(
            '../../../react/components/agentRuns/workStream'
        );
        const units = planRunStream(
            [{ kind: 'response', parts: [thinking('hm'), text('Plain reply.')] }] as any[],
            () => false,
            { streaming: true },
        );
        expect(units.map((u) => u.role)).toEqual(['work', 'answer']);
        // The thinking-only unit is one row — rendered inline, not folded.
        expect(units[0].rows).toBe(1);
    });

    it('keeps the group identity stable as the stream grows', async () => {
        const { planRunStream, groupStreamUnits } = await import(
            '../../../react/components/agentRuns/workStream'
        );
        const step1 = [
            { kind: 'response', parts: [toolCall('c0', 'read_document'), text('Looking…')] },
        ] as any[];
        const step2 = [
            ...step1,
            { kind: 'response', parts: [text('Now let me search again.')] },
        ];
        const step3 = [
            ...step2,
            { kind: 'response', parts: [toolCall('c1', 'read_document')] },
        ];
        const keyOf = (msgs: any[]) =>
            groupStreamUnits(planRunStream(msgs, () => false, { streaming: true }))
                .find((g) => g.kind === 'work')!.key;
        // The remembered open/closed state hangs off this key; a key that
        // drifts mid-run is state thrown away mid-run.
        const k1 = keyOf(step1);
        expect(keyOf(step2)).toBe(k1);
        expect(keyOf(step3)).toBe(k1);
    });

    it('renders the streaming narration once, inside the open fold', async () => {
        const host = await mount(
            [
                {
                    kind: 'response',
                    parts: Array.from({ length: 4 }, (_, i) => toolCall(`h${i}`, 'create_highlight')),
                },
                { kind: 'response', parts: [text('Interim narration.')] },
            ],
            { isStreaming: true, mode: 'collapsed' },
        );
        // Inside the fold (which is open while live), not duplicated below it
        // as a phantom answer.
        expect(count(host, 'Interim narration.')).toBe(1);
        expect(host.querySelector('[data-step-group][aria-expanded="true"]')).not.toBeNull();
    });
});

describe('the live fold does not blink at iteration boundaries', () => {
    it('stays open when the stream has appended an empty message', async () => {
        /*
         * Every iteration appends its message before any part lands in it.
         * Liveness used to compare the group's last message index with
         * messages.length - 1, so that empty tail demoted the group for a
         * frame — default flipped closed, children unmounted, then everything
         * came back. The whole fold blinked at every iteration of every run.
         */
        const host = await mount(
            [
                {
                    kind: 'response',
                    parts: Array.from({ length: 4 }, (_, i) => toolCall(`h${i}`, 'create_highlight')),
                },
                { kind: 'response', parts: [] },
            ],
            { isStreaming: true, mode: 'collapsed' },
        );
        expect(host.querySelector('[data-step-group][aria-expanded="true"]')).not.toBeNull();
    });
});
