/**
 * Run the agent locally while speaking the UI's existing protocol.
 *
 * The chat UI does not know or care where a run comes from: it consumes a
 * `WSCallbacks` stream — `onThread`, `onReady`, `onPart`, `onToolReturn`,
 * `onRunComplete`, `onDone` — and renders whatever arrives. That was fed by a
 * WebSocket to Beaver's backend. This module feeds the same callbacks from
 * `runAgentLoop` instead, so the whole panel (message rendering, tool-call
 * cards, citation previews, approval flow) keeps working untouched.
 *
 * Everything here is translation. The interesting constraints are the two the
 * UI's store assumes and the loop does not state:
 *
 *  - **A message index holds either a response or a request, never both.** The
 *    store rewrites the slot's kind to match what arrives, so putting an
 *    assistant tool-call and its tool-return at the same index silently erases
 *    the call. One round is therefore three messages: response (text plus
 *    calls), request (the returns), response (the answer).
 *  - **`part_index` counts parts within one message** and must advance
 *    monotonically, or parts overwrite each other.
 *  - **Streamed text belongs to one part, not one part per chunk.** The store
 *    appends by `(message_index, part_index)`, so a new index per token would
 *    render every token as its own paragraph.
 */

import { runAgentLoop, type AgentLoopResult, type LoopEvent, type RetryPolicy } from './agentLoop';
import type { ChatMessage, ChatProvider, ToolSchema } from './types';
import type { ToolDispatcher } from './agentLoop';
import { formatTokenCount } from './runLimits';
import { isModelRequestError, isQuotaErrorCode, parsePartialToolArguments } from './sse';
import { WRITE_TOOL_NAMES } from './writeTools';

/**
 * The slice of `WSCallbacks` a local run drives.
 *
 * Structural, not imported: this module lives in the esbuild bundle and the
 * protocol types come from a package the webpack bundle owns. Keeping the shape
 * local avoids a cross-bundle import for what is a handful of function
 * signatures — and the parity test pins it against the real interface.
 */
export interface LocalRunCallbacks {
    onThread: (threadId: string, truncation?: unknown) => void;
    onReady: (data: {
        subscriptionStatus: unknown;
        processingMode: unknown;
        indexingComplete: boolean;
    }) => void;
    onPart: (event: {
        event: 'part';
        run_id: string;
        message_index: number;
        part_index: number;
        part: Record<string, unknown>;
    }) => void | Promise<void>;
    onToolCallArgsStream: (event: {
        event: 'tool_call_args_stream';
        run_id: string;
        tool_call_id: string;
        tool_name: string;
        args: Record<string, unknown>;
    }) => void;
    onToolReturn: (event: {
        event: 'tool_return';
        run_id: string;
        message_index: number;
        part: Record<string, unknown>;
    }) => void | Promise<void>;
    onToolCallProgress: (event: {
        event: 'tool_call_progress';
        run_id: string;
        tool_call_id: string;
        progress: string;
    }) => void;
    onRunComplete: (event: {
        event: 'run_complete';
        run_id: string;
        usage: unknown;
        cost: number | null;
        citations: unknown;
        agent_actions: unknown;
    }) => void | Promise<void>;
    onDone: () => void;
    onError: (event: {
        event: 'error';
        type: string;
        message: string;
        run_id?: string;
        details?: string;
        /** The provider's own reason, shown under the message. */
        user_facing_details?: string;
        is_retryable?: boolean;
        retry_after?: number;
    }) => void;
    onWarning?: (event: {
        event: 'warning';
        run_id: string;
        type: string;
        message: string;
    }) => void;
    /** A model request failed transiently and is about to be sent again. */
    onRetry?: (event: {
        event: 'retry';
        run_id: string;
        attempt: number;
        max_attempts: number;
        reason: string;
        wait_seconds?: number | null;
        reset: boolean;
    }) => void;
}

