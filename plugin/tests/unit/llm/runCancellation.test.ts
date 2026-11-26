/**
 * Stopping a local run stops it.
 *
 * Stop, New chat and Switch chat abort the run's signal. From that moment the
 * request in flight is abandoned, no further tool is dispatched, the loop
 * settles as `cancelled` without waiting on anything that ignores the signal,
 * and the UI hears nothing more from the run but one `onDone`.
 */
import { describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '@beaver/agent-llm/agentLoop';
import { runLocalAgent, type LocalRunCallbacks } from '@beaver/agent-llm/localRunner';
import { OpenAICompatibleProvider, type FetchLike } from '@beaver/agent-llm/openAICompatible';
import type { ChatProvider, StreamEvent, ToolSchema } from '@beaver/agent-llm/types';
import { updateRunComplete, updateRunWithPart, updateRunWithToolReturn } from '@beaver/agent-core/run-state/atoms';
import type { AgentRun } from '@beaver/agent-core/agents/types';

const TOOLS: ToolSchema[] = [
    { name: 'read_document', description: 'Read', parameters: { type: 'object', properties: {} } },
];

const user = (content: string) => ({ role: 'user' as const, content });

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
        onRetry: push('retry'),
    };
    return { callbacks, events };
}

/** A provider whose stream never ends and ignores the abort signal entirely. */
function stubbornProvider(beforeHang: (emit: (e: StreamEvent) => void) => void = () => undefined) {
    const calls: number[] = [];
    let emitter: ((e: StreamEvent) => void) | null = null;
    const provider: ChatProvider = {
        label: 'Stubborn',
        model: 'm',
        wireFormat: 'openai',
        stream(_request, onEvent) {
            calls.push(1);
            emitter = onEvent;
            beforeHang(onEvent);
            return new Promise<void>(() => undefined);
        },
    };
    return { provider, calls, emitLate: (e: StreamEvent) => emitter?.(e) };
}

const oneCall = (ids: string[]) => (emit: (e: StreamEvent) => void) => {
    ids.forEach((id, index) => emit({ type: 'tool_call_start', index, id, name: 'read_document' }));
    emit({
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: ids.map((id, index) => ({ index, id, name: 'read_document', argumentsJson: '{}' })),
    });
};

function scripted(script: Array<(emit: (e: StreamEvent) => void) => void>) {
    let turn = 0;
    const calls: number[] = [];
    const provider: ChatProvider = {
        label: 'Fake',
        model: 'm',
        wireFormat: 'openai',
        async stream(_request, onEvent) {
            calls.push(turn);
            const step = script[turn++];
            if (step) step(onEvent);
            else onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        },
    };
    return { provider, calls };
}

describe('runAgentLoop / stopping', () => {
    it('settles as cancelled mid-stream even when the provider ignores the signal', async () => {
        const controller = new AbortController();
        const { provider } = stubbornProvider((emit) => emit({ type: 'text', text: 'partial' }));

        const running = runAgentLoop([user('go')], { provider, signal: controller.signal });
        await Promise.resolve();
        controller.abort();

        const result = await running;
        expect(result.reason).toBe('cancelled');
        // A stop is not a failure: there is no error to report.
        expect(result.error).toBeUndefined();
    });

    it('does not wait for a tool that never returns', async () => {
        const controller = new AbortController();
        const { provider, calls } = scripted([oneCall(['c1']), (emit) => emit({ type: 'text', text: 'never' })]);
        let dispatched = 0;

        const running = runAgentLoop([user('go')], {
            provider,
            tools: TOOLS,
            signal: controller.signal,
            dispatch: () => {
                dispatched += 1;
                // e.g. a question card waiting on the user.
                return new Promise(() => undefined);
            },
        });
        await vi.waitFor(() => expect(dispatched).toBe(1));
        controller.abort();

        const result = await running;
        expect(result.reason).toBe('cancelled');
        expect(calls).toHaveLength(1);
    });

    it('dispatches no further call once stopped between two calls of one turn', async () => {
        const controller = new AbortController();
        const { provider } = scripted([oneCall(['c1', 'c2'])]);
        const seen: string[] = [];
        const loopEvents: Array<{ type: string; id?: string }> = [];

        const result = await runAgentLoop([user('go')], {
            provider,
            tools: TOOLS,
            signal: controller.signal,
            onEvent: (e) => loopEvents.push(e as any),
            dispatch: async (_name, _args, { toolCallId }) => {
                seen.push(toolCallId);
                controller.abort();
                return 'ok';
            },
        });

        expect(seen).toEqual(['c1']);
        expect(result.reason).toBe('cancelled');
        // The second call is not touched at all — no argument rewrite, no
        // "cancelled" result row for the UI to draw.
        expect(loopEvents.filter((e) => e.id === 'c2' && e.type !== 'tool_start')).toEqual([]);
    });

    it('reports a stop as cancelled, not as the error the abort caused', async () => {
        const controller = new AbortController();
        const provider: ChatProvider = {
            label: 'Fake',
            model: 'm',
            wireFormat: 'openai',
            async stream(_request, onEvent) {
                controller.abort();
                onEvent({ type: 'error', error: new Error('The operation was aborted.') });
            },
        };
        const result = await runAgentLoop([user('go')], { provider, signal: controller.signal });
        expect(result.reason).toBe('cancelled');
        expect(result.error).toBeUndefined();
    });
});

