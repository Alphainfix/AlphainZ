// @vitest-environment jsdom
/**
 * "This chat is long" is about the chat, not about what one answer read.
 *
 * A first question that reads a long paper sends well over 100k input tokens
 * by its last request, because each request carries what was read so far. The
 * bar used to count that and told a student with one message to start over —
 * where the paper would only be read again. It now counts the first request,
 * what every further message resends, and says "chat" like the rest of the UI.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    document.body.innerHTML = '';
    vi.resetModules();
});

/** Usage of one answer: the input tokens of each of its requests, in order. */
const usage = (...requests: number[]) => ({
    requests: requests.length,
    input_tokens: requests.reduce((sum, n) => sum + n, 0),
    output_tokens: 900,
    model_requests: requests.map((input_tokens) => ({ input_tokens })),
});

describe('longChatInputTokens', () => {
    it('ignores what one answer read along the way', async () => {
        const { longChatInputTokens } = await import('../../../react/components/input/HighTokenUsageWarningBar');
        // Question one: 14k to start, 150k by the time both papers were read.
        expect(longChatInputTokens(usage(14_000, 82_000, 150_000) as any)).toBeNull();
    });

    it('counts what every further message resends', async () => {
        const { longChatInputTokens } = await import('../../../react/components/input/HighTokenUsageWarningBar');
        expect(longChatInputTokens(usage(131_000, 140_000) as any)).toBe(131_000);
    });

    it('reads a single request as both first and last', async () => {
        const { longChatInputTokens } = await import('../../../react/components/input/HighTokenUsageWarningBar');
        expect(longChatInputTokens({ requests: 1, input_tokens: 120_000, output_tokens: 10 } as any)).toBe(120_000);
    });
});

describe('the bar above the composer', () => {
    async function mount(lastRunUsage: unknown) {
        const { store } = await import('../../../react/store');
        const { threadRunsAtom } = await import('@beaver/agent-core/run-state/atoms');
        store.set(threadRunsAtom, [{ id: 'run-1', thread_id: 'th-1', status: 'completed', total_usage: lastRunUsage }] as any);
        const { default: HighTokenUsageWarningBar } = await import('../../../react/components/input/HighTokenUsageWarningBar');
        const { Provider } = await import('jotai');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(React.createElement(
                Provider,
                { store },
                React.createElement(HighTokenUsageWarningBar, {
                    onNewThread: () => {},
                    onDismiss: () => {},
                    isUsingBeaverCredits: false,
                }),
            ));
        });
        return host;
    }

    it('stays away after one question that read a long paper', async () => {
        const host = await mount(usage(14_000, 150_000));
        expect(host.textContent).toBe('');
    });

    it('speaks of a chat, says how much it resends, and that old exchanges are summarized', async () => {
        prefs[`${PREFIX}.contextCompactionEnabled`] = true;
        const host = await mount(usage(131_000, 140_000));
        expect(host.textContent).toContain('This chat is long');
        expect(host.textContent).toContain('131k tokens');
        expect(host.textContent).toContain('older exchanges are summarized automatically');
        expect(host.textContent).toContain('Start a new chat');
        expect(host.textContent).not.toMatch(/thread/i);
        expect(host.querySelector('[aria-label="Dismiss long chat warning"]')).toBeTruthy();
    });

    it('does not promise summaries when they are turned off', async () => {
        prefs[`${PREFIX}.contextCompactionEnabled`] = false;
        const host = await mount(usage(131_000, 140_000));
        expect(host.textContent).toContain('This chat is long');
        expect(host.textContent).not.toContain('summarized');
    });
});
