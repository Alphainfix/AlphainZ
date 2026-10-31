// @vitest-environment jsdom
 

/**
 * The question rail: one tick per question at the right edge of the chat.
 *
 * Pointing anywhere on the rail previews the question whose tick is nearest,
 * and the card stays up — moving and changing in place — until the pointer
 * leaves the rail. The question being read has the current tick, which
 * follows the scroll. A click jumps to the question.
 */
import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';

/** Each tick is 16px tall; the first centre is at 108px. */
const TICK_TOP = 100;
const TICK_STEP = 16;
/** The thread view: 400px tall, 1200px of content, each question 400px. */
const VIEW_HEIGHT = 400;
const CONTENT_HEIGHT = 1200;
const QUESTION_HEIGHT = 400;

let root: Root | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).__alphainzJotaiStore = undefined;
    document.body.innerHTML = '';
    vi.resetModules();
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
});

function makeRun(id: string, question: string, answer: string): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: question },
        status: 'completed',
        model_messages: [{ kind: 'response', run_id: id, parts: [{ part_kind: 'text', content: answer }] }],
        created_at: '2026-10-09T14:32:00',
        consent_to_share: false,
        model_name: 'test-model',
    } as AgentRun;
}

const RUNS = [
    makeRun('q1', 'What is the core finding?', 'Encapsulation extends the damp-heat lifetime tenfold.'),
    makeRun('q2', 'How does the method differ?', 'The stack is deposited directly on the cell.'),
    makeRun('q3', 'Can you tabulate figure 3?', 'Here are the values read off the plot.'),
];

const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 10, width: 10, x: 0, y: top, toJSON: () => ({}),
}) as DOMRect;

function stubRect(element: Element, get: () => DOMRect) {
    Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: get });
}

/** Lay out the thread view and the ticks the way a 600px-tall chat area would. */
function layOut(host: HTMLElement, runs: AgentRun[]) {
    const area = host.querySelector<HTMLElement>('.conversation-view')!;
    const view = host.querySelector<HTMLElement>('#alphainz-thread-view')!;
    stubRect(area, () => rect(0, 600));
    stubRect(view, () => rect(0, VIEW_HEIGHT));
    Object.defineProperty(view, 'clientHeight', { configurable: true, value: VIEW_HEIGHT });
    Object.defineProperty(view, 'scrollHeight', { configurable: true, value: CONTENT_HEIGHT });
    runs.forEach((run, i) => {
        const top = () => i * QUESTION_HEIGHT - view.scrollTop;
        stubRect(host.querySelector(`#run-${run.id}`)!, () => rect(top(), QUESTION_HEIGHT));
        stubRect(host.querySelector(`#user-request-${run.id}`)!, () => rect(top() + 4, 40));
    });
    marks(host).forEach((mark, i) => stubRect(mark, () => rect(TICK_TOP + i * TICK_STEP, TICK_STEP)));
    return { area, view };
}

const marks = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.conversation-rail-mark')];
const rail = (host: HTMLElement) => host.querySelector<HTMLElement>('.conversation-rail-marks')!;
const card = (host: HTMLElement) => host.querySelector<HTMLElement>('.conversation-peek')!;
const cardShows = (host: HTMLElement) => card(host).getAttribute('data-visible') === 'true';
const cardQuestion = (host: HTMLElement) => card(host).querySelector('.conversation-peek-question')?.textContent;
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));

async function mount(runs: AgentRun[] = RUNS) {
    const { store } = await import('../../../react/store');
    const { threadRunsAtom } = await import('@beaver/agent-core/run-state/atoms');
    store.set(threadRunsAtom, runs);
    const { Provider } = await import('jotai');
    const { ConversationRail } = await import('../../../react/components/agentRuns/ConversationRail');

    function Harness() {
        const viewRef = useRef<HTMLDivElement>(null);
        return (
            <div className="conversation-view">
                <div id="alphainz-thread-view" ref={viewRef}>
                    {runs.map((run) => (
                        <div key={run.id} id={`run-${run.id}`}>
                            <div id={`user-request-${run.id}`}>{run.user_prompt.content}</div>
                        </div>
                    ))}
                </div>
                <ConversationRail containerRef={viewRef} isWindow={false} />
            </div>
        );
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Provider store={store}><Harness /></Provider>); });
    const layout = layOut(host, runs);
    return { host, store, ...layout };
}

