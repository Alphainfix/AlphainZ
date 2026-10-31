// @vitest-environment jsdom
/**
 * The policy every reader entry point now shares.
 *
 * Four menu items and one popup route through here. Each one used to clear the
 * panel and start over, so asking about a second passage discarded the
 * conversation the first one produced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { continueOrStartThread, deliverPrompt } from '../../../react/utils/readerChatDelivery';
import { store } from '../../../react/store';
import { currentThreadIdAtom } from '../../../react/atoms/threads';
import { isWSChatPendingAtom } from '../../../react/atoms/agentRunAtoms';
import { currentMessageContentAtom } from '../../../react/atoms/messageComposition';

beforeEach(() => {
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    store.set(currentThreadIdAtom, null);
    store.set(isWSChatPendingAtom, false);
    store.set(currentMessageContentAtom, '');
});

describe('continueOrStartThread', () => {
    it('starts a conversation when the panel is empty', async () => {
        const start = vi.fn(async () => {});
        const result = await continueOrStartThread(start);
        expect(start).toHaveBeenCalledWith({ skipAutoPopulate: true });
        expect(result.continued).toBe(false);
    });

    it('leaves an open conversation alone', async () => {
        // The whole point: a second question from the reader adds to the
        // conversation the first one produced.
        store.set(currentThreadIdAtom, 'th1');
        const start = vi.fn(async () => {});
        const result = await continueOrStartThread(start);
        expect(start).not.toHaveBeenCalled();
        expect(result.continued).toBe(true);
    });
});

describe('deliverPrompt', () => {
    it('sends the prompt when nothing is in flight', async () => {
        const send = vi.fn(async () => {});
        expect(await deliverPrompt(send, 'explain this')).toBe('sent');
        expect(send).toHaveBeenCalledWith('explain this', undefined);
    });

    it('passes options through to the sender', async () => {
        const send = vi.fn(async () => {});
        const origin = { origin: { kind: 'selection_chat' } };
        await deliverPrompt(send, 'q', origin);
        expect(send).toHaveBeenCalledWith('q', origin);
    });

    it('stages the prompt in the composer while a run is in flight', async () => {
        // Sending refuses concurrent requests and returns silently, so the menu
        // item looked like it did nothing at all.
        store.set(isWSChatPendingAtom, true);
        const send = vi.fn(async () => {});
        expect(await deliverPrompt(send, 'explain this')).toBe('staged');
        expect(send).not.toHaveBeenCalled();
        expect(store.get(currentMessageContentAtom)).toBe('explain this');
    });

    it('does not lose the prompt it staged', async () => {
        store.set(isWSChatPendingAtom, true);
        await deliverPrompt(vi.fn(async () => {}), 'the question');
        expect(store.get(currentMessageContentAtom)).toContain('the question');
    });
});
