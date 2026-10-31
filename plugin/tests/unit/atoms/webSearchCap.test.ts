/**
 * A bound on checking, enforced where it cannot be argued with.
 *
 * Verifying a claim takes one search, or two if the first was badly phrased.
 * Beyond that the model is not checking but rephrasing: asked for a current
 * record it made thirty-nine searches, ran out of steps and never wrote an
 * answer. The prompt was then told to stop at one or two; the same question
 * came back with thirty-three. So the limit lives in the tool.
 */
import { describe, expect, it, vi } from 'vitest';

/*
 * One result by default. An empty `works` array is not a neutral fixture any
 * more — "nothing matched" is now its own answer, and a test that wants the
 * normal path has to look like the normal path.
 */
const A_WORK = {
    id: 'W1',
    title: 'A paper',
    authors: [{ name: 'Someone' }],
    year: 2020,
    citedByCount: 1,
    referencedWorkCount: 1,
};
const searchMock = vi.fn(async () => ({ total: 1, works: [A_WORK] }));
vi.mock('../../../src/services/literature/openalex', () => ({
    OpenAlexClient: class { search = searchMock; },
    formatWorksForModel: () => 'formatted',
}));

import {
    literatureBudgetForTest,
    webSearchToolForTest,
} from '../../../react/atoms/executeLocalRun';

// The mechanism tests pin a budget of six so they stay small; the default is
// twenty (checked last).
const webSearchTool = (set?: Parameters<typeof webSearchToolForTest>[0]) =>
    webSearchToolForTest(set, literatureBudgetForTest(6));

describe('web search cap', () => {
    it('answers the first few searches normally', async () => {
        searchMock.mockClear();
        const tool = webSearchTool();
        for (let i = 0; i < 6; i++) {
            const out = await tool({ query: `q${i}` });
            expect(String(out)).toContain('works matched');
        }
        expect(searchMock).toHaveBeenCalledTimes(6);
    });

    it('refuses past the cap without failing the run', async () => {
        searchMock.mockClear();
        const tool = webSearchTool();
        for (let i = 0; i < 6; i++) await tool({ query: `q${i}` });

        const out = String(await tool({ query: 'one more' }));
        expect(out).toMatch(/capped at 6 per question/);
        // Refused, not thrown: the run continues on what it already has.
        expect(searchMock).toHaveBeenCalledTimes(6);
    });

    it('tells the model what to do instead of searching again', async () => {
        const tool = webSearchTool();
        for (let i = 0; i < 7; i++) await tool({ query: `q${i}` });
        const out = String(await tool({ query: 'again' }));
        expect(out).toMatch(/name what is unconfirmed/i);
        // …and where the user can raise it, since the model will pass that on.
        expect(out).toMatch(/Literature lookups per question/);
    });

    it('allows twenty searches by default', async () => {
        searchMock.mockClear();
        const tool = webSearchToolForTest();
        for (let i = 0; i < 20; i++) await tool({ query: `q${i}` });
        expect(String(await tool({ query: 'one more' }))).toMatch(/capped at 20 per question/);
        expect(searchMock).toHaveBeenCalledTimes(20);
    });

    it('gives each question its own budget', async () => {
        // The counter is per tool instance, and a tool set is built per run.
        const first = webSearchTool();
        for (let i = 0; i < 7; i++) await first({ query: `q${i}` });
        expect(String(await first({ query: 'x' }))).toMatch(/capped at 6/);

        const second = webSearchTool();
        expect(String(await second({ query: 'fresh' }))).toContain('works matched');
    });
});

/**
 * What the search registers, beyond what it tells the model.
 *
 * A citation to a paper found on the web resolves against the external
 * reference mapping. With nothing registered there, the source row rendered as
 * a bare number: no title, no authors, nothing to click — which is what the
 * user saw and reported.
 */
describe('web search registers what it found', () => {
    it('publishes each result as an external reference, keyed by its OpenAlex id', async () => {
        searchMock.mockClear();
        searchMock.mockResolvedValueOnce({
            total: 1,
            works: [
                {
                    id: 'W2741809807',
                    title: 'Honeybee navigation',
                    authors: [{ name: 'I. Valcourt' }],
                    year: 2017,
                    doi: '10.1000/BeeNav.89.035002',
                    citedByCount: 10,
                    referencedWorkCount: 5,
                },
            ],
        } as any);

        const sets: Array<{ atom: unknown; value: unknown }> = [];
        const set = ((atom: unknown, value: unknown) => {
            sets.push({ atom, value });
        }) as any;

        await webSearchTool(set)({ query: 'bee odometry' });

        const published = sets
            .map((entry) => entry.value)
            .filter((value): value is any[] => Array.isArray(value));
        expect(published.length).toBeGreaterThan(0);
        const refs = published[0];
        expect(refs[0].source_id).toBe('W2741809807');
        expect(refs[0].title).toBe('Honeybee navigation');
        // Lowercase, because that is the spelling the import path reads.
        expect(refs[0].identifiers).toEqual({ doi: '10.1000/BeeNav.89.035002' });
    });
});

/**
 * A service that is down, told to the model as a fact rather than as a mistake.
 *
 * OpenAlex returned 503 four times in a row during one question. Each failure
 * reached the model as a thrown tool error — which reads as "you called it
 * wrong" — so it rephrased and called again until the search budget was gone,
 * and then wrote the user a paragraph about OpenAlex's cluster load.
 */
describe('when OpenAlex is down', () => {
    it('offers one retry, and says the query was not the problem', async () => {
        searchMock.mockClear();
        searchMock.mockRejectedValueOnce(new Error('OpenAlex request failed: 503'));
        const tool = webSearchTool();
        const out = String(await tool({ query: 'valcourt tunnel odometer' }));
        expect(out).toMatch(/did not respond/i);
        expect(out).toMatch(/do not reword/i);
    });

    it('stops accepting calls after the second failure', async () => {
        searchMock.mockClear();
        searchMock.mockRejectedValue(new Error('OpenAlex request failed: 503'));
        const tool = webSearchTool();
        await tool({ query: 'a' });
        const second = String(await tool({ query: 'b' }));
        expect(second).toMatch(/unavailable/i);

        const third = String(await tool({ query: 'c' }));
        expect(third).toMatch(/Do not call this tool again/i);
        // The third call never reached the network: a retry is not a choice
        // the model gets to make.
        expect(searchMock).toHaveBeenCalledTimes(2);
        searchMock.mockReset();
        searchMock.mockImplementation(async () => ({ total: 1, works: [A_WORK] }) as any);
    });

    it('does not throw, so the run keeps its other tools', async () => {
        searchMock.mockClear();
        searchMock.mockRejectedValueOnce(new Error('network'));
        const tool = webSearchTool();
        await expect(tool({ query: 'x' })).resolves.toBeTypeOf('string');
        searchMock.mockReset();
        searchMock.mockImplementation(async () => ({ total: 1, works: [A_WORK] }) as any);
    });
});

/**
 * Nothing matched is a complete answer.
 *
 * Left to itself the model reads an empty result as a prompt to rephrase, and
 * the user gets a paragraph of speculation about what the paper might have
 * been instead of two words.
 */
describe('when nothing matches', () => {
    it('says so and tells the model not to speculate', async () => {
        searchMock.mockClear();
        searchMock.mockResolvedValueOnce({ total: 0, works: [] } as any);
        const out = String(await webSearchTool()({ query: 'nonexistent paper' }));
        expect(out).toMatch(/Nothing matched/);
        expect(out).toMatch(/do not speculate/i);
    });
});
