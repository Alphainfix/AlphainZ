import { describe, expect, it } from 'vitest';

import { EmbeddingProvider, embeddingProviderFromPreset, type FetchLike } from '@beaver/agent-llm/embeddings';
import {
    figureCoverageNote,
    runPageImageIndex,
    searchPageImages,
    type PageImageStore,
    type RenderedPage,
} from '../../../src/services/llm/pageImageIndex';
import { ModelRequestError } from '@beaver/agent-llm/sse';

/** A Gemini endpoint that answers each image with a vector pointing one way per page. */
function geminiImages(fail?: { status: number; body: unknown }): FetchLike & { calls: any[] } {
    const calls: any[] = [];
    const fn = (async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        if (fail) return { ok: false, status: fail.status, text: async () => JSON.stringify(fail.body) };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                embeddings: body.requests.map((r: any) => {
                    const data = r.content.parts[0].inline_data?.data ?? '';
                    return { values: [data.length, 1, 0, 0] };
                }),
            }),
        };
    }) as FetchLike & { calls: any[] };
    fn.calls = calls;
    return fn;
}

const provider = (fetchImpl: FetchLike) => new EmbeddingProvider({
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'k',
    model: 'gemini-embedding-2',
    dimensions: 4,
    wire: 'gemini',
    imageWire: 'gemini',
    imageBatchSize: 2,
    queryPrefix: 'task: search result | query: ',
}, fetchImpl);

function memoryStore(): PageImageStore & { rows: Map<string, any[]> } {
    const rows = new Map<string, any[]>();
    return {
        rows,
        async getPageImagedAttachmentKeys(modelId) {
            return new Set([...rows.keys()].filter((k) => k.endsWith(`@${modelId}`)).map((k) => k.split('@')[0]));
        },
        async replacePageImages(libraryId, attachmentKey, parentKey, modelId, dimensions, pages) {
            rows.set(`${libraryId}-${attachmentKey}@${modelId}`, pages.map((p) => ({ ...p, parentKey, dimensions })));
        },
        async getPageImagesForSearch(modelId) {
            const out: any[] = [];
            for (const [key, pages] of rows) {
                if (!key.endsWith(`@${modelId}`)) continue;
                const [lib, att] = key.split('@')[0].split('-');
                for (const p of pages) {
                    out.push({
                        libraryId: Number(lib), attachmentKey: att, parentKey: p.parentKey, pageIndex: p.pageIndex,
                        pageLabel: p.pageLabel ?? null, embedding: new Int8Array(p.embedding.buffer),
                    });
                }
            }
            return out;
        },
    };
}

const pagesOf = (n: number): RenderedPage[] =>
    Array.from({ length: n }, (_, i) => ({ pageIndex: i, mimeType: 'image/jpeg', base64: 'x'.repeat(i + 1) }));

const renderer = (count: Record<string, number>, failOn?: string) =>
    async (candidate: { attachmentKey: string }, onPages: (p: RenderedPage[]) => Promise<void>) => {
        if (candidate.attachmentKey === failOn) throw new Error('no readable pages');
        const pages = pagesOf(count[candidate.attachmentKey] ?? 3);
        for (let i = 0; i < pages.length; i += 2) await onPages(pages.slice(i, i + 2));
        return pages.length;
    };

const candidates = ['AAA', 'BBB', 'CCC'].map((k) => ({ libraryId: 1, attachmentKey: k, parentKey: `P${k}` }));

