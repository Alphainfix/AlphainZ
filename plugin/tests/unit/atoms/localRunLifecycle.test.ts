/**
 * A local run's life: sent, streamed, stopped or finished, and stored.
 *
 * The model runs in this process, so Stop, New chat and Switch chat have no
 * socket to close — they have to stop the loop themselves, and a loop still
 * winding down must not reach the run that replaced it. A run that never
 * finishes still has to leave the question behind in the thread, and what the
 * user decided about its proposals has to survive the thread being reopened.
 *
 * The local executor is replaced by a stand-in that builds its callbacks the
 * way the real one does — `createWSCallbacks(set)` as the run starts — and
 * then waits until the test ends it, so each case drives the events by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    executeLocalRequestMock,
    saveInterruptedThreadMock,
    undoEditMetadataMock,
    saveCommentToAnnotationMock,
    preparing,
} = vi.hoisted(() => ({
    executeLocalRequestMock: vi.fn(),
    saveInterruptedThreadMock: vi.fn(),
    undoEditMetadataMock: vi.fn(async () => {}),
    saveCommentToAnnotationMock: vi.fn(async (): Promise<any> => ({ saved: true })),
    // While set, a message being sent waits here, before its run exists —
    // the last step of preparing it.
    preparing: { hold: null as Promise<void> | null },
}));

vi.mock('../../../react/utils/editMetadataActions', () => ({
    undoEditMetadataAction: undoEditMetadataMock,
}));
vi.mock('../../../react/utils/selectionChatComment', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../react/utils/selectionChatComment')>()),
    saveCommentToAnnotation: saveCommentToAnnotationMock,
}));

vi.mock('../../../react/atoms/executeLocalRun', () => ({
    executeLocalRequest: (...args: unknown[]) => executeLocalRequestMock(...args),
}));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: {
        cancel: vi.fn(async () => {}),
        close: vi.fn(),
        connect: vi.fn(),
        isConnected: vi.fn(() => false),
        sendApprovalResponse: vi.fn(() => false),
        sendAskUserQuestionResponse: vi.fn(),
    },
    agentRunService: { getThreadRuns: vi.fn() },
    AgentConnectionError: class AgentConnectionError extends Error {},
}));
vi.mock('@beaver/agent-core/transport/threadService', () => ({
    threadService: { truncateThread: vi.fn(), getThread: vi.fn() },
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: vi.fn(() => ({
        frontendVersion: '0.0.0-test',
        clientType: 'zotero-plugin',
        clientFeatures: [],
        zoteroInstance: {},
    })),
}));
vi.mock('@beaver/agent-core/transport/clients/diagnosticsService', () => ({
    reportConnectionFailure: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => {
        if (preparing.hold) await preparing.hold;
        return {};
    }),
}));
vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
    notifyApprovalRequest: vi.fn(),
    notifyBatchApproval: vi.fn(),
    notifyCreditConfirmation: vi.fn(),
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/interruptedThreadPrefs', () => ({
    saveInterruptedThread: saveInterruptedThreadMock,
}));
// No title requests: they would go to a model.
vi.mock('../../../src/services/llm/threadTitle', () => ({
    generateThreadTitle: vi.fn(async () => null),
}));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';
import {
    activeRunAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
    threadRunsAtom,
    wsRetryAtom,
} from '@beaver/agent-core/run-state/atoms';
import { setHost } from '@beaver/agent-ui/host';
import { store } from '../../../react/store';
import {
    addAgentActionsAtom,
    addPendingApprovalAtom,
    pendingApprovalsAtom,
    threadAgentActionsAtom,
} from '../../../react/agents/agentActions';
import { awaitApproval } from '../../../react/utils/localApprovals';
import { awaitAnswer, nextQuestionId } from '../../../react/utils/localQuestions';
import { selectedModelAtom } from '../../../react/atoms/models';
import { popupMessagesAtom } from '../../../react/atoms/ui';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../../../react/atoms/messageComposition';
import {
    approveToolGroupForRunAtom,
    clearClientShutDownLatch,
    closeWSConnectionAtom,
    closeWSConnectionForShutdownAtom,
    createWSCallbacks,
    isWSChatPendingAtom,
    regenerateFromRunAtom,
    regenerateWithEditedPromptAtom,
    retryPendingRunIdAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { loadThreadAtom, newThreadAtom } from '../../../react/atoms/threads';
import { localRenameThread } from '../../../react/atoms/loadLocalThreads';
import { drainPendingAnchor, stashPendingAnchor } from '../../../react/utils/selectionAnchors';

// =============================================================================
// A database with the semantics the run path relies on
// =============================================================================

interface StoredRun {
    id: string;
    thread_id: string;
    user_id: string;
    created_at?: string;
    payload: any;
    seq: number;
}

class FakeDb {
    threads = new Map<string, { id: string; user_id: string; name: string | null }>();
    runs = new Map<string, StoredRun>();
    private seq = 0;

    saveRun = vi.fn(async (run: Omit<StoredRun, 'seq'>) => {
        if (!this.threads.has(run.thread_id)) {
            this.threads.set(run.thread_id, { id: run.thread_id, user_id: run.user_id, name: null });
        }
        const existing = this.runs.get(run.id);
        this.runs.set(run.id, {
            ...run,
            payload: structuredClone(run.payload),
            seq: existing?.seq ?? ++this.seq,
        });
    });

    ensureThread = vi.fn(async (id: string, user_id: string, name: string) => {
        if (!this.threads.has(id)) this.threads.set(id, { id, user_id, name: name || null });
    });

    getThread = vi.fn(async (_userId: string, id: string) => {
        const thread = this.threads.get(id);
        return thread
            ? { id: thread.id, name: thread.name ?? '', createdAt: '', updatedAt: '' }
            : null;
    });

    setThreadName = vi.fn(async (id: string, user_id: string, name: string) => {
        const thread = this.threads.get(id) ?? { id, user_id, name: null };
        thread.name = name;
        this.threads.set(id, thread);
    });

    renameThread = vi.fn(async (_userId: string, id: string, name: string) => {
        const thread = this.threads.get(id);
        if (thread) thread.name = name;
    });

    getRunsForThread = vi.fn(async (threadId: string) =>
        this.stored(threadId).map((run) => structuredClone(run.payload)));

    /** The local truncation's contract: refuse when the survivor is not the expected tail. */
    deleteRuns = vi.fn(async (threadId: string, runIds: string[], expectedTailRunId: string | null) => {
        const present = this.stored(threadId).map((run) => run.id);
        const doomed = new Set(runIds);
        const survivors = present.filter((id) => !doomed.has(id));
        const actualTail = survivors.length > 0 ? survivors[survivors.length - 1] : null;
        if (actualTail !== expectedTailRunId) {
            return { deleted_run_ids: [], refused_run_ids: [...runIds], reason: 'tail_mismatch' };
        }
        const deletable = present.filter((id) => doomed.has(id));
        for (const id of deletable) this.runs.delete(id);
        return { deleted_run_ids: deletable, refused_run_ids: [] };
    });

    recordThreadItems = vi.fn(async () => {});
    saveThreadAnchor = vi.fn(async () => {});

    stored(threadId: string): StoredRun[] {
        return [...this.runs.values()]
            .filter((run) => run.thread_id === threadId)
            .sort((a, b) =>
                String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.seq - b.seq);
    }

    payload(runId: string): any {
        return this.runs.get(runId)?.payload;
    }
}

