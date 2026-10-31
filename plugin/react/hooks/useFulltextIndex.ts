/**
 * Keeping the full-text index up to date without being asked.
 *
 * The metadata index has always run by itself — a hook mounts, a Zotero
 * notifier watches for item changes, and the user never learns it exists. The
 * full-text pass did not: it embeds every page of every PDF and costs real
 * money, so it was put behind a button in settings and left there.
 *
 * That was the wrong trade. A paper added today is missing from full-text
 * search until someone remembers to open settings, and nothing on screen says
 * so — the search just quietly looks at less of the library than the user
 * thinks. The cost concern is real but it is a *first sweep* concern: once the
 * library is covered, keeping up with it is a few pages per new paper.
 *
 * So: automatic, resumable, and visible. It starts a little after launch,
 * picks up again a few seconds after items change, indexes only what has no
 * chunks yet, and reports progress to the same status bar the metadata index
 * uses. `fulltextIndexAuto` turns it off for anyone who would rather pay on
 * purpose.
 */

import { useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';

import { getPref } from '../../src/utils/prefs';
import { isSemanticSearchAvailable, refreshSemanticSearchAvailability } from '../../src/services/llm/agentConfig';
import {
    fulltextIndexStateAtom,
    refreshFulltextCoverageAtom,
    startFulltextIndexAtom,
} from '../atoms/fulltextIndex';
import {
    pageImageIndexStateAtom,
    pageImageProvider,
    refreshPageImageCoverageAtom,
    startPageImageIndexAtom,
} from '../atoms/pageImageIndex';
import { fulltextSweepDueAtom } from '../atoms/indexSchedule';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { store } from '../store';
import { noteSemanticSearchUnusable, subscribeSemanticSearchChanges } from './useEmbeddingIndex';

/**
 * How long to wait after launch before the first sweep.
 *
 * Long enough that it is never competing with the window opening, the database
 * warming up or the metadata index's own initial pass — which is the one that
 * makes the library searchable at all, and should have the machine to itself.
 */
const STARTUP_DELAY_MS = 20_000;

/**
 * How long to wait after the library changes.
 *
 * Importing a collection fires an event per item; this collapses the burst into
 * one pass. Longer than the metadata index's 4s because a full-text pass is far
 * more expensive to start twice.
 */
const CHANGE_DEBOUNCE_MS = 15_000;

/**
 * How long to wait once the embedding provider became usable — a key pasted,
 * Ollama started or its embedding model downloaded. Short: the user has just fixed the
 * thing that was in the way, and a run that paused on it resumes.
 */
const READY_DELAY_MS = 3_000;

/** Past a provider's reset before resuming, so its clock and ours need not agree to the second. */
const RESUME_MARGIN_MS = 2 * 60_000;

/** setTimeout's ceiling; a longer wait would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Module-scoped so a hot reload cannot leave a second observer behind. */
let moduleNotifierId: string | null = null;

export function useFulltextIndex() {
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const startIndex = useSetAtom(startFulltextIndexAtom);
    const refreshCoverage = useSetAtom(refreshFulltextCoverageAtom);
    const startImages = useSetAtom(startPageImageIndexAtom);
    const refreshImageCoverage = useSetAtom(refreshPageImageCoverageAtom);
    const state = useAtomValue(fulltextIndexStateAtom);
    const imageState = useAtomValue(pageImageIndexStateAtom);

    // Read through a ref so the notifier does not need re-registering every
    // time the status changes.
    const statusRef = useRef(state.status);
    statusRef.current = state.status;

    // A sweep that finds a picture run going cannot start one; it leaves word
    // here, and the sweep runs again once that run has ended — so a PDF added
    // while pages were being embedded is not left until the next start.
    const imagesWantedRef = useRef(false);
    const scheduleRef = useRef<((delay: number, why: string) => void) | null>(null);
    useEffect(() => {
        if (imageState.status === 'indexing' || !imagesWantedRef.current) return;
        imagesWantedRef.current = false;
        // A run the user stopped is not followed by one nobody asked for.
        if (imageState.stopped) return;
        scheduleRef.current?.(CHANGE_DEBOUNCE_MS, 'picture run ended');
    }, [imageState.status, imageState.stopped]);

    // A run that paused on the provider asked it again before reporting the
    // pause. An Ollama that stopped then reads as unusable: wait for it, so
    // the run resumes once it answers.
    useEffect(() => {
        if (state.paused && !isSemanticSearchAvailable()) noteSemanticSearchUnusable();
    }, [state.paused]);

    // A run paused on a spent day goes on by itself once the provider's day
    // has turned over; nothing else would wake it before the next change.
    useEffect(() => {
        if (!state.pausedUntil || getPref('fulltextIndexAuto') === false) return;
        const delay = Math.min(Math.max(0, state.pausedUntil - Date.now()) + RESUME_MARGIN_MS, MAX_TIMER_MS);
        const timer = setTimeout(() => {
            void (async () => {
                // Asked again at the time: it may have been turned off since.
                if (getPref('fulltextIndexAuto') === false) return;
                if (statusRef.current === 'indexing') return;
                if (!(await refreshSemanticSearchAvailability())) return;
                logger('useFulltextIndex: the provider\'s day has turned over; resuming', 3);
                await startIndex();
            })().catch((error) => logger(`useFulltextIndex: resume failed: ${error}`, 1));
        }, delay);
        return () => clearTimeout(timer);
    }, [state.pausedUntil, startIndex]);

    // The same for the page images, which pause on their own.
    useEffect(() => {
        if (!imageState.pausedUntil || getPref('pageImageIndexAuto') === false) return;
        const delay = Math.min(Math.max(0, imageState.pausedUntil - Date.now()) + RESUME_MARGIN_MS, MAX_TIMER_MS);
        const timer = setTimeout(() => {
            if (getPref('fulltextIndexAuto') === false || getPref('pageImageIndexAuto') === false) return;
            void startImages({ automatic: true })
                .catch((error) => logger(`useFulltextIndex: page images resume failed: ${error}`, 1));
        }, delay);
        return () => clearTimeout(timer);
    }, [imageState.pausedUntil, startImages]);

    useEffect(() => {
        // Off by preference. Whether there is a provider to embed with is asked
        // at every sweep, with the same check the agent uses to decide whether
        // to claim its search covers the library, so the two cannot disagree.
        if (getPref('fulltextIndexAuto') === false) return;

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        // Due stays set while another sweep is waiting to run. A sweep of an
        // effect since replaced leaves the flag to the one that replaced it.
        const settleDue = () => {
            if (!cancelled) store.set(fulltextSweepDueAtom, timer !== null);
        };

        const sweep = async (why: string) => {
            if (cancelled) return;
            // Turned off since this sweep was scheduled.
            if (getPref('fulltextIndexAuto') === false) {
                settleDue();
                return;
            }
            if (statusRef.current === 'indexing') {
                // Another run is still going (it stops on its own after the
                // document in flight when the model changed); look again soon
                // rather than dropping this reason on the floor.
                schedule(CHANGE_DEBOUNCE_MS, why);
                return;
            }
            // Asks the local server, not just the preference: a sweep against
            // an Ollama that is not running would only record failures. The
            // watcher then reports when it can run.
            if (!(await refreshSemanticSearchAvailability())) {
                settleDue();
                noteSemanticSearchUnusable();
                return;
            }
            try {
                try {
                    // Recount first. It is cheap, and it answers whether there is
                    // anything to do at all — without it every quiet wake-up would
                    // flip the panel to "counting" and back for nothing.
                    await refreshCoverage();
                    if (cancelled) return;
                    // `library` leaves out what failed to read this session, so
                    // those are not swept again until someone asks for a retry.
                    const { indexed, library } = store.get(fulltextIndexStateAtom);
                    if (indexed >= library) {
                        logger(`useFulltextIndex: nothing outstanding (${why})`, 4);
                    } else {
                        logger(`useFulltextIndex: sweeping ${library - indexed} document(s) (${why})`, 3);
                        await startIndex();
                    }
                } finally {
                    // The passages are through: a picture run waiting on this
                    // sweep may go on, unless another one is already due.
                    settleDue();
                }
                // Figures after the passages, which are what most questions
                // need — for a model that embeds pictures, and not on top of a
                // provider the passages just found failing.
                // Not after passages the user stopped, nor on top of a provider
                // they just found failing.
                const passages = store.get(fulltextIndexStateAtom);
                if (cancelled || passages.paused || passages.stopped) return;
                if (getPref('pageImageIndexAuto') === false || !pageImageProvider()) return;
                if (store.get(pageImageIndexStateAtom).stopped) return;
                if (store.get(pageImageIndexStateAtom).status === 'indexing') {
                    imagesWantedRef.current = true;
                    return;
                }
                await refreshImageCoverage();
                const images = store.get(pageImageIndexStateAtom);
                // PDFs that could not be rendered this session wait for a retry.
                const outstanding = images.library - images.indexed - images.skipped;
                if (images.counted && outstanding > 0) {
                    logger(`useFulltextIndex: rendering ${outstanding} document(s) as page images (${why})`, 3);
                    await startImages({ automatic: true });
                }
            } catch (error) {
                // A background pass must never take the panel down with it.
                logger(`useFulltextIndex: sweep failed: ${error}`, 1);
            }
        };

        const schedule = (delay: number, why: string) => {
            if (timer) clearTimeout(timer);
            store.set(fulltextSweepDueAtom, true);
            timer = setTimeout(() => {
                timer = null;
                void sweep(why);
            }, delay);
        };

        scheduleRef.current = schedule;
        schedule(STARTUP_DELAY_MS, 'startup');

        // A different embedding model means a different index to fill; the
        // sweep sees the new model's coverage and picks up what it lacks. A
        // provider that has just become usable, or whose key was replaced,
        // gets a sweep soon: that is what resumes a run paused on it.
        const stopReadiness = subscribeSemanticSearchChanges((change) =>
            schedule(
                change === 'provider-changed' ? CHANGE_DEBOUNCE_MS : READY_DELAY_MS,
                change === 'provider-changed' ? 'embedding model changed' : `embedding provider ${change}`,
            ));

        const searchable = new Set(searchableLibraryIds);
        const observer = {
            notify: async (event: string, type: string, ids: number[]) => {
                if ((Zotero as any).__alphainzShuttingDown) return;
                if (type !== 'item') return;
                if (event !== 'add' && event !== 'modify') return;
                try {
                    const items = await Zotero.Items.getAsync(ids);
                    // Only a PDF's arrival changes what the full-text index
                    // should hold. Editing a title fires the same event and is
                    // none of this index's business.
                    const relevant = items.some(
                        (item: any) =>
                            item
                            && searchable.has(item.libraryID)
                            && (item.isPDFAttachment?.() || (item.getAttachments?.()?.length ?? 0) > 0),
                    );
                    if (relevant) schedule(CHANGE_DEBOUNCE_MS, 'library changed');
                } catch (error) {
                    logger(`useFulltextIndex: notifier: ${error}`, 1);
                }
            },
        };

        if (moduleNotifierId) {
            try {
                Zotero.Notifier.unregisterObserver(moduleNotifierId);
            } catch {
                /* already gone */
            }
            moduleNotifierId = null;
        }
        moduleNotifierId = Zotero.Notifier.registerObserver(
            observer as any,
            ['item'],
            'alphainz-fulltext-index',
        );
        const myObserverId = moduleNotifierId;

        return () => {
            cancelled = true;
            store.set(fulltextSweepDueAtom, false);
            if (timer) clearTimeout(timer);
            timer = null;
            if (scheduleRef.current === schedule) scheduleRef.current = null;
            stopReadiness();
            if (moduleNotifierId && moduleNotifierId === myObserverId) {
                try {
                    Zotero.Notifier.unregisterObserver(myObserverId);
                } catch {
                    /* already gone */
                }
                moduleNotifierId = null;
            }
        };
    }, [searchableLibraryIds, startIndex, refreshCoverage]);
}
