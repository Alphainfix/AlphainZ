/**
 * Room below the newest question, so it can be read from the top.
 *
 * A question brought up to read — just sent, just answered, or picked from the
 * rail or the outline — goes to the top of the thread view, and its answer
 * streams in underneath while the view stays where it is. When the
 * conversation ends before the screen does there is nothing below to scroll
 * to, so the column holding the conversation gets a minimum height: the
 * scroll position to keep within reach plus one view (`100%` is the view's
 * own height). A spacer at the end of the column takes whatever the runs
 * leave of it — exactly enough to fill the screen, never more.
 *
 * Layout keeps it exact as the conversation changes below the reach. The
 * answer streaming in, steps folding away, the composer shrinking after a
 * send, the window growing: none of it changes how far the view can scroll, so
 * nothing on screen moves and no script writes anything. Sizing the room from
 * script would have to round it, and a page a fraction of a pixel short of the
 * view makes the browser pull the view up — a one-pixel shake on every line of
 * the answer.
 *
 * What changes above the reach moves the reach along. The reach is kept
 * relative to an element — the question brought up, or what is at the top
 * edge of a view at rest (the innermost element there, else its run) — and
 * when that element moves (the pane made narrower so everything rewraps, a
 * step opened further up, a compaction marker put in), the reach moves with
 * it, and so does a view resting there, before the change is painted.
 *
 * The room only ever shrinks on the reader's say-so. Once a scroll comes to
 * rest above the reach, the reach moves up to where the view stopped, and
 * scrolling down again ends at the conversation's last line, not in blank
 * space. Once no blank is left to keep — the reader has read on past the
 * question, or scrolled up until the room is out of sight — the room is let
 * go altogether, and the page is an ordinary page again. While the view is
 * moving the page is left alone: shortening it under a smooth wheel scroll
 * cuts the scroll short after a few pixels, and under a scrollbar thumb that
 * is still held it pulls the thumb from the pointer. Only bringing a question
 * up, or coming back to a place in the room, makes room again.
 *
 * A question brought up keeps its room while the view rests on it, even once
 * its answer has filled the screen: when the answer's steps fold away at the
 * end, the page would otherwise get shorter under the view.
 */

/**
 * A scroll counts as at rest once its scroll events have stopped for this
 * long, if no `scrollend` has said so first: a wheel or touchpad that scrolls
 * in steps without animating may send none.
 */
export const SETTLE_FALLBACK_MS = 500;

/**
 * Narrower than this the view is not laid out to be read — a pane still
 * opening, which Zotero lays out a few pixels wide for a moment — and what it
 * measures says nothing of where the reader is.
 */
const LAID_OUT_WIDTH = 80;

/** Whether the view is laid out to be read: it has some height, and room for a line of text. */
export function isLaidOut(container: HTMLElement): boolean {
    return container.clientHeight > 0 && container.clientWidth >= LAID_OUT_WIDTH;
}

/**
 * Where a reader in the room is, by what they are reading rather than by
 * pixels: the run, how far into it the view's top is, and whether it is a
 * question brought up — with the run's height and the view's width then. A
 * question brought up is the same place at any width, in any pane, with an
 * answer grown since; a place inside a run is scaled with the run when the
 * view is laid out at another width.
 *
 * `inner` is the same for the nearest box with an id of its own (an answer,
 * a step) around what the view rests on — the first box at or below its top
 * edge — when there is one, its id found only there: how far the view's top
 * is from that box's top (less than nothing when the box starts below it).
 * Found again by that id, it keeps the place where steps above it in the run
 * have folded or opened meanwhile.
 */
export interface ReadingPlace {
    runId: string;
    offset: number;
    pinned: boolean;
    height: number;
    width: number;
    inner: { id: string; offset: number; height: number } | null;
}

/** What the reach is kept relative to. */
interface Anchor {
    element: HTMLElement;
    /** The element's top, in scroll coordinates, when last measured. */
    top: number;
    /** Where the view was put, or came to rest, in scroll coordinates. */
    view: number;
    /** The element's height, and the view's width, when last measured. */
    height: number;
    width: number;
    /** To find it again when React replaces it: its own id, else its run's and how far into the run it was. */
    id: string | null;
    runId: string | null;
    runOffset: number;
}