// =============================================================================
// A local executor the test drives by hand
// =============================================================================

interface StartedRun {
    run: AgentRun;
    signal: AbortSignal;
    callbacks: WSCallbacks;
    finish: () => void;
}

let started: StartedRun[] = [];

executeLocalRequestMock.mockImplementation(
    (run: AgentRun, _request: unknown, _get: unknown, set: any, signal: AbortSignal) => {
        // Built synchronously as the run starts, like the real executor.
        const callbacks = createWSCallbacks(set);
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => { finish = resolve; });
        started.push({ run, signal, callbacks, finish });
        return settled;
    },
);

async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

/** Let detached writes land. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

async function send(message: string): Promise<{ local: StartedRun; sending: Promise<unknown> }> {
    const count = started.length;
    const sending = store.set(sendWSMessageAtom, message);
    await until(() => started.length === count + 1, `run for "${message}" to start`);
    return { local: started[count], sending };
}

/** End a run the way the runner does: its terminal event, then return. */
async function finish(local: StartedRun, sending: Promise<unknown>): Promise<void> {
    local.callbacks.onDone();
    local.finish();
    await sending;
}

function textPart(runId: string, content: string) {
    return {
        event: 'part',
        run_id: runId,
        message_index: 0,
        part_index: 0,
        part: { part_kind: 'text', content },
    } as any;
}

function toolCallPart(runId: string, toolCallId: string) {
    return {
        event: 'part',
        run_id: runId,
        message_index: 0,
        part_index: 1,
        part: { part_kind: 'tool-call', tool_name: 'create_highlight', tool_call_id: toolCallId, args: null },
    } as any;
}

function textOf(run: any): string {
    return JSON.stringify(run?.model_messages ?? []);
}

/** A proposal waiting on the user, as a local write tool leaves it. */
function proposeLocally(
    actionId: string,
    toolcallId: string,
    scope?: { runId: string; threadId: string },
    actionType = 'create_highlight',
) {
    let outcome: { approved: boolean } | null = null;
    void awaitApproval(actionId, toolcallId, actionType).then((result) => { outcome = result; });
    store.set(addPendingApprovalAtom, {
        event: 'deferred_approval_request',
        action_id: actionId,
        toolcall_id: toolcallId,
        action_type: actionType,
        action_data: {},
    } as any, scope as any);
    return { outcome: () => outcome };
}

let db: FakeDb;

const promptConfirmMock = vi.fn();

beforeEach(() => {
    executeLocalRequestMock.mockClear();
    saveInterruptedThreadMock.mockClear();
    undoEditMetadataMock.mockReset();
    undoEditMetadataMock.mockImplementation(async () => {});
    saveCommentToAnnotationMock.mockReset();
    saveCommentToAnnotationMock.mockImplementation(async () => ({ saved: true }));
    preparing.hold = null;
    // 'Undo && Retry' = 0, cancel = 1, 'Retry' (skip undo) = 2.
    promptConfirmMock.mockReset();
    promptConfirmMock.mockReturnValue(2);
    (Zotero as any).Prompt = { confirm: promptConfirmMock, BUTTON_TITLE_CANCEL: 'Cancel' };
    clearClientShutDownLatch();
    started = [];
    db = new FakeDb();
    (Zotero as any).AlphainZ = { db };
    (Zotero as any).Items = {
        getByLibraryAndKey: vi.fn(() => false),
        getByLibraryAndKeyAsync: vi.fn(async () => null),
        getAsync: vi.fn(async () => null),
        loadDataTypes: vi.fn(async () => {}),
    };
    store.set(selectedModelAtom, { name: 'test-model', provider: 'test' } as any);
    store.set(activeRunAtom, null);
    store.set(threadRunsAtom, []);
    store.set(currentThreadIdAtom, null);
    store.set(currentThreadNameAtom, null);
    store.set(threadAgentActionsAtom, []);
    store.set(pendingApprovalsAtom, new Map());
    store.set(isWSChatPendingAtom, false);
    store.set(retryPendingRunIdAtom, null);
    store.set(wsErrorAtom, null);
    store.set(wsRetryAtom, null);
    store.set(popupMessagesAtom, []);
    store.set(currentMessageItemsAtom, []);
    store.set(currentMessageContentAtom, '');
    // No dialogs: a retry that would ask goes ahead as confirmed.
    setHost({});
});

afterEach(async () => {
    for (const local of started) local.finish();
    await settle();
});

// =============================================================================
// Stopping
// =============================================================================

