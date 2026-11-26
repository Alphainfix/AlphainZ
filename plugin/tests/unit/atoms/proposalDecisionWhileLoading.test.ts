/**
 * A decision on a proposal, landing while its conversation is read back.
 *
 * A proposal the user is asked about is stored as a pending record the moment
 * its card appears, and the decision takes that record's place under the same
 * id. An Apply can take seconds to finish (adding a paper), so the decision
 * may land while the proposal's own chat is being opened, while its runs are
 * being read, or while a sync refresh re-reads the open chat. Each time, the
 * record read back still says pending, and the decision has to win — on screen
 * and in the database — or the change comes back asking to be applied again,
 * without the result its Undo works from.
 *
 * The local executor is replaced by a stand-in that builds its callbacks the
 * way the real one does and then waits until the test ends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeLocalRequestMock } = vi.hoisted(() => ({
    executeLocalRequestMock: vi.fn(),
}));

vi.mock('../../../react/utils/editMetadataActions', () => ({
    undoEditMetadataAction: vi.fn(async () => {}),
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
    getApplicationStateProvider: vi.fn(() => async () => ({})),
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
    saveInterruptedThread: vi.fn(),
}));
// No title requests: they would go to a model.
vi.mock('@beaver/agent-llm/threadTitle', () => ({
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
    pendingApprovalsAtom,
    threadAgentActionsAtom,
    upsertAgentActionsAtom,
} from '../../../react/agents/agentActions';
import { selectedModelAtom } from '../../../react/atoms/models';
import { popupMessagesAtom } from '../../../react/atoms/ui';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../../../react/atoms/messageComposition';
import {
    clearClientShutDownLatch,
    createWSCallbacks,
    isWSChatPendingAtom,
    retryPendingRunIdAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { loadThreadAtom, newThreadAtom, refreshThreadInPlaceAtom } from '../../../react/atoms/threads';

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

    getRunsForThread = vi.fn(async (threadId: string) =>
        this.stored(threadId).map((run) => structuredClone(run.payload)));

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
    callbacks: WSCallbacks;
    finish: () => void;
}

let started: StartedRun[] = [];

executeLocalRequestMock.mockImplementation(
    (run: AgentRun, _request: unknown, _get: unknown, set: any) => {
        const callbacks = createWSCallbacks(set);
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => { finish = resolve; });
        started.push({ run, callbacks, finish });
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

/** A finished run in its own chat, with one proposal stored undecided. */
async function answeredWithProposal(): Promise<string> {
    const count = started.length;
    const sending = store.set(sendWSMessageAtom, 'add this paper to my library');
    await until(() => started.length === count + 1, 'the run to start');
    const local = started[count];
    local.callbacks.onThread(local.run.id);
    local.callbacks.onDone();
    local.finish();
    await sending;
    // As proposeWrite records it when the card appears.
    store.set(addAgentActionsAtom, [proposal(local.run.id, 'pending')]);
    await settle();
    expect(storedStatuses(local.run.id)).toEqual([['proposal-1', 'pending']]);
    return local.run.id;
}

function proposal(runId: string, status: string, overrides: Record<string, unknown> = {}) {
    return {
        id: 'proposal-1',
        run_id: runId,
        toolcall_id: 'call-1',
        action_type: 'create_item',
        status,
        proposed_data: { item: { title: 'Waggle-dance odometry' } },
        created_at: '2026-09-24T10:00:00.000Z',
        ...overrides,
    } as any;
}

/** The decision taking the proposal's place, as recordAction does it. */
function decide(runId: string, status: 'applied' | 'rejected') {
    store.set(upsertAgentActionsAtom, [proposal(runId, status, status === 'applied'
        ? { result_data: { library_id: 1, zotero_key: 'NEWITEM1' } }
        : {})]);
}

const onScreen = () => (store.get(threadAgentActionsAtom) as any[]).map((a) => [a.id, a.status]);
const storedStatuses = (runId: string) =>
    (db.payload(runId)?.agent_actions ?? []).map((a: any) => [a.id, a.status]);

