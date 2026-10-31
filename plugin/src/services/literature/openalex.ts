/**
 * OpenAlex literature search.
 *
 * OpenAlex is the catalogue behind the "240 million scholarly works" Beaver
 * advertises, and it is free and keyless — so this replaces a metered cloud
 * feature with a direct call. Roughly 250M works, 100k requests/day.
 *
 * Pure apart from the injected `fetch`: no Zotero globals.
 *
 * API notes that shape this module:
 *  - Work ids are URLs (`https://openalex.org/W2741809807`); the bare key is
 *    the last path segment and is what `filter=` expressions expect.
 *  - Abstracts arrive as `abstract_inverted_index` (token → positions) and have
 *    to be rebuilt into prose.
 *  - Supplying a contact address moves a caller into the faster "polite pool".
 *    It is opt-in here and never defaulted: an address is personal data and
 *    ends up in the query string of every request.
 */

export interface OpenAlexAuthor {
    name: string;
    /** Raw affiliation string as OpenAlex reports it, when present. */
    affiliation?: string;
}

export interface OpenAlexWork {
    /** Bare OpenAlex key, e.g. `W2741809807`. */
    id: string;
    title: string;
    year?: number;
    doi?: string;
    authors: OpenAlexAuthor[];
    venue?: string;
    citedByCount: number;
    abstract?: string;
    /** Direct link to an open-access PDF or landing page, when one exists. */
    openAccessUrl?: string;
    type?: string;
    referencedWorkCount: number;
}

export interface SearchOptions {
    /** 1-200. OpenAlex rejects larger pages. */
    perPage?: number;
    page?: number;
    /** Inclusive lower bound on publication year. */
    fromYear?: number;
    toYear?: number;
    /** Restrict to works with a free full text. */
    openAccessOnly?: boolean;
    /** Extra raw `filter=` clauses, joined with the generated ones. */
    extraFilters?: string[];
    /** Opt-in contact address for OpenAlex's polite pool. */
    contactEmail?: string;
    /**
     * Free OpenAlex API key (openalex.org/settings/api). Required by OpenAlex
     * from February 2026; without one, anonymous search is rate-limited
     * whenever their search cluster is busy.
     */
    apiKey?: string;
    signal?: AbortSignal;
}

export interface SearchResult {
    works: OpenAlexWork[];
    /** Total matches, which may far exceed the page returned. */
    total: number;
    page: number;
    perPage: number;
}

export type FetchJson = (
    url: string,
    init: Record<string, any>,
) => Promise<{ ok: boolean; status: number; statusText?: string; text: () => Promise<string> }>;

const API_ROOT = 'https://api.openalex.org';
const MAX_PER_PAGE = 200;

/**
 * Longest one OpenAlex request may take. The API normally answers in well
 * under a second; without a limit, a stalled request holds the agent's tool
 * step for as long as the network stack cares to wait.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A failed OpenAlex request. `status` is the HTTP status when OpenAlex
 * answered, so a caller can tell a rejected key (401/403) or a rate limit
 * (429) from an outage without reading the message.
 */
export class OpenAlexRequestError extends Error {
    readonly kind: 'http' | 'network' | 'timeout' | 'cancelled';
    readonly status?: number;

