import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { searchableLibraryIdsAtom } from "../atoms/profile";
import {
    isSemanticSearchAvailable,
    embeddingKeyPrefs,
    refreshSemanticSearchAvailability,
    resetSemanticSearchProbe,
    semanticSearchState,
} from "../../src/services/llm/agentConfig";
import { EMBEDDING_PRESETS } from "@beaver/agent-llm/embeddings";
import { onOllamaStatus } from "../utils/ollama";
import {
    embeddingIndexStateAtom,
    setEmbeddingIndexStatusAtom,
    EmbeddingIndexState,
    updateEmbeddingIndexProgressAtom,
    forceReindexCounterAtom,
    updateFailedItemsCountAtom
} from "../atoms/embeddingIndex";
import { EmbeddingIndexer, IndexingError, MIN_CONTENT_LENGTH, INDEX_BATCH_SIZE, mergeIndexingErrors } from "../../src/services/embeddingIndexer";
import { BeaverDB } from "../../src/services/database";
import { embeddingsService } from "@beaver/agent-core/transport/clients/embeddingsService";
import { logger } from "@beaver/agent-core/platform/logger";
import { getPref, setPref } from "../../src/utils/prefs";
import { store } from "../store";
import pkg from "../../package.json";


const EVENT_DEBOUNCE_MS = 4000; // Same as useZoteroSync

/**
 * Module-level variable to track the Zotero notifier observer ID.
 * This persists across hot-reloads to ensure proper cleanup.
 */
let moduleNotifierId: string | null = null;

// ---------------------------------------------------------------------------
// When topic search may have started working
// ---------------------------------------------------------------------------

/**
 * - `provider-changed`: another embedding provider was chosen; each model has
 *   its own index.
 * - `became-ready`: the chosen provider was unusable and now is not.
 * - `key-changed`: the chosen provider's key was replaced on this computer.
 * - `ollama-changed`: Ollama was read afresh and answers with the model.
 */
export type SemanticSearchChange = 'provider-changed' | 'became-ready' | 'key-changed' | 'ollama-changed';

/** How often an Ollama that did not answer is asked again. */
const UNREACHABLE_REPROBE_MS = 60_000;

const changeListeners = new Set<(change: SemanticSearchChange) => void>();
let stopWatching: (() => void) | null = null;

/**
 * Whether topic search was usable when the watcher last looked, or was told.
 * The probe behind semanticSearchState() is shared: an index pass, a run or a
 * paused full-text run can find Ollama down, or back, between the watcher's
 * own looks, and this is what lets a later look still see the change.
 */
let lastSeenReady = true;

/**
 * An index found topic search unusable and is waiting for it. From here on
 * the watcher asks Ollama again each minute, and the first look that finds it
 * usable is reported as `became-ready` — even when a probe made elsewhere
 * found it first.
 */
export function noteSemanticSearchUnusable(): void {
    lastSeenReady = false;
}

/**
 * Hear about everything that can make topic search usable without the
 * embedding provider preference changing: the vendor's key pasted on this
 * computer, the Ollama address, Ollama starting or getting its embedding model. Both
 * indexes listen, so fixing the provider starts them without a restart.
 *
 * One watcher serves every listener: the first to subscribe installs the
 * preference observers, the Ollama listener and, while Ollama does not
 * answer, a probe once a minute; the last to leave removes them.
 */
export function subscribeSemanticSearchChanges(listener: (change: SemanticSearchChange) => void): () => void {
    changeListeners.add(listener);
    if (!stopWatching) stopWatching = watchSemanticSearch();
    return () => {
        changeListeners.delete(listener);
        if (changeListeners.size === 0 && stopWatching) {
            stopWatching();
            stopWatching = null;
        }
    };
}

