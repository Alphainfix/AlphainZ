// @vitest-environment jsdom
/**
 * A home-page action says what it does to keyboard and screen-reader users.
 *
 * Each action button shows a card with its description on hover. From the
 * keyboard the card now opens on focus, and a screen reader hears the
 * description after the button's title rather than the title a second time.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ui/openPreferencesWindow', () => ({ openPreferencesWindow: vi.fn() }));

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    document.body.innerHTML = '';
    vi.resetModules();
});

const describedBy = (element: Element) =>
    (element.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');

describe('an action on the home page', () => {
    it('is described by what it does, and shows its card on keyboard focus', async () => {
        const { store } = await import('../../../react/store');
        const { actionsAtom } = await import('../../../react/atoms/actions');
        store.set(actionsAtom, [{
            id: 'custom-1',
            title: 'Summarize the paper',
            text: 'Summarize {{items}}.',
            description: 'Five bullet points on the selected paper',
            targets: ['global'],
            category: 'research',
        }] as any);

        const { default: CategoryPanel } = await import('../../../react/components/CategoryPanel');
        const { Provider } = await import('jotai');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => {
            root.render(React.createElement(Provider, { store }, React.createElement(CategoryPanel, { category: 'research' })));
        });

        const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Summarize the paper'))!;
        expect(button).toBeTruthy();
        expect(describedBy(button)).toBe('Five bullet points on the selected paper');

        await act(async () => { button.focus(); });
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Five bullet points on the selected paper');

        // The open card positions itself on a timer; unmounting clears it, where
        // leaving it would fire after the test environment is gone.
        await act(async () => { root.unmount(); });
    });
});
