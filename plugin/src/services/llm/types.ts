/**
 * Provider-agnostic chat types.
 *
 * Deliberately narrow: this is the contract the agent loop programs against, so
 * adding a provider must not widen it. Wire-format quirks belong in the
 * provider, not here.
 */

import type { StopReason, StreamEvent, TokenUsage, WireFormat } from './sse';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * One piece of a multimodal message.
 *
 * Images are carried as raw base64 plus a MIME type rather than a data URL, so
 * a provider can render whichever envelope its wire format wants without having
 * to parse the string back apart.
 */
export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; base64: string; label?: string };

/** A plain string stays a string — the common case pays no cost for parts. */
export type MessageContent = string | ContentPart[];

/** A tool result being fed back to the model. */
export interface ToolResultMessage {
    role: 'tool';
    toolCallId: string;
    name: string;
    /**
     * Serialized result, or content parts when the tool returned images (a
     * rendered PDF page, a figure). Not every endpoint accepts image parts in a
     * `tool` message — see `imagesInToolResults` on ProviderConfig.
     */
    content: MessageContent;
}

export interface AssistantMessage {
    role: 'assistant';
    content: string;
    /**
     * Present when the turn ended in tool calls. `extraContent` is whatever
     * the provider attached to a call to have it sent back (Gemini's thought
     * signature); like `reasoningItems` it lives only in memory, which is
     * enough: Gemini checks it on the turn being answered, not on history.
     */
    toolCalls?: Array<{ id: string; name: string; argumentsJson: string; extraContent?: Record<string, unknown> }>;
    /**
     * The reasoning items a Responses-API model produced on this turn, as it
     * sent them (encrypted, with the summary). Sent back ahead of the turn's
     * calls on the next request of the same run, so the model keeps its train
     * of thought across tool steps instead of reasoning from scratch at each.
     * Lives only in memory: a saved conversation replays without them.
     */
    reasoningItems?: Array<Record<string, unknown>>;
}

export interface PlainMessage {
    role: 'system' | 'user';
    content: MessageContent;
}

export type ChatMessage = PlainMessage | AssistantMessage | ToolResultMessage;

/** Data URL form, which is what OpenAI-style `image_url` parts carry. */
export function toDataUrl(part: { mimeType: string; base64: string }): string {
    return `data:${part.mimeType};base64,${part.base64}`;
}

/** Does this message carry any image? Used to route around endpoint limits. */
export function hasImageParts(content: MessageContent): boolean {
    return Array.isArray(content) && content.some((part) => part.type === 'image');
}

/** Flatten content to text, describing images rather than dropping them silently. */
export function contentToText(content: MessageContent): string {
    if (typeof content === 'string') return content;
    return content
        .map((part) =>
            part.type === 'text'
                ? part.text
                : `[image omitted: ${part.label ?? part.mimeType}]`,
        )
        .join('\n');
}

/** JSON Schema for one tool, in the shape every provider accepts. */
export interface ToolSchema {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

/**
 * How the key is presented. Most OpenAI-compatible endpoints take a bearer
 * token; some API gateways read `X-Api-Key` instead, and a few reject a
 * bearer token outright.
 */
export type AuthStyle = 'bearer' | 'x-api-key';

/**
 * Which field carries the output cap on `/chat/completions`. OpenAI's reasoning
 * models accept only `max_completion_tokens` and 400 on `max_tokens`. The
 * Responses wire has one name for it, `max_output_tokens`, and ignores this.
 */
export type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';

export interface ProviderConfig {
    /** Display name, used in logs and errors. */
    label: string;
    /** Base URL without a trailing slash, e.g. `https://api.deepseek.com/v1`. */
    baseUrl: string;
    apiKey: string;
    model: string;
    wireFormat: WireFormat;
    /** Omitted means the provider default. */
    maxTokens?: number;
    temperature?: number;
    /** Extra headers, e.g. Anthropic's version pin. */
    headers?: Record<string, string>;
    /** Defaults to `bearer`. */
    authStyle?: AuthStyle;
    /** Defaults to `max_tokens`. */
    maxTokensParam?: MaxTokensParam;
    /**
     * Fields merged into every request body, last, so an endpoint quirk can
     * override anything the request builder set.
     *
     * The thinking effort travels here as `reasoning_effort`, the
     * chat-completions spelling. On the Responses wire it is lifted out and
     * sent as `reasoning.effort` instead.
     */
    extraBody?: Record<string, unknown>;
    /**
     * Whether a tool result may carry image parts: a `tool` message on
     * `/chat/completions`, a `function_call_output` on the Responses wire.
     *
     * OpenAI's chat spec says a tool message's content is a string, so this is
     * not a safe assumption — but some gateways accept image parts there,
     * and that is the tidy shape: the tool that rendered a page returns the
     * page. When false, images are lifted out into a follow-up `user` message
     * and the tool result keeps a text placeholder, which every endpoint accepts.
     */
    imagesInToolResults?: boolean;
    /** Set when the configured model can read images at all. */
    supportsVision?: boolean;
    /**
     * Ask the endpoint to report token usage in the stream. On by default: two
     * of the three providers here need the request, the third accepts it and
     * reports usage regardless. Set false only for an endpoint that rejects it.
     */
    streamUsage?: boolean;
    /**
     * The model takes a thinking effort. On the Responses wire it is sent on
     * every request — the configured one, or the least it accepts when none
     * is configured — because a reasoning model left to its own default may
     * spend a small budget thinking. A model that takes none (gpt-4o) is sent
     * no `reasoning` at all: the field is a 400 there.
     */
    supportsReasoningEffort?: boolean;
    /**
     * The effort sent when none is configured, and on `/chat/completions`
     * whenever tools are offered: the least the model accepts. `none` for
     * most; the models that refuse it start at `low` or `minimal`.
     */
    leastReasoningEffort?: string;
    /**
     * Responses wire only: ask for a summary of the model's thinking, which is
     * what the run shows as its thinking. Without it the model still thinks;
     * nothing of it is shown.
     */
    reasoningSummary?: boolean;
    /**
     * Responses wire only: `prompt_cache_retention`, e.g. `"24h"`. Every run
     * resends the whole conversation, and follow-up questions come minutes or
     * hours apart, so a cache that outlives the default few minutes is what
     * makes the second question cheap.
     */
    promptCacheRetention?: string;
}

export interface ChatRequest {
    messages: ChatMessage[];
    tools?: ToolSchema[];
    /** Aborts the in-flight request and closes the stream. */
    signal?: AbortSignal;
}

export interface ChatProvider {
    readonly label: string;
    readonly model: string;
    readonly wireFormat: WireFormat;
    /**
     * Stream one assistant turn. Emits through `onEvent` and resolves once the
     * stream has closed. Implementations must emit exactly one terminal
     * (`done` or `error`) event — the loop relies on that bracket.
     */
    stream(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<void>;
}

export type { StopReason, StreamEvent, TokenUsage, WireFormat };
