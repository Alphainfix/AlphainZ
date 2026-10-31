// @vitest-environment jsdom
 
/**
 * A Next-steps chip sends its own question, not the half-written draft's.
 *
 * The send keeps in the composer everything the draft mark records, so the
 * chip marks what the composer holds before it sends: the papers staged for
 * the draft stay with the draft.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sent = vi.hoisted(() => ({
    calls: [] as Array<{ message: string; markAtSend: unknown }>,
    markAtom: null as any,
}));

vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return {
        isWSChatPendingAtom: atom(false),
        sendWSMessageAtom: atom(null, (get, _set, message: string) => {
            sent.calls.push({ message, markAtSend: sent.markAtom ? get(sent.markAtom) : undefined });
        }),
    };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    sent.calls = [];
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('a suggestion chip', () => {
    it('marks the draft’s attachments as the draft’s before it sends', async () => {
        const { createStore, Provider } = await import('jotai');
        const { currentMessageItemsAtom, composerDraftMarkAtom } = await import('../../../react/atoms/messageComposition');
        const { SuggestionsView } = await import('../../../react/components/agentRuns/SuggestionsView');
        sent.markAtom = composerDraftMarkAtom;
        const store = createStore();
        store.set(currentMessageItemsAtom, [{ libraryID: 1, key: 'PAPER001' } as any]);
        store.set(composerDraftMarkAtom, null);

        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root!.render(React.createElement(Provider, { store }, React.createElement(SuggestionsView, {
                part: {
                    part_kind: 'tool-call',
                    tool_name: 'return_suggestions',
                    tool_call_id: 'call-s',
                    args: { suggestions: [{ text: 'Compare with Smith 2021', query: 'Compare this with Smith 2021', goal: 'expand' }] },
                } as any,
            })));
        });

        const chip = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Compare with Smith 2021')!;
        await act(async () => { chip.click(); });

        expect(sent.calls).toHaveLength(1);
        expect(sent.calls[0].message).toBe('Compare this with Smith 2021');
        expect(sent.calls[0].markAtSend).toMatchObject({ itemKeys: ['1-PAPER001'] });
    });
});
