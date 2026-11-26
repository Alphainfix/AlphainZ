/**
 * Check a provider configuration by actually using it.
 *
 * Upstream asked its backend to validate a key. There is no backend here, so
 * verification is a real (tiny) request to the endpoint the user just
 * configured — which is strictly better evidence: it proves the key, the base
 * URL, the model name and the auth style all work together, not just that the
 * key is well-formed.
 *
 * Pure apart from the injected `fetch`.
 */

import { PROVIDER_PRESETS, providerFromPreset, type ProviderPresetId } from './openAICompatible';
import type { FetchLike } from './openAICompatible';
import { customProviderFromEndpoint, type CustomEndpoint } from './customEndpoints';
import type { ChatProvider } from './types';
import { EMBEDDING_PRESETS, embeddingProviderFromPreset, type EmbeddingPresetId } from './embeddings';
import type { StreamEvent } from './types';
import { childAbortController, isModelRequestError, isQuotaErrorCode, untilAborted } from './sse';
import { t } from '../../utils/i18n';

export interface VerifyResult {
    ok: boolean;
    /** Shown to the user, in the interface language; actionable when it fails. */
    message: string;
    /** Round-trip time, when the call completed. */
    ms?: number;
}

export interface VerifyOptions {
    model?: string;
    baseUrl?: string;
    /** Abort in-flight verification, e.g. when the panel closes. */
    signal?: AbortSignal;
    /** How long to wait for an answer before reporting the test failed. */
    timeoutMs?: number;
}

/**
 * Longest a Test waits for an answer.
 *
 * A dead address — a lab server behind a VPN that is off — otherwise holds the
 * button in its spinner until the network stack gives up, which can take
 * minutes. A minute still leaves room for a local server loading a model.
 */
const VERIFY_TIMEOUT_MS = 60_000;

/** Codes a provider uses for "this service is not offered where you are". */
const REGION_ERROR_CODES = new Set(['unsupported_country_region_territory', 'unsupported_country']);

/**
 * Turn a provider failure into a sentence naming the likely fix.
 *
 * A settings panel is exactly where a vague error is most expensive: the user
 * has several fields in front of them and no way to tell which one is wrong.
 * Decided from the status and the provider's code, not from the text, and the
 * provider's own sentence is kept — it often names the problem exactly. An
 * error that carries neither is shown as it is rather than guessed at.
 */
export function explainVerifyFailure(error: unknown, providerLabel: string): string {
    if (!isModelRequestError(error)) return error instanceof Error ? error.message : String(error);

    const said = error.detail ? ' ' + t('{provider} said: “{detail}”', { provider: providerLabel, detail: error.detail }) : '';
    // A failed connection is explained by what to check, not by the browser's
    // own error text, which names no cause.
    switch (error.kind) {
        case 'cancelled':
            return t('Test cancelled.');
        case 'network':
            return t('Could not reach {provider}. Check the network, or the base URL if this is a local server.', { provider: providerLabel });
        case 'timeout':
            return t('No answer from {provider} in time. Check the network and the base URL; a local server may still be loading the model.', { provider: providerLabel });
        case 'stream':
            return t('The connection to {provider} broke off. Try again.', { provider: providerLabel });
        default:
            break;
    }

    const status = error.status;
    if (status === 401) {
        return t('The key was rejected. Check that you copied all of it, with no stray spaces.') + said;
    }
    if (status === 403) {
        return REGION_ERROR_CODES.has(error.code ?? '')
            ? t('{provider} is not available in your region.', { provider: providerLabel }) + said
            : t('The endpoint refused the key (403): it may not have access to this model.') + said;
    }
    if (status === 402 || isQuotaErrorCode(error.code)) {
        return t('The key works, but the account is out of credit or quota.') + said;
    }
    if (status === 429) {
        return t('The key works, but it is rate limited right now. Try again in a moment.') + said;
    }
    if (status === 404 || error.code === 'model_not_found') {
        return t('The endpoint or model was not found. Check the model name, and the base URL if you set one.') + said;
    }
    if (status !== undefined && status >= 500) {
        return t('{provider} had a server problem ({status}). Try again in a moment.', { provider: providerLabel, status }) + said;
    }
    if (status !== undefined && status >= 400) {
        return t('The endpoint rejected the request ({status}).', { status }) + said;
    }
    // An error inside a 200 reply: the gateway's own words are the explanation.
    return error.detail ? t('The endpoint rejected the request: {detail}', { detail: error.detail }) : error.message;
}

/** Run `work` under the Test's deadline and the caller's signal. */
async function withinDeadline<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ value?: T; error?: unknown; timedOut: boolean; cancelled: boolean }> {
    const { controller, release } = childAbortController(options.signal);
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs ?? VERIFY_TIMEOUT_MS);
    try {
        const value = await untilAborted(work(controller.signal), controller.signal);
        return { value, timedOut, cancelled: options.signal?.aborted === true };
    } catch (error) {
        return { error, timedOut, cancelled: options.signal?.aborted === true };
    } finally {
        clearTimeout(timer);
        release();
    }
}

function timedOutMessage(label: string, timeoutMs: number | undefined): string {
    const seconds = Math.round((timeoutMs ?? VERIFY_TIMEOUT_MS) / 1000);
    return t('No answer from {provider} within {seconds} s. Check the network and the base URL; a server on this computer may still be loading the model.', { provider: label, seconds });
}

