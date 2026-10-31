/**
 * Which installed Ollama models can chat, and downloads that belong to no
 * screen.
 *
 * - An embedding-only model (bge-m3 and its kind) is never a chat model: by
 *   what Ollama's /api/show says when it says, by name otherwise.
 * - A download keeps going with nothing subscribed to it, stops only when
 *   cancelled, and a stream that ends without Ollama's "success" is an
 *   interruption, not a finished download.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    PULL_INTERRUPTED_MESSAGE,
    cancelOllamaPull,
    isOllamaEmbeddingModel,
    ollamaChatModels,
    ollamaPullState,
    ollamaStatus,
    pullOllamaModel,
    resetOllamaPulls,
    startOllamaPull,
    subscribeOllamaPulls,
} from '../../../react/utils/ollama';

afterEach(() => resetOllamaPulls());

describe('isOllamaEmbeddingModel', () => {
    it('knows the embedding model this plugin offers, and the common embedding families, by name', () => {
        for (const tag of ['bge-m3', 'bge-m3:latest', 'bge-m3:567m', 'nomic-embed-text:v1.5', 'mxbai-embed-large',
            'snowflake-arctic-embed2:568m', 'granite-embedding:278m', 'all-minilm:l6-v2', 'hf.co/org/bge-large-en:Q8_0']) {
            expect(isOllamaEmbeddingModel(tag)).toBe(true);
        }
        for (const tag of ['qwen2.5:7b', 'llama3.1:8b', 'llava:13b', 'gemma3:12b', 'deepseek-r1:14b']) {
            expect(isOllamaEmbeddingModel(tag)).toBe(false);
        }
    });

    it('goes by what Ollama reports when it reports something', () => {
        expect(isOllamaEmbeddingModel('house-vectors:latest', ['embedding'])).toBe(true);
        expect(isOllamaEmbeddingModel('bge-m3-chat:latest', ['completion', 'tools'])).toBe(false);
        expect(isOllamaEmbeddingModel('qwen2.5vl:7b', ['completion', 'vision'])).toBe(false);
    });

    it('keeps only the chat models of an installed list', () => {
        expect(ollamaChatModels(['bge-m3:latest', 'qwen2.5:7b', 'house-vectors:latest'], {
            'house-vectors:latest': ['embedding'],
        })).toEqual(['qwen2.5:7b']);
    });
});

describe('ollamaStatus', () => {
    it('asks /api/show what each installed model can do', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: any) => {
            if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version: '0.12.0' }) };
            if (url.endsWith('/api/tags')) {
                return { ok: true, json: async () => ({ models: [{ name: 'house-vectors:latest' }, { name: 'qwen2.5:7b' }] }) };
            }
            const { model } = JSON.parse(init.body);
            return {
                ok: true,
                json: async () => ({ capabilities: model === 'qwen2.5:7b' ? ['completion', 'tools'] : ['embedding'] }),
            };
        });
        const status = await ollamaStatus('http://127.0.0.1:11434', fetchImpl as any);
        expect(status.capabilities).toEqual({
            'house-vectors:latest': ['embedding'],
            'qwen2.5:7b': ['completion', 'tools'],
        });
        expect(ollamaChatModels(status.models, status.capabilities)).toEqual(['qwen2.5:7b']);
    });

    it('leaves capabilities out when Ollama is too old to describe its models', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version: '0.3.0' }) };
            if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'bge-m3:latest' }] }) };
            return { ok: false, status: 404, json: async () => ({}) };
        });
        const status = await ollamaStatus('http://127.0.0.1:11434', fetchImpl as any);
        expect(status).toEqual({ running: true, version: '0.3.0', models: ['bge-m3:latest'] });
        expect(ollamaChatModels(status.models, status.capabilities)).toEqual([]);
    });
});

/** A streamed /api/pull body whose chunks are released one `release()` at a time. */
function controlledStream() {
    const encoder = new TextEncoder();
    const queue: Array<(result: { value?: Uint8Array; done: boolean }) => void> = [];
    const pending: Array<{ value?: Uint8Array; done: boolean }> = [];
    const push = (result: { value?: Uint8Array; done: boolean }) => {
        const waiter = queue.shift();
        if (waiter) waiter(result);
        else pending.push(result);
    };
    return {
        body: {
            getReader: () => ({
                read: () => new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => {
                    const next = pending.shift();
                    if (next) resolve(next);
                    else queue.push(resolve);
                }),
            }),
        },
        send: (text: string) => push({ value: encoder.encode(text), done: false }),
        end: () => push({ value: undefined, done: true }),
    };
}

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('pullOllamaModel', () => {
    it('treats a stream that ends without "success" as an interrupted download', async () => {
        const stream = controlledStream();
        const fetchImpl = vi.fn(async () => ({ ok: true, body: stream.body }));
        const pulled = pullOllamaModel('http://127.0.0.1:11434', 'qwen2.5:7b', fetchImpl as any);
        stream.send('{"status":"pulling 8a1b","total":100,"completed":40}\n');
        stream.end();
        await expect(pulled).rejects.toThrow(PULL_INTERRUPTED_MESSAGE);
    });
});

