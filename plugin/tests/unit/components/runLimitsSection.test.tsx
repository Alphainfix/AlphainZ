// @vitest-environment jsdom
 

/**
 * The limits per question can be read and changed in Settings → Advanced.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function mount(): Promise<HTMLDivElement> {
    const { default: RunLimitsSection } = await import('../../../react/components/preferences/RunLimitsSection');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<RunLimitsSection />); });
    return container;
}

const select = (el: HTMLElement, label: string) => el.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;

describe('Limits per Question', () => {
    it('shows the defaults when nothing is set', async () => {
        const el = await mount();
        expect(el.textContent).toContain('Limits per Question');
        expect(select(el, 'Output tokens per reply').value).toBe('0');
        expect(select(el, 'Model requests per question').value).toBe('24');
        expect(select(el, 'Library searches per question').value).toBe('20');
        expect(select(el, 'Literature lookups per question').value).toBe('20');
    });

    it('offers ten, twenty and no limit for both kinds of search', async () => {
        const el = await mount();
        for (const label of ['Library searches per question', 'Literature lookups per question']) {
            const values = Array.from(select(el, label).options).map((o) => o.value);
            expect(values).toEqual(['10', '20', '0']);
        }
    });

    it('writes a choice to its pref', async () => {
        const el = await mount();
        const output = select(el, 'Output tokens per reply');
        await act(async () => {
            output.value = '64000';
            output.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(prefs[`${PREFIX}.maxOutputTokens`]).toBe(64000);

        const lookups = select(el, 'Literature lookups per question');
        await act(async () => {
            lookups.value = '0';
            lookups.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(prefs[`${PREFIX}.maxLiteratureLookups`]).toBe(0);
        expect(lookups.selectedOptions[0].textContent).toBe('No limit');
    });

    it('shows a stored value that is not one of the choices as itself', async () => {
        // Set on another machine or by hand; showing the first option instead
        // would misreport what the next run uses.
        prefs[`${PREFIX}.maxModelRequests`] = 37;
        const el = await mount();
        const requests = select(el, 'Model requests per question');
        expect(requests.value).toBe('37');
        expect(requests.selectedOptions[0].textContent).toContain('custom');
    });
});
