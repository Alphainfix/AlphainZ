/**
 * Running the page-image index — every PDF page as a picture — from the UI and
 * the sweeps.
 *
 * Built only for an embedding model that takes pictures (Gemini Embedding 2,
 * EmbeddingGemma 2). It runs after the passages, under the same rules: the
 * PDFs of the searchable libraries, one at a time, paused rather than blamed
 * when the provider fails, resumed where it stopped. The Zotero-specific parts
 * (finding a PDF, rendering it) live here; the indexer is a pure loop.
 */

import { atom } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';

import { buildEmbeddingProviderFromPrefs, currentEmbeddingModelId } from '../../src/services/llm/agentConfig';
import { getPref } from '../../src/utils/prefs';
import { candidateKey } from '../../src/services/llm/fulltextIndexer';
import {
    MAX_PAGES_PER_DOCUMENT,
    PAGE_IMAGE_DPI,
    RENDER_WINDOW,
    figureCoverageNote,
    runPageImageIndex,
    type PageImageCandidate,
    type PageImageIndexRunResult,
    type RenderedPage,
} from '../../src/services/llm/pageImageIndex';
import type { EmbeddingProvider } from '../../src/services/llm/embeddings';
import { uint8ToBase64 } from '../../src/services/agentDataProvider/imageProcessing';
import { isEmbeddingIndexingAtom } from './embeddingIndex';
import { fulltextIndexStateAtom, listAllCandidates } from './fulltextIndex';
import { fulltextSweepDueAtom } from './indexSchedule';
import { searchableLibraryIdsAtom } from './profile';
import { store } from '../store';

export interface PageImageIndexState {
    status: 'idle' | 'indexing' | 'error';
    done: number;
    total: number;
    /** PDFs with page images for the model in use. */
    indexed: number;
    /** PDFs in the searchable libraries. */
    library: number;
    /** Page images stored for the model in use. */
    pages: number;
    counted: boolean;
    failed: number;
    /**
     * PDFs without page images that could not be rendered this session. They
     * are left out until a retry or a restart of Zotero.
     */
    skipped: number;
    /** Why each of the `skipped` PDFs could not be rendered. */
    failures: Array<{ title: string; message: string }>;
    current?: string;
    error?: string;
    /** Why the last run stopped early: the provider failed. Its documents are still pending. */
    paused?: string;
    /** When the paused run can go on, if the provider said (a day's allowance resets). */
    pausedUntil?: number;
    /**
     * Stopped from Settings this session. Runs started by themselves — a sweep,
     * a resume, a switch of model — wait for the next Index from the user.
     */
    stopped?: boolean;
}

const IDLE: PageImageIndexState = {
    status: 'idle',
    done: 0,
    total: 0,
    indexed: 0,
    library: 0,
    pages: 0,
    counted: false,
    failed: 0,
    skipped: 0,
    failures: [],
};

export const pageImageIndexStateAtom = atom<PageImageIndexState>(IDLE);

let controller: AbortController | null = null;

/** Set by Stop for the run going; a run that ends on a model switch then starts no other. */
let stopRequested = false;

/** Documents that could not be rendered this session, and why; retried after a restart. */
const failedThisSession = new Map<string, { title: string; message: string }>();

/** Test seam: forget the documents that could not be rendered this session. */
export function resetPageImageFailures(): void {
    failedThisSession.clear();
}

/**
 * Passes in one start: one more after each that found work, for PDFs added
 * meanwhile. Every pass that goes on settles at least one PDF, so this is only
 * a guard; PDFs added during the last pass get a sweep of their own.
 */
const MAX_PASSES = 20;

/** The longest a run waits for the text index at one document before going on anyway. */
const TEXT_FIRST_MAX_WAIT_MS = 20 * 60 * 1000;

/** Shown as the run's current document while it waits. */
export const WAITING_FOR_TEXT = 'Waiting for the text index';

function setState(patch: Partial<PageImageIndexState>): void {
    store.set(pageImageIndexStateAtom, (prev: PageImageIndexState) => ({ ...prev, ...patch }));
}

/**
 * Whether titles and abstracts, or passages, are being indexed right now — or
 * a full-text sweep is due, as in the seconds after a paper is added and before
 * its passage run starts.
 */
