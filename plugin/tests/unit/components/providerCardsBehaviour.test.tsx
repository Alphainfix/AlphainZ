// @vitest-environment jsdom
 

/**
 * The provider cards keep what the user typed, test what will run, and leave
 * the model in use on something that works.
 *
 * - A key field left empty keeps the stored key; a new key is kept once a Test
 *   succeeds with it, and when the card closes any way but Cancel, unless its
 *   Test failed and another key is stored.
 * - Test asks the model in use (or the catalogue's first), and can be stopped.
 * - Removing the provider in use says what happens, here and, with settings
 *   sync on, on the other computers, and moves the choice.
 * - An address from older versions shows on the card it moved to, or, when it
 *   still waits for a provider, where it can be cleared.
 * - The Ollama card tells chat models from the one used for indexing, and can
 *   mark a model as reading figures.
 * - A hand-added endpoint renamed by a synced choice while its card is open is
 *   still saved and deleted as itself.
 * - A model's thinking tiers, context window and output cap are set in its
 *   row: on a built-in card apart from the catalogue, and only where they
 *   differ from the preset; on a hand-added one with the API it speaks.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const verify = vi.hoisted(() => ({
    chat: vi.fn(),
}));
vi.mock('../../../src/services/llm/verifyKey', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    verifyChatProvider: verify.chat,
}));
const probe = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../../src/services/llm/visionProbe', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    probeVision: probe.fn,
}));
const ollama = vi.hoisted(() => ({ status: { running: true, version: '0.12.0', models: [] as string[] } as any }));
vi.mock('../../../react/utils/ollama', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    ollamaStatus: vi.fn(async () => ollama.status),
}));

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let confirmTexts: string[] = [];

const setPrefs = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) prefs[`${PREFIX}.${key}`] = value;
};
const pref = (key: string) => prefs[`${PREFIX}.${key}`];

beforeEach(() => {
    prefs = {};
    confirmTexts = [];
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    (Zotero as any).Prompt = {
        BUTTON_TITLE_CANCEL: 1,
        confirm: vi.fn((options: { text: string }) => { confirmTexts.push(options.text); return 0; }),
    };
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    verify.chat.mockReset();
    probe.fn.mockReset();
    vi.resetModules();
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    delete (Zotero as any).Prompt;
});

async function mount(props: Record<string, unknown> = {}) {
    const { default: ProviderCards } = await import('../../../react/components/preferences/ProviderCards');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const render = async (next: Record<string, unknown>) => {
        await act(async () => { root!.render(React.createElement(ProviderCards, next as any)); });
        await act(async () => { await Promise.resolve(); });
    };
    await render(props);
    return { el: container, rerender: render };
}

const $ = (el: HTMLElement, selector: string) => el.querySelector(selector) as HTMLElement | null;
const click = async (target: HTMLElement | null) => {
    expect(target).not.toBeNull();
    await act(async () => { target!.click(); });
    await act(async () => { await Promise.resolve(); });
};
const type = async (input: HTMLElement | null, value: string) => {
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const choose = async (select: HTMLElement | null, value: string) => {
    expect(select).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(select, value);
        select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
};
const button = (el: HTMLElement, text: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe('the key on a built-in card', () => {
    it('is kept when Save is pressed with the field left empty', async () => {
        setPrefs({ llmKeyDeepseek: 'sk-stored' });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit DeepSeek"]'));
        const key = $(el, '[aria-label="DeepSeek API key"]') as HTMLInputElement;
        expect(key.placeholder).toMatch(/leave empty to keep it/);
        // Typed into by accident, then emptied again.
        await type(key, 'x');
        await type(key, '');
        await click($(el, '[aria-label="Save DeepSeek"]'));
        expect(pref('llmKeyDeepseek')).toBe('sk-stored');
        expect($(el, '[data-provider="deepseek"]')).not.toBeNull();
    });

    it('is saved as soon as a Test succeeds with it', async () => {
        verify.chat.mockResolvedValue({ ok: true, message: 'Connected in 300 ms.' });
        const { el } = await mount();
        await click($(el, '[aria-label="Add provider"]'));
        await click($(el, '[aria-label="Add DeepSeek"]'));
        await type($(el, '[aria-label="DeepSeek API key"]'), 'sk-new');
        await click(button(el, 'Test')!);
        expect(pref('llmKeyDeepseek')).toBe('sk-new');
        expect(el.textContent).toContain('The key is saved.');
    });

    it('does not replace a stored key with a new one whose Test failed when the card closes', async () => {
        setPrefs({ llmKeyDeepseek: 'sk-good', llmKeyOpenrouter: 'k-or' });
        verify.chat.mockResolvedValue({ ok: false, message: 'The model rejected the API key (401).' });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit DeepSeek"]'));
        await type($(el, '[aria-label="DeepSeek API key"]'), 'sk-typo');
        await click(button(el, 'Test')!);
        expect(el.textContent).toContain('rejected the API key');
        await click($(el, '[aria-label="Edit OpenRouter"]'));
        expect(pref('llmKeyDeepseek')).toBe('sk-good');
    });

    it('keeps a new key when the card closes if nothing was stored, or if the key was changed after its Test failed', async () => {
        setPrefs({ llmKeyOpenrouter: 'k-or', llmKeyOpenai: 'sk-old' });
        verify.chat.mockResolvedValue({ ok: false, message: 'Could not reach the provider.' });
        const { el } = await mount();
        await click($(el, '[aria-label="Add provider"]'));
        await click($(el, '[aria-label="Add DeepSeek"]'));
        await type($(el, '[aria-label="DeepSeek API key"]'), 'sk-first');
        await click(button(el, 'Test')!);
        await click($(el, '[aria-label="Edit OpenAI"]'));
        expect(pref('llmKeyDeepseek')).toBe('sk-first');

        await type($(el, '[aria-label="OpenAI API key"]'), 'sk-typo');
        await click(button(el, 'Test')!);
        await type($(el, '[aria-label="OpenAI API key"]'), 'sk-fixed');
        await click($(el, '[aria-label="Edit OpenRouter"]'));
        expect(pref('llmKeyOpenai')).toBe('sk-fixed');
    });

    it('is kept when the card closes some other way than Cancel, and dropped on Cancel', async () => {
        setPrefs({ llmKeyOpenrouter: 'k-or' });
        const { el } = await mount();
        await click($(el, '[aria-label="Add provider"]'));
        await click($(el, '[aria-label="Add DeepSeek"]'));
        await type($(el, '[aria-label="DeepSeek API key"]'), 'sk-pasted');
        // Edit on another card collapses this one.
        await click($(el, '[aria-label="Edit OpenRouter"]'));
        expect(pref('llmKeyDeepseek')).toBe('sk-pasted');

        await type($(el, '[aria-label="OpenRouter API key"]'), 'k-typo');
        await click($(el, '[aria-label="Cancel editing OpenRouter"]'));
        expect(pref('llmKeyOpenrouter')).toBe('k-or');
    });

    it('is kept when the Settings window closes with the card open', async () => {
        const { el } = await mount();
        await click($(el, '[aria-label="Add provider"]'));
        await click($(el, '[aria-label="Add OpenAI"]'));
        await type($(el, '[aria-label="OpenAI API key"]'), 'sk-openai');
        act(() => root!.unmount());
        root = null;
        expect(pref('llmKeyOpenai')).toBe('sk-openai');
    });
});

describe('Test on a built-in card', () => {
    it('asks the model in use, not the preset\'s default', async () => {
        verify.chat.mockResolvedValue({ ok: true, message: 'Connected in 300 ms.' });
        setPrefs({ llmKeyOpenai: 'k', llmProvider: 'openai', llmModel: 'gpt-4o-mini' });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit OpenAI"]'));
        await click(button(el, 'Test')!);
        expect(verify.chat).toHaveBeenCalledWith('openai', 'k', expect.anything(), expect.objectContaining({ model: 'gpt-4o-mini' }));
        expect(el.textContent).toContain('Connected in 300 ms with gpt-4o-mini.');
    });

    it('can be cancelled while it waits', async () => {
        let signal: AbortSignal | undefined;
        verify.chat.mockImplementation((_id: string, _key: string, _fetch: unknown, options: any) => {
            signal = options.signal;
            return new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ ok: false, message: 'Test cancelled.' })));
        });
        setPrefs({ llmKeyDeepseek: 'k' });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit DeepSeek"]'));
        await click(button(el, 'Test')!);
        await click($(el, '[aria-label="Cancel the DeepSeek test"]'));
        expect(signal?.aborted).toBe(true);
        expect(el.textContent).toContain('Test cancelled.');
        expect($(el, '[aria-invalid="true"]')).toBeNull();
    });
});

describe('Remove on the provider in use', () => {
    it('says the model switches, and switches it to a provider still configured', async () => {
        setPrefs({ llmKeyOpenrouter: 'k-or', llmKeyDeepseek: 'k-d', llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash' });
        const { el } = await mount();
        await click($(el, '[aria-label="Remove OpenRouter"]'));
        expect(confirmTexts[0]).toContain('It is the provider in use, so the sidebar switches to DeepSeek · deepseek-flash.');
        expect(confirmTexts[0]).not.toContain('other computers');
        expect(pref('llmKeyOpenrouter')).toBe('');
        expect(pref('llmProvider')).toBe('deepseek');
        expect(pref('llmModel')).toBe('deepseek-flash');
    });

    it('says the other computers switch too when settings sync is on', async () => {
        setPrefs({
            llmKeyOpenrouter: 'k-or', llmKeyDeepseek: 'k-d', llmProvider: 'openrouter', llmModel: 'z-ai/glm-5.3-flash',
            conversationSyncBackend: 'zotero',
        });
        const { el } = await mount();
        await click($(el, '[aria-label="Remove OpenRouter"]'));
        expect(confirmTexts[0]).toContain(
            'switches to DeepSeek · deepseek-flash. With settings sync on, your other computers switch to it too, '
            + 'so it has to be set up on each of them.',
        );
    });
});

describe('an address kept by an older version', () => {
    it('moves onto the card of the provider it was redirecting, where it can be seen and changed', async () => {
        setPrefs({ llmKeyDeepseek: 'k', llmProvider: 'deepseek', llmModel: 'deepseek-flash', llmBaseUrl: 'https://relay.example.com/v1' });
        const { el } = await mount();
        expect(pref('llmBaseUrl')).toBe('');
        expect(JSON.parse(String(pref('providerOverrides'))).deepseek.baseUrl).toBe('https://relay.example.com/v1');
        await click($(el, '[aria-label="Edit DeepSeek"]'));
        await click(button(el, 'Custom settings')!);
        expect(($(el, '[aria-label="DeepSeek API address"]') as HTMLInputElement).value).toBe('https://relay.example.com/v1');
    });

    it('is shown, and can be cleared, while it waits for a built-in provider', async () => {
        setPrefs({ llmBaseUrl: 'https://relay.example.com/v1' });
        const { el } = await mount();
        expect($(el, '[data-testid="legacy-base-url"]')?.textContent).toContain('https://relay.example.com/v1');
        await click($(el, '[aria-label="Clear the stored address"]'));
        expect(pref('llmBaseUrl')).toBe('');
        expect($(el, '[data-testid="legacy-base-url"]')).toBeNull();
    });
});

describe('the Ollama card', () => {
    it('is not listed for an Ollama whose only model is the embedding one', async () => {
        setPrefs({ ollamaModels: JSON.stringify(['bge-m3:latest']) });
        const { el } = await mount();
        expect($(el, '[data-provider="ollama"]')).toBeNull();
    });

    it('lists chat models apart from the model used for indexing, and marks one as reading figures', async () => {
        ollama.status = {
            running: true, version: '0.12.0', models: ['bge-m3:latest', 'llava:13b'],
            capabilities: { 'bge-m3:latest': ['embedding'], 'llava:13b': ['completion', 'vision'] },
        };
        setPrefs({ ollamaModels: JSON.stringify(['llava:13b']) });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit Ollama (local)"]'));
        await click(button(el, 'Detect models')!);
        const listed = $(el, '[data-testid="ollama-models"]')!;
        expect(listed.textContent).toContain('bge-m3:latest');
        expect(listed.textContent).toContain('used for indexing, not for chat');
        expect(listed.textContent).toContain('Ollama says it reads images');
        expect(el.textContent).toContain('Found 1 chat model: llava:13b · used for indexing: bge-m3:latest');

        await click($(el, '[aria-label="llava:13b reads figures"]'));
        const { localModelsFromPrefs } = await import('../../../react/atoms/models');
        expect(localModelsFromPrefs().find((m) => m.snapshot === 'llava:13b')?.supports_vision).toBe(true);
        const { modelReadsImages } = await import('../../../src/services/llm/agentConfig');
        expect(modelReadsImages('ollama', 'llava:13b')).toBe(true);
    });
});

describe('a request from elsewhere on the page', () => {
    it('opens the vendor\'s card for its key, even one not listed yet', async () => {
        const { el, rerender } = await mount({ openRequest: null });
        expect($(el, '[aria-label="OpenRouter API key"]')).toBeNull();
        await rerender({ openRequest: { vendorId: 'openrouter', nonce: 1 } });
        expect($(el, '[aria-label="OpenRouter API key"]')).not.toBeNull();
    });
});

describe('a hand-added endpoint renamed while its card is on screen', () => {
    const relay = {
        id: 'ep-local', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: 'k', authStyle: 'bearer',
        models: [{ id: 'm1', supportsVision: false, reasoningEffort: false }],
    };
    /** A model choice synced from the other computer names its own id for the same relay. */
    const syncLands = async () => {
        setPrefs({ llmProvider: 'custom:ep-remote', llmModel: 'm1' });
        const { adoptSyncedEndpointId } = await import('../../../src/services/llm/customEndpoints');
        expect(adoptSyncedEndpointId('custom:ep-remote', 'm1')).toBe(true);
    };

    it('is saved under the id it has now, without a second copy', async () => {
        setPrefs({ customEndpoints: JSON.stringify([relay]) });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit Relay"]'));
        await syncLands();
        await type($(el, '[aria-label="Provider name"]'), 'Lab relay');
        await click($(el, '[aria-label="Save provider"]'));
        const saved = JSON.parse(String(pref('customEndpoints')));
        expect(saved.map((e: any) => [e.id, e.name])).toEqual([['ep-remote', 'Lab relay']]);
    });

    it('is deleted under the id it has now, and the choice naming it is released', async () => {
        setPrefs({ customEndpoints: JSON.stringify([relay]), llmKeyOpenrouter: 'k-or' });
        const { el } = await mount();
        // Another card is open, so the list is not re-read when the rename lands.
        await click($(el, '[aria-label="Edit OpenRouter"]'));
        await syncLands();
        await click($(el, '[aria-label="Delete Relay"]'));
        expect(JSON.parse(String(pref('customEndpoints')))).toEqual([]);
        expect(pref('llmProvider')).not.toBe('custom:ep-remote');
        expect(confirmTexts[0]).toContain('It is the provider in use');
    });
});

