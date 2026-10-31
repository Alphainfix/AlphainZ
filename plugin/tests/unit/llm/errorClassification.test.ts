/**
 * What an error card says is decided by the status, and keeps the provider's
 * own reason.
 *
 * The message quotes the provider's body, so searching it for "401", "403",
 * "429" or "quota" misreads a context-length 400 quoting "1054012 tokens", an
 * OpenRouter 402 "can only afford 4012", or a region block as a rejected key,
 * and turns a Zhipu "余额不足" into "try again shortly" with the reason lost.
 */
import { describe, expect, it } from 'vitest';

import { classifyRunError, runLocalAgent, type LocalRunCallbacks } from '../../../src/services/llm/localRunner';
import { OpenAICompatibleProvider, describeHttpFailure, type FetchLike } from '../../../src/services/llm/openAICompatible';
import { EmbeddingProvider } from '../../../src/services/llm/embeddings';
import { explainVerifyFailure } from '../../../src/services/llm/verifyKey';
import { toRunError } from '@beaver/agent-core/run-state/runResumeHelpers';
import type { ChatProvider } from '../../../src/services/llm/types';

const failure = (label: string, status: number, body: unknown) =>
    describeHttpFailure(label, status, undefined, async () =>
        typeof body === 'string' ? body : JSON.stringify(body),
    );

describe('classifyRunError', () => {
    it('does not read a token count containing "401" as a rejected key', async () => {
        const error = await failure('DeepSeek', 400, {
            error: { message: "This model's maximum context length is 1048576 tokens. However, you requested 1054012 tokens." },
        });
        const result = classifyRunError(error);
        expect(result.type).not.toBe('llm_auth_error');
        expect(result.user_facing_details).toContain('1054012');
    });

    it('reports a context-length code as a conversation that is too long', async () => {
        const error = await failure('OpenAI', 400, {
            error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' },
        });
        expect(classifyRunError(error)).toMatchObject({ type: 'llm_context_window_exceeded', is_retryable: false });
    });

    it('reports a 402 as billing, whatever digits the body holds', async () => {
        const error = await failure('OpenRouter', 402, {
            error: { code: 402, message: 'This request requires more credits. You can only afford 4012 tokens.' },
        });
        const result = classifyRunError(error);
        expect(result).toMatchObject({ type: 'llm_insufficient_credits', is_retryable: false });
        expect(result.user_facing_details).toContain('afford 4012');
    });

    it('explains a region block instead of blaming the key', async () => {
        const error = await failure('OpenAI', 403, {
            error: { message: 'Country, region, or territory not supported', code: 'unsupported_country_region_territory' },
        });
        const result = classifyRunError(error);
        expect(result.type).toBe('llm_model_access_denied');
        expect(result.message).toMatch(/region/);
        expect(result.user_facing_details).toBe('Country, region, or territory not supported');
    });

    it('keeps Zhipu\'s own reason for a spent balance, and does not offer to wait it out', async () => {
        const error = await failure('Zhipu GLM', 429, { error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } });
        const result = classifyRunError(error);
        expect(result).toMatchObject({ type: 'llm_quota_exceeded', is_retryable: false });
        expect(result.user_facing_details).toBe('余额不足或无可用资源包,请充值。');
    });

    it('names the settings section the key actually lives in', async () => {
        const result = classifyRunError(await failure('DeepSeek', 401, { error: { message: 'Authentication Fails' } }));
        expect(result).toMatchObject({ type: 'llm_auth_error', is_retryable: false });
        expect(result.message).toContain('Settings → Model → Providers');
        expect(result.message).not.toContain('API Keys');
        expect(result.user_facing_details).toBe('Authentication Fails');
    });

    it('carries Retry-After for a rate limit', async () => {
        const error = await describeHttpFailure('DeepSeek', 429, undefined, async () => '', { retryAfterMs: 12_000 });
        expect(classifyRunError(error)).toMatchObject({ type: 'llm_rate_limit', is_retryable: true, retry_after: 12 });
    });

    it('does not guess from the text of an error that carries no status', () => {
        const result = classifyRunError(new Error('Request 403-1401 failed: quota check skipped'));
        expect(result).toMatchObject({ type: 'llm_error', message: 'Request 403-1401 failed: quota check skipped' });
    });

    it('shows an HTML error page as its title, not as markup', async () => {
        const error = await failure(
            'Lab server',
            502,
            '<html><head><title>502 Bad Gateway</title><style>body{}</style></head><body><h1>502</h1></body></html>',
        );
        const result = classifyRunError(error);
        expect(result.type).toBe('llm_service_unavailable');
        expect(result.user_facing_details).toBe('502 Bad Gateway');
    });

    it('reads the reason out of a FastAPI validation error', async () => {
        const error = await failure('Lab server', 422, {
            detail: [{ loc: ['body', 'messages', 3, 'content'], msg: 'field required', type: 'value_error.missing' }],
        });
        expect(classifyRunError(error)).toMatchObject({
            type: 'invalid_request',
            user_facing_details: 'messages.3.content: field required',
        });
    });

    it('reads a FastAPI error sentence', async () => {
        const error = await failure('Lab server', 404, { detail: 'Model qwen3-32b is not loaded' });
        expect(classifyRunError(error).user_facing_details).toBe('Model qwen3-32b is not loaded');
    });

    it('reads a FastAPI body on an embedding request too', async () => {
        const provider = new EmbeddingProvider(
            { label: 'Lab server', baseUrl: 'http://10.0.0.5:8000/v1', apiKey: '', model: 'bge-m3', dimensions: 512 },
            async () => ({
                ok: false,
                status: 422,
                statusText: 'Unprocessable Entity',
                text: async () => JSON.stringify({ detail: [{ loc: ['body', 'input'], msg: 'field required' }] }),
            }),
        );
        await expect(provider.generateQueryEmbedding('q')).rejects.toMatchObject({
            status: 422,
            detail: 'input: field required',
        });
    });
});

