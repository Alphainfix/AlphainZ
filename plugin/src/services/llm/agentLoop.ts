/**
 * The local agent loop.
 *
 * This is the piece Beaver keeps on its server: decide, call a tool, observe,
 * repeat. Running it client-side is what removes the cloud dependency — the
 * tool executors were always local (`src/services/agentDataProvider/*`), only
 * the orchestration was remote.
 *
 * Pure orchestration: the provider and the tool dispatcher are both injected,
 * so this unit tests without a network or a Zotero instance.
 */

import { isModelRequestError, parseToolArguments, untilAborted } from './sse';
import type {
    AssistantMessage,
    ChatMessage,
    ChatProvider,
    ContentPart,
    StopReason,
    StreamEvent,
    TokenUsage,
    ToolResultMessage,
    ToolSchema,
} from './types';
import { addUsage } from './sse';
import { WRITE_TOOL_NAMES } from './writeTools';

/**
 * Executes one tool. Resolving is a success (whatever the payload); rejecting is
 * a failure the loop reports back to the model.
 */
/**
 * Runs one tool.
 *
 * `context.toolCallId` is the id of the call being executed. A tool that has to
 * address its own call needs it — the approval card is attached to a tool call
 * by id, so a tool that asks before it writes cannot ask without this.
 */
export type ToolDispatcher = (
    name: string,
    args: Record<string, unknown>,
    context: { toolCallId: string },
) => Promise<unknown>;

export type LoopEvent =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool_start'; id: string; name: string }
    | { type: 'tool_args'; id: string; delta: string }
    /*
     * The call's complete, parsed arguments, emitted once just before dispatch.
     * `tool_start` cannot carry them (they have not streamed yet) and
     * `tool_args` carries raw fragments for live preview only — so without
     * this, the run's record of every call reads `args: null` forever, and a
     * reopened conversation shows a column of bare tool names where "what did
     * it actually search for?" used to be answerable.
     */
    | { type: 'tool_exec'; id: string; name: string; args: Record<string, unknown> }
    | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
    | { type: 'iteration'; index: number }
    /*
     * The current turn's request failed before anything was shown and is
     * about to be sent again, after `waitMs`. `attempt` is the one about to
     * start, out of `maxAttempts`. Anything the failed attempt streamed was
     * thinking only, and belongs to the attempt that is being replaced.
     */
    | { type: 'retry'; attempt: number; maxAttempts: number; reason: string; waitMs: number }
    | { type: 'finished'; reason: FinishReason; text: string }
    | { type: 'failed'; error: Error };

export type FinishReason =
    | 'completed'
    | 'iteration_limit'
    | 'cancelled'
    | 'length'
    | 'content_filter'
    | 'interrupted';

export interface AgentLoopOptions {
    provider: ChatProvider;
    /** Schemas offered to the model. An empty list runs a plain chat turn. */
    tools?: ToolSchema[];
    dispatch?: ToolDispatcher;
    /**
     * Hard bound on assistant turns. Reached only by a model that keeps calling
     * tools; the run then ends as `iteration_limit` rather than spinning.
     */
    maxIterations?: number;
    /**
     * Stops the run. The request in flight is abandoned, no further tool is
     * dispatched, and the loop settles as `cancelled` without waiting for a
     * tool or a stream that ignores the signal.
     */
    signal?: AbortSignal;
    onEvent?: (event: LoopEvent) => void;
    /** Cap on a single tool result fed back to the model, in characters. */
    maxToolResultChars?: number;
    /** How a request that failed transiently is sent again. */
    retry?: RetryPolicy;
}

/**
 * Automatic retries for a model request that failed transiently — a dropped
 * connection, a 429, a 5xx, a stream cut off before it showed anything.
 *
 * Only a request whose attempt put nothing on screen is repeated: sending it
 * again after text or a tool call appeared would show the reply twice.
 */
export interface RetryPolicy {
    /** Attempts after the first. 0 turns retrying off. */
    maxRetries?: number;
    /** Wait before the first retry, doubled for each one after it. */
    baseDelayMs?: number;
    /**
     * The longest `Retry-After` honoured. A provider asking for a longer wait
     * gets the error shown instead, with its reason, rather than a spinner.
     */
    maxRetryAfterMs?: number;
}

const DEFAULT_RETRY: Required<RetryPolicy> = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    maxRetryAfterMs: 30_000,
};

