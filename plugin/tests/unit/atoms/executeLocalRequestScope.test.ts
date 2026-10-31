/**
 * A local run is confined to itself.
 *
 * Stop, New chat and Switch chat hand the run an aborted signal and give its
 * slot up. What the run does afterwards must not reach anything else: its
 * callbacks must not write into the next answer, finalize it or unlock the
 * composer under it, and its tools must not act for the user.
 *
 * The callbacks are confined by `createWSCallbacks`, to the run holding the
 * active slot when they are made — so what is checked here is that the run
 * makes them while it is still that run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { options?: any } = {};

/** Which run held the active slot each time `createWSCallbacks` was called. */
const slotWhenCallbacksWereMade = vi.hoisted(() => [] as Array<string | null>);

vi.mock('../../../react/atoms/agentRunAtoms', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../react/atoms/agentRunAtoms')>();
    const { store: sharedStore } = await import('../../../react/store');
    const { activeRunAtom: slot } = await import('@beaver/agent-core/run-state/atoms');
    return {
        ...actual,
        createWSCallbacks: (...args: Parameters<typeof actual.createWSCallbacks>) => {
            slotWhenCallbacksWereMade.push(sharedStore.get(slot)?.id ?? null);
            return actual.createWSCallbacks(...args);
        },
    };
});

vi.mock('../../../src/services/llm/localRunner', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/services/llm/localRunner')>()),
    runLocalAgent: vi.fn(async (options: any) => {
        captured.options = options;
    }),
}));

vi.mock('../../../src/services/llm/agentConfig', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/services/llm/agentConfig')>()),
    refreshSemanticSearchAvailability: vi.fn(async () => {}),
    buildAgentFromPrefs: vi.fn(() => ({
        ok: true,
        provider: {},
        tools: [],
        warnings: [],
        outputTokenLimit: 1000,
    })),
    buildAgentSystemPrompt: vi.fn(() => 'You are a test.'),
    isSemanticSearchAvailable: vi.fn(() => false),
}));

import { executeLocalRequest } from '../../../react/atoms/executeLocalRun';
import { isWSChatPendingAtom } from '../../../react/atoms/agentRunAtoms';
import { buildAgentFromPrefs } from '../../../src/services/llm/agentConfig';
import { runLocalAgent } from '../../../src/services/llm/localRunner';
import { store } from '../../../react/store';
import { activeRunAtom, currentThreadNameAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { resolveAllLocalQuestions } from '../../../react/utils/localQuestions';

const get = ((atom: any) => store.get(atom)) as any;
const set = ((atom: any, ...args: any[]) => (store.set as any)(atom, ...args)) as any;

function makeRun(id: string) {
    return {
        id,
        thread_id: 'thread-1',
        status: 'in_progress',
        user_prompt: { content: 'Summarise these papers' },
        model_messages: [],
        created_at: '2026-09-24T12:00:00.000Z',
    } as any;
}

const QUESTION = {
    questions: [{ question: 'Which colour scheme?', options: [{ label: 'Warm' }, { label: 'Cool' }] }],
};

/** Settles within a moment, or reports that it is still waiting. */
async function outcomeOf(pending: Promise<unknown>): Promise<string> {
    return Promise.race([
        pending.then(
            (value) => `resolved: ${String(value)}`,
            (error: Error) => `rejected: ${error.message}`,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
}

async function start(run: any, signal?: AbortSignal) {
    captured.options = undefined;
    store.set(activeRunAtom, run);
    await executeLocalRequest(run, { user_prompt: run.user_prompt, thread_id: 'thread-1' } as any, get, set, signal);
    expect(captured.options).toBeDefined();
    return captured.options;
}

beforeEach(() => {
    resolveAllLocalQuestions('test reset');
    store.set(activeRunAtom, null);
    store.set(currentThreadNameAtom, null);
    store.set(isWSChatPendingAtom, false);
});

describe('executeLocalRequest', () => {
    it('hands the stop signal to the model loop', async () => {
        const controller = new AbortController();
        const options = await start(makeRun('run-a'), controller.signal);
        expect(options.signal).toBe(controller.signal);
    });

    it('passes its callbacks through while it holds the active slot', async () => {
        const options = await start(makeRun('run-a'));
        options.callbacks.onThreadName({ event: 'thread_name', thread_id: 'thread-1', name: 'Waggle dances' });
        expect(store.get(currentThreadNameAtom)).toBe('Waggle dances');
    });

    it('makes its callbacks before it waits on anything, while its run still holds the slot', async () => {
        slotWhenCallbacksWereMade.length = 0;
        const run = makeRun('run-a');
        store.set(activeRunAtom, run);

        const pending = executeLocalRequest(
            run,
            { user_prompt: run.user_prompt, thread_id: 'thread-1' } as any,
            get,
            set,
        );
        // Stop, pressed at once: the slot is given up before anything the run
        // awaits has settled. Callbacks made after that would belong to no run,
        // or to whichever run took the slot.
        store.set(activeRunAtom, null);
        await pending;

        expect(slotWhenCallbacksWereMade).toEqual(['run-a']);
    });

    it('asks nothing after the run was stopped', async () => {
        const controller = new AbortController();
        const options = await start(makeRun('run-a'), controller.signal);

        controller.abort();

        expect(await outcomeOf(options.dispatch('ask_user_question', QUESTION, { toolCallId: 'q-1' })))
            .toMatch(/^rejected: .*stopped/);
    });

    it('reports a missing setup as not_configured, with no retry that would fail the same way', async () => {
        vi.mocked(buildAgentFromPrefs).mockReturnValueOnce({
            ok: false,
            problem: { message: 'DeepSeek needs an API key on this computer.' },
        } as any);
        vi.mocked(runLocalAgent).mockClear();
        const run = makeRun('run-a');
        store.set(activeRunAtom, run);
        store.set(threadRunsAtom, []);

        await executeLocalRequest(run, { user_prompt: run.user_prompt, thread_id: 'thread-1' } as any, get, set);

        expect(runLocalAgent).not.toHaveBeenCalled();
        const settled = [store.get(activeRunAtom), ...store.get(threadRunsAtom)]
            .find((candidate: any) => candidate?.id === 'run-a') as any;
        expect(settled?.error).toMatchObject({
            type: 'not_configured',
            message: 'DeepSeek needs an API key on this computer.',
            is_retryable: false,
        });
    });

    it('asks nothing once the run has given up its slot, even without a signal', async () => {
        const options = await start(makeRun('run-a'));

        // Switching chats archived the run and emptied the slot.
        store.set(activeRunAtom, null);

        expect(await outcomeOf(options.dispatch('ask_user_question', QUESTION, { toolCallId: 'q-1' })))
            .toMatch(/^rejected: .*stopped/);
    });
});