// ---------------------------------------------------------------------------
// What the card says when the provider gave no sentence of its own
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function bodyOf(chunks: string[]) {
    let i = 0;
    return {
        getReader: () => ({
            read: async () =>
                i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined },
            cancel: async () => undefined,
        }),
    };
}

/** The error the card receives when a run's only request goes the way `fetchImpl` says. */
async function cardFor(fetchImpl: FetchLike, label = 'DeepSeek') {
    const errors: any[] = [];
    const callbacks: LocalRunCallbacks = {
        onThread: () => undefined,
        onReady: () => undefined,
        onPart: () => undefined,
        onToolCallArgsStream: () => undefined,
        onToolReturn: () => undefined,
        onToolCallProgress: () => undefined,
        onRunComplete: () => undefined,
        onDone: () => undefined,
        onError: (e) => {
            errors.push(e);
        },
    };
    await runLocalAgent({
        runId: 'r',
        threadId: 't',
        messages: [{ role: 'user', content: 'q' }],
        provider: new OpenAICompatibleProvider(
            { label, baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', wireFormat: 'openai' },
            fetchImpl,
        ),
        callbacks,
        retry: { maxRetries: 0 },
    });
    expect(errors).toHaveLength(1);
    return errors[0];
}

describe('an error that came without the provider\'s own reason', () => {
    it('keeps what went wrong with an empty 200 response', async () => {
        const card = await cardFor((async () => ({ ok: true, status: 200, text: async () => '', body: bodyOf([]) })) as any);
        expect(card.user_facing_details).toBe('The endpoint returned an empty response instead of a completion stream.');
    });

    it('keeps what went wrong with a response that had no body', async () => {
        const card = await cardFor((async () => ({ ok: true, status: 200, text: async () => '', body: null })) as any);
        expect(card.user_facing_details).toBe('DeepSeek returned no response body');
    });

    it('keeps the finish reason a failed reply ended with', async () => {
        const card = await cardFor((async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            body: bodyOf([
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'insufficient_system_resource' }] })}\n\n`,
            ]),
        })) as any);
        expect(card).toMatchObject({ type: 'llm_service_unavailable', is_retryable: true });
        expect(card.user_facing_details).toContain('insufficient_system_resource');
    });
});

describe('a connection that failed', () => {
    it('is explained by what to check, not by the browser\'s own error text', async () => {
        const card = await cardFor((async () => {
            throw new TypeError('NetworkError when attempting to fetch resource.');
        }) as any);
        expect(card).toMatchObject({ type: 'llm_network_error', is_retryable: true });
        expect(card.message).toContain('Could not reach DeepSeek');
        expect(card.user_facing_details).toBeUndefined();
    });

    it('is explained the same way when it breaks off mid-reply', async () => {
        const card = await cardFor((async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            body: {
                getReader: () => ({
                    read: async () => {
                        throw new TypeError('Error in input stream');
                    },
                    cancel: async () => undefined,
                }),
            },
        })) as any);
        expect(card.type).toBe('llm_streaming_error');
        expect(card.user_facing_details).toBeUndefined();
    });
});

describe('the reason reaches the error card', () => {
    it('is passed with the error event and kept on the run', async () => {
        const errors: any[] = [];
        const callbacks: LocalRunCallbacks = {
            onThread: () => undefined,
            onReady: () => undefined,
            onPart: () => undefined,
            onToolCallArgsStream: () => undefined,
            onToolReturn: () => undefined,
            onToolCallProgress: () => undefined,
            onRunComplete: () => undefined,
            onDone: () => undefined,
            onError: (e) => {
                errors.push(e);
            },
        };
        const provider: ChatProvider = {
            label: 'OpenAI',
            model: 'gpt-5',
            wireFormat: 'openai',
            async stream(_request, onEvent) {
                onEvent({
                    type: 'error',
                    error: await failure('OpenAI', 400, {
                        error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." },
                    }),
                });
            },
        };
        await runLocalAgent({ runId: 'r', threadId: 't', messages: [{ role: 'user', content: 'q' }], provider, callbacks });

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
            type: 'invalid_request',
            is_retryable: false,
            user_facing_details: "Unsupported parameter: 'max_tokens' is not supported with this model.",
        });
        expect(toRunError(errors[0]).user_facing_details).toBe(
            "Unsupported parameter: 'max_tokens' is not supported with this model.",
        );
    });
});

describe('explainVerifyFailure', () => {
    it('does not call a context-length 400 a rejected key', async () => {
        const error = await failure('OpenAI', 400, { error: { message: 'resulted in 140301 tokens' } });
        const message = explainVerifyFailure(error, 'OpenAI');
        expect(message).not.toMatch(/key was rejected/);
        expect(message).toContain('140301');
    });

    it('keeps the provider\'s words for a region block', async () => {
        const error = await failure('OpenAI', 403, {
            error: { message: 'Country, region, or territory not supported', code: 'unsupported_country_region_territory' },
        });
        expect(explainVerifyFailure(error, 'OpenAI')).toMatch(/region/);
    });
});
