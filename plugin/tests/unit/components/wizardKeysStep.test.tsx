// @vitest-environment jsdom
 

/**
 * The welcome wizard's "Connect a model" step.
 *
 * - The key field stays while a key is typed and saves it when the field is
 *   left, or when the step closes with the field still focused; a paste saves
 *   and tests at once, and screen readers hear what the Test found. Saving on
 *   every keystroke swapped the field for "Already set ✓" after one character
 *   and stored that character as the key.
 * - "Already set ✓" means a key that was there when the step opened.
 * - Clearing a key gives up the model it had picked.
 * - In a narrow side pane the rows stack, with one line of description each.
 * Also: the feature tour says where changes to the library are turned on, and
 * the vendor notes match the catalogue.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const verify = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../../../src/services/llm/verifyKey', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    verifyChatProvider: verify.chat,
}));

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const pref = (key: string) => prefs[`${PREFIX}.${key}`];

beforeEach(() => {
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    verify.chat.mockReset();
    verify.chat.mockResolvedValue({ ok: true, message: 'Connected in 200 ms.' });
    vi.resetModules();
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function mountStep(): Promise<HTMLDivElement> {
    const { default: ApiKeysStep } = await import('../../../react/components/pages/wizard/steps/ApiKeysStep');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(React.createElement(ApiKeysStep)); });
    return container;
}

const field = (el: HTMLElement, label: string) => el.querySelector(`[aria-label="${label} API key"]`) as HTMLInputElement | null;
const setter = () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

async function typeInto(input: HTMLInputElement, text: string) {
    for (let i = 1; i <= text.length; i++) {
        await act(async () => {
            setter().call(input, text.slice(0, i));
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
}
async function pasteInto(input: HTMLInputElement, text: string) {
    await act(async () => {
        input.dispatchEvent(new Event('paste', { bubbles: true }));
        setter().call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
}
async function clearAndLeave(input: HTMLInputElement) {
    await act(async () => {
        input.focus();
        setter().call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.blur(); });
}

describe('a key typed into the wizard', () => {
    it('keeps its field while it is typed, and is saved whole when the field is left', async () => {
        const el = await mountStep();
        const input = field(el, 'DeepSeek')!;
        input.focus();
        await typeInto(input, 'sk-abc');
        // Still the same field, and nothing half-typed was stored.
        expect(field(el, 'DeepSeek')).toBe(input);
        expect(el.textContent).not.toContain('Already set');
        expect(pref('llmKeyDeepseek')).toBeUndefined();

        await act(async () => { input.blur(); });
        expect(pref('llmKeyDeepseek')).toBe('sk-abc');
        expect(field(el, 'DeepSeek')).toBe(input);
        expect(verify.chat).not.toHaveBeenCalled();
    });

    it('is saved and tested at once when pasted', async () => {
        const el = await mountStep();
        await pasteInto(field(el, 'DeepSeek')!, 'sk-pasted');
        expect(pref('llmKeyDeepseek')).toBe('sk-pasted');
        expect(verify.chat).toHaveBeenCalledWith('deepseek', 'sk-pasted', expect.anything(), {});
        expect(el.textContent).toContain('Key works — saved.');
    });

    it('is saved when the step closes while the field still has focus', async () => {
        const el = await mountStep();
        const input = field(el, 'DeepSeek')!;
        input.focus();
        await typeInto(input, 'sk-typed');
        expect(pref('llmKeyDeepseek')).toBeUndefined();
        // The window closed from the keyboard: no blur reaches the field.
        act(() => root!.unmount());
        root = null;
        expect(pref('llmKeyDeepseek')).toBe('sk-typed');
    });

    it('announces what its Test found to screen readers', async () => {
        verify.chat.mockResolvedValueOnce({ ok: false, message: 'The model rejected the API key (401).' });
        const el = await mountStep();
        await pasteInto(field(el, 'DeepSeek')!, 'sk-bad');
        const alert = el.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('rejected the API key');
        expect(alert?.closest('[aria-hidden="true"]')).toBeNull();

        await pasteInto(field(el, 'OpenAI')!, 'sk-good');
        const status = el.querySelector('[role="status"]');
        expect(status?.textContent).toBe('Key works — saved.');
        expect(status?.closest('[aria-hidden="true"]')).toBeNull();
        // A row's plain description is still left out, as beside any control.
        const note = Array.from(el.querySelectorAll('span[title]')).find((s) => s.closest('[aria-hidden="true"]'));
        expect(note).toBeTruthy();
    });

    it('shows "Already set ✓" only for a key that was there when the step opened', async () => {
        prefs[`${PREFIX}.llmKeyOpenrouter`] = 'k-h';
        const el = await mountStep();
        expect(field(el, 'OpenRouter')).toBeNull();
        expect(el.textContent).toContain('Already set ✓');
        const change = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Change')!;
        await act(async () => { change.click(); });
        expect(field(el, 'OpenRouter')).not.toBeNull();
    });
});

describe('a key pasted into the wrong row and cleared', () => {
    it('gives up the model it picked, so the right key picks again', async () => {
        verify.chat.mockResolvedValueOnce({ ok: false, message: 'The model rejected the API key (401).' });
        const el = await mountStep();
        // A DeepSeek key pasted into the OpenRouter row picks OpenRouter's model.
        await pasteInto(field(el, 'OpenRouter')!, 'sk-deepseek');
        expect(pref('llmProvider')).toBe('openrouter');
        expect(el.textContent).toContain('rejected the API key');

        await clearAndLeave(field(el, 'OpenRouter')!);
        expect(pref('llmKeyOpenrouter')).toBe('');
        expect(pref('llmProvider')).toBe('');

        await pasteInto(field(el, 'DeepSeek')!, 'sk-deepseek');
        expect(pref('llmProvider')).toBe('deepseek');
        expect(pref('llmModel')).toBe('deepseek-flash');
    });
});

describe('a key pasted into the wrong row and left there', () => {
    it('gives the model to the next key that passes its Test', async () => {
        verify.chat.mockImplementation(async (id: string) => (id === 'openrouter'
            ? { ok: false, message: 'The model rejected the API key (401).' }
            : { ok: true, message: 'Connected in 200 ms.' }));
        const el = await mountStep();
        await pasteInto(field(el, 'OpenRouter')!, 'sk-deepseek');
        expect(pref('llmProvider')).toBe('openrouter');
        await pasteInto(field(el, 'DeepSeek')!, 'sk-deepseek');
        expect(pref('llmProvider')).toBe('deepseek');
        expect(pref('llmModel')).toBe('deepseek-flash');
    });

    it('keeps a first pick whose key works', async () => {
        const el = await mountStep();
        await pasteInto(field(el, 'OpenRouter')!, 'k-openrouter');
        await pasteInto(field(el, 'DeepSeek')!, 'sk-deepseek');
        expect(pref('llmProvider')).toBe('openrouter');
    });
});

describe('in a narrow side pane', () => {
    it('puts each key field under its vendor, at full width, with one line of description', async () => {
        const el = await mountStep();
        const input = field(el, 'DeepSeek')!;
        expect(input.style.width).toBe('');
        expect(input.className).toContain('flex-1');
        // The row is a column: text first, then the field.
        const row = input.closest('.display-flex.flex-col.gap-2') as HTMLElement;
        expect(row).not.toBeNull();
        expect(row.textContent).toContain('The recommended first pick');
        const summary = Array.from(row.querySelectorAll('span[title]')).find((s) => s.textContent?.includes('recommended'));
        expect(summary?.getAttribute('title')).toMatch(/peak hours/);
    });
});

describe('the feature tour', () => {
    it('says changes to the library are turned on under Settings → Permissions', async () => {
        const { default: FeatureTourStep } = await import('../../../react/components/pages/wizard/steps/FeatureTourStep');
        const html = renderToStaticMarkup(React.createElement(FeatureTourStep));
        expect(html).toContain('turn it on under Settings → Permissions');
    });
});

describe('the vendor notes', () => {
    it('describe the models the catalogue lists, at their prices, with DeepSeek\'s peak hours stated right', async () => {
        const { VENDORS } = await import('../../../react/components/preferences/vendors');
        const note = (id: string) => VENDORS.find((v) => v.id === id)?.note ?? '';
        expect(note('openrouter')).toContain('DeepSeek V4.1 Flash');
        expect(note('openrouter')).toContain('$0.15/M in');
        expect(note('openrouter')).not.toMatch(/V4-Flash|text only|\$0\.07/);
        expect(note('deepseek')).toContain('weekdays 01:00–04:00 and 06:00–10:00 UTC');
        expect(note('deepseek')).not.toContain('04:00–01:00');
        for (const vendor of VENDORS) expect(vendor.summary, vendor.id).toBeTruthy();
    });
});