describe('the page-image index', () => {
    it('sends pictures as inline data, a batch per request, and stores one vector per page', async () => {
        const fetchImpl = geminiImages();
        const store = memoryStore();
        const result = await runPageImageIndex({
            store, provider: provider(fetchImpl), modelId: 'gemini-embedding-2',
            candidates: candidates.slice(0, 1), render: renderer({ AAA: 3 }),
        });
        expect(result).toMatchObject({ indexed: 1, failed: 0, pages: 3 });
        expect(fetchImpl.calls[0].body.requests[0].content.parts[0]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'x' } });
        expect(store.rows.get('1-AAA@gemini-embedding-2')?.map((r) => r.pageIndex)).toEqual([0, 1, 2]);
    });

    it('does not render a document again once it has pages', async () => {
        const store = memoryStore();
        const render = renderer({});
        await runPageImageIndex({ store, provider: provider(geminiImages()), modelId: 'm', candidates, render });
        const again = await runPageImageIndex({ store, provider: provider(geminiImages()), modelId: 'm', candidates, render });
        expect(again).toMatchObject({ indexed: 0, pages: 0 });
    });

    it('fails a document that cannot be rendered and goes on with the rest', async () => {
        const store = memoryStore();
        const result = await runPageImageIndex({
            store, provider: provider(geminiImages()), modelId: 'm', candidates, render: renderer({}, 'BBB'),
        });
        expect(result).toMatchObject({ indexed: 2, failed: 1 });
        expect(result.errors[0]).toMatchObject({ attachmentKey: 'BBB' });
    });

    it('pauses on the provider, blaming no document and storing nothing half-done', async () => {
        const store = memoryStore();
        const result = await runPageImageIndex({
            store,
            provider: provider(geminiImages({ status: 401, body: { error: { message: 'bad key' } } })),
            modelId: 'm', candidates, render: renderer({}),
        });
        expect(result.failed).toBe(0);
        expect(result.paused?.message).toMatch(/^Figure indexing paused: .*rejected the API key/);
        expect(store.rows.size).toBe(0);
    });

    it('stops when asked, leaving the document in flight pending', async () => {
        const store = memoryStore();
        const controller = new AbortController();
        const render = async (_c: unknown, onPages: (p: RenderedPage[]) => Promise<void>) => {
            await onPages(pagesOf(2));
            controller.abort();
            throw new ModelRequestError('cancelled', { kind: 'cancelled' });
        };
        const result = await runPageImageIndex({
            store, provider: provider(geminiImages()), modelId: 'm', candidates, render, signal: controller.signal,
        });
        expect(result.canceled).toBe(true);
        expect(store.rows.size).toBe(0);
    });

    it('waits before each document when asked to, and goes on once it may', async () => {
        const events: string[] = [];
        const render = async (candidate: { attachmentKey: string }, onPages: (p: RenderedPage[]) => Promise<void>) => {
            events.push(`render ${candidate.attachmentKey}`);
            await onPages(pagesOf(1));
        };
        const result = await runPageImageIndex({
            store: memoryStore(), provider: provider(geminiImages()), modelId: 'm', candidates, render,
            beforeDocument: async () => {
                events.push('wait');
                await new Promise((resolve) => setTimeout(resolve, 5));
                events.push('waited');
            },
        });
        expect(result).toMatchObject({ indexed: 3, failed: 0 });
        // Each document starts only once the wait before it is over.
        expect(events).toEqual([
            'wait', 'waited', 'render AAA',
            'wait', 'waited', 'render BBB',
            'wait', 'waited', 'render CCC',
        ]);
    });

    it('stops while waiting when told to, without starting the next document', async () => {
        const store = memoryStore();
        const controller = new AbortController();
        const rendered: string[] = [];
        const render = async (candidate: { attachmentKey: string }, onPages: (p: RenderedPage[]) => Promise<void>) => {
            rendered.push(candidate.attachmentKey);
            await onPages(pagesOf(1));
        };
        let waits = 0;
        const result = await runPageImageIndex({
            store, provider: provider(geminiImages()), modelId: 'm', candidates, render, signal: controller.signal,
            beforeDocument: async () => {
                waits += 1;
                if (waits === 2) controller.abort();
            },
        });
        expect(result).toMatchObject({ indexed: 1, canceled: true });
        expect(rendered).toEqual(['AAA']);
    });

    it('stores nothing of a document when stopped between its windows', async () => {
        const store = memoryStore();
        const controller = new AbortController();
        // Renders one window, is told to stop, and returns without throwing.
        const render = async (_c: unknown, onPages: (p: RenderedPage[]) => Promise<void>) => {
            await onPages(pagesOf(2));
            controller.abort();
            return 4;
        };
        const result = await runPageImageIndex({
            store, provider: provider(geminiImages()), modelId: 'm', candidates, render, signal: controller.signal,
        });
        expect(result).toMatchObject({ indexed: 0, canceled: true });
        expect(store.rows.size).toBe(0);
    });

    it('fails a PDF that yields no pages rather than leave it pending for every run', async () => {
        const store = memoryStore();
        const render = async (candidate: { attachmentKey: string }, onPages: (p: RenderedPage[]) => Promise<void>) => {
            if (candidate.attachmentKey !== 'BBB') await onPages(pagesOf(2));
            return candidate.attachmentKey === 'BBB' ? 0 : 2;
        };
        const result = await runPageImageIndex({
            store, provider: provider(geminiImages()), modelId: 'm', candidates, render,
        });
        expect(result).toMatchObject({ indexed: 2, failed: 1 });
        expect(result.errors).toEqual([{ attachmentKey: 'BBB', message: 'the PDF has no pages to index' }]);
    });

    it('passes over a document it may no longer index', async () => {
        const store = memoryStore();
        const rendered: string[] = [];
        const render = async (candidate: { attachmentKey: string }, onPages: (p: RenderedPage[]) => Promise<void>) => {
            rendered.push(candidate.attachmentKey);
            await onPages(pagesOf(1));
        };
        const result = await runPageImageIndex({
            store, provider: provider(geminiImages()), modelId: 'm', candidates, render,
            admit: (candidate) => candidate.attachmentKey !== 'BBB',
        });
        expect(rendered).toEqual(['AAA', 'CCC']);
        expect(result).toMatchObject({ indexed: 2, failed: 0 });
    });

    it('drops a document whose library is excluded halfway through it, storing and counting nothing of it', async () => {
        const store = memoryStore();
        const fetchImpl = geminiImages();
        let batchesOfB = 0;
        const result = await runPageImageIndex({
            store, provider: provider(fetchImpl), modelId: 'm', candidates, render: renderer({ BBB: 6 }),
            // Library of BBB excluded after its first batch.
            admit: (candidate) => candidate.attachmentKey !== 'BBB' || (batchesOfB += 1) <= 2,
        });
        expect([...store.rows.keys()].sort()).toEqual(['1-AAA@m', '1-CCC@m']);
        expect(result).toMatchObject({ indexed: 2, failed: 0 });
        // AAA and CCC took two requests each (3 pages, 2 a batch); BBB got one batch out before it was dropped.
        expect(fetchImpl.calls.length).toBe(5);
    });

    /** Answers texts always, and pictures except those of the PDF whose pages carry `marker`. */
    const chokesOnPictures = (marker: string, status = 500): FetchLike => (async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        const datas = body.requests.map((r: any) => r.content.parts[0].inline_data?.data ?? '');
        if (datas.some((d: string) => d.includes(marker))) {
            return { ok: false, status, text: async () => JSON.stringify({ error: { message: 'internal error' } }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ embeddings: body.requests.map(() => ({ values: [1, 0, 0, 0] })) }) };
    }) as FetchLike;
    const markedRenderer = (marked: string) =>
        async (candidate: { attachmentKey: string }, onPages: (p: RenderedPage[]) => Promise<void>) => {
            const data = candidate.attachmentKey === marked ? 'POISON' : 'fine';
            await onPages([{ pageIndex: 0, mimeType: 'image/jpeg', base64: data }]);
        };

    it('fails only a PDF the provider errors on when the provider answers a short request of its own', async () => {
        const store = memoryStore();
        const result = await runPageImageIndex({
            store, provider: provider(chokesOnPictures('POISON')), modelId: 'm', candidates, render: markedRenderer('BBB'),
        });
        expect(result.paused).toBeUndefined();
        expect(result).toMatchObject({ indexed: 2, failed: 1 });
        expect(result.errors[0]).toMatchObject({ attachmentKey: 'BBB' });
        expect([...store.rows.keys()].sort()).toEqual(['1-AAA@m', '1-CCC@m']);
    });

    it('pauses when the provider fails its own short request too', async () => {
        const store = memoryStore();
        const result = await runPageImageIndex({
            store, provider: provider(geminiImages({ status: 503, body: { error: { message: 'overloaded' } } })),
            modelId: 'm', candidates, render: renderer({}),
        });
        expect(result.failed).toBe(0);
        expect(result.paused).toMatchObject({ attachmentKey: 'AAA' });
        expect(store.rows.size).toBe(0);
    });

    it('goes on when waiting fails', async () => {
        const result = await runPageImageIndex({
            store: memoryStore(), provider: provider(geminiImages()), modelId: 'm', candidates, render: renderer({}),
            beforeDocument: async () => { throw new Error('no store'); },
        });
        expect(result).toMatchObject({ indexed: 3, failed: 0, canceled: false });
    });
});

