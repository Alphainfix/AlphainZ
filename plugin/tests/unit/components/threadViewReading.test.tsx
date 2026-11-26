// @vitest-environment jsdom
 

/**
 * A question is read from the top.
 *
 * Sending one brings it to the top of the view, with blank room below it for
 * the answer; the answer streams in underneath while the view stays put. The
 * room shrinks as the answer fills it and as the reader scrolls up, and never
 * comes back by scrolling. When the answer is finished and its steps fold
 * away, the question is brought back up and marked; with every step shown it
 * is only marked.
 *
 * Layout is a model here: runs stack with no gaps, each at the height the test
 * gives it; the conversation's column is at least as tall as its minimum
 * height, the room filling the rest; and the view clamps its scroll position
 * the way a browser does.
 */
import fs from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun, AgentRunStatus } from '@beaver/agent-core/agents/types';

vi.mock('../../../react/components/agentRuns/AgentRunView', async () => {
    const React = await import('react');
    const AgentRunView = React.forwardRef<HTMLDivElement, { run: AgentRun }>(function AgentRunView({ run }, ref) {
        // A run listed in `__twinLines` draws a second box with its line's id first, as a response drawn in two slices does.
        const twin = (globalThis as any).__twinLines?.has(run.id);
        return React.createElement('div', { id: `run-${run.id}`, ref },
            twin ? React.createElement('div', { id: `line-${run.id}`, 'data-twin': '' }) : null,
            React.createElement('div', { id: `user-request-${run.id}` }, run.user_prompt.content),
            React.createElement('div', { id: `line-${run.id}` }));
    });
    return { AgentRunView, default: AgentRunView };
});
vi.mock('../../../react/components/agentRuns/ContextCompressionIndicator', () => ({ CompactionMarker: () => null }));
vi.mock('../../../react/atoms/threadCompaction', async () => {
    const { atom } = await import('jotai');
    return { threadCompactionAtom: atom(null) };
});
vi.mock('../../../react/agents/agentActions', async () => {
    const { atom } = await import('jotai');
    return { pendingApprovalsAtom: atom(new Map()) };
});

/** The view's height; a test can change it, as a composer shrinking back does. */
let VIEW = 400;
/** The display scale, and whether the view reports its position rounded to the pixel, as Gecko does. */
let DPR = 1;
let ROUNDS = false;
/** Where the view truly was each time a scroll was started. */
const trueStarts: number[] = [];
const FLASH = 'data-conversation-flash';
/** Where the view was each time a scroll was started, as the browser saw it. */
const scrollStarts: number[] = [];
/** Every scroll position set from script, as `scrollTop = …`. */
const writes: number[] = [];
/** ResizeObserver callbacks, by the element they watch. */
const observers = new Map<Element, Set<() => void>>();
/** Fire every ResizeObserver watching `element`, as a resize would — in a frame of its own. */
async function resized(element: Element) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { for (const fire of observers.get(element) ?? []) fire(); });
}

/** Each run's height, by id; the model's whole layout. */
const heights = new Map<string, number>();
/** How far into its run each run's line sits (default 300), and how tall it is (default 20). */
const lines = new Map<string, number>();
const lineHeights = new Map<string, number>();
/** What the browser finds at the view's top edge; null as jsdom, which has no layout. */
let atTopEdge: Element | null = null;
let scrollPos = 0;
let now = 1_000_000;
let root: Root | null = null;
const restores: Array<() => void> = [];

function view(): HTMLElement {
    return document.getElementById('alphainz-thread-view')!;
}

function column(): HTMLElement {
    return document.querySelector<HTMLElement>('.thread-column')!;
}

function room(): HTMLElement {
    return document.querySelector<HTMLElement>('.thread-reading-room')!;
}

/** The scroll position the column's minimum height keeps within reach: `calc(<reach>px + 100%)`. */
function reach(): number | null {
    const match = /(-?[\d.]+)px/.exec(column()?.style.minHeight ?? '');
    return match ? parseFloat(match[1]) : null;
}

/** The room the column's minimum height leaves under the runs. */
function roomHeight(): number {
    const kept = reach();
    return kept === null ? 0 : Math.max(0, kept + VIEW - contentHeight());
}

function runIds(): string[] {
    return [...view().querySelectorAll('[id^="run-"]')].map((el) => el.id.slice('run-'.length));
}

function runTop(id: string): number {
    let top = 0;
    for (const rid of runIds()) {
        if (rid === id) return top;
        top += heights.get(rid) ?? 100;
    }
    return top;
}

const contentHeight = () => runIds().reduce((sum, id) => sum + (heights.get(id) ?? 100), 0);
// Never less than the view itself, as in a browser.
const scrollHeight = () => Math.max(VIEW, contentHeight() + roomHeight());
const maxScroll = () => Math.max(0, scrollHeight() - VIEW);

/**
 * The view's scroll position, clamped to what the page allows the way a
 * browser clamps it: once the page gets shorter, the position stays pulled up
 * even if the page grows back.
 */
function scrolled(): number {
    const max = maxScroll();
    if (scrollPos > max) scrollPos = max;
    return scrollPos;
}

/**
 * Where a script scroll to `target` lands: as Gecko does on a scaled display,
 * the target cut to a whole pixel, then put on the screen's own pixels.
 */
const landing = (target: number) => (ROUNDS ? Math.round(Math.trunc(target) * DPR) / DPR : target);

/** Where the question's request sits once it is at the top of the view: 4px into its run, 8px of margin. */
const pinnedAt = (id: string) => runTop(id) + 4 - 8;

const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}),
}) as DOMRect;

function override(target: object, key: string, descriptor: PropertyDescriptor) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restores.push(() => {
        if (previous) Object.defineProperty(target, key, previous);
        else delete (target as any)[key];
    });
}

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).ResizeObserver = class {
        private readonly watched: Element[] = [];
        private readonly fire: () => void;
        constructor(callback: (entries: unknown[]) => void) {
            this.fire = () => callback(this.watched.map((target) => ({
                target,
                contentRect: { height: target.id === 'alphainz-thread-view' ? VIEW : 0 },
            })));
        }
        observe(element: Element) {
            this.watched.push(element);
            if (!observers.has(element)) observers.set(element, new Set());
            observers.get(element)!.add(this.fire);
        }
        disconnect() {
            for (const element of this.watched) observers.get(element)?.delete(this.fire);
            this.watched.length = 0;
        }
    };
    observers.clear();
    scrollStarts.length = 0;
    trueStarts.length = 0;
    writes.length = 0;
    DPR = 1;
    ROUNDS = false;
    VIEW = 400;
    (Zotero as any).__alphainzJotaiStore = undefined;
    (Zotero.getMainWindow as any).mockReturnValue(window);
    document.body.innerHTML = '';
    heights.clear();
    lines.clear();
    lineHeights.clear();
    (globalThis as any).__twinLines = new Set<string>();
    atTopEdge = null;
    scrollPos = 0;
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.resetModules();

    const isView = (el: Element) => el.id === 'alphainz-thread-view';
    override(HTMLElement.prototype, 'clientHeight', { get(this: HTMLElement) { return isView(this) ? VIEW : 0; } });
    // As wide as a narrow pane; a test may lay it out at another width.
    override(HTMLElement.prototype, 'clientWidth', { get(this: HTMLElement) { return isView(this) ? 300 : 0; } });
    override(HTMLElement.prototype, 'scrollHeight', {
        get(this: HTMLElement) { return isView(this) ? (ROUNDS ? Math.round(scrollHeight()) : scrollHeight()) : 0; },
    });
    override(window, 'devicePixelRatio', { get() { return DPR; } });
    override(document, 'elementFromPoint', { value: () => atTopEdge });
    // A browser clamps the position when the page gets shorter under it.
    override(Element.prototype, 'scrollTop', {
        get(this: Element) { return isView(this) ? (ROUNDS ? Math.round(scrolled()) : scrolled()) : 0; },
        set(this: Element, value: number) {
            if (!isView(this)) return;
            writes.push(value);
            scrollPos = Math.min(maxScroll(), Math.max(0, landing(value)));
        },
    });
    override(HTMLElement.prototype, 'scrollTo', {
        value(this: HTMLElement, options: { top: number }) {
            scrollStarts.push(this.scrollTop);
            trueStarts.push(scrolled());
            scrollPos = Math.min(maxScroll(), Math.max(0, landing(options.top)));
        },
    });
    const original = Element.prototype.getBoundingClientRect;
    override(Element.prototype, 'getBoundingClientRect', {
        value(this: Element) {
            if (isView(this)) return rect(0, VIEW);
            const scrolledNow = scrolled();
            // The column starts at the top of the page; the room sits where the conversation ends.
            if ((this as HTMLElement).classList?.contains('thread-column')) {
                return rect(-scrolledNow, contentHeight() + roomHeight());
            }
            if ((this as HTMLElement).classList?.contains('thread-reading-room')) {
                return rect(contentHeight() - scrolledNow, roomHeight());
            }
            const match = /^(run|user-request|line)-(.+)$/.exec(this.id);
            if (!match) return original.call(this);
            const [, kind, id] = match;
            if (kind === 'line' && (this as HTMLElement).hasAttribute('data-twin')) return rect(runTop(id) + 60 - scrolledNow, 30);
            if (kind === 'line') return rect(runTop(id) + (lines.get(id) ?? 300) - scrolledNow, lineHeights.get(id) ?? 20);
            return kind === 'run'
                ? rect(runTop(id) - scrolledNow, heights.get(id) ?? 100)
                : rect(runTop(id) + 4 - scrolledNow, 40);
        },
    });
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    while (restores.length) restores.pop()!();
    delete (globalThis as any).ResizeObserver;
    vi.restoreAllMocks();
});