describe('tuning a model in its row', () => {
    const openRow = async (el: HTMLElement, model: string) => {
        await click(button(el, 'Custom settings')!);
        await click($(el, `[aria-label="Show details for ${model}"]`));
    };
    const box = (el: HTMLElement, label: string) => $(el, `[aria-label="${label}"]`) as HTMLInputElement;

    it('keeps it apart from the catalogue, and only where it differs from the preset', async () => {
        setPrefs({ llmKeyDeepseek: 'k' });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit DeepSeek"]'));
        await openRow(el, 'deepseek-flash');
        expect(box(el, 'deepseek-flash takes Medium').checked).toBe(true);
        expect(box(el, 'deepseek-flash takes Max').checked).toBe(true);
        expect(box(el, 'deepseek-flash takes Minimal').checked).toBe(false);
        expect(box(el, 'Context window of deepseek-flash, in tokens').placeholder).toBe('1,048,576');
        await click(box(el, 'deepseek-flash takes Medium'));
        // The preset's own window, typed out, is no change.
        await type(box(el, 'Context window of deepseek-flash, in tokens'), '1,048,576');
        await type(box(el, 'Most output one answer from deepseek-flash may use, in tokens'), '12000');
        expect(el.textContent).not.toContain('the preset\'s list is replaced');
        await click($(el, '[aria-label="Save DeepSeek"]'));
        expect(JSON.parse(String(pref('providerOverrides'))).deepseek).toEqual({
            tuning: { 'deepseek-flash': { efforts: ['none', 'low', 'high', 'max'], maxOutputTokens: 12000 } },
        });
    });

    it('goes back to the preset\'s values in one click', async () => {
        setPrefs({
            llmKeyDeepseek: 'k',
            providerOverrides: JSON.stringify({ deepseek: { tuning: { 'deepseek-flash': { efforts: ['high'], contextWindow: 64000 } } } }),
        });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit DeepSeek"]'));
        await openRow(el, 'deepseek-flash');
        expect(box(el, 'deepseek-flash takes Medium').checked).toBe(false);
        expect(box(el, 'Context window of deepseek-flash, in tokens').value).toBe('64000');
        await click($(el, `[aria-label="Use the preset's values for deepseek-flash"]`));
        expect(box(el, 'deepseek-flash takes Medium').checked).toBe(true);
        expect(box(el, 'Context window of deepseek-flash, in tokens').value).toBe('');
        await click($(el, '[aria-label="Save DeepSeek"]'));
        expect(JSON.parse(String(pref('providerOverrides'))).deepseek).toBeUndefined();
    });

    it('keeps the tuning when the preset\'s models are restored', async () => {
        setPrefs({
            llmKeyDeepseek: 'k',
            providerOverrides: JSON.stringify({ deepseek: {
                models: [{ id: 'deepseek-flash' }, { id: 'deepseek-extra' }],
                tuning: { 'deepseek-flash': { efforts: ['high'] } },
            } }),
        });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit DeepSeek"]'));
        await click(button(el, 'Custom settings')!);
        expect(el.textContent).toContain('the preset\'s list is replaced');
        await click(button(el, 'Restore default models')!);
        await click($(el, '[aria-label="Save DeepSeek"]'));
        expect(JSON.parse(String(pref('providerOverrides'))).deepseek).toEqual({ tuning: { 'deepseek-flash': { efforts: ['high'] } } });
    });

    it('saves a hand-added endpoint\'s API with each model\'s tuning, and checks the model on that API', async () => {
        probe.fn.mockResolvedValue({ seesImages: true, checkedAt: 0, detail: '593' });
        setPrefs({ customEndpoints: JSON.stringify([{
            id: 'ep-g', name: 'Gateway', baseUrl: 'https://gw.example/v1', apiKey: 'k', authStyle: 'x-api-key',
            models: [{ id: 'm1', supportsVision: false, reasoningEffort: false }],
        }]) });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit Gateway"]'));
        await choose($(el, '[aria-label="API format"]'), 'openai-responses');
        await click($(el, '[aria-label="Show details for m1"]'));
        expect(el.textContent).toContain('None ticked: no thinking setting is sent');
        expect($(el, `[aria-label="Use the preset's values for m1"]`)).toBeNull();
        await click(box(el, 'm1 takes Low'));
        await click(box(el, 'm1 takes Max'));
        await type(box(el, 'Context window of m1, in tokens'), '272000');
        await type(box(el, 'Most output one answer from m1 may use, in tokens'), '32000');
        await click($(el, '[aria-label="Check whether m1 reads figures"]'));
        expect(probe.fn).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'm1', wireFormat: 'openai-responses', leastEffort: 'low', authStyle: 'x-api-key' }),
            expect.anything(),
        );
        await click($(el, '[aria-label="Save provider"]'));
        const [saved] = JSON.parse(String(pref('customEndpoints')));
        expect(saved.wireFormat).toBe('openai-responses');
        expect(saved.models[0]).toMatchObject({
            id: 'm1', supportsVision: true, reasoningEffort: true, efforts: ['low', 'max'], contextWindow: 272000, maxTokens: 32000,
        });
    });

    it('checks a hand-added model that takes no tier without a thinking setting', async () => {
        probe.fn.mockResolvedValue({ seesImages: false, checkedAt: 0, detail: 'NO IMAGE' });
        setPrefs({ customEndpoints: JSON.stringify([{
            id: 'ep-g', name: 'Gateway', baseUrl: 'https://gw.example/v1', apiKey: 'k', authStyle: 'bearer',
            models: [{ id: 'm1', supportsVision: false, reasoningEffort: false }],
        }]) });
        const { el } = await mount();
        await click($(el, '[aria-label="Edit Gateway"]'));
        await click($(el, '[aria-label="Show details for m1"]'));
        await click($(el, '[aria-label="Check whether m1 reads figures"]'));
        expect(probe.fn).toHaveBeenCalledWith(expect.objectContaining({ wireFormat: 'openai', leastEffort: null }), expect.anything());
    });
});