interface Room {
    column: HTMLElement;
    spacer: HTMLElement;
    /** The scroll position kept within reach, in px; null when no room is kept. */
    reach: number | null;
    anchor: Anchor | null;
    /** The reach is where a jump brought a question up, not where a view came to rest. */
    pinned: boolean;
    /** While a jump scrolls into the room the reach is held. */
    holdUntil: number;
    /** A scroll is under way and has not come to rest. */
    scrolling: boolean;
    /** The anchor moved since the view last came to rest: the layout changed, not the reader's mind. */
    shifted: boolean;
    /** When the reader last turned the wheel, pressed a scroll key, or took hold of the scrollbar. */
    inputAt: number;
    /** When the scroll under way began; null when the view is at rest. */
    sequenceStart: number | null;
    /** The pointer is held on the view's scrollbar: no pause is the end of its scroll. */
    held: boolean;
    /** A wheel turned over the question rail is passed on to the view: until then, its scroll goes on. */
    wheelUntil: number;
    /**
     * The view was just put back — at a saved place, or where it was before a
     * layout change: a scroll begun before this that comes to rest where the
     * view was put is that one, and unless the reader joined it, its end
     * gives nothing back.
     */
    putUntil: number;
    timer: number | null;
    observer: ResizeObserver | null;
    /** Told when the room is given back: the page may end where the view does now. */
    onTrim: (() => void) | null;
    /** Told where the reader is in the room whenever that changes, and null once there is no room. */
    onPlace: ((place: ReadingPlace | null) => void) | null;
}

const rooms = new WeakMap<HTMLElement, Room>();

function setReach(room: Room, reach: number | null): void {
    if (reach === room.reach) return;
    room.reach = reach;
    room.column.style.minHeight = reach === null ? '' : `calc(${reach}px + 100%)`;
}

function cancelSettle(container: HTMLElement, room: Room): void {
    if (room.timer === null) return;
    container.ownerDocument.defaultView?.clearTimeout(room.timer);
    room.timer = null;
}

function settleLater(container: HTMLElement, room: Room, wait: number): void {
    cancelSettle(container, room);
    const win = container.ownerDocument.defaultView;
    if (win) room.timer = win.setTimeout(() => settleReadingRoom(container), wait);
}

function paddingTop(container: HTMLElement): number {
    const view = container.ownerDocument.defaultView;
    return parseFloat(view?.getComputedStyle(container)?.paddingTop ?? '') || 0;
}

/**
 * Where the view is, measured from the column: exact, where `scrollTop` is
 * rounded to the pixel.
 */
function positionOf(container: HTMLElement, room: Room): number {
    return container.getBoundingClientRect().top + container.clientTop + paddingTop(container)
        - room.column.getBoundingClientRect().top;
}

function reducedMotion(container: HTMLElement): boolean {
    try {
        return container.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    } catch {
        return false;
    }
}

/**
 * From `start`, the box the browser's own scroll anchoring would hold still:
 * going down through the boxes that cross the view's top edge, the first one
 * that starts at or below it — or the innermost one crossing it.
 */
function boxAtEdge(room: Room, start: HTMLElement, viewTop: number): HTMLElement {
    const HTML = room.column.ownerDocument.defaultView?.HTMLElement;
    let node = start;
    for (;;) {
        let next: HTMLElement | null = null;
        for (const child of Array.from(node.children)) {
            if (!HTML || !(child instanceof HTML) || child === room.spacer) continue;
            const box = child.getBoundingClientRect();
            if (box.height > 0 && box.bottom > viewTop) {
                next = child;
                break;
            }
        }
        if (!next) return node;
        if (next.getBoundingClientRect().top >= viewTop) return next;
        node = next;
    }
}

/**
 * What a reader at rest is looking at, as the browser's own scroll anchoring
 * picks it: the first box at or below the view's top edge, found by going
 * down from what is at that edge — so that a change inside a run above the
 * reader's line moves it too. The run (or marker) at the top stands in where
 * nothing finer is there.
 */
