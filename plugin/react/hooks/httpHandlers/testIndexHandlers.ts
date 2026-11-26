/**
 * Dev-only control over the embedding index.
 *
 * Rebuilding is a button in the preferences window, which cannot be clicked over
 * HTTP — so without this the only way to check that indexing works at all is to
 * ask the user to press it and report back.
 */

import { forceReindexAtom, embeddingIndexStateAtom } from '../../atoms/embeddingIndex';
import { store } from '../../store';
import { BeaverDB } from '../../../src/services/database';
import {
    buildEmbeddingProviderFromPrefs,
    currentEmbeddingModelId,
    refreshSemanticSearchAvailability,
} from '../../../src/services/llm/agentConfig';
import { semanticSearchService } from '../../../src/services/semanticSearchService';
import { searchChunks } from '@beaver/agent-llm/fulltextIndex';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { buildEmbeddingProviderForPreset } from '../../../src/services/llm/agentConfig';
import { EMBEDDING_PRESETS, type EmbeddingPresetId } from '@beaver/agent-llm/embeddings';
import { runPageImageIndex, searchPageImages, type PageImageIndexRunResult } from '../../../src/services/llm/pageImageIndex';
import {
    pageImageIndexStateAtom,
    refreshPageImageCoverageAtom,
    renderCandidate,
    startPageImageIndexAtom,
} from '../../atoms/pageImageIndex';
import { listAllCandidates } from '../../atoms/fulltextIndex';