function makeRun(id: string, status: AgentRunStatus = 'completed', overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: `Question ${id}` },
        status,
        model_messages: [{ kind: 'response', run_id: id, parts: [{ part_kind: 'text', content: `${id} ${status}` }] }],
        created_at: '2026-10-13T14:32:00',
        consent_to_share: false,
        model_name: 'test-model',
        ...overrides,
    } as AgentRun;
}

/** A thread with `q1` answered (600px tall), open and settled at its end. */
async function openThread(earlier: Record<string, number> = { q1: 600 }) {
    Object.entries(earlier).forEach(([id, h]) => heights.set(id, h));
    const { store } = await import('../../../react/store');
    const atoms = await import('@beaver/agent-core/run-state/atoms');
    store.set(atoms.currentThreadIdAtom, 'thread-1');
    store.set(atoms.threadRunsAtom, Object.keys(earlier).map((id) => makeRun(id)));
    const { Provider } = await import('jotai');
    const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
    // A ResizeObserver reports the size it starts with; the view's settles in.
    await resized(view());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    scrollPos = maxScroll();
    // What opening the conversation scrolled is not what a test looks at.
    writes.length = 0;
    const later = (ms: number) => { now += ms; };

    /** The question `id` streaming, `height` tall so far. */
    const stream = async (id: string, height: number, status: AgentRunStatus = 'in_progress') => {
        heights.set(id, height);
        await act(async () => { store.set(atoms.activeRunAtom, makeRun(id, status)); });
    };
    /** The reader's scroll is on its way through `top`. */
    const scrollThrough = async (top: number) => {
        await act(async () => {
            scrollPos = Math.min(maxScroll(), Math.max(0, top));
            view().dispatchEvent(new Event('scroll'));
        });
    };
    /** The reader scrolls the view to `top`, where it comes to rest. */
    const scrollTo = async (top: number) => {
        await scrollThrough(top);
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
    };
    return { store, atoms, stream, scrollThrough, scrollTo, later };
}

const flashed = (id: string) => document.getElementById(`user-request-${id}`)!.hasAttribute(FLASH);

describe('sending a question', () => {
    it('brings it to the top of the view, with room below for the answer', async () => {
        const { stream } = await openThread();
        await stream('q2', 60);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(roomHeight()).toBe(pinnedAt('q2') + VIEW - contentHeight());
        // A question just sent needs no pointing at.
        expect(flashed('q2')).toBe(false);
    });
});

describe('while the answer streams', () => {
    it('never follows it down; the answer fills the room instead', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;

        await stream('q2', 300);
        expect(view().scrollTop).toBe(pinned);
        expect(roomHeight()).toBe(pinned + VIEW - contentHeight());

        await stream('q2', 1400);
        expect(view().scrollTop).toBe(pinned);
        expect(roomHeight()).toBe(0);
    });

    it('gives back the room the reader scrolls away from, so scrolling down ends at the last line', async () => {
        const { stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;

        await scrollTo(pinned - 150);
        expect(roomHeight()).toBe(pinned - 150 + VIEW - contentHeight());
        // Back down: the conversation ends where the screen does.
        await scrollTo(pinned);
        expect(view().scrollTop).toBe(pinned - 150);
        expect(scrollHeight() - view().scrollTop).toBe(VIEW);
    });

    it('leaves the page alone while the reader is still scrolling, so a smooth wheel scroll runs its course', async () => {
        const { stream, scrollThrough, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        const length = scrollHeight();

        for (const step of [10, 40, 90, 160]) {
            await scrollThrough(pinned - step);
            expect(scrollHeight()).toBe(length);
        }
        // Back down within the same scroll: the room is still all there.
        await scrollThrough(pinned);
        expect(view().scrollTop).toBe(pinned);
        expect(writes).toEqual([]);
    });

    it('waits for the scrollbar thumb to be let go, however long it is held still', async () => {
        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { stream, scrollThrough, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;

        // A press on the view itself, not on what it shows: its scrollbar.
        await act(async () => { view().dispatchEvent(new Event('pointerdown')); });
        await scrollThrough(pinned - 120);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 300)); });
        expect(reach()).toBe(pinned);

        await act(async () => { window.dispatchEvent(new Event('pointerup')); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(reach()).toBe(pinned - 120);
    });

    it('gives the room back after a pause when the scroll sends no scrollend, as a wheel that scrolls in steps', async () => {
        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { stream, scrollThrough, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;

        await scrollThrough(pinned - 60);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS - 200)); });
        await scrollThrough(pinned - 120);
        // Still going: no room given back mid-scroll.
        expect(reach()).toBe(pinned);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(reach()).toBe(pinned - 120);
    });

    it('takes a pause for the end of a scroll where the browser sends no scrollend', async () => {
        // The window's own scrollend handler property is how its support shows.
        let owner: any = window;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, 'onscrollend')) owner = Object.getPrototypeOf(owner);
        const descriptor = Object.getOwnPropertyDescriptor(owner, 'onscrollend')!;
        delete owner.onscrollend;
        restores.push(() => Object.defineProperty(owner, 'onscrollend', descriptor));
        expect('onscrollend' in window).toBe(false);

        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { stream, scrollThrough, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;

        await scrollThrough(pinned - 120);
        expect(reach()).toBe(pinned);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(reach()).toBe(pinned - 120);
    });

    it('does not cut a jump short when a scroll comes to rest on its way', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        const pinned = pinnedAt('q2');
        // The send's smooth scroll is still under way, and a scrollend arrives halfway.
        scrollPos = pinned - 300;
        await act(async () => {
            view().dispatchEvent(new Event('scroll'));
            view().dispatchEvent(new Event('scrollend'));
        });
        expect(reach()).toBe(pinned);

        // The jump is over by now; had the reader stopped it there, the room below goes.
        const { JUMP_LOCK_MS } = await import('../../../react/utils/conversationNavigation');
        later(JUMP_LOCK_MS);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, JUMP_LOCK_MS + 40)); });
        expect(reach()).toBe(pinned - 300);
    });

    it('does not give the room back under a scroll that starts while a jump is held', async () => {
        const { stream, scrollThrough, later } = await openThread();
        await stream('q2', 60);
        const pinned = pinnedAt('q2');
        // The send's scroll comes to rest early; giving room back waits for the hold.
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        // The reader starts scrolling up before the hold is over, and is still scrolling when it runs out.
        later(400);
        await scrollThrough(pinned - 40);
        for (const step of [50, 60, 70]) {
            later(300);
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
            await scrollThrough(pinned - step);
        }
        expect(reach()).toBe(pinned);
        // That scroll's own end gives the room back.
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        expect(reach()).toBe(pinned - 70);
    });

    it('scrolls nothing from script as the answer streams', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        const minimum = column().style.minHeight;
        scrollStarts.length = 0;

        for (const height of [75, 120, 260, 310, 900, 1400]) {
            await stream('q2', height);
            await resized(document.getElementById('run-q2')!);
            await resized(room());
            await resized(column());
            expect(view().scrollTop).toBe(pinned);
        }
        expect(column().style.minHeight).toBe(minimum);
        expect(scrollStarts).toEqual([]);
        expect(writes).toEqual([]);
    });
});