function elementAtTop(container: HTMLElement, room: Room): HTMLElement | null {
    const viewTop = container.getBoundingClientRect().top + container.clientTop;
    const box = room.column.getBoundingClientRect();
    const HTML = container.ownerDocument.defaultView?.HTMLElement;
    let hit: Element | null = container.ownerDocument.elementFromPoint?.(box.left + Math.min(24, box.width / 2), viewTop + 1) ?? null;
    // Inside an SVG or a formula: from the HTML box around it.
    while (hit && HTML && !(hit instanceof HTML)) hit = hit.parentElement;
    if (hit && hit !== room.column && room.column.contains(hit) && !room.spacer.contains(hit)) {
        return boxAtEdge(room, hit as HTMLElement, viewTop);
    }
    for (const child of Array.from(room.column.children) as HTMLElement[]) {
        if (child === room.spacer) break;
        if (child.getBoundingClientRect().bottom > viewTop) return boxAtEdge(room, child, viewTop);
    }
    return null;
}

/** The run `element` is in, or for a row between runs (a marker), the next run below it, else the one above. */
function runFor(room: Room, element: HTMLElement): HTMLElement | null {
    const inside = element.closest<HTMLElement>('[id^="run-"]');
    if (inside && room.column.contains(inside)) return inside;
    let row: Element | null = element;
    while (row && row.parentElement !== room.column) row = row.parentElement;
    for (let next = row?.nextElementSibling ?? null; next; next = next.nextElementSibling) {
        if (next.id.startsWith('run-')) return next as HTMLElement;
    }
    for (let previous = row?.previousElementSibling ?? null; previous; previous = previous.previousElementSibling) {
        if (previous.id.startsWith('run-')) return previous as HTMLElement;
    }
    return null;
}

/**
 * The element in `scope` with this id, if it is the only one there: an id
 * that two boxes share (a response drawn in two slices) finds neither again.
 */
function onlyWithId(scope: HTMLElement, id: string): HTMLElement | null {
    let found: HTMLElement | null = null;
    const elements = scope.querySelectorAll('[id]');
    for (let i = 0; i < elements.length; i++) {
        const element = elements[i] as HTMLElement;
        if (element.id !== id) continue;
        if (found) return null;
        found = element;
    }
    return found;
}

/** The nearest box with an id of its own around `element`, inside `run` and short of it. */
function innerBox(run: HTMLElement, element: HTMLElement): HTMLElement | null {
    if (!run.contains(element)) return null;
    for (let node: HTMLElement | null = element; node && node !== run; node = node.parentElement) {
        if (node.id && onlyWithId(run, node.id) === node) return node;
    }
    return null;
}

/** The reader's place in the room, if there is a room. */
function placeOf(container: HTMLElement, room: Room): ReadingPlace | null {
    const anchor = room.reach === null ? null : liveAnchor(room);
    if (!anchor) return null;
    const run = runFor(room, anchor.element);
    if (!run) return null;
    const inner = room.pinned ? null : innerBox(run, anchor.element);
    return {
        runId: run.id.slice('run-'.length),
        offset: anchor.view - scrollTopOf(container, run),
        pinned: room.pinned,
        height: run.getBoundingClientRect().height,
        width: container.clientWidth,
        inner: inner && {
            id: inner.id,
            offset: anchor.view - scrollTopOf(container, inner),
            height: inner.getBoundingClientRect().height,
        },
    };
}

function notePlace(container: HTMLElement, room: Room): void {
    room.onPlace?.(placeOf(container, room));
}

function anchorTo(container: HTMLElement, room: Room, element: HTMLElement | null, view: number): void {
    if (!element) {
        room.anchor = null;
        return;
    }
    const top = scrollTopOf(container, element);
    const run = runFor(room, element);
    room.anchor = {
        element, top, view,
        height: element.getBoundingClientRect().height,
        width: container.clientWidth,
        id: element.id || null,
        runId: run?.id ?? null,
        runOffset: run ? top - scrollTopOf(container, run) : 0,
    };
}

/**
 * The anchor's element, found again if React has replaced it (as when a
 * finished run moves from the active slot into the history): by its own id,
 * else its run, with the measurements carried over to the run's top.
 */
function liveAnchor(room: Room): Anchor | null {
    const anchor = room.anchor;
    if (!anchor) return null;
    if (anchor.element.isConnected && room.column.contains(anchor.element)) return anchor;
    const doc = room.column.ownerDocument;
    const again = anchor.id ? onlyWithId(room.column, anchor.id) : null;
    if (again) {
        anchor.element = again;
        return anchor;
    }
    const run = anchor.runId ? doc.getElementById(anchor.runId) : null;
    if (!run || !room.column.contains(run)) {
        room.anchor = null;
        return null;
    }
    anchor.element = run;
    anchor.top -= anchor.runOffset;
    // How tall the run was is not known: no share of it to keep at a new width.
    anchor.height = 0;
    anchor.id = run.id;
    anchor.runOffset = 0;
    return anchor;
}

