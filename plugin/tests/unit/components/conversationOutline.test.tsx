// @vitest-environment jsdom
 

/**
 * The conversation outline: a header button that opens a list of every
 * question in the chat, with the start of each answer, a search over both, and
 * the question being read marked. It is the chat history's panel, drawn by the
 * same classes in the same place. ↑↓ select, Enter jumps, Escape closes and
 * hands focus back to the button.
 */
import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';

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

function makeRun(id: string, question: string, answer: string, citations = 0): AgentRun {
    const tags = Array.from({ length: citations }, (_, i) => ` <citation a="${i}"/>`).join('');
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: question },
        status: 'completed',
        model_messages: [{ kind: 'response', run_id: id, parts: [{ part_kind: 'text', content: `${answer}${tags}` }] }],
        created_at: '2026-10-09T14:32:00',
        consent_to_share: false,
        model_name: 'test-model',
    } as AgentRun;
}

const RUNS = [
    makeRun('q1', 'What is the core finding?', 'Encapsulation extends the damp-heat lifetime tenfold.', 3),
    makeRun('q2', 'How does the encapsulation differ from earlier work?', 'Earlier devices used a glass lid sealed with UV glue around the edge, so moisture crept in through the seam; this stack is deposited directly on the cell and has no seam at all.', 2),
    makeRun('q3', 'How is T80 measured?', 'T80 is the time until efficiency falls to 80 percent of its initial value.', 1),
];

const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}),
}) as DOMRect;

function stubRect(element: Element, get: () => DOMRect) {
    Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: get });
}

async function mount(runs: AgentRun[] = RUNS, isWindow = false) {
    const { store } = await import('../../../react/store');
    const { threadRunsAtom, currentThreadIdAtom } = await import('@beaver/agent-core/run-state/atoms');
    store.set(threadRunsAtom, runs);
    store.set(currentThreadIdAtom, 'thread-1');
    const { Provider } = await import('jotai');
    const { default: ConversationOutlineButton } = await import('../../../react/components/ui/buttons/ConversationOutlineButton');
    const { ConversationOutline } = await import('../../../react/components/agentRuns/ConversationOutline');

    function Harness() {
        const viewRef = useRef<HTMLDivElement>(null);
        const buttonRef = useRef<HTMLButtonElement>(null);
        return (
            <div>
                <div className="header"><ConversationOutlineButton ref={buttonRef} isWindow={isWindow} /></div>
                <div className="content">
                    <div id="alphainz-thread-view" ref={viewRef}>
                        {runs.map((run) => (
                            <div key={run.id} id={`run-${run.id}`}>
                                <div id={`user-request-${run.id}`}>{run.user_prompt.content}</div>
                            </div>
                        ))}
                    </div>
                    <ConversationOutline isWindow={isWindow} containerRef={viewRef} buttonRef={buttonRef} />
                </div>
                <p id="elsewhere">Elsewhere in the pane</p>
            </div>
        );
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Provider store={store}><Harness /></Provider>); });

    const view = host.querySelector<HTMLElement>('#alphainz-thread-view')!;
    stubRect(view, () => rect(0, VIEW_HEIGHT));
    Object.defineProperty(view, 'clientHeight', { configurable: true, value: VIEW_HEIGHT });
    Object.defineProperty(view, 'scrollHeight', { configurable: true, value: CONTENT_HEIGHT });
    runs.forEach((run, i) => {
        const top = () => i * QUESTION_HEIGHT - view.scrollTop;
        stubRect(host.querySelector(`#run-${run.id}`)!, () => rect(top(), QUESTION_HEIGHT));
        stubRect(host.querySelector(`#user-request-${run.id}`)!, () => rect(top() + 4, 40));
    });
    const scrollTo = vi.fn();
    (view as any).scrollTo = scrollTo;
    return { host, store, view, scrollTo };
}

const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Conversation outline"]');
const panel = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="dialog"]');
const filterField = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label="Search questions and answers"]')!;
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
const selectedRow = (host: HTMLElement) => rows(host).find((row) => row.getAttribute('aria-selected') === 'true');
const answerOf = (row: HTMLElement) => row.querySelector<HTMLElement>('.thread-list-item-time .truncate')!;
const matches = (element: Element) => [...element.querySelectorAll('.font-color-accent-blue')].map((match) => match.textContent);

async function open(host: HTMLElement) {
    await act(async () => { button(host)!.click(); });
}

async function key(target: Element, name: string) {
    await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
}

