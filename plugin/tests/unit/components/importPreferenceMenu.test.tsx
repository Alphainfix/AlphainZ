// @vitest-environment jsdom
 
/**
 * The permission menu on a card offers only choices that take effect.
 *
 * Adding papers has no standing preference — a saved "always apply" is read
 * past — so its card shows "Always asks" with nothing to pick, instead of a
 * menu whose "Always apply" would be saved and ignored.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => ''),
    setPref: vi.fn(),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import DeferredToolPreferenceButton from '../../../react/components/ui/buttons/DeferredToolPreferenceButton';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(toolName: string, props: { offersRunGrant?: boolean } = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(DeferredToolPreferenceButton, { toolName, ...props }));
    });
    return container.querySelector('button') as HTMLButtonElement;
}

/** What the button's tooltip says, as assistive technology reads it. */
const explanation = (button: HTMLButtonElement) => (button.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => (id ? document.getElementById(id)?.textContent ?? '' : ''))
    .join(' ')
    .trim();

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('the card’s permission menu', () => {
    it('shows adding papers as always asking, with nothing to choose', async () => {
        const button = await mount('create_item');
        expect(button.textContent).toBe('Always asks');
        expect(button.disabled).toBe(true);
    });

    it('points to "Allow for this run" only on a card whose Apply button offers it', async () => {
        // A card restored as a pending record has a plain Apply.
        let button = await mount('create_item');
        expect(explanation(button)).toBe('Adding papers always asks: each paper is added only once you apply it.');
        act(() => root?.unmount());
        container?.remove();

        // A card with its approval still waiting has the split Apply.
        button = await mount('create_item', { offersRunGrant: true });
        expect(explanation(button)).toContain('"Allow for this run" on the Apply button');
    });

    it('still offers the choices where they take effect', async () => {
        const button = await mount('create_highlight_annotations');
        expect(button.textContent).toBe('Always ask');
        expect(button.disabled).toBe(false);
    });
});