/** Stop watching the column for the rest of this frame; the next frame watches again. */
function pauseObserver(container: HTMLElement, room: Room): void {
    const observer = room.observer;
    const win = container.ownerDocument.defaultView;
    if (!observer || !win) return;
    observer.disconnect();
    const resume = () => {
        if (rooms.get(container) !== room) return;
        observer.observe(room.column);
        observer.observe(room.spacer);
    };
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(resume);
    else win.setTimeout(resume, 16);
}

/** Put the view back where it was relative to the anchor. */
function putBack(container: HTMLElement, room: Room): void {
    const anchor = room.anchor;
    if (!anchor || Math.abs(positionOf(container, room) - anchor.view) <= 0.5) return;
    room.putUntil = Date.now() + PUT_SCROLL_MS;
    container.scrollTop = anchor.view;
}

/**
 * Something in the column changed size. If it moved the anchor, the reach
 * moves with it, and the view too: a jump on its way there is sent on, and a
 * view at rest is put back where it was relative to the anchor — at a new
 * width, which rewraps the anchor too, the same share of the way into it.
 * (The browser scrolls a view along with what it shows, too — but only as
 * far as the page reaches, which the room limits until it has moved.)
 */
function follow(container: HTMLElement, room: Room): void {
    // Not laid out to be read: nothing to measure.
    if (room.reach === null || !isLaidOut(container)) return;
    const anchor = liveAnchor(room);
    if (!anchor) return;
    const top = scrollTopOf(container, anchor.element);
    const height = anchor.element.getBoundingClientRect().height;
    const width = container.clientWidth;
    const into = anchor.view - anchor.top;
    const rewrapped = width !== anchor.width && into > 0 && into < anchor.height;
    const moved = top + (rewrapped ? into * (height / anchor.height) : into) - anchor.view;
    anchor.top = top;
    anchor.height = height;
    anchor.width = width;
    if (Math.abs(moved) < 0.05) return;
    // Moving the reach resizes the column this observer watches: watching it
    // through this frame would make the browser report a resize loop.
    pauseObserver(container, room);
    anchor.view += moved;
    setReach(room, Math.max(0, room.reach + moved));
    if (Date.now() < room.holdUntil) {
        container.scrollTo?.({ top: anchor.view, behavior: reducedMotion(container) ? 'auto' : 'smooth' });
    } else if (room.scrolling) {
        // The scroll under way is (also) the layout's: its rest puts the view back.
        room.shifted = true;
    } else if (Math.abs(positionOf(container, room) - anchor.view) > 0.5) {
        room.shifted = true;
        room.putUntil = Date.now() + PUT_SCROLL_MS;
        container.scrollTop = anchor.view;
    }
    notePlace(container, room);
}

/**
 * Use `column`, the box holding the conversation inside `container`, and
 * `spacer`, the last thing in it, as its room. Idempotent for the same
 * elements; new ones start with no room. `onTrim` is called whenever room is
 * given back, `onPlace` whenever the reader's place in the room changes.
 */
export function attachReadingRoom(
    container: HTMLElement,
    column: HTMLElement,
    spacer: HTMLElement,
    handlers: { onTrim?: () => void; onPlace?: (place: ReadingPlace | null) => void } = {},
): void {
    const onTrim = handlers.onTrim ?? null;
    const onPlace = handlers.onPlace ?? null;
    const current = rooms.get(container);
    if (current?.column === column && current.spacer === spacer) {
        current.onTrim = onTrim;
        current.onPlace = onPlace;
        return;
    }
    detachReadingRoom(container);
    column.style.minHeight = '';
    const room: Room = {
        column, spacer, reach: null, anchor: null, pinned: false, holdUntil: 0, scrolling: false, shifted: false,
        inputAt: -Infinity, sequenceStart: null, held: false, wheelUntil: 0, putUntil: 0, timer: null, observer: null, onTrim, onPlace,
    };
    // The column changes size when the runs outgrow the room, the spacer when they do not.
    const win = container.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (typeof win?.ResizeObserver === 'function') {
        room.observer = new win.ResizeObserver(() => follow(container, room));
        room.observer.observe(column);
        room.observer.observe(spacer);
    }
    rooms.set(container, room);
}

