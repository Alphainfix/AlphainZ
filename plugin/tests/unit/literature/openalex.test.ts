import { describe, expect, it, vi } from 'vitest';

import {
    OpenAlexClient,
    bareDoi,
    bareId,
    buildFilters,
    buildSearchUrl,
    formatWorksForModel,
    normalizeWork,
    reconstructAbstract,
    type FetchJson,
    type OpenAlexWork,
} from '../../../src/services/literature/openalex';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonFetch(payload: unknown, ok = true, status = 200): FetchJson & { urls: string[] } {
    const urls: string[] = [];
    const fn = (async (url: string) => {
        urls.push(url);
        return {
            ok,
            status,
            statusText: ok ? 'OK' : 'Error',
            text: async () => JSON.stringify(payload),
        };
    }) as FetchJson & { urls: string[] };
    fn.urls = urls;
    return fn;
}

const RAW_WORK = {
    id: 'https://openalex.org/W2741809807',
    display_name: 'Waggle-dance odometry in honeybees',
    publication_year: 2019,
    doi: 'https://doi.org/10.1038/s41586-019-1234-5',
    type: 'article',
    cited_by_count: 412,
    authorships: [
        {
            author: { display_name: 'A. Researcher' },
            institutions: [{ display_name: 'Example University' }],
        },
        { author: { display_name: 'B. Coauthor' }, institutions: [] },
    ],
    primary_location: { source: { display_name: 'Nature' } },
    open_access: { oa_url: 'https://example.org/paper.pdf' },
    abstract_inverted_index: { Distance: [0], coding: [1], in: [2], honeybees: [3] },
    referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
};

// ---------------------------------------------------------------------------
// Id and DOI normalization
// ---------------------------------------------------------------------------

describe('bareId', () => {
    it('reduces a URL id to its key', () => {
        expect(bareId('https://openalex.org/W2741809807')).toBe('W2741809807');
    });

    it('leaves an already-bare key alone', () => {
        expect(bareId('W123')).toBe('W123');
    });

    it('returns empty for missing input', () => {
        expect(bareId(null)).toBe('');
        expect(bareId(undefined)).toBe('');
        expect(bareId('')).toBe('');
    });
});

