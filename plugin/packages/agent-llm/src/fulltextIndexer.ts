/**
 * Indexing whole documents for full-text search, across the library.
 *
 * `fulltextIndex.ts` handles one document. This walks the library: which PDFs
 * are missing chunks for the current embedding model, and then one at a time —
 * extract, chunk, embed, store — reporting progress and stopping when asked.
 *
 * This pass embeds every page of every PDF, two orders of magnitude more text
 * than the metadata index, and costs real money per document. So it resumes
 * rather than restarting — a run stopped halfway is progress, not waste — and
 * it pauses once the embedding provider is seen to fail instead of spending an
 * extraction on every document the provider would refuse anyway.
 *
 * The Zotero coupling is confined to `listCandidates` and the extract callback,
 * both injected, so the loop itself is testable.
 */

import { indexDocumentChunks } from './fulltextIndex';
import type { ChunkStore, IndexDocumentResult } from './fulltextIndex';
import type { EmbeddingProvider } from './embeddings';
import { isModelRequestError, isQuotaErrorCode } from './sse';
import { joinSentences, t } from './i18n';

/** What the extractor hands back, matching what `indexDocumentChunks` takes. */
export type ExtractedDocument = {
    pages?: Array<{
        index: number;
        label?: string;
        markdown?: string;
        /** Structured pages carry items with sentence ids — what lets a chunk
         *  record the sentence range a search hit can be cited down to. */
        items?: Array<{ kind?: string; text?: string; sentences?: Array<{ id: string; text: string }> }>;
    }>;
};

/** One PDF attachment that could be indexed. */
export interface FulltextCandidate {
    libraryId: number;
    attachmentKey: string;
    parentKey: string | null;
    /** For progress messages; never used for lookup. */
    title?: string;
}

export interface FulltextIndexProgress {
    /** Documents finished so far, successful or not. */
    done: number;
    /** Documents this run set out to index. */
    total: number;
    /** The document being worked on, if one is in flight. */
    current?: string;
    failed: number;
    chunks: number;
}

export interface FulltextIndexRunResult {
    indexed: number;
    /** Documents that could not be indexed for a reason of their own. */
    failed: number;
    chunks: number;
    /** True when the run stopped early because it was asked to. */
    canceled: boolean;
    errors: Array<{ attachmentKey: string; message: string }>;
    /**
     * Set when the run stopped because the embedding provider failed: a key
     * rejected, a quota spent, a server down or out of reach, or real
     * documents failing one after another. No document is blamed: the one in
     * flight stays pending with the rest, and the next run picks up from it.
     * `setAside` lists (by `candidateKey`) the pending documents whose failure
     * could still have been their own; later runs try them last (see
     * `RunFulltextIndexOptions.setAsideBefore`). `resumeAt` is set when the
     * provider said when it will take requests again — a day's allowance
     * comes back at its reset — so the next run can be started then.
     */
    paused?: { attachmentKey: string; message: string; setAside: string[]; resumeAt?: number };
}

/** When a paused run can be tried again, if the failure says: a spent day comes back at its reset. */
export function indexingResumesAt(error: unknown, now: number = Date.now()): number | undefined {
    return isModelRequestError(error) && error.code === 'daily_quota' && error.retryAfterMs !== undefined
        ? now + error.retryAfterMs
        : undefined;
}

/** How candidates are told apart across runs: library and attachment key. */
export const candidateKey = (candidate: { libraryId: number; attachmentKey: string }): string =>
    `${candidate.libraryId}-${candidate.attachmentKey}`;

/**
 * Whose fault an embedding failure is, as far as one failure can tell.
 *
 * - `provider`: every document would fail the same way — a key rejected, a
 *   quota or balance spent, the model not offered, requests limited, no
 *   connection. The run pauses at once rather than extracting the rest of
 *   the library only to blame each paper in turn.
 * - `document`: the endpoint refused this document's content (400, 413, 422).
 *   The document fails and the run goes on.
 * - `unclear`: a server error, a timeout, an answer that is not embeddings.
 *   A server that is down answers every document this way, and so can one
 *   that chokes on this document alone; runFulltextIndex tells which (see
 *   there).
 */
export type EmbeddingFailureBlame = 'provider' | 'document' | 'unclear';