export interface LocalRunOptions {
    runId: string;
    threadId: string;
    messages: ChatMessage[];
    provider: ChatProvider;
    tools?: ToolSchema[];
    dispatch?: ToolDispatcher;
    callbacks: LocalRunCallbacks;
    maxIterations?: number;
    /** The output cap each request carried, so the warning can name it. */
    outputTokenLimit?: number;
    /**
     * Stops the run: the request in flight is abandoned, no further tool runs,
     * and nothing but the closing `onDone` is reported after it.
     */
    signal?: AbortSignal;
    /** Semantic search is dark without an embedding index; surfaced as a warning. */
    warnings?: Array<{ type: string; message: string }>;
    /**
     * Why embedding requests failed since a time, or null if none did: asked
     * after each topic or full-text search, so a provider that is configured
     * but failing (a revoked key, a spent day) is reported to the user, not
     * only to the model.
     */
    embeddingFailureSince?: (since: number) => string | null;
    /** Overrides how transient request failures are retried. */
    retry?: RetryPolicy;
}

/** The tools that embed the query; a failed embedding is warned about after them. */
const EMBEDDING_TOOLS = new Set(['item_search_by_topic', 'search_library_fulltext', 'search_library_figures']);

/**
 * Tracks where the next part goes.
 *
 * One assistant message per iteration, and within it one part per *kind of
 * thing* — a text run, a thinking run, each tool call. Text and thinking each
 * keep an open part so consecutive chunks append to it; anything else closes
 * them, because a tool call between two sentences really is a new part.
 */
class PartCursor {
    messageIndex = 0;
    private nextPartIndex = 0;
    private openText: number | null = null;
    private openThinking: number | null = null;
    /** Index the current round's tool returns go to, once one arrives. */
    private returnsIndex: number | null = null;

    /** Begin a new assistant message. */
    newMessage(): void {
        this.messageIndex += 1;
        this.nextPartIndex = 0;
        this.returnsIndex = null;
        this.closeOpenRuns();
    }

    /**
     * Index for this round's tool returns.
     *
     * A slot holds one kind of message, and the store rewrites the kind on
     * write — so returns must go *after* the response that requested them or
     * they overwrite the tool calls. Allocated once per round and reused, so
     * several returns share one request message, which is the shape the wire
     * format uses.
     */
    returnsMessageIndex(): number {
        if (this.returnsIndex === null) {
            this.messageIndex += 1;
            this.returnsIndex = this.messageIndex;
            this.nextPartIndex = 0;
            this.closeOpenRuns();
        }
        return this.returnsIndex;
    }

    closeOpenRuns(): void {
        this.openText = null;
        this.openThinking = null;
    }

    /** Index for a text chunk, reusing the open text part when there is one. */
    textIndex(): { index: number; isNew: boolean } {
        if (this.openText !== null) return { index: this.openText, isNew: false };
        this.openThinking = null;
        this.openText = this.nextPartIndex;
        this.nextPartIndex += 1;
        return { index: this.openText, isNew: true };
    }

    thinkingIndex(): { index: number; isNew: boolean } {
        if (this.openThinking !== null) return { index: this.openThinking, isNew: false };
        this.openText = null;
        this.openThinking = this.nextPartIndex;
        this.nextPartIndex += 1;
        return { index: this.openThinking, isNew: true };
    }

    /** A discrete part (a tool call): always its own index, and closes any run. */
    discreteIndex(): number {
        this.closeOpenRuns();
        const index = this.nextPartIndex;
        this.nextPartIndex += 1;
        return index;
    }

    /**
     * Start the current message over, for a request that is being sent again.
     * Returns the part indices the abandoned attempt used, so they can be
     * blanked; the new attempt writes from index 0.
     */
    restartMessage(): number[] {
        const used = Array.from({ length: this.nextPartIndex }, (_, index) => index);
        this.nextPartIndex = 0;
        this.closeOpenRuns();
        return used;
    }
}