describe('stopping a local run', () => {
    it('hands the local executor a signal to be stopped by', async () => {
        const { local, sending } = await send('hello');

        expect(local.signal).toBeInstanceOf(AbortSignal);
        expect(local.signal.aborted).toBe(false);

        await finish(local, sending);
        expect(local.signal.aborted).toBe(false);
    });

    it('Stop aborts the model loop and keeps the stopped turn in the thread', async () => {
        const { local } = await send('summarise these papers');

        await store.set(closeWSConnectionAtom);

        expect(local.signal.aborted).toBe(true);
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([
            expect.objectContaining({ id: local.run.id, status: 'canceled' }),
        ]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('starting a new chat stops it', async () => {
        const { local } = await send('a long question');

        await store.set(newThreadAtom, { skipAutoPopulate: true });

        expect(local.signal.aborted).toBe(true);
    });

    it('opening another chat stops it', async () => {
        const { local } = await send('a long question');

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'another-thread',
            skipInstanceMismatchConfirm: true,
        });

        expect(local.signal.aborted).toBe(true);
    });

    it('retrying it while it streams stops it', async () => {
        const { local } = await send('the question');

        const retrying = store.set(regenerateFromRunAtom, local.run.id);
        await until(() => started.length === 2, 'the replacement run');

        expect(local.signal.aborted).toBe(true);
        await finish(started[1], retrying);
    });

    it('keeps a stopped run\'s late text and its end out of the run that replaced it', async () => {
        const first = await send('first question');
        await first.local.callbacks.onPart(textPart(first.local.run.id, 'the start of an answer'));
        await store.set(closeWSConnectionAtom);

        const second = await send('corrected question');
        // The first loop is still winding down: its last text and its end arrive now.
        await first.local.callbacks.onPart(textPart(first.local.run.id, 'late text from the old loop'));
        first.local.callbacks.onDone();
        first.local.finish();
        await first.sending;

        const active = store.get(activeRunAtom);
        expect(active?.id).toBe(second.local.run.id);
        expect(active?.status).toBe('in_progress');
        expect(textOf(active)).not.toContain('late text');
        // Still holding the composer: the old loop's end is not this run's.
        expect(store.get(isWSChatPendingAtom)).toBe(true);

        await second.local.callbacks.onPart(textPart(second.local.run.id, 'the right answer'));
        await finish(second.local, second.sending);

        expect(store.get(threadRunsAtom).map((run: AgentRun) => [run.id, run.status])).toEqual([
            [first.local.run.id, 'canceled'],
            [second.local.run.id, 'completed'],
        ]);
        expect(textOf(store.get(threadRunsAtom)[1])).toContain('the right answer');
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('does not let a stopped run move the open chat to its thread', async () => {
        const { local } = await send('a question in a new chat');
        await store.set(closeWSConnectionAtom);
        await store.set(newThreadAtom, { skipAutoPopulate: true });

        // The runner reports the thread as its loop starts — late, here.
        local.callbacks.onThread(local.run.id);

        expect(store.get(currentThreadIdAtom)).toBeNull();
    });

    it('does not surface a stopped run\'s own end as an error', async () => {
        const { local } = await send('a question');
        await store.set(closeWSConnectionAtom);

        local.callbacks.onError({
            event: 'error',
            type: 'run_cancelled',
            message: 'Run cancelled.',
            run_id: local.run.id,
            is_retryable: false,
        } as any);

        expect(store.get(wsErrorAtom)).toBeNull();
        expect(store.get(threadRunsAtom)[0].status).toBe('canceled');
    });

    it('is stopped within the Stop call itself, before anything is awaited', async () => {
        const { local } = await send('a question');

        const stopping = store.set(closeWSConnectionAtom);

        expect(local.signal.aborted).toBe(true);
        await stopping;
    });

    it('has already been stopped when the question card Stop clears is answered', async () => {
        const { local } = await send('a question that needs a choice');
        // The question tool is waiting on the user, as `ask_user_question` does.
        let stoppedWhenAnswered: boolean | null = null;
        void awaitAnswer(nextQuestionId()).then(() => { stoppedWhenAnswered = local.signal.aborted; });

        await store.set(closeWSConnectionAtom);
        await settle();

        // Read as a stop, not as a skip the model should carry on from.
        expect(stoppedWhenAnswered).toBe(true);
    });

    it('leaves the composer to the next message when it ends while that message is still being prepared', async () => {
        const first = await send('a question');
        await store.set(closeWSConnectionAtom);
        // Its loop is still inside a tool that does not listen for the stop.

        let prepared!: () => void;
        preparing.hold = new Promise<void>((resolve) => { prepared = resolve; });
        const count = started.length;
        const sending = store.set(sendWSMessageAtom, 'the next question');
        await settle();
        expect(store.get(isWSChatPendingAtom)).toBe(true);

        // The stopped loop gets out of its tool now, before the next run exists.
        first.local.finish();
        await first.sending;
        expect(store.get(isWSChatPendingAtom)).toBe(true);

        prepared();
        await until(() => started.length === count + 1, 'the next run');
        expect(store.get(activeRunAtom)?.id).toBe(started[count].run.id);
        expect(store.get(isWSChatPendingAtom)).toBe(true);

        await finish(started[count], sending);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('keeps a message stopped while it is still being prepared from going out', async () => {
        let prepared!: () => void;
        preparing.hold = new Promise<void>((resolve) => { prepared = resolve; });
        store.set(currentMessageContentAtom, 'a question with a typo');
        const sending = store.set(sendWSMessageAtom, 'a question with a typo');
        await settle();
        expect(store.get(isWSChatPendingAtom)).toBe(true);

        await store.set(closeWSConnectionAtom);
        prepared();
        await sending;
        await settle();

        expect(started).toHaveLength(0);
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(db.runs.size).toBe(0);
        // Nothing went out, so the draft is still there to be fixed.
        expect(store.get(currentMessageContentAtom)).toBe('a question with a typo');
    });
});

describe('a retry notice', () => {
    it('gives way to the generating clock once the retried request streams again', async () => {
        const { local, sending } = await send('a question');
        local.callbacks.onRetry?.({
            event: 'retry',
            run_id: local.run.id,
            attempt: 1,
            max_attempts: 3,
            reason: 'rate_limited',
            wait_seconds: 2,
        } as any);
        expect(store.get(wsRetryAtom)?.runId).toBe(local.run.id);

        await local.callbacks.onPart(textPart(local.run.id, 'the answer, at last'));

        expect(store.get(wsRetryAtom)).toBeNull();
        await finish(local, sending);
    });

    it('also ends when a tool result arrives', async () => {
        const { local, sending } = await send('a question');
        local.callbacks.onRetry?.({
            event: 'retry',
            run_id: local.run.id,
            attempt: 1,
            max_attempts: 3,
            reason: 'server_error',
            wait_seconds: 1,
        } as any);

        await local.callbacks.onToolReturn({
            event: 'tool_return',
            run_id: local.run.id,
            message_index: 1,
            part_index: 0,
            part: { part_kind: 'retry-prompt', content: 'try again', tool_name: 'search', tool_call_id: 'call-1' },
        } as any);

        expect(store.get(wsRetryAtom)).toBeNull();
        await finish(local, sending);
    });

    it('stays for another run\'s output', async () => {
        const { local, sending } = await send('a question');
        store.set(wsRetryAtom, { runId: 'some-other-run', attempt: 1, maxAttempts: 3, reason: 'x', waitSeconds: 1 } as any);

        await local.callbacks.onPart(textPart(local.run.id, 'text'));

        expect(store.get(wsRetryAtom)?.runId).toBe('some-other-run');
        await finish(local, sending);
    });
});

// =============================================================================
// Storing
// =============================================================================

describe('storing a local run', () => {
    it('stores the question the moment it is sent, as the stopped turn it is if nothing more is heard', async () => {
        const { local, sending } = await send('what does this paper measure?');
        await settle();

        const stored = db.payload(local.run.id);
        expect(stored).toMatchObject({
            id: local.run.id,
            status: 'canceled',
            user_prompt: expect.objectContaining({ content: 'what does this paper measure?' }),
        });
        expect(db.threads.get(local.run.id)?.name).toBe('what does this paper measure?');
        // On screen it is still being answered.
        expect(store.get(activeRunAtom)?.status).toBe('in_progress');

        // The answer takes its place once it arrives.
        await local.callbacks.onPart(textPart(local.run.id, 'It measures distance.'));
        await finish(local, sending);
        await settle();
        expect(db.payload(local.run.id).status).toBe('completed');
    });

    it('stores a stopped run with what it had streamed', async () => {
        const { local } = await send('summarise it');
        await local.callbacks.onPart(textPart(local.run.id, 'half an answer'));

        await store.set(closeWSConnectionAtom);
        await settle();

        const stored = db.payload(local.run.id);
        expect(stored.status).toBe('canceled');
        expect(JSON.stringify(stored.model_messages)).toContain('half an answer');
    });

    it('stores the stopped run when the user opens another chat', async () => {
        const { local } = await send('summarise it');
        await local.callbacks.onPart(textPart(local.run.id, 'half an answer'));

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'another-thread',
            skipInstanceMismatchConfirm: true,
        });
        await settle();

        expect(db.payload(local.run.id)?.status).toBe('canceled');
    });

    it('lets a later answer be retried after a turn in the middle was stopped', async () => {
        const first = await send('first question');
        first.local.callbacks.onThread(first.local.run.id);
        await first.local.callbacks.onPart(textPart(first.local.run.id, 'first answer'));
        await finish(first.local, first.sending);

        const stopped = await send('second question');
        await store.set(closeWSConnectionAtom);
        stopped.local.finish();
        await stopped.sending;

        const third = await send('third question');
        await finish(third.local, third.sending);

        const retrying = store.set(regenerateFromRunAtom, third.local.run.id);
        await until(() => started.length === 4, 'the retried run');

        expect(db.deleteRuns).toHaveBeenCalledWith(
            first.local.run.id,
            [third.local.run.id],
            stopped.local.run.id,
        );
        expect(store.get(popupMessagesAtom).some((m: any) => m.title === 'Chat changed elsewhere')).toBe(false);
        await finish(started[3], retrying);
    });

    it('quitting mid-answer stores the turn and records the chat to reopen', async () => {
        const { local } = await send('a question before quitting');
        local.callbacks.onThread(local.run.id);
        await local.callbacks.onPart(textPart(local.run.id, 'streamed so far'));

        store.set(closeWSConnectionForShutdownAtom, 'Zotero quitting', { rememberInterruptedThread: true });
        await settle();

        expect(local.signal.aborted).toBe(true);
        expect(saveInterruptedThreadMock).toHaveBeenCalledWith(
            expect.objectContaining({ threadId: local.run.id }),
        );
        expect(db.payload(local.run.id)?.status).toBe('canceled');
        expect(JSON.stringify(db.payload(local.run.id)?.model_messages)).toContain('streamed so far');
    });

    it('records the chat to reopen even before the runner reported its thread', async () => {
        const { local } = await send('a question before quitting');

        store.set(closeWSConnectionForShutdownAtom, 'Zotero quitting', { rememberInterruptedThread: true });

        expect(saveInterruptedThreadMock).toHaveBeenCalledWith(
            expect.objectContaining({ threadId: local.run.id }),
        );
    });
});

// =============================================================================
// Proposals
// =============================================================================

describe('"Allow all … for this run"', () => {
    it('approves the waiting proposals of that run and leaves another chat\'s alone', async () => {
        const here = proposeLocally('local-approval-here', 'call-here', { runId: 'run-here', threadId: 'thread-here' }, 'highlight_annotation');
        const elsewhere = proposeLocally('local-approval-elsewhere', 'call-elsewhere', { runId: 'run-elsewhere', threadId: 'thread-elsewhere' }, 'highlight_annotation');

        const approved = store.set(approveToolGroupForRunAtom, { runId: 'run-here', toolName: 'create_highlight_annotations' });
        await settle();

        expect(approved).toBe(1);
        expect(here.outcome()).toMatchObject({ approved: true });
        expect(elsewhere.outcome()).toBeNull();
        expect(store.get(pendingApprovalsAtom).has('local-approval-elsewhere')).toBe(true);
    });
});

describe('undecided proposals across runs', () => {
    it('stay pending when the next message is sent', async () => {
        const proposal = proposeLocally('local-approval-send', 'call-send');

        const { local, sending } = await send('a follow-up');
        await settle();

        expect(proposal.outcome()).toBeNull();
        expect(store.get(pendingApprovalsAtom).has('local-approval-send')).toBe(true);
        await finish(local, sending);
    });

    it('stay pending when the user presses Stop', async () => {
        const { local } = await send('a question');
        const proposal = proposeLocally('local-approval-stop', 'call-stop');

        await store.set(closeWSConnectionAtom);
        await settle();

        expect(local.signal.aborted).toBe(true);
        expect(proposal.outcome()).toBeNull();
        expect(store.get(pendingApprovalsAtom).has('local-approval-stop')).toBe(true);
    });

    it('stay pending when a run fails', async () => {
        const { local, sending } = await send('a question');
        const proposal = proposeLocally('local-approval-error', 'call-error');

        local.callbacks.onError({
            event: 'error',
            type: 'llm_rate_limit',
            message: 'Rate limited',
            run_id: local.run.id,
            is_retryable: true,
        } as any);
        await finish(local, sending);
        await settle();

        expect(proposal.outcome()).toBeNull();
        expect(store.get(pendingApprovalsAtom).has('local-approval-error')).toBe(true);
    });

    it('are declined only for the run a retry removes', async () => {
        const first = await send('first question');
        first.local.callbacks.onThread(first.local.run.id);
        await first.local.callbacks.onPart(toolCallPart(first.local.run.id, 'call-kept'));
        await finish(first.local, first.sending);
        const kept = proposeLocally('local-approval-kept', 'call-kept');

        const second = await send('second question');
        await second.local.callbacks.onPart(toolCallPart(second.local.run.id, 'call-removed'));
        await finish(second.local, second.sending);
        const removed = proposeLocally('local-approval-removed', 'call-removed');

        const retrying = store.set(regenerateFromRunAtom, second.local.run.id);
        await until(() => started.length === 3, 'the retried run');
        await settle();

        expect(removed.outcome()).toEqual(expect.objectContaining({ approved: false }));
        expect(store.get(pendingApprovalsAtom).has('local-approval-removed')).toBe(false);
        expect(kept.outcome()).toBeNull();
        expect(store.get(pendingApprovalsAtom).has('local-approval-kept')).toBe(true);
        await finish(started[2], retrying);
    });
});

// =============================================================================
// Agent actions
// =============================================================================

function action(runId: string, overrides: Record<string, unknown> = {}) {
    return {
        id: `action-${runId}`,
        run_id: runId,
        toolcall_id: 'call-1',
        action_type: 'edit_metadata',
        status: 'applied',
        proposed_data: { library_id: 1, zotero_key: 'ITEM1', edits: [] },
        result_data: { applied_edits: [] },
        created_at: '2026-09-24T10:00:00.000Z',
        ...overrides,
    } as any;
}

describe('agent actions are stored with their run', () => {
    it('saves a decision made after the answer into the run it belongs to', async () => {
        const { local, sending } = await send('fix the metadata');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        await settle();

        store.set(addAgentActionsAtom, [action(local.run.id)]);
        await settle();

        expect(db.payload(local.run.id).agent_actions).toEqual([
            expect.objectContaining({ id: `action-${local.run.id}`, status: 'applied' }),
        ]);
    });

    it('saves an undo as a change to the stored record', async () => {
        const { local, sending } = await send('fix the metadata');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        store.set(addAgentActionsAtom, [action(local.run.id)]);
        await settle();

        store.set(threadAgentActionsAtom, (actions: any[]) =>
            actions.map((a) => ({ ...a, status: 'undone', result_data: undefined })));
        await settle();

        expect(db.payload(local.run.id).agent_actions).toEqual([
            expect.objectContaining({ status: 'undone' }),
        ]);
    });

    it('brings the records back when the thread is reopened, and writes nothing back', async () => {
        db.threads.set('thread-old', { id: 'thread-old', user_id: 'local-user', name: 'Old chat' });
        await db.saveRun({
            id: 'run-old',
            thread_id: 'thread-old',
            user_id: 'local-user',
            created_at: '2026-09-20T10:00:00.000Z',
            payload: {
                id: 'run-old',
                thread_id: 'thread-old',
                user_id: 'local-user',
                status: 'completed',
                user_prompt: { content: 'fix the metadata' },
                model_messages: [],
                agent_actions: [action('run-old'), action('run-old', { id: 'action-rejected', status: 'rejected' })],
            },
        });
        db.saveRun.mockClear();

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'thread-old',
            skipInstanceMismatchConfirm: true,
        });
        await settle();

        expect(store.get(threadAgentActionsAtom).map((a: any) => [a.id, a.status])).toEqual([
            ['action-run-old', 'applied'],
            ['action-rejected', 'rejected'],
        ]);
        expect(store.get(threadRunsAtom)[0]).not.toHaveProperty('agent_actions');
        expect(db.saveRun).not.toHaveBeenCalled();
    });

    it('lets a Retry in a reopened chat offer to undo what the run applied', async () => {
        db.threads.set('thread-old', { id: 'thread-old', user_id: 'local-user', name: 'Old chat' });
        await db.saveRun({
            id: 'run-old',
            thread_id: 'thread-old',
            user_id: 'local-user',
            created_at: '2026-09-20T10:00:00.000Z',
            payload: {
                id: 'run-old',
                thread_id: 'thread-old',
                user_id: 'local-user',
                status: 'completed',
                user_prompt: { content: 'fix the metadata' },
                model_messages: [],
                agent_actions: [action('run-old')],
            },
        });
        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'thread-old',
            skipInstanceMismatchConfirm: true,
        });
        // Cancel.
        promptConfirmMock.mockReturnValue(1);

        await store.set(regenerateFromRunAtom, 'run-old');

        expect(promptConfirmMock).toHaveBeenCalledTimes(1);
        expect(promptConfirmMock.mock.calls[0][0].text).toContain('were applied and can be undone');
        expect(db.deleteRuns).not.toHaveBeenCalled();
    });

    it('does not bring back a run a retry deletes when its record changes during the retry', async () => {
        const first = await send('first question');
        first.local.callbacks.onThread(first.local.run.id);
        await finish(first.local, first.sending);
        const second = await send('second question');
        await finish(second.local, second.sending);
        store.set(addAgentActionsAtom, [action(second.local.run.id)]);
        await settle();
        expect(db.payload(second.local.run.id).agent_actions).toHaveLength(1);

        // "Undo && Retry": the undo marks the record undone after the rows
        // were deleted, while the run is still on screen.
        promptConfirmMock.mockReturnValue(0);
        undoEditMetadataMock.mockImplementation(async (undone: any) => {
            store.set(threadAgentActionsAtom, (actions: any[]) =>
                actions.map((a) => (a.id === undone.id ? { ...a, status: 'undone' } : a)));
        });

        const retrying = store.set(regenerateFromRunAtom, second.local.run.id);
        await until(() => started.length === 3, 'the retried run');
        await settle();

        expect(undoEditMetadataMock).toHaveBeenCalled();
        expect(db.runs.has(second.local.run.id)).toBe(false);
        await finish(started[2], retrying);
    });

    it('stores a decision that lands after the user opened another chat with its own run', async () => {
        const { local, sending } = await send('add these papers to my library');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        await settle();

        // Another chat is opened while the approved change is still being made.
        db.threads.set('thread-other', { id: 'thread-other', user_id: 'local-user', name: 'Other chat' });
        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'thread-other',
            skipInstanceMismatchConfirm: true,
        });

        // The outcome is recorded into the list on screen, as `recordAction` does.
        store.set(addAgentActionsAtom, [action(local.run.id)]);
        await settle();

        expect(db.payload(local.run.id).agent_actions).toEqual([
            expect.objectContaining({ id: `action-${local.run.id}`, status: 'applied' }),
        ]);
        // It belongs to no run of the chat on screen.
        expect(store.get(threadAgentActionsAtom)).toEqual([]);

        // And it is there, with its Undo, when its chat is opened again.
        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: local.run.id,
            skipInstanceMismatchConfirm: true,
        });
        expect(store.get(threadAgentActionsAtom).map((a: any) => [a.id, a.status])).toEqual([
            [`action-${local.run.id}`, 'applied'],
        ]);
    });

    it('keeps a decision that lands while its own chat is being opened', async () => {
        const { local, sending } = await send('add this paper to my library');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        store.set(addAgentActionsAtom, [action(local.run.id, { id: 'action-before' })]);
        await settle();
        await store.set(newThreadAtom, { skipAutoPopulate: true });

        // The Apply finishes just as the user opens the chat again.
        const unsubscribe = store.sub(currentThreadIdAtom, () => {
            if (store.get(currentThreadIdAtom) !== local.run.id) return;
            unsubscribe();
            store.set(addAgentActionsAtom, [action(local.run.id, { id: 'action-during-load' })]);
        });
        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: local.run.id,
            skipInstanceMismatchConfirm: true,
        });
        await settle();

        const expected = [['action-before', 'applied'], ['action-during-load', 'applied']];
        expect(store.get(threadAgentActionsAtom).map((a: any) => [a.id, a.status])).toEqual(expected);
        expect(db.payload(local.run.id).agent_actions.map((a: any) => [a.id, a.status])).toEqual(expected);
    });

    it('keeps a decision that lands while its chat\'s runs are being read', async () => {
        const { local, sending } = await send('add this paper to my library');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        store.set(addAgentActionsAtom, [action(local.run.id, { id: 'action-before' })]);
        await settle();
        await store.set(newThreadAtom, { skipAutoPopulate: true });

        // The Apply finishes after the runs were read, before they are shown.
        const readRuns = db.getRunsForThread.getMockImplementation()!;
        db.getRunsForThread.mockImplementationOnce(async (threadId: string) => {
            const runs = await readRuns(threadId);
            store.set(addAgentActionsAtom, [action(local.run.id, { id: 'action-during-read' })]);
            return runs;
        });
        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: local.run.id,
            skipInstanceMismatchConfirm: true,
        });
        await settle();

        const expected = [['action-before', 'applied'], ['action-during-read', 'applied']];
        expect(store.get(threadAgentActionsAtom).map((a: any) => [a.id, a.status])).toEqual(expected);
        expect(db.payload(local.run.id).agent_actions.map((a: any) => [a.id, a.status])).toEqual(expected);
    });

    it('adds a late decision to the records its run already has', async () => {
        const { local, sending } = await send('highlight the results');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        store.set(addAgentActionsAtom, [action(local.run.id, { id: 'action-first' })]);
        await settle();

        await store.set(newThreadAtom, { skipAutoPopulate: true });
        store.set(addAgentActionsAtom, [action(local.run.id, { id: 'action-late', status: 'rejected' })]);
        await settle();

        expect(db.payload(local.run.id).agent_actions.map((a: any) => [a.id, a.status])).toEqual([
            ['action-first', 'applied'],
            ['action-late', 'rejected'],
        ]);
    });
});

