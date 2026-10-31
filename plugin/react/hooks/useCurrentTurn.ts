import { useLayoutEffect, useState, type RefObject } from 'react';
import { readingRoomHeight } from '../utils/readingRoom';

/** How far down the view a question's top has to come to be the one being read. */
const READING_LINE = 0.35;
/** Within this many pixels of the bottom, the last question is the one being read. */
const AT_BOTTOM_PX = 4;

/**
 * Which question the thread view is showing: the last one whose top has come
 * up past a line a third of the way down the view, or the last question once
 * the view is scrolled to the bottom. -1 when there is none.
 *
 * Questions are found by their run's element (`#run-<id>`), top to bottom in
 * the order of `runIds`, so a binary search reads only a handful of them.
 */
export function readCurrentTurnIndex(container: HTMLElement, runIds: readonly string[]): number {
    const count = runIds.length;
    if (count === 0) return -1;
    const { scrollTop, scrollHeight, clientHeight } = container;
    // At the very end the last question is the one being read — unless there
    // is room below the conversation, which keeps the view at the end while a
    // question nearer the top is read; then the reading line decides.
    if (readingRoomHeight(container) === 0 && scrollTop + clientHeight >= scrollHeight - AT_BOTTOM_PX) return count - 1;

    const doc = container.ownerDocument;
    const line = container.getBoundingClientRect().top + clientHeight * READING_LINE;
    const topOf = (index: number): number | null => {
        const element = doc.getElementById(`run-${runIds[index]}`);
        return element && container.contains(element) ? element.getBoundingClientRect().top : null;
    };

    let low = 0;
    let high = count - 1;
    let found = 0;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const top = topOf(mid);
        // Not rendered (yet): stop at what is known rather than guess.
        if (top === null) break;
        if (top <= line) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

/**
 * Track which question the thread view is showing, as an index into `runIds`.
 *
 * A passive scroll listener, coalesced to one measurement per frame, updates
 * state only when the question changes — so scrolling re-renders the caller
 * a few times per conversation, and never the thread view or its messages.
 * Listeners go when the caller unmounts or the questions change.
 */
export function useCurrentTurnIndex(
    containerRef: RefObject<HTMLElement>,
    runIds: readonly string[],
): number {
    const [current, setCurrent] = useState(-1);
    const key = runIds.join('\n');

    useLayoutEffect(() => {
        const container = containerRef.current;
        const win = container?.ownerDocument.defaultView;
        if (!container || !win) return;
        const ids = key ? key.split('\n') : [];

        let frame: number | null = null;
        const measure = () => {
            frame = null;
            // Hidden (a collapsed pane, a background tab): keep the last answer.
            if (container.clientHeight === 0) return;
            const next = readCurrentTurnIndex(container, ids);
            setCurrent((previous) => (previous === next ? previous : next));
        };
        const schedule = () => {
            if (frame === null) frame = win.requestAnimationFrame(measure);
        };

        measure();
        container.addEventListener('scroll', schedule, { passive: true });
        const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
        observer?.observe(container);

        return () => {
            container.removeEventListener('scroll', schedule);
            observer?.disconnect();
            if (frame !== null) win.cancelAnimationFrame(frame);
        };
    }, [containerRef, key]);

    return Math.min(current, runIds.length - 1);
}
