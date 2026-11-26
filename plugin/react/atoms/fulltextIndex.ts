/**
 * Running the library-wide full-text pass from the UI.
 *
 * Unlike the metadata index, which runs by itself on a mounted hook, this one is
 * started by the user: it embeds every page of every PDF and costs real money
 * per document. So there is no hook and nothing to mount — a write atom starts
 * it, another stops it, and the state atom is what the settings panel renders.
 *
 * The Zotero-specific parts (finding the PDFs, extracting one) live here rather
 * than in the indexer, which stays a pure loop over injected callbacks.
 */

import { atom } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';

import {
    buildEmbeddingProviderFromPrefs,
    currentEmbeddingModelId,
    refreshSemanticSearchAvailability,
    resetSemanticSearchProbe,
    semanticSearchState,
    type SemanticSearchState,
} from '../../src/services/llm/agentConfig';
import {
    candidateKey,
    pendingCandidates,
    runFulltextIndex,
    type ExtractedDocument,
    type FulltextCandidate,
} from '../../src/services/llm/fulltextIndexer';
import { cachedTextAsDocument, readZoteroTextCache } from '../../src/services/llm/zoteroTextCache';
import { hasLocators } from '../../src/services/llm/sentenceLocators';
import { searchableLibraryIdsAtom } from './profile';
import { store } from '../store';
import { t } from '../../src/utils/i18n';

export interface FulltextIndexState {
    status: 'idle' | 'counting' | 'indexing' | 'error';
    /** Documents finished in the current run. */
    done: number;
    /** Documents the current run set out to do. */
    total: number;
    /** PDFs in the library that already have chunks, across all runs. */
    indexed: number;
    /**
     * PDFs in the library that indexing covers, indexed or not: all of them
     * but the `skipped` ones.
     */
    library: number;
    /**
     * PDFs left out for the rest of the session because they could not be
     * read (see failedThisSession). Retry failed brings them back.
     */
    skipped: number;
    /** Whether `indexed` and `library` have been counted for the model in use. */
    counted: boolean;
    failed: number;
    current?: string;
    error?: string;
    /**
     * Why the last run stopped early without blaming any document: the
     * embedding provider failed (a rejected key, no connection). Its
     * documents are still pending.
     */
    paused?: string;
    /** When the paused run can go on, if the provider said (a day's allowance resets). */
    pausedUntil?: number;
    /** The last run ended early on a Stop (or a switch of model); the sweep then starts no pictures. */
    stopped?: boolean;
    /**
     * Why documents failed, most recent run only. A bare count tells the user
     * something is wrong without telling them whether it matters — a scan with
     * no text layer and a damaged file look identical at "1 failed".
     */
    failures: Array<{ title: string; message: string }>;
}

const IDLE: FulltextIndexState = {
    status: 'idle',
    done: 0,
    total: 0,
    indexed: 0,
    library: 0,
    skipped: 0,
    counted: false,
    failed: 0,
    failures: [],
};

/**
 * What stands between the chosen embedding provider and a working index, in
 * one sentence, or null when nothing does. Each surface adds what that means
 * for it.
 */
export function embeddingProviderProblem(state: SemanticSearchState = semanticSearchState()): string | null {
    switch (state.status) {
        case 'ready':
            return null;
        case 'off':
            return t('No embedding provider is chosen.');
        case 'needs_key':
            return t('Embeddings are set to {provider}, but this computer has no {provider} API key.', { provider: state.label });
        case 'unreachable':
            return t('Embeddings are set to Ollama, but {reason}.', { reason: state.reason });
    }
}

export const fulltextIndexStateAtom = atom<FulltextIndexState>(IDLE);

/** Owned here rather than in the atom: an atom holds data, not a live handle. */
let controller: AbortController | null = null;

function setState(patch: Partial<FulltextIndexState>): void {
    store.set(fulltextIndexStateAtom, (prev: FulltextIndexState) => ({ ...prev, ...patch }));
}

