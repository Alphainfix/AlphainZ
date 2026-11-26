import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { classifyRunError, runLocalAgent, type LocalRunCallbacks } from '@beaver/agent-llm/localRunner';
import { ModelRequestError } from '@beaver/agent-llm/sse';
import type { ChatProvider, StreamEvent, ToolSchema } from '@beaver/agent-llm/types';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** Records every callback the runner fires, in order. */
function recorder() {
    const events: Array<{ kind: string; payload?: any }> = [];
    const push = (kind: string) => (payload?: any) => {
        events.push({ kind, payload });
    };
    const callbacks: LocalRunCallbacks = {
        onThread: (threadId) => events.push({ kind: 'thread', payload: threadId }),
        onReady: push('ready'),
        onPart: push('part'),
        onToolCallArgsStream: push('args'),
        onToolReturn: push('toolReturn'),
        onToolCallProgress: push('progress'),
        onRunComplete: push('runComplete'),
        onDone: () => events.push({ kind: 'done' }),
        onError: push('error'),
        onWarning: push('warning'),
    };
    return { callbacks, events };
}

type Script = Array<(emit: (e: StreamEvent) => void) => void>;

function scriptedProvider(script: Script): ChatProvider {
    let turn = 0;
    return {
        label: 'Fake',
        model: 'fake-1',
        wireFormat: 'openai',
        async stream(_request, onEvent) {
            const step = script[turn++];
            if (!step) {
                onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                return;
            }
            step(onEvent);
        },
    };
}

const say = (...chunks: string[]) => (emit: (e: StreamEvent) => void) => {
    for (const chunk of chunks) emit({ type: 'text', text: chunk });
    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
};

const callTool = (id: string, name: string, args = '{}') => (emit: (e: StreamEvent) => void) => {
    emit({ type: 'tool_call_start', index: 0, id, name });
    emit({ type: 'tool_call_args', index: 0, delta: args });
    emit({ type: 'done', stopReason: 'tool_calls', toolCalls: [{ index: 0, id, name, argumentsJson: args }] });
};

const TOOLS: ToolSchema[] = [
    {
        name: 'list_tags',
        description: 'List tags',
        parameters: { type: 'object', properties: {}, required: [] },
    },
];

const base = {
    runId: 'run-1',
    threadId: 'thread-1',
    messages: [{ role: 'user' as const, content: 'hi' }],
};

const parts = (events: ReturnType<typeof recorder>['events']) =>
    events.filter((e) => e.kind === 'part').map((e) => e.payload);

// ---------------------------------------------------------------------------
// Protocol parity — the claim the module's doc comment makes
// ---------------------------------------------------------------------------