export function embeddingFailureBlame(error: unknown): EmbeddingFailureBlame {
    if (!isModelRequestError(error)) return 'unclear';
    if (isQuotaErrorCode(error.code)) return 'provider';
    if (error.kind === 'network') return 'provider';
    if (error.kind !== 'http' || error.status === undefined) return 'unclear';
    const status = error.status;
    if (status === 400 || status === 413 || status === 422) return 'document';
    if (status === 408 || status >= 500) return 'unclear';
    return 'provider';
}

/**
 * The sentence the settings show for a paused run: what went wrong with the
 * provider, and what happens next.
 */
export function describeIndexingPause(error: unknown, index: 'text' | 'figures' = 'text'): string {
    const details = indexingPauseDetails(error);
    return index === 'figures'
        ? t('Figure indexing paused: {details}', { details })
        : t('Indexing paused: {details}', { details });
}

/** What went wrong with the provider and what happens next, after the "… paused:" lead. */
function indexingPauseDetails(error: unknown): string {
    const resumes = t('It picks up where it stopped on the next pass.');
    if (!isModelRequestError(error)) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '');
        return joinSentences([t('{reason}.', { reason }), resumes]);
    }
    const who = error.label ? t('{label} embeddings', { label: error.label }) : t('The embedding provider');
    const status = error.status;
    if (error.code === 'daily_quota') {
        const at = error.retryAfterMs !== undefined ? new Date(Date.now() + error.retryAfterMs) : null;
        const time = at ? `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}` : null;
        return joinSentences([
            t('{who} has used today’s allowance.', { who }),
            error.detail ? error.detail.replace(/\s*$/, '') : null,
            time
                ? t('It continues by itself after midnight Pacific time ({time} here).', { time })
                : t('It continues by itself after midnight Pacific time.'),
        ]);
    }
    if (status === 401 || status === 403) {
        return t('{who} rejected the API key ({status}). Check the key under '
            + 'Settings → Model → Providers; indexing resumes once it works.', { who, status });
    }
    if (isQuotaErrorCode(error.code) || status === 402) {
        return joinSentences([t('{who} reports the quota or balance is used up.', { who }), resumes]);
    }
    if (status === 429) return joinSentences([t('{who} is limiting requests (429).', { who }), resumes]);
    if (status === 404) {
        return t("{who} does not offer the embedding model (404). Check the provider's "
            + 'address under Settings → Model → Providers.', { who });
    }
    if (error.kind === 'network') return joinSentences([t('{who} could not be reached.', { who }), resumes]);
    if (error.kind === 'timeout') return joinSentences([t('{who} did not answer in time.', { who }), resumes]);
    if (status !== undefined && status >= 500) {
        return joinSentences([t('{who} had a server error ({status}).', { who, status }), resumes]);
    }
    return joinSentences([t('{reason}.', { reason: error.message }), resumes]);
}

/** Two short texts: a request that costs next to nothing, and still a batch. */
const PROVIDER_CHECK_TEXTS = ['Checking that the embedding provider answers.', 'A second short text.'];

/**
 * Whether the provider embeds a short request of its own: null when it does,
 * else what went wrong. It settles an `unclear` failure. A provider that
 * answers the check works, so the document's own content was the trouble; one
 * that fails the check too is failing for every document.
 */
export async function providerCheckFailure(provider: EmbeddingProvider, signal?: AbortSignal): Promise<unknown | null> {
    try {
        const response = await provider.generateEmbeddings(
            PROVIDER_CHECK_TEXTS.map((text, index) => ({ item_id: index, text })),
            signal,
        );
        const count = response?.embeddings?.length ?? 0;
        return count === PROVIDER_CHECK_TEXTS.length
            ? null
            : new Error(`the embedding provider returned ${count} embeddings for ${PROVIDER_CHECK_TEXTS.length} texts`);
    } catch (error) {
        return error;
    }
}