/**
 * Whether the cached extraction of a document already knows where its
 * sentences sit — the condition for re-indexing a document whose passages
 * carry no sentence ranges. Cache only, never a fresh extraction: the sweep
 * asks this for every such document, and an extraction is a thirty-second job.
 */
/** Documents already re-indexed for sentence ranges this session — once is enough. */
const upgradeAttempted = new Set<string>();

/**
 * Documents that failed to index this session. A PDF that cannot be read
 * (no text layer, a damaged file) fails the same way every time; without
 * this, every sweep — startup and each library change — tried it again and
 * the user saw the plugin "scanning" a library that was fully indexed. It is
 * retried after a restart, when the file may have been fixed, or when the
 * user asks (Retry failed). A failure of the embedding provider never lands
 * here: the run pauses instead (see runFulltextIndex).
 */
const failedThisSession = new Set<string>();

/**
 * Documents a paused run set aside this session: its failures could have
 * been their own. Later runs try them after every other document, so two
 * that fail every time cannot keep the rest of the library from being indexed
 * (see RunFulltextIndexOptions.setAsideBefore). This only changes the order.
 */
const setAsideThisSession = new Set<string>();

async function cacheHasSentenceStructure(candidate: FulltextCandidate): Promise<boolean> {
    // At most one attempt per document per session: a document whose
    // re-index still yields no ranges must not be re-queued by every sweep.
    const key = `${candidate.libraryId}-${candidate.attachmentKey}`;
    if (upgradeAttempted.has(key)) return false;
    try {
        const cache = (Zotero as any).AlphainZ?.documentCache;
        if (!cache?.getResult) return false;
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(candidate.libraryId, candidate.attachmentKey);
        const filePath = attachment ? await (attachment as any).getFilePathAsync?.() : null;
        if (!filePath) return false;
        const result = await cache.getResult(
            { libraryId: candidate.libraryId, zoteroKey: candidate.attachmentKey },
            'structured',
            filePath,
        );
        const ok = !!result && result.mode === 'structured' && hasLocators(result.document);
        if (ok) upgradeAttempted.add(key);
        return ok;
    } catch {
        return false;
    }
}

/** Every PDF attachment in a searchable library, minus what failed this session. */
async function listCandidates(): Promise<FulltextCandidate[]> {
    return (await listAllCandidates()).filter((c) => !failedThisSession.has(candidateKey(c)));
}

/** The items in the trash, as Zotero records them: each one deleted by itself. */
async function trashedItemIds(): Promise<Set<number>> {
    const ids = new Set<number>();
    try {
        await Zotero.DB.queryAsync('SELECT itemID FROM deletedItems', [], {
            onRow: (row: any) => {
                ids.add(row.getResultByIndex(0));
            },
        });
    } catch {
        // Then only what the items themselves say.
    }
    return ids;
}

/**
 * Whether an item is in the trash, its own or by way of its parent: a paper is
 * trashed by trashing its parent, which leaves the PDF itself unmarked. Read
 * from the trash records first — the parent may not be loaded yet, as in a
 * group library nobody has opened this session.
 */
function inTrash(item: any, trashed: Set<number>): boolean {
    if (trashed.has(item.id) || (item.parentItemID && trashed.has(item.parentItemID))) return true;
    try {
        return item.isInTrash?.() ?? Boolean(item.deleted);
    } catch {
        return Boolean(item.deleted);
    }
}

/**
 * Every PDF attachment in a searchable library and not in the trash. Shared with
 * the page-image index and the searches, which keep to these documents.
 * `titles: false` skips loading the titles, for a caller that only counts.
 */
