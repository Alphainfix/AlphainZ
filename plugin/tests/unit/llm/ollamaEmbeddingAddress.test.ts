/**
 * Ollama embeddings go where Ollama is.
 *
 * The availability check reads the address set on the Ollama card, so the
 * embedding requests — indexing, topic search, the embedding Test — have to go
 * there too; sent to the default local port instead, they all fail while the
 * check passes. The address is taken as an override, in the same form the
 * Ollama card stores it.
 */
import { describe, expect, it } from 'vitest';

import { embeddingProviderFromPreset } from '../../../src/services/llm/embeddings';
import { verifyEmbeddingProvider } from '../../../src/services/llm/verifyKey';

function embeddingFetch() {
    const urls: string[] = [];
    const fn = (async (url: string) => {
        urls.push(url);
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ data: [{ index: 0, embedding: new Array(768).fill(0.1) }] }),
        };
    }) as any;
    return { fn, urls };
}

describe('Ollama embedding address', () => {
    it('uses the configured server address, adding the OpenAI-compatible root', async () => {
        const { fn, urls } = embeddingFetch();
        await embeddingProviderFromPreset('ollama', '', fn, { baseUrl: 'http://192.168.1.20:11500' })
            .generateQueryEmbedding('q');
        expect(urls).toEqual(['http://192.168.1.20:11500/v1/embeddings']);
    });

    it('accepts an address that already ends in /v1', async () => {
        const { fn, urls } = embeddingFetch();
        await embeddingProviderFromPreset('ollama', '', fn, { baseUrl: 'http://gpu-box:11434/v1/' })
            .generateQueryEmbedding('q');
        expect(urls).toEqual(['http://gpu-box:11434/v1/embeddings']);
    });

    it('defaults to the same local address chat uses', async () => {
        const { fn, urls } = embeddingFetch();
        await embeddingProviderFromPreset('ollama', '', fn).generateQueryEmbedding('q');
        expect(urls).toEqual(['http://127.0.0.1:11434/v1/embeddings']);
    });

    it('tests the address it was given', async () => {
        const { fn, urls } = embeddingFetch();
        const result = await verifyEmbeddingProvider('ollama', '', fn, { baseUrl: 'http://192.168.1.20:11500' });
        expect(result.ok).toBe(true);
        expect(urls).toEqual(['http://192.168.1.20:11500/v1/embeddings']);
    });
});