export interface RunFulltextIndexOptions {
    store: ChunkStore & {
        getChunkedAttachmentKeys: (modelId: string) => Promise<Set<string>>;
        getAttachmentKeysLackingRanges?: (modelId: string) => Promise<Set<string>>;
    };
    /** Whether a document indexed without sentence ranges can now get them from the cache. */
    canUpgrade?: (candidate: FulltextCandidate) => Promise<boolean>;
    provider: EmbeddingProvider;
    modelId: string;
    /** Every PDF attachment in scope, indexed or not. */
    candidates: FulltextCandidate[];
    /**
     * The extracted document for one attachment, or null when it cannot be
     * read. Paged rather than flat: a chunk carries the page it came from, and
     * a citation without a page is a citation the reader cannot check.
     */
    extract: (candidate: FulltextCandidate) => Promise<ExtractedDocument | null>;
    onProgress?: (progress: FulltextIndexProgress) => void;
    signal?: AbortSignal;
    /** Re-index documents that already have chunks for this model. */
    force?: boolean;
    /** Stop after this many documents. Omitted means all of them. */
    limit?: number;
    /**
     * Documents (by `candidateKey`) an earlier run set aside: it paused on
     * them with failures that could have been their own. They are tried after
     * every other document, so two that fail every time cannot hold up the
     * rest of the library, and failing again once the provider has embedded
     * other documents in the run, they are charged with it.
     */
    setAsideBefore?: ReadonlySet<string>;
}

/**
 * The candidates that have no chunks yet for this model — plus, when the store
 * can tell, documents whose chunks carry no sentence ranges and whose cached
 * extraction now could (`canUpgrade`): those hits cite a page instead of a
 * sentence, and a re-index from the cache fixes that without a fresh
 * extraction.
 */
export async function pendingCandidates(
    store: {
        getChunkedAttachmentKeys: (modelId: string) => Promise<Set<string>>;
        getAttachmentKeysLackingRanges?: (modelId: string) => Promise<Set<string>>;
    },
    modelId: string,
    candidates: FulltextCandidate[],
    options: { canUpgrade?: (candidate: FulltextCandidate) => Promise<boolean> } = {},
): Promise<FulltextCandidate[]> {
    const already = await store.getChunkedAttachmentKeys(modelId);
    const lacking = options.canUpgrade && store.getAttachmentKeysLackingRanges
        ? await store.getAttachmentKeysLackingRanges(modelId)
        : new Set<string>();
    const out: FulltextCandidate[] = [];
    for (const c of candidates) {
        const key = `${c.libraryId}-${c.attachmentKey}`;
        if (!already.has(key)) {
            out.push(c);
        } else if (lacking.has(key) && options.canUpgrade && (await options.canUpgrade(c))) {
            out.push(c);
        }
    }
    return out;
}

/**
 * Index every candidate that needs it.
 *
 * One document at a time on purpose: extraction is the slow, memory-hungry step,
 * and running several in parallel is how a library-wide pass turns into an
 * unresponsive Zotero.
 *
 * A failure whose blame is unclear (see embeddingFailureBlame) is first put to
 * the provider as a short request of the run's own (providerCheckFailure).
 * Refused too, the provider is failing: the run pauses and blames no document.
 * Answered, the provider is up, but that does not yet say the document is at
 * fault — a provider can answer a few words and still fail every full-sized
 * request — so the document is held and the next one settles it. Indexed, it
 * shows real documents get through, and the one held is charged with its own
 * failure. Failing the same way, it shows they do not, and the run pauses
 * with both set aside. With nothing after it, the one held is charged.
 */
