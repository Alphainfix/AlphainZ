/**
 * The page-image index: every page of every PDF as a picture, embedded by a
 * model that puts pictures and text queries in one space, so that a figure can
 * be found by describing it ("a rose diagram of dance directions").
 *
 * Whole pages, not cut-out figures. A figure drawn as vectors — most plots —
 * is not an image to the PDF, and cutting figures out reliably is a project of
 * its own. A page is also exactly what `view_page_images` opens, so the model
 * can look before it says anything about the figure; and the caption and the
 * labels on the page are part of the picture the model embeds.
 *
 * Pure apart from what is injected: the store, the provider, and a renderer
 * that turns a candidate into rendered pages.
 */

import { int8Cosine, quantizeToInt8, type EmbeddingProvider } from './embeddings';
import { describeIndexingPause, embeddingFailureBlame, indexingResumesAt, candidateKey, providerCheckFailure } from './fulltextIndexer';
import { isModelRequestError } from './sse';

/** Pages rendered past this are not indexed: a handbook is not a paper. */
export const MAX_PAGES_PER_DOCUMENT = 300;

/** Enough to read a figure's labels, small enough to send several to a request. */
export const PAGE_IMAGE_DPI = 96;

/** Pages rendered at a time: each is a few hundred KB until it is embedded. */
export const RENDER_WINDOW = 8;

export interface PageImageCandidate {
    libraryId: number;
    attachmentKey: string;
    parentKey: string | null;
    title?: string;
}

export interface RenderedPage {
    pageIndex: number;
    pageLabel?: string | null;
    mimeType: string;
    base64: string;
}

export interface PageImageStore {
    getPageImagedAttachmentKeys(modelId: string): Promise<Set<string>>;
    replacePageImages(
        libraryId: number,
        attachmentKey: string,
        parentKey: string | null,
        modelId: string,
        dimensions: number,
        pages: Array<{ pageIndex: number; pageLabel?: string | null; embedding: Uint8Array }>,
    ): Promise<void>;
    getPageImagesForSearch(modelId: string, libraryIds?: number[]): Promise<Array<{
        libraryId: number;
        attachmentKey: string;
        parentKey: string | null;
        pageIndex: number;
        pageLabel: string | null;
        embedding: Int8Array;
    }>>;
}

/**
 * Renders one document, handing its pages over a window at a time; resolves
 * with how many pages it rendered.
 */
export type PageRenderer = (
    candidate: PageImageCandidate,
    onPages: (pages: RenderedPage[]) => Promise<void>,
    signal?: AbortSignal,
) => Promise<number>;

export interface PageImageIndexRunResult {
    indexed: number;
    failed: number;
    pages: number;
    canceled: boolean;
    errors: Array<{ attachmentKey: string; message: string }>;
    /** The provider failed: nothing is blamed, and the run can resume (at `resumeAt`, if it said). */
    paused?: { attachmentKey: string; message: string; resumeAt?: number };
}

/** Documents without page images for this model, in the order given. */
export async function pendingPageImageCandidates(
    store: Pick<PageImageStore, 'getPageImagedAttachmentKeys'>,
    modelId: string,
    candidates: PageImageCandidate[],
): Promise<PageImageCandidate[]> {
    const done = await store.getPageImagedAttachmentKeys(modelId);
    return candidates.filter((c) => !done.has(candidateKey(c)));
}

/** Thrown from inside a document's render to drop it unstored and uncounted. */
const PASSED_OVER = Symbol('passed over');

/**
 * Render and embed every pending document's pages, one document at a time.
 *
 * A document's pages are stored together once all of them are embedded, so a
 * run stopped halfway leaves that document pending rather than half-indexed.
 * The provider failing pauses the run, as for the passages: a document is
 * charged only with a failure that is its own (it could not be read, or the
 * endpoint refused its pictures).
 */