async function pointer(target: Element, type: 'pointerenter' | 'pointermove' | 'pointerleave', clientY = 0) {
    await act(async () => { target.dispatchEvent(new PointerEvent(type, { clientY, bubbles: type === 'pointermove' })); });
}

describe('the ticks', () => {
    it('are one per question, labelled with the question', async () => {
        const { host } = await mount();
        expect(marks(host).map((mark) => mark.getAttribute('aria-label'))).toEqual([
            'Question 1: What is the core finding?',
            'Question 2: How does the method differ?',
            'Question 3: Can you tabulate figure 3?',
        ]);
        expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Questions in this conversation');
    });

    it('mark the question being read, following the scroll', async () => {
        const { host, view } = await mount();
        const current = () => marks(host).findIndex((mark) => mark.classList.contains('is-current'));

        view.scrollTop = 0;
        await act(async () => { view.dispatchEvent(new Event('scroll')); await frame(); });
        expect(current()).toBe(0);
        expect(marks(host)[0].getAttribute('aria-current')).toBe('location');

        // The second question's top has passed the line a third of the way down.
        view.scrollTop = 450;
        await act(async () => { view.dispatchEvent(new Event('scroll')); await frame(); });
        expect(current()).toBe(1);

        // At the bottom the last question is the one being read.
        view.scrollTop = CONTENT_HEIGHT - VIEW_HEIGHT;
        await act(async () => { view.dispatchEvent(new Event('scroll')); await frame(); });
        expect(current()).toBe(2);
        expect(marks(host).filter((mark) => mark.getAttribute('aria-current')).length).toBe(1);
    });

    it('are reached with one Tab stop, on the question being read', async () => {
        const { host, view } = await mount();
        view.scrollTop = 450;
        await act(async () => { view.dispatchEvent(new Event('scroll')); await frame(); });
        expect(marks(host).map((mark) => mark.tabIndex)).toEqual([-1, 0, -1]);
    });
});