/** How a failed run is reported to the UI's error card. */
export interface RunErrorReport {
    type: string;
    /** The headline: what happened and what to do about it. */
    message: string;
    is_retryable: boolean;
    /** The provider's own words, shown under the headline as the reason. */
    user_facing_details?: string;
    /** Seconds the provider asked to wait before trying again. */
    retry_after?: number;
}

/** Where every provider's key, address and model list are set. */
const PROVIDER_SETTINGS = 'Settings → Model → Providers';

/**
 * How finely a streaming call's argument preview follows the stream: it is
 * re-parsed each time the arguments have grown by 1/50 of their length, which
 * is every fragment for a short call and every paragraph or so for a long note.
 */
const PREVIEW_GROWTH_STEPS = 50;

/** Codes a provider uses for "this service is not offered where you are". */
const REGION_ERROR_CODES = new Set(['unsupported_country_region_territory', 'unsupported_country']);

/** Codes for a request that no longer fits the model's context window. */
const CONTEXT_ERROR_CODES = new Set(['context_length_exceeded', 'string_above_max_length', '1261']);

const WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES);

/** Whether any of these messages is the result of a tool that proposes or makes a change. */
function ranWriteTool(messages: ChatMessage[]): boolean {
    return messages.some((message) => message.role === 'tool' && WRITE_TOOLS.has(message.name));
}

/**
 * Classify a failure for the UI's error surface.
 *
 * The store shows a retry button for a retryable type and keeps the run's
 * transcript either way, so an auth failure and a dropped socket must not look
 * alike — one is worth retrying and the other never is.
 *
 * Decided from the status and the provider's error code, never from the text:
 * the text quotes the provider's body, where a token count such as 1054012
 * reads as "401". The provider's own sentence is kept as the reason, since it
 * is often the one thing that says what is actually wrong ("余额不足", "not
 * available in your region", "Unsupported parameter").
 */
export function classifyRunError(error: Error): RunErrorReport {
    if (!isModelRequestError(error)) {
        if (error.name === 'AbortError') {
            return { type: 'run_cancelled', message: 'Run cancelled.', is_retryable: false };
        }
        return { type: 'llm_error', message: error.message || 'The run failed.', is_retryable: true };
    }

    const who = error.label || 'The model provider';
    const reason = error.detail ? { user_facing_details: error.detail } : {};
    const status = error.status;
    const tag = status !== undefined ? ` (${status})` : '';
    const report = (type: string, message: string, extra: Partial<RunErrorReport> = {}): RunErrorReport => ({
        type,
        message,
        is_retryable: error.retryable,
        ...reason,
        ...extra,
    });

    switch (error.kind) {
        case 'cancelled':
            return { type: 'run_cancelled', message: 'Run cancelled.', is_retryable: false };
        case 'network':
            return report(
                'llm_network_error',
                `Could not reach ${who}. Check your internet connection, or the address if this is a server you run yourself.`,
            );
        case 'timeout':
            return report('llm_timeout', `${who} stopped responding. Try again in a moment.`);
        case 'stream':
            return report('llm_streaming_error', `The connection to ${who} broke off mid-reply. Try again.`);
        default:
            break;
    }

    if (status === 401) {
        return report(
            'llm_auth_error',
            `${who} rejected the API key (401). Check the key on its card under ${PROVIDER_SETTINGS}.`,
        );
    }
    if (status === 403) {
        return REGION_ERROR_CODES.has(error.code ?? '')
            ? report(
                  'llm_model_access_denied',
                  `${who} is not available in your region (403). Choose another provider under Settings → Model.`,
              )
            : report(
                  'llm_auth_error',
                  `${who} refused the request (403). The key may not have access to this model — check it on its card under ${PROVIDER_SETTINGS}.`,
              );
    }
    if (status === 402) {
        return report(
            'llm_insufficient_credits',
            `${who} says the account is out of credit (402). Top it up with the provider, or choose another model under Settings → Model.`,
        );
    }
    if (isQuotaErrorCode(error.code)) {
        return report(
            'llm_quota_exceeded',
            `${who} says the quota or balance is used up${tag}. Top it up or wait for it to reset, or choose another model under Settings → Model.`,
        );
    }
    if (status === 429) {
        return report('llm_rate_limit', `${who} is limiting how fast requests can be sent (429). Wait a moment, then retry.`, {
            ...(error.retryAfterMs !== undefined ? { retry_after: Math.ceil(error.retryAfterMs / 1000) } : {}),
        });
    }
    if (status === 404 || error.code === 'model_not_found') {
        return report(
            'llm_invalid_model',
            `${who} could not find the model or the endpoint${tag}. Check the model name, and the address if you set one, under ${PROVIDER_SETTINGS}.`,
        );
    }
    if (status === 413 || CONTEXT_ERROR_CODES.has(error.code ?? '')) {
        return report(
            'llm_context_window_exceeded',
            `This conversation is too long for the model${tag}. Start a new chat, or ask about fewer papers at once.`,
        );
    }
    if (status === 408 || status === 504) {
        return report('llm_timeout', `${who} took too long to answer${tag}. Try again in a moment.`);
    }
    if (status !== undefined && status >= 500) {
        return report('llm_service_unavailable', `${who} had a server problem${tag}. Try again in a moment.`);
    }
    if (status !== undefined && status >= 400) {
        return report('invalid_request', `${who} rejected the request${tag}.`);
    }
    // Reported inside a 200: an upstream failure mid-reply, or a body that
    // explains why the request was refused. Without a sentence from the
    // provider, the error's own text is the specific part: an empty response,
    // a missing body, the finish reason the reply ended with.
    const specific = error.detail ? {} : { user_facing_details: error.message };
    return error.retryable
        ? report('llm_service_unavailable', `${who} could not finish the reply. Try again in a moment.`, specific)
        : report('invalid_request', `${who} returned an error instead of a reply.`, specific);
}