describe('LocalRunCallbacks / WSCallbacks parity', () => {
    const protocolSource = readFileSync(
        fileURLToPath(
            new URL('../../../packages/agent-core/src/protocol/agentProtocol.ts', import.meta.url),
        ),
        'utf8',
    );
    const runnerSource = readFileSync(
        fileURLToPath(new URL('../../../packages/agent-llm/src/localRunner.ts', import.meta.url)),
        'utf8',
    );

    function methodNames(source: string, interfaceName: string): Set<string> {
        const match = new RegExp(
            `export interface ${interfaceName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
        ).exec(source);
        if (!match) throw new Error(`interface ${interfaceName} not found`);
        return new Set([...match[1].matchAll(/^ {4}(on[A-Za-z]+)\??\s*:/gm)].map((m) => m[1]));
    }

    it('names only callbacks the real WSCallbacks declares', () => {
        // The runner declares its own structural copy to avoid a cross-bundle
        // import. A name that drifts would be a callback the UI never wired.
        const real = methodNames(protocolSource, 'WSCallbacks');
        const local = methodNames(runnerSource, 'LocalRunCallbacks');
        expect([...local].filter((name) => !real.has(name))).toEqual([]);
    });

    it('covers every callback WSCallbacks marks required', () => {
        const requiredReal = new Set(
            [
                ...(
                    /export interface WSCallbacks\b[^{]*\{([\s\S]*?)\n\}/.exec(protocolSource)?.[1] ??
                    ''
                ).matchAll(/^ {4}(on[A-Za-z]+):/gm),
            ].map((m) => m[1]),
        );
        const local = methodNames(runnerSource, 'LocalRunCallbacks');
        // onClose is connection-level and has no local analogue; everything else
        // the UI requires must be something the runner can drive.
        requiredReal.delete('onClose');
        expect([...requiredReal].filter((name) => !local.has(name))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('runLocalAgent / lifecycle', () => {
    it('opens with a thread then ready, and closes with run_complete then done', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({ ...base, provider: scriptedProvider([say('hello')]), callbacks });

        const kinds = events.map((e) => e.kind);
        expect(kinds[0]).toBe('thread');
        expect(kinds[1]).toBe('ready');
        expect(kinds.at(-2)).toBe('runComplete');
        expect(kinds.at(-1)).toBe('done');
    });

    it('reports the thread id the caller supplied', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            threadId: 'thread-xyz',
            provider: scriptedProvider([say('x')]),
            callbacks,
        });
        expect(events[0].payload).toBe('thread-xyz');
    });

    it('declares itself ready with no subscription and local processing', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({ ...base, provider: scriptedProvider([say('x')]), callbacks });
        expect(events[1].payload).toEqual({
            subscriptionStatus: 'inactive',
            processingMode: 'frontend',
            indexingComplete: true,
        });
    });

    it('reports usage and cost as null rather than zero', async () => {
        // Zero would claim a metered run that cost nothing; null says there is
        // no meter, which is the truth for a local run.
        const { callbacks, events } = recorder();
        await runLocalAgent({ ...base, provider: scriptedProvider([say('x')]), callbacks });
        const complete = events.find((e) => e.kind === 'runComplete')!.payload;
        expect(complete).toMatchObject({ run_id: 'run-1', usage: null, cost: null });
    });

    it('passes caller warnings through before the run', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scriptedProvider([say('x')]),
            callbacks,
            warnings: [{ type: 'no_index', message: 'Semantic search is unavailable.' }],
        });
        const warning = events.find((e) => e.kind === 'warning')!.payload;
        expect(warning).toMatchObject({ type: 'no_index', run_id: 'run-1' });
    });
});

// ---------------------------------------------------------------------------
// Part indexing — the invariant the UI depends on
// ---------------------------------------------------------------------------

describe('runLocalAgent / part indexing', () => {
    it('streams a text run into one part, carrying the whole content each time', async () => {
        // A new index per chunk would render every token as its own paragraph.
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scriptedProvider([say('Hello', ' ', 'world')]),
            callbacks,
        });

        const textParts = parts(events);
        expect(new Set(textParts.map((p) => p.part_index)).size).toBe(1);
        expect(textParts.at(-1).part.content).toBe('Hello world');
    });

    it('keeps thinking in a part separate from the answer', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scriptedProvider([
                (emit) => {
                    emit({ type: 'reasoning', text: 'let me think' });
                    emit({ type: 'text', text: 'the answer' });
                    emit({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
                },
            ]),
            callbacks,
        });

        const byKind = new Map<string, number>();
        for (const p of parts(events)) byKind.set(p.part.part_kind, p.part_index);
        expect(byKind.get('thinking')).toBe(0);
        expect(byKind.get('text')).toBe(1);
    });

    it('gives a tool call its own part index', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => ({ tags: [] }),
            provider: scriptedProvider([callTool('c1', 'list_tags'), say('done')]),
            callbacks,
        });

        const toolCall = parts(events).find((p) => p.part.part_kind === 'tool-call');
        expect(toolCall.part).toMatchObject({ tool_name: 'list_tags', tool_call_id: 'c1' });
    });

    it('starts a new message_index after tool results come back', async () => {
        // The model's second turn is a new assistant message; reusing the index
        // would overwrite the first turn's parts.
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => 'ok',
            provider: scriptedProvider([callTool('c1', 'list_tags'), say('final answer')]),
            callbacks,
        });

        const indices = [...new Set(parts(events).map((p) => p.message_index))];
        expect(indices).toEqual([0, 2]);
    });

    it('advances message_index monotonically across three turns', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => 'ok',
            provider: scriptedProvider([
                callTool('c1', 'list_tags'),
                callTool('c2', 'list_tags'),
                say('done'),
            ]),
            callbacks,
        });

        const indices = parts(events).map((p) => p.message_index);
        for (let i = 1; i < indices.length; i += 1) {
            expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
        }
        // Two tool rounds at two messages each, then the final answer.
        expect(indices.at(-1)).toBe(4);
    });

    it('opens a fresh text part after a tool call', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => 'ok',
            provider: scriptedProvider([
                (emit) => {
                    emit({ type: 'text', text: 'Looking… ' });
                    emit({ type: 'tool_call_start', index: 0, id: 'c1', name: 'list_tags' });
                    emit({
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ index: 0, id: 'c1', name: 'list_tags', argumentsJson: '{}' }],
                    });
                },
                say('found it'),
            ]),
            callbacks,
        });

        // The second turn's text must not continue the first turn's buffer.
        const secondTurnText = parts(events)
            .filter((p) => p.message_index === 2 && p.part.part_kind === 'text')
            .at(-1);
        expect(secondTurnText.part.content).toBe('found it');
    });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('runLocalAgent / tools', () => {
    it('reports a tool result with its call id and outcome', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => ({ ok: true }),
            provider: scriptedProvider([callTool('c1', 'list_tags'), say('done')]),
            callbacks,
        });

        const ret = events.find((e) => e.kind === 'toolReturn')!.payload;
        expect(ret.part).toMatchObject({
            part_kind: 'tool-return',
            tool_call_id: 'c1',
            tool_name: 'list_tags',
            outcome: 'success',
        });
    });

    it('marks a failed tool as an error outcome without ending the run', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => {
                throw new Error('library locked');
            },
            provider: scriptedProvider([callTool('c1', 'list_tags'), say('sorry')]),
            callbacks,
        });

        const ret = events.find((e) => e.kind === 'toolReturn')!.payload;
        expect(ret.part.outcome).toBe('error');
        expect(events.some((e) => e.kind === 'runComplete')).toBe(true);
        expect(events.some((e) => e.kind === 'error')).toBe(false);
    });

    it('streams argument fragments with the tool name attached', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => 'ok',
            provider: scriptedProvider([callTool('c1', 'list_tags', '{"limit":5}'), say('x')]),
            callbacks,
        });

        const args = events.find((e) => e.kind === 'args')!.payload;
        expect(args).toMatchObject({ tool_call_id: 'c1', tool_name: 'list_tags' });
    });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe('runLocalAgent / failure', () => {
    it('reports an error and still closes the run', async () => {
        // A panel left spinning with no terminal event is worse than an error.
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scriptedProvider([
                (emit) => emit({ type: 'error', error: new Error('boom') }),
            ]),
            callbacks,
        });

        expect(events.some((e) => e.kind === 'error')).toBe(true);
        expect(events.at(-1)!.kind).toBe('done');
        expect(events.some((e) => e.kind === 'runComplete')).toBe(false);
    });

    it('warns rather than errors when the iteration limit is hit', async () => {
        const forever: Script = Array.from({ length: 10 }, (_, i) =>
            callTool(`c${i}`, 'list_tags'),
        );
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            tools: TOOLS,
            dispatch: async () => 'again',
            provider: scriptedProvider(forever),
            callbacks,
            maxIterations: 3,
        });

        const warning = events.find((e) => e.kind === 'warning')!.payload;
        expect(warning.type).toBe('iteration_limit');
        // The limit is a setting now; the warning says which one.
        expect(warning.message).toMatch(/Model requests per question/);
        expect(events.some((e) => e.kind === 'runComplete')).toBe(true);
    });

    it('names the output cap and where to raise it when a reply runs out thinking', async () => {
        // The reply that answered nothing: all of it spent on reasoning.
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scriptedProvider([
                (emit) => emit({ type: 'done', stopReason: 'length', toolCalls: [] }),
            ]),
            callbacks,
            outputTokenLimit: 32_000,
        });
        const warning = events.find((e) => e.kind === 'warning')!.payload;
        expect(warning.type).toBe('output_limit');
        expect(warning.message).toContain('32k-token');
        expect(warning.message).toMatch(/Output tokens per reply/);
    });

    it('says "cut off" when some of the answer did arrive', async () => {
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scriptedProvider([
                (emit) => { emit({ type: 'text', text: 'Partial' }); emit({ type: 'done', stopReason: 'length', toolCalls: [] }); },
            ]),
            callbacks,
        });
        const warning = events.find((e) => e.kind === 'warning')!.payload;
        expect(warning.message).toMatch(/cut off at the per-reply output limit/);
    });

    it('does not report an error for a cancelled run', async () => {
        const controller = new AbortController();
        controller.abort();
        const { callbacks, events } = recorder();
        await runLocalAgent({
            ...base,
            provider: scriptedProvider([say('never')]),
            callbacks,
            signal: controller.signal,
        });
        expect(events.some((e) => e.kind === 'error')).toBe(false);
        expect(events.at(-1)!.kind).toBe('done');
    });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('classifyRunError', () => {
    it('marks an auth failure as not retryable', () => {
        const result = classifyRunError(
            new ModelRequestError('OpenRouter request failed: 401', { kind: 'http', status: 401, label: 'OpenRouter' }),
        );
        expect(result).toMatchObject({ type: 'llm_auth_error', is_retryable: false });
        // Points at the place the key actually lives.
        expect(result.message).toContain('Settings → Model → Providers');
        expect(result.message).toContain('OpenRouter');
    });

    it('marks a rate limit as retryable', () => {
        expect(
            classifyRunError(new ModelRequestError('429', { kind: 'http', status: 429, label: 'DeepSeek' })),
        ).toMatchObject({ type: 'llm_rate_limit', is_retryable: true });
    });

    it('marks a network failure as retryable', () => {
        expect(
            classifyRunError(
                new ModelRequestError('DeepSeek could not be reached: fetch failed', {
                    kind: 'network',
                    label: 'DeepSeek',
                    detail: 'fetch failed',
                }),
            ),
        ).toMatchObject({ type: 'llm_network_error', is_retryable: true });
    });

    it('treats cancellation as neither an error to retry nor a fault', () => {
        expect(classifyRunError(new ModelRequestError('Request cancelled', { kind: 'cancelled' }))).toMatchObject({
            type: 'run_cancelled',
            is_retryable: false,
        });
    });

    it('falls back to a retryable generic error, keeping the message', () => {
        const result = classifyRunError(new Error('something odd happened'));
        expect(result).toMatchObject({ type: 'llm_error', is_retryable: true });
        expect(result.message).toBe('something odd happened');
    });
});