describe('bareDoi', () => {
    it('strips the doi.org prefix', () => {
        expect(bareDoi('https://doi.org/10.1038/s41586-019-1234-5')).toBe(
            '10.1038/s41586-019-1234-5',
        );
    });

    it('accepts a bare DOI', () => {
        expect(bareDoi('10.1242/jeb.130.123456')).toBe('10.1242/jeb.130.123456');
    });

    it('returns undefined when there is no DOI', () => {
        expect(bareDoi(null)).toBeUndefined();
        expect(bareDoi('not-a-doi')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Abstract reconstruction — the format's real gotcha
// ---------------------------------------------------------------------------

describe('reconstructAbstract', () => {
    it('rebuilds prose from token positions', () => {
        expect(
            reconstructAbstract({ We: [0], measured: [1], the: [2], distance: [3] }),
        ).toBe('We measured the distance');
    });

    it('places a repeated token at each of its positions', () => {
        expect(reconstructAbstract({ the: [0, 2], waggle: [1], dance: [3] })).toBe(
            'the waggle the dance',
        );
    });

    it('orders by position, not by key insertion order', () => {
        expect(reconstructAbstract({ second: [1], first: [0] })).toBe('first second');
    });

    it('closes gaps rather than emitting empty words', () => {
        // Sparse positions are normal; writing into a fixed-length array would
        // leave holes that join into double spaces.
        expect(reconstructAbstract({ a: [0], b: [5] })).toBe('a b');
    });

    it('returns undefined for a missing or empty index', () => {
        expect(reconstructAbstract(null)).toBeUndefined();
        expect(reconstructAbstract(undefined)).toBeUndefined();
        expect(reconstructAbstract({})).toBeUndefined();
    });

    it('ignores malformed position entries', () => {
        expect(
            reconstructAbstract({ good: [0], bad: 'nope' as any, alsoBad: [NaN] }),
        ).toBe('good');
    });
});

// ---------------------------------------------------------------------------
// normalizeWork
// ---------------------------------------------------------------------------

describe('normalizeWork', () => {
    it('maps a complete work', () => {
        expect(normalizeWork(RAW_WORK)).toEqual({
            id: 'W2741809807',
            title: 'Waggle-dance odometry in honeybees',
            year: 2019,
            doi: '10.1038/s41586-019-1234-5',
            authors: [
                { name: 'A. Researcher', affiliation: 'Example University' },
                { name: 'B. Coauthor' },
            ],
            venue: 'Nature',
            citedByCount: 412,
            abstract: 'Distance coding in honeybees',
            openAccessUrl: 'https://example.org/paper.pdf',
            type: 'article',
            referencedWorkCount: 2,
        });
    });

    it('falls back to title when display_name is null', () => {
        expect(normalizeWork({ title: 'Fallback', display_name: null }).title).toBe('Fallback');
    });

    it('survives an almost-empty record', () => {
        const work = normalizeWork({});
        expect(work).toMatchObject({
            id: '',
            title: '(untitled)',
            authors: [],
            citedByCount: 0,
            referencedWorkCount: 0,
        });
        expect(work.abstract).toBeUndefined();
    });

    it('does not crash on a null authorships array', () => {
        expect(normalizeWork({ authorships: null }).authors).toEqual([]);
    });

    it('labels an author with no name', () => {
        expect(normalizeWork({ authorships: [{ author: {} }] }).authors).toEqual([
            { name: '(unknown)' },
        ]);
    });
});

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

describe('buildFilters', () => {
    it('is empty with no constraints', () => {
        expect(buildFilters({})).toBe('');
    });

    it('renders a year range as date bounds', () => {
        expect(buildFilters({ fromYear: 2020, toYear: 2024 })).toBe(
            'from_publication_date:2020-01-01,to_publication_date:2024-12-31',
        );
    });

    it('adds the open-access clause', () => {
        expect(buildFilters({ openAccessOnly: true })).toBe('is_oa:true');
    });

    it('appends raw extra filters', () => {
        expect(buildFilters({ openAccessOnly: true, extraFilters: ['cites:W1'] })).toBe(
            'is_oa:true,cites:W1',
        );
    });
});

describe('buildSearchUrl', () => {
    it('encodes the query and defaults paging', () => {
        const url = buildSearchUrl('honeybee waggle dance');
        expect(url).toContain('search=honeybee+waggle+dance');
        expect(url).toContain('per_page=10');
        expect(url).toContain('page=1');
    });

    it('clamps per_page to the API maximum', () => {
        expect(buildSearchUrl('x', { perPage: 5000 })).toContain('per_page=200');
        expect(buildSearchUrl('x', { perPage: 0 })).toContain('per_page=1');
    });

    it('omits an empty search term so a pure filter query is valid', () => {
        const url = buildSearchUrl('   ', { extraFilters: ['cites:W1'] });
        expect(url).not.toContain('search=');
        expect(url).toContain('filter=cites%3AW1');
    });

    it('never sends a contact address unless one is supplied', () => {
        // The address is personal data that lands in every query string, so it
        // has to stay opt-in.
        expect(buildSearchUrl('x')).not.toContain('mailto');
        expect(buildSearchUrl('x', { contactEmail: 'a@b.edu' })).toContain('mailto=a%40b.edu');
    });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe('OpenAlexClient', () => {
    it('returns normalized works and the total count', async () => {
        const fetchJson = jsonFetch({ meta: { count: 2731, page: 1, per_page: 10 }, results: [RAW_WORK] });
        const result = await new OpenAlexClient(fetchJson).search('waggle dance');

        expect(result.total).toBe(2731);
        expect(result.works).toHaveLength(1);
        expect(result.works[0].id).toBe('W2741809807');
    });

    it('treats a missing results array as an empty page', async () => {
        const result = await new OpenAlexClient(jsonFetch({ meta: { count: 0 } })).search('zzz');
        expect(result.works).toEqual([]);
        expect(result.total).toBe(0);
    });

    it('builds a cites: filter from a URL work id', async () => {
        const fetchJson = jsonFetch({ meta: { count: 0 }, results: [] });
        await new OpenAlexClient(fetchJson).citedBy('https://openalex.org/W2741809807');
        expect(fetchJson.urls[0]).toContain('filter=cites%3AW2741809807');
    });

    it('builds a cited_by: filter for references', async () => {
        const fetchJson = jsonFetch({ meta: { count: 0 }, results: [] });
        await new OpenAlexClient(fetchJson).references('W99');
        expect(fetchJson.urls[0]).toContain('filter=cited_by%3AW99');
    });

    it('rejects a citation lookup with no id', async () => {
        const client = new OpenAlexClient(jsonFetch({}));
        await expect(client.citedBy('')).rejects.toThrow('requires an OpenAlex work id');
    });

    it('carries a constructor contact address into requests', async () => {
        const fetchJson = jsonFetch({ meta: { count: 0 }, results: [] });
        await new OpenAlexClient(fetchJson, { contactEmail: 'me@uni.edu' }).search('x');
        expect(fetchJson.urls[0]).toContain('mailto=me%40uni.edu');
    });

    it('reports an HTTP failure with the status and a hint', async () => {
        const fetchJson = jsonFetch({ message: 'slow down' }, false, 429);
        await expect(new OpenAlexClient(fetchJson).search('x')).rejects.toThrow(/429.*rate limited/s);
    });

    it('reports a non-JSON body clearly', async () => {
        const fetchJson = (async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => '<html>gateway</html>',
        })) as FetchJson;
        await expect(new OpenAlexClient(fetchJson).search('x')).rejects.toThrow('not JSON');
    });

    it('resolves a DOI to a work', async () => {
        const fetchJson = jsonFetch(RAW_WORK);
        const work = await new OpenAlexClient(fetchJson).byDoi('10.1038/s41586-019-1234-5');
        expect(work?.id).toBe('W2741809807');
        expect(fetchJson.urls[0]).toContain('/works/https://doi.org/10.1038/s41586-019-1234-5');
    });

    it('returns null for an unparseable DOI without calling the API', async () => {
        const fetchJson = jsonFetch({});
        expect(await new OpenAlexClient(fetchJson).byDoi('garbage')).toBeNull();
        expect(fetchJson.urls).toHaveLength(0);
    });

    it('treats an unknown DOI as a miss rather than an error', async () => {
        const fetchJson = jsonFetch({ message: 'not found' }, false, 404);
        expect(await new OpenAlexClient(fetchJson).byDoi('10.1/nope')).toBeNull();
    });

    it('passes the abort signal through to fetch', async () => {
        const spy = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ meta: { count: 0 }, results: [] }),
        }));
        const controller = new AbortController();
        await new OpenAlexClient(spy as unknown as FetchJson).search('x', {
            signal: controller.signal,
        });
        expect(spy.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    });
});

// ---------------------------------------------------------------------------
// Model-facing formatting
// ---------------------------------------------------------------------------

describe('formatWorksForModel', () => {
    const work: OpenAlexWork = {
        id: 'W1',
        title: 'A paper',
        year: 2021,
        doi: '10.1/x',
        authors: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }, { name: 'Four' }],
        venue: 'Anim. Behav.',
        citedByCount: 7,
        abstract: 'y'.repeat(900),
        openAccessUrl: 'https://oa.example/x.pdf',
        referencedWorkCount: 3,
    };

    it('says so plainly when there are no results', () => {
        expect(formatWorksForModel([])).toBe('No matching works.');
    });

    it('abbreviates a long author list', () => {
        expect(formatWorksForModel([work])).toContain('One, Two, Three et al.');
    });

    it('clips a long abstract so a page of results still fits the window', () => {
        const out = formatWorksForModel([work], 100);
        expect(out).toContain(`${'y'.repeat(100)}…`);
        expect(out).not.toContain('y'.repeat(101));
    });

    it('hands the model a ready-to-paste citation tag per work', () => {
        const out = formatWorksForModel([work]);
        expect(out).toContain('Cite as: <citation external_id="W1"/>');
    });

    it('includes ids the agent needs for follow-up calls', () => {
        const out = formatWorksForModel([work]);
        expect(out).toContain('OpenAlex: W1');
        expect(out).toContain('DOI: 10.1/x');
        expect(out).toContain('cited by 7');
    });

    it('handles a work with no authors', () => {
        expect(formatWorksForModel([{ ...work, authors: [] }])).toContain('(no authors listed)');
    });
});

