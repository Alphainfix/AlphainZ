/**
 * The OpenAI preset works with the models its own endpoint lists.
 *
 * It speaks the Responses API, where OpenAI's reasoning models (gpt-5 and
 * later, the o-series) take a thinking effort together with tools; the output
 * cap there is `max_output_tokens` for every model, and the ceiling follows
 * the chosen model. gpt-4o answers on the same wire, sent no `reasoning`.
 */
import { describe, expect, it } from 'vitest';

import { presetCapabilities, providerFromPreset, type FetchLike } from '../../../src/services/llm/openAICompatible';

const noFetch = (async () => {
    throw new Error('not called');
}) as unknown as FetchLike;

const bodyFor = (model?: string) =>
    providerFromPreset('openai', 'sk-test', noFetch, { ...(model ? { model } : {}), maxTokens: 8000 }).buildBody({
        messages: [{ role: 'user', content: 'hi' }],
    });

describe('OpenAI preset', () => {
    it.each(['gpt-5', 'o4-mini', 'gpt-4o'])('sends max_output_tokens for %s', (model) => {
        const body = bodyFor(model);
        expect(body.max_output_tokens).toBe(8000);
        expect(body).not.toHaveProperty('max_tokens');
        expect(body).not.toHaveProperty('max_completion_tokens');
    });

    it('asks the reasoning models for an effort and leaves gpt-4o without one', () => {
        // With none configured (the key Test), the least each model accepts.
        expect(bodyFor('gpt-5.1').reasoning).toEqual({ effort: 'none' });
        expect(bodyFor('o4-mini').reasoning).toMatchObject({ effort: 'low' });
        expect(bodyFor('gpt-5').reasoning).toMatchObject({ effort: 'minimal' });
        expect(bodyFor('gpt-4o')).not.toHaveProperty('reasoning');
        expect(bodyFor('gpt-5-chat-latest')).not.toHaveProperty('reasoning');
        // No thinking summaries on api.openai.com: some organisations must be verified first.
        const thinking = providerFromPreset('openai', 'sk-test', noFetch, {
            model: 'gpt-5.1',
            extraBody: { reasoning_effort: 'low' },
        }).buildBody({ messages: [{ role: 'user', content: 'hi' }] });
        expect(thinking.reasoning).toEqual({ effort: 'low' });
        expect(thinking).not.toHaveProperty('reasoning_effort');
    });

    it('holds each model to its own output ceiling', () => {
        // A stored gpt-4o-mini must not be sent the 32k default.
        expect(presetCapabilities('openai', 'gpt-6-luna').maxOutputTokens).toBe(128_000);
        expect(presetCapabilities('openai').maxOutputTokens).toBe(16_384);
        expect(presetCapabilities('openai', 'gpt-4o-mini').maxOutputTokens).toBe(16_384);
        expect(presetCapabilities('openai', 'gpt-4.1').maxOutputTokens).toBe(32_768);
        expect(presetCapabilities('openai', 'o3').maxOutputTokens).toBe(100_000);
        expect(presetCapabilities('openai', 'gpt-5-mini').maxOutputTokens).toBe(128_000);
    });

    it('leaves the other presets as they were', () => {
        expect(providerFromPreset('deepseek', 'k', noFetch, { maxTokens: 100 }).buildBody({ messages: [] }))
            .toMatchObject({ max_tokens: 100 });
        expect(presetCapabilities('deepseek').maxOutputTokens).toBe(393_216);
    });
});

describe('an OpenAI card pointed at an address without /responses', () => {
    /** A relay that speaks only chat completions: /responses is a 404 there. */
    function relay(chatStatus = 200) {
        const calls: Array<{ url: string; body: any }> = [];
        const fetchImpl = (async (url: string, init: any) => {
            calls.push({ url, body: JSON.parse(init.body) });
            if (url.endsWith('/responses')) {
                return { ok: false, status: 404, statusText: 'Not Found', text: async () => '404 page not found', body: null };
            }
            const chunks = [`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`];
            let i = 0;
            return {
                ok: chatStatus === 200, status: chatStatus, text: async () => '',
                body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]) } : { done: true, value: undefined }) }) },
            };
        }) as unknown as FetchLike;
        return { fetchImpl, calls };
    }
    const tool = { name: 't', description: 'd', parameters: { type: 'object' as const, properties: {} } };

    it('answers on /chat/completions instead, at the least effort, and stays there', async () => {
        const { fetchImpl, calls } = relay();
        const provider = providerFromPreset('openai', 'sk', fetchImpl, {
            model: 'gpt-5.1',
            baseUrl: 'https://relay.example/v1',
            extraBody: { reasoning_effort: 'high' },
        });
        const events: any[] = [];
        await provider.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [tool] }, (e) => events.push(e));
        expect(calls.map((c) => c.url)).toEqual(['https://relay.example/v1/responses', 'https://relay.example/v1/chat/completions']);
        expect(events.at(-1)).toMatchObject({ type: 'done' });
        // On /chat/completions OpenAI's newer models take tools only at the least effort.
        expect(calls[1].body).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: expect.any(Number) });
        expect(calls[1].body.messages).toBeDefined();
        expect(provider.wireFormat).toBe('openai');

        await provider.stream({ messages: [{ role: 'user', content: 'again' }] }, () => undefined);
        expect(calls[2].url).toBe('https://relay.example/v1/chat/completions');
    });

    it('does not mistake a missing model for a missing endpoint', async () => {
        const calls: string[] = [];
        const fetchImpl = (async (url: string) => {
            calls.push(url);
            return {
                ok: false, status: 404, statusText: 'Not Found', body: null,
                text: async () => JSON.stringify({ error: { message: 'The model `gpt-9` does not exist', code: 'model_not_found' } }),
            };
        }) as unknown as FetchLike;
        const events: any[] = [];
        await providerFromPreset('openai', 'sk', fetchImpl, { model: 'gpt-9' })
            .stream({ messages: [{ role: 'user', content: 'hi' }] }, (e) => events.push(e));
        expect(calls).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { status: 404, code: 'model_not_found' } });
    });
});