    constructor(message: string, kind: OpenAlexRequestError['kind'], status?: number) {
        super(message);
        this.name = 'OpenAlexRequestError';
        this.kind = kind;
        if (status !== undefined) this.status = status;
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Strip an OpenAlex URL id down to its bare key.
 *
 * `filter=cites:` and the `/works/{id}` route both want `W123`, not the full
 * URL the API hands back, so every id crossing this boundary is normalized.
 */
export function bareId(id: string | null | undefined): string {
    if (!id) return '';
    const trimmed = id.trim();
    const lastSlash = trimmed.lastIndexOf('/');
    return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/** Reduce a DOI to bare `10.x/y` form, dropping any `https://doi.org/` prefix. */
export function bareDoi(doi: string | null | undefined): string | undefined {
    if (!doi) return undefined;
    const match = /10\.\d{4,9}\/\S+/.exec(doi.trim());
    return match ? match[0] : undefined;
}

/**
 * Rebuild prose from OpenAlex's inverted abstract index.
 *
 * The field maps each token to the positions it occupies, so the abstract is
 * recovered by sorting every (position, token) pair. Positions can be sparse
 * when OpenAlex drops a token, so the output is joined rather than written into
 * a fixed-length array — a gap would otherwise become an empty word.
 */
export function reconstructAbstract(
    invertedIndex: Record<string, number[]> | null | undefined,
): string | undefined {
    if (!invertedIndex) return undefined;

    const placed: Array<{ position: number; token: string }> = [];
    for (const [token, positions] of Object.entries(invertedIndex)) {
        if (!Array.isArray(positions)) continue;
        for (const position of positions) {
            if (typeof position === 'number' && Number.isFinite(position)) {
                placed.push({ position, token });
            }
        }
    }
    if (placed.length === 0) return undefined;

    placed.sort((a, b) => a.position - b.position);
    return placed.map((entry) => entry.token).join(' ');
}

/** Map one raw API work onto the shape the agent tools consume. */
export function normalizeWork(raw: any): OpenAlexWork {
    const authorships = Array.isArray(raw?.authorships) ? raw.authorships : [];
    return {
        id: bareId(raw?.id),
        // `display_name` is the reliable one; `title` is occasionally null even
        // when a work is otherwise complete.
        title: raw?.display_name ?? raw?.title ?? '(untitled)',
        year: typeof raw?.publication_year === 'number' ? raw.publication_year : undefined,
        doi: bareDoi(raw?.doi),
        authors: authorships.map((authorship: any) => {
            const institutions = Array.isArray(authorship?.institutions)
                ? authorship.institutions
                : [];
            const affiliation = institutions[0]?.display_name;
            return {
                name: authorship?.author?.display_name ?? '(unknown)',
                ...(affiliation ? { affiliation } : {}),
            };
        }),
        venue: raw?.primary_location?.source?.display_name ?? undefined,
        citedByCount: typeof raw?.cited_by_count === 'number' ? raw.cited_by_count : 0,
        abstract: reconstructAbstract(raw?.abstract_inverted_index),
        openAccessUrl: raw?.open_access?.oa_url ?? undefined,
        type: raw?.type ?? undefined,
        referencedWorkCount: Array.isArray(raw?.referenced_works)
            ? raw.referenced_works.length
            : 0,
    };
}

/** Build the `filter=` value from the structured options. */
export function buildFilters(options: SearchOptions): string {
    const clauses: string[] = [];
    if (options.fromYear !== undefined) {
        clauses.push(`from_publication_date:${options.fromYear}-01-01`);
    }
    if (options.toYear !== undefined) {
        clauses.push(`to_publication_date:${options.toYear}-12-31`);
    }
    if (options.openAccessOnly) clauses.push('is_oa:true');
    if (options.extraFilters?.length) clauses.push(...options.extraFilters);
    return clauses.join(',');
}

export function buildSearchUrl(query: string, options: SearchOptions = {}): string {
    const params = new URLSearchParams();
    const trimmed = query.trim();
    if (trimmed) params.set('search', trimmed);

    const filters = buildFilters(options);
    if (filters) params.set('filter', filters);

    // Clamp rather than forward a value the API would reject outright.
    const perPage = Math.min(Math.max(options.perPage ?? 10, 1), MAX_PER_PAGE);
    params.set('per_page', String(perPage));
    params.set('page', String(Math.max(options.page ?? 1, 1)));

    if (options.contactEmail) params.set('mailto', options.contactEmail);
    if (options.apiKey) params.set('api_key', options.apiKey);

    return `${API_ROOT}/works?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class OpenAlexClient {
    private readonly fetchJson: FetchJson;
    private readonly contactEmail?: string;
    private readonly apiKey?: string;

    constructor(
        fetchJson: FetchJson,
        identity?: { contactEmail?: string; apiKey?: string },
    ) {
        this.fetchJson = fetchJson;
        this.contactEmail = identity?.contactEmail;
        this.apiKey = identity?.apiKey;
    }

    /**
     * GET one URL as JSON, within `REQUEST_TIMEOUT_MS` whether or not the
     * caller passed a signal of its own.
     */
    private async getJson(url: string, signal?: AbortSignal): Promise<any> {
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', forwardAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, REQUEST_TIMEOUT_MS);

        // Raced against the abort as well as handed to fetch, so a transport
        // that ignores the signal still cannot outlast the deadline.
        const aborted = new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        aborted.catch(() => undefined);
        const settle = <T>(promise: Promise<T>): Promise<T> => {
            promise.catch(() => undefined);
            return Promise.race([promise, aborted]);
        };

        try {
            let response;
            try {
                response = await settle(this.fetchJson(url, {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    signal: controller.signal,
                }));
            } catch (error) {
                if (timedOut) {
                    throw new OpenAlexRequestError(
                        `OpenAlex did not respond within ${REQUEST_TIMEOUT_MS / 1000} s`,
                        'timeout',
                    );
                }
                if (signal?.aborted) throw new OpenAlexRequestError('OpenAlex request cancelled', 'cancelled');
                const message = error instanceof Error ? error.message : String(error);
                throw new OpenAlexRequestError(`OpenAlex could not be reached: ${message}`, 'network');
            }

            if (!response.ok) {
                let detail = '';
                try {
                    const body = await settle(response.text());
                    try {
                        detail = JSON.parse(body)?.message ?? body;
                    } catch {
                        detail = body;
                    }
                } catch {
                    // Status alone is still worth reporting.
                }
                const hint = response.status === 429 ? ' — rate limited by OpenAlex' : '';
                throw new OpenAlexRequestError(
                    `OpenAlex request failed: ${response.status} ${response.statusText ?? ''}${hint}${
                        detail ? `\n${String(detail).slice(0, 300)}` : ''
                    }`.trim(),
                    'http',
                    response.status,
                );
            }

            let raw: string;
            try {
                raw = await settle(response.text());
            } catch (error) {
                if (timedOut) {
                    throw new OpenAlexRequestError(
                        `OpenAlex did not respond within ${REQUEST_TIMEOUT_MS / 1000} s`,
                        'timeout',
                    );
                }
                if (signal?.aborted) throw new OpenAlexRequestError('OpenAlex request cancelled', 'cancelled');
                const message = error instanceof Error ? error.message : String(error);
                throw new OpenAlexRequestError(`OpenAlex could not be reached: ${message}`, 'network');
            }
            try {
                return JSON.parse(raw);
            } catch {
                throw new Error('OpenAlex returned a response that was not JSON');
            }
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', forwardAbort);
        }
    }

    async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
        const merged = { contactEmail: this.contactEmail, apiKey: this.apiKey, ...options };
        const url = buildSearchUrl(query, merged);
        const json = await this.getJson(url, options.signal);

        const results = Array.isArray(json?.results) ? json.results : [];
        return {
            works: results.map(normalizeWork),
            total: typeof json?.meta?.count === 'number' ? json.meta.count : results.length,
            page: typeof json?.meta?.page === 'number' ? json.meta.page : (merged.page ?? 1),
            perPage:
                typeof json?.meta?.per_page === 'number'
                    ? json.meta.per_page
                    : (merged.perPage ?? 10),
        };
    }

    /** Works citing the given work — the "who built on this" direction. */
    async citedBy(workId: string, options: SearchOptions = {}): Promise<SearchResult> {
        const key = bareId(workId);
        if (!key) throw new Error('citedBy requires an OpenAlex work id');
        return this.search('', {
            ...options,
            extraFilters: [...(options.extraFilters ?? []), `cites:${key}`],
        });
    }

    /** Works this one cites — the reference list, fetched in one batched query. */
    async references(workId: string, options: SearchOptions = {}): Promise<SearchResult> {
        const key = bareId(workId);
        if (!key) throw new Error('references requires an OpenAlex work id');
        return this.search('', {
            ...options,
            extraFilters: [...(options.extraFilters ?? []), `cited_by:${key}`],
        });
    }

    async byDoi(doi: string, options: SearchOptions = {}): Promise<OpenAlexWork | null> {
        const bare = bareDoi(doi);
        if (!bare) return null;
        const params = new URLSearchParams();
        const email = options.contactEmail ?? this.contactEmail;
        if (email) params.set('mailto', email);
        const apiKey = options.apiKey ?? this.apiKey;
        if (apiKey) params.set('api_key', apiKey);
        const suffix = params.toString() ? `?${params.toString()}` : '';
        try {
            const json = await this.getJson(
                `${API_ROOT}/works/https://doi.org/${bare}${suffix}`,
                options.signal,
            );
            return json?.id ? normalizeWork(json) : null;
        } catch (error) {
            // A DOI that OpenAlex has never seen is a legitimate miss, not a
            // failure the caller should have to catch. Read from the status:
            // the message also quotes the DOI and the body, either of which
            // can contain "404".
            if ((error as OpenAlexRequestError | null)?.status === 404) return null;
            throw error;
        }
    }
}

