import React, { useEffect, useRef, forwardRef, useLayoutEffect, useCallback, useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeRunAtom, allRunsAtom } from "@beaver/agent-core/run-state/atoms";
import { AgentRunView } from "./AgentRunView";
import { CompactionMarker } from "./ContextCompressionIndicator";
import { threadCompactionAtom } from "../../atoms/threadCompaction";
import { scrollToBottom } from "../../utils/scrollToBottom";
import { userScrolledAtom, windowUserScrolledAtom } from "../../atoms/ui";
import { currentThreadScrollPositionAtom, windowScrollPositionAtom, currentThreadIdAtom, pendingScrollToRunAtom, isLoadingThreadAtom } from "../../atoms/threads";
import { pendingApprovalsAtom } from "../../agents/agentActions";
import { store } from "../../store";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { toolExpandedAtom, messageSourcesVisibilityAtom, annotationPanelStateAtom } from "../../atoms/messageUIState";
import { endWheelTurn, flashQuestion, isConversationJumpLocked, jumpToRun, readingTopOf } from "../../utils/conversationNavigation";
import {
    attachReadingRoom, clearReadingRoom, detachReadingRoom, holdReadingScroll, isHeldAtReach, isLaidOut, noteReaderInput,
    noteReadingScroll, placeInView, readingRoomHeight, restoreReadingPlace, settleReadingRoom, type ReadingPlace,
} from "@beaver/agent-ui/conversation/readingRoom";
import { lastQuestionRunId } from "../../utils/conversationTurns";
import { streamDisplayModeAtom } from "../../atoms/streamDisplay";
import { logger } from "@beaver/agent-core/platform/logger";
import { t } from '../../../src/utils/i18n';

const BOTTOM_THRESHOLD = 120; // pixels
const RESTORE_THRESHOLD = 100; // pixels - threshold for restoring scroll position
const RESTORE_DEBOUNCE_MS = 50; // ms - debounce delay for scroll restoration
const ANIMATION_LOCKOUT_MS = 400; // ms - time to wait after animation before allowing restore
const PENDING_APPROVAL_SCROLL_DELAY = 100; // ms - delay before scrolling for pending approval (allows content to render)
const EXPANSION_SCROLL_EVAL_DELAY = 50; // ms - delay before re-evaluating scroll state after expansion toggle
const PROTOCOL_SCROLL_LOCKOUT_MS = 800; // ms - block other scroll restorations right after protocol target jump

type ThreadViewProps = {
    /** Optional className for styling */
    className?: string;
    /** Whether this is rendered in the separate window (uses independent scroll state) */
    isWindow?: boolean;
};

/** Keys that scroll the view. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

/**
 * Where a reader in the room was, by pane kind and thread (readingRoom.ts):
 * the sidebar is mounted afresh on every tab switch and whenever it is shown
 * again, and the library and reader panes lay the conversation out at their
 * own widths, so a pixel position alone is no place to come back to.
 */
const savedPlaces = new Map<string, ReadingPlace>();

/**
 * ThreadView renders all agent runs for the current thread.
 * Uses allRunsAtom which combines completed runs with any active streaming run.
 *
 * A question is read from the top. Sending one brings it to the top of the
 * view, and its answer streams in underneath while the view stays put — the
 * view never follows the stream down. When the answer is finished and its
 * working steps fold away (Collapse steps, Answer only), the question is
 * brought back up and marked, wherever the reader had scrolled; with every
 * step shown nothing moves, so it is only marked. Blank room below the last
 * run lets a question reach the top when the conversation ends sooner (see
 * readingRoom.ts).
 */
