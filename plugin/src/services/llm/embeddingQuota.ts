/**
 * Pacing the indexer on a free Google key, so that searches keep working.
 *
 * The Gemini API's free tier counts every text in a batch as a request: 100 a
 * minute and about 1000 a day for each embedding model (Google no longer
 * publishes the numbers; these are what its 429s report). Left alone, a
 * library-wide pass spends both, and topic search is refused for the rest of
 * the minute — or of the day. So once the API has said a key is on the free
 * tier, the indexer keeps to 80 texts a minute and 800 a day, and leaves the
 * rest to searches. A paid key is not paced: its limits are many times higher,
 * and a 429 there is simply waited out (see EmbeddingProvider).
 *
 * The tier is learned from the first 429 that names its quota and remembered
 * per key — by a fingerprint, never the key itself — so a key changed in
 * Settings starts unknown again. The day is Google's: it turns over at
 * midnight Pacific time.
 */

import { getPref, setPref } from '../../utils/prefs';
import { msUntilPacificMidnight, type EmbeddingRequestOutcome } from './embeddings';
import { ModelRequestError, isModelRequestError } from './sse';

/** Texts the indexer may send in any minute on the free tier, of 100. */
export const FREE_INDEX_PER_MINUTE = 80;
/** Texts the indexer may send in a Pacific day on the free tier, of about 1000. */
export const FREE_INDEX_PER_DAY = 800;
/**
 * Of that, what page images leave unspent: the text of a paper added later in
 * the day — a few dozen passages — is still indexed that day, ahead of the
 * pictures, instead of waiting for midnight behind them.
 */
export const FREE_TEXT_RESERVE_PER_DAY = 200;

const MINUTE_MS = 60_000;

interface QuotaState {
    /** Tier by key fingerprint, as the API last reported it. */
    tiers?: Record<string, 'free' | 'paid'>;
    /** What the indexer sent today, for one key. */
    day?: { date: string; key: string; count: number };
}

/** A short stand-in for a key: enough to tell keys apart, useless as a key. */
export function keyFingerprint(key: string): string {
    let hash = 5381;
    for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) + hash) ^ key.charCodeAt(i);
    return `${(hash >>> 0).toString(36)}${key.length}`;
}

/** Today's date in Pacific time, as YYYY-MM-DD. */
export function pacificDate(now: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
}

function readState(): QuotaState {
    const raw = getPref('embeddingQuota');
    if (typeof raw !== 'string' || !raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as QuotaState) : {};
    } catch {
        return {};
    }
}

function writeState(state: QuotaState): void {
    setPref('embeddingQuota', JSON.stringify(state));
}

/** What the API last said about this key's tier; undefined until a 429 tells. */
export function knownTier(key: string): 'free' | 'paid' | undefined {
    return readState().tiers?.[keyFingerprint(key)];
}

/** Texts sent by the indexer in the last minute, per key fingerprint. */
const recent = new Map<string, Array<{ at: number; count: number }>>();

function sentInLastMinute(fingerprint: string, now: number): number {
    const log = (recent.get(fingerprint) ?? []).filter((entry) => now - entry.at < MINUTE_MS);
    recent.set(fingerprint, log);
    return log.reduce((sum, entry) => sum + entry.count, 0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * The indexer's admission and bookkeeping for one Google key: pass
 * `beforeIndexBatch` and `onRequest` to the provider.
 */
export function geminiIndexPacing(key: string, label: string): {
    beforeIndexBatch: (count: number, signal?: AbortSignal, kind?: 'text' | 'image') => Promise<void>;
    onRequest: (outcome: EmbeddingRequestOutcome) => void;
} {
    const fingerprint = keyFingerprint(key);

    const beforeIndexBatch = async (count: number, signal?: AbortSignal, kind: 'text' | 'image' = 'text') => {
        if (knownTier(key) !== 'free') return;
        const state = readState();
        const today = pacificDate();
        const usedToday = state.day?.date === today && state.day.key === fingerprint ? state.day.count : 0;
        const pictures = kind === 'image';
        const allowance = pictures ? FREE_INDEX_PER_DAY - FREE_TEXT_RESERVE_PER_DAY : FREE_INDEX_PER_DAY;
        if (usedToday + count > allowance) {
            throw new ModelRequestError(
                `${label} embeddings: the free tier's daily allowance for ${pictures ? 'page images' : 'indexing'} is used`,
                {
                    kind: 'http',
                    label,
                    status: 429,
                    code: 'daily_quota',
                    quotaTier: 'free',
                    retryAfterMs: msUntilPacificMidnight(),
                    detail: pictures
                        ? `Page images keep to ${allowance} requests a day on a free key, leaving the rest for new papers and searches.`
                        : `Indexing keeps to ${FREE_INDEX_PER_DAY} texts a day on a free key, leaving the rest for searches.`,
                },
            );
        }
        // Wait until this batch fits in the minute, as entries age out.
        for (;;) {
            const now = Date.now();
            const sent = sentInLastMinute(fingerprint, now);
            if (sent + count <= FREE_INDEX_PER_MINUTE || sent === 0) return;
            const oldest = Math.min(...(recent.get(fingerprint) ?? []).map((entry) => entry.at));
            if (!(await sleep(Math.max(250, oldest + MINUTE_MS - now), signal))) return;
        }
    };

    const onRequest = (outcome: EmbeddingRequestOutcome) => {
        if (outcome.ok) {
            if (outcome.purpose !== 'index') return;
            const now = Date.now();
            const log = recent.get(fingerprint) ?? [];
            log.push({ at: now, count: outcome.count });
            recent.set(fingerprint, log);
            // Counted only on a key known to be free: a paid key is never
            // refused for its day, so its count would be kept for nothing.
            if (knownTier(key) !== 'free') return;
            const state = readState();
            const today = pacificDate();
            const day = state.day?.date === today && state.day.key === fingerprint
                ? state.day
                : { date: today, key: fingerprint, count: 0 };
            writeState({ ...state, day: { ...day, count: day.count + outcome.count } });
            return;
        }
        const error = outcome.error;
        if (!isModelRequestError(error) || error.quotaTier === undefined) return;
        const state = readState();
        if (state.tiers?.[fingerprint] === error.quotaTier) return;
        writeState({ ...state, tiers: { ...(state.tiers ?? {}), [fingerprint]: error.quotaTier } });
    };

    return { beforeIndexBatch, onRequest };
}

/** Test seam: forget the per-minute log. */
export function resetEmbeddingPacing(): void {
    recent.clear();
}
