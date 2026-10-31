// @vitest-environment jsdom
 

/**
 * Settings → Model says what is really wrong with the embedding provider.
 *
 * A provider that is chosen but unusable — no key on this computer, Ollama not
 * answering — used to read as "none configured", with "No PDFs found" and an
 * "Everything is indexed" button that answered "No embedding provider is
 * configured". Now the panel names the problem and offers the way past it.
 * Also here: the Tests of this page ask the right place and read the right
 * facts.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const verify = vi.hoisted(() => ({ embedding: vi.fn() }));
vi.mock('../../../src/services/llm/verifyKey', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    verifyEmbeddingProvider: verify.embedding,
}));
const openalex = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../../../src/services/literature/openalex', async (importOriginal) => {
    const real = await importOriginal<any>();
    return {
        ...real,
        OpenAlexClient: class { search = openalex.search; },
    };
});
vi.mock('../../../react/utils/ollama', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    ollamaStatus: vi.fn(async () => ({ running: false, version: null, models: [], error: 'ECONNREFUSED' })),
}));

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const setPrefs = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) prefs[`${PREFIX}.${key}`] = value;
};

beforeEach(() => {
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    verify.embedding.mockReset();
    openalex.search.mockReset();
    // The Ollama probe must not reach the network from a test.
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
    vi.resetModules();
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function staticHtml(): Promise<string> {
    const { default: ModelSettingsSection } = await import('../../../react/components/preferences/ModelSettingsSection');
    return renderToStaticMarkup(React.createElement(ModelSettingsSection));
}

async function mount(): Promise<HTMLDivElement> {
    const { default: ModelSettingsSection } = await import('../../../react/components/preferences/ModelSettingsSection');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(React.createElement(ModelSettingsSection)); });
    await act(async () => { await Promise.resolve(); });
    return container;
}

const button = (el: HTMLElement, text: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe('an embedding provider chosen without its key on this computer', () => {
    it('is named as such, with the way to add the key, and no claim about the PDFs', async () => {
        setPrefs({ embeddingProvider: 'openai', llmKeyDeepseek: 'k' });
        const html = await staticHtml();
        expect(html).toContain('Embeddings are set to OpenAI, but this computer has no OpenAI API key.');
        expect(html).toContain('Add the OpenAI key');
        expect(html).toContain('OpenAI — no key on this computer yet');
        expect(html).not.toContain('No PDFs found');
        expect(html).not.toContain('Everything is indexed');
        expect(html).not.toContain('Enter a key first');
        expect(html).not.toContain('configured');
    });

    it('opens the OpenAI card for its key when asked', async () => {
        setPrefs({ embeddingProvider: 'openai', llmKeyDeepseek: 'k' });
        const el = await mount();
        expect(el.querySelector('[aria-label="OpenAI API key"]')).toBeNull();
        await act(async () => { button(el, 'Add the OpenAI key')!.click(); });
        await act(async () => { await Promise.resolve(); });
        expect(el.querySelector('[aria-label="OpenAI API key"]')).not.toBeNull();
    });
});

describe('a usable embedding provider', () => {
    it('says it is counting, not that there are no PDFs, before the count is in', async () => {
        setPrefs({ embeddingProvider: 'openai', llmKeyOpenai: 'k' });
        const html = await staticHtml();
        expect(html).toContain('Counting the PDFs in your libraries');
        expect(html).not.toContain('No PDFs found');
        expect(html).not.toContain('data-testid="embedding-problem"');
    });
});

describe('the Tests on this page', () => {
    it('tests Ollama embeddings at the address on the Ollama card', async () => {
        verify.embedding.mockResolvedValue({ ok: true, message: 'Connected in 20 ms · 1024 dimensions.' });
        setPrefs({ embeddingProvider: 'ollama', ollamaBaseUrl: 'http://gpu-box:11434' });
        const el = await mount();
        const section = el.querySelector('#alphain-embedding-provider')!.parentElement as HTMLElement;
        await act(async () => { button(section, 'Test')!.click(); });
        expect(verify.embedding).toHaveBeenCalledWith('ollama', '', expect.anything(), { baseUrl: 'http://gpu-box:11434/v1' });
    });

    it('reads a rejected OpenAlex key from the status, not from digits in the text', async () => {
        const { OpenAlexRequestError } = await import('../../../src/services/literature/openalex');
        setPrefs({ openalexApiKey: 'oa-key' });
        const el = await mount();
        const test = el.querySelector('#alphain-key-openalex')!.parentElement!.querySelector('button') as HTMLButtonElement;

        openalex.search.mockRejectedValueOnce(new OpenAlexRequestError('OpenAlex request failed: 403 Forbidden', 'http', 403));
        await act(async () => { test.click(); });
        expect(el.textContent).toContain('The key was rejected.');

        // A 500 whose body happens to contain "401" is not a rejected key.
        openalex.search.mockRejectedValueOnce(new OpenAlexRequestError('OpenAlex request failed: 500 — request 4012 failed', 'http', 500));
        await act(async () => { test.click(); });
        expect(el.textContent).not.toContain('The key was rejected.');
        expect(el.textContent).toContain('request 4012 failed');
    });
});
