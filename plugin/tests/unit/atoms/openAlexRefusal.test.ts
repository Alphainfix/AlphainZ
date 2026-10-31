/**
 * What the model is told when OpenAlex turns a lookup away.
 *
 * A rate limit and a refused key are not outages, and the user can do
 * something about each — so the model is told which one it was, pointed at the
 * setting that exists (Settings → Model → Literature search), and not told to
 * send someone who already has a key to go and add one. The status decides,
 * never digits that happen to sit in OpenAlex's error body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
const search = vi.hoisted(() => vi.fn());
const byDoi = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/prefs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/utils/prefs')>()),
    getPref: (key: string) => prefs.values[key],
}));

vi.mock('../../../src/services/literature/openalex', () => ({
    OpenAlexClient: class {
        search = search;
        byDoi = byDoi;
        citedBy = vi.fn();
        references = vi.fn();
    },
    formatWorksForModel: () => 'formatted',
}));

import {
    literatureBudgetForTest,
    literatureToolsForTest,
    webSearchToolForTest,
} from '../../../react/atoms/executeLocalRun';

const failure = (status: string, body = '') =>
    new Error(`OpenAlex request failed: ${status}${body ? `\n${body}` : ''}`);

beforeEach(() => {
    prefs.values = {};
    search.mockReset();
    byDoi.mockReset();
});

describe('a rate limit', () => {
    it('points the user at the setting that exists', async () => {
        search.mockRejectedValueOnce(failure('429 Too Many Requests — rate limited by OpenAlex'));
        const out = String(await webSearchToolForTest()({ query: 'waggle dance odometry' }));
        expect(out).toMatch(/rate-limit/i);
        expect(out).toContain('Settings → Model → Literature search');
        expect(out).not.toMatch(/API keys/);
    });

    it('does not tell a user who has a key to add one', async () => {
        prefs.values.openalexApiKey = 'my-openalex-key';
        search.mockRejectedValueOnce(failure('429 Too Many Requests — rate limited by OpenAlex'));
        const out = String(await webSearchToolForTest()({ query: 'waggle dance odometry' }));
        expect(out).toMatch(/rate-limit/i);
        expect(out).not.toMatch(/add(ing)? a free OpenAlex API key/i);
    });

    it('is not read out of digits in an unrelated failure', async () => {
        search.mockRejectedValueOnce(
            failure('503 Service Unavailable', '{"doi":"10.1016/j.anbehav.94.214299"}'),
        );
        const out = String(await webSearchToolForTest()({ query: 'waggle dance odometry' }));
        expect(out).toMatch(/did not respond/i);
        expect(out).not.toMatch(/rate-limit/i);
    });
});

describe('a refused key', () => {
    it('is reported as a key problem, not as OpenAlex being down', async () => {
        prefs.values.openalexApiKey = 'mistyped-key';
        search.mockRejectedValueOnce(failure('401 Unauthorized'));
        const out = String(await webSearchToolForTest()({ query: 'waggle dance odometry' }));
        expect(out).toMatch(/did not accept the API key/);
        expect(out).toContain('Settings → Model → Literature search');
        expect(out).not.toMatch(/not responding|did not respond/i);
    });

    it('asks for a key when OpenAlex will not answer without one', async () => {
        search.mockRejectedValueOnce(failure('403 Forbidden'));
        const out = String(await webSearchToolForTest()({ query: 'waggle dance odometry' }));
        expect(out).toMatch(/needs an API key/);
        expect(out).toContain('Settings → Model → Literature search');
    });

    it('is held for this question only, so the tools work again once the key is fixed', async () => {
        // The result is replayed with the thread's later turns: a ban "in this
        // conversation" would outlive the fix.
        prefs.values.openalexApiKey = 'mistyped-key';
        search.mockRejectedValueOnce(failure('401 Unauthorized'));
        const rejected = String(await webSearchToolForTest()({ query: 'waggle dance odometry' }));

        prefs.values = {};
        search.mockRejectedValueOnce(failure('403 Forbidden'));
        const missing = String(await webSearchToolForTest()({ query: 'waggle dance odometry' }));

        for (const out of [rejected, missing]) {
            expect(out).toMatch(/again for this question/);
            expect(out).toMatch(/a later question can use them/);
            expect(out).not.toMatch(/in this conversation/);
        }
    });

    it('answers every later lookup the same way, without the network', async () => {
        prefs.values.openalexApiKey = 'mistyped-key';
        const budget = literatureBudgetForTest(6);
        const webSearch = webSearchToolForTest(undefined, budget);
        const literature = literatureToolsForTest(undefined, budget);
        search.mockRejectedValue(failure('401 Unauthorized'));

        await webSearch({ query: 'first' });
        const later = String(await literature.lookup_paper({ doi: '10.1/x' }));

        expect(later).toMatch(/did not accept the API key/);
        expect(byDoi).not.toHaveBeenCalled();
        expect(search).toHaveBeenCalledTimes(1);
    });
});

describe('an outage', () => {
    it('is held for this question only, like the budget that counts it', async () => {
        const budget = literatureBudgetForTest(10);
        const webSearch = webSearchToolForTest(undefined, budget);
        const literature = literatureToolsForTest(undefined, budget);
        search.mockRejectedValue(failure('503 Service Unavailable'));

        await webSearch({ query: 'first' });
        await webSearch({ query: 'second' });
        const refusals = [
            String(await webSearch({ query: 'third' })),
            String(await literature.lookup_paper({ title: 'Waggle dance odometry' })),
        ];

        for (const out of refusals) {
            expect(out).toMatch(/Do not call this tool again for this question/);
            expect(out).not.toMatch(/in this conversation/);
        }
    });
});
