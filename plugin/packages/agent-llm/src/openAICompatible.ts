/**
 * OpenAI-compatible chat provider.
 *
 * Speaks two wire formats. `/chat/completions` covers DeepSeek, OpenRouter,
 * Zhipu, Together, vLLM and Ollama's compatibility endpoint. OpenAI itself,
 * and gateways in front of it, speak OpenAI's Responses API (`/responses`),
 * the only place its reasoning models take a thinking effort together with
 * function tools. Everything else is the
 * same, so one class serves them all.
 *
 * Pure apart from the injected `fetch`: no Zotero globals, so it unit tests
 * against a fake transport.
 */

import {
    ModelRequestError,
    childAbortController,
    describeErrorBody,
    describeWait,
    parseSseStream,
    untilAborted,
} from './sse';
import { contentToText, hasImageParts, toDataUrl } from './types';
import type {
    ChatMessage,
    ChatProvider,
    ChatRequest,
    ContentPart,
    MessageContent,
    ProviderConfig,
    StreamEvent,
    ToolSchema,
    WireFormat,
} from './types';

export type FetchLike = (url: string, init: Record<string, any>) => Promise<{
    ok: boolean;
    status: number;
    statusText?: string;
    /** Read for `Retry-After`; optional so a test double can leave it out. */
    headers?: { get: (name: string) => string | null } | null;
    text: () => Promise<string>;
    body: { getReader: () => ReadableStreamDefaultReader<Uint8Array> } | null;
}>;

/** One content part on the wire, in OpenAI's shape. */
type WireContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/** Wire shape of one message in an OpenAI chat-completions request. */
interface WireMessage {
    role: string;
    content: string | WireContentPart[] | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: Record<string, unknown>;
    }>;
}

function toWireContent(content: MessageContent): string | WireContentPart[] {
    if (typeof content === 'string') return content;
    return content.map((part): WireContentPart =>
        part.type === 'text'
            ? { type: 'text', text: part.text }
            : { type: 'image_url', image_url: { url: toDataUrl(part) } },
    );
}

/** What a call the history never answered is answered with on the wire. */
const UNANSWERED_CALL_RESULT = JSON.stringify({ error: 'This tool call did not complete.' });

/**
 * Content with its images replaced by a notice, for a model that cannot read
 * them. The notice is explicit so the model says it could not see the images
 * instead of answering as if it had. Consecutive images share one notice.
 */
function withoutImages(parts: ContentPart[], returnedBy?: string): string {
    const out: string[] = [];
    let withheld = 0;
    const notice = () => {
        if (!withheld) return;
        const what = withheld === 1 ? 'An image' : `${withheld} images`;
        const source = returnedBy ? ` returned by ${returnedBy}` : '';
        out.push(`[${what}${source} ${withheld === 1 ? 'was' : 'were'} not sent: this model cannot read images.]`);
        withheld = 0;
    };
    for (const part of parts) {
        if (part.type === 'image') {
            withheld += 1;
            continue;
        }
        notice();
        out.push(part.text);
    }
    notice();
    return out.join('\n');
}

/**
 * Convert to the chat-completions message array.
 *
 * `imagesInToolResults` decides how a tool that returned images is rendered.
 * When the endpoint does not accept image parts on a `tool` message, the images
 * are lifted into a follow-up `user` message: the tool result keeps its text so
 * the `tool_call_id` is still answered — leaving it unanswered would make the
 * whole request 400 — and the pixels arrive in the next message instead.
 *
 * The call/result pairing is enforced here, because strict endpoints reject the
 * whole request over one broken pair, and a broken pair in a saved thread would
 * then fail every later message in it. A `tool` message whose id the assistant
 * turn before it did not request is dropped; a requested call with no result is
 * answered with a short "did not complete" before the conversation moves on.
 *
 * `supportsVision: false` sends no image at all, from a tool or from the user,
 * each replaced by a notice: a text-only endpoint rejects the whole request
 * over one image part, and a thread started on a model that reads images
 * still carries them when it moves to one that does not.
 */
export function toOpenAIMessages(
    messages: ChatMessage[],
    options: { imagesInToolResults?: boolean; supportsVision?: boolean } = {},
): WireMessage[] {
    const textOnly = options.supportsVision === false;
    const wire: WireMessage[] = [];

    // The calls the latest assistant turn made and no tool message has answered.
    let openCalls = new Map<string, string>();
    const answerOpenCalls = () => {
        for (const [id, name] of openCalls) {
            wire.push({ role: 'tool', tool_call_id: id, name, content: UNANSWERED_CALL_RESULT });
        }
        openCalls = new Map();
    };

    /*
     * Lifted images wait here until the current run of tool messages ends.
     * An assistant turn may carry several tool calls, and the API requires
     * the tool messages answering them to follow as one uninterrupted block —
     * pushing the image user-message immediately would wedge it between two
     * tool messages of the same turn, which is a 400 ("An assistant message
     * with 'tool_calls' must be followed by tool messages responding to each
     * 'tool_call_id'"). Seen live when a model called view_page_images and
     * get_metadata in one turn.
     */
    let liftedImages: Array<{ name: string; images: ContentPart[] }> = [];
    const flushLiftedImages = () => {
        for (const lift of liftedImages) {
            wire.push({
                role: 'user',
                content: toWireContent([
                    {
                        type: 'text',
                        text: `Images returned by ${lift.name}:`,
                    },
                    ...lift.images,
                ]),
            });
        }
        liftedImages = [];
    };

    for (const message of messages) {
        if (message.role === 'tool') {
            if (!openCalls.has(message.toolCallId)) continue;
            openCalls.delete(message.toolCallId);
            const carriesImages = hasImageParts(message.content);

            if (carriesImages && textOnly) {
                wire.push({
                    role: 'tool',
                    tool_call_id: message.toolCallId,
                    name: message.name,
                    content: withoutImages(message.content as ContentPart[], message.name),
                });
                continue;
            }

            if (carriesImages && !options.imagesInToolResults) {
                const parts = message.content as ContentPart[];
                const images = parts.filter((p) => p.type === 'image');
                const text = contentToText(parts);

                wire.push({
                    role: 'tool',
                    tool_call_id: message.toolCallId,
                    name: message.name,
                    content: text,
                });
                liftedImages.push({ name: message.name, images });
                continue;
            }

            wire.push({
                role: 'tool',
                tool_call_id: message.toolCallId,
                name: message.name,
                content: toWireContent(message.content),
            });
            continue;
        }

        answerOpenCalls();
        flushLiftedImages();

        if (message.role === 'assistant' && message.toolCalls?.length) {
            openCalls = new Map(message.toolCalls.map((call) => [call.id, call.name] as [string, string]));
            wire.push({
                role: 'assistant',
                // The API rejects a tool-call turn that also carries an empty
                // string, but accepts null — and models often produce no prose
                // alongside their calls.
                content: message.content || null,
                tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function' as const,
                    function: {
                        name: call.name,
                        // A zero-arg call streams nothing; the API requires valid
                        // JSON here, so send an empty object rather than "".
                        arguments: call.argumentsJson || '{}',
                    },
                    // Gemini's thought signature, returned exactly as it came.
                    ...(call.extraContent ? { extra_content: call.extraContent } : {}),
                })),
            });
            continue;
        }

        wire.push({
            role: message.role,
            content: textOnly && hasImageParts(message.content)
                ? withoutImages(message.content as ContentPart[])
                : toWireContent(message.content),
        });
    }

    // The request usually ends on the freshest tool results — the lifted
    // images are exactly what the next completion needs to see.
    answerOpenCalls();
    flushLiftedImages();

    return wire;
}

