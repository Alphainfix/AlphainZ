/**
 * When a conversation earns its rolling summary, and what the summariser reads.
 *
 * The plan is the safety-critical half: compacting too eagerly spends money
 * and rewrites the model's memory for nothing; compacting too late means the
 * 10-run replay window silently drops history first.
 */
import { describe, expect, it } from 'vitest';

import {
    COMPACT_AFTER_RUNS,
    COMPACT_MIN_BATCH,
    KEEP_RECENT_RUNS,
    buildCompactionInput,
    generateThreadSummary,
    planCompaction,
    runAnswerText,
    type CompactableRun,
} from '../../../src/services/llm/threadCompaction';

const run = (id: string, question = `q-${id}`, answer = `a-${id}`): CompactableRun => ({
    id,
    user_prompt: { content: question },
    model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: answer }] }],
});

const runs = (n: number) => Array.from({ length: n }, (_, i) => run(`r${i + 1}`));
// Enough real text that the token rule's cover-weight floor is satisfied.
const fatRuns = (n: number) =>
    Array.from({ length: n }, (_, i) => run(`r${i + 1}`, `q-${i + 1}`, 'A'.repeat(3000)));

describe('planCompaction', () => {
    it('does nothing while the thread fits in the keep-window', () => {
        expect(planCompaction(runs(KEEP_RECENT_RUNS), null, null)).toBeNull();
        expect(planCompaction(runs(KEEP_RECENT_RUNS + 2), null, null)).toBeNull();
    });

    it('compacts once the conversation grows past the run threshold', () => {
        // At exactly the threshold: quiet.
        expect(planCompaction(runs(COMPACT_AFTER_RUNS), null, null)).toBeNull();
        // One past it: everything but the keep-window is covered.
        const all = runs(COMPACT_AFTER_RUNS + 1);
        const plan = planCompaction(all, null, null);
        expect(plan).not.toBeNull();
        expect(plan!.cover).toHaveLength(COMPACT_AFTER_RUNS + 1 - KEEP_RECENT_RUNS);
        expect(plan!.throughRunId).toBe(all[all.length - KEEP_RECENT_RUNS - 1].id);
    });

    it('honours a user-set run threshold', () => {
        expect(planCompaction(runs(9), null, null, undefined, 6)).not.toBeNull();
        expect(planCompaction(runs(11), null, null, undefined, 15)).toBeNull();
    });

    it('compacts early when the history itself got heavy — but never below the batch floor', () => {
        // Two compactable runs: even a heavy first request does not fire —
        // otherwise a standing-heavy thread would pay a summary call after
        // every single message.
        expect(planCompaction(fatRuns(KEEP_RECENT_RUNS + COMPACT_MIN_BATCH - 1), null, 999_999)).toBeNull();
        // At the floor, it fires.
        const plan = planCompaction(fatRuns(KEEP_RECENT_RUNS + COMPACT_MIN_BATCH), null, 81_000);
        expect(plan).not.toBeNull();
        expect(plan!.cover).toHaveLength(COMPACT_MIN_BATCH);
    });

    it('ignores a signal below the threshold', () => {
        expect(planCompaction(fatRuns(KEEP_RECENT_RUNS + COMPACT_MIN_BATCH), null, 79_000)).toBeNull();
    });

    it('refuses the token rule when the covered runs carry no real weight', () => {
        // A heavy first request whose weight is standing context (a fat
        // annotation preamble) re-fires forever; tiny covered runs prove the
        // history is not the problem, so there is nothing to gain.
        expect(planCompaction(runs(KEEP_RECENT_RUNS + COMPACT_MIN_BATCH), null, 999_999)).toBeNull();
    });

    it('honours a user-set threshold in either direction', () => {
        const six = fatRuns(KEEP_RECENT_RUNS + COMPACT_MIN_BATCH);
        // Lowered: fires below the default.
        expect(planCompaction(six, null, 45_000, 40_000)).not.toBeNull();
        // Raised: quiet where the default would fire.
        expect(planCompaction(six, null, 90_000, 150_000)).toBeNull();
    });

    it('starts the count over when the old cutoff is unknown', () => {
        // The imported count refers to runs that may be in this very list —
        // adding them again would double count on the marker label.
        const existing = { summary: 's', throughRunId: 'ghost', createdAt: 'x', runCount: 9 };
        const plan = planCompaction(runs(COMPACT_AFTER_RUNS + 1), existing, null);
        expect(plan).not.toBeNull();
        expect(plan!.runCount).toBe(plan!.cover.length);
    });

    it('extends an existing summary instead of re-covering its runs', () => {
        const all = runs(KEEP_RECENT_RUNS + COMPACT_AFTER_RUNS + 3);
        const existing = {
            summary: 'old', throughRunId: 'r3', createdAt: 'x', runCount: 3,
        };
        const plan = planCompaction(all, existing, 999_999);
        expect(plan).not.toBeNull();
        expect(plan!.cover[0].id).toBe('r4');
        expect(plan!.runCount).toBe(3 + plan!.cover.length);
    });

    it('treats an unknown cutoff as nothing covered', () => {
        // An imported thread can carry a cutoff this machine has never seen.
        const existing = { summary: 's', throughRunId: 'ghost', createdAt: 'x', runCount: 9 };
        const plan = planCompaction(runs(KEEP_RECENT_RUNS + COMPACT_AFTER_RUNS), existing, null);
        expect(plan).not.toBeNull();
        expect(plan!.cover[0].id).toBe('r1');
    });
});