// =============================================================================
// The thread's name
// =============================================================================

describe('the thread name', () => {
    it('is not written over by a later answer once the user renamed the chat', async () => {
        db.threads.set('thread-named', { id: 'thread-named', user_id: 'local-user', name: 'My renamed chat' });
        store.set(currentThreadIdAtom, 'thread-named');
        // The in-memory name still holds the placeholder the chat started with.
        store.set(currentThreadNameAtom, 'what does this paper');

        const { local, sending } = await send('a follow-up');
        local.callbacks.onThread('thread-named');
        await finish(local, sending);
        await settle();

        expect(db.threads.get('thread-named')?.name).toBe('My renamed chat');
        expect(db.setThreadName).not.toHaveBeenCalled();
    });

    it('follows a rename of the open chat, from whichever list it came', async () => {
        db.threads.set('thread-open', { id: 'thread-open', user_id: 'local-user', name: 'Old name' });
        store.set(currentThreadIdAtom, 'thread-open');
        store.set(currentThreadNameAtom, 'Old name');

        await localRenameThread('thread-open', 'New name');

        expect(store.get(currentThreadNameAtom)).toBe('New name');
    });

    it('leaves the open chat\'s name alone when another chat is renamed', async () => {
        store.set(currentThreadIdAtom, 'thread-open');
        store.set(currentThreadNameAtom, 'Open chat');

        await localRenameThread('thread-other', 'Renamed elsewhere');

        expect(store.get(currentThreadNameAtom)).toBe('Open chat');
    });
});