function textIndexBusy(): boolean {
    const passages = store.get(fulltextIndexStateAtom).status;
    return passages === 'counting'
        || passages === 'indexing'
        || store.get(isEmbeddingIndexingAtom)
        || store.get(fulltextSweepDueAtom);
}

/**
 * Wait while the text index is being built, so a paper added during a long
 * picture run is searchable by its words first. Gives up waiting after a while
 * rather than stall behind a text run that never reports an end; `stopWaiting`
 * is asked again whenever the text index reports, and ends the wait early.
 */
async function letTextGoFirst(signal?: AbortSignal, stopWaiting?: () => boolean): Promise<void> {
    if (signal?.aborted || stopWaiting?.() || !textIndexBusy()) return;
    setState({ current: WAITING_FOR_TEXT });
    await new Promise<void>((resolve) => {
        const stops: Array<() => void> = [];
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            for (const stop of stops) stop();
            resolve();
        };
        const check = () => {
            if (!textIndexBusy() || stopWaiting?.()) finish();
        };
        stops.push(store.sub(fulltextIndexStateAtom, check));
        stops.push(store.sub(isEmbeddingIndexingAtom, check));
        stops.push(store.sub(fulltextSweepDueAtom, check));
        const timer = setTimeout(finish, TEXT_FIRST_MAX_WAIT_MS);
        stops.push(() => clearTimeout(timer));
        if (signal) {
            signal.addEventListener('abort', finish, { once: true });
            stops.push(() => signal.removeEventListener('abort', finish));
        }
        // It may have ended between the first look and the subscriptions.
        check();
    });
}

/**
 * The coverage note for a figure search with this model, or null when every
 * PDF has its pages. Counts the searchable libraries only; a PDF that could not
 * be rendered this session counts as unreadable rather than still to come.
 */
export async function figureCoverageNoteFor(
    modelId: string,
    listed?: PageImageCandidate[],
): Promise<string | null> {
    const db = (Zotero as any).AlphainZ?.db;
    if (!db?.getPageImagedAttachmentKeys) return null;
    try {
        const [done, candidates] = await Promise.all([
            db.getPageImagedAttachmentKeys(modelId) as Promise<Set<string>>,
            listed ?? listAllCandidates({ titles: false }),
        ]);
        let indexed = 0;
        let pending = 0;
        for (const candidate of candidates) {
            const key = candidateKey(candidate);
            if (done.has(key)) indexed += 1;
            else if (!failedThisSession.has(key)) pending += 1;
        }
        return figureCoverageNote(indexed, candidates.length, pending);
    } catch (error) {
        logger(`page images: could not count coverage for a search: ${error}`, 2);
        return null;
    }
}

/** The provider for the model in use, when it embeds pictures. */
export function pageImageProvider(): EmbeddingProvider | null {
    const provider = buildEmbeddingProviderFromPrefs();
    return provider?.embedsImages ? provider : null;
}

/**
 * Why an attachment's PDF is not on this computer, and what brings it back.
 * The text index can fall back on Zotero's synced text for such a PDF; its
 * pages cannot be rendered without the file.
 */
export function missingFileReason(attachment: any): string {
    const linkedFile = (Zotero as any).Attachments?.LINK_MODE_LINKED_FILE ?? 2;
    if (attachment.attachmentLinkMode === linkedFile) {
        return 'The linked PDF is not at its path on this computer. Relink it in Zotero, then retry.';
    }
    // Zotero keeps the hash of a file it has synced; without one there is no
    // copy online to download.
    if (!attachment.attachmentSyncedHash) {
        return 'The PDF file is not on this computer, and Zotero never uploaded it, so it cannot be downloaded '
            + 'either. Attach the PDF to the item again (for example, move the empty attachment to the trash, '
            + 'then use Find Available PDF on the item), then retry.';
    }
    let syncsFiles = true;
    try {
        syncsFiles = (Zotero as any).Sync.Storage.Local.getEnabledForLibrary(attachment.libraryID) !== false;
    } catch {
        /* unknown: assume Zotero can download it */
    }
    return syncsFiles
        ? 'The PDF is not downloaded to this computer yet. Open it once in Zotero to download it, then retry.'
        : 'The PDF file is not on this computer, and file syncing is off for this library in Zotero\'s Sync '
            + 'settings. Turn it on or attach the PDF again, then retry.';
}

