// @vitest-environment jsdom
 

/**
 * A jump from the question rail or the outline holds while an answer streams.
 *
 * ThreadView once followed a streaming answer to the bottom, and a token that
 * arrived during a jump's smooth scroll pulled the view straight back down. It
 * no longer follows the stream at all — a question is read from the top — and
 * neither a jump nor the view where the reader left it moves when a token
 * lands.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';

vi.mock('../../../react/components/agentRuns/AgentRunView', async () => {
    const React = await import('react');
    const AgentRunView = React.forwardRef<HTMLDivElement, { run: AgentRun }>(function AgentRunView({ run }, ref) {
        return React.createElement('div', { id: `run-${run.id}`, ref },
            React.createElement('div', { id: `user-request-${run.id}` }, run.user_prompt.content));
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

const VIEW_HEIGHT = 400;
const CONTENT_HEIGHT = 1200;

let root: Root | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
    (Zotero as any).__alphainzJotaiStore = undefined;
    (Zotero.getMainWindow as any).mockReturnValue(window);
    document.body.innerHTML = '';
    vi.resetModules();
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    delete (globalThis as any).ResizeObserver;
    vi.restoreAllMocks();
});

function makeRun(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: `Question ${id}` },
        status: 'completed',
        model_messages: [],
        created_at: '2026-10-09T14:32:00',
        consent_to_share: false,
        model_name: 'test-model',
        ...overrides,
    } as AgentRun;
}

const streaming = (text: string) => makeRun('q3', {
    status: 'in_progress',
    model_messages: [{ kind: 'response', run_id: 'q3', parts: [{ part_kind: 'text', content: text }] }] as any,
});

const frame = () => new Promise((resolve) => setTimeout(resolve, 40));

async function mountStreamingThread() {
    const { store } = await import('../../../react/store');
    const { threadRunsAtom, activeRunAtom, currentThreadIdAtom } = await import('@beaver/agent-core/run-state/atoms');
    store.set(currentThreadIdAtom, 'thread-1');
    store.set(threadRunsAtom, [makeRun('q1'), makeRun('q2')]);
    store.set(activeRunAtom, streaming('The answer so'));
    const { Provider } = await import('jotai');
    const { ThreadView } = await import('../../../react/components/agentRuns/ThreadView');
    const { userScrolledAtom } = await import('../../../react/atoms/ui');

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Provider store={store}><ThreadView isWindow={false} /></Provider>); });

    const view = host.querySelector<HTMLElement>('#alphainz-thread-view')!;
    Object.defineProperty(view, 'clientHeight', { configurable: true, value: VIEW_HEIGHT });
    Object.defineProperty(view, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(view, 'scrollHeight', { configurable: true, value: CONTENT_HEIGHT });
    Object.defineProperty(view, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, height: VIEW_HEIGHT }) });
    // The conversation's column starts at the top of the page.
    Object.defineProperty(host.querySelector('.thread-column')!, 'getBoundingClientRect', {
        configurable: true, value: () => ({ top: -view.scrollTop, height: CONTENT_HEIGHT }),
    });
    ['q1', 'q2', 'q3'].forEach((id, i) => {
        const top = () => i * 400 - view.scrollTop;
        Object.defineProperty(host.querySelector(`#user-request-${id}`)!, 'getBoundingClientRect', {
            configurable: true, value: () => ({ top: top() + 4, height: 40 }),
        });
    });
    // Following the stream, 50px from the bottom.
    view.scrollTop = CONTENT_HEIGHT - VIEW_HEIGHT - 50;
    store.set(userScrolledAtom, false);
    // The smooth scroll is the browser's; here it does not move.
    (view as any).scrollTo = vi.fn();

    // A streamed token, then a few frames for any scroll it sets off.
    const token = async (text: string) => {
        await act(async () => { store.set(activeRunAtom, streaming(text)); });
        await act(async () => { await frame(); await frame(); });
    };
    return { store, view, token, userScrolledAtom };
}

describe('a jump while an answer streams', () => {
    it('is not pulled back to the bottom by the next token', async () => {
        const { store, view, token, userScrolledAtom } = await mountStreamingThread();
        const { jumpToRun } = await import('../../../react/utils/conversationNavigation');
        const before = view.scrollTop;

        expect(jumpToRun(view, 'q2', userScrolledAtom)).toBe(true);
        // q2's request is 404px down the page; 8px of margin above it.
        expect((view as any).scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 396 }));
        expect(jumpToRun(view, 'q1', userScrolledAtom)).toBe(true);
        expect(store.get(userScrolledAtom)).toBe(true);

        await token('The answer so far, and more');
        expect(store.get(userScrolledAtom)).toBe(true);
        expect(view.scrollTop).toBe(before);
    });

    it('without one, the next token leaves the view where the reader left it', async () => {
        const { view, token } = await mountStreamingThread();
        const before = view.scrollTop;
        await token('The answer so far, and more');
        expect(view.scrollTop).toBe(before);
    });
});