describe('when the answer is finished', () => {
    it('brings the question back up and marks it as the steps fold, wherever the reader went', async () => {
        const { stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(1500);
        later(1000);

        // The steps fold: the run is shorter now.
        await stream('q2', 500, 'completed');
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(flashed('q2')).toBe(true);
    });

    it('still does when the finished run leaves the active slot before it reaches the history', async () => {
        const { store, atoms, stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(1500);
        later(1000);

        // Seen live: for a moment the finished run is in neither list.
        heights.set('q2', 500);
        await act(async () => { store.set(atoms.activeRunAtom, null); });
        await act(async () => { store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2', 'completed')]); });
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(flashed('q2')).toBe(true);
    });

    it('only marks the question when every step stays shown', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        const { streamDisplayModeAtom } = await import('../../../react/atoms/streamDisplay');
        store.set(streamDisplayModeAtom, 'expanded');
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(1300);
        later(1000);

        await stream('q2', 1400, 'completed');
        expect(view().scrollTop).toBe(1300);
        expect(flashed('q2')).toBe(true);
    });

    it('counts a stopped answer as finished, and a pause for approval as not', async () => {
        const { stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(1500);
        later(1000);

        await stream('q2', 1400, 'awaiting_deferred');
        expect(view().scrollTop).toBe(1500);
        expect(flashed('q2')).toBe(false);

        await stream('q2', 1400, 'canceled');
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(flashed('q2')).toBe(true);
    });

    it('brings up the question a continued answer belongs to', async () => {
        const { stream, later } = await openThread({ q1: 600, q2: 300 });
        // The question failed and was continued: the continuation has no question of its own.
        const continuation = { user_prompt: { content: '', is_resume: true } } as Partial<AgentRun>;
        const { store, atoms } = await import('../../../react/store').then(async ({ store }) => ({
            store, atoms: await import('@beaver/agent-core/run-state/atoms'),
        }));
        heights.set('c2', 200);
        await act(async () => { store.set(atoms.activeRunAtom, makeRun('c2', 'in_progress', continuation)); });
        later(1000);
        heights.set('c2', 250);
        await act(async () => { store.set(atoms.activeRunAtom, makeRun('c2', 'completed', continuation)); });
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(flashed('q2')).toBe(true);
        void stream;
    });
});

describe('opening a conversation', () => {
    it('shows its end, with no room', async () => {
        await openThread({ q1: 600, q2: 300 });
        expect(roomHeight()).toBe(0);
        expect(view().scrollTop).toBe(maxScroll());
    });

    it('keeps no room from the conversation before', async () => {
        const { store, atoms, stream } = await openThread();
        await stream('q2', 60);
        expect(roomHeight()).toBeGreaterThan(0);

        heights.set('x1', 300);
        await act(async () => {
            store.set(atoms.activeRunAtom, null);
            store.set(atoms.currentThreadIdAtom, 'thread-2');
            store.set(atoms.threadRunsAtom, [makeRun('x1')]);
        });
        expect(roomHeight()).toBe(0);
    });
});

describe('around a question brought up to read', () => {
    it('keeps it at the top when the view grows right after the send, as the composer shrinks back', async () => {
        const { stream } = await openThread();
        await stream('q2', 60);
        const pinned = pinnedAt('q2');
        const room = roomHeight();

        // A three-line draft goes back to one line: the view is 40px taller,
        // and the browser pulls the scroll position up to what is left.
        VIEW = 440;
        await resized(view());
        expect(view().scrollTop).toBe(pinned);
        expect(roomHeight()).toBe(room + 40);
    });

    it('keeps it there when the pane is made taller later on', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        VIEW = 480;
        await resized(view());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('lets a question reach the top in a conversation shorter than the screen', async () => {
        VIEW = 800;
        const { stream } = await openThread({ q1: 300 });
        await stream('q2', 90);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(roomHeight()).toBe(pinnedAt('q2') + 800 - contentHeight());
    });

    it('does not cut the room from under the view before an upward jump scrolls', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const from = view().scrollTop;
        scrollStarts.length = 0;

        const { jumpToRun } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await act(async () => { jumpToRun(view(), 'q1', userScrolledAtom); });
        expect(scrollStarts[0]).toBe(from);
        expect(view().scrollTop).toBe(0);
    });

    it('does not drop it down the screen when the steps fold away at the end', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 250);
        scrollStarts.length = 0;

        await stream('q2', 120, 'completed');
        // Already back in place when the finishing jump starts: no dip.
        expect(scrollStarts).toEqual([pinnedAt('q2')]);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(flashed('q2')).toBe(true);
    });

    it('notes when the answer runs past the bottom, so the scroll-down button shows', async () => {
        const { store, stream, later } = await openThread();
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await stream('q2', 60);
        later(1000);
        expect(store.get(userScrolledAtom)).toBe(false);
        await stream('q2', 1400);
        expect(store.get(userScrolledAtom)).toBe(true);
    });

    it('hides the scroll-down button once the reader reaches the end of an answer that ran past the bottom', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        expect(store.get(userScrolledAtom)).toBe(true);

        await scrollTo(maxScroll());
        expect(store.get(userScrolledAtom)).toBe(false);
    });

    it('shows the scroll-down button on the way up out of the room, and hides it once the room below the resting view is given back', async () => {
        const { store, stream, scrollThrough, later } = await openThread();
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        // The send's own last scroll event, then the reader's way up.
        await scrollThrough(pinned);
        await scrollThrough(pinned - 100);
        await scrollThrough(pinned - 200);
        expect(store.get(userScrolledAtom)).toBe(true);

        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        expect(maxScroll() - view().scrollTop).toBe(0);
        expect(store.get(userScrolledAtom)).toBe(false);
    });

    it('marks it, not the last question, as the one being read', async () => {
        // The last two exchanges are short: q1 reaches the top only with room.
        const { later } = await openThread({ q0: 800, q1: 150, q2: 120 });
        const { jumpToRun } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await act(async () => { jumpToRun(view(), 'q1', userScrolledAtom); });
        later(1000);
        expect(view().scrollTop).toBe(pinnedAt('q1'));
        expect(roomHeight()).toBeGreaterThan(0);
        // The room keeps the view at the end, and still q1 is the one being read.
        const { readCurrentTurnIndex } = await import('@beaver/agent-ui/conversation/useCurrentTurn');
        expect(readCurrentTurnIndex(view(), ['q0', 'q1', 'q2'])).toBe(1);
    });
});

/** The sidebar is mounted afresh (another tab, shown again): a new view, scrolled to the top. */
async function remount(store: any) {
    act(() => root!.unmount());
    scrollPos = 0;
    const { Provider } = await import('jotai');
    const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
    await resized(view());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
}

describe('coming back to a place, again and again', () => {
    it('follows the reader on from a question brought back that needed no room', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400, 'completed');
        later(1000);
        await remount(store);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        later(1000);
        // The reader reads on in that pane, far below the question, then comes back again.
        await scrollTo(1500);
        later(1000);
        await remount(store);
        expect(view().scrollTop).toBe(1500);
    });

    it('lets the scroll-down button end the question\'s place', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        const { currentThreadScrollPositionAtom } = await import('../../../react/atoms/threads');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400, 'completed');
        later(1000);
        await remount(store);
        later(1000);
        // As the scroll-down button does.
        store.set(userScrolledAtom, false);
        store.set(currentThreadScrollPositionAtom, null);
        await scrollTo(maxScroll());
        later(1000);
        const end = view().scrollTop;
        await remount(store);
        expect(view().scrollTop).toBe(end);
    });

    it('takes the scroll that puts the view back at a place for no scroll of the reader\'s', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 50);
        later(1000);
        const place = view().scrollTop;
        // The other pane: narrower, so q1 wraps taller there and the place needs no room.
        heights.set('q1', 900);
        await remount(store);
        // Gecko reports the scroll of the restore itself, as any script scroll.
        await act(async () => {
            view().dispatchEvent(new Event('scroll'));
            view().dispatchEvent(new Event('scrollend'));
        });
        later(1000);
        // Back in the first pane: the same place, room and all.
        heights.set('q1', 600);
        await remount(store);
        expect(view().scrollTop).toBe(place);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('takes the scroll that puts the view back at a place for no scroll of the reader\'s when it ends without a scrollend', async () => {
        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { store, stream, scrollTo, later } = await openThread();
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 50);
        later(1000);
        const place = view().scrollTop;
        heights.set('q1', 900);
        await remount(store);
        // The restore's scroll is reported late (a busy frame), and no scrollend reaches the view: it comes to rest after a pause.
        later(600);
        await act(async () => { view().dispatchEvent(new Event('scroll')); });
        later(SETTLE_FALLBACK_MS + 20);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        later(1000);
        heights.set('q1', 600);
        await remount(store);
        expect(view().scrollTop).toBe(place);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('takes a scroll that something else starts just after the view is put back, to somewhere else, as that scroll', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 150);
        later(1000);
        const place = view().scrollTop;
        // A new view: the place is put back, Gecko reports that scroll, then the view's first size comes in.
        act(() => root!.unmount());
        scrollPos = 0;
        const { Provider } = await import('jotai');
        const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
        await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(place);
        // Something other than the reader scrolls the view up a little (a card brought into view).
        later(400);
        scrollPos = place - 100;
        await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
        // Later a run above grows: the view stays on what it shows now.
        later(2000);
        heights.set('q0', 340);
        await resized(room());
        expect(view().scrollTop).toBe(place - 100 + 40);
    });

    it('takes a scroll that takes the view somewhere else before the one putting it back is reported for that scroll', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 150);
        later(1000);
        const place = view().scrollTop;
        // A new view puts the place back; before that scroll is reported, something else scrolls the view up.
        act(() => root!.unmount());
        scrollPos = 0;
        const { Provider } = await import('jotai');
        const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
        scrollPos = place - 100;
        await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(place - 100);
        later(2000);
        heights.set('q0', 340);
        await resized(room());
        expect(view().scrollTop).toBe(place - 100 + 40);
    });

    it('keeps a resting place on the line it was on when steps above it in its run folded or opened meanwhile', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        // The reader rests 300px up from q2, inside q1's answer (a box with an id of its own).
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const onScreen = () => document.getElementById('line-q1')!.getBoundingClientRect().top;
        const before = onScreen();
        // Meanwhile, in another conversation, the steps are folded: 210px less of q1, all of it above the line.
        heights.set('q1', 1790);
        lines.set('q1', 1690 - 210);
        await remount(store);
        expect(onScreen()).toBe(before);
        expect(roomHeight()).toBeGreaterThan(0);
        // And opened again, taller than before.
        later(1000);
        heights.set('q1', 2560);
        lines.set('q1', 1690 + 560);
        await remount(store);
        expect(onScreen()).toBe(before);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('keeps a question brought back mid-answer from dipping when its steps fold', async () => {
        const { store, stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        later(1000);
        await remount(store);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        scrollStarts.length = 0;
        await stream('q2', 120, 'completed');
        expect(scrollStarts).toEqual([pinnedAt('q2')]);
    });

    it('keeps the place of a reader resting with a row between runs at the top edge', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60, 'completed');
        later(1000);
        // A row between runs (as the compaction marker is), at the view's top edge.
        const marker = document.createElement('div');
        column().insertBefore(marker, document.getElementById('run-q2'));
        atTopEdge = marker;
        await scrollTo(pinnedAt('q2') - 30);
        later(1000);
        const place = view().scrollTop;
        marker.remove();
        atTopEdge = null;
        await remount(store);
        expect(view().scrollTop).toBe(place);
    });

    it('keeps the room of the question being answered when the rail brings it back up', async () => {
        const { stream, scrollTo, later } = await openThread();
        const { jumpToRun, JUMP_LOCK_MS } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(1500);
        later(1000);
        await act(async () => { jumpToRun(view(), 'q2', userScrolledAtom); });
        await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
        later(JUMP_LOCK_MS + 10);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, JUMP_LOCK_MS + 40)); });
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        scrollStarts.length = 0;
        await stream('q2', 120, 'completed');
        expect(scrollStarts).toEqual([pinnedAt('q2')]);
    });
});