function watchSemanticSearch(): () => void {
    lastSeenReady = isSemanticSearchAvailable();
    let probing = false;
    const emit = (change: SemanticSearchChange) => {
        for (const listener of [...changeListeners]) {
            try {
                listener(change);
            } catch (error) {
                logger(`useEmbeddingIndex: a readiness listener failed: ${error}`, 1);
            }
        }
    };
    /** Look again; `fresh` forgets the last Ollama probe first. */
    const recheck = async (why: SemanticSearchChange | null, fresh: boolean) => {
        if (probing) return;
        probing = true;
        try {
            if (fresh) resetSemanticSearchProbe();
            const now = await refreshSemanticSearchAvailability();
            const was = lastSeenReady;
            lastSeenReady = now;
            if (now && !was) emit('became-ready');
            else if (now && why) emit(why);
        } catch (error) {
            logger(`useEmbeddingIndex: readiness check failed: ${error}`, 2);
        } finally {
            probing = false;
        }
    };

    const prefix = pkg.config.prefsPrefix;
    const keyPrefs = [...new Set(
        (Object.keys(EMBEDDING_PRESETS) as Array<keyof typeof EMBEDDING_PRESETS>).flatMap((id) => embeddingKeyPrefs(id)),
    )];
    const symbols = [
        Zotero.Prefs.registerObserver(`${prefix}.embeddingProvider`, () => {
            lastSeenReady = isSemanticSearchAvailable();
            emit('provider-changed');
        }, true),
        ...keyPrefs.map((key) => Zotero.Prefs.registerObserver(`${prefix}.${key}`, () => {
            // Only the chosen provider's key matters to the index.
            const chosen = semanticSearchState();
            const uses = chosen.status !== 'off' && (embeddingKeyPrefs(chosen.provider) as string[]).includes(key);
            if (uses) void recheck('key-changed', false);
        }, true)),
        Zotero.Prefs.registerObserver(`${prefix}.ollamaBaseUrl`, () => void recheck(null, true), true),
    ];
    // A guide's check, Detect models or a finished download has just asked
    // Ollama and refreshed the probe; news only when embeddings use Ollama.
    const stopOllama = onOllamaStatus(() => {
        const chosen = semanticSearchState();
        if (chosen.status !== 'off' && chosen.provider === 'ollama') void recheck('ollama-changed', false);
    });
    // Only Ollama can start working with no preference changing, so only it
    // is asked again: whenever it is not known to answer, including when a
    // probe made elsewhere found it down since the last look.
    const timer = setInterval(() => {
        const state = semanticSearchState();
        if (state.status === 'off' || state.provider !== 'ollama') return;
        if (state.status === 'unreachable') lastSeenReady = false;
        if (!lastSeenReady) void recheck(null, true);
    }, UNREACHABLE_REPROBE_MS);

    return () => {
        for (const symbol of symbols) Zotero.Prefs.unregisterObserver(symbol);
        stopOllama();
        clearInterval(timer);
    };
}

/**
 * Interface for collected embedding index events
 */
interface CollectedEvents {
    modifiedItemIds: Set<number>;   // Item IDs that were added or modified
    deletedItemIds: Set<number>;    // Item IDs that were deleted
    timer: NodeJS.Timeout | null;   // Timer ID for debounce
    timestamp: number;              // Last event timestamp
}

/**
 * Hook that manages embedding index for semantic search:
 * - Only indexes libraries in searchableLibraryIds
 * - Cleans up embeddings from libraries removed from searchableLibraryIds
 * - Performs initial indexing on mount for searchableLibraryIds
 * - Sets up listeners for item changes with debouncing (filtered to searchableLibraryIds)
 * - Updates embeddings incrementally based on content hash changes
 */