/** One item of a Responses-API `input` array. */
type ResponsesItem = Record<string, unknown>;

/** Message content as Responses input parts. Empty text is dropped: the API refuses it. */
function toResponsesContent(content: MessageContent): ResponsesItem[] {
    const parts: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return parts
        .filter((part) => part.type === 'image' || part.text !== '')
        .map((part): ResponsesItem =>
            part.type === 'text'
                ? { type: 'input_text', text: part.text }
                : { type: 'input_image', image_url: toDataUrl(part) },
        );
}

/**
 * Convert to a Responses-API request's `instructions` and `input`.
 *
 * The same conversation as `toOpenAIMessages`, under the same rules — calls and
 * results paired, images lifted out of tool results the endpoint will not take
 * them in, and none at all for a model that cannot read them — in the
 * Responses shapes: the leading system prompt becomes `instructions`, a later
 * system message a `developer` message, an assistant turn its text plus one
 * `function_call` per call, and a tool result a `function_call_output`.
 *
 * Calls are sent back by `call_id` alone, without the `fc_` item ids: the
 * server pairs an item id with the reasoning that produced it, and a saved
 * conversation does not have that reasoning. Within a run, the reasoning
 * items a turn produced are sent back ahead of its calls.
 */
export function toResponsesInput(
    messages: ChatMessage[],
    options: { imagesInToolResults?: boolean; supportsVision?: boolean } = {},
): { instructions?: string; input: ResponsesItem[] } {
    const textOnly = options.supportsVision === false;
    const input: ResponsesItem[] = [];
    const instructions: string[] = [];
    let leading = true;

    let openCalls = new Map<string, string>();
    const answerOpenCalls = () => {
        for (const id of openCalls.keys()) {
            input.push({ type: 'function_call_output', call_id: id, output: UNANSWERED_CALL_RESULT });
        }
        openCalls = new Map();
    };

    // Lifted images wait until the current run of results ends, as on the
    // chat wire: every call of a turn is answered before anything else comes.
    let liftedImages: Array<{ name: string; images: ContentPart[] }> = [];
    const flushLiftedImages = () => {
        for (const lift of liftedImages) {
            input.push({
                role: 'user',
                content: toResponsesContent([{ type: 'text', text: `Images returned by ${lift.name}:` }, ...lift.images]),
            });
        }
        liftedImages = [];
    };

    for (const message of messages) {
        if (message.role === 'tool') {
            if (!openCalls.has(message.toolCallId)) continue;
            openCalls.delete(message.toolCallId);
            let output: string | ResponsesItem[];
            if (!hasImageParts(message.content)) {
                output = contentToText(message.content);
            } else if (textOnly) {
                output = withoutImages(message.content as ContentPart[], message.name);
            } else if (!options.imagesInToolResults) {
                const parts = message.content as ContentPart[];
                output = contentToText(parts);
                liftedImages.push({ name: message.name, images: parts.filter((part) => part.type === 'image') });
            } else {
                output = toResponsesContent(message.content);
            }
            input.push({ type: 'function_call_output', call_id: message.toolCallId, output });
            continue;
        }

        answerOpenCalls();
        flushLiftedImages();

        if (message.role === 'system') {
            const text = contentToText(message.content);
            if (!text) continue;
            if (leading) instructions.push(text);
            else input.push({ role: 'developer', content: text });
            continue;
        }
        leading = false;

        if (message.role === 'assistant') {
            for (const item of message.reasoningItems ?? []) input.push(item);
            if (message.content) input.push({ role: 'assistant', content: message.content });
            if (message.toolCalls?.length) {
                openCalls = new Map(message.toolCalls.map((call) => [call.id, call.name] as [string, string]));
                for (const call of message.toolCalls) {
                    input.push({
                        type: 'function_call',
                        call_id: call.id,
                        name: call.name,
                        // A zero-arg call streams nothing; the API wants JSON.
                        arguments: call.argumentsJson || '{}',
                    });
                }
            }
            continue;
        }

        const content = textOnly && hasImageParts(message.content)
            ? toResponsesContent(withoutImages(message.content as ContentPart[]))
            : toResponsesContent(message.content);
        if (content.length) input.push({ role: 'user', content });
    }

    answerOpenCalls();
    flushLiftedImages();

    return { ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}), input };
}

/**
 * Tools in the Responses shape: flat, and with `strict: false` stated rather
 * than left to the default — strict mode requires every property to be listed
 * as required and no others allowed, which these schemas do not promise.
 */
export function toResponsesTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
    }));
}

/** The smallest output cap the Responses API accepts. */
const RESPONSES_MIN_OUTPUT_TOKENS = 16;