// =============================================================================
// Highlights parked for a question
// =============================================================================

function parkAnchor(key: string) {
    stashPendingAnchor({
        annotation: { libraryID: 1, key } as any,
        attachment: { key: 'ATTACH1' } as any,
        selectedText: 'a passage',
    });
}

describe('a highlight parked for a question', () => {
    it('is not linked to a later run when its own run ended before it started', async () => {
        parkAnchor('ANCHOR1');
        const failed = await send('a question from the popup');
        failed.local.callbacks.onError({
            event: 'error',
            type: 'not_configured',
            message: 'Add an API key on this computer.',
            run_id: failed.local.run.id,
            is_retryable: false,
        } as any);
        await finish(failed.local, failed.sending);

        const next = await send('an unrelated question');
        next.local.callbacks.onThread('thread-unrelated');
        await finish(next.local, next.sending);
        await settle();

        expect(db.saveThreadAnchor).not.toHaveBeenCalled();
    });

    it('is not linked to the conversation opened next', async () => {
        store.set(currentThreadIdAtom, 'thread-asked-in');
        parkAnchor('ANCHOR2');

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'thread-opened-next',
            skipInstanceMismatchConfirm: true,
        });
        await drainPendingAnchor('thread-opened-next');

        expect(db.saveThreadAnchor).not.toHaveBeenCalled();
    });

    it('is still linked to the thread its own run reports', async () => {
        parkAnchor('ANCHOR3');
        const { local, sending } = await send('a question from the popup');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        await settle();

        expect(db.saveThreadAnchor).toHaveBeenCalledWith(
            expect.objectContaining({ annotationKey: 'ANCHOR3', threadId: local.run.id }),
        );
    });

    it('is not linked to a later run when its question never became a run', async () => {
        parkAnchor('ANCHOR4');
        // No libraries have been read yet, so a message with a paper in it is
        // turned away before any run exists.
        store.set(currentMessageItemsAtom, [{ libraryID: 1, key: 'PAPER1' } as any]);
        await store.set(sendWSMessageAtom, 'what does this term mean?', {
            origin: { kind: 'selection_chat', annotation_key: 'ANCHOR4', library_id: 1 },
        });
        expect(started).toHaveLength(0);

        store.set(currentMessageItemsAtom, []);
        const next = await send('an unrelated question');
        next.local.callbacks.onThread('thread-unrelated');
        await finish(next.local, next.sending);
        await settle();

        expect(db.saveThreadAnchor).not.toHaveBeenCalled();
    });

    it('stays parked when an older question is turned away', async () => {
        // A newer popup question has parked its highlight; the older one, about
        // another passage, is refused before any run exists.
        parkAnchor('ANCHOR-NEW');
        store.set(currentMessageItemsAtom, [{ libraryID: 1, key: 'PAPER1' } as any]);
        await store.set(sendWSMessageAtom, 'what did that older passage mean?', {
            origin: { kind: 'selection_chat', annotation_key: 'ANCHOR-OLD', library_id: 1 },
        });
        expect(started).toHaveLength(0);
        store.set(currentMessageItemsAtom, []);

        const { local, sending } = await send('the newer question');
        local.callbacks.onThread(local.run.id);
        await finish(local, sending);
        await settle();

        expect(db.saveThreadAnchor).toHaveBeenCalledWith(
            expect.objectContaining({ annotationKey: 'ANCHOR-NEW', threadId: local.run.id }),
        );
    });
});

