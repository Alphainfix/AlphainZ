// @vitest-environment jsdom
/**
 * The "Recent" list on the home page, with no account.
 *
 * Its fetch was fixed to read the local database before its click handler was —
 * so the rows appeared and clicking one did nothing at all. Both halves are
 * checked here.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

const STORED = [
    {
        id: 't1',
        name: '我库里有哪些关于 waggle dance 的论文？',
        createdAt: '2026-08-23T15:00:00.000Z',
        updatedAt: '2026-08-23T15:00:00.000Z',
    },
];

let getThreadsPaginated: ReturnType<typeof vi.fn>;
let getRunsForThread: ReturnType<typeof vi.fn>;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs = {};
    prefs[`${PREFIX}.llmProvider`] = 'deepseek';
    prefs[`${PREFIX}.llmModel`] = 'deepseek-flash';
    prefs[`${PREFIX}.llmKeyDeepseek`] = 'sk-test';
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => {
        prefs[key] = value;
    });

    getThreadsPaginated = vi.fn(async () => ({ threads: STORED }));
    getRunsForThread = vi.fn(async () => []);
    (Zotero as any).AlphainZ = { data: { env: 'test' }, db: { getThreadsPaginated, getRunsForThread } };
    vi.resetModules();
});

async function mount(): Promise<HTMLElement> {
    const { default: RecentChats } = await import('../../../react/components/RecentChats');
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    // Wrapped in the plugin's own store, as the sidebar wraps it: without the
    // Provider the component would talk to jotai's default store and nothing
    // the rest of the app sets would reach it.
    await act(async () => {
        root.render(
            React.createElement(Provider, { store }, React.createElement(RecentChats)),
        );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return host;
}

describe('RecentChats with no account', () => {
    it('lists recent conversations from the local database', async () => {
        const host = await mount();
        expect(getThreadsPaginated).toHaveBeenCalled();
        expect(host.textContent).toContain('waggle dance');
    });

    it('opens a conversation when its row is clicked', async () => {
        // The row rendering and the row working were two separate fixes; the
        // first landing alone looks identical to nothing being wrong. Asserted
        // on the transcript read the load performs, which is the observable
        // consequence rather than a guess at how loading is wired.
        const host = await mount();
        const row = host.querySelector('.recent-chats-item') as HTMLElement | null;
        expect(row).not.toBeNull();
        await act(async () => { row!.click(); });
        await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

        expect(getRunsForThread).toHaveBeenCalledWith('t1');
    });
});
