// @vitest-environment jsdom
/**
 * The error card offers what can actually help.
 *
 * A model that is not set up on this computer, or a key the provider
 * rejected, fails the same way on every retry until a setting changes. The
 * card opens that setting instead of offering a Retry that cannot work, and
 * brings Retry back once the user has been there. A transient failure keeps
 * its Retry, and the provider's own reason is shown under the headline.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openPreferencesWindow = vi.fn();
vi.mock('../../../src/ui/openPreferencesWindow', () => ({
    openPreferencesWindow: (...args: unknown[]) => openPreferencesWindow(...args),
}));

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    openPreferencesWindow.mockClear();
    document.body.innerHTML = '';
    vi.resetModules();
});

async function mountCard(error: Record<string, unknown>, isLastRun = true) {
    const { RunErrorDisplay } = await import('../../../react/components/agentRuns/RunErrorDisplay');
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(RunErrorDisplay, { runId: 'run-1', error: error as any, isLastRun }),
            ),
        );
    });
    return host;
}

const action = (host: HTMLElement, name: string) =>
    host.querySelector<HTMLButtonElement>(`[data-run-error-action="${name}"]`);

describe('a run that could not start because the model is not set up', () => {
    const notConfigured = {
        type: 'not_configured',
        message: 'DeepSeek needs an API key on this computer. Paste it into its card under Settings → Model → Providers.',
        is_retryable: false,
    };

    it('is titled for what went wrong and opens the Model settings', async () => {
        const host = await mountCard(notConfigured);
        expect(host.textContent).toContain('Model Not Set Up');
        expect(host.textContent).not.toContain('An error occurred');

        const open = action(host, 'open-settings');
        expect(open).toBeTruthy();
        expect(open!.textContent).toContain('Open Settings → Model');
        // Voice control users say what they see, so the button's name holds its visible label.
        const name = open!.getAttribute('aria-label') ?? open!.textContent ?? '';
        expect(name).toContain('Open Settings → Model');
        expect(open!.getAttribute('data-run-error-primary-action')).toBe('true');
        await act(async () => { open!.click(); });
        expect(openPreferencesWindow).toHaveBeenCalledWith('models');
    });

    it('offers no Retry until the user has been to Settings', async () => {
        const host = await mountCard(notConfigured);
        expect(action(host, 'retry')).toBeNull();

        await act(async () => { action(host, 'open-settings')!.click(); });
        expect(action(host, 'retry')).toBeTruthy();
    });
});

describe('a key the provider rejected', () => {
    it('opens the Model settings rather than retrying', async () => {
        const host = await mountCard({
            type: 'llm_auth_error',
            message: 'DeepSeek rejected the API key (401). Check the key on its card under Settings → Model → Providers.',
            user_facing_details: 'Authentication Fails, Your api key: ****abcd is invalid',
            is_retryable: false,
        });
        expect(action(host, 'open-settings')).toBeTruthy();
        expect(action(host, 'retry')).toBeNull();
        expect(host.textContent).toContain('Reason: Authentication Fails, Your api key: ****abcd is invalid');
    });
});

describe('a failure retrying can fix', () => {
    it('keeps Retry and does not point at Settings', async () => {
        const host = await mountCard({
            type: 'llm_timeout',
            message: 'DeepSeek stopped responding. Try again in a moment.',
            is_retryable: true,
        });
        expect(action(host, 'retry')).toBeTruthy();
        expect(action(host, 'open-settings')).toBeNull();
    });

    it('keeps Retry for a stored error that does not say whether it is retryable', async () => {
        const host = await mountCard({ type: 'llm_service_unavailable', message: 'DeepSeek had a server problem (503).' });
        expect(action(host, 'retry')).toBeTruthy();
    });
});

describe('a failure neither retrying nor a setting can fix', () => {
    it('offers neither', async () => {
        const host = await mountCard({
            type: 'llm_context_window_exceeded',
            message: 'This conversation is too long for the model (400). Start a new chat, or ask about fewer papers at once.',
            is_retryable: false,
        });
        expect(action(host, 'retry')).toBeNull();
        expect(action(host, 'open-settings')).toBeNull();
    });
});

describe('an earlier run in the chat', () => {
    it('keeps its buttons to itself: they belong to the last run', async () => {
        const host = await mountCard({ type: 'not_configured', message: 'No model is set up yet.', is_retryable: false }, false);
        expect(action(host, 'open-settings')).toBeNull();
        expect(action(host, 'retry')).toBeNull();
    });
});
