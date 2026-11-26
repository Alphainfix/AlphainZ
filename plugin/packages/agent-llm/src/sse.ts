/**
 * SSE stream parsing for chat APIs.
 *
 * Pure module — no Zotero globals, no DOM. Everything here is driven by a
 * `ReadableStreamDefaultReader<Uint8Array>` so it can be unit tested against a
 * hand-built stream.
 *
 * Supports the OpenAI chat-completions wire format (which DeepSeek, OpenRouter,
 * Ollama and most "OpenAI-compatible" endpoints also speak), OpenAI's
 * Responses API, and the Anthropic messages format.
 */

/**
 * - `openai`: `POST /chat/completions`, the format nearly every compatible
 *   endpoint speaks.
 * - `openai-responses`: OpenAI's `POST /responses`. Its reasoning models (gpt-5
 *   and later, the o-series) take a thinking effort together with function
 *   tools only here; on `/chat/completions` a request carrying both is a 400.
 * - `anthropic`: the messages format.
 */
export type WireFormat = 'openai' | 'openai-responses' | 'anthropic';

/**
 * Why a turn ended. `interrupted`: the stream stopped with neither a finish
 * reason nor the end-of-stream marker, so the reply may be missing its end.
 */
export type StopReason = 'end_turn' | 'tool_calls' | 'length' | 'content_filter' | 'interrupted';

/** A fully assembled tool call, ready to dispatch. */
export interface AssembledToolCall {
    index: number;
    id: string;
    name: string;
    /** Raw JSON text as streamed. Callers parse it — see `parseToolArguments`. */
    argumentsJson: string;
    /**
     * What the provider attached to the call beyond the OpenAI fields, to be
     * sent back with it unchanged: Gemini puts the model's thought signature
     * here (`{google: {thought_signature}}`) and refuses the next request of
     * the same turn without it.
     */
    extraContent?: Record<string, unknown>;
}

/** How much of a non-SSE body to keep for the error message. */
const NON_SSE_BODY_LIMIT = 2048;

// ---------------------------------------------------------------------------
// Request errors
// ---------------------------------------------------------------------------

/**
 * How a request to a model endpoint failed.
 *
 * - `http`: the endpoint answered with a non-2xx status.
 * - `network`: no response at all — offline, DNS, refused connection, TLS.
 * - `timeout`: no response, or no data mid-stream, within the deadline.
 * - `stream`: the connection broke after the reply had started.
 * - `provider`: the endpoint answered 200 but reported an error, in the body
 *   or inside the stream.
 * - `cancelled`: the caller aborted the request.
 */
export type ModelRequestErrorKind = 'http' | 'network' | 'timeout' | 'stream' | 'provider' | 'cancelled';

export interface ModelRequestErrorInit {
    kind: ModelRequestErrorKind;
    /** Who was called, e.g. "DeepSeek"; explanations name it. */
    label?: string;
    /** HTTP status, or the numeric code a provider put on an in-stream error. */
    status?: number;
    /** The provider's own error code: `insufficient_quota`, `1113`, `model_not_found`… */
    code?: string;
    /**
     * The specific reason shown under an explanation: the provider's own
     * sentence reduced to plain text, or this client's (how long it waited).
     * Never the transport's error text, which in Zotero reads "NetworkError
     * when attempting to fetch resource." whatever went wrong; that stays in
     * the message, for the logs.
     */
    detail?: string;
    /** How long the provider asked callers to wait before trying again. */
    retryAfterMs?: number;
    /**
     * Whose limit a 429 was, when the provider says: the Gemini API names the
     * free tier's quotas `…-FreeTier`. Unset when the reply does not tell.
     */
    quotaTier?: 'free' | 'paid';
    /** Overrides the verdict the kind, status and code would give. */
    retryable?: boolean;
}

/**
 * Codes meaning the account's quota or balance is spent. Waiting does not fix
 * these within a run, unlike a plain 429: OpenAI's billing codes, Zhipu's
 * "余额不足" (1113) and its daily cap (1304).
 */
const QUOTA_ERROR_CODES = new Set([
    'insufficient_quota',
    'billing_hard_limit_reached',
    'billing_not_active',
    '1113',
    '1304',
    // A day's allowance spent (the Gemini API's per-day quotas); it comes back
    // at the provider's reset, not within a run.
    'daily_quota',
]);

export function isQuotaErrorCode(code: string | undefined): boolean {
    return code !== undefined && QUOTA_ERROR_CODES.has(code);
}

/**
 * Error codes a request sent again shortly may get past: an overloaded or
 * failing server, a rate limit. Anything else — a refused parameter, a prompt
 * the model will not take — fails the same way every time.
 */
const TRANSIENT_ERROR_CODE = /server_error|rate_limit|overloaded|unavailable|timeout/i;

/** Statuses where the same request, sent again shortly, can succeed. */
export function isTransientStatus(status: number): boolean {
    return (
        status === 408
        || status === 425
        || status === 429
        || (status >= 500 && status < 600 && status !== 501 && status !== 505)
    );
}

function defaultRetryable(init: ModelRequestErrorInit): boolean {
    if (isQuotaErrorCode(init.code)) return false;
    switch (init.kind) {
        case 'cancelled':
            return false;
        case 'network':
        case 'timeout':
        case 'stream':
            return true;
        case 'http':
            return init.status !== undefined && isTransientStatus(init.status);
        case 'provider':
            // An error reported inside a reply is transient unless it carries
            // a status that says otherwise: these are upstream disconnects and
            // overloaded backends far more often than anything about the request.
            return init.status === undefined || isTransientStatus(init.status);
    }
}

/**
 * A failed model request, with the facts needed to explain it.
 *
 * Explanations are built from these fields, never from the message text. The
 * message quotes the provider's body, and a body can hold anything: a token
 * count such as 1054012 contains "401", and a request id can contain "403".
 */