describe('runLocalAgent / stopping', () => {
    it('reports nothing after the stop but a single onDone', async () => {
        const controller = new AbortController();
        const { provider, emitLate } = stubbornProvider((emit) => emit({ type: 'text', text: 'first words' }));
        const { callbacks, events } = recorder();

        const running = runLocalAgent({
            runId: 'run-1',
            threadId: 't',
            messages: [user('go')],
            provider,
            callbacks,
            signal: controller.signal,
        });
        await Promise.resolve();
        const before = events.length;
        controller.abort();
        // The provider keeps talking after the stop; none of it may land.
        emitLate({ type: 'text', text: ' more words' });
        emitLate({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        await running;

        const after = events.slice(before).map((e) => e.kind);
        expect(after).toEqual(['done']);
        expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
        expect(events.some((e) => e.kind === 'runComplete' || e.kind === 'error')).toBe(false);
    });

    it('announces nothing for a run stopped before it began', async () => {
        // By then the reader may be in another thread; a late onThread would
        // switch the panel back to this one.
        const controller = new AbortController();
        controller.abort();
        const { provider, calls } = scripted([]);
        const { callbacks, events } = recorder();

        await runLocalAgent({
            runId: 'run-1',
            threadId: 'old-thread',
            messages: [user('go')],
            provider,
            callbacks,
            signal: controller.signal,
            warnings: [{ type: 'semantic_search_unavailable', message: 'x' }],
        });

        expect(events.map((e) => e.kind)).toEqual(['done']);
        expect(calls).toHaveLength(0);
    });

    it('does not mark a stopped run complete', async () => {
        const controller = new AbortController();
        const { provider } = scripted([oneCall(['c1'])]);
        const { callbacks, events } = recorder();

        await runLocalAgent({
            runId: 'run-1',
            threadId: 't',
            messages: [user('go')],
            provider,
            tools: TOOLS,
            callbacks,
            signal: controller.signal,
            dispatch: async () => {
                controller.abort();
                return 'ok';
            },
        });

        expect(events.some((e) => e.kind === 'runComplete')).toBe(false);
        expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
    });
});

describe('OpenAICompatibleProvider / stopping', () => {
    const config = {
        label: 'DeepSeek',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        wireFormat: 'openai' as const,
    };

    it('aborts the fetch itself, so the paid request really ends', async () => {
        const controller = new AbortController();
        let fetchSignal: AbortSignal | undefined;
        const fetchImpl = (async (_url: string, init: any) => {
            fetchSignal = init.signal;
            return new Promise(() => undefined);
        }) as unknown as FetchLike;
        const events: StreamEvent[] = [];

        const streaming = new OpenAICompatibleProvider(config, fetchImpl).stream(
            { messages: [user('hi')], signal: controller.signal },
            (e) => events.push(e),
        );
        await Promise.resolve();
        controller.abort();
        await streaming;

        expect(fetchSignal?.aborted).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
    });

    it('stops reading a stream mid-reply when the signal aborts', async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        let reads = 0;
        const fetchImpl = (async () => ({
            ok: true,
            status: 200,
            text: async () => '',
            body: {
                getReader: () => ({
                    read: () => {
                        reads += 1;
                        if (reads === 1) {
                            return Promise.resolve({
                                done: false,
                                value: encoder.encode(
                                    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
                                ),
                            });
                        }
                        // The next chunk never comes, and this reader ignores aborts.
                        return new Promise(() => undefined);
                    },
                    cancel: async () => undefined,
                }),
            },
        })) as unknown as FetchLike;
        const events: StreamEvent[] = [];

        const streaming = new OpenAICompatibleProvider(config, fetchImpl).stream(
            { messages: [user('hi')], signal: controller.signal },
            (e) => events.push(e),
        );
        await vi.waitFor(() => expect(events.some((e) => e.type === 'text')).toBe(true));
        controller.abort();
        await streaming;

        const terminals = events.filter((e) => e.type === 'done' || e.type === 'error');
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
    });
});

describe('run updates from a run that is no longer active', () => {
    const activeRun = (): AgentRun => ({
        id: 'new-run',
        user_id: 'u',
        thread_id: 't',
        agent_name: 'beaver',
        user_prompt: { content: 'q', is_resume: false } as any,
        status: 'in_progress',
        model_messages: [{ kind: 'response', run_id: 'new-run', parts: [{ part_kind: 'text', content: 'new answer' }] } as any],
        model_name: 'm',
        created_at: new Date().toISOString(),
    } as AgentRun);

    it('does not write a stopped run\'s part into the new run', () => {
        const run = activeRun();
        const next = updateRunWithPart(run, {
            event: 'part',
            run_id: 'stopped-run',
            message_index: 0,
            part_index: 0,
            part: { part_kind: 'text', content: 'old answer' },
        } as any);
        expect(next).toBe(run);
    });

    it('does not let a stopped run\'s tool return rewrite a slot of the new run', () => {
        const run = activeRun();
        const next = updateRunWithToolReturn(run, {
            event: 'tool_return',
            run_id: 'stopped-run',
            message_index: 0,
            part: { part_kind: 'tool-return', tool_name: 'x', tool_call_id: 'c', content: 'r' },
        } as any);
        expect(next).toBe(run);
    });

    it('does not let a stopped run\'s completion finish the new run', () => {
        const run = activeRun();
        const next = updateRunComplete(run, {
            event: 'run_complete',
            run_id: 'stopped-run',
            usage: null,
            cost: null,
        } as any);
        expect(next.status).toBe('in_progress');
    });

    it('still applies the run\'s own events', () => {
        const run = activeRun();
        const next = updateRunWithPart(run, {
            event: 'part',
            run_id: 'new-run',
            message_index: 0,
            part_index: 0,
            part: { part_kind: 'text', content: 'new answer, longer' },
        } as any);
        expect((next.model_messages[0] as any).parts[0].content).toBe('new answer, longer');
    });
});
