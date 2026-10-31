/**
 * The state behind the question rail and the outline.
 *
 * The questions are derived from the runs, which change on every streamed
 * token; the rail, the outline and the header badge must hear about it only
 * when something they draw changes. The outline opens per surface — the
 * sidebar and the separate window share one store but not one outline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';

beforeEach(() => {
    (Zotero as any).__alphainzJotaiStore = undefined;
    vi.resetModules();
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

const withText = (id: string, text: string, status: AgentRun['status']) => makeRun(id, {
    status,
    model_messages: [{ kind: 'response', run_id: id, parts: [{ part_kind: 'text', content: text }] }] as any,
});

describe('the questions', () => {
    it('stay the same object while a run streams, and change when it finishes', async () => {
        const { store } = await import('../../../react/store');
        const { threadRunsAtom, activeRunAtom } = await import('@beaver/agent-core/run-state/atoms');
        const { conversationTurnsAtom, conversationTurnCountAtom } = await import('../../../react/atoms/conversationNav');

        store.set(threadRunsAtom, [withText('a', 'The first answer.', 'completed')]);
        store.set(activeRunAtom, withText('b', 'Hal', 'in_progress'));
        const notified: number[] = [];
        const unsubscribe = store.sub(conversationTurnsAtom, () => notified.push(store.get(conversationTurnsAtom).length));
        const before = store.get(conversationTurnsAtom);
        expect(store.get(conversationTurnCountAtom)).toBe(2);

        store.set(activeRunAtom, withText('b', 'Halfway', 'in_progress'));
        store.set(activeRunAtom, withText('b', 'Halfway there', 'in_progress'));
        expect(notified).toEqual([]);
        expect(store.get(conversationTurnsAtom)).toBe(before);

        store.set(activeRunAtom, withText('b', 'Halfway there, done.', 'completed'));
        expect(notified).toEqual([2]);
        expect(store.get(conversationTurnsAtom)[1].answer).toBe('Halfway there, done.');
        unsubscribe();
    });
});

describe('opening the outline', () => {
    it('opens and closes the outline of one surface only', async () => {
        const { store } = await import('../../../react/store');
        const {
            conversationOutlineOpenAtom,
            windowConversationOutlineOpenAtom,
            toggleConversationOutlineAtom,
        } = await import('../../../react/atoms/conversationNav');

        store.set(toggleConversationOutlineAtom, true);
        expect(store.get(windowConversationOutlineOpenAtom)).toBe(true);
        expect(store.get(conversationOutlineOpenAtom)).toBe(false);

        store.set(toggleConversationOutlineAtom, false);
        expect(store.get(conversationOutlineOpenAtom)).toBe(true);

        store.set(toggleConversationOutlineAtom, true);
        expect(store.get(windowConversationOutlineOpenAtom)).toBe(false);
        expect(store.get(conversationOutlineOpenAtom)).toBe(true);
    });

    it('closes the chat history, which takes the same space; closing leaves it alone', async () => {
        const { store } = await import('../../../react/store');
        const { isThreadListViewAtom } = await import('../../../react/atoms/ui');
        const { toggleConversationOutlineAtom } = await import('../../../react/atoms/conversationNav');

        store.set(isThreadListViewAtom, true);
        store.set(toggleConversationOutlineAtom, false);
        expect(store.get(isThreadListViewAtom)).toBe(false);

        store.set(isThreadListViewAtom, true);
        store.set(toggleConversationOutlineAtom, false);
        expect(store.get(isThreadListViewAtom)).toBe(true);
    });
});
