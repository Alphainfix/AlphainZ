// @vitest-environment jsdom
/**
 * Jumping to a question in the thread view.
 *
 * The question's request goes to the top of the view and is marked for a
 * moment; ThreadView's own scrolling stands back while the jump is under way;
 * and the scrolled flag says where the jump will end, so a streaming answer
 * does not pull the view back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VIEW_HEIGHT = 400;
const CONTENT_HEIGHT = 1200;

beforeEach(() => {
    (Zotero as any).__alphainzJotaiStore = undefined;
    document.body.innerHTML = '';
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** A thread view of three 400px questions, scrolled to `scrollTop`. */
function threadView(scrollTop: number) {
    const view = document.createElement('div');
    document.body.appendChild(view);
    Object.defineProperty(view, 'clientHeight', { configurable: true, value: VIEW_HEIGHT });
    Object.defineProperty(view, 'scrollHeight', { configurable: true, value: CONTENT_HEIGHT });
    view.getBoundingClientRect = () => ({ top: 0, height: VIEW_HEIGHT }) as DOMRect;
    view.scrollTop = scrollTop;
    ['q1', 'q2', 'q3'].forEach((id, i) => {
        const run = document.createElement('div');
        run.id = `run-${id}`;
        const bubble = document.createElement('div');
        bubble.id = `user-request-${id}`;
        bubble.getBoundingClientRect = () => ({ top: i * 400 + 4 - view.scrollTop, height: 40 }) as DOMRect;
        run.appendChild(bubble);
        view.appendChild(run);
    });
    const scrollTo = vi.fn();
    (view as any).scrollTo = scrollTo;
    return { view, scrollTo };
}

describe('jumpToRun', () => {
    it('holds ThreadView off for the length of the jump', async () => {
        const { jumpToRun, isConversationJumpLocked, JUMP_LOCK_MS } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        const { view } = threadView(800);
        const start = Date.now();
        const now = vi.spyOn(Date, 'now').mockReturnValue(start);

        jumpToRun(view, 'q1', userScrolledAtom);
        expect(isConversationJumpLocked(view)).toBe(true);
        now.mockReturnValue(start + JUMP_LOCK_MS - 1);
        expect(isConversationJumpLocked(view)).toBe(true);
        now.mockReturnValue(start + JUMP_LOCK_MS);
        expect(isConversationJumpLocked(view)).toBe(false);
        // Another view is not held.
        expect(isConversationJumpLocked(threadView(0).view)).toBe(false);
    });

    it('leaves the view following the stream when the question is at the bottom', async () => {
        const { jumpToRun } = await import('../../../react/utils/conversationNavigation');
        const { store } = await import('../../../react/store');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        const { view, scrollTo } = threadView(0);
        store.set(userScrolledAtom, true);

        jumpToRun(view, 'q3', userScrolledAtom);
        // 804 - 8 = 796: within the 120px the view counts as "at the bottom".
        expect(scrollTo).toHaveBeenCalledWith({ top: 796, behavior: 'smooth' });
        expect(store.get(userScrolledAtom)).toBe(false);
    });

    it('sets the scrolled flag of the surface it was given', async () => {
        const { jumpToRun } = await import('../../../react/utils/conversationNavigation');
        const { store } = await import('../../../react/store');
        const { userScrolledAtom, windowUserScrolledAtom } = await import('../../../react/atoms/ui');
        const { view } = threadView(800);
        jumpToRun(view, 'q1', windowUserScrolledAtom);
        expect(store.get(windowUserScrolledAtom)).toBe(true);
        expect(store.get(userScrolledAtom)).toBe(false);
    });

    it('marks the question for a moment, and again on a second jump', async () => {
        const { jumpToRun, FLASH_ATTRIBUTE, FLASH_MS } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        const { view } = threadView(800);
        const timers = vi.spyOn(window, 'setTimeout');
        const bubble = view.querySelector('#user-request-q2')!;

        jumpToRun(view, 'q2', userScrolledAtom);
        expect(bubble.hasAttribute(FLASH_ATTRIBUTE)).toBe(true);
        const [clear, delay] = timers.mock.calls.at(-1)!;
        expect(delay).toBe(FLASH_MS);
        (clear as () => void)();
        expect(bubble.hasAttribute(FLASH_ATTRIBUTE)).toBe(false);

        jumpToRun(view, 'q2', userScrolledAtom);
        expect(bubble.hasAttribute(FLASH_ATTRIBUTE)).toBe(true);
    });

    it('does nothing for a question that is not in this view', async () => {
        const { jumpToRun, isConversationJumpLocked } = await import('../../../react/utils/conversationNavigation');
        const { userScrolledAtom } = await import('../../../react/atoms/ui');
        const { view, scrollTo } = threadView(0);
        const elsewhere = document.createElement('div');
        elsewhere.id = 'run-q9';
        document.body.appendChild(elsewhere);

        expect(jumpToRun(view, 'q9', userScrolledAtom)).toBe(false);
        expect(jumpToRun(view, 'missing', userScrolledAtom)).toBe(false);
        expect(scrollTo).not.toHaveBeenCalled();
        expect(isConversationJumpLocked(view)).toBe(false);
    });
});