/** The view is going away: stop watching its column. */
export function detachReadingRoom(container: HTMLElement | null): void {
    const room = container ? rooms.get(container) : undefined;
    if (!container || !room) return;
    cancelSettle(container, room);
    room.observer?.disconnect();
    rooms.delete(container);
}

function paddingBottom(container: HTMLElement): number {
    const view = container.ownerDocument.defaultView;
    return parseFloat(view?.getComputedStyle(container)?.paddingBottom ?? '') || 0;
}

/** Where the conversation's last run ends, in scroll coordinates. */
function endOf(container: HTMLElement, room: Room): number {
    return room.spacer.getBoundingClientRect().top - room.column.getBoundingClientRect().top + paddingTop(container);
}

/**
 * The room under the conversation now, in whole px: blank beyond where the
 * page would end without it. (A conversation shorter than the view has blank
 * below it anyway; that is no room.)
 */
export function readingRoomHeight(container: HTMLElement | null): number {
    const room = container ? rooms.get(container) : undefined;
    if (!container || !room || room.reach === null) return 0;
    const spacer = room.spacer.getBoundingClientRect().height;
    const inside = container.clientHeight - paddingTop(container) - paddingBottom(container);
    const natural = Math.max(0, inside - (endOf(container, room) - paddingTop(container)));
    return Math.round(Math.max(0, spacer - natural));
}

/**
 * Whether the view rests where the room keeps the page's end within reach — a
 * question brought up, or a place in the room it came to rest at — rather
 * than at the conversation's own end: within the pixel and a half a scroll
 * lands short of where it was sent, or on its way back there after a change
 * in the layout. The room catches up with the layout first, so a change not
 * yet followed does not make the view look moved.
 */
export function isHeldAtReach(container: HTMLElement | null): boolean {
    const room = container ? rooms.get(container) : undefined;
    if (!container || !room || room.reach === null || !isLaidOut(container)) return false;
    follow(container, room);
    if (room.reach === null) return false;
    return room.shifted || Math.abs(positionOf(container, room) - room.reach) <= LANDING_PX;
}

/**
 * The scroll position that puts `element`'s top at the top of the view,
 * measured from the conversation's column, so it is exact: the browser
 * reports `scrollTop` rounded to the pixel, and on a screen whose pixels are
 * a fraction of that (a display scaled to 125% or 150%) the difference shows.
 */
export function scrollTopOf(container: HTMLElement, element: HTMLElement): number {
    const top = element.getBoundingClientRect().top;
    const room = rooms.get(container);
    if (!room) return container.scrollTop + top - container.getBoundingClientRect().top - container.clientTop;
    return top - room.column.getBoundingClientRect().top + paddingTop(container);
}

/**
 * Make room for `top` to become the view's scroll position, and hold it for
 * `holdMs` while a jump scrolls there. `anchor` is what is brought up there,
 * which the reach then moves with; `pinned` says it is a question brought up
 * to read. Never below the view's own position: cutting the room from under
 * the view would make the browser snap it there before the jump's own scroll
 * began.
 */
export function makeRoomFor(
    container: HTMLElement,
    top: number,
    holdMs: number,
    anchor: HTMLElement | null = null,
    pinned = anchor !== null,
): void {
    const room = rooms.get(container);
    if (!room) return;
    const at = isLaidOut(container) ? positionOf(container, room) : container.scrollTop;
    setReach(room, at > top ? at : top);
    anchorTo(container, room, anchor, top);
    room.pinned = anchor !== null && pinned;
    room.putUntil = 0;
    // What scrolls from here is the jump's own; a jump that finds the view
    // already in place scrolls nothing, and nothing is left under way.
    room.scrolling = false;
    room.shifted = false;
    room.sequenceStart = null;
    room.holdUntil = Date.now() + holdMs;
    cancelSettle(container, room);
    notePlace(container, room);
}

/**
 * Put the view back at a reader's saved place (`placeInView`), room and all.
 * The scroll that takes it there is the view's own, not the reader's: coming
 * to rest, it gives nothing back.
 */