export async function listAllCandidates(options: { titles?: boolean } = {}): Promise<FulltextCandidate[]> {
    const withTitles = options.titles !== false;
    const libraryIds: number[] = store.get(searchableLibraryIdsAtom);
    const out: FulltextCandidate[] = [];
    const trashed = await trashedItemIds();
    for (const libraryId of libraryIds) {
        const items = await Zotero.Items.getAll(libraryId);
        const pdfs = items.filter((item: any) => item.isPDFAttachment?.() && !inTrash(item, trashed));
        // Titles are field data, which Zotero loads lazily — not yet, for a
        // group library, a moment after startup.
        if (withTitles) await Zotero.Items.loadDataTypes(pdfs, ['itemData']);
        for (const item of pdfs) {
            let title = item.key;
            try {
                if (withTitles) title = item.getDisplayTitle?.() || item.key;
            } catch {
                // Still not loaded: the key names it well enough for progress.
            }
            out.push({
                libraryId: item.libraryID,
                attachmentKey: item.key,
                parentKey: (item as any).parentKey || null,
                title,
            });
        }
    }
    return out;
}

/**
 * Refusals about access rather than the file. Zotero's text cache never stands
 * in for these: an excluded library's text must not reach the provider by way
 * of the fallback.
 */
const ACCESS_REFUSALS = new Set(['library_excluded', 'library_unavailable', 'not_found', 'invalid_format', 'not_attachment']);

/** Whether a document's library may be read now: exclusion can change while a run goes on. */
function searchableNow(candidate: FulltextCandidate): boolean {
    return store.get(searchableLibraryIdsAtom).includes(candidate.libraryId);
}

/** Extract one attachment through the same path the read_document tool uses. */
async function extractDocument(
    candidate: FulltextCandidate,
): Promise<ExtractedDocument | null> {
    // A library excluded after this run listed its documents is not read, and
    // one excluded while its document was being read is not sent.
    if (!searchableNow(candidate)) return null;
    const { createZoteroDataProvider } = await import('../../src/services/zoteroDataProvider');
    const { flattenProviderResponse } = await import('../../src/services/llm/zoteroToolDispatch');
    const entry = (createZoteroDataProvider() as any)['zotero_document_request'];

    const request = (mode: 'structured' | 'markdown') => entry.handle({
        event: 'zotero_document_request',
        request_id: `fulltext-${candidate.attachmentKey}`,
        attachment: {
            library_id: candidate.libraryId,
            zotero_key: candidate.attachmentKey,
        },
        mode,
        timeout_seconds: 120,
    });

    /*
     * Structured first: its sentence ids are what let a search hit be cited
     * down to the passage, and the cached structured payload it leaves behind
     * is what resolves that citation's boxes at click time. Markdown is the
     * fallback for documents the structured extractor cannot handle — their
     * hits keep today's page-level citations.
     */
    let raw: any = flattenProviderResponse(await request('structured'));
    if (raw?.error) {
        logger(
            `fulltext: structured extraction failed for ${candidate.attachmentKey} `
            + `(${String(raw.error).slice(0, 120)}); falling back to markdown`,
        );
        raw = flattenProviderResponse(await request('markdown'));
    }
    if (!raw?.error) return searchableNow(candidate) ? raw?.result?.document ?? null : null;
    if (ACCESS_REFUSALS.has(String(raw.error_code ?? ''))) throw new Error(String(raw.error));

    // The PDF is not on this machine — the usual cause is Zotero set to
    // download files as needed, which keeps the metadata and the extracted-text
    // cache but purges the file. Zotero already read that paper; the text is
    // sitting in its own cache. Indexing that keeps the paper findable, at the
    // cost of page numbers, instead of leaving it invisible for a reason that
    // has nothing to do with the paper.
    const item = Zotero.Items.getByLibraryAndKey(
        candidate.libraryId,
        candidate.attachmentKey,
    ) as Zotero.Item | false;
    if (item) {
        const cached = await readZoteroTextCache(item);
        if (cached) {
            logger(
                `fulltext: ${candidate.attachmentKey} has no local PDF; indexing Zotero's ` +
                    `cached text (${cached.text.length} chars, no page numbers)`,
            );
            return searchableNow(candidate) ? cachedTextAsDocument(cached) : null;
        }
    }

    throw new Error(String(raw.error));
}

