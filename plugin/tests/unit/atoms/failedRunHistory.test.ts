/**
 * What a new question in a thread is sent of an earlier run that failed.
 *
 * The history builder decides from the stored run's error type: a run that
 * failed for a passing reason replays the tool steps it finished, one that
 * overflowed the context window keeps only its question and prose. That only
 * works if the run executor hands the builder the error type along with the
 * run — checked here through a real executeLocalRequest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { options?: any } = {};

vi.mock('@beaver/agent-llm/localRunner', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@beaver/agent-llm/localRunner')>()),
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
import { store } from '../../../react/store';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';

const get = ((atom: any) => store.get(atom)) as any;
const set = ((atom: any, ...args: any[]) => (store.set as any)(atom, ...args)) as any;

const SEARCH_RESULT = 'u-WAGGLE001 Waggle-dance odometry in honeybees';

/** An earlier run that searched the library and then failed with `errorType`. */
function failedRun(errorType: string) {
    return {
        id: 'run-failed',
        thread_id: 'thread-1',
        status: 'error',
        error: { type: errorType, message: 'The request failed.' },
        user_prompt: { content: 'Which of my papers discuss waggle-dance odometry?' },
        model_messages: [
            {
                kind: 'response',
                parts: [
                    { part_kind: 'text', content: 'Searching your library.' },
                    { part_kind: 'tool-call', tool_name: 'item_search_by_metadata', tool_call_id: 'c-search', args: { title: 'waggle dance' } },
                ],
            },
            {
                kind: 'request',
                parts: [{ part_kind: 'tool-return', tool_name: 'item_search_by_metadata', tool_call_id: 'c-search', content: SEARCH_RESULT }],
            },
        ],
        created_at: '2026-09-24T12:00:00.000Z',
    } as any;
}

function nextRun() {
    return {
        id: 'run-next',
        thread_id: 'thread-1',
        status: 'in_progress',
        user_prompt: { content: 'continue' },
        model_messages: [],
        created_at: '2026-09-24T12:05:00.000Z',
    } as any;
}

async function sentAfter(errorType: string): Promise<string> {
    captured.options = undefined;
    store.set(threadRunsAtom, [failedRun(errorType)]);
    const run = nextRun();
    store.set(activeRunAtom, run);
    await executeLocalRequest(run, { user_prompt: run.user_prompt, thread_id: 'thread-1' } as any, get, set);
    expect(captured.options).toBeDefined();
    return JSON.stringify(captured.options.messages);
}

beforeEach(() => {
    store.set(activeRunAtom, null);
    store.set(threadRunsAtom, []);
    store.set(isWSChatPendingAtom, false);
});

describe('a new question after a failed run', () => {
    it('still carries the question the run failed on', async () => {
        const sent = await sentAfter('llm_service_unavailable');
        expect(sent).toContain('Which of my papers discuss waggle-dance odometry?');
    });

    it('carries the search the run had finished when it failed for a passing reason', async () => {
        const sent = await sentAfter('llm_service_unavailable');
        expect(sent).toContain(SEARCH_RESULT);
    });

    it('leaves out the tool results of a run that overflowed the context window', async () => {
        const sent = await sentAfter('llm_context_window_exceeded');
        expect(sent).toContain('Which of my papers discuss waggle-dance odometry?');
        expect(sent).not.toContain(SEARCH_RESULT);
    });
});