export function useEmbeddingIndex() {
    // Index every local library that has not been excluded by the user.
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const forceReindexCounter = useAtomValue(forceReindexCounterAtom);

    // Atoms for state management
    const setIndexStatus = useSetAtom(setEmbeddingIndexStatusAtom);
    const updateProgress = useSetAtom(updateEmbeddingIndexProgressAtom);
    const updateFailedCount = useSetAtom(updateFailedItemsCountAtom);


    // Ref for collected events
    const eventsRef = useRef<CollectedEvents>({
        modifiedItemIds: new Set(),
        deletedItemIds: new Set(),
        timer: null,
        timestamp: 0
    });

    // Ref for the indexer instance
    const indexerRef = useRef<EmbeddingIndexer | null>(null);
    // True while the last pass was skipped because the provider could not be
    // used: no key on this computer, Ollama not answering or without the model.
    const asleepRef = useRef(false);
    // Bumped when the embedding provider changes — each model has its own
    // index, so a switch has to start the scan that builds the new model's,
    // not wait for the next restart (switching back finds the old index still
    // there) — and when a sleeping index can run now.
    const [providerGeneration, setProviderGeneration] = useState(0);
    useEffect(() => subscribeSemanticSearchChanges((change) => {
        if (change === 'provider-changed' || asleepRef.current) setProviderGeneration((n) => n + 1);
    }), []);
    
    // Ref to track previous forceReindexCounter for detecting manual reindex requests
    const prevForceReindexCounterRef = useRef<number>(forceReindexCounter);

    // Generation counter to cancel stale async runs when effect re-fires
    const generationRef = useRef(0);

    /**
     * Get the BeaverDB instance from addon
     */
    const getDB = (): BeaverDB | null => {
        return Zotero.AlphainZ?.db as BeaverDB | null;
    };

    /**
     * Get or create the indexer instance
     */
    const getIndexer = (): EmbeddingIndexer | null => {
        if (indexerRef.current) return indexerRef.current;
        
        const db = getDB();
        if (!db) {
            logger("useEmbeddingIndex: BeaverDB not available", 2);
            return null;
        }

        indexerRef.current = new EmbeddingIndexer(db);
        return indexerRef.current;
    };

    /**
     * Format duration in milliseconds to a human-readable string
     */
    const formatDuration = (ms: number): string => {
        if (ms < 1000) {
            return `${Math.round(ms)}ms`;
        }
        return `${(ms / 1000).toFixed(2)}s`;
    };

    /**
     * Perform initial indexing of searchable libraries only.
     * First cleans up embeddings from libraries no longer in searchableLibraryIds.
     * Uses optimized diff check to skip full scans when nothing changed.
     * Falls back to full diff when changes are detected or on periodic safety check.
     * Also retries previously failed items that are ready for retry.
     * @param libraryIds Array of library IDs to index (from searchableLibraryIds)
     * @param forceFullDiff If true, bypass shouldRunFullDiff and process all libraries
     */
    const performInitialIndexing = async (libraryIds: number[], forceFullDiff: boolean = false, isCancelled?: () => boolean) => {
        const startTime = Date.now();
        const indexer = getIndexer();
        if (!indexer) return;
        // The provider has to be reachable, not just chosen: with Ollama down
        // every batch would fail and every item would land in the retry queue.
        if (!(await refreshSemanticSearchAvailability())) {
            logger("useEmbeddingIndex: embedding provider not reachable; skipping this pass", 2);
            asleepRef.current = true;
            noteSemanticSearchUnusable();
            setIndexStatus({ status: 'idle', phase: 'initial' });
            return;
        }

        logger("useEmbeddingIndex: Starting initial indexing check", 3);
        setIndexStatus({ status: 'indexing', phase: 'initial' });

        try {
            // First, clean up embeddings from libraries no longer in searchableLibraryIds
            // This runs even when libraryIds is empty to remove all stale embeddings
            const cleanup = await indexer.cleanupUnsyncedLibraries(libraryIds);
            if (cleanup.librariesRemoved > 0) {
                logger(`useEmbeddingIndex: Cleaned up ${cleanup.embeddingsRemoved} embeddings from ${cleanup.librariesRemoved} unsynced libraries`, 3);
            }

            // If force reindex requested, clear all failed embeddings to retry them
            if (forceFullDiff && libraryIds.length > 0) {
                const clearedCount = await indexer.clearFailedEmbeddings(libraryIds);
                if (clearedCount > 0) {
                    logger(`useEmbeddingIndex: Cleared ${clearedCount} failed embeddings for force reindex`, 3);
                }
            }

            // If no libraries to index, we're done after cleanup
            if (libraryIds.length === 0) {
                const duration = Date.now() - startTime;
                logger(`useEmbeddingIndex: No libraries to index (searchableLibraryIds is empty) - completed in ${formatDuration(duration)}`, 3);
                // Still update failed count to reflect any existing failures in DB
                const failedStats = await indexer.getFailedStats();
                updateFailedCount(failedStats.permanentlyFailed);
                setIndexStatus({ status: 'idle', phase: 'initial' });
                return;
            }

            // Check for upgrade-triggered full diff (clears stored index state so shouldRunFullDiff returns true)
            const needsUpgradeDiff = getPref('runEmbeddingFullDiff');
            if (needsUpgradeDiff) {
                logger("useEmbeddingIndex: Upgrade-triggered embedding full diff - clearing index state for all libraries", 3);
                const dbInstance = getDB();
                if (dbInstance) {
                    // Clear index state for all libraries
                    const allLibraries = Zotero.Libraries.getAll();
                    for (const lib of allLibraries) {
                        await dbInstance.deleteEmbeddingIndexState(lib.libraryID);
                    }
                }
                setPref('runEmbeddingFullDiff', false);
            }

            if (forceFullDiff) {
                logger(`useEmbeddingIndex: Force full diff requested - processing all ${libraryIds.length} libraries`, 3);
            } else {
                logger(`useEmbeddingIndex: Found ${libraryIds.length} searchable libraries to check`, 3);
            }

            // First pass: check which libraries need a full diff
            // This is fast - just SQL queries for MAX(date) and COUNT
            // Skip this check if forceFullDiff is true
            const librariesToProcess: number[] = [];
            const libraryStates: Map<number, { maxClientDateModified: string | null, itemCount: number }> = new Map();

            for (const libraryId of libraryIds) {
                // If forceFullDiff, process all libraries without checking
                if (forceFullDiff) {
                    librariesToProcess.push(libraryId);
                    const state = await indexer.getZoteroLibraryState(libraryId);
                    libraryStates.set(libraryId, state);
                    continue;
                }

                const diffCheck = await indexer.shouldRunFullDiff(libraryId);
                
                if (diffCheck.needsDiff) {
                    logger(`useEmbeddingIndex: Library ${libraryId} needs diff: ${diffCheck.reason}`, 3);
                    librariesToProcess.push(libraryId);
                    // Get and store the current state for later
                    const state = await indexer.getZoteroLibraryState(libraryId);
                    libraryStates.set(libraryId, state);
                } else {
                    logger(`useEmbeddingIndex: Library ${libraryId} skipped: ${diffCheck.reason}`, 4);
                }
            }

            // Collect items ready for retry across synced libraries only
            const itemsReadyForRetry: number[] = [];
            for (const libraryId of libraryIds) {
                const retryItems = await indexer.getItemsReadyForRetry(libraryId);
                itemsReadyForRetry.push(...retryItems);
            }
            if (itemsReadyForRetry.length > 0) {
                logger(`useEmbeddingIndex: Found ${itemsReadyForRetry.length} items ready for retry across synced libraries`, 3);
            }

            // If no libraries need processing and no retries, we're done
            if (librariesToProcess.length === 0 && itemsReadyForRetry.length === 0) {
                const duration = Date.now() - startTime;
                logger(`useEmbeddingIndex: All libraries up to date, no retries needed - completed in ${formatDuration(duration)}`, 3);
                // Still update failed count to reflect any existing failures in DB
                const failedStats = await indexer.getFailedStats();
                updateFailedCount(failedStats.permanentlyFailed);
                setIndexStatus({ status: 'idle', phase: 'incremental' });
                return;
            }

            // Second pass: compute diff only for libraries that need it
            let totalToIndex = 0;
            let totalToDelete = 0;
            const libraryDiffs: Map<number, { toIndex: number[], toDelete: number[], totalIndexable: number }> = new Map();

            for (const libraryId of librariesToProcess) {
                logger(`useEmbeddingIndex: Computing diff for library ${libraryId}`, 4);
                const diff = await indexer.computeIndexingDiff(libraryId, MIN_CONTENT_LENGTH);
                
                // Filter out items that are still in backoff period
                const filteredToIndex = await indexer.filterItemsNotInBackoff(diff.toIndex);
                const skippedDueToBackoff = diff.toIndex.length - filteredToIndex.length;
                if (skippedDueToBackoff > 0) {
                    logger(`useEmbeddingIndex: Library ${libraryId}: ${skippedDueToBackoff} items still in backoff`, 4);
                }
                
                libraryDiffs.set(libraryId, { 
                    toIndex: filteredToIndex, 
                    toDelete: diff.toDelete, 
                    totalIndexable: diff.totalIndexable 
                });
                totalToIndex += filteredToIndex.length;
                totalToDelete += diff.toDelete.length;
            }

            // Add retry items to total (they may overlap with diff items, but that's fine)
            const uniqueRetryItems = itemsReadyForRetry.filter(id => {
                // Check if this item is already in any library diff
                for (const diff of libraryDiffs.values()) {
                    if (diff.toIndex.includes(id)) return false;
                }
                return true;
            });
            totalToIndex += uniqueRetryItems.length;

            logger(`useEmbeddingIndex: Total: ${totalToIndex} to index (including ${uniqueRetryItems.length} retries), ${totalToDelete} to delete across ${librariesToProcess.length} libraries`, 3);
            store.set(embeddingIndexStateAtom, (prev: EmbeddingIndexState) => ({
                ...prev,
                totalItems: totalToIndex,
            }));

            // Third pass: process each library and save state
            let processedItems = 0;
            let totalIndexed = 0;
            let totalSkipped = 0;
            let totalFailed = 0;
            const allErrors: IndexingError[] = [];
            const db = getDB();

            for (const libraryId of librariesToProcess) {
                if (isCancelled?.()) {
                    logger("useEmbeddingIndex: Indexing cancelled (superseded by new run)", 3);
                    setIndexStatus({ status: 'idle', phase: 'initial' });
                    return;
                }
                const diff = libraryDiffs.get(libraryId);
                const zoteroState = libraryStates.get(libraryId);
                if (!diff) continue;

                // Clean up failed embeddings for deleted items
                const cleanedUp = await indexer.cleanupDeletedFailedEmbeddings(libraryId);
                if (cleanedUp > 0) {
                    logger(`useEmbeddingIndex: Cleaned up ${cleanedUp} failed records for deleted items in library ${libraryId}`, 3);
                }

                // Delete orphaned embeddings
                if (diff.toDelete.length > 0 && db) {
                    await db.deleteEmbeddingsBatch(diff.toDelete);
                    logger(`useEmbeddingIndex: Deleted ${diff.toDelete.length} orphaned embeddings from library ${libraryId}`, 3);
                }

                // Track whether the indexing run for this library left any
                // items in an unknown state (pre-API failure). If so, we MUST
                // skip saveIndexState below so the next pass re-runs the diff
                // and gives those items another chance.
                let libraryIncomplete = false;

                // Index items that need (re-)indexing
                if (diff.toIndex.length > 0) {
                    logger(`useEmbeddingIndex: Indexing ${diff.toIndex.length} items in library ${libraryId}`, 3);

                    const result = await indexer.indexItemIdsBatch(diff.toIndex, {
                        batchSize: INDEX_BATCH_SIZE,
                        isCancelled,
                        onProgress: (processed, total) => {
                            updateProgress({
                                indexedItems: processedItems + processed,
                                totalItems: totalToIndex,
                            });
                        },
                    });

                    processedItems += result.indexed + result.skipped + result.failed;
                    totalIndexed += result.indexed;
                    totalSkipped += result.skipped;
                    totalFailed += result.failed;
                    mergeIndexingErrors(allErrors, result.errors);
                    libraryIncomplete = result.incomplete;
                    logger(`useEmbeddingIndex: Library ${libraryId} complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed${result.incomplete ? ' (incomplete)' : ''}`, 3);

                    // If cancelled mid-batch, don't persist state for this library
                    // (partial scan would be recorded as complete)
                    if (isCancelled?.()) {
                        logger("useEmbeddingIndex: Indexing cancelled after partial batch - skipping state save", 3);
                        setIndexStatus({ status: 'idle', phase: 'initial' });
                        return;
                    }
                }

                // Save the index state for this library (for future quick checks).
                // Skip if any batch was incomplete — saving would mark the library
                // as fully scanned and hide unindexed items from quick checks
                // until the weekly safety diff (P1 fix).
                if (zoteroState && !libraryIncomplete) {
                    await indexer.saveIndexState(libraryId, zoteroState);
                    logger(`useEmbeddingIndex: Saved index state for library ${libraryId}`, 4);
                } else if (libraryIncomplete) {
                    logger(`useEmbeddingIndex: Skipping state save for library ${libraryId} due to incomplete batch — will re-check next pass`, 2);
                }
            }

            // Fourth pass: process retry items that weren't covered by library diffs
            if (uniqueRetryItems.length > 0 && !isCancelled?.()) {
                logger(`useEmbeddingIndex: Processing ${uniqueRetryItems.length} retry items`, 3);

                const result = await indexer.indexItemIdsBatch(uniqueRetryItems, {
                    batchSize: INDEX_BATCH_SIZE,
                    isCancelled,
                    onProgress: (processed, total) => {
                        updateProgress({
                            indexedItems: processedItems + processed,
                            totalItems: totalToIndex,
                        });
                    },
                });

                processedItems += result.indexed + result.skipped + result.failed;
                totalIndexed += result.indexed;
                totalSkipped += result.skipped;
                totalFailed += result.failed;
                mergeIndexingErrors(allErrors, result.errors);
                logger(`useEmbeddingIndex: Retry items complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`, 3);
            }

            // If cancelled during retry pass, still reset status
            if (isCancelled?.()) {
                logger("useEmbeddingIndex: Indexing cancelled during retry pass", 3);
                setIndexStatus({ status: 'idle', phase: 'initial' });
                return;
            }

            // Log final failed stats and update UI
            const failedStats = await indexer.getFailedStats();
            if (failedStats.totalFailed > 0) {
                logger(`useEmbeddingIndex: Failed items summary: ${failedStats.totalFailed} total, ${failedStats.readyForRetry} ready for retry, ${failedStats.permanentlyFailed} permanently failed`, 3);
            }
            updateFailedCount(failedStats.permanentlyFailed);

            const duration = Date.now() - startTime;
            logger(`useEmbeddingIndex: Initial indexing complete - took ${formatDuration(duration)}`, 3);
            setIndexStatus({ status: 'idle', phase: 'incremental' });

            // Report indexing completion to backend (fire-and-forget).
            const hasActivity = totalIndexed > 0 || totalFailed > 0 || totalToDelete > 0;
            const hasErrors = allErrors.length > 0;
            if (hasActivity || hasErrors) {
                embeddingsService.reportIndexingComplete({
                    items_indexed: totalIndexed,
                    items_failed: totalFailed,
                    items_skipped: totalSkipped,
                    items_deleted: totalToDelete,
                    libraries_count: libraryIds.length,
                    duration_ms: duration,
                    is_force_reindex: forceFullDiff,
                    errors: allErrors.length > 0 ? allErrors : undefined,
                }).catch(() => {
                    // Silently ignore - already logged in the service
                });
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            logger(`useEmbeddingIndex: Initial indexing failed after ${formatDuration(duration)}: ${(error as Error).message}`, 1);
            Zotero.logError(error as Error);
            setIndexStatus({ 
                status: 'error', 
                phase: 'initial',
                error: (error as Error).message 
            });
        }
    };

    
    /**
     * Process collected events for incremental updates.
     * Uses indexItemIdsBatch which loads items per-batch for memory efficiency.
     */
    const processEvents = async () => {
        const indexer = getIndexer();
        if (!indexer) return;

        const modifiedIds = Array.from(eventsRef.current.modifiedItemIds);
        const deletedIds = Array.from(eventsRef.current.deletedItemIds);

        // Clear collections immediately
        eventsRef.current.modifiedItemIds.clear();
        eventsRef.current.deletedItemIds.clear();
        eventsRef.current.timer = null;

        if (modifiedIds.length === 0 && deletedIds.length === 0) return;

        let filteredModifiedIds = modifiedIds;

        try {
            // Re-check current searchable libraries when draining queued events.
            // This is important when events were queued before an effect re-fire.
            if (modifiedIds.length > 0) {
                const searchableLibrarySet = new Set(searchableLibraryIds);
                const items = await Zotero.Items.getAsync(modifiedIds);
                filteredModifiedIds = items
                    .filter((item): item is Zotero.Item => Boolean(item) && searchableLibrarySet.has(item.libraryID))
                    .map(item => item.id);
            }

            logger(`useEmbeddingIndex: Processing events: ${filteredModifiedIds.length} modified, ${deletedIds.length} deleted`, 3);
            setIndexStatus({ status: 'updating', phase: 'incremental' });

            const db = getDB();

            // Handle deletions first
            if (deletedIds.length > 0 && db) {
                await db.deleteEmbeddingsBatch(deletedIds);
                logger(`useEmbeddingIndex: Deleted ${deletedIds.length} embeddings`, 3);
            }

            // Handle modifications - indexItemIdsBatch handles per-batch loading
            // skipUnchanged: compare content hashes to avoid unnecessary API calls
            if (filteredModifiedIds.length > 0) {
                const result = await indexer.indexItemIdsBatch(filteredModifiedIds, {
                    batchSize: INDEX_BATCH_SIZE,
                    skipUnchanged: true,
                });
                logger(`useEmbeddingIndex: Updated ${result.indexed} embeddings (${result.skipped} skipped, ${result.failed} failed)`, 3);

                // Items that were skipped might need their embeddings removed
                // (e.g., if title/abstract were cleared below min length, or item was trashed)
                // Only delete embeddings for items that exist but don't meet criteria anymore
                if (result.skipped > 0 && db) {
                    // Get existing embeddings for these items
                    const existingEmbeddings = await db.getContentHashes(filteredModifiedIds);
                    const idsWithEmbeddings = filteredModifiedIds.filter(id => existingEmbeddings.has(id));
                    
                    // Check which of these no longer meet criteria
                    if (idsWithEmbeddings.length > 0) {
                        const items = await Zotero.Items.getAsync(idsWithEmbeddings);
                        const stillValidIds = new Set<number>();
                        
                        for (const item of items) {
                            // Item must exist, be a regular item, not be trashed, and meet content requirements
                            if (item && item.isRegularItem() && !item.deleted && indexer.isItemIndexable(item, MIN_CONTENT_LENGTH)) {
                                stillValidIds.add(item.id);
                            }
                        }
                        
                        const toRemove = idsWithEmbeddings.filter(id => !stillValidIds.has(id));
                        if (toRemove.length > 0) {
                            await db.deleteEmbeddingsBatch(toRemove);
                            logger(`useEmbeddingIndex: Removed ${toRemove.length} embeddings for items no longer meeting criteria`, 3);
                        }
                    }
                }
            }

            // Update failed items count after incremental processing
            const failedStats = await indexer.getFailedStats();
            updateFailedCount(failedStats.permanentlyFailed);

            setIndexStatus({ status: 'idle', phase: 'incremental' });

        } catch (error) {
            logger(`useEmbeddingIndex: Event processing failed: ${(error as Error).message}`, 1);
            Zotero.logError(error as Error);
            setIndexStatus({ 
                status: 'error', 
                phase: 'incremental',
                error: (error as Error).message 
            });
        }
    };

    /**
     * Schedule event processing with debounce
     */
    const scheduleEventProcessing = () => {
        eventsRef.current.timestamp = Date.now();

        if (eventsRef.current.timer !== null) {
            clearTimeout(eventsRef.current.timer);
        }

        eventsRef.current.timer = setTimeout(processEvents, EVENT_DEBOUNCE_MS);
    };

    useEffect(() => {
        // Guards - auth/authorization required
        /*
         * Three account gates stood here. With no account all three were false,
         * so the indexer never started once — the stale vectors in the database
         * were not merely from an older model, nothing had been indexing at all.
         *
         * What replaces them is the real precondition: an embedding provider.
         * Without one there is nothing to call, and running would only produce
         * failures. A provider that is chosen but not usable yet leaves the
         * index asleep; the readiness watcher wakes it once the key is pasted
         * or Ollama answers with the model.
         */
        if (!isSemanticSearchAvailable()) {
            asleepRef.current = true;
            noteSemanticSearchUnusable();
            return;
        }
        asleepRef.current = false;
        logger("useEmbeddingIndex: Setting up embedding index", 3);

        let isMounted = true;

        // Track the observer ID for this specific hook instance to prevent race conditions during cleanup
        let myObserverId: string | null = null;

        // Create a set for efficient library lookup in event handling
        const searchableLibrarySet = new Set(searchableLibraryIds);

        // Setup observer (only if we have libraries to index)
        const setupObserver = () => {
            // Don't set up observer if no libraries are searchable
            if (searchableLibraryIds.length === 0) return;

            // Unregister any existing observer before registering a new one
            // This handles hot-reload scenarios where cleanup may not have run
            if (moduleNotifierId) {
                try {
                    Zotero.Notifier.unregisterObserver(moduleNotifierId);
                    logger("useEmbeddingIndex: Unregistered stale observer before re-registering", 4);
                } catch (e) {
                    // Ignore errors if observer was already unregistered
                }
                moduleNotifierId = null;
            }

            const observer = {
                notify: async function(event: string, type: string, ids: number[], extraData: any) {
                    // Skip all processing if shutdown has started
                    if (Zotero.__alphainzShuttingDown) return;

                    // Only handle item events
                    if (type !== 'item') return;

                    let shouldSchedule = false;

                    // Handle add/modify events - filter to synced libraries
                    if (event === 'add' || event === 'modify') {
                        // Load items to check their library
                        const items = await Zotero.Items.getAsync(ids);
                        for (const item of items) {
                            if (item && searchableLibrarySet.has(item.libraryID)) {
                                // Remove from delete set if it was there (item was restored)
                                eventsRef.current.deletedItemIds.delete(item.id);
                                eventsRef.current.modifiedItemIds.add(item.id);
                                shouldSchedule = true;
                            }
                        }
                    }

                    // Handle delete events - use extraData to get libraryID
                    if (event === 'delete') {
                        for (const id of ids) {
                            // For delete events, item no longer exists - check extraData for libraryID
                            if (extraData && extraData[id]) {
                                const { libraryID } = extraData[id];
                                if (libraryID && searchableLibrarySet.has(libraryID)) {
                                    // Remove from modified set
                                    eventsRef.current.modifiedItemIds.delete(id);
                                    eventsRef.current.deletedItemIds.add(id);
                                    shouldSchedule = true;
                                }
                            }
                        }
                    }

                    if (shouldSchedule) {
                        scheduleEventProcessing();
                    }
                }
            // @ts-ignore Zotero.Notifier.Notify is defined
            } as Zotero.Notifier.Notify;

            moduleNotifierId = Zotero.Notifier.registerObserver(observer, ['item'], 'alphainz-embedding-index');
            myObserverId = moduleNotifierId;
        };

        // Check if this is a manual reindex request (counter changed)
        const isForceReindex = forceReindexCounter !== prevForceReindexCounterRef.current;
        prevForceReindexCounterRef.current = forceReindexCounter;

        // Generation counter: cancel any in-flight indexing from a previous effect run
        const generation = ++generationRef.current;
        const isCancelled = () => generationRef.current !== generation;

        // Initialize indexing
        const initialize = async () => {
            try {
                // Wait a moment for DB to be ready (skip delay for force reindex)
                if (!isForceReindex) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                if (isCancelled()) return;

                // Perform initial indexing for searchable libraries only
                // Pass forceFullDiff=true if user clicked "Rebuild Search Index"
                await performInitialIndexing(searchableLibraryIds, isForceReindex, isCancelled);

                // Setup observer after initial indexing
                if (isMounted && !isCancelled()) {
                    setupObserver();

                    // If a prior effect run was cleaned up before debounce fired,
                    // resume processing of the queued IDs in this generation.
                    if (eventsRef.current.modifiedItemIds.size > 0 || eventsRef.current.deletedItemIds.size > 0) {
                        logger("useEmbeddingIndex: Rescheduling pending queued events after re-init", 4);
                        scheduleEventProcessing();
                    }
                }

            } catch (error) {
                if (isCancelled()) return;
                logger(`useEmbeddingIndex: Initialization failed: ${(error as Error).message}`, 1);
                Zotero.logError(error as Error);
                if (isMounted && !isCancelled()) {
                    setupObserver(); // Still set up observer even if initial indexing fails
                    if (eventsRef.current.modifiedItemIds.size > 0 || eventsRef.current.deletedItemIds.size > 0) {
                        logger("useEmbeddingIndex: Rescheduling pending queued events after init failure", 4);
                        scheduleEventProcessing();
                    }
                }
            }
        };

        initialize();

        // Cleanup
        return () => {
            isMounted = false;
            // Bump generation so isCancelled() fires for in-flight performInitialIndexing,
            // whether this is an effect re-fire or a permanent unmount.
            generationRef.current++;
            logger("useEmbeddingIndex: Cleaning up embedding index", 3);

            // Unregister observer
            if (moduleNotifierId && moduleNotifierId === myObserverId) {
                Zotero.Notifier.unregisterObserver(myObserverId);
                moduleNotifierId = null;
            }

            // Clear pending timer
            if (eventsRef.current.timer !== null) {
                clearTimeout(eventsRef.current.timer);
                eventsRef.current.timer = null;
            }

            // Keep queued IDs across effect re-runs. The next generation re-schedules
            // processing after initialization, which avoids losing debounced updates.

            // Clear indexer reference
            indexerRef.current = null;
        };
    }, [searchableLibraryIds, forceReindexCounter, providerGeneration]);
}
