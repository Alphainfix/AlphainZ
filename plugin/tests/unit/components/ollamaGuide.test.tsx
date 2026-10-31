// @vitest-environment jsdom

/**
 * The Ollama guide: what it says when Ollama is missing, and which models it
 * offers to download once it is running.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ value: { running: false, version: null as string | null, models: [] as string[], error: 'ECONNREFUSED' } }));
vi.mock('../../../react/utils/ollama', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    ollamaStatus: vi.fn(async () => status.value),
    pullOllamaModel: vi.fn(),
}));

import { OllamaGuide } from '../../../react/components/preferences/OllamaGuide';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(props: React.ComponentProps<typeof OllamaGuide>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(OllamaGuide, props));
    });
    await act(async () => { await Promise.resolve(); });
    return container;
}

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('OllamaGuide', () => {
    it('says Ollama is not running and offers the download page', async () => {
        status.value = { running: false, version: null, models: [], error: 'ECONNREFUSED' };
        const el = await mount({ showEmbedding: true });
        expect(el.textContent).toContain('Ollama is not running');
        expect(el.textContent).toContain('Install Ollama');
        expect(el.textContent).toContain('No account is needed');
        // The download button is there but disabled until Ollama answers.
        const get = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Get it') as HTMLButtonElement;
        expect(get?.disabled).toBe(true);
        expect(get?.title).toBe('Start Ollama first');
    });

    it('marks an installed model and offers the missing one', async () => {
        status.value = { running: true, version: '0.40.9', models: ['embeddinggemma-2:440m-q8_0-text-vision'], error: undefined as any };
        const el = await mount({ showEmbedding: true, showChat: true });
        expect(el.textContent).toContain('Ollama 0.40.9 is running · 1 model installed');
        expect(el.textContent).toContain('Installed ✓');
        const getButtons = Array.from(el.querySelectorAll('button')).filter((b) => b.textContent === 'Get it');
        expect(getButtons.map((b) => b.title)).toEqual(['Download qwen2.5:7b through Ollama']);
        // The terminal alternative is shown only for what is not installed.
        expect(el.textContent).toContain('ollama pull qwen2.5:7b');
        expect(el.textContent).not.toContain('ollama pull embeddinggemma-2:440m-q8_0-text-vision');
        // Chat models get the context-length note.
        expect(el.textContent).toContain('OLLAMA_CONTEXT_LENGTH');
    });

    it('asks for a newer Ollama before offering a model that needs one', async () => {
        status.value = { running: true, version: '0.33.3', models: [], error: undefined as any };
        const el = await mount({ showEmbedding: true });
        expect(el.textContent).toContain('This model needs Ollama 0.40.0 or later; this one is 0.33.3.');
        const get = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Get it') as HTMLButtonElement;
        expect(get.disabled).toBe(true);
        expect(get.title).toBe('Needs Ollama 0.40.0 or later');
        expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent)).toContain('Update Ollama');
    });

    it('remembers the installed chat models for the composer, and never the embedding model', async () => {
        // bge-m3 only embeds: listed as a chat model it was picked as one.
        status.value = { running: true, version: '0.33.3', models: ['bge-m3:latest', 'qwen2.5:7b'], error: undefined as any };
        (Zotero.Prefs.set as any).mockClear();
        const changed = vi.fn();
        await mount({ showEmbedding: true, onModelsChanged: changed });
        expect(changed).toHaveBeenCalledWith(['bge-m3:latest', 'qwen2.5:7b']);
        const written = (Zotero.Prefs.set as any).mock.calls.filter(([key]: [string]) => key.endsWith('.ollamaModels'));
        expect(written.at(-1)?.[1]).toBe(JSON.stringify(['qwen2.5:7b']));
    });
});