export function restoreReadingPlace(
    container: HTMLElement,
    place: { top: number; anchor: HTMLElement; pinned: boolean },
): void {
    const room = rooms.get(container);
    if (!room) return;
    // The scroll of a restore just before this one may still be on its way.
    const earlier = room.putUntil;
    makeRoomFor(container, place.top, 0, place.anchor, place.pinned);
    room.putUntil = earlier;
    if (Math.abs(container.scrollTop - place.top) <= 0.5) return;
    room.putUntil = Date.now() + PUT_SCROLL_MS;
    container.scrollTop = place.top;
}

/**
 * How soon after the view is put back the scroll that takes it there begins:
 * the browser reports it at its next frame, which a heavy mount may hold up.
 */
const PUT_SCROLL_MS = 1000;

/**
 * How far short of a position given in fractions of a pixel a scroll there
 * lands: the browser cuts the target to a whole pixel, then puts it on the
 * screen's own pixels.
 */
const LANDING_PX = 1.5;

/**
 * The scroll position `offset` into `box`, measured when the box was `height`
 * tall in a view `width` wide: the same share of the way into it when the
 * view is laid out at another width, else the same distance — if the box
 * still reaches that far.
 */
function intoBox(container: HTMLElement, box: HTMLElement, offset: number, height: number, width: number): number | null {
    const now = box.getBoundingClientRect().height;
    if (container.clientWidth !== width && offset > 0 && height > 0) {
        return scrollTopOf(container, box) + offset * (now / height);
    }
    return offset > now ? null : scrollTopOf(container, box) + offset;
}

/**
 * Where the reader's saved place is in the view as laid out now, if it is
 * still there: the question brought up (put at the top by `topOf`), or the
 * same distance from the box with an id that the view rested on — else from
 * the same run — or the same share of it when the view is laid out at
 * another width.
 */
export function placeInView(
    container: HTMLElement,
    place: ReadingPlace | null | undefined,
    topOf: (element: HTMLElement) => number,
): { top: number; anchor: HTMLElement; pinned: boolean } | null {
    if (!place) return null;
    const doc = container.ownerDocument;
    const run = doc.getElementById(`run-${place.runId}`);
    if (!run || !container.contains(run)) return null;
    if (place.pinned) {
        const bubble = doc.getElementById(`user-request-${place.runId}`);
        const anchor = bubble && container.contains(bubble) ? bubble : run;
        return { top: topOf(anchor), anchor, pinned: true };
    }
    // Steps above it in the run may have folded or opened since: from the box itself.
    const inner = place.inner ? onlyWithId(run, place.inner.id) : null;
    if (place.inner && inner && inner !== run) {
        const top = intoBox(container, inner, place.inner.offset, place.inner.height, place.width);
        if (top !== null) return { top, anchor: inner, pinned: false };
    }
    // A place past the end of a run that has since got shorter (its steps folded) is gone.
    const top = intoBox(container, run, place.offset, place.height, place.width);
    return top === null ? null : { top, anchor: run, pinned: false };
}

/**
 * A scroll is under way: the room settles once it stops — at its `scrollend`
 * (Firefox 109 on, so every Zotero 7 and later), or after a pause in its
 * scroll events where no `scrollend` comes. While the scrollbar thumb is held
 * a pause is no end: it waits for the thumb to be let go.
 */
export function noteReadingScroll(container: HTMLElement | null): void {
    const room = container ? rooms.get(container) : undefined;
    // Not laid out to be read: what scrolls it is no reading.
    if (!container || !room || !isLaidOut(container)) return;
    if (room.reach === null) {
        // Moved with no room: no place in the room is kept for it.
        room.onPlace?.(null);
        return;
    }
    if (room.sequenceStart === null) room.sequenceStart = Date.now();
    room.scrolling = true;
    // A settle put off until a jump finished waits for this scroll's own end instead.
    if (room.held) cancelSettle(container, room);
    else settleLater(container, room, SETTLE_FALLBACK_MS);
}

/** The pointer is taken hold of on the view's scrollbar, or let go. */
export function holdReadingScroll(container: HTMLElement | null, held: boolean): void {
    const room = container ? rooms.get(container) : undefined;
    if (!container || !room || room.held === held) return;
    room.held = held;
    if (held) cancelSettle(container, room);
    else if (room.scrolling) settleLater(container, room, SETTLE_FALLBACK_MS);
}