describe('saying how much a figure search covered', () => {
    it('says nothing once every PDF has its pages', () => {
        expect(figureCoverageNote(224, 224, 0)).toBeNull();
        expect(figureCoverageNote(0, 0, 0)).toBeNull();
    });

    it('says how many PDFs were searched, how many are still to come and how many could not be read', () => {
        const note = figureCoverageNote(120, 224, 93)!;
        expect(note).toMatch(/^Only 120 of 224 PDFs in this library have page images, so this searched part of the library/);
        expect(note).toMatch(/93 more have no page images yet\./);
        expect(note).toMatch(/11 could not be read on this computer/);
    });

    it('still speaks when the only PDFs without pages are ones that could not be read', () => {
        const note = figureCoverageNote(5, 224, 0)!;
        expect(note).toMatch(/^Only 5 of 224 PDFs/);
        expect(note).toMatch(/219 could not be read on this computer/);
        expect(note).not.toMatch(/no page images yet/);
    });
});

describe('searching page images', () => {
    it('ranks pages by the query, at most two from one PDF', async () => {
        const store = memoryStore();
        const vec = (a: number, b: number) => new Uint8Array(new Int8Array([a, b, 0, 0]).buffer);
        await store.replacePageImages(1, 'AAA', 'PA', 'm', 4, [0, 1, 2].map((i) => ({ pageIndex: i, embedding: vec(127, 10 * i) })));
        await store.replacePageImages(1, 'BBB', 'PB', 'm', 4, [{ pageIndex: 4, embedding: vec(0, 127) }]);
        const query = (async () => ({
            ok: true, status: 200, text: async () => JSON.stringify({ embeddings: [{ values: [1, 0, 0, 0] }] }),
        })) as FetchLike;
        const hits = await searchPageImages({ store, provider: provider(query), modelId: 'm', query: 'a rose diagram', limit: 5 });
        expect(hits.map((h) => `${h.attachmentKey}:${h.page}`)).toEqual(['AAA:1', 'AAA:2', 'BBB:5']);
    });
});