/** Kick off a rebuild and report where it got to. */
export async function handleTestReindexHttpRequest(request: any): Promise<any> {
    const waitMs = Number(request?.wait_ms ?? 0);

    store.set(forceReindexAtom);

    if (waitMs > 0) {
        const deadline = Date.now() + waitMs;
        // Poll rather than await: the indexer reports through the store, and a
        // caller wants the snapshot at the moment it stopped waiting.
        while (Date.now() < deadline) {
            const state = store.get(embeddingIndexStateAtom);
            if (state.phase === 'idle' && state.progress === 0 && state.totalItems === 0) {
                // Not started yet; keep waiting.
            } else if (state.phase === 'idle') {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }

    return { ok: true, state: store.get(embeddingIndexStateAtom) };
}

/** The index's current state, without touching it. */
export async function handleTestIndexStateHttpRequest(): Promise<any> {
    return { ok: true, state: store.get(embeddingIndexStateAtom) };
}

/**
 * Which embedding models have an index in this database, and how much each
 * holds. `deleteModelId` drops one model's index — the same operation as the
 * settings button. `seedModelId` plants a single throw-away vector under that
 * model so deletion can be exercised without touching a real index.
 */
export async function handleTestIndexModelsHttpRequest(request: any): Promise<any> {
    const db = (Zotero as any).AlphainZ?.db as BeaverDB | undefined;
    if (!db) return { ok: false, error: 'database not available' };
    if (typeof request?.seedModelId === 'string' && request.seedModelId) {
        await db.upsertEmbedding({
            item_id: 999999901,
            library_id: 1,
            zotero_key: 'ZZTESTSEED',
            version: 1,
            client_date_modified: new Date().toISOString(),
            content_hash: 'seed',
            embedding: BeaverDB.embeddingToBlob(new Int8Array(8)),
            dimensions: 8,
            model_id: request.seedModelId,
        });
    }
    let deleted: { items: number; chunks: number } | null = null;
    if (typeof request?.deleteModelId === 'string' && request.deleteModelId) {
        deleted = await db.deleteEmbeddingsForModel(request.deleteModelId);
    }
    return { ok: true, active: currentEmbeddingModelId(), models: await db.listEmbeddingModels(), deleted };
}

/**
 * Build the full-text passage index.
 *
 * Explicit rather than automatic: embedding every page of every paper costs real
 * money and real minutes, and an index that starts building itself spends both
 * without being asked. `limit` bounds a run so it can be tried on a handful of
 * documents before committing to the library.
 */
/**
 * Run the library-wide full-text pass, the same one the settings button runs.
 *
 * Drives the real atoms rather than keeping a second copy of the loop: a test
 * path that walks its own version of the code proves nothing about the one the
 * user runs. `limit` keeps a smoke test from indexing the whole library.
 */
export async function handleTestIndexFulltextHttpRequest(request: any): Promise<any> {
    const { startFulltextIndexAtom, fulltextIndexStateAtom } = await import(
        '../../atoms/fulltextIndex'
    );
    const db = (Zotero as any).AlphainZ?.db;
    if (!db) return { ok: false, error: 'no database' };

    await store.set(startFulltextIndexAtom, {
        force: request?.force === true,
        ...(request?.limit != null ? { limit: Number(request.limit) } : {}),
    });

    const state = store.get(fulltextIndexStateAtom);
    return {
        ok: state.status !== 'error',
        state,
        stats: await db.getChunkStats(),
    };
}

/**
 * How much full text is indexed, and the exact sentence a search hands the
 * model about it.
 *
 * The sentence is reported here because the persisted run stores a minimised
 * tool return, so there is no way to read back what the model was actually told.
 */
export async function handleTestFulltextStatsHttpRequest(): Promise<any> {
    const db = (Zotero as any).AlphainZ?.db;
    if (!db?.getChunkStats) return { ok: false, error: 'no database' };

    const { currentEmbeddingModelId } = await import('../../../src/services/llm/agentConfig');
    const { coverageNote } = await import('@beaver/agent-llm/fulltextIndexer');
    const modelId = currentEmbeddingModelId();

    // Counted as the search tool counts: chunked documents among the PDFs in
    // the searchable libraries now.
    let indexed = 0;
    let pdfs = 0;
    if (modelId) {
        const [keys, candidates] = await Promise.all([
            db.getChunkedAttachmentKeys(modelId) as Promise<Set<string>>,
            listAllCandidates({ titles: false }),
        ]);
        pdfs = candidates.length;
        indexed = candidates.filter((c) => keys.has(`${c.libraryId}-${c.attachmentKey}`)).length;
    }

    return {
        ok: true,
        stats: await db.getChunkStats(),
        indexed_pdfs: indexed,
        library_pdfs: pdfs,
        coverage_note: modelId ? coverageNote(indexed, pdfs) : null,
    };
}

/**
 * Run the two retrieval paths the agent's search tools use — item vectors
 * (title + abstract) or indexed passages — for one query, against the model
 * currently selected, with no language model in the loop. This is how the
 * accuracy of two embedding models can be compared on the same library.
 */
export async function handleTestSemanticSearchHttpRequest(request: any): Promise<any> {
    const db = (Zotero as any).AlphainZ?.db as BeaverDB | undefined;
    if (!db) return { ok: false, error: 'database not available' };
    const query = String(request?.query ?? '').trim();
    if (!query) return { ok: false, error: 'query is required' };
    const mode = request?.mode === 'passages' ? 'passages' : 'items';
    const topK = Math.max(1, Math.min(50, Number(request?.topK ?? 10)));
    if (!(await refreshSemanticSearchAvailability())) return { ok: false, error: 'semantic search is not available' };
    const modelId = currentEmbeddingModelId();
    const titleOf = async (libraryId: number, key: string | null): Promise<string> => {
        if (!key) return '';
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, key);
        if (!item) return '';
        await (item as any).loadDataType?.('itemData');
        return String((item as any).getField?.('title') ?? '');
    };
    // Kept to the searchable libraries, as the agent's tools are.
    const libraryIds: number[] = store.get(searchableLibraryIdsAtom);
    if (mode === 'items') {
        const results = await new semanticSearchService(db).search(query, { topK, minSimilarity: 0, libraryIds });
        const out = [];
        for (const r of results) {
            out.push({ item_id: r.itemId, key: r.zoteroKey, similarity: Number(r.similarity.toFixed(4)), title: await titleOf(r.libraryId, r.zoteroKey) });
        }
        return { ok: true, mode, model: modelId, results: out };
    }
    const provider = buildEmbeddingProviderFromPrefs();
    if (!provider || !modelId) return { ok: false, error: 'no embedding provider' };
    const candidates = await listAllCandidates({ titles: false });
    const hits = await searchChunks({
        store: db,
        provider,
        modelId,
        query,
        limit: topK,
        minSimilarity: 0,
        perDocument: 1,
        libraryIds,
        attachments: new Set(candidates.map((c) => `${c.libraryId}-${c.attachmentKey}`)),
    });
    const out = [];
    for (const hit of hits) {
        out.push({
            attachment_key: hit.attachmentKey,
            parent_key: hit.parentKey,
            page: hit.page,
            similarity: Number(hit.similarity.toFixed(4)),
            title: await titleOf(hit.libraryId, hit.parentKey ?? hit.attachmentKey),
            snippet: hit.text.slice(0, 140),
        });
    }
    return { ok: true, mode, model: modelId, results: out };
}


/**
 * A page-image run for one preset, started in the background — a library takes
 * minutes, longer than a request should hang. The preset is named in the
 * request, not read from the settings: switching the preference to build
 * another model's index would carry the switch to the user's other computers.
 */
interface PageImageRun {
    preset: string;
    startedAt: number;
    progress: { done: number; total: number; failed: number; pages: number; current?: string };
    result?: PageImageIndexRunResult;
    error?: string;
    controller: AbortController;
}

/** One run per preset at most; two presets may run side by side. */
const pageImageRuns = new Map<string, PageImageRun>();

function imagePreset(request: any): EmbeddingPresetId | null {
    const id = String(request?.provider ?? '').trim();
    if (!(id in EMBEDDING_PRESETS)) return null;
    return (EMBEDDING_PRESETS as Record<string, { imageWire?: string }>)[id].imageWire ? (id as EmbeddingPresetId) : null;
}

export async function handleTestIndexPageImagesHttpRequest(request: any): Promise<any> {
    const db = (Zotero as any).AlphainZ?.db as BeaverDB | undefined;
    if (!db) return { ok: false, error: 'database not available' };
    if (request?.stop === true) {
        for (const run of pageImageRuns.values()) run.controller.abort();
        return { ok: true, stopped: pageImageRuns.size };
    }
    const preset = imagePreset(request);
    if (!preset) return { ok: false, error: 'provider must be a preset that embeds images (google, ollama)' };
    const running = pageImageRuns.get(preset);
    if (running && !running.result && !running.error) {
        return { ok: false, error: `a run for ${preset} is in progress`, progress: running.progress };
    }
    const provider = buildEmbeddingProviderForPreset(preset);
    const modelId = EMBEDDING_PRESETS[preset].model;
    const controller = new AbortController();
    const run: PageImageRun = {
        preset,
        startedAt: Date.now(),
        progress: { done: 0, total: 0, failed: 0, pages: 0 },
        controller,
    };
    pageImageRuns.set(preset, run);
    const limit = Number(request?.limit);
    void (async () => {
        try {
            run.result = await runPageImageIndex({
                store: db as any,
                provider,
                modelId,
                candidates: await listAllCandidates(),
                render: renderCandidate,
                admit: (candidate) => store.get(searchableLibraryIdsAtom).includes(candidate.libraryId),
                signal: controller.signal,
                ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
                onProgress: (progress) => { run.progress = progress; },
            });
        } catch (error) {
            run.error = error instanceof Error ? error.message : String(error);
        }
    })();
    return { ok: true, started: preset, model: modelId };
}

export async function handleTestPageImageStatusHttpRequest(): Promise<any> {
    const runs = [...pageImageRuns.values()].map(({ preset, startedAt, progress, result, error }) => ({
        preset,
        running: !result && !error,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        progress,
        ...(result ? { result: { ...result, errors: result.errors.slice(0, 20) } } : {}),
        ...(error ? { error } : {}),
    }));
    return { ok: true, running: runs.some((run) => run.running), runs };
}

/** Figure search against one preset's page images, as the agent's tool runs it. */
export async function handleTestFigureSearchHttpRequest(request: any): Promise<any> {
    const db = (Zotero as any).AlphainZ?.db as BeaverDB | undefined;
    if (!db) return { ok: false, error: 'database not available' };
    const preset = imagePreset(request);
    if (!preset) return { ok: false, error: 'provider must be a preset that embeds images (google, ollama)' };
    const query = String(request?.query ?? '').trim();
    if (!query) return { ok: false, error: 'query is required' };
    const candidates = await listAllCandidates({ titles: false });
    const hits = await searchPageImages({
        store: db as any,
        provider: buildEmbeddingProviderForPreset(preset),
        modelId: EMBEDDING_PRESETS[preset].model,
        query,
        limit: Math.max(1, Math.min(30, Number(request?.topK ?? 8))),
        perDocument: Math.max(1, Number(request?.perDocument ?? 2)),
        libraryIds: store.get(searchableLibraryIdsAtom),
        attachments: new Set(candidates.map((c) => `${c.libraryId}-${c.attachmentKey}`)),
    });
    const out = [];
    for (const hit of hits) {
        const parent = hit.parentKey ? await Zotero.Items.getByLibraryAndKeyAsync(hit.libraryId, hit.parentKey) : null;
        if (parent) await (parent as any).loadDataType?.('itemData');
        out.push({
            library_id: hit.libraryId,
            attachment_key: hit.attachmentKey,
            parent_key: hit.parentKey,
            page: hit.page,
            similarity: Number(hit.similarity.toFixed(4)),
            title: parent ? String((parent as any).getField?.('title') ?? '') : '',
        });
    }
    return { ok: true, model: EMBEDDING_PRESETS[preset].model, results: out };
}

/** Whether the Zotero pane is locked under a progress cover, and what the cover says. */
export async function handleTestPaneStateHttpRequest(): Promise<any> {
    const zotero = Zotero as any;
    const windows = (zotero.getMainWindows?.() ?? []).map((win: Window) => {
        const overlay = win.document.getElementById('zotero-pane-overlay') as any;
        const label = win.document.getElementById('zotero-pane-progress-label') as any;
        return {
            overlayShown: overlay ? !overlay.hidden : null,
            label: label && !label.hidden ? String(label.value ?? '') : null,
        };
    });
    return { ok: true, locked: Boolean(zotero.locked), windows };
}

/**
 * The figures block in Settings: its state, and its buttons. `action` is
 * `index` (the Index button), `retry` (Retry the ones that could not be
 * rendered) or omitted to only read the state; `wait_ms` waits for the run.
 * `reveal` scrolls an open settings window to the block.
 */
export async function handleTestFigurePanelHttpRequest(request: any): Promise<any> {
    const action = request?.action;
    if (action === 'index' || action === 'retry') {
        void store.set(startPageImageIndexAtom, action === 'retry' ? { retryFailed: true } : undefined);
        const deadline = Date.now() + Math.min(Number(request?.wait_ms ?? 0), 120_000);
        // The run reports through the store; give it a moment to begin first.
        await new Promise((resolve) => setTimeout(resolve, 200));
        while (Date.now() < deadline && store.get(pageImageIndexStateAtom).status === 'indexing') {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    } else {
        await store.set(refreshPageImageCoverageAtom);
    }
    let revealed = false;
    if (request?.reveal) {
        const windows = (globalThis as any).Services.wm.getEnumerator(null);
        while (!revealed && windows.hasMoreElements()) {
            const block = windows.getNext().document?.querySelector?.('[data-testid="page-image-index"]');
            if (block) {
                block.scrollIntoView({ block: 'start' });
                revealed = true;
            }
        }
    }
    const { status, indexed, library, pages, skipped, failed, failures, paused, error } = store.get(pageImageIndexStateAtom);
    return { ok: true, status, indexed, library, pages, skipped, failed, failures, paused, error, revealed };
}