/**
 * The reader is scrolling the view themselves: the wheel, a scroll key, the
 * scrollbar, a touch. It counts for the scroll it starts or joins — not for
 * one the layout causes later.
 */
export function noteReaderInput(container: HTMLElement | null): void {
    const room = container ? rooms.get(container) : undefined;
    if (room) room.inputAt = Date.now();
}

/**
 * The wheel is turned over something laid on the view and passed on to it
 * (the question rail). The notches of one turn are one scroll for the room:
 * passed on as they come, each may end with a scrollend of its own, so the
 * room settles only once they stop.
 */
export function noteForwardedWheel(container: HTMLElement | null): void {
    const room = container ? rooms.get(container) : undefined;
    if (room) room.wheelUntil = Date.now() + SETTLE_FALLBACK_MS;
}

/** Input that close to a scroll's start began it. */
const INPUT_LEAD_MS = 150;

/**
 * The view has come to rest: give back the room below it, and keep the reach
 * relative to what the view rests on. A jump still under way is let finish
 * first.
 */
export function settleReadingRoom(container: HTMLElement | null): void {
    const room = container ? rooms.get(container) : undefined;
    if (!container || !room) return;
    cancelSettle(container, room);
    // Not laid out to be read: nothing to measure.
    if (room.reach === null || !isLaidOut(container)) return;
    const wait = Math.max(room.holdUntil, room.wheelUntil) - Date.now();
    if (wait > 0) {
        settleLater(container, room, wait);
        return;
    }
    // No scroll since the last rest: a scrollend the browser sends once more
    // (as it may after the layout changes) ends nothing.
    if (room.sequenceStart === null) return;
    // The browser's own scrolling, as it keeps the view on what it shows
    // while the layout changes, comes to rest like the reader's — and may
    // arrive before the layout change is reported. That gives nothing back:
    // the view goes back where it was, relative to what it was on. Where the
    // reader scrolled too, where they stopped stands.
    follow(container, room);
    const startedAt = room.sequenceStart;
    const byReader = startedAt !== null && room.inputAt >= startedAt - INPUT_LEAD_MS;
    room.scrolling = false;
    room.sequenceStart = null;
    if (room.shifted) {
        room.shifted = false;
        if (!byReader) {
            putBack(container, room);
            return;
        }
    }
    const at = positionOf(container, room);
    // The end of the scroll that put the view back — at a saved place, or on
    // what it showed before the layout changed — and left it there, however
    // it came to rest (its scrollend, or the pause where none came): nothing
    // is given back until the reader moves. (Where the layout now leaves no
    // blank under the view, letting the room go would leave the view to
    // whatever moves it next.) A scroll that took the view somewhere else
    // meanwhile is no part of it, and settles as any other.
    if ((startedAt ?? Date.now()) < room.putUntil && room.anchor !== null
        && Math.abs(at - room.anchor.view) <= LANDING_PX) {
        room.putUntil = 0;
        if (!byReader) return;
    }
    let changed = false;
    // Whether the view still rests on the question brought up: where the
    // jump put it, give or take the pixel a smooth scroll may land off by. (A
    // jump up keeps the room below the view until it lands; a reader who
    // scrolls straight back from the jump has left the question.)
    const restsOnQuestion = room.pinned && room.anchor !== null && Math.abs(at - room.anchor.view) <= 1;
    room.pinned = restsOnQuestion;
    if (at < room.reach - 1) {
        setReach(room, at);
        changed = true;
    }
    // No blank left to keep: an ordinary page again. A question brought up
    // and still rested on keeps its room for when its steps fold away.
    if (readingRoomHeight(container) === 0 && !restsOnQuestion) {
        setReach(room, null);
        room.anchor = null;
        room.pinned = false;
        changed = true;
    } else if (!restsOnQuestion) {
        anchorTo(container, room, elementAtTop(container, room), at);
    }
    notePlace(container, room);
    if (changed) room.onTrim?.();
}

/** No room at all: another conversation opened. */
export function clearReadingRoom(container: HTMLElement | null): void {
    const room = container ? rooms.get(container) : undefined;
    if (!container || !room) return;
    cancelSettle(container, room);
    room.holdUntil = 0;
    room.wheelUntil = 0;
    room.anchor = null;
    room.pinned = false;
    room.scrolling = false;
    room.shifted = false;
    room.putUntil = 0;
    room.sequenceStart = null;
    setReach(room, null);
}