export class ModelRequestError extends Error {
    readonly kind: ModelRequestErrorKind;
    readonly label?: string;
    readonly status?: number;
    readonly code?: string;
    readonly detail?: string;
    readonly retryAfterMs?: number;
    readonly quotaTier?: 'free' | 'paid';
    /** Whether sending the same request again may succeed. */
    readonly retryable: boolean;

    constructor(message: string, init: ModelRequestErrorInit) {
        super(message);
        this.name = 'ModelRequestError';
        this.kind = init.kind;
        if (init.label !== undefined) this.label = init.label;
        if (init.status !== undefined) this.status = init.status;
        if (init.code !== undefined) this.code = init.code;
        if (init.detail !== undefined) this.detail = init.detail;
        if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
        if (init.quotaTier !== undefined) this.quotaTier = init.quotaTier;
        this.retryable = init.retryable ?? defaultRetryable(init);
    }
}

/**
 * Whether `error` is a `ModelRequestError`.
 *
 * Checked by shape as well as by class: the plugin ships two bundles, each
 * with its own copy of this module, and an error can cross between them.
 */
export function isModelRequestError(error: unknown): error is ModelRequestError {
    if (error instanceof ModelRequestError) return true;
    const candidate = error as Partial<ModelRequestError> | null;
    return (
        typeof candidate === 'object'
        && candidate !== null
        && candidate.name === 'ModelRequestError'
        && typeof candidate.kind === 'string'
        && typeof candidate.retryable === 'boolean'
    );
}