/**
 * The title of the paper a PDF belongs to, which names it better than the
 * PDF's own title ("Full Text PDF"); the PDF's own for one standing alone.
 */
async function paperTitle(candidate: PageImageCandidate): Promise<string> {
    const fallback = candidate.title || candidate.attachmentKey;
    if (!candidate.parentKey) return fallback;
    try {
        const parent = await Zotero.Items.getByLibraryAndKeyAsync(candidate.libraryId, candidate.parentKey);
        if (!parent) return fallback;
        await Zotero.Items.loadDataTypes([parent], ['itemData']);
        return (parent as any).getDisplayTitle?.() || fallback;
    } catch {
        return fallback;
    }
}

/** Render a PDF's pages, a window at a time, as the index wants them. */
export async function renderCandidate(
    candidate: PageImageCandidate,
    onPages: (pages: RenderedPage[]) => Promise<void>,
    signal?: AbortSignal,
): Promise<number> {
    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(candidate.libraryId, candidate.attachmentKey);
    if (!attachment) throw new Error('The attachment is no longer in Zotero.');
    const filePath = await (attachment as any).getFilePathAsync?.();
    if (!filePath) throw new Error(missingFileReason(attachment));
    const bytes: Uint8Array = await IOUtils.read(filePath);
    const { BeaverExtractor } = await import('../../src/beaver-extract');
    const extractor = new BeaverExtractor();
    const pageCount = Math.min(await extractor.getPageCount(bytes, signal), MAX_PAGES_PER_DOCUMENT);
    for (let start = 0; start < pageCount; start += RENDER_WINDOW) {
        if (signal?.aborted) break;
        const pageIndices = Array.from({ length: Math.min(RENDER_WINDOW, pageCount - start) }, (_, i) => start + i);
        const result = await extractor.renderPages(
            bytes,
            { pageIndices, options: { dpi: PAGE_IMAGE_DPI, format: 'jpeg', jpegQuality: 80 } },
            signal,
        );
        await onPages(result.pages.map((page) => ({
            pageIndex: page.pageIndex,
            pageLabel: result.pageLabels?.[page.pageIndex] ?? null,
            mimeType: 'image/jpeg',
            base64: uint8ToBase64(page.data),
        })));
    }
    return pageCount;
}

/** Recount coverage for the model in use. */
export const refreshPageImageCoverageAtom = atom(null, async () => {
    const db = (Zotero as any).AlphainZ?.db;
    const modelId = currentEmbeddingModelId();
    if (!db?.getPageImagedAttachmentKeys || !modelId || !pageImageProvider()) {
        setState({ counted: false, indexed: 0, library: 0, pages: 0, skipped: 0, failures: [] });
        return;
    }
    try {
        const [done, candidates, models] = await Promise.all([
            db.getPageImagedAttachmentKeys(modelId) as Promise<Set<string>>,
            listAllCandidates(),
            db.listEmbeddingModels(),
        ]);
        let indexed = 0;
        const failures: PageImageIndexState['failures'] = [];
        for (const candidate of candidates as PageImageCandidate[]) {
            const key = candidateKey(candidate);
            // A PDF that failed earlier and has pages since counts as indexed.
            if (done.has(key)) indexed += 1;
            else if (failedThisSession.has(key)) failures.push(failedThisSession.get(key)!);
        }
        const pages = (models as Array<{ model_id: string; images: number }>).find((m) => m.model_id === modelId)?.images ?? 0;
        setState({ counted: true, indexed, library: candidates.length, pages, skipped: failures.length, failures });
    } catch (error) {
        logger(`page images: could not count coverage: ${error}`, 1);
    }
});

/**
 * Render and embed every PDF that has no page images for the model in use.
 * Resumes; safe to run again. Does nothing for a model that takes no pictures.
 *
 * The text index goes first: before each document the run waits while titles,
 * abstracts or passages are being indexed. A pass that found work is followed
 * by another, which picks up PDFs added while it ran and ends at once when
 * there are none. A switch to another embedding model ends the run at the next
 * document — those pictures are another index — and, when figures are indexed
 * automatically, starts one for the model now in use.
 */