/**
 * Drive one agent run, emitting the events the chat UI expects.
 *
 * A failure is reported through `onError` and the run still closes with
 * `onDone`, because a panel left with a spinner and no terminal event is worse
 * than a visible error. `onDone` fires exactly once. A stopped run reports
 * nothing after the stop except that `onDone`: the UI has already moved on,
 * and a late part or error would land in whatever run is showing now.
 */
export async function runLocalAgent(options: LocalRunOptions): Promise<AgentLoopResult> {
    const {
        runId,
        threadId,
        messages,
        provider,
        tools = [],
        dispatch,
        callbacks,
        maxIterations,
        outputTokenLimit,
        signal,
        warnings = [],
        embeddingFailureSince,
        retry,
    } = options;

    const startedAt = Date.now();
    // One warning per run at most: a model that retries a failing search
    // three times has still hit one problem.
    let warnedEmbedding = false;

    const cursor = new PartCursor();
    // Tool call ids are needed again when the result comes back, and the loop
    // reports the result by id but not the name.
    const toolNameById = new Map<string, string>();
    // Where each call's part landed, so `tool_exec` can rewrite that same part
    // with the parsed args once they exist. Both coordinates are needed — the
    // cursor has usually moved on to a later message by then.
    const toolPartById = new Map<string, { messageIndex: number; partIndex: number }>();
    // Each call's arguments as streamed so far, how much of them the last
    // preview read, and that preview, so an unchanged one is not sent again.
    const argsById = new Map<string, { json: string; preview: string; parsedLength: number }>();
    let sawFirstIteration = false;

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        callbacks.onDone();
    };
    const stopped = () => closed || signal?.aborted === true;

    // A run stopped before it began announces nothing: by now the reader may
    // be in another thread, which a late `onThread` would switch back.
    if (!stopped()) {
        callbacks.onThread(threadId);
        // The UI gates the composer on readiness. There is no handshake to wait
        // for locally, so it is ready immediately; the fields describe a client
        // that owns its own processing and has no subscription.
        callbacks.onReady({
            subscriptionStatus: 'inactive',
            processingMode: 'frontend',
            indexingComplete: true,
        });

        for (const warning of warnings) {
            callbacks.onWarning?.({
                event: 'warning',
                run_id: runId,
                type: warning.type,
                message: warning.message,
            });
        }
    }

    // Accumulated across chunks: the store replaces a part's content by index
    // rather than appending, so each frame carries the whole run so far.
    let textBuffer = '';
    let thinkingBuffer = '';

    const emitPart = (
        part: Record<string, unknown>,
        partIndex: number,
        messageIndex: number = cursor.messageIndex,
    ) => {
        void callbacks.onPart({
            event: 'part',
            run_id: runId,
            message_index: messageIndex,
            part_index: partIndex,
            part,
        });
    };

    const onEvent = (event: LoopEvent) => {
        if (stopped()) return;
        switch (event.type) {
            case 'iteration':
                // `message_index` is a direct array index into the run's
                // model_messages (see ensureModelResponse), so it is 0-based:
                // starting at 1 leaves an empty message at position 0.
                if (sawFirstIteration) cursor.newMessage();
                else {
                    cursor.messageIndex = 0;
                    sawFirstIteration = true;
                }
                // Each turn is its own message, so its text starts from
                // nothing — even when the previous turn's tool call was never
                // announced and so never reset the buffers.
                textBuffer = '';
                thinkingBuffer = '';
                break;

            case 'retry': {
                // The attempt that failed showed no text and no tool call, but
                // may have streamed thinking. Blank what it wrote so the next
                // attempt starts on a clean message rather than appending its
                // own thinking to the abandoned one.
                for (const index of cursor.restartMessage()) {
                    emitPart({ part_kind: 'text', content: '' }, index);
                }
                textBuffer = '';
                thinkingBuffer = '';
                callbacks.onRetry?.({
                    event: 'retry',
                    run_id: runId,
                    attempt: event.attempt,
                    max_attempts: event.maxAttempts,
                    reason: event.reason,
                    wait_seconds: Math.ceil(event.waitMs / 1000),
                    // Never true here: the UI's reset empties the whole run,
                    // and the earlier steps of this run are still valid.
                    reset: false,
                });
                break;
            }

            case 'text': {
                const { index } = cursor.textIndex();
                // The whole accumulated run is re-sent, not just the delta: the
                // store replaces a part's content by index rather than appending.
                textBuffer += event.text;
                emitPart({ part_kind: 'text', content: textBuffer }, index);
                break;
            }

            case 'reasoning': {
                const { index } = cursor.thinkingIndex();
                thinkingBuffer += event.text;
                emitPart({ part_kind: 'thinking', content: thinkingBuffer }, index);
                break;
            }

            case 'tool_start': {
                toolNameById.set(event.id, event.name);
                const partIndex = cursor.discreteIndex();
                toolPartById.set(event.id, { messageIndex: cursor.messageIndex, partIndex });
                emitPart(
                    {
                        part_kind: 'tool-call',
                        tool_name: event.name,
                        tool_call_id: event.id,
                        args: null,
                    },
                    partIndex,
                );
                // Text after a tool call belongs to a fresh part.
                textBuffer = '';
                thinkingBuffer = '';
                break;
            }

            case 'tool_exec': {
                /*
                 * The same part again, now with its arguments. Until this
                 * landed, `args` stayed null for the part's whole life — the
                 * live label leaned on the streamed preview and looked fine,
                 * and then persistence faithfully saved the null, so every
                 * reopened conversation showed "Item search" six times with no
                 * trace of what was searched.
                 */
                argsById.delete(event.id);
                const at = toolPartById.get(event.id);
                if (!at) break;
                emitPart(
                    {
                        part_kind: 'tool-call',
                        tool_name: event.name,
                        tool_call_id: event.id,
                        args: event.args,
                    },
                    at.partIndex,
                    at.messageIndex,
                );
                break;
            }

            case 'tool_args': {
                // Live argument preview. The store replaces the preview with
                // each event and renders it as a value, so what is sent is the
                // arguments received so far, parsed as far as they go — a note
                // preview shows its title and its content growing, not the
                // last few characters of the stream.
                const entry = argsById.get(event.id) ?? { json: '', preview: '', parsedLength: 0 };
                entry.json += event.delta;
                argsById.set(event.id, entry);
                // Each parse reads the whole buffer, so a long note is not
                // re-read on every token; the final arguments arrive with
                // `tool_exec` regardless.
                const step = Math.max(1, Math.floor(entry.json.length / PREVIEW_GROWTH_STEPS));
                if (entry.json.length - entry.parsedLength < step) break;
                entry.parsedLength = entry.json.length;
                const partial = parsePartialToolArguments(entry.json);
                if (!partial || Object.keys(partial).length === 0) break;
                const preview = JSON.stringify(partial);
                if (preview === entry.preview) break;
                entry.preview = preview;
                callbacks.onToolCallArgsStream({
                    event: 'tool_call_args_stream',
                    run_id: runId,
                    tool_call_id: event.id,
                    tool_name: toolNameById.get(event.id) ?? 'unknown',
                    args: partial,
                });
                break;
            }

            case 'tool_result': {
                void callbacks.onToolReturn({
                    event: 'tool_return',
                    run_id: runId,
                    message_index: cursor.returnsMessageIndex(),
                    part: {
                        part_kind: 'tool-return',
                        tool_name: event.name,
                        tool_call_id: event.id,
                        content: event.summary,
                        outcome: event.ok ? 'success' : 'error',
                    },
                });
                if (!warnedEmbedding && embeddingFailureSince && EMBEDDING_TOOLS.has(event.name)) {
                    const reason = embeddingFailureSince(startedAt);
                    if (reason) {
                        warnedEmbedding = true;
                        callbacks.onWarning?.({
                            event: 'warning',
                            run_id: runId,
                            type: 'semantic_search_failed',
                            message: `Topic search could not run: ${reason} Keyword and metadata search still `
                                + 'work, so the answer may miss papers that use other words.',
                        });
                    }
                }
                break;
            }

            case 'failed':
            case 'finished':
                // Terminal handling belongs after the loop resolves, where the
                // full result is available.
                break;
        }
    };

    let result: AgentLoopResult;
    try {
        result = await runAgentLoop(messages, {
            provider,
            tools,
            dispatch,
            maxIterations,
            signal,
            onEvent,
            ...(retry ? { retry } : {}),
        });
    } catch (error) {
        // runAgentLoop is documented not to throw, but a terminal event is owed
        // to the UI even if that contract is ever broken.
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!stopped()) callbacks.onError({ event: 'error', run_id: runId, ...classifyRunError(failure) });
        close();
        throw failure;
    }

    // Stopped: not a failure and not a finished answer. Whoever stopped the run
    // has already recorded it as cancelled; all that is owed is the close.
    if (result.reason === 'cancelled' || stopped()) {
        close();
        return result;
    }

    if (result.error) {
        const report = classifyRunError(result.error);
        callbacks.onError({
            event: 'error',
            run_id: runId,
            details: result.error.stack,
            ...report,
            // Said outright, so nobody presses Retry expecting something the
            // automatic retries have not already tried.
            ...(result.attempts && result.attempts > 1
                ? { message: `${report.message} (Tried ${result.attempts} times.)` }
                : {}),
        });
        close();
        return result;
    }

    if (result.reason === 'iteration_limit') {
        callbacks.onWarning?.({
            event: 'warning',
            run_id: runId,
            type: 'iteration_limit',
            message: `Stopped after ${result.iterations} steps, the limit set under "Model requests per question" `
                + 'in Settings → Advanced. Ask it to continue, raise the limit, or ask a narrower question.',
        });
    }

    // A turn that hits the output cap can end with nothing at all: a model that
    // thinks before answering spends the same budget on thinking, so the cap
    // can arrive before it has emitted either text or a tool call. Without this
    // the run settles as `completed` and the user sees a request that did
    // nothing and said nothing — the failure looks like the agent choosing not
    // to act. The wording is about the turn that was cut off, not the run: a
    // preamble from an earlier step is not the answer being cut.
    if (result.reason === 'length') {
        const capPhrase = outputTokenLimit ? `${formatTokenCount(outputTokenLimit)}-token` : 'per-reply';
        const lastTurnText = result.lastTurnText ?? result.text;
        callbacks.onWarning?.({
            event: 'warning',
            run_id: runId,
            type: 'output_limit',
            // Named where the user can act on it: the limit is a setting now,
            // and its value is the first thing worth knowing.
            message: result.truncatedToolCall
                ? `The reply reached the ${capPhrase} output limit while writing a ${result.truncatedToolCall} call, so `
                  + ((result.truncatedTurnCalls ?? 1) > 1
                      ? `none of the ${result.truncatedTurnCalls} tool calls in that step ran. `
                      : 'that call did not run. ')
                  + 'Raise "Output tokens per reply" in Settings → Advanced, or ask for less in one go.'
                : lastTurnText.trim()
                  ? `The answer was cut off at the ${capPhrase} output limit. Ask it to continue, or raise `
                    + '"Output tokens per reply" in Settings → Advanced.'
                  : `The model spent its whole ${capPhrase} output budget thinking, before it could answer or use `
                    + 'a tool. Raise "Output tokens per reply" in Settings → Advanced, or lower the thinking effort.',
        });
    }

    // Finished without a word: the reply is blank and nothing else says why. A
    // write the model proposed or made is output in its own right, its card on
    // screen, and asking again would only propose it twice.
    if (
        result.reason === 'completed'
        && !result.text.trim()
        && !ranWriteTool(result.messages.slice(messages.length))
    ) {
        callbacks.onWarning?.({
            event: 'warning',
            run_id: runId,
            type: 'empty_response',
            message: 'The model ended its turn without writing a reply. Ask again, or try another model.',
        });
    }

    if (result.reason === 'content_filter') {
        callbacks.onWarning?.({
            event: 'warning',
            run_id: runId,
            type: 'content_filter',
            message: "The provider's content filter stopped this response.",
        });
    }

    if (result.reason === 'interrupted') {
        callbacks.onWarning?.({
            event: 'warning',
            run_id: runId,
            type: 'stream_interrupted',
            message: 'The connection closed before the model finished, so this answer may be incomplete. '
                + 'Ask it to continue, or retry.',
        });
    }

    void callbacks.onRunComplete({
        event: 'run_complete',
        run_id: runId,
        // Token usage is the provider's own count, summed across the run's
        // iterations, mapped into the shape the rest of the client already
        // reads. `cost` stays null: turning tokens into money needs a price
        // table per model, and a stale table is worse than no figure at all.
        usage: result.usage
            ? {
                  requests: result.iterations,
                  tool_calls: result.messages.filter((m) => m.role === 'tool').length,
                  input_tokens: result.usage.promptTokens,
                  cache_write_tokens: 0,
                  cache_read_tokens: result.usage.cachedTokens ?? 0,
                  input_audio_tokens: 0,
                  cache_audio_read_tokens: 0,
                  output_tokens: result.usage.completionTokens,
                  /*
                   * Per-iteration breakdown. The client's "your conversation
                   * is long" warning keys on the LAST request's input tokens
                   * — without this list it cannot tell a long conversation
                   * from a long run, and stays silent forever.
                   */
                  ...(result.perRequestUsage?.length
                      ? {
                            model_requests: result.perRequestUsage.map((u) => ({
                                input_tokens: u.promptTokens,
                                output_tokens: u.completionTokens,
                                cache_read_tokens: u.cachedTokens ?? 0,
                            })),
                        }
                      : {}),
              }
            : null,
        cost: null,
        citations: null,
        agent_actions: null,
    });
    close();

    return result;
}
