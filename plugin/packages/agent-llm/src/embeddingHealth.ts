/**
 * Whether the embedding provider worked the last time it was asked, and why
 * not when it did not.
 *
 * A provider can be configured and still fail every request — a key revoked, a
 * day's free allowance spent, the network down. The search tools tell the model
 * (see handleItemSearchByTopicRequest), but the person reading the answer is
 * told nothing unless something keeps the reason for them: the chat warns once
 * per conversation, and Settings shows it beside the provider until a request
 * succeeds again.
 *
 * Kept in a preference rather than in memory: the search tools, the indexers
 * and the Settings window do not share a module instance, and the reason should
 * still be there after a restart. Written only when the state changes, so a
 * provider that keeps working costs nothing.
 */

import { getPref, setPref } from './prefs';
import type { EmbeddingRequestOutcome } from './embeddings';
import { isModelRequestError, isQuotaErrorCode } from './sse';
import { joinSentences, t } from './i18n';

export interface EmbeddingHealth {
    /** The embedding model the failure belongs to; another model's is stale. */
    model: string;
    /** When the last failing request ended, ms since the epoch. */
    failedAt: number;
    /** What went wrong, as a sentence for the user. */
    reason: string;
}

/** The stored failure, if the model in use now is the one that failed. */
export function readEmbeddingHealth(model: string | null | undefined): EmbeddingHealth | null {
    if (!model) return null;
    const raw = getPref('embeddingHealth');
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<EmbeddingHealth>;
        if (parsed.model !== model || typeof parsed.failedAt !== 'number' || typeof parsed.reason !== 'string') {
            return null;
        }
        return { model: parsed.model, failedAt: parsed.failedAt, reason: parsed.reason };
    } catch {
        return null;
    }
}

/** Forget a failure: a request just worked, or the user's Test did. */
export function clearEmbeddingHealth(): void {
    if (getPref('embeddingHealth')) setPref('embeddingHealth', '');
}

/**
 * The reason a failed embedding request gives the user.
 *
 * Decided from the status and code the request carried, never from the text,
 * which quotes the provider's body. Each sentence ends with what happens next
 * or what to do, since that is the part the user can act on.
 */
export function describeEmbeddingFailure(error: unknown, label: string): string {
    const who = label || t('The embedding provider');
    if (!isModelRequestError(error)) {
        const text = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '');
        return t('{who} failed: {text}.', { who, text });
    }
    const status = error.status;
    if (error.code === 'daily_quota') {
        return joinSentences([
            t('{who} has used up today’s embedding allowance (on a free Google key, about 1000 texts a day).', { who }),
            error.retryAfterMs !== undefined
                ? t('It resets at midnight Pacific time ({time} here).', { time: resetTimeText(error.retryAfterMs) })
                : t('It resets at midnight Pacific time.'),
        ]);
    }
    if (error.code === 'invalid_api_key') return t('{who} does not accept the API key. Check it under Settings → Model.', { who });
    if (status === 401 || status === 403) {
        return t('{who} rejected the API key ({status}). Check it under Settings → Model.', { who, status });
    }
    if (isQuotaErrorCode(error.code) || status === 402) {
        return t("{who} reports that the account's quota or balance is used up.", { who });
    }
    if (status === 429) return t('{who} is limiting requests right now (429); it should work again in a minute.', { who });
    if (status === 404) return t('{who} does not offer the embedding model (404).', { who });
    switch (error.kind) {
        case 'network':
            return t('{who} could not be reached. Check the network, or that the server is running.', { who });
        case 'timeout':
            return t('{who} did not answer in time.', { who });
        default:
            break;
    }
    if (status !== undefined && status >= 500) return t('{who} had a server problem ({status}).', { who, status });
    if (status && error.detail) return t('{who} failed ({status}): {text}.', { who, status, text: error.detail });
    if (status) return t('{who} failed ({status}).', { who, status });
    if (error.detail) return t('{who} failed: {text}.', { who, text: error.detail });
    return t('{who} failed.', { who });
}

/** The local clock time a wait of `ms` from now ends at, as "3:00". */
function resetTimeText(ms: number): string {
    const at = new Date(Date.now() + ms);
    return `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * Whether a failure says something about the provider rather than one text:
 * a document the endpoint refused (400, 413, 422) is the indexer's business,
 * and a stop the user asked for is no failure at all.
 */
function isProviderFailure(error: unknown): boolean {
    if (!isModelRequestError(error)) return true;
    if (error.kind === 'cancelled') return false;
    return !(error.status === 400 || error.status === 413 || error.status === 422);
}

/** Record how a request for `model` ended. */
export function noteEmbeddingOutcome(model: string, label: string, outcome: EmbeddingRequestOutcome): void {
    if (outcome.ok) {
        clearEmbeddingHealth();
        return;
    }
    if (!isProviderFailure(outcome.error)) return;
    // Every failure moves the time: whether a run met one is read from it
    // (embeddingFailureSince), and failures come one per request at most.
    const reason = describeEmbeddingFailure(outcome.error, label);
    setPref('embeddingHealth', JSON.stringify({ model, failedAt: Date.now(), reason } satisfies EmbeddingHealth));
}

/**
 * The reason topic search failed during a run that started at `since`, or
 * null when nothing failed since then — what the chat warns about.
 */
export function embeddingFailureSince(model: string | null | undefined, since: number): string | null {
    const health = readEmbeddingHealth(model);
    return health && health.failedAt >= since ? health.reason : null;
}