// =============================================================================
// Saving a selection answer into its highlight
// =============================================================================

describe('the offer to save a selection answer into its highlight', () => {
    const origin = { kind: 'selection_chat', annotation_key: 'ANCHORX', library_id: 1 } as const;

    function offers(): any[] {
        return store.get(popupMessagesAtom).filter((m: any) => String(m.id).startsWith('selection-comment-'));
    }

    async function askAboutTheHighlight(question: string): Promise<StartedRun> {
        const count = started.length;
        const sending = store.set(sendWSMessageAtom, question, { origin });
        await until(() => started.length === count + 1, `run for "${question}"`);
        const local = started[count];
        local.callbacks.onThread(store.get(currentThreadIdAtom) ?? local.run.id);
        await local.callbacks.onPart(textPart(local.run.id, `An answer to: ${question}`));
        await finish(local, sending);
        return local;
    }

    beforeEach(() => {
        (Zotero as any).Items.getByLibraryAndKey = vi.fn(() => ({
            annotationText: 'a passage',
            annotationPageLabel: '3',
            annotationColor: '#e56eee',
        }));
    });

    it('is one card per highlight, however many answers it has', async () => {
        await askAboutTheHighlight('what does this term mean?');
        await askAboutTheHighlight('and how is it measured?');

        expect(offers()).toHaveLength(1);
    });

    it('goes away when a new chat is started', async () => {
        await askAboutTheHighlight('what does this term mean?');
        expect(offers()).toHaveLength(1);

        await store.set(newThreadAtom, { skipAutoPopulate: true });

        expect(offers()).toHaveLength(0);
    });

    it('goes away when another chat is opened', async () => {
        await askAboutTheHighlight('what does this term mean?');

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'another-thread',
            skipInstanceMismatchConfirm: true,
        });

        expect(offers()).toHaveLength(0);
    });

    it('keeps the newer card when a Save on the card it replaced finishes late', async () => {
        let finishSaving!: (result: { saved: true }) => void;
        saveCommentToAnnotationMock.mockImplementationOnce(
            () => new Promise((resolve) => { finishSaving = resolve; }),
        );
        await askAboutTheHighlight('what does this term mean?');
        const saving = offers()[0].customContent.props.onSave();

        await askAboutTheHighlight('and how is it measured?');
        finishSaving({ saved: true });
        await saving;

        expect(offers()).toHaveLength(1);
        expect(offers()[0].customContent.props.preview).toContain('and how is it measured?');
    });

    it('stays, saying why, when Zotero will not let the highlight change', async () => {
        const refusal = {
            saved: false,
            reason: 'read_only',
            message: 'Zotero does not let you change that highlight, so the answer could not be added to its comment.',
        };
        saveCommentToAnnotationMock.mockImplementationOnce(async () => refusal);
        await askAboutTheHighlight('what does this term mean?');

        const outcome = await offers()[0].customContent.props.onSave();

        // The card shows the reason itself and keeps Save for another try.
        expect(outcome).toEqual(refusal);
        expect(offers()).toHaveLength(1);
    });

    it('goes, saying so, when the highlight no longer exists', async () => {
        saveCommentToAnnotationMock.mockImplementationOnce(async () => ({
            saved: false,
            reason: 'missing',
            message: 'That highlight no longer exists.',
        }));
        await askAboutTheHighlight('what does this term mean?');

        await offers()[0].customContent.props.onSave();

        expect(offers()).toHaveLength(0);
        expect(store.get(popupMessagesAtom).some((m: any) => m.type === 'error' && m.text === 'That highlight no longer exists.')).toBe(true);
    });
});