/**
 * Budget for the verification request.
 *
 * Small enough to cost nothing worth measuring, but not as small as it could
 * be: an OpenAI-compatible gateway rejected a 1-token request outright —
 * "Could not finish the message because max_tokens ... was reached" — rather
 * than returning a `length`-finished stream, so a budget too tight to complete
 * a reply fails a perfectly good key. Four was enough there; this leaves room
 * for a model that opens with a longer preamble.
 */
const VERIFY_MAX_TOKENS = 16;

/**
 * Verify a chat provider by asking for a very short reply.
 *
 * A tiny budget keeps the cost at effectively nothing while still exercising
 * the whole path: key, base URL, model name and auth style together.
 *
 * Success means the response really was a completion stream, not merely that
 * the status was 2xx. One API gateway answered an invalid model name
 * with HTTP 200 and a JSON error body, so a status check alone would report a
 * configuration that cannot answer a single question as working. The stream
 * parser rejects a body with no frames, which is what this relies on.
 *
 * What is deliberately *not* required is any content: at a small budget an
 * endpoint may legitimately send frames carrying only a finish reason.
 */
export async function verifyChatProvider(
    presetId: ProviderPresetId,
    apiKey: string,
    fetchImpl: FetchLike,
    options: VerifyOptions = {},
): Promise<VerifyResult> {
    const preset = PROVIDER_PRESETS[presetId];
    // Hosted endpoints need a key; Ollama runs on this machine and takes none.
    if (presetId !== 'ollama' && !apiKey.trim()) {
        return { ok: false, message: t('Enter a key first.') };
    }

    const provider = providerFromPreset(presetId, apiKey.trim(), fetchImpl, {
        ...(options.model ? { model: options.model } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        maxTokens: VERIFY_MAX_TOKENS,
    });
    return verifyWithProvider(provider, preset.label, options);
}

/**
 * Verify a hand-added endpoint with one of its models — the same tiny request,
 * so the address, the key, how it is sent and the model name are all exercised.
 * A key is optional here: a server on this computer usually takes none.
 */
export async function verifyCustomEndpoint(
    endpoint: CustomEndpoint,
    modelId: string,
    fetchImpl: FetchLike,
    options: Pick<VerifyOptions, 'signal' | 'timeoutMs'> = {},
): Promise<VerifyResult> {
    if (!endpoint.baseUrl.trim()) return { ok: false, message: t('Enter the base URL first.') };
    if (!modelId.trim()) return { ok: false, message: t('Add a model under this endpoint first, then test.') };
    const provider = customProviderFromEndpoint(endpoint, modelId.trim(), fetchImpl, { maxTokens: VERIFY_MAX_TOKENS });
    return verifyWithProvider(provider, endpoint.name || endpoint.baseUrl, options);
}

async function verifyWithProvider(
    provider: ChatProvider,
    label: string,
    options: Pick<VerifyOptions, 'signal' | 'timeoutMs'>,
): Promise<VerifyResult> {
    const started = Date.now();
    let failure: Error | null = null;

    const outcome = await withinDeadline(
        (signal) => provider.stream(
            { messages: [{ role: 'user', content: 'Reply with: ok' }], signal },
            (event: StreamEvent) => {
                if (event.type === 'error') failure = event.error;
            },
        ),
        options,
    );

    const ms = Date.now() - started;

    if (outcome.timedOut) return { ok: false, message: timedOutMessage(label, options.timeoutMs), ms };
    if (outcome.cancelled) return { ok: false, message: t('Test cancelled.'), ms };
    const error = failure ?? outcome.error;
    if (error) {
        return {
            ok: false,
            message: explainVerifyFailure(error, label),
            ms,
        };
    }
    return { ok: true, message: t('Connected in {ms} ms.', { ms }), ms };
}

/**
 * Verify an embedding provider, and report the dimensionality it returned.
 *
 * The dimension is worth surfacing: a provider that silently ignores the
 * `dimensions` request produces vectors the existing table cannot hold, and the
 * only symptom later would be a dimension-mismatch error mid-search.
 *
 * `baseUrl` points the test where the provider really is — for Ollama, the
 * address set on its card rather than the default local port.
 */
export async function verifyEmbeddingProvider(
    presetId: EmbeddingPresetId,
    apiKey: string,
    fetchImpl: FetchLike,
    options: Pick<VerifyOptions, 'baseUrl' | 'signal' | 'timeoutMs'> = {},
): Promise<VerifyResult> {
    const preset = EMBEDDING_PRESETS[presetId];
    if (presetId !== 'ollama' && !apiKey.trim()) {
        return { ok: false, message: t('Enter a key first.') };
    }

    const provider = embeddingProviderFromPreset(presetId, apiKey.trim(), fetchImpl as any, {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
    const started = Date.now();

    const outcome = await withinDeadline(
        (signal) => provider.generateQueryEmbedding('embedding check', signal),
        options,
    );
    const ms = Date.now() - started;

    if (outcome.timedOut) return { ok: false, message: timedOutMessage(preset.label, options.timeoutMs), ms };
    if (outcome.cancelled) return { ok: false, message: t('Test cancelled.'), ms };
    if (outcome.error !== undefined || !outcome.value) {
        return { ok: false, message: explainVerifyFailure(outcome.error, preset.label), ms };
    }

    const result = outcome.value;
    if (result.dimensions !== preset.dimensions) {
        return {
            ok: false,
            message: t('Expected {expected}-dimensional vectors but got {got}. This endpoint ignores the dimensions request, so its vectors will not fit the existing index.', { expected: preset.dimensions, got: result.dimensions }),
            ms,
        };
    }
    return { ok: true, message: t('Connected in {ms} ms · {dimensions} dimensions.', { ms, dimensions: result.dimensions }), ms };
}
