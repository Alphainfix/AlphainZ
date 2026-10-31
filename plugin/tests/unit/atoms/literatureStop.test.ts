/**
 * Stop reaches the literature tools.
 *
 * Every OpenAlex request carries the run's stop signal, so pressing Stop
 * cancels a search that is still waiting on the network. A lookup cut short
 * that way ends as a stop: it is not counted as OpenAlex failing to answer,
 * and the model is not told the service is down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
    search: vi.fn(),
    byDoi: vi.fn(),
    citedBy: vi.fn(),
    references: vi.fn(),
}));

vi.mock('../../../src/services/literature/openalex', () => ({
    OpenAlexClient: class {
        search = client.search;
        byDoi = client.byDoi;
        citedBy = client.citedBy;
        references = client.references;
    },
    formatWorksForModel: () => 'formatted',
}));

import {
    literatureBudgetForTest,
    literatureToolsForTest,
    webSearchToolForTest,
} from '../../../react/atoms/executeLocalRun';

const WORK = { id: 'W1', title: 'Waggle dance odometry', authors: [], citedByCount: 0, referencedWorkCount: 0 };

/** What the OpenAlex client does when the signal it was handed aborts mid-request. */
function cancelledBy(controller: AbortController) {
    return async () => {
        controller.abort();
        throw new Error('OpenAlex request cancelled');
    };
}

beforeEach(() => {
    for (const method of Object.values(client)) method.mockReset();
    client.search.mockResolvedValue({ works: [WORK], total: 1, page: 1, perPage: 8 });
    client.byDoi.mockResolvedValue(WORK);
    client.citedBy.mockResolvedValue({ works: [WORK], total: 1, page: 1, perPage: 10 });
    client.references.mockResolvedValue({ works: [WORK], total: 1, page: 1, perPage: 10 });
});

describe('every OpenAlex request', () => {
    it('carries the run\'s stop signal', async () => {
        const controller = new AbortController();
        const budget = literatureBudgetForTest(10);
        const webSearch = webSearchToolForTest(undefined, budget, controller.signal);
        const literature = literatureToolsForTest(undefined, budget, controller.signal);

        await webSearch({ query: 'waggle dance odometry' });
        await literature.lookup_paper({ doi: '10.1000/bees.1' });
        await literature.lookup_paper({ title: 'Waggle dance odometry' });
        await literature.find_citing_papers({ openalex_id: 'W1' });
        await literature.find_cited_papers({ openalex_id: 'W1' });

        const signals = [
            client.search.mock.calls[0][1]?.signal,
            client.byDoi.mock.calls[0][1]?.signal,
            client.search.mock.calls[1][1]?.signal,
            client.citedBy.mock.calls[0][1]?.signal,
            client.references.mock.calls[0][1]?.signal,
        ];
        expect(signals.every((signal) => signal === controller.signal)).toBe(true);
    });
});

describe('a lookup cut short by Stop', () => {
    it('ends the search as a stop, not as OpenAlex being down', async () => {
        const controller = new AbortController();
        const budget = literatureBudgetForTest(10);
        client.search.mockImplementationOnce(cancelledBy(controller));

        await expect(webSearchToolForTest(undefined, budget, controller.signal)({ query: 'waggle' }))
            .rejects.toThrow(/stopped/);
        expect((budget as any).outages).toBe(0);
    });

    it('ends a paper lookup as a stop, not as OpenAlex being down', async () => {
        const controller = new AbortController();
        const budget = literatureBudgetForTest(10);
        client.byDoi.mockImplementationOnce(cancelledBy(controller));

        await expect(
            literatureToolsForTest(undefined, budget, controller.signal).lookup_paper({ doi: '10.1/x' }),
        ).rejects.toThrow(/stopped/);
        expect((budget as any).outages).toBe(0);
    });

    it('makes no request at all once the run has been stopped', async () => {
        const controller = new AbortController();
        controller.abort();
        const budget = literatureBudgetForTest(10);

        await expect(webSearchToolForTest(undefined, budget, controller.signal)({ query: 'waggle' }))
            .rejects.toThrow(/stopped/);
        await expect(
            literatureToolsForTest(undefined, budget, controller.signal).find_citing_papers({ openalex_id: 'W1' }),
        ).rejects.toThrow(/stopped/);
        expect(client.search).not.toHaveBeenCalled();
        expect(client.citedBy).not.toHaveBeenCalled();
        // Nothing was looked up, so nothing was spent.
        expect((budget as any).used).toBe(0);
    });

    it('leaves a real outage reported as one', async () => {
        const controller = new AbortController();
        const budget = literatureBudgetForTest(10);
        client.search.mockRejectedValueOnce(new Error('OpenAlex request failed: 503 Service Unavailable'));

        const out = String(await webSearchToolForTest(undefined, budget, controller.signal)({ query: 'waggle' }));

        expect(out).toMatch(/did not respond/);
        expect((budget as any).outages).toBe(1);
    });
});