async function type(input: HTMLInputElement, value: string) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('the outline button', () => {
    it('is in the header once the conversation has a question, with how many there are', async () => {
        const { host } = await mount();
        const outline = button(host)!;
        expect(outline).toBeTruthy();
        expect(outline.getAttribute('aria-haspopup')).toBe('dialog');
        expect(outline.getAttribute('aria-expanded')).toBe('false');
        expect(outline.querySelector('.conversation-outline-count')?.textContent).toBe('3');
    });

    it('is not there before the first question', async () => {
        const { host } = await mount([]);
        expect(button(host)).toBeNull();
    });

    it('opens the outline in the chat history\'s panel and closes it again', async () => {
        const { host } = await mount();
        await open(host);
        const dialog = panel(host)!;
        expect(dialog.getAttribute('aria-label')).toBe('Conversation outline');
        expect(button(host)!.getAttribute('aria-expanded')).toBe('true');
        expect(button(host)!.getAttribute('aria-controls')).toBe(dialog.id);
        // The same overlay, title and search field as the chat history.
        expect(dialog.classList.contains('thread-overlay-panel')).toBe(true);
        expect(dialog.parentElement!.classList.contains('thread-overlay-container')).toBe(true);
        expect(dialog.parentElement!.querySelector(':scope > .thread-overlay-backdrop')).toBeTruthy();
        expect(dialog.querySelector('.thread-overlay-title')?.textContent).toBe('Questions');
        expect(filterField(host).classList.contains('thread-search-input')).toBe(true);
        expect(filterField(host).closest('.thread-search-wrapper')?.querySelector('.thread-search-icon')).toBeTruthy();
        expect(document.activeElement).toBe(filterField(host));

        await open(host);
        expect(panel(host)).toBeNull();
        expect(button(host)!.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes the chat history, which takes the same space', async () => {
        const { host, store } = await mount();
        const { isThreadListViewAtom } = await import('../../../react/atoms/ui');
        await act(async () => { store.set(isThreadListViewAtom, true); });
        await open(host);
        expect(store.get(isThreadListViewAtom)).toBe(false);
        expect(panel(host)).toBeTruthy();

        // And the history opening closes the outline.
        await act(async () => { store.set(isThreadListViewAtom, true); });
        expect(panel(host)).toBeNull();
    });

    it('opens the separate window its own outline, not the sidebar one', async () => {
        const { host, store } = await mount(RUNS, true);
        const { conversationOutlineOpenAtom, windowConversationOutlineOpenAtom } = await import('../../../react/atoms/conversationNav');
        await open(host);
        expect(store.get(windowConversationOutlineOpenAtom)).toBe(true);
        expect(store.get(conversationOutlineOpenAtom)).toBe(false);
        expect(panel(host)!.id).toBe('alphainz-conversation-outline-window');
    });
});

describe('the list', () => {
    it('has a chat-list row per question: its number and the question, then the start of the answer', async () => {
        const { host } = await mount();
        await open(host);
        const [, second] = rows(host);
        expect(rows(host)).toHaveLength(3);
        expect(second.classList.contains('thread-list-item')).toBe(true);
        expect(second.querySelector('.thread-list-item-name')?.textContent).toBe('2. How does the encapsulation differ from earlier work?');
        expect(answerOf(second).textContent).toMatch(/^Earlier devices used a glass lid/);
        expect(second.getAttribute('aria-label')).toBe('Question 2: How does the encapsulation differ from earlier work?');
    });

    it('marks the question being read the way the chat list marks the current chat', async () => {
        const { host, view } = await mount();
        view.scrollTop = 450;
        await open(host);
        const current = rows(host).filter((row) => row.getAttribute('aria-current') === 'location');
        expect(current.map((row) => row.dataset.turnIndex)).toEqual(['1']);
        expect(current[0].querySelector('.thread-list-item-time')?.textContent).toMatch(/\(current\)$/);
        expect(current[0].getAttribute('aria-label')).toMatch(/, current question$/);
        // Nothing is picked until the pointer or the arrows pick it.
        expect(selectedRow(host)).toBeUndefined();
        expect(filterField(host).hasAttribute('aria-activedescendant')).toBe(false);
    });

    it('searches the question and the answer and colours the matches', async () => {
        const { host } = await mount();
        await open(host);
        await type(filterField(host), 'T80');
        expect(rows(host).map((row) => row.dataset.turnIndex)).toEqual(['2']);
        expect(matches(rows(host)[0])).toEqual(['T80', 'T80']);

        // Only the answer matches: its snippet starts at the match, so the match is not cut off.
        await type(filterField(host), 'seam');
        const answer = answerOf(rows(host)[0]);
        expect(rows(host).map((row) => row.dataset.turnIndex)).toEqual(['1']);
        expect(answer.textContent!.startsWith('…')).toBe(true);
        expect(matches(answer)).toEqual(['seam', 'seam']);

        await type(filterField(host), 'sourdough');
        expect(rows(host)).toHaveLength(0);
        expect(panel(host)!.querySelector('[role="status"]')?.textContent).toBe('No matching questions');
    });
});

describe('the keys', () => {
    it('select with the arrows, from the question being read, and Enter jumps to it and closes', async () => {
        const { host, store, scrollTo } = await mount();
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        await open(host);
        // The view is at the top, on the first question: the arrows start there.
        await key(filterField(host), 'ArrowDown');
        expect(selectedRow(host)?.dataset.turnIndex).toBe('1');
        expect(selectedRow(host)!.classList.contains('thread-list-item-hovered')).toBe(true);
        expect(filterField(host).getAttribute('aria-activedescendant')).toBe(selectedRow(host)!.id);
        await key(filterField(host), 'ArrowDown');
        await key(filterField(host), 'ArrowDown');
        expect(selectedRow(host)?.dataset.turnIndex).toBe('2');
        await key(filterField(host), 'ArrowUp');
        expect(selectedRow(host)?.dataset.turnIndex).toBe('1');

        await key(filterField(host), 'Enter');
        expect(scrollTo).toHaveBeenCalledWith({ top: QUESTION_HEIGHT + 4 - 8, behavior: 'smooth' });
        expect(store.get(userScrolledAtom)).toBe(true);
        expect(host.querySelector('#user-request-q2')?.hasAttribute('data-conversation-flash')).toBe(true);
        expect(panel(host)).toBeNull();
        expect(document.activeElement).toBe(button(host));
    });

    it('Enter after a search jumps to the first match', async () => {
        const { host, scrollTo } = await mount();
        await open(host);
        await type(filterField(host), 'T80');
        await key(filterField(host), 'Enter');
        expect(scrollTo).toHaveBeenCalledWith({ top: 2 * QUESTION_HEIGHT + 4 - 8, behavior: 'smooth' });
        expect(panel(host)).toBeNull();
    });

    it('Enter with nothing picked and nothing searched stays put', async () => {
        const { host, scrollTo } = await mount();
        await open(host);
        await key(filterField(host), 'Enter');
        expect(scrollTo).not.toHaveBeenCalled();
        expect(panel(host)).toBeTruthy();
    });

    it('Escape closes and hands focus back to the button', async () => {
        const { host, scrollTo } = await mount();
        await open(host);
        await key(filterField(host), 'Escape');
        expect(panel(host)).toBeNull();
        expect(document.activeElement).toBe(button(host));
        expect(scrollTo).not.toHaveBeenCalled();
    });

});

describe('the pointer', () => {
    it('jumps to a question when its row is clicked, and closes', async () => {
        const { host, scrollTo } = await mount();
        await open(host);
        await act(async () => { rows(host)[2].click(); });
        expect(scrollTo).toHaveBeenCalledWith({ top: 2 * QUESTION_HEIGHT + 4 - 8, behavior: 'smooth' });
        expect(panel(host)).toBeNull();
    });

    it('highlights the row under the pointer as the chat list does', async () => {
        const { host } = await mount();
        await open(host);
        const third = rows(host)[2];
        await act(async () => { third.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        expect(third.classList.contains('thread-list-item-hovered')).toBe(true);
        await act(async () => { third.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
        expect(third.classList.contains('thread-list-item-hovered')).toBe(false);
    });

    it('closes when the strip beside the panel is clicked, leaving focus alone', async () => {
        const { host } = await mount();
        await open(host);
        await act(async () => {
            host.querySelector<HTMLElement>('.thread-overlay-backdrop')!.click();
            filterField(host).blur();
        });
        expect(panel(host)).toBeNull();
        expect(document.activeElement).not.toBe(button(host));
    });
});

describe('another conversation', () => {
    it('closes the outline', async () => {
        const { host, store } = await mount();
        const { currentThreadIdAtom } = await import('@beaver/agent-core/run-state/atoms');
        await open(host);
        await act(async () => { store.set(currentThreadIdAtom, 'thread-2'); });
        expect(panel(host)).toBeNull();
    });
});
