/**
 * One paper, and the graph around it.
 *
 * `search_web_literature` finds papers by topic, which is the wrong shape for
 * the three questions a reference list actually raises: *this exact paper*,
 * *who built on it*, *what it built on*. The OpenAlex client has had all three
 * calls since the fork and nothing reached them — so a model handed a DOI could
 * only search for the title, and in one run the user saw, burned its whole
 * budget failing to.
 *
 * The budget is shared with the topic search on purpose: they all hit the same
 * service, and a model that has not settled a question in a handful of lookups
 * will not settle it on the next one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const byDoi = vi.fn();
const citedBy = vi.fn();
const references = vi.fn();
const search = vi.fn();

vi.mock('../../../src/services/literature/openalex', () => ({
    OpenAlexClient: class {
        byDoi = byDoi;
        citedBy = citedBy;
        references = references;
        search = search;
    },
    formatWorksForModel: (works: any[]) => works.map((w) => w.title).join('; '),
}));

const WORK = {
    id: 'W2741809807',
    title: 'Honeybee navigation',
    authors: [{ name: 'I. Valcourt' }],
    year: 2017,
    citedByCount: 3000,
    referencedWorkCount: 500,
};

let tools: any;

beforeEach(async () => {
    vi.resetModules();
    byDoi.mockReset();
    citedBy.mockReset();
    references.mockReset();
    search.mockReset();
    const mod = await import('../../../react/atoms/executeLocalRun');
    tools = (mod as any).literatureToolsForTest();
});

describe('lookup_paper', () => {
    it('resolves a DOI without searching', async () => {
        byDoi.mockResolvedValueOnce(WORK);
        const out = String(await tools.lookup_paper({ doi: '10.1000/BeeNav.89.035002' }));
        expect(byDoi).toHaveBeenCalledOnce();
        expect(search).not.toHaveBeenCalled();
        expect(out).toContain('Honeybee navigation');
        expect(out).toContain('add_papers_to_library');
    });

    it('says it could not find it rather than guessing', async () => {
        byDoi.mockResolvedValueOnce(null);
        const out = String(await tools.lookup_paper({ doi: '10.0000/nope' }));
        expect(out).toMatch(/Not found/);
        expect(out).toMatch(/do not guess/i);
    });

    it('needs something to look up', async () => {
        await expect(tools.lookup_paper({})).rejects.toThrow(/doi or a title/);
    });
});

describe('the citation graph', () => {
    it('lists what cites a work', async () => {
        citedBy.mockResolvedValueOnce({ total: 42, works: [WORK] });
        const out = String(await tools.find_citing_papers({ openalex_id: 'W123' }));
        expect(out).toContain('42 works cite it');
    });

    it('lists what a work cites', async () => {
        references.mockResolvedValueOnce({ total: 7, works: [WORK] });
        const out = String(await tools.find_cited_papers({ openalex_id: 'W123' }));
        expect(out).toContain('cites 7 works');
    });

    it('reports an empty graph as an answer, not a failure', async () => {
        citedBy.mockResolvedValueOnce({ total: 0, works: [] });
        const out = String(await tools.find_citing_papers({ openalex_id: 'W123' }));
        expect(out).toMatch(/Nothing cites it/);
        expect(out).toMatch(/move on/);
    });

    it('refuses an id it was not given', async () => {
        await expect(tools.find_citing_papers({})).rejects.toThrow(/openalex_id is required/);
    });
});

describe('the shared budget', () => {
    it('is spent by all of them together, not one each', async () => {
        const mod: any = await import('../../../react/atoms/executeLocalRun');
        const tools = mod.literatureToolsForTest(undefined, mod.literatureBudgetForTest(6));
        byDoi.mockResolvedValue(WORK);
        citedBy.mockResolvedValue({ total: 1, works: [WORK] });
        references.mockResolvedValue({ total: 1, works: [WORK] });

        await tools.lookup_paper({ doi: '10.1/a' });
        await tools.find_citing_papers({ openalex_id: 'W1' });
        await tools.find_cited_papers({ openalex_id: 'W1' });
        await tools.lookup_paper({ doi: '10.1/b' });
        await tools.find_citing_papers({ openalex_id: 'W1' });
        await tools.find_cited_papers({ openalex_id: 'W1' });

        const seventh = String(await tools.find_citing_papers({ openalex_id: 'W1' }));
        expect(seventh).toMatch(/capped at 6/);
    });

    it('is the same budget the topic search spends', async () => {
        // The web search used to count on its own, so a question could make
        // eight lookups while the prompt said four. One budget object, handed
        // to both factories, is what the runner builds.
        const mod: any = await import('../../../react/atoms/executeLocalRun');
        const budget = mod.literatureBudgetForTest(3);
        const lookups = mod.literatureToolsForTest(undefined, budget);
        const webSearch = mod.webSearchToolForTest(undefined, budget);
        search.mockResolvedValue({ total: 1, works: [WORK] });
        byDoi.mockResolvedValue(WORK);

        await webSearch({ query: 'honeybee navigation' });
        await lookups.lookup_paper({ doi: '10.1/a' });
        await webSearch({ query: 'waggle dances' });
        const fourth = String(await lookups.lookup_paper({ doi: '10.1/b' }));
        expect(fourth).toMatch(/capped at 3/);
        expect(byDoi).toHaveBeenCalledTimes(1);
        expect(search).toHaveBeenCalledTimes(2);
    });

    it('can be lifted entirely', async () => {
        const mod: any = await import('../../../react/atoms/executeLocalRun');
        const unlimited = mod.literatureToolsForTest(undefined, mod.literatureBudgetForTest(null));
        byDoi.mockResolvedValue(WORK);
        for (let i = 0; i < 12; i += 1) await unlimited.lookup_paper({ doi: `10.1/${i}` });
        expect(byDoi).toHaveBeenCalledTimes(12);
    });

    it('stops calling out after two failures', async () => {
        citedBy.mockRejectedValue(new Error('503'));
        const first = String(await tools.find_citing_papers({ openalex_id: 'W1' }));
        expect(first).toMatch(/did not respond/i);
        const second = String(await tools.find_citing_papers({ openalex_id: 'W1' }));
        expect(second).toMatch(/unavailable/i);

        // The third never reaches the network — and neither does a *different*
        // literature tool, because the service is down for all of them.
        byDoi.mockResolvedValue(WORK);
        const third = String(await tools.lookup_paper({ doi: '10.1/a' }));
        expect(third).toMatch(/Do not call this tool again/i);
        expect(byDoi).not.toHaveBeenCalled();
    });
});
