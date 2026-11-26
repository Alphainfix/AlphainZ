import { describe, expect, it, vi } from 'vitest';

import {
    EmbeddingProvider,
    embeddingProviderFromPreset,
    int8Cosine,
    itemEmbeddingText,
    quantizeToInt8,
    type FetchLike,
} from '@beaver/agent-llm/embeddings';

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

describe('quantizeToInt8', () => {
    it('scales the largest component to the int8 ceiling', () => {
        expect(quantizeToInt8([1, 0.5, -1])).toEqual([127, 64, -127]);
    });

    it('uses -127 rather than -128 as the floor', () => {
        // Two's complement is asymmetric; allowing -128 would stretch a vector
        // whose extreme component happens to be negative.
        expect(Math.min(...quantizeToInt8([-1, 0.5]))).toBe(-127);
    });

    it('is scale invariant, which is what cosine needs', () => {
        expect(quantizeToInt8([0.1, 0.05])).toEqual(quantizeToInt8([10, 5]));
    });

    it('returns zeros for an all-zero vector instead of NaN', () => {
        // Scaling by 1/0 would make every component NaN and poison the index.
        expect(quantizeToInt8([0, 0, 0])).toEqual([0, 0, 0]);
    });

    it('preserves length', () => {
        expect(quantizeToInt8(new Array(512).fill(0.3))).toHaveLength(512);
    });

    it('keeps every component in range', () => {
        const out = quantizeToInt8([5, -5, 0.001, -0.001, 2.5]);
        for (const value of out) {
            expect(value).toBeGreaterThanOrEqual(-127);
            expect(value).toBeLessThanOrEqual(127);
            expect(Number.isInteger(value)).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

describe('int8Cosine', () => {
    it('is 1 for identical direction', () => {
        expect(int8Cosine([127, 0], [127, 0])).toBeCloseTo(1);
    });

    it('is unaffected by magnitude, only direction', () => {
        // The property that makes per-vector quantization safe.
        expect(int8Cosine([100, 50], [10, 5])).toBeCloseTo(1);
    });

    it('is 0 for orthogonal vectors', () => {
        expect(int8Cosine([127, 0], [0, 127])).toBeCloseTo(0);
    });

    it('is -1 for opposite vectors', () => {
        expect(int8Cosine([127, 0], [-127, 0])).toBeCloseTo(-1);
    });

    it('is 0 rather than NaN when a vector is all zeros', () => {
        expect(int8Cosine([0, 0], [127, 0])).toBe(0);
    });

    it('rejects a dimension mismatch loudly', () => {
        expect(() => int8Cosine([1, 2], [1, 2, 3])).toThrow('dimension mismatch');
    });

    it('survives quantization: ranking is preserved', () => {
        // The real requirement — quantization may perturb scores, but the
        // ordering of near / far has to hold or retrieval degrades silently.
        const query = [0.9, 0.1, 0.05];
        const near = [0.85, 0.15, 0.02];
        const far = [-0.4, 0.9, 0.1];
        const q = quantizeToInt8(query);
        expect(int8Cosine(q, quantizeToInt8(near))).toBeGreaterThan(
            int8Cosine(q, quantizeToInt8(far)),
        );
    });
});

// ---------------------------------------------------------------------------
// Embedding text
// ---------------------------------------------------------------------------

describe('itemEmbeddingText', () => {
    it('leads with the title', () => {
        const text = itemEmbeddingText({ title: 'Bee navigation', abstract: 'We measure…' });
        expect(text.startsWith('Bee navigation')).toBe(true);
    });

    it('skips absent fields without leaving blank lines', () => {
        expect(itemEmbeddingText({ title: 'Only a title' })).toBe('Only a title');
        expect(itemEmbeddingText({})).toBe('');
    });

    it('caps creators so an author list cannot crowd out the abstract', () => {
        const text = itemEmbeddingText({
            title: 'T',
            creators: Array.from({ length: 20 }, (_, i) => `Author${i}`),
        });
        expect(text).toContain('Author5');
        expect(text).not.toContain('Author6');
    });

    it('truncates from the tail, keeping the title', () => {
        const text = itemEmbeddingText({ title: 'Keep me', abstract: 'x'.repeat(10_000) }, 100);
        expect(text).toHaveLength(100);
        expect(text.startsWith('Keep me')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function embeddingFetch(
    vectors: number[][],
    opts: { ok?: boolean; status?: number; body?: unknown; shuffle?: boolean } = {},
): FetchLike & { calls: any[] } {
    const calls: any[] = [];
    const fn = (async (url: string, init: any) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        // Echo one vector per requested text, cycling the fixtures — a double
        // that ignored the request count would trip the provider's own
        // length guard instead of exercising batching.
        const requested = JSON.parse(init.body).input.length;
        const data = Array.from({ length: requested }, (_, index) => ({
            index,
            embedding: vectors[index % Math.max(vectors.length, 1)] ?? [1, 0, 0, 0],
        }));
        if (opts.shuffle) data.reverse();
        return {
            ok: opts.ok ?? true,
            status: opts.status ?? 200,
            statusText: 'OK',
            text: async () => JSON.stringify(opts.body ?? { data }),
        };
    }) as FetchLike & { calls: any[] };
    fn.calls = calls;
    return fn;
}

const config = {
    label: 'Test',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'text-embedding-3-large',
    dimensions: 4,
};

describe('EmbeddingProvider', () => {
    it('stamps a model id carrying model and dimensions', () => {
        // Stored with each vector so a later model or dimension change is
        // detectable rather than silently comparing incompatible vectors.
        const provider = new EmbeddingProvider(config, embeddingFetch([]));
        expect(provider.modelId).toBe('text-embedding-3-large-int8-4');
    });

    it('requests the configured dimensionality', async () => {
        const fetchImpl = embeddingFetch([[1, 0, 0, 0]]);
        await new EmbeddingProvider(config, fetchImpl).generateQueryEmbedding('bees');
        expect(fetchImpl.calls[0].body).toMatchObject({
            model: 'text-embedding-3-large',
            dimensions: 4,
            input: ['bees'],
        });
        expect(fetchImpl.calls[0].url).toBe('https://example.test/v1/embeddings');
    });

    it('quantizes what it returns', async () => {
        const fetchImpl = embeddingFetch([[1, 0.5, -1, 0]]);
        const result = await new EmbeddingProvider(config, fetchImpl).generateQueryEmbedding('q');
        expect(result).toEqual({ embedding: [127, 64, -127, 0], dimensions: 4 });
    });

    it('sends X-Api-Key when the endpoint wants it', async () => {
        const fetchImpl = embeddingFetch([[1, 0, 0, 0]]);
        await new EmbeddingProvider(
            { ...config, authStyle: 'x-api-key' },
            fetchImpl,
        ).generateQueryEmbedding('q');
        expect(fetchImpl.calls[0].init.headers).toHaveProperty('X-Api-Key', 'k');
        expect(fetchImpl.calls[0].init.headers).not.toHaveProperty('Authorization');
    });

    it('keeps item ids aligned with their vectors', async () => {
        const fetchImpl = embeddingFetch([
            [1, 0, 0, 0],
            [0, 1, 0, 0],
        ]);
        const result = await new EmbeddingProvider(config, fetchImpl).generateEmbeddings([
            { item_id: 11, text: 'a' },
            { item_id: 22, text: 'b' },
        ]);
        expect(result.embeddings.map((e) => e.item_id)).toEqual([11, 22]);
        expect(result.embeddings[0].embedding).toEqual([127, 0, 0, 0]);
        expect(result.embeddings[1].embedding).toEqual([0, 127, 0, 0]);
    });

    it('reorders a permuted response by index', async () => {
        // A silently permuted batch would attach every vector to the wrong item.
        const fetchImpl = embeddingFetch(
            [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
            ],
            { shuffle: true },
        );
        const result = await new EmbeddingProvider(config, fetchImpl).generateEmbeddings([
            { item_id: 1, text: 'first' },
            { item_id: 2, text: 'second' },
        ]);
        expect(result.embeddings[0].embedding).toEqual([127, 0, 0, 0]);
    });

    it('batches so a large index does not exceed provider limits', async () => {
        const fetchImpl = embeddingFetch([[1, 0, 0, 0], [1, 0, 0, 0]]);
        await new EmbeddingProvider({ ...config, batchSize: 2 }, fetchImpl).generateEmbeddings(
            Array.from({ length: 5 }, (_, i) => ({ item_id: i, text: `t${i}` })),
        );
        // 5 items at 2 per batch = 3 requests.
        expect(fetchImpl.calls).toHaveLength(3);
        expect(fetchImpl.calls[2].body.input).toHaveLength(1);
    });

    it('reports an HTTP failure with the provider message', async () => {
        const fetchImpl = embeddingFetch([], {
            ok: false,
            status: 401,
            body: { error: { message: 'bad key' } },
        });
        await expect(
            new EmbeddingProvider(config, fetchImpl).generateQueryEmbedding('q'),
        ).rejects.toThrow(/401.*bad key/s);
    });

    it('rejects a short response rather than mislabelling vectors', async () => {
        // Its own double: the shared one echoes the requested count by design,
        // so a deliberately short reply has to be constructed here.
        const shortFetch = (async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }),
        })) as FetchLike;
        await expect(
            new EmbeddingProvider(config, shortFetch).generateEmbeddings([
                { item_id: 1, text: 'a' },
                { item_id: 2, text: 'b' },
            ]),
        ).rejects.toThrow('returned 1 embeddings for 2 texts');
    });

    it('rejects an empty embedding', async () => {
        const fetchImpl = embeddingFetch([[]]);
        await expect(
            new EmbeddingProvider(config, fetchImpl).generateQueryEmbedding('q'),
        ).rejects.toThrow('empty embedding');
    });

    it('rejects a non-JSON body', async () => {
        const fetchImpl = (async () => ({
            ok: true,
            status: 200,
            text: async () => '<html>gateway timeout</html>',
        })) as FetchLike;
        await expect(
            new EmbeddingProvider(config, fetchImpl).generateQueryEmbedding('q'),
        ).rejects.toThrow('non-JSON');
    });

    it('makes no request for an empty item list', async () => {
        const fetchImpl = embeddingFetch([]);
        const result = await new EmbeddingProvider(config, fetchImpl).generateEmbeddings([]);
        expect(result.embeddings).toEqual([]);
        expect(fetchImpl.calls).toHaveLength(0);
    });
});

describe('embeddingProviderFromPreset', () => {
    it('carries 512 dimensions for OpenAI', () => {
        const fetchImpl = embeddingFetch([]);
        const provider = embeddingProviderFromPreset('openai', 'k', fetchImpl);
        // 512 matches the existing table layout, so no schema change is needed.
        expect(provider.modelId).toBe('text-embedding-3-large-int8-512');
    });

    it('accepts overrides', () => {
        const provider = embeddingProviderFromPreset('openai', 'k', embeddingFetch([]), {
            dimensions: 256,
        });
        expect(provider.modelId).toBe('text-embedding-3-large-int8-256');
    });

    it('runs EmbeddingGemma 2 on Ollama, at its full 768 dimensions and with its prefixes', async () => {
        const fetchImpl = embeddingFetch([[1, 0]]);
        const provider = embeddingProviderFromPreset('ollama', '', fetchImpl);
        expect(provider.modelId).toBe('embeddinggemma-2:440m-q8_0-text-vision-int8-768');
        await provider.generateQueryEmbedding('waggle dance');
        await provider.generateEmbeddings([{ item_id: 1, text: 'honeybees' }]);
        expect(fetchImpl.calls[0].url).toBe('http://127.0.0.1:11434/v1/embeddings');
        expect(fetchImpl.calls[0].body).toMatchObject({ model: 'embeddinggemma-2:440m-q8_0-text-vision', dimensions: 768, input: ['task: search result | query: waggle dance'] });
        expect(fetchImpl.calls[1].body.input).toEqual(['title: none | text: honeybees']);
    });
});