export const startPageImageIndexAtom = atom(
    null,
    async (get, set, options?: { retryFailed?: boolean; limit?: number; automatic?: boolean }) => {
        if (get(pageImageIndexStateAtom).status === 'indexing') return;
        // A Stop holds for the session against runs nobody asked for.
        if (options?.automatic && get(pageImageIndexStateAtom).stopped) return;
        const db = (Zotero as any).AlphainZ?.db;
        const provider = pageImageProvider();
        const modelId = currentEmbeddingModelId();
        if (!db || !provider || !modelId) return;

        const runController = new AbortController();
        controller = runController;
        stopRequested = false;
        const signal = runController.signal;
        let switched = false;
        const modelChanged = () => currentEmbeddingModelId() !== modelId;
        // A switch noticed here ends the run; a Stop from the user is not a
        // switch, and starts nothing afterwards.
        const noteSwitch = () => {
            if (signal.aborted || !modelChanged()) return;
            switched = true;
            runController.abort();
        };
        const beforeDocument = async (waitSignal?: AbortSignal) => {
            noteSwitch();
            await letTextGoFirst(waitSignal, modelChanged);
            noteSwitch();
        };
        setState({
            status: 'indexing', done: 0, total: 0, failed: 0, error: undefined, paused: undefined, pausedUntil: undefined,
            ...(options?.automatic ? {} : { stopped: undefined }),
        });
        try {
            if (options?.retryFailed) failedThisSession.clear();
            const totals = { indexed: 0, failed: 0, pages: 0 };
            let result: PageImageIndexRunResult | null = null;
            for (let pass = 0; pass < MAX_PASSES; pass++) {
                const candidates = (await listAllCandidates()).filter((c) => !failedThisSession.has(candidateKey(c)));
                result = await runPageImageIndex({
                    store: db,
                    provider,
                    modelId,
                    candidates,
                    render: renderCandidate,
                    ...(options?.limit != null ? { limit: options.limit } : {}),
                    signal,
                    beforeDocument,
                    admit: (candidate) => store.get(searchableLibraryIdsAtom).includes(candidate.libraryId),
                    onProgress: (progress) => setState({
                        done: progress.done,
                        total: progress.total,
                        failed: totals.failed + progress.failed,
                        current: progress.current,
                    }),
                });
                for (const failure of result.errors) {
                    const candidate = candidates.find((c) => c.attachmentKey === failure.attachmentKey);
                    if (candidate) {
                        failedThisSession.set(candidateKey(candidate), {
                            title: await paperTitle(candidate),
                            message: failure.message,
                        });
                    }
                }
                totals.indexed += result.indexed;
                totals.failed += result.failed;
                totals.pages += result.pages;
                if (options?.limit != null || result.canceled || result.paused || result.indexed + result.failed === 0) break;
            }
            // A switch during the last document is not seen before another one.
            noteSwitch();
            await set(refreshPageImageCoverageAtom);
            setState({
                status: 'idle',
                current: undefined,
                failed: totals.failed,
                paused: result?.paused?.message,
                pausedUntil: result?.paused?.resumeAt,
            });
            logger(
                `page images: ${totals.indexed} indexed (${totals.pages} pages), ${totals.failed} failed`
                    + `${result?.canceled ? ' (stopped early)' : ''}${result?.paused ? ` (paused: ${result.paused.message})` : ''}`
                    + `${switched ? ` (embedding model changed from ${modelId})` : ''}`,
            );
            const automatic = getPref('fulltextIndexAuto') !== false && getPref('pageImageIndexAuto') !== false;
            if (switched && automatic && !stopRequested && pageImageProvider()) {
                // Through the store: `set` on the atom being written would only
                // assign its value, not run it again.
                void store.set(startPageImageIndexAtom, { automatic: true });
            }
        } catch (error) {
            setState({ status: 'error', current: undefined, error: error instanceof Error ? error.message : String(error) });
        } finally {
            // The run started for a new model may already hold the slot.
            if (controller === runController) controller = null;
        }
    },
);

/** Stop after the document in flight. */
export const stopPageImageIndexAtom = atom(null, () => {
    if (!controller) return;
    stopRequested = true;
    setState({ stopped: true });
    controller.abort();
});