describe('searching only the PDFs in the library now', () => {
    it('passes over pages of a document not in the list', async () => {
        const store = memoryStore();
        await runPageImageIndex({ store, provider: provider(geminiImages()), modelId: 'm', candidates, render: renderer({}) });
        const hits = await searchPageImages({
            store, provider: provider(geminiImages()), modelId: 'm', query: 'q', limit: 10,
            attachments: new Set(['1-AAA']),
        });
        expect(new Set(hits.map((h) => h.attachmentKey))).toEqual(new Set(['AAA']));
    });
});

describe('a PDF attached twice', () => {
    it('lists its pages once', async () => {
        const store = memoryStore();
        const vec = (a: number, b: number) => new Uint8Array(new Int8Array([a, b, 0, 0]).buffer);
        await store.replacePageImages(1, 'AAA', 'PA', 'm', 4, [{ pageIndex: 2, embedding: vec(127, 20) }]);
        await store.replacePageImages(1, 'DUP', 'PD', 'm', 4, [{ pageIndex: 2, embedding: vec(127, 20) }]);
        await store.replacePageImages(1, 'BBB', 'PB', 'm', 4, [{ pageIndex: 0, embedding: vec(127, 60) }]);
        const query = (async () => ({
            ok: true, status: 200, text: async () => JSON.stringify({ embeddings: [{ values: [1, 0, 0, 0] }] }),
        })) as FetchLike;
        const hits = await searchPageImages({ store, provider: provider(query), modelId: 'm', query: 'q', limit: 5 });
        expect(hits.map((h) => h.attachmentKey)).toEqual(['AAA', 'BBB']);
    });
});

describe('which presets take pictures', () => {
    it('is Google and EmbeddingGemma 2, not OpenAI', () => {
        const none = (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchLike;
        expect(embeddingProviderFromPreset('google', 'k', none).embedsImages).toBe(true);
        expect(embeddingProviderFromPreset('ollama', '', none).embedsImages).toBe(true);
        expect(embeddingProviderFromPreset('openai', 'k', none).embedsImages).toBe(false);
    });

    it('sends EmbeddingGemma 2 its pictures on Ollama’s own route and cuts the vector to size', async () => {
        const calls: any[] = [];
        const fetchImpl = (async (url: string, init: any) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200, text: async () => JSON.stringify({ embeddings: [Array.from({ length: 900 }, () => 0.1)] }) };
        }) as FetchLike;
        const out = await embeddingProviderFromPreset('ollama', '', fetchImpl, { baseUrl: 'http://127.0.0.1:11434' })
            .generateImageEmbeddings([{ item_id: 0, mimeType: 'image/jpeg', base64: 'abc' }]);
        expect(calls[0].url).toBe('http://127.0.0.1:11434/api/embed');
        expect(calls[0].body).toEqual({ model: 'embeddinggemma-2:440m-q8_0-text-vision', input: [{ image: 'abc' }] });
        expect(out.embeddings[0].dimensions).toBe(768);
    });
});