export async function runFulltextIndex(
    options: RunFulltextIndexOptions,
): Promise<FulltextIndexRunResult> {
    const { store, provider, modelId, candidates, extract, onProgress, signal, force, limit, canUpgrade } =
        options;
    const setAsideBefore = options.setAsideBefore ?? new Set<string>();

    const pending = force
        ? [...candidates]
        : await pendingCandidates(store, modelId, candidates, { canUpgrade });
    const queue = [
        ...pending.filter((c) => !setAsideBefore.has(candidateKey(c))),
        ...pending.filter((c) => setAsideBefore.has(candidateKey(c))),
    ];
    const work = typeof limit === 'number' ? queue.slice(0, limit) : queue;

    const result: FulltextIndexRunResult = {
        indexed: 0,
        failed: 0,
        chunks: 0,
        canceled: false,
        errors: [],
    };

    const report = (current?: string) =>
        onProgress?.({
            done: result.indexed + result.failed,
            total: work.length,
            failed: result.failed,
            chunks: result.chunks,
            ...(current ? { current } : {}),
        });

    report();

    const fail = (candidate: FulltextCandidate, error: unknown) => {
        result.failed += 1;
        result.errors.push({
            attachmentKey: candidate.attachmentKey,
            message: error instanceof Error ? error.message : String(error),
        });
    };

    // A document whose failure the provider's check did not explain, held
    // until the next document shows whether real documents fail too.
    let held: { candidate: FulltextCandidate; error: unknown } | null = null;
    // Whether the provider has embedded a document in this run.
    let providerWorked = false;
    /** Stop at the first document left pending, blaming none. */
    const pause = (at: FulltextCandidate, error: unknown, setAside: FulltextCandidate[]) => {
        const first = held?.candidate ?? at;
        const resumeAt = indexingResumesAt(error);
        result.paused = {
            attachmentKey: first.attachmentKey,
            message: describeIndexingPause(error),
            setAside: setAside.map(candidateKey),
            ...(resumeAt !== undefined ? { resumeAt } : {}),
        };
    };

    for (const candidate of work) {
        if (signal?.aborted) {
            result.canceled = true;
            break;
        }
        report(candidate.title || candidate.attachmentKey);

        let document: ExtractedDocument | null;
        try {
            document = await extract(candidate);
        } catch (error) {
            // Reading the PDF failed: that is this document's problem.
            fail(candidate, error);
            report();
            continue;
        }
        if (!document) {
            // Not an error worth a red count: plenty of attachments have no
            // readable text at all (scans without OCR, non-PDF payloads).
            // Counting them as failures would make a healthy library look
            // broken every time the user opened this panel.
            result.indexed += 1;
            continue;
        }

        try {
            const outcome: IndexDocumentResult = await indexDocumentChunks({
                store,
                provider,
                modelId,
                libraryId: candidate.libraryId,
                attachmentKey: candidate.attachmentKey,
                parentKey: candidate.parentKey,
                document,
            });
            result.indexed += 1;
            result.chunks += outcome.chunks ?? 0;
            if ((outcome.chunks ?? 0) > 0) {
                providerWorked = true;
                // Real documents get through: the one held failed for a reason of its own.
                if (held) fail(held.candidate, held.error);
                held = null;
            }
        } catch (error) {
            if (isModelRequestError(error) && error.kind === 'cancelled') {
                result.canceled = true;
                break;
            }
            const blame = embeddingFailureBlame(error);
            if (blame === 'document') {
                fail(candidate, error);
                report();
                continue;
            }
            // The one held may still have failed for a reason of its own.
            const heldAside = held ? [held.candidate] : [];
            if (blame === 'provider') {
                pause(candidate, error, heldAside);
                break;
            }
            const failing = await providerCheckFailure(provider, signal);
            if (signal?.aborted) {
                result.canceled = true;
                break;
            }
            if (failing) {
                pause(candidate, failing, heldAside);
                break;
            }
            if (providerWorked && setAsideBefore.has(candidateKey(candidate))) {
                // Set aside by an earlier run and failing again after other
                // documents were embedded: its own.
                fail(candidate, error);
            } else if (!held) {
                held = { candidate, error };
            } else {
                // A second document in a row failing like this: the provider
                // cannot take real documents now.
                pause(candidate, error, [...heldAside, candidate]);
                break;
            }
        }
        report();
    }

    // The last document tried, held with nothing after it to compare. The
    // provider answered its check, so the failure is the document's.
    if (held && !result.paused && !result.canceled) fail(held.candidate, held.error);

    report();
    return result;
}

/**
 * One sentence on how much of the library the index covers, or null when it
 * covers all of it.
 *
 * Attached to every full-text search result. Without it a thin result reads as
 * evidence the library has nothing on the subject, when the real answer may be
 * that most of the library has never been indexed — and that difference is the
 * whole value of the answer.
 */
export function coverageNote(indexed: number, total: number): string | null {
    if (total === 0 || indexed >= total) return null;
    return (
        `Only ${indexed} of ${total} PDFs in this library are indexed for full text, ` +
        `so this searched part of the library, not all of it. Say so when it matters ` +
        `to the answer — a paper missing here may still discuss the topic.`
    );
}