let db: FakeDb;

beforeEach(() => {
    executeLocalRequestMock.mockClear();
    (Zotero as any).Prompt = { confirm: vi.fn(() => 0), BUTTON_TITLE_CANCEL: 'Cancel' };
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
    setHost({});
});

afterEach(async () => {
    for (const local of started) local.finish();
    await settle();
});

describe('a decision on a proposal stored undecided', () => {
    it('is kept, with its Undo data, when it lands while its own chat is being opened', async () => {
        const runId = await answeredWithProposal();
        await store.set(newThreadAtom, { skipAutoPopulate: true });

        // The Apply finishes just as the user opens the chat again.
        const unsubscribe = store.sub(currentThreadIdAtom, () => {
            if (store.get(currentThreadIdAtom) !== runId) return;
            unsubscribe();
            decide(runId, 'applied');
        });
        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: runId,
            skipInstanceMismatchConfirm: true,
        });
        await settle();

        expect(onScreen()).toEqual([['proposal-1', 'applied']]);
        expect(storedStatuses(runId)).toEqual([['proposal-1', 'applied']]);
        expect((store.get(threadAgentActionsAtom) as any[])[0].result_data)
            .toEqual({ library_id: 1, zotero_key: 'NEWITEM1' });
        expect(db.payload(runId).agent_actions[0].result_data)
            .toEqual({ library_id: 1, zotero_key: 'NEWITEM1' });
    });

    it('is kept when it lands while its chat\'s runs are being read', async () => {
        const runId = await answeredWithProposal();
        await store.set(newThreadAtom, { skipAutoPopulate: true });

        // The Apply finishes after the runs were read, before they are shown.
        const readRuns = db.getRunsForThread.getMockImplementation()!;
        db.getRunsForThread.mockImplementationOnce(async (threadId: string) => {
            const runs = await readRuns(threadId);
            decide(runId, 'applied');
            return runs;
        });
        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: runId,
            skipInstanceMismatchConfirm: true,
        });
        await settle();

        expect(onScreen()).toEqual([['proposal-1', 'applied']]);
        expect(storedStatuses(runId)).toEqual([['proposal-1', 'applied']]);
    });

    it('is kept when it is made while a sync refresh reads the open chat', async () => {
        const runId = await answeredWithProposal();

        // The user clicks Reject on the card while the refresh is reading.
        const readRuns = db.getRunsForThread.getMockImplementation()!;
        db.getRunsForThread.mockImplementationOnce(async (threadId: string) => {
            const runs = await readRuns(threadId);
            decide(runId, 'rejected');
            return runs;
        });
        await store.set(refreshThreadInPlaceAtom, { userId: 'local-user', threadId: runId });
        await settle();

        expect(onScreen()).toEqual([['proposal-1', 'rejected']]);
        expect(storedStatuses(runId)).toEqual([['proposal-1', 'rejected']]);
    });

    it('is stored into its run when it lands while another chat is open', async () => {
        const runId = await answeredWithProposal();
        await store.set(newThreadAtom, { skipAutoPopulate: true });

        decide(runId, 'applied');
        await settle();

        expect(storedStatuses(runId)).toEqual([['proposal-1', 'applied']]);
    });
});

describe('a proposal nobody has decided', () => {
    it('comes back undecided when its chat is opened, and nothing is written for it', async () => {
        const runId = await answeredWithProposal();
        await store.set(newThreadAtom, { skipAutoPopulate: true });
        const writesBefore = db.saveRun.mock.calls.length;

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: runId,
            skipInstanceMismatchConfirm: true,
        });
        await settle();

        expect(onScreen()).toEqual([['proposal-1', 'pending']]);
        expect(storedStatuses(runId)).toEqual([['proposal-1', 'pending']]);
        expect(db.saveRun.mock.calls.length).toBe(writesBefore);
    });
});
