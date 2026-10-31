/**
 * A question's library searches are counted and capped.
 *
 * The web search has had a budget since a run spent thirty-nine of them. The
 * library searches had none and behave the same way: measured over fifty-two
 * questions, one asked about two research groups and made sixteen
 * `item_search_by_metadata` calls — "pollen", then "pollen foraging", then
 * "honeybee pollen foraging distance meadow survey" — each a rephrasing of
 * the last, for 652k input tokens and three minutes on one answer.
 *
 * The prompt already tells the model to stop after one or two. This is what
 * that instruction is worth once a model has decided it has not found the
 * paper yet, so the limit lives in the tool. It began at six; the default is
 * now twenty (the setting goes from ten to no limit), and the mechanism tests
 * below pin six explicitly so they stay small.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { withLibrarySearchBudgetForTest as budgeted } from '../../../react/atoms/executeLocalRun';

function counting() {
    const calls: string[] = [];
    return { calls, dispatch: async (name: string) => { calls.push(name); return { items: [] }; } };
}

describe('the library search budget', () => {
    it('lets the first six through, whichever tool they are', async () => {
        const { calls, dispatch } = counting();
        const run = budgeted(dispatch as any, 6);
        for (const name of ['item_search_by_topic','item_search_by_metadata','search_library_fulltext',
                            'item_search_by_topic','item_search_by_metadata','search_library_fulltext']) {
            await run(name, {}, {} as any);
        }
        expect(calls).toHaveLength(6);
    });

    it('refuses the seventh, and says what to do instead', async () => {
        const { calls, dispatch } = counting();
        const run = budgeted(dispatch as any, 6);
        for (let i = 0; i < 6; i += 1) await run('item_search_by_topic', {}, {} as any);
        const refusal: any = await run('item_search_by_topic', {}, {} as any);
        expect(calls).toHaveLength(6);            // never reached the executor
        expect(refusal.refused).toBe(true);
        expect(refusal.note).toMatch(/Answer from what the earlier searches returned/);
    });

    it('does not count anything else against it', async () => {
        // Reading a paper is not searching for one, and a long read is normal.
        const { calls, dispatch } = counting();
        const run = budgeted(dispatch as any, 6);
        for (let i = 0; i < 20; i += 1) await run('read_document', {}, {} as any);
        await run('item_search_by_topic', {}, {} as any);
        expect(calls).toHaveLength(21);
    });

    it('gives each question its own budget', async () => {
        const first = counting();
        const runOne = budgeted(first.dispatch as any, 6);
        for (let i = 0; i < 8; i += 1) await runOne('item_search_by_topic', {}, {} as any);
        expect(first.calls).toHaveLength(6);

        const second = counting();
        const runTwo = budgeted(second.dispatch as any, 6);
        await runTwo('item_search_by_topic', {}, {} as any);
        expect(second.calls).toHaveLength(1);
    });

    it('takes its limit from the settings', async () => {
        const { calls, dispatch } = counting();
        const run = budgeted(dispatch as any, 2);
        for (let i = 0; i < 4; i += 1) await run('item_search_by_metadata', {}, {} as any);
        expect(calls).toHaveLength(2);
        const refusal: any = await run('item_search_by_metadata', {}, {} as any);
        // The refusal names the setting, so the model can tell the user where it is.
        expect(refusal.note).toMatch(/capped at 2 per question/);
        expect(refusal.note).toMatch(/Library searches per question/);
    });

    it('has no limit when the setting says so', async () => {
        const { calls, dispatch } = counting();
        const run = budgeted(dispatch as any, null);
        for (let i = 0; i < 30; i += 1) await run('item_search_by_topic', {}, {} as any);
        expect(calls).toHaveLength(30);
    });

    it('allows twenty by default', async () => {
        const { calls, dispatch } = counting();
        const run = budgeted(dispatch as any);
        for (let i = 0; i < 25; i += 1) await run('item_search_by_topic', {}, {} as any);
        expect(calls).toHaveLength(20);
    });
});
