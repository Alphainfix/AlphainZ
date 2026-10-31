/**
 * Talking to Ollama from inside Zotero: address normalisation, what "installed"
 * means against Ollama's tag names, and the streamed pull progress.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    isModelInstalled,
    normalizeOllamaBase,
    parsePullLine,
    pullOllamaModel,
    ollamaStatus,
} from '../../../react/utils/ollama';

describe('normalizeOllamaBase', () => {
    it('defaults to the local server and strips the OpenAI suffix', () => {
        expect(normalizeOllamaBase('')).toBe('http://127.0.0.1:11434');
        expect(normalizeOllamaBase(' http://127.0.0.1:11434/v1/ ')).toBe('http://127.0.0.1:11434');
        expect(normalizeOllamaBase('http://gpu-box:11434')).toBe('http://gpu-box:11434');
    });
});

describe('isModelInstalled', () => {
    it('matches Ollama tags with or without :latest', () => {
        expect(isModelInstalled(['bge-m3:latest', 'qwen2.5:7b'], 'bge-m3')).toBe(true);
        expect(isModelInstalled(['bge-m3:latest'], 'qwen2.5:7b')).toBe(false);
        expect(isModelInstalled(['qwen2.5:7b'], 'qwen2.5:7b')).toBe(true);
        expect(isModelInstalled(['qwen2.5:14b'], 'qwen2.5:7b')).toBe(false);
    });
});

describe('parsePullLine', () => {
    it('turns a layer download line into a percentage', () => {
        const p = parsePullLine('{"status":"pulling 8a1b","digest":"sha256:8a1b","total":1000,"completed":250}');
        expect(p).toMatchObject({ percent: 25, done: false, completed: 250, total: 1000 });
    });
    it('marks success and ignores blank lines', () => {
        expect(parsePullLine('{"status":"success"}')?.done).toBe(true);
        expect(parsePullLine('   ')).toBeNull();
    });
    it('throws on an Ollama error line', () => {
        expect(() => parsePullLine('{"error":"pull model manifest: file does not exist"}')).toThrow(/does not exist/);
    });
});

function streamOf(chunks: string[]) {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        getReader: () => ({
            read: async () => (i < chunks.length
                ? { value: encoder.encode(chunks[i++]), done: false }
                : { value: undefined, done: true }),
        }),
    };
}

describe('pullOllamaModel', () => {
    it('reports progress from the stream and resolves on success', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            body: streamOf([
                '{"status":"pulling manifest"}\n{"status":"pulling 8a1b","total":100,"completed":',
                '50}\n{"status":"success"}\n',
            ]),
        }));
        const seen: Array<number | null> = [];
        await pullOllamaModel('http://127.0.0.1:11434/v1', 'bge-m3', fetchImpl as any, (p) => seen.push(p.percent));
        expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:11434/api/pull', expect.objectContaining({ method: 'POST' }));
        expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)).toEqual({ model: 'bge-m3', stream: true });
        expect(seen).toEqual([null, 50, null]);
    });

    it('surfaces the server\'s error for an unknown model', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'no such model' }) }));
        await expect(pullOllamaModel('http://127.0.0.1:11434', 'nope', fetchImpl as any)).rejects.toThrow(/no such model/);
    });
});

describe('ollamaStatus', () => {
    it('reads the version and the installed tags', async () => {
        const fetchImpl = vi.fn(async (url: string) => url.endsWith('/api/version')
            ? { ok: true, json: async () => ({ version: '0.33.3' }) }
            : { ok: true, json: async () => ({ models: [{ name: 'bge-m3:latest' }] }) });
        expect(await ollamaStatus('http://127.0.0.1:11434', fetchImpl as any)).toEqual({ running: true, version: '0.33.3', models: ['bge-m3:latest'] });
    });
    it('reports not running when nothing answers', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        const s = await ollamaStatus('http://127.0.0.1:11434', fetchImpl as any);
        expect(s.running).toBe(false);
        expect(s.error).toContain('ECONNREFUSED');
    });
});