/**
 * Refresh the coverage counts without indexing anything.
 *
 * With no usable embedding model there is no index to count: the counts are
 * marked unknown (`counted: false`) rather than zero, which would read as a
 * library with no PDFs in it.
 */
export const refreshFulltextCoverageAtom = atom(null, async (_get, set) => {
    const db = (Zotero as any).AlphainZ?.db;
    const modelId = currentEmbeddingModelId();
    if (!db?.getChunkedAttachmentKeys || !modelId) {
        set(fulltextIndexStateAtom, (prev) => ({ ...prev, indexed: 0, library: 0, skipped: 0, counted: false }));
        return;
    }
    try {
        const all = await listAllCandidates();
        const pending = await pendingCandidates(db, modelId, all, { canUpgrade: cacheHasSentenceStructure });
        // A document that failed earlier and has since been indexed (added
        // again, say) counts as indexed, not as skipped.
        const skipped = pending.filter((c) => failedThisSession.has(candidateKey(c))).length;
        set(fulltextIndexStateAtom, (prev) => ({
            ...prev,
            library: all.length - skipped,
            indexed: all.length - pending.length,
            skipped,
            counted: true,
        }));
    } catch (error) {
        logger(`refreshFulltextCoverage: ${error}`, 1);
    }
});

/**
 * Index the PDFs hanging off one item, right after it is added.
 *
 * A paper added through the agent was invisible to full-text search until the
 * user happened to open settings and run the indexer by hand — so the thing
 * they just asked for could not be searched, with nothing saying why.
 *
 * Scoped to the new item rather than calling the full sweep: that one indexes
 * everything outstanding, so adding one paper could kick off a hundred
 * embeddings the user did not ask for and pays for. Failures are swallowed —
 * the paper is in the library either way, and the sweep will pick it up later.
 */
export const indexItemAttachmentsAtom = atom(
    null,
    async (_get, set, ref: { libraryId: number; zoteroKey: string }) => {
        try {
            const db = (Zotero as any).AlphainZ?.db;
            const provider = buildEmbeddingProviderFromPrefs();
            const modelId = currentEmbeddingModelId();
            if (!db || !provider || !modelId) return;

            const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryId, ref.zoteroKey);
            if (!item) return;

            // The item is the parent; its PDFs are what carry text.
            const attachmentIds: number[] = (item as any).isPDFAttachment?.()
                ? []
                : ((item as any).getAttachments?.() ?? []);
            const attachments = (item as any).isPDFAttachment?.()
                ? [item]
                : (await Zotero.Items.getAsync(attachmentIds)).filter(
                    (a: any) => a?.isPDFAttachment?.() && !a.deleted,
                );
            if (!attachments.length) return;

            const candidates: FulltextCandidate[] = attachments.map((a: any) => ({
                libraryId: a.libraryID,
                attachmentKey: a.key,
                parentKey: a.parentKey || null,
                title: a.getDisplayTitle?.() || a.key,
            }));

            const result = await runFulltextIndex({
                store: db, provider, modelId, candidates, extract: extractDocument,
            });
            logger(
                `indexItemAttachments: ${ref.zoteroKey} — indexed ${result.indexed}, `
                + `${result.chunks} chunks, ${result.failed} failed`,
            );
            await set(refreshFulltextCoverageAtom);
        } catch (error) {
            logger(`indexItemAttachments: skipped (${error})`, 1);
        }
    },
);

/**
 * Index every PDF that has no chunks yet. Resumes; safe to run again.
 *
 * `retryFailed` gives the documents that failed earlier this session another
 * try, along with everything else still pending. `force` re-indexes every
 * document, indexed or not.
 */