export async function runPageImageIndex(options: {
    store: PageImageStore;
    provider: EmbeddingProvider;
    modelId: string;
    candidates: PageImageCandidate[];
    render: PageRenderer;
    onProgress?: (progress: { done: number; total: number; failed: number; pages: number; current?: string }) => void;
    signal?: AbortSignal;
    limit?: number;
    /**
     * Awaited before each document. The UI uses it to let the text index go
     * first: a passage run that starts while pages are being embedded has the
     * provider to itself from the next document on.
     */
    beforeDocument?: (signal?: AbortSignal) => Promise<void>;
    /**
     * Asked before each document whether it may still be indexed: a library
     * excluded while the run goes on is passed over from that moment.
     */
    admit?: (candidate: PageImageCandidate) => boolean;
}): Promise<PageImageIndexRunResult> {
    const { store, provider, modelId, render, onProgress, signal } = options;
    const pending = await pendingPageImageCandidates(store, modelId, options.candidates);
    const work = typeof options.limit === 'number' ? pending.slice(0, options.limit) : pending;
    const result: PageImageIndexRunResult = { indexed: 0, failed: 0, pages: 0, canceled: false, errors: [] };
    const report = (current?: string) =>
        onProgress?.({
            done: result.indexed + result.failed,
            total: work.length,
            failed: result.failed,
            pages: result.pages,
            ...(current ? { current } : {}),
        });
    report();

    for (const candidate of work) {
        if (signal?.aborted) {
            result.canceled = true;
            break;
        }
        if (options.beforeDocument) {
            try {
                await options.beforeDocument(signal);
            } catch {
                // Waiting is a courtesy; failing to wait is no reason to stop.
            }
            if (signal?.aborted) {
                result.canceled = true;
                break;
            }
        }
        if (options.admit && !options.admit(candidate)) continue;
        report(candidate.title || candidate.attachmentKey);
        const rows: Array<{ pageIndex: number; pageLabel?: string | null; embedding: Uint8Array }> = [];
        let dimensions = 0;
        // Set by the embedding step, so a failure is told apart from one in rendering.
        const embedding: { failure?: unknown } = {};
        try {
            await render(candidate, async (pages) => {
                if (pages.length === 0) return;
                // A long document is checked again before each batch goes out:
                // its library may have been excluded since it was started.
                if (options.admit && !options.admit(candidate)) throw PASSED_OVER;
                try {
                    const response = await provider.generateImageEmbeddings(
                        pages.map((page, i) => ({ item_id: i, mimeType: page.mimeType, base64: page.base64 })),
                        signal,
                    );
                    for (const vector of response.embeddings) {
                        const page = pages[vector.item_id];
                        if (!page) continue;
                        dimensions = vector.dimensions;
                        rows.push({
                            pageIndex: page.pageIndex,
                            pageLabel: page.pageLabel ?? null,
                            embedding: new Uint8Array(new Int8Array(vector.embedding).buffer),
                        });
                    }
                } catch (error) {
                    embedding.failure = error;
                    throw error;
                }
            }, signal);
        } catch (error) {
            if (error === PASSED_OVER) continue;
            if (signal?.aborted || (isModelRequestError(error) && error.kind === 'cancelled')) {
                result.canceled = true;
                break;
            }
            // The provider's fault pauses the run; the document's own fails only it.
            // A failure that could be either is put to the provider as a short
            // request of the run's own: answered, the document is to blame —
            // otherwise one PDF the provider always chokes on would hold up
            // every other one, run after run.
            let blame = 'failure' in embedding ? embeddingFailureBlame(embedding.failure) : 'document';
            if (blame === 'unclear') {
                const failing = await providerCheckFailure(provider, signal);
                if (signal?.aborted) {
                    result.canceled = true;
                    break;
                }
                if (failing === null) blame = 'document';
            }
            if (blame !== 'document') {
                const resumeAt = indexingResumesAt(embedding.failure);
                result.paused = {
                    attachmentKey: candidate.attachmentKey,
                    message: describeIndexingPause(embedding.failure, 'figures'),
                    ...(resumeAt !== undefined ? { resumeAt } : {}),
                };
                break;
            }
            result.failed += 1;
            result.errors.push({
                attachmentKey: candidate.attachmentKey,
                message: error instanceof Error ? error.message : String(error),
            });
            report();
            continue;
        }
        // A renderer told to stop may return between windows rather than
        // throw; what it rendered so far is not the whole document.
        if (signal?.aborted) {
            result.canceled = true;
            break;
        }
        // Nothing to store would leave the document pending for every run to
        // render again; it fails instead, like one that cannot be read.
        if (rows.length === 0) {
            result.failed += 1;
            result.errors.push({ attachmentKey: candidate.attachmentKey, message: 'the PDF has no pages to index' });
            report();
            continue;
        }
        if (options.admit && !options.admit(candidate)) continue;
        await store.replacePageImages(
            candidate.libraryId,
            candidate.attachmentKey,
            candidate.parentKey,
            modelId,
            dimensions,
            rows,
        );
        result.pages += rows.length;
        result.indexed += 1;
        report();
    }
    report();
    return result;
}