/**
 * Retries allowed after a timeout. Each attempt already waited a full
 * deadline, so repeating it as often as a quick 503 would turn a dead endpoint
 * into minutes of "Retrying…".
 */
const MAX_TIMEOUT_RETRIES = 1;

export interface AgentLoopResult {
    /** Concatenated assistant prose across every iteration. */
    text: string;
    reason: FinishReason;
    /** The full transcript, including tool calls and results. */
    messages: ChatMessage[];
    iterations: number;
    error?: Error;
    /** Prose of the last assistant turn alone — what a cut-off answer is about. */
    lastTurnText?: string;
    /**
     * The tool the model was calling when its turn hit the output cap. That
     * call's arguments are cut short, so no call of that turn was run.
     */
    truncatedToolCall?: string;
    /** How many calls the cut-off turn held, the one cut short included. */
    truncatedTurnCalls?: number;
    /** Attempts the failing request took, when the run ended on an error. */
    attempts?: number;
    /**
     * What the whole run cost, summed across iterations.
     *
     * A tool-using run makes one request per iteration, and each reports its
     * own usage; the number the user cares about is what the question cost, not
     * what its last leg cost.
     */
    usage?: TokenUsage;
    /**
     * Each iteration's own usage, in order. The last entry is what the NEXT
     * message will roughly cost to send — the signal behind the "your
     * conversation is long" warning.
     */
    perRequestUsage?: TokenUsage[];
}

/**
 * How many model requests one question may make.
 *
 * Sized for the work the built-in actions ask for, not for a single answer.
 * Colour-coding a paper wants 4-8 highlights, each proposed by its own call and
 * often preceded by a search to find the passage; on 12 it ran out mid-pass,
 * having placed three. Each iteration is one billed request, so this is a
 * ceiling rather than a target — the loop stops as soon as the model answers
 * without calling a tool, which is what almost every question does in two or
 * three.
 */
const DEFAULT_MAX_ITERATIONS = 24;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 60_000;

/*
 * Search results get a much smaller budget than document reads.
 *
 * A tool result is not paid for once. It stays in the message array for every
 * later request in the run, so one 60,000-character result costs its ~17k
 * tokens again on each of them — measured at 106k–151k input tokens for a
 * three-tool library question, most of it the same search payload re-sent.
 *
 * A page of a paper is worth that; a list of search hits is not — nobody needs
 * the fortieth match, and the model has already picked from the first few by
 * the time it calls anything else. Reading keeps the large budget.
 */
const MAX_TOOL_RESULT_CHARS_BY_TOOL: Record<string, number> = {
    item_search_by_topic: 12_000,
    item_search_by_metadata: 12_000,
    search_web_literature: 12_000,
    lookup_paper: 8_000,
    find_citing_papers: 8_000,
    find_cited_papers: 8_000,
    search_in_document: 12_000,
    search_library_fulltext: 12_000,
    get_annotations: 20_000,
};

function toolResultBudget(name: string, fallback: number): number {
    return MAX_TOOL_RESULT_CHARS_BY_TOOL[name] ?? fallback;
}

/**
 * What a tool returns when its result is (or includes) images.
 *
 * A rendered PDF page is the case this exists for: the tool that rasterized the
 * page hands back the pixels, rather than a caption the model has to trust.
 * Recognised by the `kind` tag so an ordinary object result is unaffected.
 */
export interface ToolImagesResult {
    kind: 'tool-images';
    /** Accompanying text — page numbers, what was rendered, any caveat. */
    text?: string;
    images: Array<{ mimeType: string; base64: string; label?: string }>;
}

export function isToolImagesResult(value: unknown): value is ToolImagesResult {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as any).kind === 'tool-images' &&
        Array.isArray((value as any).images)
    );
}

/**
 * Build the content parts for an image-bearing tool result.
 *
 * The text part is always present, even when the tool supplied none: a result
 * that is nothing but pixels gives the model no idea what it is looking at, and
 * some endpoints reject a content array with no text part at all.
 */
export function toolImagesToContent(result: ToolImagesResult): ContentPart[] {
    const parts: ContentPart[] = [
        {
            type: 'text',
            text:
                result.text ??
                `${result.images.length} image${result.images.length === 1 ? '' : 's'} returned.`,
        },
    ];
    for (const image of result.images) {
        parts.push({
            type: 'image',
            mimeType: image.mimeType,
            base64: image.base64,
            label: image.label,
        });
    }
    return parts;
}

