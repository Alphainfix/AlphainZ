// @vitest-environment jsdom
/**
 * The header's icons say what they do.
 *
 * Settings sat behind a person silhouette — an account menu in a build with
 * no accounts — whose only item was "Settings", while the guide and every
 * error message say "Settings". It is a gear now and opens Settings in one
 * click. The step display used the brain icon that also marks the model
 * picker in the composer; it has an eye of its own.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrainIcon, SettingsIcon, UserIcon, ViewIcon } from '@beaver/agent-ui/icons';

const openPreferencesWindow = vi.fn();
vi.mock('../../../src/ui/openPreferencesWindow', () => ({
    openPreferencesWindow: (...args: unknown[]) => openPreferencesWindow(...args),
}));

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    openPreferencesWindow.mockClear();
    document.body.innerHTML = '';
    vi.resetModules();
});

async function render(element: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(element); });
    return host;
}

/** The drawing of an icon, to tell which one a button shows. */
async function drawing(icon: React.ComponentType<React.SVGProps<SVGSVGElement>>): Promise<string> {
    const host = await render(React.createElement(icon));
    const paths = [...host.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|');
    host.remove();
    return paths;
}

const shownDrawing = (button: Element) =>
    [...button.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|');

describe('the Settings button', () => {
    it('is a gear that opens Settings directly, with no menu in between', async () => {
        const { default: UserAccountMenuButton } = await import('../../../react/components/ui/buttons/UserAccountMenuButton');
        const host = await render(React.createElement(UserAccountMenuButton, { ariaLabel: 'AlphainZ settings' }));
        const button = host.querySelector<HTMLButtonElement>('[aria-label="AlphainZ settings"]')!;
        expect(button).toBeTruthy();
        expect(button.getAttribute('aria-haspopup')).toBeNull();
        expect(shownDrawing(button)).toBe(await drawing(SettingsIcon));
        expect(shownDrawing(button)).not.toBe(await drawing(UserIcon));

        await act(async () => { button.click(); });
        expect(openPreferencesWindow).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });
});

describe('the step display button', () => {
    it('does not use the brain icon of the model picker', async () => {
        const { store } = await import('../../../react/store');
        const { Provider } = await import('jotai');
        const { default: StreamDisplayButton } = await import('../../../react/components/ui/buttons/StreamDisplayButton');
        const host = await render(React.createElement(Provider, { store }, React.createElement(StreamDisplayButton)));
        const button = host.querySelector('[aria-label="Step display"]')!;
        expect(shownDrawing(button)).toBe(await drawing(ViewIcon));
        expect(shownDrawing(button)).not.toBe(await drawing(BrainIcon));
    });
});