function clipText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stringCode(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function httpLikeStatus(value: unknown): number | undefined {
    const status = typeof value === 'string' && /^\d{3}$/.test(value.trim()) ? Number(value) : value;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600
        ? status
        : undefined;
}

/**
 * The `detail` of a FastAPI error body: a sentence, or for a request that
 * failed validation a list of `{loc, msg}` naming each field at fault.
 */
function fastApiDetail(detail: unknown): string | undefined {
    if (typeof detail === 'string') return detail;
    if (!Array.isArray(detail)) return undefined;
    const problems = detail
        .map((entry) => {
            if (typeof entry === 'string') return entry;
            const msg = typeof entry?.msg === 'string' ? entry.msg.trim() : '';
            const loc = Array.isArray(entry?.loc) ? entry.loc.filter((part: unknown) => part !== 'body').join('.') : '';
            return msg && loc ? `${loc}: ${msg}` : msg;
        })
        .filter((problem) => typeof problem === 'string' && problem.trim());
    return problems.length ? problems.join('; ') : undefined;
}

/**
 * The useful parts of a provider's error object, in any of the shapes seen:
 * OpenAI's `{error: {message, code}}` (DeepSeek, Zhipu and OpenRouter follow
 * it, OpenRouter with a numeric code), a bare `{message}`, the
 * `{fault: {faultstring, detail: {errorcode}}}` some API gateways return, and
 * the `{detail}` of servers built on FastAPI.
 */
export function describeErrorObject(parsed: unknown): { detail?: string; code?: string; status?: number } {
    // Gemini's OpenAI-compatible layer sends its error object in a one-element array.
    if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
    if (!parsed || typeof parsed !== 'object') return {};
    const root = parsed as Record<string, any>;
    const error = (root.error && typeof root.error === 'object' ? root.error : null)
        ?? (root.fault && typeof root.fault === 'object' ? root.fault : null)
        ?? root;
    const message = [
        error.message,
        error.faultstring,
        root.message,
        typeof root.error === 'string' ? root.error : undefined,
        fastApiDetail(root.detail),
    ].find((value) => typeof value === 'string' && value.trim());
    /*
     * Google refuses a key it does not know with 400 INVALID_ARGUMENT, not
     * 401: the Gemini API says so in an ErrorInfo reason, its OpenAI-compatible
     * layer (which drops the details) only in its sentence. Read as 401, it is
     * explained as a rejected key and pauses an index instead of failing every
     * document in turn.
     */
    const reasons = Array.isArray(error.details) ? error.details.map((d: any) => d?.reason) : [];
    const keyRefused = reasons.includes('API_KEY_INVALID')
        || (error.status === 'INVALID_ARGUMENT' && typeof message === 'string' && /\bvalid API key\b/i.test(message));
    const code = keyRefused
        ? 'invalid_api_key'
        : stringCode(error.code) ?? stringCode(error.detail?.errorcode) ?? stringCode(root.code);
    const status = keyRefused
        ? 401
        : httpLikeStatus(error.code) ?? httpLikeStatus(error.status) ?? httpLikeStatus(root.status);
    return {
        ...(typeof message === 'string' ? { detail: clipText(message.replace(/\s+/g, ' ').trim(), 400) } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(status !== undefined ? { status } : {}),
    };
}

/**
 * Reduce an error response body to something fit to show a person.
 *
 * JSON bodies yield the provider's own sentence and code. An HTML error page is
 * cut down to its title: the markup itself means nothing to a reader.
 */
export function describeErrorBody(raw: string): { detail?: string; code?: string; status?: number } {
    const text = raw.trim();
    if (!text) return {};
    try {
        return describeErrorObject(JSON.parse(text));
    } catch {
        // Not JSON.
    }
    if (/^</.test(text) || /<html[\s>]/i.test(text)) {
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
        const plain = (title ?? text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();
        return plain ? { detail: clipText(plain, 200) } : {};
    }
    return { detail: clipText(text.replace(/\s+/g, ' '), 300) };
}

/**
 * Explain a 200 response whose body was never an event stream.
 *
 * An API gateway was seen to answer an invalid model with HTTP 200,
 * `content-type: text/event-stream`, and a plain JSON error object — no frames
 * at all. Read as a stream that simply produced nothing, that becomes a blank
 * answer with no error anywhere, so the body has to be surfaced instead.
 */
function nonSseBodyError(raw: string, label: string | undefined): ModelRequestError {
    const text = raw.trim();
    if (!text) {
        return new ModelRequestError(
            'The endpoint returned an empty response instead of a completion stream.',
            { kind: 'provider', label },
        );
    }
    const described = describeErrorBody(text);
    let isJson = false;
    try {
        JSON.parse(text);
        isJson = true;
    } catch {
        // Not JSON.
    }
    const message = isJson && described.detail
        ? described.detail
        : `The endpoint returned a non-streaming response: ${text.slice(0, 300)}`;
    return new ModelRequestError(message, {
        kind: 'provider',
        label,
        ...described,
        // A body that states why the request was refused is refused again on
        // a second try, unless what it carries is transient: a status such as
        // 503, or a code such as `server_error`.
        retryable: (described.status !== undefined && isTransientStatus(described.status))
            || (!isQuotaErrorCode(described.code) && TRANSIENT_ERROR_CODE.test(described.code ?? '')),
    });
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

function abortError(): Error {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

/** A wait as a person would say it: in seconds up to two minutes, in minutes after. */
export function describeWait(ms: number): string {
    return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * Settle with `promise`, or reject with an AbortError as soon as `signal`
 * aborts — whether or not whatever produced the promise honours the signal.
 *
 * A late rejection from the abandoned promise is swallowed, so walking away
 * from it cannot surface as an unhandled rejection.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.reject(abortError());
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * An AbortController that also aborts when `parent` does, plus a way to
 * detach from the parent once the work is over.
 */
export function childAbortController(parent: AbortSignal | undefined): {
    controller: AbortController;
    release: () => void;
} {
    const controller = new AbortController();
    if (!parent) return { controller, release: () => undefined };
    const forward = () => controller.abort();
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', forward, { once: true });
    return { controller, release: () => parent.removeEventListener('abort', forward) };
}

/**
 * What one request cost, as the provider counted it.
 *
 * Taken from the provider rather than estimated: an estimate that is close is
 * still a number the user cannot reconcile with their bill, and the whole point
 * of showing it is that they are spending their own money.
 */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Prompt tokens served from the provider's cache, when it reports them. */
    cachedTokens?: number;
}

/** Add two usage reports together. */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
    if (!a) return b;
    const cached = (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0);
    return {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens,
        ...(cached > 0 ? { cachedTokens: cached } : {}),
    };
}

export type StreamEvent =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool_call_start'; index: number; id: string; name: string }
    | { type: 'tool_call_args'; index: number; delta: string }
    | {
        type: 'done';
        stopReason: StopReason;
        toolCalls: AssembledToolCall[];
        usage?: TokenUsage;
        /**
         * Responses wire: the turn's reasoning items, encrypted, to be sent
         * back with it on the next request of the same run.
         */
        reasoningItems?: Array<Record<string, unknown>>;
    }
    | { type: 'error'; error: Error };

// ---------------------------------------------------------------------------
// Tool call assembly
// ---------------------------------------------------------------------------

interface PartialToolCall {
    index: number;
    id: string;
    name: string;
    argumentsJson: string;
    announced: boolean;
    extraContent?: Record<string, unknown>;
}

/**
 * Accumulates streamed tool-call fragments into whole calls.
 *
 * The OpenAI wire format spreads one tool call over many chunks and makes no
 * promise about which chunk carries which field: `id` and `function.name` often
 * arrive together in the first chunk, but several OpenAI-compatible providers
 * split them across chunks, and a few repeat `id` on every chunk. Requiring
 * both fields in a *single* chunk therefore silently drops the call. So keep
 * per-index state and announce the call the moment both fields are known,
 * wherever they came from. A call whose `id` never arrives is announced when
 * the stream ends (`announceRemaining`), under the id `finalize` gives it.
 */
export class ToolCallAssembler {
    private readonly byIndex = new Map<number, PartialToolCall>();
    /**
     * Keeps synthesised ids unique across turns: the UI and the replayed
     * history both key tool results by id, so two turns that each made an
     * id-less first call must not both call it `call_0`.
     */
    private readonly idSuffix = Math.random().toString(36).slice(2, 10);

    private slot(index: number): PartialToolCall {
        let slot = this.byIndex.get(index);
        if (!slot) {
            slot = { index, id: '', name: '', argumentsJson: '', announced: false };
            this.byIndex.set(index, slot);
        }
        return slot;
    }

    private idFor(slot: PartialToolCall): string {
        return slot.id || `call_${slot.index}_${this.idSuffix}`;
    }

    /**
     * Fold one fragment in. Returns the events it produced: at most one
     * `tool_call_start` (the first time the call is fully identified) plus one
     * `tool_call_args` per argument fragment.
     */
    ingest(fragment: {
        index: number;
        id?: string | null;
        name?: string | null;
        argumentsDelta?: string | null;
        extraContent?: unknown;
    }): StreamEvent[] {
        const slot = this.slot(fragment.index);
        const events: StreamEvent[] = [];

        if (fragment.extraContent && typeof fragment.extraContent === 'object' && !Array.isArray(fragment.extraContent)) {
            slot.extraContent = fragment.extraContent as Record<string, unknown>;
        }

        // Once announced, the id is what the UI and the loop know the call by,
        // so a provider that sends a different id later cannot split it in two.
        if (fragment.id && !slot.announced) slot.id = fragment.id;
        if (fragment.name) {
            // Most providers send the name once. Some repeat the whole name on
            // every chunk, and some re-send it growing; appending either would
            // produce "read_documentread_document". A fragment that is not a
            // repeat or an extension of the name so far is the next piece of
            // a name split across chunks.
            if (!slot.name || fragment.name.startsWith(slot.name)) slot.name = fragment.name;
            else slot.name += fragment.name;
        }

        if (!slot.announced && slot.id && slot.name) {
            slot.announced = true;
            events.push({
                type: 'tool_call_start',
                index: slot.index,
                id: slot.id,
                name: slot.name,
            });
        }

        if (fragment.argumentsDelta) {
            slot.argumentsJson += fragment.argumentsDelta;
            events.push({
                type: 'tool_call_args',
                index: slot.index,
                delta: fragment.argumentsDelta,
            });
        }

        return events;
    }

    /**
     * Take a call's complete arguments, once the provider states them whole.
     * What streamed is normally a prefix of them, and only the missing tail is
     * emitted; arguments that disagree with what streamed replace it, since
     * the whole is what the provider will expect back.
     */
    settle(index: number, full: string): StreamEvent[] {
        const slot = this.slot(index);
        if (full === slot.argumentsJson) return [];
        if (!full.startsWith(slot.argumentsJson)) {
            slot.argumentsJson = full;
            return [];
        }
        const delta = full.slice(slot.argumentsJson.length);
        slot.argumentsJson = full;
        return [{ type: 'tool_call_args', index: slot.index, delta }];
    }

    /**
     * Announce every named call that has not been announced yet — the ones
     * whose provider never sent an `id`. Called once the stream is over, so the
     * loop and the UI see every call it is about to run.
     */
    announceRemaining(): StreamEvent[] {
        const events: StreamEvent[] = [];
        for (const slot of [...this.byIndex.values()].sort((a, b) => a.index - b.index)) {
            if (slot.announced || !slot.name) continue;
            slot.id = this.idFor(slot);
            slot.announced = true;
            events.push({ type: 'tool_call_start', index: slot.index, id: slot.id, name: slot.name });
        }
        return events;
    }

    /**
     * The calls assembled so far, in wire order.
     *
     * A call that never received an `id` still gets one, synthesised from its
     * index: some providers omit `id` entirely on single-call turns, and the
     * follow-up request must echo *some* stable identifier back.
     */
    finalize(): AssembledToolCall[] {
        return [...this.byIndex.values()]
            .filter((slot) => slot.name !== '')
            .sort((a, b) => a.index - b.index)
            .map((slot) => ({
                index: slot.index,
                id: this.idFor(slot),
                name: slot.name,
                argumentsJson: slot.argumentsJson,
                ...(slot.extraContent ? { extraContent: slot.extraContent } : {}),
            }));
    }

    get isEmpty(): boolean {
        return this.finalize().length === 0;
    }
}

/**
 * Parse a tool call's streamed arguments.
 *
 * An empty string means "no arguments" — a zero-arg tool streams nothing at
 * all, and `JSON.parse('')` would throw. Malformed JSON is reported rather
 * than thrown so the caller can feed the model a retry prompt instead of
 * collapsing the whole run.
 */
export function parseToolArguments(
    argumentsJson: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    const trimmed = argumentsJson.trim();
    if (!trimmed) return { ok: true, value: {} };
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, error: `expected a JSON object, got ${typeof parsed}` };
        }
        return { ok: true, value: parsed as Record<string, unknown> };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** Closing brackets for a stack of open ones, innermost first. */
function closersFor(stack: string): string {
    let out = '';
    for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === '{' ? '}' : ']';
    return out;
}

function parseObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Keys whose value names something, such as `note_id` or `item_ids`. An
 * identifier cut short names a different item (`u-AB` for `u-ABCD1234`).
 */
const IDENTIFIER_KEY = /(?:^|_)(?:id|key)s?$|[a-z](?:Id|Key)s?$/;

/** The text ends partway through a number, which may still gain digits. */
const TRAILING_NUMBER = /(?:^|[\s:,[])-?\d[\d.eE+-]*$/;

/**
 * Best-effort parse of a tool call's arguments while they are still streaming.
 *
 * The live preview (a note being written, an edit being drafted) renders the
 * arguments as a value, so the prefix received so far is closed off — an open
 * string ended where it stands, open brackets closed — and whatever parses is
 * returned. A trailing key with no value yet, a dangling comma or a half-typed
 * literal is dropped back to the last complete member, and so is a value that
 * may still turn into a different one: an identifier string, or a number.
 * Prose is shown as it grows. Returns null when nothing usable has arrived.
 */
export function parsePartialToolArguments(argumentsJson: string): Record<string, unknown> | null {
    const text = argumentsJson.trimStart();
    if (!text.startsWith('{')) return null;

    let stack = '';
    // The key most recently read in each open container, by depth ('' in an
    // array), and whether the next string is a key rather than a value.
    const keys: string[] = [];
    let expectKey = false;
    let inString = false;
    let stringIsKey = false;
    let stringStart = 0;
    let escaped = false;
    // Places the text may be cut back to, each with the brackets open there:
    // just inside an opening bracket, and just before a comma.
    const cuts: Array<{ at: number; stack: string }> = [];

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') {
                inString = false;
                if (stringIsKey) keys[keys.length - 1] = text.slice(stringStart + 1, i);
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            stringIsKey = expectKey;
            stringStart = i;
            expectKey = false;
        } else if (ch === '{' || ch === '[') {
            stack += ch;
            keys.push('');
            expectKey = ch === '{';
            cuts.push({ at: i + 1, stack });
        } else if (ch === '}' || ch === ']') {
            stack = stack.slice(0, -1);
            keys.pop();
            expectKey = false;
            // The object is complete; anything after it is not ours to read.
            if (!stack) return parseObject(text.slice(0, i + 1));
        } else if (ch === ',') {
            expectKey = stack.endsWith('{');
            cuts.push({ at: i, stack });
        } else if (ch === ':') {
            expectKey = false;
        }
    }

    // The key a value belongs to: an array's elements belong to the key the
    // array sits under.
    const owningKey = () => {
        for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
            if (stack[depth] === '{') return keys[depth];
        }
        return '';
    };
    const stillGrowing = inString
        ? !stringIsKey && IDENTIFIER_KEY.test(owningKey())
        : TRAILING_NUMBER.test(text);

    if (!stillGrowing) {
        // The text as it stands, an open string closed where it was cut off.
        // An escape sequence cut in half is dropped rather than closed into
        // garbage: a lone backslash, or a `\u` short of its four digits. A
        // `u` after an escaped backslash (`\\u`, as in LaTeX's `\uparrow`) is
        // plain text, so only an odd run of backslashes starts an escape.
        let whole = text;
        if (inString) {
            if (escaped) whole = whole.slice(0, -1);
            else {
                const unicode = /(\\+)u[0-9a-fA-F]{0,3}$/.exec(whole);
                if (unicode && unicode[1].length % 2 === 1) {
                    whole = whole.slice(0, unicode.index + unicode[1].length - 1);
                }
            }
            whole += '"';
        }
        const direct = parseObject(whole + closersFor(stack));
        if (direct) return direct;
    }

    for (let i = cuts.length - 1; i >= 0; i -= 1) {
        const cut = cuts[i];
        const parsed = parseObject(text.slice(0, cut.at) + closersFor(cut.stack));
        if (parsed) return parsed;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Wire format decoding
// ---------------------------------------------------------------------------

/**
 * Map a provider's finish reason onto ours. Beyond the standard names:
 * `function_call` is the legacy function-calling reason some servers still
 * send, `sensitive` is Zhipu's safety filter, and `refusal` is Anthropic's.
 */
function normalizeStopReason(raw: unknown): StopReason {
    switch (raw) {
        case 'tool_calls':
        case 'tool_use':
        case 'function_call':
            return 'tool_calls';
        case 'length':
        case 'max_tokens':
        case 'model_context_window_exceeded':
            return 'length';
        case 'content_filter':
        case 'sensitive':
        case 'refusal':
            return 'content_filter';
        default:
            return 'end_turn';
    }
}

/**
 * Finish reasons that mean the reply failed rather than ended: OpenRouter's
 * `error` when the upstream provider dropped out, Zhipu's `network_error`, and
 * DeepSeek's `insufficient_system_resource` when it sheds load. Reading any of
 * them as a normal stop would present a cut-off answer as a finished one.
 */
const FAILED_FINISH_REASONS = new Set(['error', 'network_error', 'insufficient_system_resource']);

/** An error a provider reported inside the stream. */
function inStreamError(
    reported: unknown,
    finishReason: unknown,
    label: string | undefined,
): ModelRequestError {
    const described = describeErrorObject(reported);
    const code = described.code ?? (typeof finishReason === 'string' ? finishReason : undefined);
    const who = label ?? 'The provider';
    return new ModelRequestError(
        described.detail
            ? `${who} reported an error mid-reply: ${described.detail}`
            : `${who} stopped the reply with an error${code ? ` (${code})` : ''}.`,
        { kind: 'provider', label, ...described, ...(code !== undefined ? { code } : {}) },
    );
}

/**
 * Pull usage off a frame, in whichever shape the provider uses: on the frame
 * itself (chat completions), or on the response a Responses-API event carries.
 */
export function readUsage(parsed: unknown): TokenUsage | undefined {
    const raw = (parsed as any)?.usage ?? (parsed as any)?.response?.usage;
    if (!raw || typeof raw !== 'object') return undefined;

    const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
    const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
    const total = Number(raw.total_tokens ?? prompt + completion);
    if (!Number.isFinite(total) || total <= 0) return undefined;

    const cached = Number(
        raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.cached_tokens ?? 0,
    );
    return {
        promptTokens: Number.isFinite(prompt) ? prompt : 0,
        completionTokens: Number.isFinite(completion) ? completion : 0,
        totalTokens: total,
        ...(Number.isFinite(cached) && cached > 0 ? { cachedTokens: cached } : {}),
    };
}

interface DecodeResult {
    events: StreamEvent[];
    /** Set when the chunk carried a terminal signal. */
    stopReason?: StopReason;
    /**
     * The reply is over: stop reading, as after `[DONE]`. A Responses stream
     * ends with an event rather than a sentinel, and a server may hold the
     * connection open after it.
     */
    terminal?: boolean;
}

function decodeOpenAIChunk(parsed: any, assembler: ToolCallAssembler, label?: string): DecodeResult {
    const choice = parsed?.choices?.[0];
    // OpenRouter reports a failure that happens after the stream started as a
    // frame carrying a top-level `error` (with `finish_reason: "error"` on its
    // choice); others send the error object alone.
    const reportedError = parsed?.error;
    if (!choice) {
        return reportedError
            ? { events: [{ type: 'error', error: inStreamError(reportedError, undefined, label) }] }
            : { events: [] };
    }

    const events: StreamEvent[] = [];
    const delta = choice.delta;

    if (delta) {
        // DeepSeek and several others put chain-of-thought on `reasoning_content`;
        // OpenRouter uses `reasoning`. Neither belongs in the answer text.
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
            events.push({ type: 'reasoning', text: reasoning });
        }
        if (typeof delta.content === 'string' && delta.content) {
            events.push({ type: 'text', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
            for (const [position, call] of delta.tool_calls.entries()) {
                // `index` is required by the spec but missing from some
                // compatible providers; fall back to array position so two
                // parallel calls in one chunk do not collapse into one slot.
                const index = typeof call?.index === 'number' ? call.index : position;
                events.push(
                    ...assembler.ingest({
                        index,
                        id: call?.id,
                        name: call?.function?.name,
                        argumentsDelta: call?.function?.arguments,
                        extraContent: call?.extra_content,
                    }),
                );
            }
        }
    }

    const finish = choice.finish_reason;
    if (reportedError || (typeof finish === 'string' && FAILED_FINISH_REASONS.has(finish))) {
        events.push({ type: 'error', error: inStreamError(reportedError, finish, label) });
        return { events };
    }
    if (finish) {
        return { events, stopReason: normalizeStopReason(finish) };
    }
    return { events };
}

function decodeAnthropicChunk(parsed: any, assembler: ToolCallAssembler, label?: string): DecodeResult {
    const type = parsed?.type;

    if (type === 'error') {
        const described = describeErrorObject(parsed);
        return {
            events: [
                {
                    type: 'error',
                    error: new ModelRequestError(described.detail || 'Anthropic stream error', {
                        kind: 'provider',
                        label,
                        ...described,
                    }),
                },
            ],
        };
    }

    if (type === 'content_block_start') {
        const block = parsed.content_block;
        if (block?.type === 'tool_use') {
            return {
                events: assembler.ingest({
                    index: parsed.index ?? 0,
                    id: block.id,
                    name: block.name,
                }),
            };
        }
        return { events: [] };
    }

    if (type === 'content_block_delta') {
        const delta = parsed.delta;
        if (delta?.type === 'text_delta' && delta.text) {
            return { events: [{ type: 'text', text: delta.text }] };
        }
        if (delta?.type === 'thinking_delta' && delta.thinking) {
            return { events: [{ type: 'reasoning', text: delta.thinking }] };
        }
        if (delta?.type === 'input_json_delta' && delta.partial_json) {
            return {
                events: assembler.ingest({
                    index: parsed.index ?? 0,
                    argumentsDelta: delta.partial_json,
                }),
            };
        }
        return { events: [] };
    }

    if (type === 'message_delta' && parsed.delta?.stop_reason) {
        return { events: [], stopReason: normalizeStopReason(parsed.delta.stop_reason) };
    }

    if (type === 'message_stop') {
        return { events: [], stopReason: 'end_turn' };
    }

    return { events: [] };
}


/** A failure a Responses stream reported: an `error` event or a failed response. */
function responsesFailure(reported: unknown, label: string | undefined): ModelRequestError {
    const described = describeErrorObject(reported);
    const who = label ?? 'The provider';
    return new ModelRequestError(
        described.detail
            ? `${who} reported an error mid-reply: ${described.detail}`
            : `${who} stopped the reply with an error${described.code ? ` (${described.code})` : ''}.`,
        {
            kind: 'provider',
            label,
            ...described,
            retryable: described.code === undefined
                || (!isQuotaErrorCode(described.code) && TRANSIENT_ERROR_CODE.test(described.code)),
        },
    );
}

/**
 * A reasoning item as the next request takes it back: its id, its summary and
 * its encrypted content. Requests are sent with `store: false`, so the server
 * keeps nothing, and an item without its encrypted content cannot be resolved
 * from the id alone — such an item is not kept.
 */
function replayableReasoning(item: any): Record<string, unknown> | null {
    if (typeof item?.id !== 'string' || typeof item.encrypted_content !== 'string' || !item.encrypted_content) {
        return null;
    }
    return {
        type: 'reasoning',
        id: item.id,
        summary: Array.isArray(item.summary) ? item.summary : [],
        encrypted_content: item.encrypted_content,
    };
}

/**
 * Decoder for OpenAI's Responses API (`POST /responses`).
 *
 * Every event names its own `type`, and every part of a reply belongs to an
 * output item addressed by `output_index`: a reasoning item, a message, or a
 * function call. Text and arguments stream as deltas; the finished item states
 * them whole, and fills in whatever its deltas missed.
 *
 * Stateful, unlike the chat-completions decoder: the finished reasoning items
 * are kept for the next request, and the text streamed per item is tracked so
 * a finished message can be checked against it.
 */
class ResponsesDecoder {
    private readonly reasoning = new Map<number, Record<string, unknown>>();
    private readonly textByItem = new Map<number, string>();
    /** The thinking part the last reasoning text came from, to break between parts. */
    private lastThinkingPart: string | null = null;

    constructor(
        private readonly assembler: ToolCallAssembler,
        private readonly label: string | undefined,
    ) {}

    /** The finished reasoning items, in output order, ready to send back. */
    reasoningItems(): Array<Record<string, unknown>> {
        return [...this.reasoning.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    }

    decode(parsed: any): DecodeResult {
        const type = typeof parsed?.type === 'string' ? parsed.type : '';
        const index = typeof parsed?.output_index === 'number' ? parsed.output_index : 0;
        switch (type) {
            case 'response.output_item.added':
                return {
                    events: parsed.item?.type === 'function_call'
                        ? this.assembler.ingest({
                            index,
                            id: parsed.item.call_id,
                            name: parsed.item.name,
                            argumentsDelta: parsed.item.arguments,
                        })
                        : [],
                };
            case 'response.function_call_arguments.delta':
                return { events: this.assembler.ingest({ index, argumentsDelta: parsed.delta }) };
            case 'response.function_call_arguments.done':
                return {
                    events: typeof parsed.arguments === 'string' ? this.assembler.settle(index, parsed.arguments) : [],
                };
            case 'response.output_text.delta':
            case 'response.refusal.delta':
                return { events: this.text(index, parsed.delta) };
            case 'response.reasoning_summary_text.delta':
                return { events: this.thinking(`${index}/summary/${parsed.summary_index ?? 0}`, parsed.delta) };
            case 'response.reasoning_text.delta':
                return { events: this.thinking(`${index}/content/${parsed.content_index ?? 0}`, parsed.delta) };
            case 'response.output_item.done':
                return { events: this.finishItem(index, parsed.item) };
            case 'response.completed':
                this.backfill(parsed.response);
                return { events: [], stopReason: 'end_turn', terminal: true };
            case 'response.incomplete': {
                this.backfill(parsed.response);
                const reason = parsed.response?.incomplete_details?.reason;
                if (reason === 'max_output_tokens') return { events: [], stopReason: 'length', terminal: true };
                if (reason === 'content_filter') return { events: [], stopReason: 'content_filter', terminal: true };
                const why = typeof reason === 'string' && reason ? reason : 'no reason given';
                const error = new ModelRequestError(
                    `${this.label ?? 'The provider'} stopped the reply early (${why}).`,
                    { kind: 'provider', label: this.label, detail: `The reply stopped early: ${why}.`, retryable: false },
                );
                return { events: [{ type: 'error', error }], terminal: true };
            }
            case 'response.failed':
                return {
                    events: [{ type: 'error', error: responsesFailure(parsed.response?.error, this.label) }],
                    terminal: true,
                };
            case 'error':
                return { events: [{ type: 'error', error: responsesFailure(parsed, this.label) }], terminal: true };
            default:
                return { events: [] };
        }
    }

    private text(index: number, delta: unknown): StreamEvent[] {
        if (typeof delta !== 'string' || !delta) return [];
        this.textByItem.set(index, (this.textByItem.get(index) ?? '') + delta);
        return [{ type: 'text', text: delta }];
    }

    private thinking(part: string, delta: unknown): StreamEvent[] {
        if (typeof delta !== 'string' || !delta) return [];
        const events: StreamEvent[] = [];
        // A summary comes in parts, each opening with its own heading; run
        // together they would read as one paragraph.
        if (this.lastThinkingPart !== null && this.lastThinkingPart !== part) {
            events.push({ type: 'reasoning', text: '\n\n' });
        }
        this.lastThinkingPart = part;
        events.push({ type: 'reasoning', text: delta });
        return events;
    }

    private finishItem(index: number, item: any): StreamEvent[] {
        switch (item?.type) {
            case 'reasoning': {
                const kept = replayableReasoning(item);
                if (kept) this.reasoning.set(index, kept);
                return [];
            }
            case 'function_call': {
                const events = this.assembler.ingest({ index, id: item.call_id, name: item.name });
                if (typeof item.arguments === 'string') events.push(...this.assembler.settle(index, item.arguments));
                return events;
            }
            case 'message': {
                const whole = (Array.isArray(item.content) ? item.content : [])
                    .map((part: any) => (part?.type === 'refusal' ? part.refusal : part?.text))
                    .filter((text: unknown): text is string => typeof text === 'string')
                    .join('');
                const streamed = this.textByItem.get(index) ?? '';
                return whole.length > streamed.length && whole.startsWith(streamed)
                    ? this.text(index, whole.slice(streamed.length))
                    : [];
            }
            default:
                return [];
        }
    }

    /**
     * Take reasoning items from the finished response itself. Some deployments
     * (Azure among them) leave the encrypted content off the item's own
     * `done` event and state it only here.
     */
    private backfill(response: any): void {
        const output = Array.isArray(response?.output) ? response.output : [];
        output.forEach((item: any, position: number) => {
            if (item?.type !== 'reasoning') return;
            const kept = replayableReasoning(item);
            if (!kept) return;
            const existing = [...this.reasoning.entries()].find(([, stored]) => stored.id === kept.id);
            this.reasoning.set(existing ? existing[0] : position, kept);
        });
    }
}

// ---------------------------------------------------------------------------
// Stream driver
// ---------------------------------------------------------------------------

/**
 * Split an SSE buffer into whole lines, returning the trailing partial line.
 *
 * Handles CRLF as well as LF: some proxies in front of OpenAI-compatible
 * endpoints rewrite line endings, and a stray `\r` would otherwise end up
 * inside the JSON payload.
 */
export function splitSseLines(buffer: string): { lines: string[]; rest: string } {
    const normalized = buffer.split('\r\n').join('\n');
    const lines = normalized.split('\n');
    const rest = lines.pop() ?? '';
    return { lines, rest };
}

export interface SseStreamOptions {
    /** Who is on the other end; errors carry it so their explanation can name it. */
    label?: string;
    /**
     * Longest silence tolerated between two reads, in ms. Any bytes count —
     * keep-alive comments included — so a provider that is queueing the
     * request or thinking out of sight but still sending keep-alives never
     * trips it. Unset means no limit.
     */
    idleTimeoutMs?: number;
    /** Aborting this ends the stream at once with a `cancelled` error. */
    signal?: AbortSignal;
}

type ReadOutcome =
    | { kind: 'chunk'; done: boolean; value?: Uint8Array }
    | { kind: 'timeout' }
    | { kind: 'aborted' };

/** One `reader.read()`, given up on after `idleMs` or when `signal` aborts. */
function readWithin(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    idleMs: number | undefined,
    signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
    return new Promise<ReadOutcome>((resolve, reject) => {
        if (signal?.aborted) {
            resolve({ kind: 'aborted' });
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            cleanup();
            resolve({ kind: 'aborted' });
        };
        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (idleMs !== undefined && idleMs > 0) {
            timer = setTimeout(() => {
                cleanup();
                resolve({ kind: 'timeout' });
            }, idleMs);
        }
        reader.read().then(
            (result) => {
                cleanup();
                resolve({ kind: 'chunk', done: result.done, value: result.value });
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
}

/** Release the connection behind a reader we are done with. */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    try {
        const cancelled = (reader as { cancel?: () => Promise<void> }).cancel?.();
        if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => undefined);
    } catch {
        // Already released or errored; nothing left to close.
    }
}

/**
 * Drive an SSE response to completion, emitting one `StreamEvent` at a time.
 *
 * Always terminates with exactly one `done` or one `error` event, so a caller
 * can rely on the stream closing its own bracket.
 */
export async function parseSseStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    format: WireFormat,
    onEvent: (event: StreamEvent) => void,
    options: SseStreamOptions = {},
): Promise<void> {
    const { label, idleTimeoutMs, signal } = options;
    const assembler = new ToolCallAssembler();
    const responses = format === 'openai-responses' ? new ResponsesDecoder(assembler, label) : null;
    const decodeChunk = (parsed: unknown): DecodeResult => {
        if (responses) return responses.decode(parsed);
        return format === 'anthropic'
            ? decodeAnthropicChunk(parsed, assembler, label)
            : decodeOpenAIChunk(parsed, assembler, label);
    };
    const decoder = new TextDecoder();

    let buffer = '';
    let stopReason: StopReason | null = null;
    let settled = false;
    /**
     * Whether any `data:` line arrived — the only proof this response really is
     * an event stream. Until it does, the raw bytes are kept so a non-stream
     * body can be quoted back; after it does, nothing is accumulated.
     */
    let sawDataLine = false;
    let rawPrefix = '';
    // Providers differ on where this lands: OpenAI and DeepSeek send it in a
    // final frame with an empty `choices` array (and only when asked), while
    // some gateways attach it to the last content frame unprompted. Reading it
    // off whichever frame carries it covers both without a per-provider
    // branch.
    let usage: TokenUsage | undefined;

    const emitDone = (reason: StopReason) => {
        if (settled) return;
        // Calls whose provider never sent an id are announced now, under the id
        // they are about to be run with, so no call runs unseen.
        for (const start of assembler.announceRemaining()) onEvent(start);
        settled = true;
        const toolCalls = assembler.finalize();
        const reasoningItems = responses?.reasoningItems() ?? [];
        onEvent({
            type: 'done',
            // A turn that assembled named calls is a tool turn, whatever finish
            // reason came with it: some compatible servers send `stop` after a
            // tool call, and ending the run there would drop the call unrun.
            stopReason: reason === 'end_turn' && toolCalls.length > 0 ? 'tool_calls' : reason,
            toolCalls,
            ...(usage ? { usage } : {}),
            ...(reasoningItems.length ? { reasoningItems } : {}),
        });
    };
    const emitError = (error: Error) => {
        if (settled) return;
        settled = true;
        onEvent({ type: 'error', error });
    };
    const cancelled = () => new ModelRequestError('Request cancelled', { kind: 'cancelled', label });

    /** Handle one `data:` payload; false once the stream has nothing more to say. */
    const handlePayload = (payload: string): boolean => {
        if (payload === '[DONE]') {
            // OpenAI's terminal sentinel. A `finish_reason` normally
            // arrived just before it; trust that over the default.
            stopReason = stopReason ?? 'end_turn';
            return false;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            // Providers occasionally flush a `data:` line mid-JSON. The
            // fragment is unrecoverable on its own, but the stream is
            // still healthy, so skip this line rather than fail the run.
            return true;
        }

        usage = readUsage(parsed) ?? usage;

        const result = decodeChunk(parsed);
        for (const event of result.events) {
            if (event.type === 'error') {
                emitError(event.error);
                return false;
            }
            onEvent(event);
        }
        // A bare end marker (Anthropic's `message_stop`) must not overwrite the
        // specific reason that came before it.
        if (result.stopReason && !(result.stopReason === 'end_turn' && stopReason)) {
            stopReason = result.stopReason;
        }
        return !result.terminal;
    };

    try {
        reading: for (;;) {
            const outcome = await readWithin(reader, idleTimeoutMs, signal);
            if (outcome.kind === 'aborted') {
                cancelReader(reader);
                emitError(cancelled());
                return;
            }
            if (outcome.kind === 'timeout') {
                cancelReader(reader);
                const wait = describeWait(idleTimeoutMs ?? 0);
                emitError(
                    new ModelRequestError(`${label ?? 'The endpoint'} sent nothing for ${wait}`, {
                        kind: 'timeout',
                        label,
                        detail: sawDataLine
                            ? `The reply stopped arriving: nothing came for ${wait}.`
                            : `The reply never started: nothing came for ${wait}.`,
                    }),
                );
                return;
            }
            if (outcome.done) break;

            const text = decoder.decode(outcome.value, { stream: true });
            if (!sawDataLine && rawPrefix.length < NON_SSE_BODY_LIMIT) {
                rawPrefix += text;
            }
            buffer += text;
            const split = splitSseLines(buffer);
            buffer = split.rest;

            for (const line of split.lines) {
                const trimmed = line.trim();
                // Comments (`:` keep-alives) and Anthropic's `event:` lines carry
                // nothing we need — the payload is always on the `data:` line.
                if (!trimmed || !trimmed.startsWith('data:')) continue;

                // Even a keep-alive `data:` proves the response is a stream.
                sawDataLine = true;
                const payload = trimmed.slice('data:'.length).trimStart();
                // A bare `data:` is a spec-legal keep-alive.
                if (!payload) continue;
                if (!handlePayload(payload)) {
                    // Finished or failed. The server may hold the connection
                    // open after its last frame, so close it rather than wait.
                    cancelReader(reader);
                    if (settled) return;
                    break reading;
                }
            }
        }

        // A body with no frames at all never was a stream, whatever the status
        // said. Reporting it as a clean finish would turn a rejected request
        // into a blank answer with no error attached.
        if (!sawDataLine) {
            emitError(nonSseBodyError(rawPrefix, label));
            return;
        }

        // A stream that stops with no finish reason and no end marker was cut
        // off — a dropped connection, a proxy giving up — and its reply may be
        // missing its end. Assembled calls still make it a tool turn: a call
        // whose arguments did not all arrive fails to parse and says so.
        emitDone(stopReason ?? (assembler.isEmpty ? 'interrupted' : 'tool_calls'));
    } catch (error) {
        if (signal?.aborted) {
            emitError(cancelled());
            return;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        emitError(
            isModelRequestError(failure)
                ? failure
                : new ModelRequestError(failure.message, { kind: 'stream', label }),
        );
    }
}
