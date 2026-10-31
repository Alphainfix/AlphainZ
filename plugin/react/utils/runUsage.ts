import { RunUsage } from '@beaver/agent-core/agents/types';

/**
 * Returns input tokens for the latest model request in a run when determinable.
 *
 * - Preferred: last item from usage.model_requests (per-request backend data)
 * - Fallback: aggregate input_tokens when exactly one request was made
 * - Otherwise: null (cannot safely infer last-request input tokens)
 */
/**
 * Input tokens of the run's FIRST request: system prompt + summary + replayed
 * history + the new prompt, before any in-run tool results pile on. This is
 * the part of a request that compaction can actually shrink, which makes it
 * the honest trigger signal — a run that merely read big pages mid-flight
 * should not look like a bloated conversation.
 */
export function getFirstRequestInputTokens(usage: RunUsage): number | null {
    if (usage.model_requests && usage.model_requests.length > 0) {
        const first = usage.model_requests[0];
        if (typeof first.input_tokens === 'number') {
            return first.input_tokens;
        }
    }
    if (usage.requests === 1) {
        return usage.input_tokens;
    }
    return null;
}

export function getLastRequestInputTokens(usage: RunUsage): number | null {
    if (usage.model_requests && usage.model_requests.length > 0) {
        const lastRequest = usage.model_requests[usage.model_requests.length - 1];
        if (typeof lastRequest.input_tokens === 'number') {
            return lastRequest.input_tokens;
        }
    }

    if (usage.requests === 1) {
        return usage.input_tokens;
    }

    return null;
}