export const ThreadView = forwardRef<HTMLDivElement, ThreadViewProps>(
    function ThreadView({ className, isWindow = false }: ThreadViewProps, ref: React.ForwardedRef<HTMLDivElement>) {
        const win = Zotero.getMainWindow();
        const runs = useAtomValue(allRunsAtom);
        // The run in the active slot: a question sent from here is the only kind that lands there
        const activeRunId = useAtomValue(activeRunAtom)?.id;
        const compaction = useAtomValue(threadCompactionAtom);
        const pendingRunId = useAtomValue(pendingScrollToRunAtom);
        const isLoadingThread = useAtomValue(isLoadingThreadAtom);
        const setPendingScrollToRun = useSetAtom(pendingScrollToRunAtom);
        const restoredFromAtomRef = useRef(false);
        const currentThreadId = useAtomValue(currentThreadIdAtom);
        const prevThreadIdRef = useRef<string | null>(null);
        
        // Track pending approvals for scroll-to-bottom triggering
        // With parallel tool calls, there can be multiple pending approvals
        const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
        const prevPendingApprovalIdsRef = useRef<Set<string>>(new Set());
        
        // Track visibility state for ResizeObserver
        const wasHiddenRef = useRef(true);
        // Track previous container height for resize detection
        const prevContainerHeightRef = useRef(0);
        // Track if we're currently animating scroll
        const isAnimatingRef = useRef(false);
        // Debounce timer for restore
        const restoreDebounceRef = useRef<number | null>(null);
        // Target run element for protocol navigation
        const pendingRunElementRef = useRef<HTMLDivElement | null>(null);
        // Timestamp lock to prevent post-target-jump scroll overrides
        const protocolScrollLockUntilRef = useRef(0);
        // The column holding the conversation, and the blank room at its end (readingRoom.ts)
        const columnRef = useRef<HTMLDivElement | null>(null);
        const roomRef = useRef<HTMLDivElement | null>(null);
        // The thread whose opening scroll is done; until then the view follows it to the end
        const openedThreadRef = useRef<string | null>(null);
        // The newest question last seen, to tell a question just sent from a thread opening
        const prevQuestionRef = useRef<{ threadId: string | null; runId: string | undefined } | null>(null);
        // A question sent while the view was not laid out: the place it comes back to once shown
        const unseenQuestionRef = useRef<{ threadId: string | null; runId: string } | null>(null);
        // The run working on the newest question, followed by id until its answer finishes
        const liveRunRef = useRef<{ threadId: string | null; runId: string } | null>(null);
        const lastQuestionId = useMemo(() => lastQuestionRunId(runs), [runs]);
        const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
        
        // Select the correct atoms based on whether we're in the separate window
        const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;
        const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
        // Read scroll position imperatively inside restoreScrollPosition rather than subscribing.
        // The atom is updated every ~10px of scroll, so subscribing would cause ThreadView to
        // re-render constantly while the user scrolls, cascading through all message components.
        
        // Watch expansion state to re-evaluate scroll button visibility after expand/collapse
        // Track multiple expansion states: tool calls, sources, and agent actions
        const toolExpansionState = useAtomValue(toolExpandedAtom);
        const sourcesVisibilityState = useAtomValue(messageSourcesVisibilityAtom);
        const annotationPanelState = useAtomValue(annotationPanelStateAtom);
        const prevExpansionStateRef = useRef(toolExpansionState);
        const prevSourcesVisibilityRef = useRef(sourcesVisibilityState);
        const prevAnnotationPanelRef = useRef(annotationPanelState);
        
        // Use the auto-scroll hook with window-aware state
        const { scrollContainerRef, setScrollContainerRef, handleScroll } = useAutoScroll(ref, {
            threshold: BOTTOM_THRESHOLD,
            isWindow
        });

        // Also holds while a jump from the question rail or the conversation
        // outline is scrolling this view, so none of the effects below pull
        // the view away from the question the user picked.
        const isProtocolScrollLocked = useCallback(() => {
            return Date.now() < protocolScrollLockUntilRef.current
                || isConversationJumpLocked(scrollContainerRef.current);
        }, [scrollContainerRef]);

        // The view no longer follows the answer down, so the content can grow
        // past the bottom with no scroll to say so. Whether the view is at the
        // bottom is noted here instead: the scroll-down button shows, and a
        // pane that shrinks does not mistake a reader at the top for one at
        // the end.
        const noteDistanceFromBottom = useCallback((container: HTMLElement) => {
            if (!isLaidOut(container)) return;
            const away = container.scrollHeight - container.scrollTop - container.clientHeight > BOTTOM_THRESHOLD;
            if (store.get(scrolledAtom) !== away) store.set(scrolledAtom, away);
        }, [scrolledAtom]);

        const tryScrollToPendingRun = useCallback((source: string, targetElement?: HTMLElement | null) => {
            if (!pendingRunId) {
                return false;
            }

            const container = scrollContainerRef.current;
            if (!container || !isLaidOut(container)) {
                return false;
            }

            const element = targetElement
                ?? pendingRunElementRef.current
                ?? container.querySelector<HTMLElement>(`#run-${CSS.escape(pendingRunId)}`);

            if (!element) {
                if (!isLoadingThread && !runs.some((run) => run.id === pendingRunId)) {
                    logger("ThreadView: pending run target not found after load", {
                        source,
                        pendingRunId,
                        currentThreadId,
                        runsCount: runs.length,
                    }, 1);
                    setPendingScrollToRun(null);
                }
                return false;
            }

            // Prevent restore/auto-bottom effects from overriding this jump.
            protocolScrollLockUntilRef.current = Date.now() + PROTOCOL_SCROLL_LOCKOUT_MS;
            // The link sets where the reader is; an older place in the room is left behind.
            savedPlaces.delete(`${isWindow ? 'window' : 'pane'}:${currentThreadId}`);
            isAnimatingRef.current = true;
            win.setTimeout(() => {
                isAnimatingRef.current = false;
            }, ANIMATION_LOCKOUT_MS);

            element.scrollIntoView({ behavior: "smooth", block: "start" });
            // Determine scroll state based on whether the target is near the bottom.
            // scrollIntoView is async (smooth), so project the final scroll position:
            // use getBoundingClientRect relative to the container to get the element's
            // position within the scrollable area (offsetTop is relative to offsetParent,
            // which may not be the scroll container).
            const { scrollHeight, scrollTop, clientHeight } = container;
            const elementTopInContainer = element.getBoundingClientRect().top - container.getBoundingClientRect().top + scrollTop;
            const projectedDistanceFromBottom = scrollHeight - elementTopInContainer - clientHeight;
            store.set(scrolledAtom, projectedDistanceFromBottom > BOTTOM_THRESHOLD);
            setPendingScrollToRun(null);
            return true;
        }, [pendingRunId, currentThreadId, isLoadingThread, scrollContainerRef, runs, scrolledAtom, setPendingScrollToRun, win, isWindow]);

        const setPendingRunRef = useCallback((node: HTMLDivElement | null) => {
            pendingRunElementRef.current = node;
            if (node) {
                tryScrollToPendingRun("target-ref", node);
            }
        }, [tryScrollToPendingRun]);

        /**
         * Helper function to restore scroll position. A reader's saved place
         * in the room is always restored, room and all; a pixel position only
         * when the view is more than RESTORE_THRESHOLD away from it and not
         * animating.
         */
        const restoreScrollPosition = useCallback((force = false) => {
            if (pendingRunId && !force) {
                restoredFromAtomRef.current = false;
                return;
            }
            if (isProtocolScrollLocked() && !force) {
                restoredFromAtomRef.current = false;
                return;
            }

            const container = scrollContainerRef.current;
            if (!container) {
                restoredFromAtomRef.current = false;
                return;
            }
            
            // Skip if hidden, or not yet laid out to be read (a pane still opening)
            if (!isLaidOut(container)) {
                restoredFromAtomRef.current = false;
                return;
            }
            
            // Skip if currently animating (unless forced)
            if (isAnimatingRef.current && !force) {
                return;
            }

            const saved = store.get(scrollPositionAtom);
            // A reader in the room is placed by what they were reading (readingRoom.ts).
            const placeKey = `${isWindow ? 'window' : 'pane'}:${currentThreadId}`;
            const place = placeInView(container, savedPlaces.get(placeKey), (element) => readingTopOf(container, element));
            // A place no longer in the conversation is no place to come back to later either.
            if (!place) savedPlaces.delete(placeKey);
            const targetScrollTop = saved ?? container.scrollHeight;
            const delta = Math.abs(container.scrollTop - targetScrollTop);
            
            // Check if this is a thread switch
            const isThreadSwitch = currentThreadId !== prevThreadIdRef.current;

            // A reader who left from inside the room (another tab, the
            // sidebar shown again, the window reopened) comes back to the
            // same place, room and all — and the room keeps following them
            // from there, even where none is needed yet.
            if (place) {
                restoredFromAtomRef.current = true;
                restoreReadingPlace(container, place);
                const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
                store.set(scrolledAtom, distanceFromBottom > BOTTOM_THRESHOLD);
                return;
            }

            // Only restore if there's a significant difference (e.g., thread switch)
            // Use a larger threshold to avoid oscillation near boundaries
            if (delta > RESTORE_THRESHOLD) {
                restoredFromAtomRef.current = true;
                // Any other saved position the browser clamps to the end, as always.
                container.scrollTop = targetScrollTop;
                
                // Set scroll state based on position after restore
                const { scrollHeight, clientHeight } = container;
                const distanceFromBottom = scrollHeight - container.scrollTop - clientHeight;
                const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
                store.set(scrolledAtom, !isNearBottom);
            } else {
                restoredFromAtomRef.current = false;
                
                // For small deltas (thread switch with similar position or streaming updates),
                // ensure scroll state is false if we're near the bottom.
                // IMPORTANT: Only do this on thread switch!
                // If we're just scrolling (user interaction), useAutoScroll handles the atom state.
                // Overwriting it here would hide the ScrollDownButton when the user scrolls up.
                if (isThreadSwitch) {
                    const { scrollHeight, clientHeight } = container;
                    const distanceFromBottom = scrollHeight - container.scrollTop - clientHeight;
                    if (distanceFromBottom <= BOTTOM_THRESHOLD) {
                        store.set(scrolledAtom, false);
                    }
                }
            }
        }, [pendingRunId, isProtocolScrollLocked, scrollPositionAtom, scrolledAtom, scrollContainerRef, currentThreadId, isWindow]);

        // The room is the last thing in the conversation's column; new
        // elements start with none. Before the restore below, which may need it.
        useLayoutEffect(() => {
            const container = scrollContainerRef.current;
            if (container && columnRef.current && roomRef.current) {
                const key = `${isWindow ? 'window' : 'pane'}:${currentThreadId}`;
                attachReadingRoom(container, columnRef.current, roomRef.current, {
                    onTrim: () => noteDistanceFromBottom(container),
                    onPlace: (place) => {
                        // Until a question sent while the view was not laid out
                        // is brought up, that question is the place to come back to.
                        if (unseenQuestionRef.current?.threadId === currentThreadId) return;
                        if (place) savedPlaces.set(key, place);
                        else savedPlaces.delete(key);
                    },
                });
            }
        });

        // Room below a view at rest is given back (readingRoom.ts), once the
        // view has runs and with them the column that holds the room.
        const hasRuns = runs.length > 0;
        useEffect(() => {
            const container = scrollContainerRef.current;
            if (!container || !hasRuns) return;
            const settle = () => settleReadingRoom(container);
            // The reader's own scrolling: the wheel, a touch, the scrollbar
            // (a press on the view itself, not on what it shows), scroll keys
            // outside a field being typed in.
            const input = (event: Event) => {
                if (event.type === 'pointerdown') {
                    if (event.target !== container) return;
                    holdReadingScroll(container, true);
                }
                if (event.type === 'keydown') {
                    const target = event.target as HTMLElement | null;
                    if (!SCROLL_KEYS.has((event as KeyboardEvent).key)) return;
                    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
                }
                noteReaderInput(container);
                // A turn of the wheel over the rail does not go on from here.
                endWheelTurn(container);
            };
            const release = () => holdReadingScroll(container, false);
            const releases = ['pointerup', 'pointercancel', 'blur'] as const;
            const inputs = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;
            const owner = container.ownerDocument.defaultView;
            container.addEventListener('scrollend', settle);
            for (const type of inputs) container.addEventListener(type, input, { passive: true });
            for (const type of releases) owner?.addEventListener(type, release, true);
            return () => {
                container.removeEventListener('scrollend', settle);
                for (const type of inputs) container.removeEventListener(type, input);
                for (const type of releases) owner?.removeEventListener(type, release, true);
                detachReadingRoom(container);
            };
        }, [scrollContainerRef, hasRuns]);

        // Restore scroll position from atom (only for thread switching, not during streaming)
        // Note: userScrolledAtom is managed by useAutoScroll.handleScroll, not here
        useLayoutEffect(() => {
            // Another conversation keeps no room from this one.
            if (currentThreadId !== prevThreadIdRef.current) {
                clearReadingRoom(scrollContainerRef.current);
                unseenQuestionRef.current = null;
            }
            restoreScrollPosition();
            prevThreadIdRef.current = currentThreadId;
        }, [restoreScrollPosition, currentThreadId]);

        // Deterministic retry path for protocol navigation:
        // attempt again on render-state changes instead of relying on timers.
        useEffect(() => {
            if (!pendingRunId) return;
            tryScrollToPendingRun("retry-effect");
        }, [pendingRunId, isLoadingThread, runs, tryScrollToPendingRun]);

        // The observer below reads these as they are now, so that it is not
        // set up again whenever the conversation changes: that would cancel a
        // restore it has scheduled, every time a part of an answer streams in.
        const restoreRef = useRef(restoreScrollPosition);
        const tryPendingRef = useRef(tryScrollToPendingRun);
        useLayoutEffect(() => {
            restoreRef.current = restoreScrollPosition;
            tryPendingRef.current = tryScrollToPendingRun;
        });

        // Watch for visibility transitions and container resizes
        useEffect(() => {
            const container = scrollContainerRef.current;
            if (!container) return;

            const observer = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (!entry) return;
                
                const currentHeight = entry.contentRect.height;
                // A pane still opening, a few pixels wide, is not shown yet either.
                const isVisible = currentHeight > 0 && isLaidOut(container);
                const wasHidden = wasHiddenRef.current;
                const prevHeight = prevContainerHeightRef.current;
                
                // Only restore scroll position when transitioning from hidden to visible
                // This prevents interference during normal content growth or layout shifts
                if (wasHidden && isVisible) {
                    // Put back before the view is painted, so it does not show
                    // the top of the conversation first; and once more when the
                    // transition has settled (debounced, as it may come in steps).
                    restoreRef.current();
                    if (restoreDebounceRef.current !== null) {
                        win.clearTimeout(restoreDebounceRef.current);
                    }
                    restoreDebounceRef.current = win.setTimeout(() => {
                        restoreDebounceRef.current = null;
                        restoreRef.current();
                        tryPendingRef.current("visibility-transition");
                        // Shown and put back: a question sent unseen is seen now.
                        if (isLaidOut(container)) unseenQuestionRef.current = null;
                    }, RESTORE_DEBOUNCE_MS);
                }
                // Re-evaluate scroll state when container height changes (window resize)
                // Only trigger if already visible (not on visibility transition)
                else if (!wasHidden && isVisible && prevHeight > 0 && currentHeight !== prevHeight) {
                    const containerShrunk = currentHeight < prevHeight;
                    const wasAtBottom = !store.get(scrolledAtom);

                    // If the container shrunk and the user was at the bottom,
                    // pin to the new bottom — unless a question is up to be
                    // read, which stays where it is.
                    if (containerShrunk && wasAtBottom && !isProtocolScrollLocked()
                        && readingRoomHeight(container) === 0 && !isHeldAtReach(container)) {
                        container.scrollTop = Math.max(container.scrollHeight - currentHeight, 0);
                    } else {
                        const { scrollHeight, scrollTop } = container;
                        const distanceFromBottom = scrollHeight - scrollTop - currentHeight;
                        const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
                        store.set(scrolledAtom, !isNearBottom);
                    }
                }
                
                wasHiddenRef.current = !isVisible;
                prevContainerHeightRef.current = currentHeight;
            });
            
            observer.observe(container);
            return () => {
                observer.disconnect();
                if (restoreDebounceRef.current !== null) {
                    win.clearTimeout(restoreDebounceRef.current);
                    restoreDebounceRef.current = null;
                    // Shown and not yet restored: the next observer's first
                    // report schedules the restore again.
                    wasHiddenRef.current = true;
                }
            };
        }, [scrolledAtom, isProtocolScrollLocked, win]);

        // Scroll to the end of a conversation as it opens. Once it is open,
        // nothing that streams in moves the view: a question is read from the
        // top (see the two effects below).
        useEffect(() => {
            if (openedThreadRef.current === currentThreadId) {
                return;
            }
            if (!isLoadingThread && runs.length > 0) {
                openedThreadRef.current = currentThreadId;
            }

            if (pendingRunId || isProtocolScrollLocked()) {
                return;
            }

            if (restoredFromAtomRef.current) {
                restoredFromAtomRef.current = false;
                return;
            }

            // Not laid out to be read yet (hidden, or a pane still opening):
            // where it opens is settled once it is shown.
            if (scrollContainerRef.current && runs.length > 0 && isLaidOut(scrollContainerRef.current)) {
                const container = scrollContainerRef.current;

                // Check if we're effectively at the bottom now (e.g. content shrunk due to retry/edit)
                // If we are within the threshold, we should reset userScrolled to allow auto-scroll.
                // This handles cases where the user was scrolled up, but the content size reduced 
                // such that they are now looking at the bottom.
                const { scrollHeight, clientHeight, scrollTop } = container;
                const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
                
                if (distanceFromBottom <= BOTTOM_THRESHOLD) {
                    store.set(scrolledAtom, false);
                }

                // Set animation flag to prevent restoreScrollPosition from interfering
                isAnimatingRef.current = true;
                
                // Pass the correct scroll atom for this context
                scrollToBottom(scrollContainerRef as React.RefObject<HTMLElement>, undefined, scrolledAtom);
                
                // Clear animation flag after animation completes (with buffer)
                win.setTimeout(() => {
                    isAnimatingRef.current = false;
                }, ANIMATION_LOCKOUT_MS);
            }
        }, [pendingRunId, isProtocolScrollLocked, runs, scrolledAtom, win, currentThreadId, isLoadingThread]);

        // A question just sent goes to the top of the view, with room below it
        // for its answer. A question sent from here is the only kind that
        // lands in the active slot: one that arrives from another computer
        // through sync, or a question uncovered when a retry takes the run
        // after it away, leaves the view where it is.
        //
        // Anything else the conversation does leaves the view where it is:
        // the room adjusts in layout (readingRoom.ts).
        useLayoutEffect(() => {
            const container = scrollContainerRef.current;
            const previous = prevQuestionRef.current;
            prevQuestionRef.current = { threadId: currentThreadId, runId: lastQuestionId };
            const opened = openedThreadRef.current === currentThreadId;
            const sent = previous !== null
                && previous.threadId === currentThreadId
                && previous.runId !== undefined
                && lastQuestionId !== undefined
                && previous.runId !== lastQuestionId
                && activeRunId === lastQuestionId
                && opened;
            if (container && sent && !pendingRunId) {
                if (isLaidOut(container)) {
                    unseenQuestionRef.current = null;
                    jumpToRun(container, lastQuestionId, scrolledAtom, { flash: false });
                } else {
                    // Not laid out to be read (no height, as when a long draft
                    // takes all of a short pane, or a pane still opening), so
                    // nothing to jump in. The question is the place the view
                    // comes back to once it is shown, whatever the room reports
                    // meanwhile.
                    unseenQuestionRef.current = { threadId: currentThreadId, runId: lastQuestionId };
                    savedPlaces.set(`${isWindow ? 'window' : 'pane'}:${currentThreadId}`, {
                        runId: lastQuestionId, offset: 0, pinned: true, height: 0, width: 0, inner: null,
                    });
                }
                return;
            }
            if (container && opened && !isProtocolScrollLocked()) noteDistanceFromBottom(container);
        }, [runs, lastQuestionId, activeRunId, currentThreadId, pendingRunId, scrolledAtom, isProtocolScrollLocked, isWindow]);

        // The answer is finished. With its steps folding away the page under
        // the reader changes, so the question comes back up, marked — wherever
        // they had scrolled meanwhile. With every step shown nothing changes,
        // and the question is only marked.
        //
        // The working run is followed by id: on finishing it moves from the
        // active slot into the history, and for a moment it may be in neither.
        useEffect(() => {
            if (liveRunRef.current && liveRunRef.current.threadId !== currentThreadId) liveRunRef.current = null;
            const live = runs.find((run) => run.status === 'in_progress' || run.status === 'awaiting_deferred');
            if (live) {
                liveRunRef.current = { threadId: currentThreadId, runId: live.id };
                return;
            }
            const followed = liveRunRef.current;
            if (!followed) return;
            const run = runs.find((candidate) => candidate.id === followed.runId);
            if (!run) return;
            liveRunRef.current = null;
            if (run.status !== 'completed' && run.status !== 'error' && run.status !== 'canceled') return;
            const container = scrollContainerRef.current;
            if (!container || !isLaidOut(container) || !lastQuestionId) return;
            if (store.get(streamDisplayModeAtom) === 'expanded') flashQuestion(container, lastQuestionId);
            else jumpToRun(container, lastQuestionId, scrolledAtom);
        }, [runs, lastQuestionId, currentThreadId, scrolledAtom]);

        // The last run grows and shrinks on its own too — a figure loading, a
        // step opened or closed — and whether the view is at the bottom with it.
        useEffect(() => {
            const container = scrollContainerRef.current;
            const runId = lastRun?.id;
            const win = container?.ownerDocument.defaultView as (Window & typeof globalThis) | null | undefined;
            if (!container || !runId || typeof win?.ResizeObserver !== 'function') return;
            const element = container.ownerDocument.getElementById(`run-${runId}`);
            if (!element) return;
            const observer = new win.ResizeObserver(() => {
                if (!isProtocolScrollLocked()) noteDistanceFromBottom(container);
            });
            observer.observe(element);
            return () => observer.disconnect();
        }, [lastRun?.id, scrollContainerRef, isProtocolScrollLocked, noteDistanceFromBottom]);

        // Scroll to bottom when a new pending approval appears
        // This ensures the approval buttons are visible, even if user had scrolled up
        // Uses a delay to allow the AgentActionView to fully render/expand
        // With parallel tool calls, we track all pending approval IDs
        useEffect(() => {
            const currentApprovalIds = new Set(pendingApprovalsMap.keys());

            if (pendingRunId || isProtocolScrollLocked()) {
                prevPendingApprovalIdsRef.current = currentApprovalIds;
                return;
            }
            
            // Check if there are any NEW pending approvals (not seen before)
            let hasNewApproval = false;
            for (const id of currentApprovalIds) {
                if (!prevPendingApprovalIdsRef.current.has(id)) {
                    hasNewApproval = true;
                    break;
                }
            }
            
            // Only scroll if there's a NEW pending approval (not the same ones re-rendering)
            if (hasNewApproval) {
                const timeoutId = win.setTimeout(() => {
                    if (scrollContainerRef.current) {
                        // Force scroll to bottom for pending approvals - user action is required
                        // Reset userScrolled to allow auto-scroll
                        store.set(scrolledAtom, false);
                        
                        // Set animation flag
                        isAnimatingRef.current = true;
                        
                        // Force scroll to bottom (passing false to override userScrolled)
                        scrollToBottom(scrollContainerRef as React.RefObject<HTMLElement>, false, scrolledAtom);
                        
                        // Clear animation flag after animation completes
                        win.setTimeout(() => {
                            isAnimatingRef.current = false;
                        }, ANIMATION_LOCKOUT_MS);
                    }
                }, PENDING_APPROVAL_SCROLL_DELAY);
                
                prevPendingApprovalIdsRef.current = currentApprovalIds;
                
                return () => win.clearTimeout(timeoutId);
            }
            
            prevPendingApprovalIdsRef.current = currentApprovalIds;
        }, [pendingApprovalsMap, pendingRunId, isProtocolScrollLocked, scrolledAtom, win]);

        // Re-evaluate scroll state when content expands/collapses
        // This ensures the ScrollDownButton visibility is updated when user toggles:
        // - Tool call results (toolExpandedAtom)
        // - Sources sections (messageSourcesVisibilityAtom)
        // - Agent action panels (annotationPanelStateAtom)
        useEffect(() => {
            // Check if any expansion state changed
            const toolChanged = prevExpansionStateRef.current !== toolExpansionState;
            const sourcesChanged = prevSourcesVisibilityRef.current !== sourcesVisibilityState;
            const annotationChanged = prevAnnotationPanelRef.current !== annotationPanelState;
            
            // Skip if nothing changed (initial mount or no state change)
            if (!toolChanged && !sourcesChanged && !annotationChanged) return;
            
            // Update refs
            prevExpansionStateRef.current = toolExpansionState;
            prevSourcesVisibilityRef.current = sourcesVisibilityState;
            prevAnnotationPanelRef.current = annotationPanelState;
            
            // Wait briefly for DOM to update after expansion toggle
            const timeoutId = win.setTimeout(() => {
                const container = scrollContainerRef.current;
                if (!container || !isLaidOut(container)) return;
                
                const { scrollHeight, clientHeight, scrollTop } = container;
                const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
                const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
                
                // Update scrolled state based on current position
                store.set(scrolledAtom, !isNearBottom);
            }, EXPANSION_SCROLL_EVAL_DELAY);
            
            return () => win.clearTimeout(timeoutId);
        }, [toolExpansionState, sourcesVisibilityState, annotationPanelState, scrolledAtom, win]);

        if (runs.length === 0) {
            return (
                <div 
                    id="alphainz-thread-view"
                    className={`display-flex flex-col flex-1 min-h-0 items-center justify-center ${className || ''}`}
                    ref={setScrollContainerRef}
                >
                    <p className="text-secondary">{t('No messages yet')}</p>
                </div>
            );
        }

        return (
            <div
                id="alphainz-thread-view"
                role="log"
                aria-label={t('Chat history')}
                className={`flex-1 min-h-0 overflow-y-auto scrollbar min-w-0 pb-4 ${className || ''}`}
                onScroll={() => {
                    handleScroll();
                    noteReadingScroll(scrollContainerRef.current);
                }}
                ref={setScrollContainerRef}
            >
                <div ref={columnRef} className="thread-column display-flex flex-col gap-4 min-w-0">
                {/* A summary whose cutoff run is not in this list (a thread
                    imported mid-conversation from another machine) is still in
                    use on the wire — the marker moves to the top so the
                    summary stays visible and discardable. */}
                {compaction && !runs.some((r) => r.id === compaction.throughRunId) && (
                    <CompactionMarker />
                )}
                {runs.map((run, index) => (
                    <React.Fragment key={run.id}>
                        <AgentRunView
                            ref={run.id === pendingRunId ? setPendingRunRef : undefined}
                            run={run}
                            isLastRun={index === runs.length - 1}
                        />
                        {/* The compaction cutoff: everything up to this run is
                            summarised on the wire. Rendered as a sibling row —
                            the runs themselves stay untouched. */}
                        {compaction?.throughRunId === run.id && <CompactionMarker />}
                    </React.Fragment>
                ))}
                {/* Room below the last run, so a question can be read from the
                    top of the view (readingRoom.ts). */}
                <div ref={roomRef} className="thread-reading-room" aria-hidden="true" />
                </div>
            </div>
        );
    }
);

export default ThreadView;