describe('the preview card', () => {
    it('shows the question whose tick is nearest the pointer, between two ticks as well', async () => {
        const { host } = await mount();
        expect(cardShows(host)).toBe(false);

        // Centres at 108, 124 and 140. 117 is between the first two, nearer the second.
        await pointer(rail(host), 'pointerenter', 117);
        expect(cardShows(host)).toBe(true);
        expect(cardQuestion(host)).toBe('How does the method differ?');
        expect(card(host).querySelector('.conversation-peek-number')?.textContent).toBe('Question 2');

        // 114 is nearer the first.
        await pointer(rail(host), 'pointermove', 114);
        expect(cardQuestion(host)).toBe('What is the core finding?');

        // 133 is nearer the third.
        await pointer(rail(host), 'pointermove', 133);
        expect(cardQuestion(host)).toBe('Can you tabulate figure 3?');
    });

    it('never hides while the pointer runs along the rail, and goes when it leaves', async () => {
        const { host } = await mount();
        const theCard = card(host);
        await pointer(rail(host), 'pointerenter', 100);
        expect(cardShows(host)).toBe(true);

        // Watch the card from here on: it must not be hidden, or swapped for another element.
        const changes: string[] = [];
        const observer = new MutationObserver((records) => {
            for (const record of records) changes.push(`${record.attributeName}:${record.oldValue}`);
        });
        observer.observe(theCard, { attributes: true, attributeFilter: ['data-visible'], attributeOldValue: true });

        const seen: string[] = [];
        for (let y = 100; y <= 148; y += 2) {
            await pointer(rail(host), 'pointermove', y);
            expect(cardShows(host)).toBe(true);
            const question = cardQuestion(host)!;
            if (seen[seen.length - 1] !== question) seen.push(question);
        }
        changes.push(...observer.takeRecords().map((record) => `${record.attributeName}:${record.oldValue}`));
        observer.disconnect();

        expect(changes).toEqual([]);
        expect(card(host)).toBe(theCard);
        expect(seen).toEqual(['What is the core finding?', 'How does the method differ?', 'Can you tabulate figure 3?']);

        await pointer(rail(host), 'pointerleave', 200);
        expect(cardShows(host)).toBe(false);
    });

    it('carries the time, the citations, the start of the answer and how to jump', async () => {
        const runs = [
            RUNS[0],
            {
                ...makeRun('q2', 'How does the method differ?', '**Directly** on the cell <citation a="1"/> and <citation a="2"/>.'),
                created_at: new Date().toISOString(),
            } as AgentRun,
            RUNS[2],
        ];
        const { host } = await mount(runs);
        await pointer(rail(host), 'pointerenter', 124);
        const meta = card(host).querySelector('.conversation-peek-meta')!.textContent;
        expect(meta).toMatch(/^Question 2· \d\d:\d\d· 2 citations$/);
        expect(card(host).querySelector('.conversation-peek-answer')?.textContent).toBe('Directly on the cell and.');
        expect(card(host).querySelector('.conversation-peek-foot')?.textContent).toBe('Click to jump');
    });

    it('shows for a tick focused from the keyboard, follows the arrow keys, and Escape puts it away', async () => {
        const { host } = await mount();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => { marks(host)[0].focus(); });
        expect(cardShows(host)).toBe(true);
        expect(cardQuestion(host)).toBe('What is the core finding?');
        expect(card(host).querySelector('.conversation-peek-foot')?.textContent).toBe('Press Enter to jump');
        expect(marks(host)[0].getAttribute('aria-describedby')).toBe(card(host).id);

        await act(async () => {
            marks(host)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
        expect(document.activeElement).toBe(marks(host)[1]);
        expect(cardShows(host)).toBe(true);
        expect(cardQuestion(host)).toBe('How does the method differ?');

        await act(async () => {
            marks(host)[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(cardShows(host)).toBe(false);
    });

    it('does not show for a tick a click focused', async () => {
        const { host } = await mount();
        const matches = Element.prototype.matches;
        vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
            return selector === ':focus-visible' ? false : matches.call(this, selector);
        });
        await act(async () => { marks(host)[2].focus(); });
        expect(cardShows(host)).toBe(false);
    });
});

describe('a click on the rail', () => {
    it('brings the question under the pointer to the top, marks it, and puts the card away', async () => {
        const { host, store, view } = await mount();
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        const { isConversationJumpLocked, FLASH_ATTRIBUTE } = await import('../../../react/utils/conversationNavigation');
        view.scrollTop = CONTENT_HEIGHT - VIEW_HEIGHT;
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;

        await pointer(rail(host), 'pointerenter', 124);
        expect(cardShows(host)).toBe(true);
        await act(async () => { marks(host)[1].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });

        // The second request starts 400 + 4px into the content; it goes to the
        // top of the view with 8px above it, and the view is smooth about it.
        expect(scrollTo).toHaveBeenCalledWith({ top: QUESTION_HEIGHT + 4 - 8, behavior: 'smooth' });
        // Far from the bottom: the auto-scroll that follows a streaming answer stands back.
        expect(store.get(userScrolledAtom)).toBe(true);
        expect(isConversationJumpLocked(view)).toBe(true);
        expect(host.querySelector('#user-request-q2')?.hasAttribute(FLASH_ATTRIBUTE)).toBe(true);
        // Out of the way of the question it brought up, with the pointer still on the rail.
        expect(cardShows(host)).toBe(false);
        // Moving on to another question brings it back.
        await pointer(rail(host), 'pointermove', 140);
        expect(cardShows(host)).toBe(true);
    });

    it('jumps to the tick nearest the pointer, not only to the button pressed', async () => {
        const { host, view } = await mount();
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        await pointer(rail(host), 'pointerenter', 140);
        // The click lands on the second button's box edge, but the pointer is nearest the third tick.
        await act(async () => { marks(host)[1].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
        expect(host.querySelector('#user-request-q3')?.hasAttribute('data-conversation-flash')).toBe(true);
        expect(host.querySelector('#user-request-q2')?.hasAttribute('data-conversation-flash')).toBe(false);
    });

    it('jumps without animation when reduced motion is preferred', async () => {
        const { host, view } = await mount();
        (window as any).matchMedia = (query: string) => ({ matches: query.includes('reduce') });
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        try {
            await act(async () => { marks(host)[1].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
        } finally {
            delete (window as any).matchMedia;
        }
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    });
});

describe('the wheel over the rail', () => {
    const lines = (deltaY: number) => new WheelEvent('wheel', { deltaY, deltaMode: 1, cancelable: true, bubbles: true });

    it('scrolls the conversation smoothly instead of whatever is around the pane, the notches of a turn adding up', async () => {
        const { host, view } = await mount();
        view.scrollTop = 100;
        // The view's smooth scroll is still on its way when the next notch comes.
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        const first = lines(3);
        await act(async () => { rail(host).dispatchEvent(first); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 100 + 3 * 18, behavior: 'smooth' });
        expect(first.defaultPrevented).toBe(true);
        await act(async () => { rail(host).dispatchEvent(lines(3)); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 100 + 6 * 18, behavior: 'smooth' });
        // Never past either end.
        await act(async () => { rail(host).dispatchEvent(lines(-300)); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });

        // Ctrl+wheel is Zotero's zoom.
        const zoom = new WheelEvent('wheel', { deltaY: 3, ctrlKey: true, cancelable: true, bubbles: true });
        await act(async () => { rail(host).dispatchEvent(zoom); });
        expect(zoom.defaultPrevented).toBe(false);
    });

    it('starts a turn after a pause from where the view is', async () => {
        const { host, view } = await mount();
        view.scrollTop = 100;
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        await act(async () => { rail(host).dispatchEvent(lines(3)); });
        // A while later, the view is somewhere else (the reader dragged it there).
        view.scrollTop = 300;
        now += 1000;
        await act(async () => { rail(host).dispatchEvent(lines(-3)); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 300 - 3 * 18, behavior: 'smooth' });
    });

    it('starts a turn after a pause from where the view stopped, short of where the last notch sent it', async () => {
        const { host, view } = await mount();
        view.scrollTop = 100;
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        await act(async () => { rail(host).dispatchEvent(lines(3)); });
        // The scroll stopped on its way (the page got shorter under it), and stayed there.
        view.scrollTop = 130;
        now += 1000;
        await act(async () => { rail(host).dispatchEvent(lines(3)); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 130 + 3 * 18, behavior: 'smooth' });
    });

    it('adds a notch to where the turn is going, though the view swings back past where the last one found it', async () => {
        const { host, view } = await mount();
        view.scrollTop = 600;
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        // Two notches up, the smooth scroll on its way; then two straight back down.
        await act(async () => { rail(host).dispatchEvent(lines(-3)); });
        view.scrollTop = 580;
        await act(async () => { rail(host).dispatchEvent(lines(-3)); });
        view.scrollTop = 540;
        await act(async () => { rail(host).dispatchEvent(lines(3)); });
        // The scroll carries on upward a little before it turns back.
        view.scrollTop = 505;
        await act(async () => { rail(host).dispatchEvent(lines(3)); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: 'smooth' });
    });

    it('starts a turn again from where the view is after a jump', async () => {
        const { host, view } = await mount();
        view.scrollTop = 600;
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        await act(async () => { rail(host).dispatchEvent(lines(-3)); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 600 - 54, behavior: 'smooth' });
        // A click on the rail takes the view to the first question.
        await act(async () => { marks(host)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
        view.scrollTop = 0;
        await act(async () => { rail(host).dispatchEvent(lines(3)); });
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 54, behavior: 'smooth' });
    });

    it('follows a wheel that reports pixels (a touchpad) as it comes', async () => {
        const { host, view } = await mount();
        view.scrollTop = 100;
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        const pixels = new WheelEvent('wheel', { deltaY: -40, deltaMode: 0, cancelable: true, bubbles: true });
        await act(async () => { rail(host).dispatchEvent(pixels); });
        expect(view.scrollTop).toBe(60);
        expect(pixels.defaultPrevented).toBe(true);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('scrolls without animation when reduced motion is preferred', async () => {
        const { host, view } = await mount();
        view.scrollTop = 100;
        const scrollTo = vi.fn();
        (view as any).scrollTo = scrollTo;
        (window as any).matchMedia = (query: string) => ({ matches: query.includes('reduce') });
        try {
            await act(async () => { rail(host).dispatchEvent(lines(3)); });
        } finally {
            delete (window as any).matchMedia;
        }
        expect(view.scrollTop).toBe(154);
        expect(scrollTo).not.toHaveBeenCalled();
    });
});

describe('cleaning up', () => {
    it('removes its listeners when it goes', async () => {
        const { host, view } = await mount();
        const viewRemoved = vi.spyOn(view, 'removeEventListener');
        const railRemoved = vi.spyOn(rail(host), 'removeEventListener');
        act(() => root!.unmount());
        root = null;
        expect(viewRemoved).toHaveBeenCalledWith('scroll', expect.any(Function));
        expect(railRemoved.mock.calls.map(([type]) => type).sort()).toEqual(
            ['pointercancel', 'pointerenter', 'pointerleave', 'pointermove', 'wheel'],
        );
    });

    it('draws nothing for a conversation without questions', async () => {
        const { host } = await mount([]);
        expect(host.querySelector('.conversation-rail')).toBeNull();
    });
});