describe('downloads that outlive the screen that started them', () => {
    it('keeps downloading with nothing watching, and says when it is done', async () => {
        const stream = controlledStream();
        let signal: AbortSignal | undefined;
        const fetchImpl = vi.fn(async (_url: string, init: any) => {
            signal = init.signal;
            return { ok: true, body: stream.body };
        });
        const onFinished = vi.fn();
        // Nothing subscribes: the guide that started it has already closed.
        startOllamaPull('http://127.0.0.1:11434', 'qwen2.5:7b', { fetchImpl: fetchImpl as any, onFinished });
        await flush();
        stream.send('{"status":"pulling 8a1b","total":200,"completed":50}\n');
        await flush();
        expect(ollamaPullState('http://127.0.0.1:11434/v1', 'qwen2.5:7b')).toMatchObject({ status: 'pulling', percent: 25 });
        expect(signal?.aborted).toBe(false);

        stream.send('{"status":"success"}\n');
        stream.end();
        await flush();
        expect(ollamaPullState('http://127.0.0.1:11434', 'qwen2.5:7b')?.status).toBe('done');
        expect(onFinished).toHaveBeenCalledWith('done');
    });

    it('does not start a second request for a model already downloading', async () => {
        const stream = controlledStream();
        const fetchImpl = vi.fn(async () => ({ ok: true, body: stream.body }));
        startOllamaPull('http://127.0.0.1:11434', 'bge-m3', { fetchImpl: fetchImpl as any });
        startOllamaPull('http://127.0.0.1:11434', 'bge-m3', { fetchImpl: fetchImpl as any });
        await flush();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('stops only on Cancel, and offers to resume', async () => {
        const fetchImpl = vi.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }));
        const seen = vi.fn();
        const unsubscribe = subscribeOllamaPulls(seen);
        const onFinished = vi.fn();
        startOllamaPull('http://127.0.0.1:11434', 'bge-m3', { fetchImpl: fetchImpl as any, onFinished });
        await flush();
        expect(ollamaPullState('http://127.0.0.1:11434', 'bge-m3')?.status).toBe('pulling');

        cancelOllamaPull('http://127.0.0.1:11434', 'bge-m3');
        await flush();
        const state = ollamaPullState('http://127.0.0.1:11434', 'bge-m3');
        expect(state?.status).toBe('cancelled');
        expect(state?.message).toMatch(/Resume/);
        expect(onFinished).toHaveBeenCalledWith('cancelled');
        expect(seen).toHaveBeenCalled();
        unsubscribe();
    });

    it('reports an interrupted download with the reason and a way to resume', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('connection reset'); });
        startOllamaPull('http://127.0.0.1:11434', 'qwen2.5:7b', { fetchImpl: fetchImpl as any });
        await flush();
        const state = ollamaPullState('http://127.0.0.1:11434', 'qwen2.5:7b');
        expect(state?.status).toBe('error');
        expect(state?.message).toBe('Download interrupted (connection reset). Resume picks up where it stopped.');
    });
});