export const startFulltextIndexAtom = atom(
    null,
    async (get, set, options?: { force?: boolean; retryFailed?: boolean; limit?: number }) => {
        if (get(fulltextIndexStateAtom).status === 'indexing') return;

        const db = (Zotero as any).AlphainZ?.db;
        const provider = buildEmbeddingProviderFromPrefs();
        const modelId = currentEmbeddingModelId();
        if (!db || !provider || !modelId) {
            const problem = embeddingProviderProblem();
            setState({
                status: 'error',
                error: problem
                    ? `${problem} ${t('The full text of your PDFs is indexed once that is fixed.')}`
                    : t('The index database is not open yet; try again in a moment.'),
            });
            return;
        }

        controller = new AbortController();
        setState({
            status: 'counting',
            done: 0,
            total: 0,
            failed: 0,
            failures: [],
            error: undefined,
            paused: undefined,
            pausedUntil: undefined,
            stopped: undefined,
        });

        try {
            if (options?.retryFailed) failedThisSession.clear();
            // A forced rebuild from the settings tries everything, failures included.
            const candidates = options?.force ? await listAllCandidates() : await listCandidates();
            setState({ status: 'indexing', library: candidates.length });

            const result = await runFulltextIndex({
                store: db,
                provider,
                modelId,
                candidates,
                extract: extractDocument,
                canUpgrade: cacheHasSentenceStructure,
                force: options?.force,
                ...(options?.limit != null ? { limit: options.limit } : {}),
                setAsideBefore: setAsideThisSession,
                signal: controller.signal,
                onProgress: (progress) => {
                    setState({
                        done: progress.done,
                        total: progress.total,
                        failed: progress.failed,
                        current: progress.current,
                    });
                    // A switch of embedding provider mid-run: this run keeps
                    // writing correct vectors under the model it started with,
                    // but every further document is work the new model's run
                    // will not see. Stop after the one in flight; the switch has
                    // already scheduled the run for the new model.
                    if (currentEmbeddingModelId() !== modelId) {
                        logger(`fulltext index: embedding model changed (${modelId} → ${currentEmbeddingModelId()}); stopping this run`);
                        controller?.abort();
                    }
                },
            });

            // A document that could not be read is left out of the sweeps for
            // the rest of the session (see failedThisSession). A forced rebuild
            // from the settings still tries everything. A paused run lists
            // nothing here: the provider failed, not the documents.
            for (const failure of result.errors) {
                const candidate = candidates.find((c) => c.attachmentKey === failure.attachmentKey);
                if (candidate) failedThisSession.add(candidateKey(candidate));
            }
            for (const key of result.paused?.setAside ?? []) setAsideThisSession.add(key);
            if (result.paused) {
                // Ask the provider again, so everything that reads the
                // availability sees the failure: an Ollama that stopped reads
                // as unreachable, and is looked at again until it answers,
                // which is what resumes this run.
                resetSemanticSearchProbe();
                await refreshSemanticSearchAvailability().catch(() => false);
            }
            // Recount from the database rather than from the run: it is the
            // number the panel keeps showing after the run is over, and a run
            // that was cancelled halfway must not leave it overstated.
            await set(refreshFulltextCoverageAtom);
            const byKey = new Map(candidates.map((c) => [c.attachmentKey, c.title || c.attachmentKey]));
            setState({
                status: 'idle',
                current: undefined,
                failed: result.failed,
                failures: result.errors.map((e) => ({
                    title: byKey.get(e.attachmentKey) ?? e.attachmentKey,
                    message: e.message,
                })),
                paused: result.paused?.message,
                pausedUntil: result.paused?.resumeAt,
                stopped: result.canceled || undefined,
            });
            logger(
                `fulltext index: ${result.indexed} indexed, ${result.failed} failed, ` +
                    `${result.chunks} chunks${result.canceled ? ' (stopped early)' : ''}`
                    + `${result.paused ? ` (paused: ${result.paused.message})` : ''}`,
            );
        } catch (error) {
            setState({
                status: 'error',
                current: undefined,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            controller = null;
        }
    },
);

/** Stop after the document in flight finishes. */
export const stopFulltextIndexAtom = atom(null, () => {
    controller?.abort();
});
