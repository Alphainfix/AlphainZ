// @vitest-environment jsdom

/**
 * A model download started from the Ollama guide is not the guide's to end.
 *
 * Closing the guide — Next in the wizard, Done on the Ollama card, another
 * Settings tab — used to abort the request, which ends Ollama's pull. Now it
 * keeps going, any guide shows it, only Cancel stops it, and once it finishes
 * the new chat model reaches the model picker even with no guide open.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({
    value: { running: true, version: '0.12.0', models: [] as string[] } as any,
}));
vi.mock('../../../react/utils/ollama', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    ollamaStatus: vi.fn(async () => status.value),
}));

import { OllamaGuide } from '../../../react/components/preferences/OllamaGuide';
import { ollamaPullState, resetOllamaPulls } from '../../../react/utils/ollama';

const containers: Array<{ root: Root; el: HTMLDivElement }> = [];

async function mount(props: React.ComponentProps<typeof OllamaGuide>) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    containers.push({ root, el });
    await act(async () => { root.render(React.createElement(OllamaGuide, props)); });
    await act(async () => { await Promise.resolve(); });
    return { el, unmount: () => act(() => root.unmount()) };
}

/**
 * A /api/pull response whose stream the test feeds by hand. Like a real
 * fetch body, a pending read fails once the request's signal aborts.
 */
function pullResponse() {
    const encoder = new TextEncoder();
    type Read = { value?: Uint8Array; done: boolean };
    const waiting: Array<{ resolve: (r: Read) => void; reject: (e: Error) => void }> = [];
    const ready: Read[] = [];
    const push = (r: Read) => { const w = waiting.shift(); if (w) w.resolve(r); else ready.push(r); };
    return {
        attach(signal: AbortSignal) {
            signal.addEventListener('abort', () => {
                for (const w of waiting.splice(0)) w.reject(new Error('The operation was aborted.'));
            });
        },
        response: {
            ok: true,
            body: {
                getReader: () => ({
                    read: () => new Promise<Read>((resolve, reject) => {
                        const r = ready.shift();
                        if (r) resolve(r); else waiting.push({ resolve, reject });
                    }),
                }),
            },
        },
        send: (line: string) => push({ value: encoder.encode(`${line}\n`), done: false }),
        end: () => push({ done: true }),
    };
}

const button = (el: HTMLElement, text: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined;

let pullSignal: AbortSignal | undefined;
let pull: ReturnType<typeof pullResponse>;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    status.value = { running: true, version: '0.40.9', models: [] };
    pull = pullResponse();
    pullSignal = undefined;
    (globalThis as any).fetch = vi.fn(async (_url: string, init: any) => {
        pullSignal = init?.signal;
        if (init?.signal) pull.attach(init.signal);
        return pull.response;
    });
    (Zotero.Prefs.set as any).mockClear();
});
afterEach(() => {
    for (const { root, el } of containers.splice(0)) {
        act(() => root.unmount());
        el.remove();
    }
    resetOllamaPulls();
});

describe('a download started from the guide', () => {
    it('survives the guide closing, and reaches the model picker when it finishes', async () => {
        const first = await mount({ showChat: true });
        await act(async () => { button(first.el, 'Get it')!.click(); });
        await act(async () => { pull.send('{"status":"pulling 8a1b","total":4700000000,"completed":500000000}'); });
        expect(first.el.textContent).toContain('500 MB of 4.70 GB');

        // Next in the wizard: the step and its guide go away.
        first.unmount();
        expect(pullSignal?.aborted).toBe(false);

        // Another guide for the same server shows the same download.
        const second = await mount({ showChat: true, showEmbedding: true });
        expect(second.el.textContent).toContain('500 MB of 4.70 GB');
        expect(button(second.el, 'Cancel')).toBeDefined();
        second.unmount();

        // It finishes with no guide open; the new model is recorded anyway.
        status.value = { running: true, version: '0.40.9', models: ['qwen2.5:7b', 'bge-m3:latest'] };
        await act(async () => {
            pull.send('{"status":"success"}');
            pull.end();
            for (let i = 0; i < 20; i++) await Promise.resolve();
        });
        expect(ollamaPullState('http://127.0.0.1:11434', 'qwen2.5:7b')?.status).toBe('done');
        const written = (Zotero.Prefs.set as any).mock.calls.filter(([key]: [string]) => key.endsWith('.ollamaModels'));
        expect(written.at(-1)?.[1]).toBe(JSON.stringify(['qwen2.5:7b']));
    });

    it('stops on Cancel and offers to resume', async () => {
        const guide = await mount({ showEmbedding: true });
        await act(async () => { button(guide.el, 'Get it')!.click(); });
        await act(async () => { pull.send('{"status":"pulling 8a1b","total":1000,"completed":10}'); });
        await act(async () => {
            button(guide.el, 'Cancel')!.click();
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });
        expect(pullSignal?.aborted).toBe(true);
        expect(button(guide.el, 'Resume download')).toBeDefined();
        expect(guide.el.textContent).toContain('What was already downloaded is kept');
    });
});