// =============================================================================
// Retrying an earlier answer
// =============================================================================

describe('retrying an answer with later exchanges after it', () => {
    async function threeExchanges(): Promise<StartedRun[]> {
        const runs: StartedRun[] = [];
        for (const question of ['first question', 'second question', 'third question']) {
            const { local, sending } = await send(question);
            if (runs.length === 0) local.callbacks.onThread(local.run.id);
            await finish(local, sending);
            runs.push(local);
        }
        await settle();
        return runs;
    }

    it('asks first, and changes nothing when the user says no', async () => {
        const confirm = vi.fn(() => false);
        setHost({ dialogs: { confirm } });
        const [first, second, third] = await threeExchanges();

        await store.set(regenerateFromRunAtom, first.run.id);

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0].text).toContain('the 2 questions and answers');
        expect(db.deleteRuns).not.toHaveBeenCalled();
        expect(started).toHaveLength(3);
        expect(store.get(threadRunsAtom).map((run: AgentRun) => run.id)).toEqual([
            first.run.id, second.run.id, third.run.id,
        ]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('goes ahead once the user agrees', async () => {
        setHost({ dialogs: { confirm: vi.fn(() => true) } });
        const [first, second, third] = await threeExchanges();

        const retrying = store.set(regenerateFromRunAtom, first.run.id);
        await until(() => started.length === 4, 'the retried run');

        expect(db.deleteRuns).toHaveBeenCalledWith(
            first.run.id,
            [first.run.id, second.run.id, third.run.id],
            null,
        );
        await finish(started[3], retrying);
    });

    it('does not ask when the last answer is retried', async () => {
        const confirm = vi.fn(() => false);
        setHost({ dialogs: { confirm } });
        const [, , third] = await threeExchanges();

        const retrying = store.set(regenerateFromRunAtom, third.run.id);
        await until(() => started.length === 4, 'the retried run');

        expect(confirm).not.toHaveBeenCalled();
        await finish(started[3], retrying);
    });

    it('names the later exchanges in the question about undoing applied changes', async () => {
        const first = await send('first question');
        first.local.callbacks.onThread(first.local.run.id);
        await finish(first.local, first.sending);
        const second = await send('fix the metadata');
        await finish(second.local, second.sending);
        store.set(addAgentActionsAtom, [action(second.local.run.id)]);
        await settle();
        // Cancel.
        promptConfirmMock.mockReturnValue(1);

        await store.set(regenerateFromRunAtom, first.local.run.id);

        expect(promptConfirmMock).toHaveBeenCalledTimes(1);
        expect(promptConfirmMock.mock.calls[0][0].text)
            .toContain('also removes the question and answer after it');
        expect(db.deleteRuns).not.toHaveBeenCalled();
    });

    it('keeps an edited question open when the user says no', async () => {
        setHost({ dialogs: { confirm: vi.fn(() => false) } });
        const [first] = await threeExchanges();
        const onProceed = vi.fn();

        await store.set(regenerateWithEditedPromptAtom, {
            runId: first.run.id,
            editedPrompt: { ...first.run.user_prompt, content: 'first question, corrected' },
            onProceed,
        });

        expect(onProceed).not.toHaveBeenCalled();
        expect(db.deleteRuns).not.toHaveBeenCalled();
    });

    it('closes the editor once the user agrees', async () => {
        setHost({ dialogs: { confirm: vi.fn(() => true) } });
        const [first] = await threeExchanges();
        const onProceed = vi.fn();

        const retrying = store.set(regenerateWithEditedPromptAtom, {
            runId: first.run.id,
            editedPrompt: { ...first.run.user_prompt, content: 'first question, corrected' },
            onProceed,
        });
        await until(() => started.length === 4, 'the edited run');

        expect(onProceed).toHaveBeenCalledTimes(1);
        expect(started[3].run.user_prompt.content).toBe('first question, corrected');
        await finish(started[3], retrying);
    });
});

describe('retrying an earlier answer while a later one is still being written', () => {
    /** Two answered exchanges, and a third question whose answer is still streaming. */
    async function twoAnsweredAndOneStreaming() {
        const first = await send('first question');
        first.local.callbacks.onThread(first.local.run.id);
        await finish(first.local, first.sending);
        const second = await send('second question');
        await finish(second.local, second.sending);
        const third = await send('third question');
        await third.local.callbacks.onPart(textPart(third.local.run.id, 'half of the third answer'));
        await settle();
        return { first: first.local, second: second.local, third };
    }

    it('asks first, naming the answer being written, and leaves it running when the user says no', async () => {
        const confirm = vi.fn(() => false);
        setHost({ dialogs: { confirm } });
        const { second, third } = await twoAnsweredAndOneStreaming();

        await store.set(regenerateFromRunAtom, second.run.id);
        await settle();

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0].text).toContain('the question and answer after it');
        expect(confirm.mock.calls[0][0].text).toContain('including the answer still being written');
        expect(third.local.signal.aborted).toBe(false);
        expect(store.get(activeRunAtom)).toMatchObject({ id: third.local.run.id, status: 'in_progress' });
        expect(store.get(isWSChatPendingAtom)).toBe(true);
        expect(db.deleteRuns).not.toHaveBeenCalled();
        expect(store.get(popupMessagesAtom).some((m: any) => m.title === 'Chat changed elsewhere')).toBe(false);
    });

    it('stops it and removes it with the rest once the user agrees', async () => {
        setHost({ dialogs: { confirm: vi.fn(() => true) } });
        const { first, second, third } = await twoAnsweredAndOneStreaming();
        // Stopped before the removal is committed, not left calling the model
        // and its tools while the retry deletes it.
        let stoppedBeforeRemoval: boolean | null = null;
        const deleteRuns = db.deleteRuns.getMockImplementation()!;
        db.deleteRuns.mockImplementationOnce(async (...args: Parameters<typeof deleteRuns>) => {
            stoppedBeforeRemoval = third.local.signal.aborted;
            return deleteRuns(...args);
        });

        const retrying = store.set(regenerateFromRunAtom, second.run.id);
        await until(() => started.length === 4, 'the retried run');

        expect(stoppedBeforeRemoval).toBe(true);
        expect(db.deleteRuns).toHaveBeenCalledWith(
            first.run.id,
            [second.run.id, third.local.run.id],
            first.run.id,
        );
        expect(store.get(popupMessagesAtom).some((m: any) => m.title === 'Chat changed elsewhere')).toBe(false);
        expect(store.get(threadRunsAtom).map((run: AgentRun) => run.id)).toEqual([first.run.id]);
        expect(started[3].run.user_prompt.content).toBe('second question');
        await settle();
        expect(db.runs.has(third.local.run.id)).toBe(false);

        // The stopped loop ends late; the retried answer keeps the composer.
        third.local.callbacks.onDone();
        third.local.finish();
        await third.sending;
        expect(store.get(activeRunAtom)?.id).toBe(started[3].run.id);
        expect(store.get(isWSChatPendingAtom)).toBe(true);

        await finish(started[3], retrying);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(threadRunsAtom).map((run: AgentRun) => [run.id, run.status])).toEqual([
            [first.run.id, 'completed'],
            [started[3].run.id, 'completed'],
        ]);
    });

    it('keeps it, stopped with what it had written, when the removal cannot be made', async () => {
        setHost({ dialogs: { confirm: vi.fn(() => true) } });
        const { first, second, third } = await twoAnsweredAndOneStreaming();
        db.deleteRuns.mockImplementationOnce(async () => { throw new Error('database is locked'); });

        await store.set(regenerateFromRunAtom, second.run.id);
        await settle();

        expect(third.local.signal.aborted).toBe(true);
        expect(started).toHaveLength(3);
        expect(store.get(threadRunsAtom).map((run: AgentRun) => [run.id, run.status])).toEqual([
            [first.run.id, 'completed'],
            [second.run.id, 'completed'],
            [third.local.run.id, 'canceled'],
        ]);
        expect(db.payload(third.local.run.id)?.status).toBe('canceled');
        expect(textOf(db.payload(third.local.run.id))).toContain('half of the third answer');
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(retryPendingRunIdAtom)).toBeNull();
        expect(store.get(popupMessagesAtom).some((m: any) => m.title === 'Retry failed')).toBe(true);
    });

    it('declines what the stopped answer proposed, with the rest of what the retry removes', async () => {
        setHost({ dialogs: { confirm: vi.fn(() => true) } });
        const { second, third } = await twoAnsweredAndOneStreaming();
        await third.local.callbacks.onPart(toolCallPart(third.local.run.id, 'call-streaming'));
        const proposal = proposeLocally('local-approval-streaming', 'call-streaming');

        const retrying = store.set(regenerateFromRunAtom, second.run.id);
        await until(() => started.length === 4, 'the retried run');
        await settle();

        expect(proposal.outcome()).toEqual(expect.objectContaining({ approved: false }));
        expect(store.get(pendingApprovalsAtom).has('local-approval-streaming')).toBe(false);
        await finish(started[3], retrying);
    });
});