export function toOpenAITools(tools: ToolSchema[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

/**
 * Turn a non-2xx response into an error worth showing a user.
 *
 * Providers bury the useful sentence in `error.message`; the bare status alone
 * ("400 Bad Request") never tells you it was actually a bad key or an unknown
 * model name. The status, the provider's code and its sentence travel as
 * fields, so what the error means is decided from them rather than from
 * whatever digits the body happens to contain.
 */
export async function describeHttpFailure(
    label: string,
    status: number,
    statusText: string | undefined,
    readBody: () => Promise<string>,
    extra: { retryAfterMs?: number } = {},
): Promise<ModelRequestError> {
    let described: { detail?: string; code?: string } = {};
    try {
        described = describeErrorBody(await readBody());
    } catch {
        // A body we cannot read is not worth masking the status over.
    }
    const { detail, code } = described;
    return new ModelRequestError(
        `${label} request failed: ${status}${statusText ? ` ${statusText}` : ''}${detail ? `\n${detail}` : ''}`,
        {
            kind: 'http',
            label,
            // A refused key reported under another status (Google's 400) is a 401.
            status: code === 'invalid_api_key' ? 401 : status,
            ...(code !== undefined ? { code } : {}),
            ...(detail !== undefined ? { detail } : {}),
            ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
        },
    );
}

/**
 * A `Retry-After` header in milliseconds: either delay-seconds or an HTTP date.
 * Undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
    const at = Date.parse(trimmed);
    return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * How long a chat request may go without hearing back.
 *
 * `responseMs` covers the wait for the response to start: connecting and the
 * endpoint accepting the request (a local server loading a large model spends
 * this). `idleMs` covers every gap once the stream is open; any bytes reset
 * it, keep-alive comments included, so a provider that is queueing or thinking
 * out of sight but keeps the line alive never trips it.
 */
export interface StreamTimeouts {
    responseMs: number;
    idleMs: number;
}

/**
 * For the hosted services the presets name. Each starts its reply within
 * seconds, and while it queues a request or thinks it keeps the line alive,
 * with keep-alive comments or by streaming the thinking itself.
 */
export const HOSTED_STREAM_TIMEOUTS: StreamTimeouts = {
    responseMs: 60_000,
    idleMs: 180_000,
};

/**
 * For a model server whose speed nothing here can know: Ollama, and any
 * endpoint added by hand. Such a server may send nothing at all until it has
 * loaded the model and read the whole prompt, which takes minutes for a large
 * model or on a machine without a GPU (the first request of a run carries
 * every tool's schema), and Ollama holds a tool call back until the call is
 * complete. Only a silence longer than this means the server is stuck.
 *
 * A provider gets these unless it is given others: only a preset vouches for
 * an endpoint that answers faster.
 */
export const PATIENT_STREAM_TIMEOUTS: StreamTimeouts = {
    responseMs: 600_000,
    idleMs: 600_000,
};

export class OpenAICompatibleProvider implements ChatProvider {
    readonly label: string;
    readonly model: string;

    private readonly config: ProviderConfig;
    private readonly fetchImpl: FetchLike;
    private readonly timeouts: StreamTimeouts;
    /**
     * The wire this provider speaks now: the configured one, until an address
     * turns out to have no `/responses` (see `stream`).
     */
    private activeWire: WireFormat;
    /** Sent as the session header by requests that name no conversation (a title, a key check). */
    private readonly ownSessionId = `alphain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    constructor(config: ProviderConfig, fetchImpl: FetchLike, timeouts: Partial<StreamTimeouts> = {}) {
        this.config = config;
        this.label = config.label;
        this.model = config.model;
        this.activeWire = config.wireFormat === 'openai-responses' ? 'openai-responses' : 'openai';
        this.fetchImpl = fetchImpl;
        this.timeouts = { ...PATIENT_STREAM_TIMEOUTS, ...timeouts };
    }

    get wireFormat(): WireFormat {
        return this.activeWire;
    }

    /** Auth and content headers for this endpoint's convention, and the conversation's header where the endpoint wants one. */
    buildHeaders(request?: ChatRequest): Record<string, string> {
        const auth: Record<string, string> =
            (this.config.authStyle ?? 'bearer') === 'x-api-key'
                ? { 'X-Api-Key': this.config.apiKey }
                : { Authorization: `Bearer ${this.config.apiKey}` };
        const session: Record<string, string> = this.config.sessionHeader
            ? { [this.config.sessionHeader]: request?.sessionId?.trim() || this.ownSessionId }
            : {};
        return { 'Content-Type': 'application/json', ...auth, ...session, ...(this.config.headers ?? {}) };
    }

    /** The request body, exposed for tests and for logging a failing call. */
    buildBody(request: ChatRequest): Record<string, unknown> {
        if (this.wireFormat === 'openai-responses') return this.buildResponsesBody(request);
        const body: Record<string, unknown> = {
            model: this.config.model,
            messages: toOpenAIMessages(request.messages, {
                imagesInToolResults: this.config.imagesInToolResults,
                supportsVision: this.config.supportsVision,
            }),
            stream: true,
            // What a run cost, from the provider rather than estimated.
            // DeepSeek and OpenAI report usage only when asked; other
            // gateways report it either way and accept the field, so it is
            // sent unconditionally rather than per-provider. `streamUsage:
            // false` opts out an endpoint that rejects it.
            ...(this.config.streamUsage === false
                ? {}
                : { stream_options: { include_usage: true } }),
        };
        if (request.tools?.length) {
            body.tools = toOpenAITools(request.tools);
            body.tool_choice = 'auto';
        }
        if (this.config.maxTokens !== undefined) {
            body[this.config.maxTokensParam ?? 'max_tokens'] = this.config.maxTokens;
        }
        if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
        const extraBody = { ...(this.config.extraBody ?? {}) };
        if (this.config.wireFormat === 'openai-responses') {
            // A Responses preset on an address without /responses. Thinking
            // and tools go together only there; on /chat/completions OpenAI's
            // newer models take tools only at the least effort, so that is
            // what is sent, whatever the setting.
            delete extraBody.reasoning_effort;
            if (this.config.supportsReasoningEffort) {
                extraBody.reasoning_effort = this.config.leastReasoningEffort ?? 'none';
            }
        }
        // Last, so an endpoint quirk can override anything above it.
        return { ...body, ...extraBody };
    }

    /**
     * The same request on the Responses wire. The effort arrives in
     * `extraBody` under its chat-completions name and goes out as
     * `reasoning.effort`; a model that takes none is sent no `reasoning` at
     * all, since the field is a 400 there.
     */
    private buildResponsesBody(request: ChatRequest): Record<string, unknown> {
        const { instructions, input } = toResponsesInput(request.messages, {
            imagesInToolResults: this.config.imagesInToolResults,
            supportsVision: this.config.supportsVision,
        });
        const { reasoning_effort: configuredEffort, ...extraBody } = this.config.extraBody ?? {};
        const body: Record<string, unknown> = {
            model: this.config.model,
            ...(instructions ? { instructions } : {}),
            input,
            stream: true,
            // Every request carries the whole conversation; nothing is kept on
            // the provider's side, and the reasoning that is sent back travels
            // encrypted in the request instead.
            store: false,
        };
        if (request.tools?.length) {
            body.tools = toResponsesTools(request.tools);
            body.tool_choice = 'auto';
        }
        if (this.config.maxTokens !== undefined) {
            body.max_output_tokens = Math.max(this.config.maxTokens, RESPONSES_MIN_OUTPUT_TOKENS);
        }
        if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
        if (this.config.supportsReasoningEffort) {
            const effort = typeof configuredEffort === 'string' && configuredEffort
                ? configuredEffort
                : (this.config.leastReasoningEffort ?? 'none');
            const thinks = effort !== 'none';
            body.reasoning = { effort, ...(thinks && this.config.reasoningSummary ? { summary: 'auto' } : {}) };
            // The encrypted reasoning is what lets the next step of the run
            // pick up where this one's thinking left off.
            if (thinks) body.include = ['reasoning.encrypted_content'];
        }
        if (this.config.promptCacheRetention) body.prompt_cache_retention = this.config.promptCacheRetention;
        return { ...body, ...extraBody };
    }

    /**
     * Stream one turn.
     *
     * The caller's signal and this request's own deadlines share one
     * controller, so either really closes the connection; the wait is also
     * raced against it, so a transport that ignores the signal cannot hold a
     * stopped run open.
     *
     * A Responses preset whose address has no `/responses` — an
     * OpenAI-compatible relay in front of OpenAI that speaks only chat
     * completions, put on the card by hand — answers 404 or 405 there. The
     * turn is then sent again on `/chat/completions`, and so is every later
     * one: answering without thinking beats not answering.
     */
    async stream(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void> {
        if ((await this.streamOnce(request, onEvent)) === 'no-responses-endpoint') {
            this.activeWire = 'openai';
            await this.streamOnce(request, onEvent);
        }
    }

    private async streamOnce(
        request: ChatRequest,
        onEvent: (event: StreamEvent) => void,
    ): Promise<'no-responses-endpoint' | undefined> {
        const path = this.wireFormat === 'openai-responses' ? '/responses' : '/chat/completions';
        const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
        const label = this.label;
        const { controller, release } = childAbortController(request.signal);
        const signal = controller.signal;
        let timedOut = false;
        const deadline = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.timeouts.responseMs);
        const cancelled = () => new ModelRequestError('Request cancelled', { kind: 'cancelled', label });
        const noResponse = () => {
            const wait = describeWait(this.timeouts.responseMs);
            return new ModelRequestError(`${label} did not respond within ${wait}`, {
                kind: 'timeout',
                label,
                detail: `No response within ${wait}.`,
            });
        };

        try {
            if (signal.aborted) {
                onEvent({ type: 'error', error: cancelled() });
                return;
            }

            let response;
            try {
                response = await untilAborted(
                    this.fetchImpl(url, {
                        method: 'POST',
                        headers: this.buildHeaders(request),
                        body: JSON.stringify(this.buildBody(request)),
                        signal,
                    }),
                    signal,
                );
            } catch (error) {
                // No response at all. A stop is a normal outcome, not a
                // provider fault; a missed deadline and a dead network differ
                // in what the user should check.
                const err = error instanceof Error ? error : new Error(String(error));
                onEvent({
                    type: 'error',
                    error: timedOut
                        ? noResponse()
                        : request.signal?.aborted || err.name === 'AbortError'
                          ? cancelled()
                          : new ModelRequestError(`${label} could not be reached: ${err.message}`, {
                                kind: 'network',
                                label,
                            }),
                });
                return;
            }

            if (!response.ok) {
                const failure = await describeHttpFailure(
                    label,
                    response.status,
                    response.statusText,
                    () => untilAborted(response!.text(), signal),
                    { retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')) },
                );
                if (request.signal?.aborted) {
                    onEvent({ type: 'error', error: cancelled() });
                    return;
                }
                // OpenAI also answers 404 for a model that does not exist;
                // that is an answer, not a missing endpoint.
                if (
                    this.wireFormat === 'openai-responses'
                    && (response.status === 404 || response.status === 405)
                    && failure.code !== 'model_not_found'
                ) {
                    return 'no-responses-endpoint';
                }
                onEvent({ type: 'error', error: failure });
                return;
            }

            // The response has started; from here the idle limit applies.
            clearTimeout(deadline);

            if (!response.body) {
                onEvent({
                    type: 'error',
                    error: new ModelRequestError(`${label} returned no response body`, { kind: 'provider', label }),
                });
                return;
            }

            await parseSseStream(response.body.getReader(), this.wireFormat, onEvent, {
                label,
                idleTimeoutMs: this.timeouts.idleMs,
                signal,
            });
        } finally {
            clearTimeout(deadline);
            release();
        }
    }
}

// ---------------------------------------------------------------------------
// Known presets
// ---------------------------------------------------------------------------

/**
 * Whether an OpenAI model takes a thinking effort: the o-series and gpt-5
 * onward, except the `-chat` variants, which do not reason. gpt-4o and gpt-4.1
 * reject the `reasoning` field outright ("Unsupported parameter:
 * 'reasoning.effort' is not supported with this model", gpt-4o-mini,
 * 2026-10-13).
 */
export function takesOpenAIReasoningEffort(model: string): boolean {
    return /^(o\d|gpt-([5-9]|\d{2,}))/.test(model) && !/-chat(-|$)/.test(model);
}

/**
 * Respellings for the OpenAI models that refuse a tier. `none` arrived with
 * gpt-5.1, and GPT-6 takes it; the o-series, gpt-6-astra and gpt-6.1-sol
 * refuse it and start at `low` (6.1 Sol answered so on 2026-10-28: "Supported
 * values are: 'low', 'medium', 'high', 'xhigh', and 'max'"), and the first
 * gpt-5 models' least is `minimal`.
 */
export function openAIReasoningEffortAliases(model: string): Record<string, string> {
    // The `-pro` models think at `high` and nothing less.
    if (/-pro(-|$)/.test(model)) return { none: 'high', low: 'high', medium: 'high' };
    if (/^o\d/.test(model) || /-astra\b/.test(model) || /^gpt-6\.1-sol\b/.test(model) || /-codex/.test(model)) return { none: 'low' };
    // With or without a snapshot date: gpt-5-mini-2025-08-07.
    if (/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(model)) return { none: 'minimal' };
    return {};
}

/**
 * The most output tokens an OpenAI model accepts; a request above it is a 400.
 * gpt-5 and later 128,000, the o-series 100,000, gpt-4.1 32,768, and 16,384
 * for gpt-4o, gpt-4o-mini and anything unrecognised.
 */
export function openAIOutputCeiling(model: string): number {
    return /^gpt-([5-9]|\d{2,})/.test(model)
        ? 128_000
        : /^o\d/.test(model)
          ? 100_000
          : /^gpt-4\.1/.test(model)
            ? 32_768
            : 16_384;
}

/**
 * Endpoint defaults for the providers this plugin ships with.
 *
 * `deepseek-reasoner` streams its chain of thought on `reasoning_content`,
 * which the SSE layer routes to `reasoning` events rather than answer text.
 */
export const PROVIDER_PRESETS = {
    /**
     * DeepSeek's own endpoint. One model: `deepseek-flash`, the id DeepSeek
     * gave V4.1 Flash on 2026-09-10 (`/v1/models` lists `deepseek-flash` and
     * `deepseek-v4-pro`; `deepseek-v4.1-flash` is not an accepted name). It is
     * multimodal from the ground up — the release note's "native visual
     * understanding" — so the preset declares vision and no longer needs a
     * separate vision preset: the message shape is the same one every
     * OpenAI-compatible endpoint takes, images lifted into a user message.
     *
     * The retired ids — `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`,
     * and from 2026-09-14 `deepseek-v4-pro` — are routed by DeepSeek to this
     * model at its price; a stored preference naming one of them resolves to
     * `deepseek-flash` here (RETIRED_MODELS) rather than riding a redirect.
     */
    deepseek: {
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-flash',
        models: ['deepseek-flash'],
        wireFormat: 'openai' as WireFormat,
        supportsVision: true,
        imagesInToolResults: false,
        /*
         * DeepSeek renames and routes server-side (`deepseek-flash` is itself a
         * floating name), so the catalogue's Check button may still ask the
         * endpoint about a model added by hand; see visionProbe.ts.
         */
        visionByProbe: true,
        // These models think before they answer, and the thinking is spent from
        // the same budget as the answer. On a 4000-token cap a planning turn
        // reached `finish_reason: "length"` with the whole budget consumed by
        // reasoning — no content and no tool calls. 8000 moved the failure
        // rather than fixing it: after a long read (eight searches, five pages)
        // a high-effort final turn thought past 8000 and answered nothing. The
        // cap is a ceiling, not a charge, so the default leaves real room; the
        // endpoint's own limit is 393,216 ("valid range of max_tokens is
        // [1, 393216]", measured 2026-09-24).
        defaultMaxTokens: 32_000,
        maxOutputTokens: 393_216,
        // Every tier from `none` to `max` is accepted by `deepseek-flash`
        // (verified live, 2026-09-10); `none` zeroes reasoning_tokens.
        supportsReasoningEffort: true,
    },
    /**
     * OpenRouter, for the models nobody else hosts behind one key.
     *
     * The endpoint is plain OpenAI-compatible, so the only preset-specific
     * facts are the base URL and that, like DeepSeek, the model's thinking is
     * spent from the answer's budget.
     */
    /**
     * OpenCode Go (opencode.ai): one subscription key for a set of hosted
     * models, with rolling five-hour, weekly and monthly allowances instead of
     * a per-token bill. Facts from the provider's catalogue as pi-ai 1.5 ships
     * it (read 2026-11-25).
     *
     * Only its chat-completions models are listed: the same key also reaches
     * Claude, Qwen and MiniMax M3 on Anthropic's protocol, Gemini on Google's
     * and GPT / Grok on the Responses API, none of which this preset speaks.
     * The listed models all think before they answer and none can be told not
     * to (`off` is absent from every one of them), so the lowest tier is the
     * floor; DeepSeek V4 Pro takes only `high` and `max`. The DeepSeek models
     * are DeepSeek's own (OpenCode states zero retention for them) and take
     * `reasoning_effort` as DeepSeek's API does, and like it they accept a
     * history whose assistant turns carry no `reasoning_content`.
     *
     * The service can be slow to start a reply when one of its upstreams is
     * struggling — first words 80 s and more were seen on 2026-11-05 — so the
     * response window is wider than the hosted default.
     */
    'opencode-go': {
        label: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        defaultModel: 'deepseek-v4.1-flash',
        models: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3.1-pro', 'minimax-m3.1-flash', 'deepseek-v4-pro', 'glm-5.3'],
        wireFormat: 'openai' as WireFormat,
        supportsVision: true,
        textOnlyModels: ['deepseek-v4-pro', 'glm-5.3'] as readonly string[],
        imagesInToolResults: false,
        defaultMaxTokens: 32_000,
        maxOutputTokens: 131_072,
        maxOutputTokensByModel: (model: string) =>
            model.startsWith('deepseek-') ? 384_000 : model.startsWith('minimax-m3.1') ? 512_000 : 131_072,
        supportsReasoningEffort: true,
        reasoningEffortAliasesByModel: (model: string) =>
            (model === 'deepseek-v4-pro'
                ? { none: 'high', low: 'high', medium: 'high' }
                : model.startsWith('minimax-m3.1')
                    ? { none: 'low' }
                    : { none: 'low', medium: 'high' }) as Record<string, string>,
        streamTimeouts: { responseMs: 300_000, idleMs: PATIENT_STREAM_TIMEOUTS.idleMs } as StreamTimeouts,
        // Since 2026-11 a request without it is refused (400, "Request is missing
        // x-opencode-session"). The service keeps each conversation on one
        // upstream by it, which is also what lets the prompt cache hit.
        sessionHeader: 'x-opencode-session',
    },
    openrouter: {
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        /*
         * GLM 5.3 Flash, successor to the retired stealth/ox-alpha.
         *
         * Read from https://openrouter.ai/api/v1/models on 2026-08-26 (its
         * release day) rather than assumed: `z-ai/glm-5.3-flash` lists
         * `tools`, `tool_choice`, `reasoning` and `reasoning_effort` among its
         * supported parameters — this plugin is an agent loop, so tool support
         * is the entry ticket. 1,310,720 context, 131,072 max completion,
         * text+image+video in, $0.075/M prompt · $0.25/M completion.
         *
         * `stealth/ox-alpha` no longer exists on the roster at all; the
         * mapping in RETIRED_OPENROUTER_MODELS keeps a preference that still
         * names it from turning into a 404 on every request.
         */
        defaultModel: 'z-ai/glm-5.3-flash',
        /*
         * `deepseek/deepseek-v4.1-flash` replaced `deepseek/deepseek-v4-flash`
         * on 2026-09-10: OpenRouter's roster lists it with text+image input,
         * 1,048,576 context, $0.15/M in · $0.60/M out. Being multimodal it
         * needs no `textOnlyModels` entry; a stored preference naming the old
         * id resolves to it (RETIRED_OPENROUTER_MODELS).
         */
        models: ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash'],
        wireFormat: 'openai' as WireFormat,
        supportsVision: true,
        textOnlyModels: [] as readonly string[],
        imagesInToolResults: false,
        // A thinking model shares this with its reasoning, so it is sized for
        // thinking plus an answer. 131,072 is accepted for both models on the
        // roster (measured 2026-09-24).
        defaultMaxTokens: 32_000,
        maxOutputTokens: 131_072,
        supportsReasoningEffort: true,
        /*
         * GLM refuses to have its reasoning turned off — `none` 400s with
         * "Reasoning is mandatory for this endpoint" (verified live,
         * 2026-08-26). `minimal` is accepted and is what someone choosing
         * "none" actually wants from this model: as little thinking as it
         * will allow.
         */
        reasoningEffortAliases: { none: 'minimal' } as Record<string, string>,
        /*
         * That alias is GLM's quirk, not the gateway's, and this preset now
         * hosts two models that disagree about it. Verified live against
         * `deepseek/deepseek-v4-flash` on 2026-09-01: every tier from `none` to
         * `high` is accepted, and `none` genuinely zeroes reasoning_tokens —
         * so respelling it to `minimal` would turn thinking back ON for someone
         * who asked for none. Same shape as `extraBodyByModel`: when present,
         * this replaces the static map for the model actually chosen.
         */
        reasoningEffortAliasesByModel: (model: string) =>
            (model.startsWith('deepseek/') ? {} : { none: 'minimal' }) as Record<string, string>,
    },
    /**
     * Zhipu's own platform (bigmodel.cn), for GLM without the OpenRouter hop.
     *
     * Facts read from docs.bigmodel.cn on 2026-08-27, not assumed:
     * `glm-5.3-flash` — 1M context, 128K max output, image input via
     * `image_url` content blocks, function calling, priced at 1/10 of
     * GLM-5.3. Plain OpenAI-compatible wire: bearer auth, `max_tokens`.
     *
     * Thinking cannot be turned off on this model (`thinking.type` accepts
     * only `enabled`), and no `thinking` object is sent: its other field,
     * `clear_thinking`, only governs whether *replayed* reasoning_content in
     * the history is used, and this client never sends reasoning back.
     */
    zhipu: {
        label: 'Zhipu GLM',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-5.3-flash',
        models: ['glm-5.3-flash'],
        wireFormat: 'openai' as WireFormat,
        supportsVision: true,
        imagesInToolResults: false,
        // Same budget logic as the OpenRouter GLM preset: thinking is always
        // on and spends from the answer's tokens. The endpoint's own range is
        // [1, 131072] ("max_tokens参数非法：限制数值范围[1,131072]", measured
        // 2026-09-24).
        defaultMaxTokens: 32_000,
        maxOutputTokens: 131_072,
        supportsReasoningEffort: true,
        /*
         * This endpoint's effort enum is documented as low/high/max for the
         * 5.3 models (the full seven-step scale is GLM-5.2 only). Our four UI
         * tiers map onto the three that exist: `none` cannot be honoured
         * (thinking is mandatory) so it becomes the least thinking on offer,
         * and `high` gets the model's actual top tier.
         */
        reasoningEffortAliases: {
            none: 'low',
            medium: 'high',
            high: 'max',
        } as Record<string, string>,
    },
    /**
     * Google's Gemini API, through its OpenAI-compatible endpoint, with the
     * key from Google AI Studio as a bearer token. The same key serves the
     * Gemini Embedding option for topic search.
     *
     * Verified live on 2026-10-23 with this client's own request shape
     * (streamed, `tool_choice`, tool results carrying `name`, an assistant
     * turn of calls with `content: null`): all three models call tools and
     * read images in a user message. Every tool call comes with the model's
     * thought signature in `extra_content`, and the next request of the same
     * turn must send it back or the API refuses it ("Function call is missing
     * a thought_signature"); of parallel calls only the first carries one. A
     * finished earlier turn replayed without signatures is accepted. A turn
     * that called a tool ends with `finish_reason: "stop"`.
     *
     * Efforts: 3.8 Flash and 4 Argon take none, low, medium and high and
     * refuse `minimal`; 3.5 Flash-Lite refuses `none` once tools are offered
     * ("Request contains an invalid argument") and takes `minimal`. Thinking
     * is never quite off on these models: `none` still spends a few dozen
     * tokens, counted in `total_tokens` but not in `completion_tokens`.
     *
     * Prices per million tokens, paid tier (ai.google.dev/gemini-api/docs/pricing,
     * 2026-10-22): 3.8 Flash $0.75 in / $3.75 out until 2026-12-31, then
     * $1.50 / $7.50; 3.5 Flash-Lite $0.30 / $2.50; 4 Argon $2 / $10 until
     * 2026-11-30, then $4 / $20. The two Flash models have a free tier, with
     * tight daily limits and on terms that let Google use what is sent to
     * improve its products; Argon has none.
     */
    google: {
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-3.8-flash',
        models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon'],
        wireFormat: 'openai' as WireFormat,
        supportsVision: true,
        imagesInToolResults: false,
        // Thinking spends from the answer's budget, as on the other thinking
        // presets. models.list gives 65,536 output tokens for the Flash models
        // and 32,768 for Argon.
        defaultMaxTokens: 32_000,
        maxOutputTokens: 65_536,
        maxOutputTokensByModel: (model: string) => (model.startsWith('gemini-4-argon') ? 32_768 : 65_536),
        supportsReasoningEffort: true,
        reasoningEffortAliasesByModel: (model: string) =>
            (model.includes('flash-lite') ? { none: 'minimal' } : {}) as Record<string, string>,
        // A model thinking at a high effort may stream nothing for a while.
        streamTimeouts: { ...HOSTED_STREAM_TIMEOUTS, idleMs: PATIENT_STREAM_TIMEOUTS.idleMs } as StreamTimeouts,
    },
    /**
     * OpenAI itself, on the Responses wire: its reasoning models (gpt-5 and
     * later, the o-series) take a thinking effort together with function
     * tools only there. gpt-4o and gpt-4.1
     * answer on it too, sent no `reasoning` field.
     *
     * Thinking summaries are not asked for here: on api.openai.com some
     * organisations must be verified first, and the request would be refused.
     */
    openai: {
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
        models: ['gpt-4o', 'gpt-4o-mini'],
        wireFormat: 'openai-responses' as WireFormat,
        // Both listed models read images; without this an attached figure or
        // a scanned PDF was refused for anyone whose only key is OpenAI.
        supportsVision: true,
        imagesInToolResults: false,
        // The thinking models share this with their reasoning; gpt-4o and
        // gpt-4o-mini are held to their own 16,384 by the ceiling below.
        defaultMaxTokens: 32_000,
        maxOutputTokens: 16_384,
        /*
         * Models added from the endpoint's own list are not held to gpt-4o's
         * ceiling: gpt-4.1 allows 32,768, the o-series 100,000, gpt-5 and later
         * 128,000. Anything unrecognised keeps the 16,384 every current chat
         * model accepts.
         */
        maxOutputTokensByModel: openAIOutputCeiling,
        // Used only if the address turns out to have no /responses.
        maxTokensParam: 'max_completion_tokens' as const,
        supportsReasoningEffortByModel: takesOpenAIReasoningEffort,
        reasoningEffortAliasesByModel: openAIReasoningEffortAliases,
        // A reasoning model thinks out of sight on this endpoint, and the
        // stream carries nothing while it does: minutes of silence once the
        // reply has started are thinking, not a stalled connection.
        streamTimeouts: { ...HOSTED_STREAM_TIMEOUTS, idleMs: PATIENT_STREAM_TIMEOUTS.idleMs } as StreamTimeouts,
    },
    /**
     * Ollama on this machine, through its OpenAI-compatible endpoint.
     *
     * No key and no fixed model list: whatever `ollama pull` installed is
     * discovered from `/api/tags` and stored in the `ollamaModels` preference,
     * so the picker offers exactly the models that exist here. Text only —
     * whether a given local model reads images is not knowable from its name.
     */
    ollama: {
        label: 'Ollama (local)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        defaultModel: '',
        models: [] as string[],
        wireFormat: 'openai' as WireFormat,
        supportsVision: false,
        imagesInToolResults: false,
        defaultMaxTokens: 4000,
        // Ollama answers nothing until the model is loaded and the prompt read,
        // and sends a tool call only once it is complete; how long either takes
        // depends on the model and the machine it runs on.
        streamTimeouts: PATIENT_STREAM_TIMEOUTS,
    },
} as const;

export type ProviderPresetId = keyof typeof PROVIDER_PRESETS;

/**
 * Models that once shipped as a preset default and have since left the
 * provider's roster, each mapped to its successor.
 *
 * The model preference outlives the catalog: someone who picked Ox Alpha has
 * `llmModel = "stealth/ox-alpha"` stored, and OpenRouter now answers that id
 * with a 404 — on every request, wearing an error message about a model the
 * settings page no longer even offers. Routing the stored name to the
 * successor keeps their setup working without touching their preferences;
 * they keep whatever the successor is until they choose something themselves.
 */
export const RETIRED_OPENROUTER_MODELS: Record<string, string> = {
    'stealth/ox-alpha': 'z-ai/glm-5.3-flash',
    'deepseek/deepseek-v4-flash': 'deepseek/deepseek-v4.1-flash',
};

/**
 * Model ids that no longer exist, with the model that answers in their place.
 *
 * A preference names a model by id, and vendors retire ids: DeepSeek replaced
 * its whole V4 line with `deepseek-flash` on 2026-09-10 and routes the old
 * names to it. Resolving here — rather than sending the old name and riding
 * the redirect — means the composer, the picker and the run all name the model
 * that actually answers, and the row the user chose still exists.
 */
export const RETIRED_MODELS: Record<string, string> = {
    ...RETIRED_OPENROUTER_MODELS,
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    'deepseek-v4-pro': 'deepseek-flash',
    'deepseek-v4.1-flash': 'deepseek-flash',
    'deepseek-v4.1-flash-expires-on-0910': 'deepseek-flash',
};

/**
 * Preset ids that were folded into another preset. `deepseek-vision` existed
 * because DeepSeek's vision model needed its own message shape; the current
 * DeepSeek model reads images under the plain preset.
 */
export const RETIRED_PROVIDERS: Record<string, ProviderPresetId> = {
    'deepseek-vision': 'deepseek',
};

/**
 * A stored provider/model pair, resolved to what exists today.
 *
 * An id is retired only where it no longer exists: a provider whose own
 * catalogue still lists it keeps it. OpenCode Go serves `deepseek-v4.1-flash`
 * and `deepseek-v4-pro`, ids DeepSeek's own API retired, and sending them
 * renamed is a 400 there ("Model deepseek-flash isn't included in OpenCode Go").
 */
export function retireChoice(provider: string, model: string): { provider: string; model: string } {
    const nextProvider = RETIRED_PROVIDERS[provider] ?? provider;
    const catalogue = (PROVIDER_PRESETS as Record<string, { models?: readonly string[] }>)[nextProvider]?.models;
    if (catalogue?.includes(model)) return { provider: nextProvider, model };
    const nextModel = RETIRED_MODELS[model] ?? model;
    return { provider: nextProvider, model: nextModel };
}

/**
 * The optional preset fields, readable without narrowing the union.
 *
 * `PROVIDER_PRESETS` is `as const`, so each entry has its own exact type and
 * only some carry these keys — reading one off the union does not typecheck
 * even though the lookup is safe.
 */
export function presetCapabilities(id: ProviderPresetId, model?: string): {
    defaultMaxTokens?: number;
    /** The most output tokens the provider accepts; a request above it is a 400. */
    maxOutputTokens?: number;
    supportsReasoningEffort?: boolean;
    supportsVision?: boolean;
    /** Per-provider respellings of effort tiers the endpoint refuses. */
    reasoningEffortAliases?: Record<string, string>;
} {
    const preset = (PROVIDER_PRESETS[id] ?? {}) as {
        defaultMaxTokens?: number;
        maxOutputTokens?: number;
        maxOutputTokensByModel?: (model: string) => number;
        supportsReasoningEffort?: boolean;
        supportsReasoningEffortByModel?: (model: string) => boolean;
        supportsVision?: boolean;
        reasoningEffortAliases?: Record<string, string>;
        reasoningEffortAliasesByModel?: (model: string) => Record<string, string>;
        defaultModel?: string;
    };
    // A preset can host models with different capabilities, so anything that
    // varies by model is resolved against the model actually chosen — falling
    // back to the preset's default, which is what an unset (or empty)
    // preference means.
    const chosen = model || preset.defaultModel;
    return {
        defaultMaxTokens: preset.defaultMaxTokens,
        maxOutputTokens:
            preset.maxOutputTokensByModel !== undefined && chosen
                ? preset.maxOutputTokensByModel(chosen)
                : preset.maxOutputTokens,
        supportsReasoningEffort:
            preset.supportsReasoningEffortByModel !== undefined
                ? chosen !== undefined && preset.supportsReasoningEffortByModel(chosen)
                : preset.supportsReasoningEffort,
        supportsVision: presetSupportsVision(id, chosen),
        reasoningEffortAliases:
            preset.reasoningEffortAliasesByModel !== undefined && chosen !== undefined
                ? preset.reasoningEffortAliasesByModel(chosen)
                : preset.reasoningEffortAliases,
    };
}

/**
 * Image support learned from an endpoint rather than declared, per
 * `preset:model`. Written by the probe in visionProbe.ts; read below so that
 * everything keyed on `presetSupportsVision` — the picker's "reads figures",
 * the attachment checks, the provider config — moves together.
 */
const probedVision = new Map<string, boolean>();

/**
 * Image support the user declared in a provider's catalogue (providerOverrides.ts),
 * for a model the preset knows nothing about. A Check's verdict outranks it.
 */
const declaredVision = new Map<string, boolean>();

const probeKey = (id: ProviderPresetId, model: string) => `${id}:${model}`;

export function recordDeclaredVision(id: ProviderPresetId, model: string, seesImages: boolean): void {
    declaredVision.set(probeKey(id, model), seesImages);
}

/** Test seam and re-hydration point: forget every declared flag. */
export function resetDeclaredVision(): void {
    declaredVision.clear();
}

export function recordProbedVision(id: ProviderPresetId, model: string, seesImages: boolean): void {
    probedVision.set(probeKey(id, model), seesImages);
}

/** The probe's last verdict for a model, or undefined when it has not run. */
export function probedVisionFor(id: ProviderPresetId, model: string): boolean | undefined {
    return probedVision.get(probeKey(id, model));
}

/** Whether a preset's models are asked about images rather than declared. */
export function presetVisionByProbe(id: ProviderPresetId): boolean {
    return (PROVIDER_PRESETS[id] as { visionByProbe?: boolean } | undefined)?.visionByProbe === true;
}

/** Test seam: forget every probe verdict. */
export function resetProbedVision(): void {
    probedVision.clear();
}

/**
 * Whether one model on a preset can read images.
 *
 * `supportsVision` is declared per preset, but a preset is a gateway, not a
 * model: OpenRouter serves both a vision model and a text-only one behind the
 * same key. A preset lists the exceptions in `textOnlyModels`; everything else
 * inherits the preset's own answer. A preset that is text-only on paper may be
 * serving a multimodal successor behind an unchanged id (`visionByProbe`), and
 * then the probe's verdict wins.
 */
export function presetSupportsVision(
    id: ProviderPresetId,
    model?: string,
): boolean | undefined {
    const preset = PROVIDER_PRESETS[id] as
        | { supportsVision?: boolean; textOnlyModels?: readonly string[]; defaultModel?: string }
        | undefined;
    const chosen = model ?? preset?.defaultModel;
    if (chosen !== undefined) {
        // What a Check found outranks what was declared, which outranks the preset.
        const probed = probedVision.get(probeKey(id, chosen));
        if (probed !== undefined) return probed;
        const declared = declaredVision.get(probeKey(id, chosen));
        if (declared !== undefined) return declared;
    }
    if (preset?.supportsVision !== true) return preset?.supportsVision;
    if (chosen === undefined) return true;
    return !(preset.textOnlyModels ?? []).includes(chosen);
}

/** Whether a model takes an effort, and the least one it accepts: `none`, or what it says instead. */
function leastEffort(caps: ReturnType<typeof presetCapabilities>): Pick<ProviderConfig, 'supportsReasoningEffort' | 'leastReasoningEffort'> {
    return caps.supportsReasoningEffort
        ? { supportsReasoningEffort: true, leastReasoningEffort: caps.reasoningEffortAliases?.none ?? 'none' }
        : { supportsReasoningEffort: false };
}

export function providerFromPreset(
    id: ProviderPresetId,
    apiKey: string,
    fetchImpl: FetchLike,
    overrides: Partial<
        Pick<
            ProviderConfig,
            'model' | 'baseUrl' | 'maxTokens' | 'temperature' | 'extraBody' | 'supportsReasoningEffort' | 'leastReasoningEffort'
        >
    > = {},
): OpenAICompatibleProvider {
    const preset = PROVIDER_PRESETS[id] as (typeof PROVIDER_PRESETS)[ProviderPresetId] & {
        authStyle?: ProviderConfig['authStyle'];
        maxTokensParam?: ProviderConfig['maxTokensParam'];
        extraBody?: Record<string, unknown>;
        imagesInToolResults?: boolean;
        supportsVision?: boolean;
        textOnlyModels?: readonly string[];
        defaultMaxTokens?: number;
        reasoningSummary?: boolean;
        promptCacheRetention?: string;
        streamTimeouts?: StreamTimeouts;
        sessionHeader?: string;
    };
    // Resolved once: several fields below depend on which model was chosen,
    // and computing it separately for each is how they drift apart.
    const chosenModel = overrides.model || preset.defaultModel;
    return new OpenAICompatibleProvider(
        {
            label: preset.label,
            baseUrl: overrides.baseUrl ?? preset.baseUrl,
            apiKey,
            model: chosenModel,
            wireFormat: preset.wireFormat,
            maxTokens: overrides.maxTokens ?? preset.defaultMaxTokens,
            temperature: overrides.temperature,
            authStyle: preset.authStyle,
            maxTokensParam: preset.maxTokensParam,
            // A preset quirk is a floor, not a default: an override adds to it
            // rather than dropping the field the endpoint requires.
            extraBody: { ...(preset.extraBody ?? {}), ...(overrides.extraBody ?? {}) },
            imagesInToolResults: preset.imagesInToolResults,
            supportsVision: presetSupportsVision(id, chosenModel),
            // The model's own list of tiers, when the caller resolved one (the
            // user may have changed it), else what the preset knows.
            ...(overrides.supportsReasoningEffort !== undefined
                ? {
                    supportsReasoningEffort: overrides.supportsReasoningEffort,
                    ...(overrides.supportsReasoningEffort ? { leastReasoningEffort: overrides.leastReasoningEffort ?? 'none' } : {}),
                }
                : leastEffort(presetCapabilities(id, chosenModel))),
            reasoningSummary: preset.reasoningSummary,
            promptCacheRetention: preset.promptCacheRetention,
            ...(preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
        },
        fetchImpl,
        preset.streamTimeouts ?? HOSTED_STREAM_TIMEOUTS,
    );
}
