/**
 * Bringing a question up to read: from the question rail and the outline, when
 * a question is sent, and when its answer is finished.
 *
 * A jump scrolls the thread view itself. ThreadView has scroll logic of its
 * own — scrolling to the end of a conversation as it opens, pinning to the
 * bottom when the pane shrinks, restoring a saved position — and while a jump
 * is under way all of it stands back, the same way it does for a protocol
 * link's jump (see `isProtocolScrollLocked` there).
 */
import { makeRoomFor, noteForwardedWheel, noteReaderInput, scrollTopOf } from './readingRoom';

/** How long ThreadView leaves the view alone after a jump; a smooth scroll is over well before. */
export const JUMP_LOCK_MS = 800;
/** Distance from the bottom that ThreadView and useAutoScroll count as "at the bottom". */
const BOTTOM_THRESHOLD = 120;
/** Room left above the question once it is at the top of the view. */
const JUMP_MARGIN = 8;
/** Pixels per line for a wheel that reports its distance in lines. */
const WHEEL_LINE_PX = 18;
/** How long the question's bubble stays marked after a jump. */
export const FLASH_MS = 1400;
/** Set on the request bubble while it is marked; the stylesheet draws the mark. */
export const FLASH_ATTRIBUTE = 'data-conversation-flash';

const jumpLocks = new WeakMap<Element, number>();
const flashTimers = new WeakMap<Element, number>();

/** Whether a jump in this thread view is still under way. */
export function isConversationJumpLocked(container: Element | null): boolean {
    if (!container) return false;
    const until = jumpLocks.get(container);
    return until !== undefined && Date.now() < until;
}

export function prefersReducedMotion(win: Window | null | undefined): boolean {
    try {
        return win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    } catch {
        return false;
    }
}

/** An element of this thread view by id: ids are per document, so check it is inside the view. */
function elementIn(container: HTMLElement, id: string): HTMLElement | null {
    const element = container.ownerDocument.getElementById(id);
    return element && container.contains(element) ? element : null;
}

/*
 * The mark is an attribute rather than a class: React owns the bubble's
 * className and rewrites it whenever the bubble's hover state changes, which
 * would cut the mark short.
 */
function flash(bubble: HTMLElement): void {
    const win = bubble.ownerDocument.defaultView;
    if (!win) return;
    const pending = flashTimers.get(bubble);
    if (pending !== undefined) win.clearTimeout(pending);
    // Off, a layout read, then on: a second jump to the same question replays the mark.
    bubble.removeAttribute(FLASH_ATTRIBUTE);
    void bubble.offsetWidth;
    bubble.setAttribute(FLASH_ATTRIBUTE, '');
    flashTimers.set(bubble, win.setTimeout(() => {
        flashTimers.delete(bubble);
        bubble.removeAttribute(FLASH_ATTRIBUTE);
    }, FLASH_MS));
}

/**
 * The scroll position that puts `element` at the top of the view, below the
 * margin, as a whole pixel: Gecko cuts a scroll target to a whole pixel and
 * then lands it on the screen's own pixels, so a fractional one can land more
 * than a pixel short. A whole one lands within half a screen pixel.
 */
export function readingTopOf(container: HTMLElement, element: HTMLElement): number {
    return Math.max(0, Math.floor(scrollTopOf(container, element) - JUMP_MARGIN));
}

/**
 * Bring a question's request to the top of the thread view and mark it.
 *
 * When the conversation ends too soon after the question for it to reach the
 * top, room is made below the last run (see readingRoom.ts). Smooth unless the
 * user prefers reduced motion. `onScrolled` hears where the scroll will end —
 * away from the bottom or not — before it starts, so nothing that keeps that
 * state pulls the view elsewhere mid-scroll.
 *
 * `flash: false` brings the question up unmarked: a question just sent needs
 * no pointing at.
 *
 * @returns false when the question is not in this thread view
 */
export function jumpToRun(
    container: HTMLElement,
    runId: string,
    onScrolled: ((scrolledAway: boolean) => void) | null,
    options: { flash?: boolean } = {},
): boolean {
    const run = elementIn(container, `run-${runId}`);
    if (!run) return false;
    endWheelTurn(container);
    const bubble = elementIn(container, `user-request-${runId}`);
    const target = bubble ?? run;

    const wanted = readingTopOf(container, target);
    makeRoomFor(container, wanted, JUMP_LOCK_MS, target);
    // The browser reports the page's size rounded to the pixel; within one of it the room is there.
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const top = wanted - maxTop < 1 ? wanted : maxTop;

    jumpLocks.set(container, Date.now() + JUMP_LOCK_MS);
    onScrolled?.(container.scrollHeight - top - container.clientHeight > BOTTOM_THRESHOLD);

    const behavior: ScrollBehavior = prefersReducedMotion(container.ownerDocument.defaultView) ? 'auto' : 'smooth';
    if (typeof container.scrollTo === 'function') container.scrollTo({ top, behavior });
    else container.scrollTop = top;

    if (bubble && options.flash !== false) flash(bubble);
    return true;
}

/**
 * Mark a question where it stands, without moving the view: its answer is
 * finished, and nothing above or below it changed.
 *
 * @returns false when the question is not in this thread view
 */
export function flashQuestion(container: HTMLElement, runId: string): boolean {
    const bubble = elementIn(container, `user-request-${runId}`);
    if (!bubble) return false;
    flash(bubble);
    return true;
}

/** A turn of the wheel over the rail: where its last notch sent the view, and when. */
const wheelRuns = new WeakMap<HTMLElement, { top: number; at: number }>();

/**
 * A notch this soon after the last one adds to where the view is going, not
 * to where it is: a smooth scroll begun again from where the view is falls
 * short, notch after notch; one that turns back carries on a little the old
 * way first; and pixels added to a position the browser rounds drift.
 */
const WHEEL_RUN_MS = 400;

/** The turn of the wheel over the rail is over: something else moves the view now. */
export function endWheelTurn(container: HTMLElement): void {
    wheelRuns.delete(container);
}

/**
 * Scroll the thread view by a vertical wheel turned over something laid on
 * top of it. The rail sits over the view's right edge and is not inside the
 * view, so its wheel events would otherwise scroll nothing — or whatever
 * scrollable box surrounds the pane.
 *
 * A wheel that turns in lines or pages scrolls smoothly, as it does over the
 * text, its notches adding up to one scroll; one that reports pixels (a
 * touchpad) is followed as it comes, its fractions of a pixel adding up, the
 * view put on the whole pixel. A turn ends with a pause, or once something
 * else moves the view (a jump, the reader's own scroll: `endWheelTurn`).
 *
 * @returns whether the wheel was used, and its default should be prevented
 */
export function scrollByWheel(container: HTMLElement, event: WheelEvent): boolean {
    // Ctrl+wheel zooms; a horizontal swipe is not for this view.
    if (event.ctrlKey || event.deltaY === 0) return false;
    const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? container.clientHeight : 1;
    noteReaderInput(container);
    noteForwardedWheel(container);
    const now = Date.now();
    const run = wheelRuns.get(container);
    const going = run !== undefined && now - run.at < WHEEL_RUN_MS;
    const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
        (going ? run.top : container.scrollTop) + event.deltaY * unit));
    wheelRuns.set(container, { top, at: now });
    if (event.deltaMode === 0 || typeof container.scrollTo !== 'function'
        || prefersReducedMotion(container.ownerDocument.defaultView)) {
        container.scrollTop = Math.round(top);
        return true;
    }
    container.scrollTo({ top, behavior: 'smooth' });
    return true;
}
