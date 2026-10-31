// @vitest-environment jsdom
 

/**
 * The Model settings section mounts in a real DOM and survives its effects.
 *
 * The static-markup tests check what the section says; this one checks that it
 * does not throw once React runs its effects and event handlers — a blank
 * preferences tab is what a render-time throw looks like to the user.
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

const setPrefs = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) prefs[`${PREFIX}.${key}`] = value;
};

async function mount(): Promise<HTMLDivElement> {
    const { default: ModelSettingsSection } = await import('../../../react/components/preferences/ModelSettingsSection');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(React.createElement(ModelSettingsSection)); });
    await act(async () => { await Promise.resolve(); });
    return container;
}

describe('ModelSettingsSection in a live DOM', () => {
    it('mounts with a configured vendor and a stored custom provider, and opens a card for editing', async () => {
        setPrefs({
            llmKeyDeepseek: 'k', llmProvider: 'deepseek', llmModel: 'deepseek-flash',
            customEndpoints: JSON.stringify([{ id: 'ep-1', name: 'My proxy', baseUrl: 'https://proxy.example.com/v1', apiKey: '', authStyle: 'bearer',
                models: [{ id: 'm1', supportsVision: false, reasoningEffort: false }] }]),
        });
        const el = await mount();
        expect(el.querySelectorAll('[data-testid="provider-card"]')).toHaveLength(2);
        const edit = el.querySelector('[aria-label="Edit DeepSeek"]') as HTMLButtonElement;
        await act(async () => { edit.click(); });
        // The key field shows a placeholder, never the key.
        const key = el.querySelector('[aria-label="DeepSeek API key"]') as HTMLInputElement;
        expect(key.placeholder).toMatch(/Configured/);
        expect(key.value).toBe('');
        // Custom settings open the catalogue with the preset's models.
        const advanced = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Custom settings')) as HTMLButtonElement;
        await act(async () => { advanced.click(); });
        const ids = Array.from(el.querySelectorAll('[aria-label="Model id"]')).map((i) => (i as HTMLInputElement).value);
        expect(ids).toEqual(['deepseek-flash']);
        // Adding a row and saving writes an edited catalogue for the preset.
        const add = el.querySelector('[aria-label="Add model"]') as HTMLButtonElement;
        await act(async () => { add.click(); });
        const inputs = el.querySelectorAll('[aria-label="Model id"]');
        const last = inputs[inputs.length - 1] as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(last, 'deepseek-v4.1-flash');
            last.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const save = el.querySelector('[aria-label="Save DeepSeek"]') as HTMLButtonElement;
        await act(async () => { save.click(); });
        const overrides = JSON.parse(String(prefs[`${PREFIX}.providerOverrides`]));
        expect(overrides.deepseek.models.map((m: any) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4.1-flash']);
        expect(overrides['deepseek-vision']).toBeUndefined();
    });

    it('adds a custom provider through Save, and drops it on Cancel', async () => {
        const el = await mount();
        const add = el.querySelector('[aria-label="Add custom provider"]') as HTMLButtonElement;
        await act(async () => { add.click(); });
        const name = el.querySelector('[aria-label="Provider name"]') as HTMLInputElement;
        const address = el.querySelector('[aria-label="Provider API address"]') as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        await act(async () => {
            setter.call(name, 'Local box'); name.dispatchEvent(new Event('input', { bubbles: true }));
            setter.call(address, 'http://127.0.0.1:8765/v1'); address.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const save = el.querySelector('[aria-label="Save provider"]') as HTMLButtonElement;
        await act(async () => { save.click(); });
        const stored = JSON.parse(String(prefs[`${PREFIX}.customEndpoints`]));
        expect(stored).toHaveLength(1);
        expect(stored[0].name).toBe('Local box');
        expect(stored[0].baseUrl).toBe('http://127.0.0.1:8765/v1');

        // A second new card, cancelled, leaves nothing behind.
        await act(async () => { add.click(); });
        const cancel = el.querySelector('[aria-label="Cancel editing provider"]') as HTMLButtonElement;
        await act(async () => { cancel.click(); });
        expect(JSON.parse(String(prefs[`${PREFIX}.customEndpoints`]))).toHaveLength(1);
    });

    it('mounts with nothing configured at all', async () => {
        const el = await mount();
        expect(el.textContent).toContain('No providers yet');
    });
});