/**
 * Render works as compact text for a model's context.
 *
 * Abstracts are the bulk of a result set, so they are clipped per work: a
 * 20-result page of full abstracts crowds out everything else in the window.
 */
export function formatWorksForModel(works: OpenAlexWork[], abstractChars = 500): string {
    if (works.length === 0) return 'No matching works.';
    return works
        .map((work, index) => {
            const authors =
                work.authors.length > 3
                    ? `${work.authors.slice(0, 3).map((a) => a.name).join(', ')} et al.`
                    : work.authors.map((a) => a.name).join(', ');
            const lines = [
                `[${index + 1}] ${work.title}`,
                `    ${authors || '(no authors listed)'}${work.year ? ` · ${work.year}` : ''}${
                    work.venue ? ` · ${work.venue}` : ''
                }`,
                `    OpenAlex: ${work.id}${work.doi ? ` · DOI: ${work.doi}` : ''} · cited by ${work.citedByCount}`,
                // Ready to paste — the tag renders as a clickable reference the
                // reader can open on the web. A requirement that has to hold
                // cannot live in the prompt alone.
                `    Cite as: <citation external_id="${work.id}"/>`,
            ];
            if (work.openAccessUrl) lines.push(`    Open access: ${work.openAccessUrl}`);
            if (work.abstract) {
                const clipped =
                    work.abstract.length > abstractChars
                        ? `${work.abstract.slice(0, abstractChars)}…`
                        : work.abstract;
                lines.push(`    ${clipped}`);
            }
            return lines.join('\n');
        })
        .join('\n\n');
}