describe('places that are left behind', () => {
    it('lets a link that opens the conversation at another run end the old place', async () => {
        const { store, atoms, stream, later } = await openThread({ q0: 600, q1: 600 });
        await stream('q2', 60);
        later(1000);
        // To another conversation, then a link opens this one at q1 (as a note's link back does).
        heights.set('x1', 300);
        await act(async () => {
            store.set(atoms.activeRunAtom, null);
            store.set(atoms.currentThreadIdAtom, 'thread-2');
            store.set(atoms.threadRunsAtom, [makeRun('x1')]);
        });
        override(Element.prototype, 'scrollIntoView', {
            value(this: Element) {
                const match = /^run-(.+)$/.exec(this.id);
                if (!match) return;
                scrollPos = Math.min(maxScroll(), runTop(match[1]));
                view().dispatchEvent(new Event('scroll'));
                view().dispatchEvent(new Event('scrollend'));
            },
        });
        const { pendingScrollToRunAtom } = await import('../../../react/atoms/threads');
        later(1000);
        await act(async () => {
            store.set(pendingScrollToRunAtom, 'q1');
            store.set(atoms.currentThreadIdAtom, 'thread-1');
            store.set(atoms.threadRunsAtom, [makeRun('q0'), makeRun('q1'), makeRun('q2')]);
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        const atLink = view().scrollTop;
        expect(atLink).toBe(runTop('q1'));
        later(1000);
        await remount(store);
        expect(view().scrollTop).toBe(atLink);
    });

    it('forgets a place the conversation no longer has, so a later return goes where the reader went', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        // Laid out again with q1 shorter (its steps folded): the place inside it is gone.
        heights.set('q1', 1000);
        await remount(store);
        await scrollTo(250);
        later(1000);
        heights.set('q1', 2000);
        await remount(store);
        expect(view().scrollTop).toBe(250);
    });

    it('puts a resting place the same share of the way into its run at another width', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        const width = (px: number) => override(HTMLElement.prototype, 'clientWidth', {
            get(this: HTMLElement) { return this.id === 'alphainz-thread-view' ? px : 0; },
        });
        width(300);
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const share = view().scrollTop / 2000;
        // The other pane is wider: q1 is shorter there.
        width(380);
        heights.set('q1', 1750);
        heights.set('q2', 50);
        await remount(store);
        expect(view().scrollTop).toBeCloseTo(share * 1750, 6);
    });

    it('does not find a place again by an id two boxes of its run share', async () => {
        (globalThis as any).__twinLines = new Set(['q1']);
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        lines.set('q1', 1690);
        atTopEdge = document.querySelector('#run-q1 > #line-q1:not([data-twin])');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const place = view().scrollTop;
        await remount(store);
        expect(view().scrollTop).toBe(place);
    });

    it('does not find a place again by an id that two boxes of its run share by the time it comes back', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const place = view().scrollTop;
        // Drawn again, the run has a second box with that id, ahead of the first.
        (globalThis as any).__twinLines = new Set(['q1']);
        await remount(store);
        expect(view().scrollTop).toBe(place);
    });

    it('takes the scroll that follows a change while the view is put back for the view\'s own, whatever runs before it is reported', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        const width = (px: number) => override(HTMLElement.prototype, 'clientWidth', {
            get(this: HTMLElement) { return this.id === 'alphainz-thread-view' ? px : 0; },
        });
        width(300);
        await stream('q2', 60, 'completed');
        later(1000);
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const place = view().scrollTop;
        // The other pane opens narrow: q1 wraps much taller there, and the place needs no blank below it.
        act(() => root!.unmount());
        scrollPos = 0;
        width(120);
        heights.set('q1', 2500);
        lines.set('q1', 2028);
        lineHeights.set('q1', 24);
        const { Provider } = await import('jotai');
        const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
        // Gecko reports the scroll that put the place back.
        await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
        // The pane takes its width; the room follows, at rest, and puts the view back on its line straight away…
        width(200);
        heights.set('q1', 2300);
        lines.set('q1', 1880);
        lineHeights.set('q1', 22);
        await resized(room());
        // …and the view's own restore, 50ms after its first size, runs before that scroll is reported.
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
        await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
        // Back in the first pane: the same place, room and all.
        later(1000);
        width(300);
        heights.set('q1', 2000);
        lines.set('q1', 1690);
        lineHeights.set('q1', 20);
        await remount(store);
        expect(view().scrollTop).toBeCloseTo(place, 6);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('puts a resting place back once a pane that opens a few pixels wide has taken its width', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        const width = (px: number) => override(HTMLElement.prototype, 'clientWidth', {
            get(this: HTMLElement) { return this.id === 'alphainz-thread-view' ? px : 0; },
        });
        width(300);
        await stream('q2', 60, 'completed');
        later(1000);
        // The reader rests 6px into a 20px box of q1's: 30% of the way into it.
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        // The other pane opens 13px wide for a moment: nothing in it is laid out to be read.
        width(13);
        heights.set('q1', 10);
        heights.set('q2', 10);
        lines.set('q1', 5);
        lineHeights.set('q1', 0);
        await remount(store);
        // The browser reports a scroll as it lays the narrow pane out.
        await act(async () => { view().dispatchEvent(new Event('scroll')); });
        // Then it takes its width.
        width(380);
        heights.set('q1', 1750);
        heights.set('q2', 50);
        lines.set('q1', 1480);
        lineHeights.set('q1', 18);
        const share = () => {
            const box = document.getElementById('line-q1')!.getBoundingClientRect();
            return -box.top / box.height;
        };
        await resized(view());
        // Put back before it is painted, not a moment later.
        expect(share()).toBeCloseTo(0.3, 6);
        await resized(room());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(share()).toBeCloseTo(0.3, 6);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('keeps a place put back while the pane is still taking its width the same share of the way into its box', async () => {
        const { store, stream, scrollTo, later } = await openThread({ q1: 2000 });
        const width = (px: number) => override(HTMLElement.prototype, 'clientWidth', {
            get(this: HTMLElement) { return this.id === 'alphainz-thread-view' ? px : 0; },
        });
        width(300);
        await stream('q2', 60, 'completed');
        later(1000);
        // The reader rests 6px into a 20px box of q1's: 30% of the way into it.
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const share = () => {
            const box = document.getElementById('line-q1')!.getBoundingClientRect();
            return -box.top / box.height;
        };
        expect(share()).toBeCloseTo(0.3, 6);
        // The other pane opens narrow, so the box wraps to 100px, and only then takes its width.
        width(120);
        lineHeights.set('q1', 100);
        heights.set('q1', 2080);
        await remount(store);
        expect(share()).toBeCloseTo(0.3, 6);
        width(300);
        lineHeights.set('q1', 20);
        heights.set('q1', 2000);
        await resized(room());
        expect(share()).toBeCloseTo(0.3, 6);
        expect(roomHeight()).toBeGreaterThan(0);
    });
});

describe('a view at rest by a box that changes size', () => {
    it('gives nothing back for a scrollend that ends no scroll', async () => {
        const { stream, scrollTo, later } = await openThread({ q0: 300, q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const kept = reach();
        expect(roomHeight()).toBeGreaterThan(0);
        // The layout changes so that no blank is needed below the view, and the browser
        // sends a scrollend once more, with no scroll before it.
        VIEW = 300;
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        expect(reach()).toBe(kept);
    });

    it('stays where it is in the box when the box grows below it at the same width', async () => {
        const { stream, scrollTo, later } = await openThread({ q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        // The reader rests 6px into a box of q1's.
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const at = view().scrollTop;
        // More of the box is laid out below the reader's line.
        lineHeights.set('q1', 100);
        heights.set('q1', 2080);
        await resized(room());
        expect(view().scrollTop).toBe(at);
    });

    it('stays the same distance above the box it rests over when a new width rewraps it', async () => {
        const { stream, scrollTo, later } = await openThread({ q1: 2000 });
        const width = (px: number) => override(HTMLElement.prototype, 'clientWidth', {
            get(this: HTMLElement) { return this.id === 'alphainz-thread-view' ? px : 0; },
        });
        width(300);
        await stream('q2', 60, 'completed');
        later(1000);
        // The first box at or below the view's top edge starts 6px down.
        lines.set('q1', 1702);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const below = () => document.getElementById('line-q1')!.getBoundingClientRect().top;
        expect(below()).toBe(6);
        width(200);
        lineHeights.set('q1', 100);
        heights.set('q1', 2080);
        await resized(room());
        expect(below()).toBe(6);
    });

    it('keeps its room through a layout that needs none, and is on the same line when the layout comes back', async () => {
        const { stream, scrollTo, later } = await openThread({ q0: 300, q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const onScreen = () => document.getElementById('line-q1')!.getBoundingClientRect().top;
        const before = onScreen();
        expect(roomHeight()).toBeGreaterThan(0);
        /** The layout changes; the browser scrolls along first (not quite as far), then the view put back reports its own scroll. */
        const relayout = async (view_: number, q0: number, along: number) => {
            VIEW = view_;
            heights.set('q0', q0);
            scrollPos += along;
            await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
            await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
            await resized(room());
        };
        // Zotero stacks its panes: a shorter view, which needs no blank below it here, and q0 rewrapped taller.
        await relayout(197, 500, 180);
        expect(onScreen()).toBe(before);
        expect(reach()).not.toBe(null);
        later(1000);
        await relayout(400, 300, -190);
        expect(onScreen()).toBe(before);
        expect(roomHeight()).toBeGreaterThan(0);
    });
});

describe('the reader\'s scroll and the layout\'s', () => {
    /** The runs above rewrap much taller; the browser scrolls along as far as the page reaches and reports it first. */
    async function stackedLayout() {
        heights.set('q1', 7300);
        scrollPos = Math.min(scrollPos + 7000, maxScroll());
        await act(async () => {
            view().dispatchEvent(new Event('scroll'));
            view().dispatchEvent(new Event('scrollend'));
        });
        await resized(room());
    }

    it('does not take a wheel turned long before (that scrolled nothing) for the reader\'s part in a later layout scroll', async () => {
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        // At the reach the view cannot go further down: the wheel scrolls nothing.
        await act(async () => { view().dispatchEvent(new Event('wheel')); });
        later(5000);
        await stackedLayout();
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('does not take a click on what the view shows for the reader scrolling', async () => {
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        const link = document.getElementById('line-q2')!;
        await act(async () => { link.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        await stackedLayout();
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('keeps following what changes above a question after a jump that found it in place and scrolled nothing', async () => {
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        // The send's scroll ends while the jump is held, and the answer stops at once.
        await act(async () => {
            view().dispatchEvent(new Event('scroll'));
            view().dispatchEvent(new Event('scrollend'));
        });
        later(300);
        await stream('q2', 120, 'error');
        later(2000);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); });
        heights.set('q1', 340);
        await resized(room());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('lets a reader who scrolls straight back from a jump up keep reading where they were', async () => {
        const { store, stream, scrollThrough, later } = await openThread({ q0: 300, q1: 300 });
        const { jumpToRun } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        await act(async () => { jumpToRun(view(), 'q1', userScrolledAtom); });
        later(200);
        await act(async () => { view().dispatchEvent(new Event('wheel')); });
        await scrollThrough(pinned);
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        later(700);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
        expect(view().scrollTop).toBe(pinned);
        // Everything above rewraps a little taller: the view stays on q2, not back on q1.
        heights.set('q0', 340);
        await resized(room());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        // And coming back to the view, it is q2's place.
        later(1000);
        await remount(store);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('lets a reader who scrolls straight back from the finishing jump keep reading the answer\'s end', async () => {
        const { store, stream, scrollThrough, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(maxScroll());
        later(1000);
        await stream('q2', 900, 'completed');
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        later(200);
        await act(async () => { view().dispatchEvent(new Event('wheel')); });
        await scrollThrough(maxScroll());
        const end = view().scrollTop;
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        later(700);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
        later(1000);
        await remount(store);
        expect(view().scrollTop).toBe(end);
    });
});

describe('coming back to the view', () => {
    /** The pane is hidden and shown again: the browser forgets a hidden view's scroll position. */
    async function hideAndShow() {
        VIEW = 0;
        await resized(view());
        scrollPos = 0;
        VIEW = 400;
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    }

    it('returns a reader who left from inside the room to the same place, room and all', async () => {
        const { stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await scrollTo(pinnedAt('q2') - 30);
        const place = view().scrollTop;

        await hideAndShow();
        expect(view().scrollTop).toBe(place);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('returns a reader who left from inside the room to the same place though an answer streams on as the view comes back', async () => {
        const { stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await scrollTo(pinnedAt('q2') - 30);
        const place = view().scrollTop;
        VIEW = 0;
        await resized(view());
        scrollPos = 0;
        VIEW = 400;
        await resized(view());
        // A part of the answer arrives before the view's restore is due.
        await stream('q2', 80);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(place);
    });

    it('comes back to the question it was on, not to a pixel position the other pane saved', async () => {
        const { store, stream, later } = await openThread();
        const { currentThreadScrollPositionAtom } = await import('../../../react/atoms/threads');
        await stream('q2', 60);
        later(1000);
        // The other pane, laid out at its own width, saves a position past this pane's end.
        store.set(currentThreadScrollPositionAtom, maxScroll() + 600);

        await hideAndShow();
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('comes back to the question, not to an earlier pixel position the other pane saved', async () => {
        const { store, stream, later } = await openThread();
        const { currentThreadScrollPositionAtom } = await import('../../../react/atoms/threads');
        await stream('q2', 60);
        later(1000);
        store.set(currentThreadScrollPositionAtom, pinnedAt('q2') - 300);

        await hideAndShow();
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('comes back to the question at the top, room and all, after its answer came in with the view gone', async () => {
        const { store, stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        act(() => root!.unmount());
        // The answer streams on (and finishes) while the sidebar is away: no scroll of the view.
        heights.set('q2', 220);
        const atoms = await import('@beaver/agent-core/run-state/atoms');
        store.set(atoms.activeRunAtom, makeRun('q2', 'in_progress'));
        scrollPos = 0;
        const { Provider } = await import('jotai');
        const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(roomHeight()).toBe(pinnedAt('q2') + VIEW - contentHeight());
    });

    it('returns a reader who left from inside the room to the same place in a new view of the same width (the window opened again)', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await scrollTo(pinnedAt('q2') - 30);
        const place = view().scrollTop;
        act(() => root!.unmount());
        scrollPos = 0;
        const { Provider } = await import('jotai');
        const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
        expect(view().scrollTop).toBe(place);
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(place);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('returns a reader who left a conversation from inside the room to the same place when they come back to it', async () => {
        const { store, atoms, stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await scrollTo(pinnedAt('q2') - 30);
        const place = view().scrollTop;
        heights.set('x1', 300);
        await act(async () => {
            store.set(atoms.activeRunAtom, null);
            store.set(atoms.currentThreadIdAtom, 'thread-2');
            store.set(atoms.threadRunsAtom, [makeRun('x1')]);
        });
        later(1000);
        await act(async () => {
            store.set(atoms.currentThreadIdAtom, 'thread-1');
            store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]);
        });
        expect(view().scrollTop).toBe(place);
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('makes no room for a place saved before the conversation got shorter', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await scrollTo(pinnedAt('q2') - 30);
        act(() => root!.unmount());
        // Closed meanwhile, the conversation got shorter (its steps folded by another display mode).
        heights.set('q1', 400);
        scrollPos = 0;
        const { Provider } = await import('jotai');
        const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(reach()).toBe(null);
        expect(view().scrollTop).toBe(maxScroll());
    });

    it('makes no room for a saved place the view is already near', async () => {
        const { store } = await openThread();
        const { currentThreadScrollPositionAtom } = await import('../../../react/atoms/threads');
        // Saved a few pixels past where the conversation now ends (it got shorter meanwhile).
        store.set(currentThreadScrollPositionAtom, maxScroll() + 4);
        VIEW = 0;
        await resized(view());
        VIEW = 400;
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(reach()).toBe(null);
        expect(roomHeight()).toBe(0);
    });
});

describe('on a display scaled to 250%, where the browser reports positions rounded to the pixel', () => {
    it('aims a question just sent at a whole pixel, so it lands there: within a pixel of the margin', async () => {
        DPR = 2.5;
        ROUNDS = true;
        // On the device grid, as Gecko keeps layout: the view rests at a true 200.4, reported as 200.
        const { stream } = await openThread({ q1: 600.4 });
        await stream('q2', 60);
        const landed = scrolled();
        expect(Number.isInteger(landed)).toBe(true);
        expect(landed).toBeLessThanOrEqual(pinnedAt('q2'));
        expect(landed).toBeGreaterThan(pinnedAt('q2') - 1);
        expect(reach()).toBe(landed);
    });

    it('starts a jump up from where the view truly is, with no snap before it', async () => {
        DPR = 2.5;
        ROUNDS = true;
        const { stream, later } = await openThread({ q1: 600.4 });
        await stream('q2', 60);
        later(1000);
        const from = scrolled();
        trueStarts.length = 0;
        const { jumpToRun } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await act(async () => { jumpToRun(view(), 'q1', userScrolledAtom); });
        expect(trueStarts[0]).toBeCloseTo(from, 6);
    });

    it('leaves the question exactly where it is when the answer is finished and its steps fold', async () => {
        DPR = 2.5;
        ROUNDS = true;
        const { stream, later } = await openThread({ q1: 600.4 });
        await stream('q2', 60);
        later(1000);
        await stream('q2', 250);
        const before = scrolled();
        await stream('q2', 120, 'completed');
        expect(scrolled()).toBeCloseTo(before, 6);
    });

    it('gives back the room below a resting view without pulling the view itself up', async () => {
        DPR = 2.5;
        ROUNDS = true;
        const { stream, scrollTo, later } = await openThread({ q1: 600.4 });
        await stream('q2', 60);
        later(1000);
        // A true position the browser reports rounded.
        await scrollTo(scrolled() - 120.2);
        const resting = scrolled();
        expect(view().scrollTop).not.toBe(resting);
        expect(reach()!).toBeGreaterThanOrEqual(resting - 1e-9);
        expect(scrolled()).toBe(resting);
    });
});

describe('the room itself', () => {
    it('is kept as the reach plus one view', async () => {
        const { stream } = await openThread();
        await stream('q2', 60);
        const value = column().style.minHeight;
        const match = /^calc\((?:100% \+ (-?[\d.]+)px|(-?[\d.]+)px \+ 100%)\)$/.exec(value);
        expect(match, value).not.toBeNull();
        expect(parseFloat(match![1] ?? match![2])).toBe(pinnedAt('q2'));
    });

    it('takes whatever the runs leave of the column, and adds nothing when there is none', () => {
        // The room is shared (@beaver/agent-ui/conversation), and so is its stylesheet.
        const css = fs.readFileSync(path.resolve(__dirname, '../../../packages/agent-ui/src/theme/agent-ui-components.css'), 'utf8');
        const utilities = fs.readFileSync(path.resolve(__dirname, '../../../packages/agent-ui/src/theme/agent-ui-utilities.css'), 'utf8');
        const rule = (sheet: string, selector: string) => {
            const at = sheet.indexOf(`${selector} {`);
            expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
            return sheet.slice(at, sheet.indexOf('}', at));
        };
        const spacer = rule(css, '.alphainz-root .thread-reading-room');
        expect(spacer).toMatch(/flex:\s*1 0 0px;/);
        expect(spacer).toMatch(/overflow-anchor:\s*none;/);
        const gap = /row-gap:\s*([\d.]+rem)/.exec(rule(utilities, '.alphainz-root .gap-4'))?.[1];
        expect(spacer).toContain(`margin-top: -${gap};`);
        // The column is the one with the gap, not the scrolling view.
        const source = fs.readFileSync(path.resolve(__dirname, '../../../react/components/agentRuns/ThreadView.tsx'), 'utf8');
        expect(source).toMatch(/className="thread-column display-flex flex-col gap-4/);
    });

    it('scrolls nothing from script while the send\'s own scroll is under way and the answer starts', async () => {
        const { stream } = await openThread();
        await stream('q2', 60);
        expect(scrollStarts).toHaveLength(1);
        writes.length = 0;
        for (const height of [75, 120, 260, 310]) {
            await stream('q2', height);
            await resized(document.getElementById('run-q2')!);
            await resized(room());
        }
        expect(scrollStarts).toHaveLength(1);
        expect(writes).toEqual([]);
    });

    it('stops watching the column once the view is gone', async () => {
        await openThread();
        const watched = [column(), room()];
        expect(watched.every((element) => (observers.get(element)?.size ?? 0) > 0)).toBe(true);
        act(() => root!.unmount());
        root = null;
        expect(watched.every((element) => (observers.get(element)?.size ?? 0) === 0)).toBe(true);
    });
});

describe('when something above a question brought up changes size', () => {
    it('keeps the question at the top: its place moves along, and the view with it', async () => {
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        expect(view().scrollTop).toBe(pinnedAt('q2'));

        // The pane gets narrower: the runs above rewrap taller.
        heights.set('q0', 360);
        heights.set('q1', 340);
        await resized(room());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(reach()).toBe(pinnedAt('q2'));

        // Wider again.
        heights.set('q0', 280);
        await resized(room());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(reach()).toBe(pinnedAt('q2'));
    });

    it('finds the question again when its run is made anew as it finishes, and keeps following it', async () => {
        const { store, atoms, stream, later } = await openThread({ q0: 300, q1: 300 });
        const { streamDisplayModeAtom } = await import('../../../react/atoms/streamDisplay');
        store.set(streamDisplayModeAtom, 'expanded');
        await stream('q2', 60);
        later(1000);
        const bubble = document.getElementById('user-request-q2');
        // Finishing, the run is for a moment in neither the active slot nor the history.
        await act(async () => { store.set(atoms.activeRunAtom, null); });
        await act(async () => { store.set(atoms.threadRunsAtom, [makeRun('q0'), makeRun('q1'), makeRun('q2', 'completed')]); });
        expect(document.getElementById('user-request-q2')).not.toBe(bubble);
        heights.set('q1', 340);
        await resized(room());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(reach()).toBe(pinnedAt('q2'));
    });

    it('stops watching the column through the frame in which it moves the reach, then watches again', async () => {
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        heights.set('q1', 340);
        await act(async () => { for (const fire of observers.get(room()) ?? []) fire(); });
        // The reach moved, resizing the column: no observer is left to be told of it in this frame.
        expect(observers.get(column())?.size ?? 0).toBe(0);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
        expect(observers.get(column())?.size ?? 0).toBeGreaterThan(0);
        heights.set('q1', 380);
        await resized(room());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('sends the send\'s own scroll on to where the question is now', async () => {
        const { stream } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        // While it scrolls there, a marker goes in above (as compaction puts one).
        heights.set('q1', 352);
        await resized(room());
        expect(scrollStarts).toHaveLength(2);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('takes the browser\'s own scroll along the layout for no scroll of the reader\'s, and keeps the room', async () => {
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        // Zotero switches to its stacked layout: the runs above rewrap much taller, and the
        // browser scrolls the view along — only as far as the page then reaches — and reports
        // that scroll's end before the resize itself.
        heights.set('q1', 7300);
        scrollPos = Math.min(scrollPos + 7000, maxScroll());
        await act(async () => {
            view().dispatchEvent(new Event('scroll'));
            view().dispatchEvent(new Event('scrollend'));
        });
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(reach()).toBe(pinnedAt('q2'));
        expect(roomHeight()).toBeGreaterThan(0);

        // The pane is shorter in that layout, too: the question stays, not pinned to the bottom.
        VIEW = 184;
        await resized(view());
        await resized(room());
        expect(view().scrollTop).toBe(pinnedAt('q2'));
    });

    it('keeps the line a resting view is on in place when something inside its run, above that line, changes size', async () => {
        const { stream, scrollTo, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        // At rest 150px above the question, with the line at the view's top edge inside q1.
        lines.set('q1', 446 - 300);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 150);
        const lineOnScreen = () => document.getElementById('line-q1')!.getBoundingClientRect().top;
        const before = lineOnScreen();

        // A step inside q1, above that line, opens (the display mode switched to show steps).
        heights.set('q1', 380);
        lines.set('q1', 446 - 300 + 80);
        await resized(room());
        expect(lineOnScreen()).toBe(before);
    });

    it('leaves where the reader\'s own scroll stopped when the layout shifts during it', async () => {
        const { stream, scrollThrough, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        // The reader turns the wheel; while that scroll runs, a run above grows.
        await act(async () => { view().dispatchEvent(new Event('wheel')); });
        await scrollThrough(pinned - 100);
        heights.set('q0', 350);
        await resized(room());
        await scrollThrough(pinned - 60);
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        expect(view().scrollTop).toBe(pinned - 60);
    });

    it('takes a wheel turned over the question rail for the reader\'s own scroll too', async () => {
        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { stream, scrollThrough, later } = await openThread({ q0: 300, q1: 300 });
        const { scrollByWheel } = await import('../../../react/utils/conversationNavigation');
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        // The rail lies over the view and passes its wheel on; meanwhile a run above grows.
        await act(async () => { scrollByWheel(view(), new WheelEvent('wheel', { deltaY: -60 })); });
        await scrollThrough(view().scrollTop);
        heights.set('q0', 350);
        await resized(room());
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        later(SETTLE_FALLBACK_MS);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(view().scrollTop).toBe(pinned - 60);
        expect(reach()).toBe(pinned - 60);
    });

    it.each([
        [[64, 64, 64]],
        [[80, 80, 80]],
        [[96, 96, 96]],
        [[64, 104, 64]],
        [[40, 152, 40]],
        [[80, 104, 80]],
    ])('comes back to the question from a quick turn up and straight back over the rail, though the smooth scroll swings (%j ms apart)', async (gaps: number[]) => {
        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { scrollByWheel } = await import('../../../react/utils/conversationNavigation');
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        // Gecko's smooth scroll: a spring that keeps its speed when it is sent somewhere else.
        let target = scrollPos;
        let velocity = 0;
        let running = false;
        const frame = () => {
            const k = 250;
            const dt = 0.008;
            velocity += (-k * (scrollPos - target) - 2 * Math.sqrt(k) * velocity) * dt;
            const next = Math.min(maxScroll(), Math.max(0, scrollPos + velocity * dt));
            const done = Math.abs(next - target) < 0.5 && Math.abs(velocity) < 5;
            scrollPos = done ? target : next;
            view().dispatchEvent(new Event('scroll'));
            if (done) {
                running = false;
                velocity = 0;
                view().dispatchEvent(new Event('scrollend'));
                return;
            }
            setTimeout(frame, 8);
        };
        override(HTMLElement.prototype, 'scrollTo', {
            value(this: HTMLElement, options: { top: number }) {
                target = Math.trunc(options.top);
                if (!running) {
                    running = true;
                    setTimeout(frame, 8);
                }
            },
        });
        for (const [i, deltaY] of [-3, -3, 3, 3].entries()) {
            await act(async () => { scrollByWheel(view(), new WheelEvent('wheel', { deltaY, deltaMode: 1 })); });
            const gap = gaps[i] ?? 0;
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, gap)); });
            later(gap);
        }
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
        later(SETTLE_FALLBACK_MS + 800);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(view().scrollTop).toBe(pinned);
        expect(reach()).toBe(pinned);
    });

    it('starts a turn over the rail again from where the view is once the reader has scrolled it another way', async () => {
        const { scrollByWheel } = await import('../../../react/utils/conversationNavigation');
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60, 'completed');
        later(1000);
        const start = view().scrollTop;
        await act(async () => { scrollByWheel(view(), new WheelEvent('wheel', { deltaY: -3, deltaMode: 1 })); });
        expect(view().scrollTop).toBe(start - 54);
        // The reader turns the wheel over the text: the view moves up another 100px.
        later(100);
        await act(async () => {
            view().dispatchEvent(new Event('wheel'));
            scrollPos -= 100;
            view().dispatchEvent(new Event('scroll'));
        });
        later(100);
        await act(async () => { scrollByWheel(view(), new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 })); });
        expect(view().scrollTop).toBe(start - 54 - 100 + 54);
    });

    it('adds up a touchpad\'s fractions of a pixel over the rail, so a turn up and straight back comes back', async () => {
        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { scrollByWheel } = await import('../../../react/utils/conversationNavigation');
        DPR = 2;
        ROUNDS = true;
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        for (const deltaY of [...Array(20).fill(-1.5), ...Array(20).fill(1.5)]) {
            await act(async () => {
                scrollByWheel(view(), new WheelEvent('wheel', { deltaY }));
                view().dispatchEvent(new Event('scroll'));
                view().dispatchEvent(new Event('scrollend'));
            });
            later(16);
        }
        expect(view().scrollTop).toBe(pinned);
        later(SETTLE_FALLBACK_MS);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(reach()).toBe(pinned);
    });

    it('takes the notches of a wheel turned over the question rail for one scroll, given back once they stop', async () => {
        const { SETTLE_FALLBACK_MS } = await import('@beaver/agent-ui/conversation/readingRoom');
        const { scrollByWheel } = await import('../../../react/utils/conversationNavigation');
        const { stream, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        // Up two notches and straight back down two, each passed on as it comes, with a scroll and a scrollend of its own.
        for (const deltaY of [-30, -30, 30, 30]) {
            await act(async () => {
                scrollByWheel(view(), new WheelEvent('wheel', { deltaY }));
                view().dispatchEvent(new Event('scroll'));
                view().dispatchEvent(new Event('scrollend'));
            });
            later(60);
        }
        expect(view().scrollTop).toBe(pinned);
        later(SETTLE_FALLBACK_MS);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(view().scrollTop).toBe(pinned);
        expect(reach()).toBe(pinned);
        // And once they stop, an upward turn gives the room below back.
        await act(async () => {
            scrollByWheel(view(), new WheelEvent('wheel', { deltaY: -40 }));
            view().dispatchEvent(new Event('scroll'));
            view().dispatchEvent(new Event('scrollend'));
        });
        later(SETTLE_FALLBACK_MS);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, SETTLE_FALLBACK_MS + 40)); });
        expect(reach()).toBe(pinned - 40);
    });

    it('goes down from a coarse box at the top edge to the line the reader is on, as the browser does', async () => {
        const { stream, scrollTo, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        lines.set('q1', 446 - 300);
        // What is found at the top edge is the whole run (the edge falls in a gap between its parts).
        atTopEdge = document.getElementById('run-q1');
        await scrollTo(pinnedAt('q2') - 150);
        const lineOnScreen = () => document.getElementById('line-q1')!.getBoundingClientRect().top;
        const before = lineOnScreen();
        // Something inside q1, above that line, opens.
        heights.set('q1', 380);
        lines.set('q1', 446 - 300 + 80);
        await resized(room());
        expect(lineOnScreen()).toBe(before);
    });

    it('keeps a view at rest where it was, relative to what it rests on', async () => {
        const { stream, scrollTo, later } = await openThread({ q0: 300, q1: 300 });
        await stream('q2', 60);
        later(1000);
        await scrollTo(pinnedAt('q2') - 150);
        const fromQuestion = pinnedAt('q2') - view().scrollTop;

        heights.set('q0', 340);
        await resized(room());
        expect(pinnedAt('q2') - view().scrollTop).toBe(fromQuestion);
    });
});

describe('the pane getting shorter', () => {
    it('keeps a question brought up at the top though its answer ran just past the bottom', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        // The answer runs 60px past the bottom: no room left, and close enough to count as the bottom.
        await stream('q2', pinned + VIEW + 60 - 600);
        expect(roomHeight()).toBe(0);

        VIEW = 380;
        await resized(view());
        expect(view().scrollTop).toBe(pinned);
    });

    it('keeps the end in view for a reader still scrolling at the bottom of an answer, past the question', async () => {
        const { stream, scrollThrough, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        // Down to the end; the scroll has not come to rest when the pane gets shorter.
        await scrollThrough(maxScroll());
        VIEW = 360;
        await resized(view());
        expect(view().scrollTop).toBe(maxScroll());
    });

    it('keeps the end in view for a reader at the bottom of an answer that filled the room', async () => {
        const { store, stream, scrollTo, later } = await openThread();
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(maxScroll());
        expect(store.get(userScrolledAtom)).toBe(false);
        VIEW = 360;
        await resized(view());
        expect(view().scrollTop).toBe(maxScroll());
    });

    it('keeps a reader resting in the room where they are, though the view landed a pixel and more short of it', async () => {
        const { stream, scrollTo, later } = await openThread({ q0: 300, q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        // Sent to a position in fractions of a pixel, the view landed 1.2px short of it.
        scrollPos -= 1.2;
        const at = view().scrollTop;
        // The pane gets shorter (the composer grows a line): no blank is needed below the view any more.
        VIEW = 300;
        await resized(view());
        expect(view().scrollTop).toBe(at);
        expect(reach()).not.toBe(null);
    });

    it('does not pin a reader resting in the room to the end when the pane\'s new size is reported before the room\'s', async () => {
        const { stream, scrollTo, later } = await openThread({ q0: 300, q1: 2000 });
        await stream('q2', 60, 'completed');
        later(1000);
        lines.set('q1', 1690);
        atTopEdge = document.getElementById('line-q1');
        await scrollTo(pinnedAt('q2') - 300);
        later(1000);
        const onScreen = () => document.getElementById('line-q1')!.getBoundingClientRect().top;
        const before = onScreen();
        writes.length = 0;
        // Zotero stacks its panes: a much shorter view, q0 rewrapped taller, and the browser has scrolled
        // along only part of the way when the pane's new size is reported.
        VIEW = 184;
        heights.set('q0', 500);
        scrollPos += 150;
        await act(async () => { view().dispatchEvent(new Event('scroll')); });
        await resized(view());
        expect(writes).not.toContain(Math.max(0, contentHeight() + roomHeight() - 184));
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        await act(async () => { view().dispatchEvent(new Event('scroll')); view().dispatchEvent(new Event('scrollend')); });
        await resized(room());
        expect(onScreen()).toBe(before);
        expect(reach()).not.toBe(null);
    });
});

describe('letting the room go', () => {
    it('lets it go once the reader has read on past the question, so a shorter page is an ordinary page', async () => {
        const { stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(1500);
        expect(reach()).toBe(null);

        // The steps fold (or the display mode changes): the browser clamps to the new end, no blank.
        await stream('q2', 500);
        expect(view().scrollTop).toBe(maxScroll());
        expect(maxScroll()).toBe(contentHeight() - VIEW);
    });

    it('keeps a question brought up as brought up when the jump lands a fraction of a pixel short', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        const target = reach();
        // Gecko lands a smooth scroll within a pixel of where it was sent.
        scrollPos = target! - 0.6;
        later(1000);
        await act(async () => {
            view().dispatchEvent(new Event('scroll'));
            view().dispatchEvent(new Event('scrollend'));
        });
        expect(reach()).toBe(target);
    });

    it('keeps it for a question brought up and still rested on, though its answer has filled the screen', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        const pinned = view().scrollTop;
        // A scroll that came to rest where it was.
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        expect(reach()).toBe(pinned);

        // The steps fold away at the end: the view does not dip before the jump back.
        scrollStarts.length = 0;
        await stream('q2', 120, 'completed');
        expect(scrollStarts).toEqual([pinned]);
    });

    it('keeps none for a view at rest at the very top, so the last question is the one being read', async () => {
        VIEW = 800;
        const { stream, scrollTo, later } = await openThread({ q0: 150, q1: 150 });
        await stream('q2', 90);
        later(1000);
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        await stream('q2', 90, 'completed');
        later(1000);
        await scrollTo(0);
        expect(reach()).toBe(null);
        expect(scrollHeight()).toBe(800);
        const { readCurrentTurnIndex } = await import('@beaver/agent-ui/conversation/useCurrentTurn');
        expect(readCurrentTurnIndex(view(), ['q0', 'q1', 'q2'])).toBe(2);
    });
});

describe('a conversation that starts empty', () => {
    it('gives back the room a reader scrolls away from, once the first exchange is in', async () => {
        const { store, atoms, stream, scrollTo, later } = await openThread({});
        heights.set('q1', 600);
        await act(async () => { store.set(atoms.threadRunsAtom, [makeRun('q1')]); });
        scrollPos = maxScroll();
        await stream('q2', 60);
        later(1000);
        const pinned = view().scrollTop;
        expect(pinned).toBe(pinnedAt('q2'));
        await scrollTo(pinned - 150);
        expect(reach()).toBe(pinned - 150);
    });
});

describe('a pane that is not shown', () => {
    it('gives back no room for a scroll that ends while it has no height', async () => {
        const { stream, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        const kept = reach();
        VIEW = 0;
        await resized(view());
        scrollPos = 0;
        await act(async () => { view().dispatchEvent(new Event('scrollend')); });
        expect(reach()).toBe(kept);
    });

    it('does not jump when a question is sent: it has no layout to jump in', async () => {
        const { stream } = await openThread();
        VIEW = 0;
        await resized(view());
        scrollStarts.length = 0;
        await stream('q2', 60);
        expect(scrollStarts).toEqual([]);
        expect(reach()).toBe(null);
    });

    it('brings a question sent while it had no height to the top once it is shown', async () => {
        const { store, atoms, stream, later } = await openThread();
        await stream('q2', 60, 'completed');
        later(1000);
        await act(async () => {
            store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]);
            store.set(atoms.activeRunAtom, null);
        });
        // A long draft takes all of a short pane: the view has no height as the question goes.
        VIEW = 0;
        await resized(view());
        scrollPos = 0;
        await stream('q3', 60);
        later(1000);
        VIEW = 400;
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(pinnedAt('q3'));
        expect(roomHeight()).toBeGreaterThan(0);
    });

    it('brings a question sent while it had no height up even when its answer streams on as the view comes back', async () => {
        const { store, atoms, stream, later } = await openThread();
        await stream('q2', 60, 'completed');
        later(1000);
        await act(async () => {
            store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]);
            store.set(atoms.activeRunAtom, null);
        });
        VIEW = 0;
        await resized(view());
        scrollPos = 0;
        await stream('q3', 60);
        later(1000);
        VIEW = 400;
        await resized(view());
        // A part of the answer arrives before the view's restore is due.
        await stream('q3', 80);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(pinnedAt('q3'));
    });

    it('lets the reader read on from a question sent while it had no height, once it was brought up', async () => {
        const { store, atoms, stream, scrollTo, later } = await openThread();
        await stream('q2', 60, 'completed');
        later(1000);
        await act(async () => {
            store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]);
            store.set(atoms.activeRunAtom, null);
        });
        VIEW = 0;
        await resized(view());
        await stream('q3', 60, 'completed');
        later(1000);
        VIEW = 400;
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(pinnedAt('q3'));
        // The reader scrolls up a little and stops; coming back later, that is where they are.
        later(1000);
        await scrollTo(pinnedAt('q3') - 40);
        later(1000);
        const place = view().scrollTop;
        await remount(store);
        expect(view().scrollTop).toBe(place);
    });

    it('brings a question sent while it had no height up though the view reports a scroll as it comes back', async () => {
        const { store, atoms, stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await stream('q2', 1400);
        await scrollTo(maxScroll());
        later(1000);
        expect(reach()).toBe(null);
        VIEW = 0;
        await resized(view());
        await stream('q2', 500, 'completed');
        await act(async () => { view().dispatchEvent(new Event('scroll')); });
        await act(async () => {
            store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]);
            store.set(atoms.activeRunAtom, null);
        });
        await stream('q3', 60);
        later(1000);
        // Back to its height, the page shorter: the browser clamps the view, and says so.
        VIEW = 400;
        await act(async () => { view().dispatchEvent(new Event('scroll')); });
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(pinnedAt('q3'));
    });

    it('brings a question sent while it had no height up though the room follows a change above the old one first', async () => {
        const { store, atoms, stream, later } = await openThread();
        await stream('q2', 60, 'completed');
        later(1000);
        await act(async () => {
            store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]);
            store.set(atoms.activeRunAtom, null);
        });
        VIEW = 0;
        await resized(view());
        heights.set('q1', 640);
        await resized(column());
        await stream('q3', 60);
        later(1000);
        VIEW = 400;
        await resized(view());
        await resized(column());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(pinnedAt('q3'));
    });

    it('keeps that question its place through a scroll the browser reports while the view has no height', async () => {
        const { stream, later } = await openThread();
        VIEW = 0;
        await resized(view());
        await stream('q2', 60);
        // The browser forgets a hidden view's position, and says so.
        scrollPos = 0;
        await act(async () => { view().dispatchEvent(new Event('scroll')); });
        later(1000);
        VIEW = 400;
        await resized(view());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(view().scrollTop).toBe(pinnedAt('q2'));
        expect(roomHeight()).toBeGreaterThan(0);
    });
});

describe('what is not a question sent from here', () => {
    it('hides the scroll-down button once the reader reaches the end of an answer that came in through sync', async () => {
        const { store, atoms, scrollTo } = await openThread();
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        heights.set('q2', 900);
        await act(async () => { store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]); });
        await resized(document.getElementById('run-q2')!);
        expect(store.get(userScrolledAtom)).toBe(true);
        expect(reach()).toBe(null);

        await scrollTo(maxScroll());
        expect(store.get(userScrolledAtom)).toBe(false);
    });

    it('leaves the view alone when a question arrives through sync', async () => {
        const { store, atoms } = await openThread();
        const before = view().scrollTop;
        heights.set('q2', 300);
        await act(async () => { store.set(atoms.threadRunsAtom, [makeRun('q1'), makeRun('q2')]); });
        expect(view().scrollTop).toBe(before);
        expect(roomHeight()).toBe(0);
    });

    it('does not bring up the question a retry uncovers', async () => {
        const { store, atoms, stream, scrollTo, later } = await openThread();
        await stream('q2', 60);
        later(1000);
        await scrollTo(300);
        later(1000);
        await act(async () => { store.set(atoms.activeRunAtom, null); });
        expect(view().scrollTop).not.toBe(pinnedAt('q1'));
        expect(flashed('q1')).toBe(false);
    });
});