describe('OpenAlex API key', () => {
    it('buildSearchUrl carries api_key when given', () => {
        expect(buildSearchUrl('x', { apiKey: 'k123' })).toContain('api_key=k123');
        expect(buildSearchUrl('x')).not.toContain('api_key');
    });

    it('a client-level key reaches every search URL', async () => {
        const fetchJson = jsonFetch({ results: [], meta: { count: 0 } });
        const client = new OpenAlexClient(fetchJson, { apiKey: 'k123' });
        await client.search('waggle dance');
        await client.citedBy('W99');
        expect(fetchJson.urls.every((u) => u.includes('api_key=k123'))).toBe(true);
    });

    it('byDoi carries the key too', async () => {
        const fetchJson = jsonFetch({ id: 'https://openalex.org/W1' });
        const client = new OpenAlexClient(fetchJson, { apiKey: 'k123' });
        await client.byDoi('10.1000/x');
        expect(fetchJson.urls[0]).toContain('api_key=k123');
    });

    it('a per-call key overrides the client one', async () => {
        const fetchJson = jsonFetch({ results: [], meta: { count: 0 } });
        const client = new OpenAlexClient(fetchJson, { apiKey: 'client-key' });
        await client.search('x', { apiKey: 'call-key' });
        expect(fetchJson.urls[0]).toContain('api_key=call-key');
    });
});