/** Serialize a tool result for the model, truncating a runaway payload. */
export function serializeToolResult(value: unknown, maxChars: number): string {
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else if (value === undefined) {
        text = 'null';
    } else {
        try {
            text = JSON.stringify(value) ?? 'null';
        } catch {
            // Circular or otherwise unserializable: say so rather than throwing
            // inside the loop, where it would look like a tool failure.
            text = '"[result could not be serialized]"';
        }
    }
    if (text.length <= maxChars) return text;
    // A silently clipped payload reads as complete data to the model, so the
    // truncation has to be visible in the text it receives.
    return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} characters]`;
}

/** One streamed assistant turn, collapsed into a result. */
interface Turn {
    text: string;
    stopReason: StopReason;
    toolCalls: Array<{ id: string; name: string; argumentsJson: string; extraContent?: Record<string, unknown> }>;
    error?: Error;
    usage?: TokenUsage;
    /** Responses wire: the turn's reasoning, to send back with its calls. */
    reasoningItems?: Array<Record<string, unknown>>;
    /** Whether any answer text or tool call reached the screen. */
    showedContent: boolean;
    /** The run was stopped while this turn was streaming. */
    cancelled: boolean;
}

async function runTurn(
    provider: ChatProvider,
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal | undefined,
    emit: (event: LoopEvent) => void,
): Promise<Turn> {
    let text = '';
    let stopReason: StopReason = 'end_turn';
    let toolCalls: Turn['toolCalls'] = [];
    let error: Error | undefined;
    let usage: TokenUsage | undefined;
    let reasoningItems: Turn['reasoningItems'];
    let showedContent = false;
    // tool_call events are keyed by index on the wire but by id downstream.
    const idByIndex = new Map<number, string>();

    const onStreamEvent = (event: StreamEvent) => {
        // Nothing passes once the run is stopped, even from a provider that
        // keeps streaming after the abort.
        if (signal?.aborted) return;
        switch (event.type) {
            case 'text':
                text += event.text;
                showedContent = true;
                emit({ type: 'text', text: event.text });
                break;
            case 'reasoning':
                emit({ type: 'reasoning', text: event.text });
                break;
            case 'tool_call_start':
                idByIndex.set(event.index, event.id);
                showedContent = true;
                emit({ type: 'tool_start', id: event.id, name: event.name });
                break;
            case 'tool_call_args': {
                const id = idByIndex.get(event.index);
                if (id) emit({ type: 'tool_args', id, delta: event.delta });
                break;
            }
            case 'done':
                stopReason = event.stopReason;
                usage = event.usage;
                reasoningItems = event.reasoningItems;
                toolCalls = event.toolCalls.map((call) => ({
                    id: call.id,
                    name: call.name,
                    argumentsJson: call.argumentsJson,
                    ...(call.extraContent ? { extraContent: call.extraContent } : {}),
                }));
                break;
            case 'error':
                error = event.error;
                break;
        }
    };

    try {
        await untilAborted(provider.stream({ messages, tools, signal }, onStreamEvent), signal);
    } catch (thrown) {
        // A provider that throws instead of emitting an error event still
        // gets its failure reported, and a stop is not a failure.
        if (!signal?.aborted) error = error ?? (thrown instanceof Error ? thrown : new Error(String(thrown)));
    }

    return {
        text,
        stopReason,
        toolCalls,
        error,
        ...(usage ? { usage } : {}),
        ...(reasoningItems?.length ? { reasoningItems } : {}),
        showedContent,
        cancelled: signal?.aborted === true,
    };
}

/**
 * Wait `ms`, or less if the run is stopped. Resolves true when the full wait
 * elapsed.
 */
function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * How long to wait before retrying a failed turn, or null when it should not be
 * retried: the failure is not transient, the attempt already showed something,
 * the retries are spent, or the provider asked for a longer wait than is worth
 * sitting through.
 */
function retryDelay(turn: Turn, retriesSoFar: number, policy: Required<RetryPolicy>): number | null {
    const error = turn.error;
    if (!isModelRequestError(error) || !error.retryable) return null;
    if (turn.showedContent) return null;
    const limit = error.kind === 'timeout' ? Math.min(MAX_TIMEOUT_RETRIES, policy.maxRetries) : policy.maxRetries;
    if (retriesSoFar >= limit) return null;
    if (error.retryAfterMs !== undefined) {
        return error.retryAfterMs > policy.maxRetryAfterMs ? null : Math.max(0, error.retryAfterMs);
    }
    // A little jitter, so parallel clients that failed together do not all
    // come back in the same instant.
    return Math.round(policy.baseDelayMs * 2 ** retriesSoFar * (1 + Math.random() * 0.2));
}

/** Run one turn, sending it again while it fails transiently. */
async function runTurnWithRetries(
    provider: ChatProvider,
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal: AbortSignal | undefined,
    emit: (event: LoopEvent) => void,
    policy: Required<RetryPolicy>,
): Promise<{ turn: Turn; attempts: number }> {
    for (let attempt = 1; ; attempt += 1) {
        const turn = await runTurn(provider, messages, tools, signal, emit);
        if (!turn.error || turn.cancelled) return { turn, attempts: attempt };

        const wait = retryDelay(turn, attempt - 1, policy);
        if (wait === null) return { turn, attempts: attempt };

        emit({
            type: 'retry',
            attempt: attempt + 1,
            maxAttempts: policy.maxRetries + 1,
            reason: turn.error.message,
            waitMs: wait,
        });
        if (!(await pause(wait, signal))) {
            return { turn: { ...turn, error: undefined, cancelled: true }, attempts: attempt };
        }
    }
}

/**
 * Run the loop to completion.
 *
 * Never throws: every failure resolves as a result carrying `error`, because a
 * half-finished run still holds a transcript worth keeping.
 */
export async function runAgentLoop(
    initialMessages: ChatMessage[],
    options: AgentLoopOptions,
): Promise<AgentLoopResult> {
    const {
        provider,
        tools = [],
        dispatch,
        maxIterations = DEFAULT_MAX_ITERATIONS,
        signal,
        onEvent,
        maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
    } = options;
    const retryPolicy: Required<RetryPolicy> = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };

    const emit = (event: LoopEvent) => onEvent?.(event);
    const messages: ChatMessage[] = [...initialMessages];
    const collected: string[] = [];
    let iterations = 0;
    let usage: TokenUsage | undefined;
    const perRequestUsage: TokenUsage[] = [];
    let lastTurnText = '';
    let truncatedToolCall: string | undefined;
    let truncatedTurnCalls = 0;

    const settle = (reason: FinishReason, error?: Error, attempts?: number): AgentLoopResult => {
        const text = collected.join('');
        if (error) emit({ type: 'failed', error });
        else emit({ type: 'finished', reason, text });
        return {
            text, reason, messages, iterations, error,
            lastTurnText,
            ...(truncatedToolCall ? { truncatedToolCall, truncatedTurnCalls } : {}),
            ...(error && attempts ? { attempts } : {}),
            ...(usage ? { usage } : {}),
            ...(perRequestUsage.length ? { perRequestUsage } : {}),
        };
    };

    while (iterations < maxIterations) {
        if (signal?.aborted) return settle('cancelled');

        iterations += 1;
        emit({ type: 'iteration', index: iterations });

        const { turn, attempts } = await runTurnWithRetries(
            provider, messages, tools, signal, emit, retryPolicy,
        );
        // Summed, not replaced: a tool-using run makes one request per
        // iteration and the user is billed for all of them.
        if (turn.usage) {
            usage = addUsage(usage, turn.usage);
            perRequestUsage.push(turn.usage);
        }

        if (turn.text) collected.push(turn.text);
        lastTurnText = turn.text;

        // A stop is checked before the turn's error: the abort is what broke
        // the stream, and the user asked for it.
        if (turn.cancelled || signal?.aborted) {
            if (turn.text) messages.push({ role: 'assistant', content: turn.text } as AssistantMessage);
            return settle('cancelled');
        }

        if (turn.error) {
            // Keep whatever prose arrived before the break, so a stream that
            // died late is not reported as an empty answer.
            if (turn.text) {
                messages.push({ role: 'assistant', content: turn.text } as AssistantMessage);
            }
            return settle('completed', turn.error, attempts);
        }

        /*
         * Calls end a turn whatever finish reason came with them — some
         * compatible servers send `stop` after a tool call, and ending the run
         * there would leave the call unrun. The exceptions are a turn cut off
         * by the output cap, whose last call's arguments are incomplete, and
         * one stopped by the content filter.
         */
        const cutShort = turn.stopReason === 'length' || turn.stopReason === 'content_filter';
        if (turn.toolCalls.length === 0 || cutShort) {
            messages.push({ role: 'assistant', content: turn.text } as AssistantMessage);
            if (turn.stopReason === 'length') {
                truncatedToolCall = turn.toolCalls[turn.toolCalls.length - 1]?.name;
                truncatedTurnCalls = turn.toolCalls.length;
                return settle('length');
            }
            if (turn.stopReason === 'content_filter') return settle('content_filter');
            if (turn.stopReason === 'interrupted') return settle('interrupted');
            return settle('completed');
        }

        // The assistant turn must be recorded before its results: the wire
        // format requires each `tool` message to follow the assistant message
        // that requested it. Its reasoning, where the provider returned it,
        // goes with it to the next request.
        messages.push({
            role: 'assistant',
            content: turn.text,
            toolCalls: turn.toolCalls,
            ...(turn.reasoningItems ? { reasoningItems: turn.reasoningItems } : {}),
        } as AssistantMessage);

        for (const call of turn.toolCalls) {
            // Checked before every call, not once per turn: a stop between
            // two calls must keep the second from running at all.
            if (signal?.aborted) return settle('cancelled');
            // Parsed here *and* in executeOne: the duplication is two lines and
            // keeps executeOne's failure text (which the model reads) intact.
            const parsedArgs = parseToolArguments(call.argumentsJson);
            if (parsedArgs.ok) {
                emit({ type: 'tool_exec', id: call.id, name: call.name, args: parsedArgs.value });
            }
            // Every call needs a matching result even when it fails: the next
            // request is rejected outright if any tool_call_id goes unanswered.
            const result = await executeOne(call, dispatch, maxToolResultChars, signal);
            if (!result) return settle('cancelled');
            messages.push(result.message);
            emit({
                type: 'tool_result',
                id: call.id,
                name: call.name,
                ok: result.ok,
                summary: result.summary,
            });
        }

        if (signal?.aborted) return settle('cancelled');

        if (endsWithSuggestions(turn.toolCalls)) return settle('completed');
    }

    return settle('iteration_limit');
}

/** The tool that puts follow-up chips under a finished answer. */
const SUGGESTIONS_TOOL = 'return_suggestions';

/** Calls whose result the model does not need to read before it is done. */
const NO_FOLLOW_UP_TOOLS = new Set<string>([SUGGESTIONS_TOOL, ...WRITE_TOOL_NAMES]);

/**
 * Whether a turn that called `return_suggestions` ends the run.
 *
 * The prompt tells the model to call it last, and it has nothing to report
 * back — the chips are already on screen. Looping anyway bought a whole extra
 * request whose only job was to produce a sign-off, and a model that did not
 * want to sign off restated its entire answer instead: the transcript showed
 * the same answer twice, because it had genuinely been generated twice.
 *
 * That holds when everything else in the batch is a write, whose proposal card
 * is its own output. A read in the same batch is different: the model has not
 * seen what it asked for, so it gets another turn to use it.
 */
function endsWithSuggestions(calls: Array<{ name: string }>): boolean {
    return (
        calls.some((call) => call.name === SUGGESTIONS_TOOL)
        && calls.every((call) => NO_FOLLOW_UP_TOOLS.has(call.name))
    );
}

/** Longest a summary line may be before it stops being a line. */
const SUMMARY_MAX_CHARS = 120;

function clip(text: string, max = 90): string {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

/**
 * One readable line describing what a tool call did.
 *
 * This was the literal string `'ok'` for every successful call, and the
 * transcript renders it: approving a highlight replaced a card that named the
 * passage, the page and the colour with the word "ok". The user had just agreed
 * to something, and the record of what they agreed to said nothing.
 *
 * Everything needed is already in the result the tool returned — the sentence,
 * the page, the locator, the field names. Written for the reader, not the
 * model: the model gets the full JSON either way.
 */
export function summarizeToolResult(name: string, value: unknown): string {
    if (value === null || value === undefined) return 'done';
    if (typeof value === 'string') return clip(value, SUMMARY_MAX_CHARS) || 'done';
    if (typeof value !== 'object') return String(value);

    const v = value as Record<string, any>;

    // A mark on a page: the passage is the whole point of the record.
    if (typeof v.page === 'number' && typeof v.text === 'string') {
        const where = v.placed_by ? `p.${v.page} \u00b7 ${v.placed_by}` : `p.${v.page}`;
        return clip(`${where} \u00b7 \u201c${v.text}\u201d`, SUMMARY_MAX_CHARS);
    }
    if (typeof v.page === 'number' && typeof v.comment === 'string') {
        return clip(`p.${v.page} \u00b7 \u201c${v.comment}\u201d`, SUMMARY_MAX_CHARS);
    }

    if (Array.isArray(v.papers)) {
        const titles = v.papers.map((p: any) => p?.title).filter(Boolean);
        return clip(titles.length ? titles.join('; ') : `${v.papers.length} paper(s)`, SUMMARY_MAX_CHARS);
    }
    if (Array.isArray(v.fields) && v.fields.length) {
        return clip(`fields: ${v.fields.join(', ')}`, SUMMARY_MAX_CHARS);
    }
    if (typeof v.annotations === 'number') {
        const changed = v.changes ? ` \u00b7 ${Object.keys(v.changes).join(', ')}` : '';
        return clip(`${v.annotations} annotation(s)${changed}`, SUMMARY_MAX_CHARS);
    }
    if (typeof v.operation === 'string' && v.note) {
        return clip(`${v.operation} on ${v.note}`, SUMMARY_MAX_CHARS);
    }
    if (typeof v.name === 'string' && typeof v.items === 'number') {
        return clip(`${v.name} \u00b7 ${v.items} item(s)`, SUMMARY_MAX_CHARS);
    }
    if (typeof v.items === 'number') return `${v.items} item(s)`;
    if (typeof v.pages_returned === 'string') {
        const total = v.total_pages ? ` of ${v.total_pages}` : '';
        return `pages ${v.pages_returned}${total}`;
    }
    if (Array.isArray(v.matches)) return `${v.matches.length} match(es)`;
    if (Array.isArray(v.results)) return `${v.results.length} result(s)`;
    if (Array.isArray(v.items)) return `${v.items.length} item(s)`;

    // Nothing recognised: name the scalar fields rather than fall back to "ok",
    // which says less than the tool's own name already did.
    const scalars = Object.entries(v)
        .filter(([k, x]) => k !== 'note' && k !== 'citation'
            && (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'))
        .slice(0, 3)
        .map(([k, x]) => `${k}: ${clip(String(x), 40)}`);
    return scalars.length ? clip(scalars.join(' \u00b7 '), SUMMARY_MAX_CHARS) : 'done';
}

/**
 * Run one call. Resolves null when the run was stopped before or while the
 * tool ran: the loop settles at once rather than waiting on a tool that may
 * itself be waiting on the user.
 */
async function executeOne(
    call: { id: string; name: string; argumentsJson: string },
    dispatch: ToolDispatcher | undefined,
    maxChars: number,
    signal: AbortSignal | undefined,
): Promise<{ message: ToolResultMessage; ok: boolean; summary: string } | null> {
    const fail = (summary: string) => ({
        message: {
            role: 'tool' as const,
            toolCallId: call.id,
            name: call.name,
            // Phrased for the model: it should be able to correct itself from
            // this text rather than repeat the same malformed call.
            content: JSON.stringify({ error: summary }),
        },
        ok: false,
        summary,
    });

    if (signal?.aborted) return null;
    if (!dispatch) return fail(`No tool dispatcher is configured; cannot run "${call.name}".`);

    const parsed = parseToolArguments(call.argumentsJson);
    if (!parsed.ok) {
        return fail(`Arguments for "${call.name}" were not valid JSON: ${parsed.error}`);
    }

    try {
        const value = await untilAborted(
            dispatch(call.name, parsed.value, { toolCallId: call.id }),
            signal,
        );

        // Images bypass serialization entirely: base64 through JSON.stringify
        // would arrive as a quoted blob the model cannot decode, and would blow
        // the character budget on the way.
        if (isToolImagesResult(value)) {
            return {
                message: {
                    role: 'tool',
                    toolCallId: call.id,
                    name: call.name,
                    content: toolImagesToContent(value),
                },
                ok: true,
                summary: `${value.images.length} image(s)`,
            };
        }

        return {
            message: {
                role: 'tool',
                toolCallId: call.id,
                name: call.name,
                content: serializeToolResult(value, toolResultBudget(call.name, maxChars)),
            },
            ok: true,
            summary: summarizeToolResult(call.name, value),
        };
    } catch (error) {
        if (signal?.aborted) return null;
        const message = error instanceof Error ? error.message : String(error);
        return fail(`Tool "${call.name}" failed: ${message}`);
    }
}
