import { describe, expect, it, vi } from 'vitest';

import { runAgentLoop } from '@beaver/agent-llm/agentLoop';
import { runLocalAgent, type LocalRunCallbacks } from '@beaver/agent-llm/localRunner';
import { providerFromPreset } from '@beaver/agent-llm/openAICompatible';
import type { ChatProvider, ChatRequest, StreamEvent } from '@beaver/agent-llm/types';

/** A provider that answers "ok" and keeps every request it was sent. */
function recordingProvider(): ChatProvider & { requests: ChatRequest[] } {
    const requests: ChatRequest[] = [];
    return {
        requests,
        label: 'Fake',
        model: 'fake-1',
        wireFormat: 'openai',
        async stream(request, onEvent: (event: StreamEvent) => void) {
            requests.push(request);
            onEvent({ type: 'text', text: 'ok' });
            onEvent({ type: 'done', stopReason: 'end_turn', toolCalls: [] });
        },
    };
}

const quietCallbacks: LocalRunCallbacks = {
    onThread: () => {},
    onReady: () => {},
    onPart: () => {},
    onToolCallArgsStream: () => {},
    onToolReturn: () => {},
    onToolCallProgress: () => {},
    onRunComplete: () => {},
    onDone: () => {},
    onError: () => {},
    onWarning: () => {},
};

describe('the conversation header OpenCode Go requires', () => {
    it('names the conversation on every OpenCode Go request', () => {
        const provider = providerFromPreset('opencode-go', 'k', vi.fn() as any);
        const headers = provider.buildHeaders({ messages: [], sessionId: 'thread-1' });
        expect(headers['x-opencode-session']).toBe('thread-1');
        expect(headers.Authorization).toBe('Bearer k');
    });

    it('makes up one id for requests that name no conversation, the same each time', () => {
        const provider = providerFromPreset('opencode-go', 'k', vi.fn() as any);
        const first = provider.buildHeaders({ messages: [] })['x-opencode-session'];
        expect(first).toMatch(/\S{8,}/);
        expect(provider.buildHeaders()['x-opencode-session']).toBe(first);
        expect(provider.buildHeaders({ messages: [], sessionId: '  ' })['x-opencode-session']).toBe(first);
    });

    it('is not sent to providers that do not ask for it', () => {
        for (const id of ['deepseek', 'openrouter', 'zhipu', 'openai'] as const) {
            const headers = providerFromPreset(id, 'k', vi.fn() as any).buildHeaders({ messages: [], sessionId: 'thread-1' });
            expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('x-opencode-session');
        }
    });

    it('reaches the wire: the request OpenCode Go receives carries it', async () => {
        const fetchImpl = vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        const provider = providerFromPreset('opencode-go', 'k', fetchImpl as any);
        await provider.stream({ messages: [{ role: 'user', content: 'hi' }], sessionId: 'thread-7' }, () => {});
        const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('thread-7');
    });

    it('is the session id the loop was given, on each of its requests', async () => {
        const provider = recordingProvider();
        await runAgentLoop([{ role: 'user', content: 'hi' }], { provider, sessionId: 'thread-2' });
        expect(provider.requests.map((request) => request.sessionId)).toEqual(['thread-2']);
    });

    it('is the thread id when a run goes through the runner', async () => {
        const provider = recordingProvider();
        await runLocalAgent({
            runId: 'run-1',
            threadId: 'thread-3',
            messages: [{ role: 'user', content: 'hi' }],
            provider,
            callbacks: quietCallbacks,
        });
        expect(provider.requests.length).toBeGreaterThan(0);
        expect(provider.requests.every((request) => request.sessionId === 'thread-3')).toBe(true);
    });
});
