/**
 * Limits on one question, as the user set them in Settings → Advanced.
 *
 * Four numbers bound a run: how many tokens one reply may spend (thinking
 * included), how many model requests one question may make, and how many
 * searches of the library and of the literature it may run. Each exists
 * because an unbounded run went badly — the call sites say how — and each was
 * a constant until people asking different questions ran into them: a
 * thinking model on an 8,000-token reply cap spent it all reasoning and
 * answered nothing ("reached its output limit while thinking"), and a
 * literature question stopped at its fourth search.
 *
 * Read at the start of every run, so a change applies to the next question
 * without a restart.
 */

import { getPref } from './prefs';

/** `maxOutputTokens` value meaning "the provider's own default". */
export const AUTO_OUTPUT_TOKENS = 0;
/** Search-limit value meaning no limit; the request limit still bounds the run. */
export const NO_SEARCH_LIMIT = 0;

export const DEFAULT_MAX_MODEL_REQUESTS = 24;
/**
 * Twenty searches of each kind. The limits began at six and four, sized
 * against runaway runs (39 web searches, 16 rephrasings of one library
 * query); in use they stopped real questions short more often than they
 * stopped a runaway, so the default is now generous and the tighter setting
 * is one choice away.
 */
export const DEFAULT_MAX_LIBRARY_SEARCHES = 20;
export const DEFAULT_MAX_LITERATURE_LOOKUPS = 20;

/**
 * The request limit is always a number. Every request is billed, and a model
 * that keeps calling tools would otherwise keep a run — and the bill — going.
 */
const MODEL_REQUEST_RANGE: readonly [number, number] = [4, 200];
const SEARCH_RANGE: readonly [number, number] = [1, 100];
const OUTPUT_TOKEN_RANGE: readonly [number, number] = [1_000, 1_000_000];

export interface RunLimits {
    /** Tokens one reply may spend, thinking included, or `auto` for the provider's default. */
    outputTokens: number | 'auto';
    /** Model requests one question may make — each tool step is one. */
    modelRequests: number;
    /** Library searches per question across topic, keyword and full-text search; null is no limit. */
    librarySearches: number | null;
    /** OpenAlex lookups per question, shared by its four tools; null is no limit. */
    literatureLookups: number | null;
}

function storedInteger(key: string): number | null {
    const raw = Number(getPref(key));
    return Number.isFinite(raw) ? Math.round(raw) : null;
}

function clamp(value: number, [low, high]: readonly [number, number]): number {
    return Math.min(high, Math.max(low, value));
}

function searchLimit(key: string, fallback: number): number | null {
    const stored = storedInteger(key);
    if (stored === null || stored < 0) return fallback;
    if (stored === NO_SEARCH_LIMIT) return null;
    return clamp(stored, SEARCH_RANGE);
}

/** The limits for the run about to start. Anything unreadable falls back to its default. */
export function readRunLimits(): RunLimits {
    const output = storedInteger('maxOutputTokens');
    const requests = storedInteger('maxModelRequests');
    return {
        outputTokens: output === null || output <= AUTO_OUTPUT_TOKENS ? 'auto' : clamp(output, OUTPUT_TOKEN_RANGE),
        modelRequests: requests === null || requests <= 0 ? DEFAULT_MAX_MODEL_REQUESTS : clamp(requests, MODEL_REQUEST_RANGE),
        librarySearches: searchLimit('maxLibrarySearches', DEFAULT_MAX_LIBRARY_SEARCHES),
        literatureLookups: searchLimit('maxLiteratureLookups', DEFAULT_MAX_LITERATURE_LOOKUPS),
    };
}

/**
 * The output cap one request carries.
 *
 * `auto` takes the provider's default; a number is taken as asked, but never
 * above what the provider accepts — every provider measured answers a request
 * over its ceiling with a 400 rather than trimming it, so an honest "64k" on a
 * provider that allows 16k would fail every message.
 */
export function resolveOutputTokens(
    setting: number | 'auto',
    providerDefault: number,
    ceiling?: number,
): number {
    const wanted = setting === 'auto' ? providerDefault : setting;
    return ceiling && ceiling > 0 ? Math.min(wanted, ceiling) : wanted;
}

/** "32k", "393k": how a token count reads in a warning. */
export function formatTokenCount(tokens: number): string {
    return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}