/**
 * What a figure search tells the model about the PDFs it could not look at, or
 * nothing when every PDF in the searched libraries has page images. Without it
 * a search over part of the library reads as proof the figure is not there.
 * Of the rest, `pending` are still to be indexed; the others could not be read
 * on this computer (most often, the file has not been downloaded).
 */
export function figureCoverageNote(indexed: number, total: number, pending: number): string | null {
    if (total === 0 || indexed >= total) return null;
    const unreadable = Math.max(0, total - indexed - pending);
    const parts = [`Only ${indexed} of ${total} PDFs in this library have page images, so this searched part of the library, not all of it.`];
    if (pending > 0) parts.push(`${pending} more ${pending === 1 ? 'has' : 'have'} no page images yet.`);
    if (unreadable > 0) {
        parts.push(`${unreadable} could not be read on this computer (the file is missing or damaged).`);
    }
    parts.push('Say so when it matters to the answer — a figure missing here may be in one of those PDFs.');
    return parts.join(' ');
}

export interface PageImageHit {
    libraryId: number;
    attachmentKey: string;
    parentKey: string | null;
    /** 1-based, as `view_page_images` and citations count. */
    page: number;
    pageLabel: string | null;
    similarity: number;
}

/**
 * The pages whose picture is closest to a description. At most `perDocument`
 * pages from one PDF — a paper with six panels of the same kind should not
 * crowd out every other paper — and `limit` in all; a page identical to one
 * already listed (a PDF attached twice) is left out.
 */
export async function searchPageImages(options: {
    store: Pick<PageImageStore, 'getPageImagesForSearch'>;
    provider: EmbeddingProvider;
    modelId: string;
    query: string;
    limit?: number;
    perDocument?: number;
    libraryIds?: number[];
    /** The documents that may be returned, as for passages: the PDFs in the library now. */
    attachments?: ReadonlySet<string>;
}): Promise<PageImageHit[]> {
    const limit = options.limit ?? 6;
    const perDocument = options.perDocument ?? 2;
    const [queryResult, pages] = await Promise.all([
        options.provider.generateQueryEmbedding(options.query),
        options.store.getPageImagesForSearch(options.modelId, options.libraryIds),
    ]);
    if (pages.length === 0) return [];
    const query = quantizeToInt8(queryResult.embedding);
    const scored = pages
        .filter((page) => page.embedding.length === query.length)
        .filter((page) => !options.attachments || options.attachments.has(`${page.libraryId}-${page.attachmentKey}`))
        .map((page) => ({ page, similarity: int8Cosine(query, page.embedding) }))
        .sort((a, b) => b.similarity - a.similarity);
    const perDoc = new Map<string, number>();
    const hits: PageImageHit[] = [];
    // The same PDF attached twice gives the same page twice, vector for
    // vector; one of them is enough.
    const kept: Int8Array[] = [];
    const sameVector = (a: Int8Array, b: Int8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
    for (const { page, similarity } of scored) {
        const key = `${page.libraryId}-${page.attachmentKey}`;
        const seen = perDoc.get(key) ?? 0;
        if (seen >= perDocument) continue;
        if (kept.some((vector) => sameVector(vector, page.embedding))) continue;
        perDoc.set(key, seen + 1);
        kept.push(page.embedding);
        hits.push({
            libraryId: page.libraryId,
            attachmentKey: page.attachmentKey,
            parentKey: page.parentKey,
            page: page.pageIndex + 1,
            pageLabel: page.pageLabel,
            similarity,
        });
        if (hits.length >= limit) break;
    }
    return hits;
}
