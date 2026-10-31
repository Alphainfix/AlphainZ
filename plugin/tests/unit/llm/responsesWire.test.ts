/**
 * OpenAI's Responses wire, which OpenAI itself and gateways in front of it
 * speak. It is where its reasoning models take a thinking effort together with
 * function tools.
 *
 * The stream fixtures follow the event sequences a gateway in front of OpenAI
 * sent on 2026-10-13: a plain answer; a reasoning item (summary streamed in
 * parts, encrypted content on its finished item) followed by a function call;
 * an image read back from inside a `function_call_output`.
 */
import { describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { isModelRequestError, parseSseStream, type StreamEvent } from '../../../src/services/llm/sse';
import {
    presetCapabilities,
    providerFromPreset,
    toResponsesInput,
    toResponsesTools,
    type FetchLike,
} from '../../../src/services/llm/openAICompatible';
import { providerSupportsReasoningEffort } from '../../../src/services/llm/agentConfig';
import { customProviderFromEndpoint, type CustomEndpoint } from '../../../src/services/llm/customEndpoints';
import { runAgentLoop } from '../../../src/services/llm/agentLoop';
import { PROBE_CODE, PROBE_IMAGE_DATA_URL, probeVision } from '../../../src/services/llm/visionProbe';
import type { ChatMessage, ToolSchema } from '../../../src/services/llm/types';

// ---------------------------------------------------------------------------
// Helpers and fixtures
// ---------------------------------------------------------------------------

/** One event as the gateway frames it: an `event:` line naming it, then its data. */
const ev = (payload: Record<string, unknown>) => `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;

/** A reader over the chunks; `hangAfter` holds the connection open after the last one. */
function readerOf(chunks: string[], hangAfter = false): ReadableStreamDefaultReader<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        read() {
            if (i < chunks.length) return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) });
            return hangAfter ? new Promise(() => undefined) : Promise.resolve({ done: true, value: undefined });
        },
        cancel: () => Promise.resolve(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function decode(chunks: string[], options: { hangAfter?: boolean; idleTimeoutMs?: number } = {}) {
    const events: StreamEvent[] = [];
    await parseSseStream(readerOf(chunks, options.hangAfter), 'openai-responses', (e) => events.push(e), {
        label: 'Gateway',
        idleTimeoutMs: options.idleTimeoutMs,
    });
    return events;
}

const textOf = (events: StreamEvent[]) =>
    events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
const thinkingOf = (events: StreamEvent[]) =>
    events.filter((e) => e.type === 'reasoning').map((e) => (e as { text: string }).text).join('');
const doneOf = (events: StreamEvent[]) => events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }> | undefined;
const errorOf = (events: StreamEvent[]) => (events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }> | undefined)?.error;

const created = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [], usage: null } };
const inProgress = { type: 'response.in_progress', response: { id: 'resp_1', status: 'in_progress', output: [], usage: null } };
const usage = (input: number, cached: number, output: number, reasoning = 0) => ({
    input_tokens: input,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
});
const completed = (output: unknown[], used = usage(100, 0, 10)) => ({
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', output, usage: used },
});

const messageItem = (text: string) => ({
    id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
});

/** A plain answer, "4729", as the gateway streamed it after reading an image. */
const PLAIN_ANSWER = [
    ev(created),
    ev(inProgress),
    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
    ev({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg_1', part: { type: 'output_text', text: '' } }),
    ev({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: '47' }),
    ev({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: '29' }),
    ev({ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_1', text: '4729' }),
    ev({ type: 'response.output_item.done', output_index: 0, item: messageItem('4729') }),
    ev(completed([messageItem('4729')], usage(235, 128, 6))),
];

const REASONING_ITEM = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [
        { type: 'summary_text', text: '**Calculating prime number**\n\nThe 7th prime is 17.' },
        { type: 'summary_text', text: '**Choosing the page**\n\n17 minus 14 is 3.' },
    ],
    encrypted_content: 'gAAAA-encrypted-1',
    content: null,
};
const CALL_ITEM = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_A', name: 'get_page_image', arguments: '{"page":3}' };

/** Think, then call a tool: the shape of a step in the middle of a run. */
const THINK_THEN_CALL = [
    ev(created),
    ev(inProgress),
    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
    ev({ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, item_id: 'rs_1' }),
    ev({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, item_id: 'rs_1', delta: '**Calculating prime number**\n\n' }),
    ev({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, item_id: 'rs_1', delta: 'The 7th prime is 17.' }),
    ev({ type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 1, item_id: 'rs_1' }),
    ev({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, item_id: 'rs_1', delta: '**Choosing the page**\n\n17 minus 14 is 3.' }),
    ev({ type: 'response.output_item.done', output_index: 0, item: REASONING_ITEM }),
    ev({ type: 'response.output_item.added', output_index: 1, item: { ...CALL_ITEM, status: 'in_progress', arguments: '' } }),
    ev({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"page"' }),
    ev({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: ':3}' }),
    ev({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_1', arguments: '{"page":3}' }),
    ev({ type: 'response.output_item.done', output_index: 1, item: CALL_ITEM }),
    ev(completed([REASONING_ITEM, CALL_ITEM], usage(88, 0, 44, 23))),
];

const TOOL: ToolSchema = {
    name: 'get_page_image',
    description: 'Render one page of the open paper as an image.',
    parameters: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
};

const IMAGE = { type: 'image' as const, mimeType: 'image/png', base64: 'iVBOR', label: 'page 3' };

// ---------------------------------------------------------------------------
// Reading the stream
// ---------------------------------------------------------------------------

describe('a Responses stream', () => {
    it('reads the answer, the usage and the end of the reply', async () => {
        const events = await decode(PLAIN_ANSWER);
        expect(textOf(events)).toBe('4729');
        const done = doneOf(events)!;
        expect(done.stopReason).toBe('end_turn');
        expect(done.toolCalls).toEqual([]);
        expect(done.usage).toEqual({ promptTokens: 235, completionTokens: 6, totalTokens: 241, cachedTokens: 128 });
        expect(done).not.toHaveProperty('reasoningItems');
    });

    it('shows the thinking summary part by part, and calls the tool by its call_id', async () => {
        const events = await decode(THINK_THEN_CALL);
        expect(thinkingOf(events)).toBe(
            '**Calculating prime number**\n\nThe 7th prime is 17.\n\n**Choosing the page**\n\n17 minus 14 is 3.',
        );
        const start = events.find((e) => e.type === 'tool_call_start') as Extract<StreamEvent, { type: 'tool_call_start' }>;
        // The `fc_` item id is the server's; the call is answered by `call_id`.
        expect(start).toMatchObject({ id: 'call_A', name: 'get_page_image' });
        const done = doneOf(events)!;
        expect(done.stopReason).toBe('tool_calls');
        expect(done.toolCalls).toEqual([{ index: 1, id: 'call_A', name: 'get_page_image', argumentsJson: '{"page":3}' }]);
        expect(done.usage?.completionTokens).toBe(44);
    });

    it('keeps the encrypted reasoning, to send back with the call', async () => {
        const done = doneOf(await decode(THINK_THEN_CALL))!;
        expect(done.reasoningItems).toEqual([
            { type: 'reasoning', id: 'rs_1', summary: REASONING_ITEM.summary, encrypted_content: 'gAAAA-encrypted-1' },
        ]);
    });

    it('takes the encrypted content from the finished response when the item left it off', async () => {
        const bare = { ...REASONING_ITEM, encrypted_content: undefined };
        const events = await decode([
            ev({ type: 'response.output_item.done', output_index: 0, item: bare }),
            ev({ type: 'response.output_item.done', output_index: 1, item: CALL_ITEM }),
            ev(completed([REASONING_ITEM, CALL_ITEM])),
        ]);
        expect(doneOf(events)!.reasoningItems?.[0]).toMatchObject({ id: 'rs_1', encrypted_content: 'gAAAA-encrypted-1' });
    });

    it('drops a reasoning item that cannot be sent back', async () => {
        // Requests go out with `store: false`: without its encrypted content
        // the server could not resolve the item, and the next request would fail.
        const bare = { ...REASONING_ITEM, encrypted_content: undefined };
        const events = await decode([
            ev({ type: 'response.output_item.done', output_index: 0, item: bare }),
            ev(completed([bare])),
        ]);
        expect(doneOf(events)).not.toHaveProperty('reasoningItems');
    });

    it('stops reading at the terminal event, even if the connection stays open', async () => {
        const events = await decode(PLAIN_ANSWER, { hangAfter: true, idleTimeoutMs: 50 });
        expect(errorOf(events)).toBeUndefined();
        expect(doneOf(events)?.stopReason).toBe('end_turn');
    });

    it('fills in what the deltas missed from the finished items', async () => {
        const events = await decode([
            ev({ type: 'response.output_text.delta', output_index: 0, delta: '47' }),
            ev({ type: 'response.output_item.done', output_index: 0, item: messageItem('4729') }),
            ev({ type: 'response.output_item.added', output_index: 1, item: { ...CALL_ITEM, arguments: '' } }),
            ev({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"pa' }),
            ev({ type: 'response.output_item.done', output_index: 1, item: CALL_ITEM }),
            ev(completed([])),
        ]);
        expect(textOf(events)).toBe('4729');
        expect(doneOf(events)!.toolCalls[0].argumentsJson).toBe('{"page":3}');
    });

    it('ends a reply cut by the output cap as `length`, and a filtered one as `content_filter`', async () => {
        const incomplete = (reason: string) => ev({
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason }, output: [], usage: usage(10, 0, 16, 16) },
        });
        expect(doneOf(await decode([incomplete('max_output_tokens')]))?.stopReason).toBe('length');
        expect(doneOf(await decode([incomplete('content_filter')]))?.stopReason).toBe('content_filter');
        const other = errorOf(await decode([incomplete('something_new')]));
        expect(isModelRequestError(other) && other.retryable).toBe(false);
        expect(other?.message).toContain('something_new');
    });

    it('reports a failed response and an error event in the provider\'s words', async () => {
        const failed = errorOf(await decode([
            ev(created),
            ev({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'The server had an error.' } } }),
        ]));
        expect(failed?.message).toContain('The server had an error.');
        // A server error may pass on a second try; a refused request will not.
        expect(isModelRequestError(failed) && failed.retryable).toBe(true);

        const refused = errorOf(await decode([
            ev({ type: 'error', code: 'invalid_prompt', message: 'Invalid prompt: flagged.', param: null }),
        ]));
        expect(refused?.message).toContain('Invalid prompt: flagged.');
        expect(isModelRequestError(refused) && refused.retryable).toBe(false);
    });

    it('retries a transient error the gateway sends as a 200 body, and not a spent quota', async () => {
        const body = (code: string) => JSON.stringify({ error: { message: 'Something went wrong.', type: code, code } });
        const transient = errorOf(await decode([body('server_error')]));
        expect(isModelRequestError(transient) && transient.retryable).toBe(true);
        const quota = errorOf(await decode([body('insufficient_quota')]));
        expect(isModelRequestError(quota) && quota.retryable).toBe(false);
    });

    it('surfaces the JSON error the gateway sends as a 200 "event stream"', async () => {
        // A refused parameter on a streaming request: HTTP 200, text/event-stream,
        // and a pretty-printed JSON error with no frames at all (2026-10-13).
        const body = JSON.stringify({
            error: {
                message: "Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model.",
                type: 'invalid_request_error',
                param: 'reasoning.effort',
                code: 'unsupported_value',
            },
        }, null, 2);
        const error = errorOf(await decode([body]));
        expect(error?.message).toContain("'minimal' is not supported");
        expect(isModelRequestError(error) && error.retryable).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Building the request
// ---------------------------------------------------------------------------

describe('the Responses input', () => {
    it('puts the system prompt in instructions and a later system message in a developer message', () => {
        const { instructions, input } = toResponsesInput([
            { role: 'system', content: 'You are AlphainZ.' },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello.' },
            { role: 'system', content: 'Summary of the earlier conversation.' },
            { role: 'user', content: [{ type: 'text', text: 'What is on this page?' }, IMAGE] },
        ]);
        expect(instructions).toBe('You are AlphainZ.');
        expect(input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
            { role: 'assistant', content: 'Hello.' },
            { role: 'developer', content: 'Summary of the earlier conversation.' },
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'What is on this page?' },
                    { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' },
                ],
            },
        ]);
    });

    it('sends the turn\'s reasoning back ahead of its calls, and each call by call_id alone', () => {
        const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' };
        const { input } = toResponsesInput([
            { role: 'user', content: 'Which page?' },
            {
                role: 'assistant',
                content: 'Let me look.',
                toolCalls: [{ id: 'call_A', name: 'get_page_image', argumentsJson: '{"page":3}' }, { id: 'call_B', name: 'list', argumentsJson: '' }],
                reasoningItems: [reasoning],
            },
            { role: 'tool', toolCallId: 'call_A', name: 'get_page_image', content: '{"ok":true}' },
            { role: 'tool', toolCallId: 'call_B', name: 'list', content: '[]' },
        ]);
        expect(input.slice(1)).toEqual([
            reasoning,
            { role: 'assistant', content: 'Let me look.' },
            { type: 'function_call', call_id: 'call_A', name: 'get_page_image', arguments: '{"page":3}' },
            { type: 'function_call', call_id: 'call_B', name: 'list', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_A', output: '{"ok":true}' },
            { type: 'function_call_output', call_id: 'call_B', output: '[]' },
        ]);
    });

    it('answers a call the history never answered and drops a result nobody asked for', () => {
        const { input } = toResponsesInput([
            { role: 'user', content: 'Go' },
            { role: 'tool', toolCallId: 'stray', name: 'x', content: 'orphan' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call_A', name: 'search', argumentsJson: '{}' }] },
            { role: 'user', content: 'Never mind.' },
        ]);
        expect(input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'Go' }] },
            { type: 'function_call', call_id: 'call_A', name: 'search', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_A', output: JSON.stringify({ error: 'This tool call did not complete.' }) },
            { role: 'user', content: [{ type: 'input_text', text: 'Never mind.' }] },
        ]);
    });

    const withImageResult: ChatMessage[] = [
        { role: 'user', content: 'Read page 3.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_A', name: 'view_page_images', argumentsJson: '{"page":3}' }] },
        { role: 'tool', toolCallId: 'call_A', name: 'view_page_images', content: [{ type: 'text', text: 'Page 3:' }, IMAGE] },
    ];

    it('keeps a page image inside the tool result where the endpoint takes it there', () => {
        const { input } = toResponsesInput(withImageResult, { imagesInToolResults: true });
        expect(input.at(-1)).toEqual({
            type: 'function_call_output',
            call_id: 'call_A',
            output: [
                { type: 'input_text', text: 'Page 3:' },
                { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' },
            ],
        });
    });

    it('lifts it into the next user message where it does not', () => {
        const { input } = toResponsesInput(withImageResult);
        expect(input.slice(-2)).toEqual([
            { type: 'function_call_output', call_id: 'call_A', output: 'Page 3:\n[image omitted: page 3]' },
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'Images returned by view_page_images:' },
                    { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' },
                ],
            },
        ]);
    });

    it('sends a model that cannot read images a notice instead', () => {
        const { input } = toResponsesInput(withImageResult, { imagesInToolResults: true, supportsVision: false });
        expect(input.at(-1)).toMatchObject({ type: 'function_call_output', output: expect.stringContaining('this model cannot read images') });
    });

    it('describes tools flat, and not in strict mode', () => {
        expect(toResponsesTools([TOOL])).toEqual([
            { type: 'function', name: 'get_page_image', description: TOOL.description, parameters: TOOL.parameters, strict: false },
        ]);
    });
});

describe('a request to a gateway added with the Responses API', () => {
    const endpoint: CustomEndpoint = {
        id: 'ep-gw',
        name: 'Gateway',
        baseUrl: 'https://gateway.example.edu/v2',
        apiKey: 'secret',
        authStyle: 'x-api-key',
        wireFormat: 'openai-responses',
        models: [{
            id: 'gpt-6-luna', supportsVision: true, reasoningEffort: true,
            efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        }],
    };
    const gateway = (overrides: { maxTokens?: number; extraBody?: Record<string, unknown> } = {}, fetchImpl?: FetchLike) =>
        customProviderFromEndpoint(endpoint, 'gpt-6-luna', fetchImpl ?? ((async () => { throw new Error('unused'); }) as unknown as FetchLike), overrides);

    it('is a Responses request: whole conversation, nothing stored, thinking at the chosen effort', () => {
        const body = gateway({ extraBody: { reasoning_effort: 'low' }, maxTokens: 32_000 }).buildBody({
            messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }],
            tools: [TOOL],
        });
        expect(body).toMatchObject({
            model: 'gpt-6-luna',
            instructions: 'Be brief.',
            stream: true,
            store: false,
            max_output_tokens: 32_000,
            reasoning: { effort: 'low', summary: 'auto' },
            include: ['reasoning.encrypted_content'],
            tool_choice: 'auto',
        });
        expect(body).not.toHaveProperty('messages');
        expect(body).not.toHaveProperty('stream_options');
        expect(body).not.toHaveProperty('reasoning_effort');
        expect(body).not.toHaveProperty('max_completion_tokens');
    });

    it('never asks for fewer than the 16 output tokens the API accepts', () => {
        expect(gateway({ maxTokens: 4 }).buildBody({ messages: [{ role: 'user', content: 'Hi' }] }).max_output_tokens).toBe(16);
    });

    it('goes to /responses with the key in X-Api-Key', async () => {
        const calls: Array<{ url: string; init: any }> = [];
        const fetchImpl = (async (url: string, init: any) => {
            calls.push({ url, init });
            const reader = readerOf(PLAIN_ANSWER);
            return { ok: true, status: 200, text: async () => '', body: { getReader: () => reader } };
        }) as unknown as FetchLike;
        const events: StreamEvent[] = [];
        await gateway({}, fetchImpl).stream({ messages: [{ role: 'user', content: 'Hi' }] }, (e) => events.push(e));
        expect(calls[0].url).toBe('https://gateway.example.edu/v2/responses');
        expect(calls[0].init.headers['X-Api-Key']).toBe('secret');
        expect(calls[0].init.headers).not.toHaveProperty('Authorization');
        expect(textOf(events)).toBe('4729');
    });

});

describe('the OpenAI preset', () => {
    it('offers the thinking dial for the reasoning models, and not for gpt-4o', () => {
        expect(providerSupportsReasoningEffort('openai', 'gpt-6-luna')).toBe(true);
        expect(providerSupportsReasoningEffort('openai', 'o4-mini')).toBe(true);
        expect(providerSupportsReasoningEffort('openai', 'gpt-4o-mini')).toBe(false);
        // The model picker passes an empty snapshot for "the preset's default", gpt-4o.
        expect(providerSupportsReasoningEffort('openai', '')).toBe(false);
        expect(presetCapabilities('openai').defaultMaxTokens).toBe(32_000);
    });
});

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

describe('a run on the Responses wire', () => {
    it('sends the model\'s reasoning back with its call on the next step', async () => {
        const bodies: any[] = [];
        const replies = [THINK_THEN_CALL, PLAIN_ANSWER];
        const fetchImpl = (async (_url: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            const reader = readerOf(replies[bodies.length - 1]);
            return { ok: true, status: 200, text: async () => '', body: { getReader: () => reader } };
        }) as unknown as FetchLike;
        const provider = providerFromPreset('openai', 'secret', fetchImpl, { model: 'gpt-6-luna', extraBody: { reasoning_effort: 'low' } });
        const thinking: string[] = [];

        const result = await runAgentLoop(
            [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Which number is on the page?' }],
            {
                provider,
                tools: [TOOL],
                dispatch: async () => ({ kind: 'tool-images', text: 'Page 3:', images: [{ mimeType: 'image/png', base64: 'iVBOR' }] }),
                onEvent: (event) => { if (event.type === 'reasoning') thinking.push(event.text); },
            },
        );

        expect(result.error).toBeUndefined();
        expect(result.text).toBe('4729');
        expect(thinking.join('')).toContain('17 minus 14 is 3.');
        expect(bodies).toHaveLength(2);
        const second = bodies[1].input;
        const at = (type: string) => second.findIndex((item: any) => item.type === type);
        expect(second[at('reasoning')]).toEqual({
            type: 'reasoning', id: 'rs_1', summary: REASONING_ITEM.summary, encrypted_content: 'gAAAA-encrypted-1',
        });
        expect(at('reasoning')).toBeLessThan(at('function_call'));
        expect(second[at('function_call')]).toEqual({ type: 'function_call', call_id: 'call_A', name: 'get_page_image', arguments: '{"page":3}' });
        expect(second[at('function_call_output')]).toMatchObject({ call_id: 'call_A' });
        // OpenAI takes no image in a tool result, so the page follows it in a user message.
        expect(second.slice(at('function_call_output') + 1)).toContainEqual(expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([{ type: 'input_image', image_url: 'data:image/png;base64,iVBOR' }]),
        }));
    });
});

// ---------------------------------------------------------------------------
// The catalogue's Check
// ---------------------------------------------------------------------------

describe('the image Check on a Responses preset', () => {
    const answering = (text: string, inputTokens = 160) => {
        const calls: Array<{ url: string; body: any }> = [];
        const fetchImpl = vi.fn(async (url: string, init: any) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return {
                status: 200,
                json: async () => ({ output: [messageItem(text)], usage: { input_tokens: inputTokens } }),
            };
        });
        return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
    };
    const target = (model: string) => ({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'k',
        authStyle: 'bearer' as const,
        model,
        presetId: 'openai' as const,
    });

    it('asks on /responses, with thinking off, the way a run would', async () => {
        const { fetchImpl, calls } = answering(PROBE_CODE);
        const verdict = await probeVision(target('gpt-6-luna'), fetchImpl);
        expect(verdict.seesImages).toBe(true);
        expect(calls[0].url).toMatch(/\/responses$/);
        expect(calls[0].body).toMatchObject({ model: 'gpt-6-luna', stream: false, store: false, reasoning: { effort: 'none' } });
        expect(calls[0].body.max_output_tokens).toBeGreaterThanOrEqual(16);
        expect(calls[0].body.input[0].content).toContainEqual({ type: 'input_image', image_url: PROBE_IMAGE_DATA_URL });
        expect(calls[0].body).not.toHaveProperty('max_tokens');
    });

    it('gives a model that cannot stop thinking its least effort and room to answer', async () => {
        const { fetchImpl, calls } = answering(PROBE_CODE);
        await probeVision({ ...target('o4-mini'), presetId: 'openai' }, fetchImpl);
        expect(calls[0].body.reasoning).toEqual({ effort: 'low' });
        expect(calls[0].body.max_output_tokens).toBeGreaterThanOrEqual(1024);
    });

    it('judges the bill by what OpenAI\'s tokenizer charges for the image', async () => {
        // The question alone is 36 input tokens on GPT-6, 55 with the image
        // (measured on the gateway): seeing at 55, the image never arriving at 36.
        expect((await probeVision(target('gpt-6-luna'), answering(PROBE_CODE, 55).fetchImpl)).seesImages).toBe(true);
        expect((await probeVision(target('gpt-6-luna'), answering(PROBE_CODE, 36).fetchImpl)).seesImages).toBe(false);
    });

    it('sends no reasoning to a model that refuses it', async () => {
        const { fetchImpl, calls } = answering(PROBE_CODE);
        await probeVision(target('gpt-4o-mini'), fetchImpl);
        expect(calls[0].body).not.toHaveProperty('reasoning');
    });

    it('still asks a hand-added endpoint on /chat/completions', async () => {
        const calls: string[] = [];
        const fetchImpl = (async (url: string) => {
            calls.push(url);
            return { status: 200, json: async () => ({ choices: [{ message: { content: PROBE_CODE } }], usage: { prompt_tokens: 160 } }) };
        }) as unknown as FetchLike;
        const { presetId: _drop, ...custom } = target('some-model');
        await probeVision(custom, fetchImpl);
        expect(calls[0]).toMatch(/\/chat\/completions$/);
    });
});
