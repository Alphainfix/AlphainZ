// @vitest-environment jsdom
/**
 * The chat-history list, mounted with no account.
 *
 * This is the test that was missing. The list's data path was verified through
 * the helpers it calls, which all worked — while the component itself opened
 * with `if (!user) return` and never reached them. Verifying a data path proves
 * nothing about the component that is supposed to walk it, so this mounts the
 * real component and looks for rows.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

const thread = (id: string, name: string) => ({
    id,
    name,
    createdAt: '2026-08-23T15:00:00.000Z',
    updatedAt: '2026-08-23T15:00:00.000Z',
});

const STORED = [
    thread('t1', '我库里有哪些关于 waggle dance 和蜜蜂导航的论文？'),
    thread('t2', 'What does this paper measure?'),
    thread('t3', 'Highlight the sentence about covariance'),
];

let getThreadsPaginated: ReturnType<typeof vi.fn>;
let searchThreadsLocal: ReturnType<typeof vi.fn>;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs = {};
    // A configured model is what puts the plugin on the local path at all.
    prefs[`${PREFIX}.llmProvider`] = 'deepseek';
    prefs[`${PREFIX}.llmModel`] = 'deepseek-flash';
    prefs[`${PREFIX}.llmKeyDeepseek`] = 'sk-test';
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => {
        prefs[key] = value;
    });

    getThreadsPaginated = vi.fn(async (_userId: string, limit: number, offset: number) => ({
        threads: STORED.slice(offset, offset + limit),
    }));
    searchThreadsLocal = vi.fn(async (_userId: string, query: string) =>
        STORED.filter((t) => t.name.includes(query)),
    );
    (Zotero as any).AlphainZ = { data: { env: 'test' }, db: { getThreadsPaginated, searchThreadsLocal } };
    vi.resetModules();
});

/** Mount the list and let its fetch effect settle. */
async function mount(): Promise<HTMLElement> {
    const { default: ThreadListView } = await import('../../../react/components/ThreadListView');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(React.createElement(ThreadListView, { isWindow: false }));
    });
    // The fetch is async; flush the microtask queue it settles on.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return host;
}

describe('ThreadListView with no account', () => {
    it('lists the conversations on disk', async () => {
        const host = await mount();
        expect(getThreadsPaginated).toHaveBeenCalled();
        expect(host.textContent).toContain('waggle dance');
        expect(host.textContent).toContain('What does this paper measure?');
    });

    it('asks the local database for the fixed local owner', async () => {
        await mount();
        expect(getThreadsPaginated.mock.calls[0][0]).toBe('local-user');
    });

    it('pages from an offset rather than a cursor', async () => {
        // There is no server cursor locally; the rows already shown are the
        // offset. Without this the list stopped at one page.
        await mount();
        const [, limit, offset] = getThreadsPaginated.mock.calls[0];
        expect(offset).toBe(0);
        expect(typeof limit).toBe('number');
    });
});