describe('buildCompactionInput', () => {
    it('rolls the prior summary forward ahead of the new exchanges', () => {
        const input = buildCompactionInput([run('r9', 'why?', 'because')], 'the story so far');
        expect(input.indexOf('the story so far')).toBeLessThan(input.indexOf('why?'));
        expect(input).toContain('carry its facts forward');
    });

    it('clips a rambling exchange but keeps its head', () => {
        const input = buildCompactionInput([run('r1', 'Q'.repeat(1000), 'A'.repeat(2000))]);
        expect(input.length).toBeLessThan(1500);
        expect(input).toContain('QQQ');
        expect(input).toContain('AAA');
    });

    it('skips an exchange with nothing in it', () => {
        expect(buildCompactionInput([{ id: 'r1' }])).toBe('');
    });
});

describe('runAnswerText', () => {
    it('joins response text and ignores tool traffic and thinking', () => {
        const text = runAnswerText({
            id: 'r',
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'thinking', content: 'hmm' }, { part_kind: 'text', content: 'first' }] },
                { kind: 'request', parts: [{ part_kind: 'tool-return', content: 'noise' }] },
                { kind: 'response', parts: [{ part_kind: 'text', content: 'second' }] },
            ],
        });
        expect(text).toBe('first\n\nsecond');
    });
});

describe('generateThreadSummary', () => {
    const providerSaying = (reply: string) => ({
        stream: async (_req: any, onEvent: (e: any) => void) => {
            onEvent({ type: 'text', text: reply });
        },
    }) as any;

    it('returns the model text, trimmed', async () => {
        const long = 'Topic: hive navigation. '.repeat(4);
        expect(await generateThreadSummary(providerSaying(`  ${long}  `), 'input')).toBe(long.trim());
    });

    it('refuses a summary too short to be one', async () => {
        expect(await generateThreadSummary(providerSaying('ok'), 'input')).toBeNull();
    });

    it('returns null when the provider throws — the thread stays as it was', async () => {
        const provider = { stream: async () => { throw new Error('boom'); } } as any;
        expect(await generateThreadSummary(provider, 'input')).toBeNull();
    });

    it('sends nothing for an empty input', async () => {
        let called = false;
        const provider = { stream: async () => { called = true; } } as any;
        expect(await generateThreadSummary(provider, '   ')).toBeNull();
        expect(called).toBe(false);
    });
});
