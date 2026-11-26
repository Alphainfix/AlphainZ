/**
 * The message the user is writing belongs to them.
 *
 * A question sent from somewhere other than the composer — a suggestion chip,
 * the reader's Explain or selection popup — must not take the draft with it,
 * nor the papers staged for it. Starting a new chat, opening another one, or a
 * conversation arriving from another computer must not throw it away either:
 * a draft stays with the conversation it was written in and comes back with
 * it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeLocalRequestMock, importAllMock, dispatchMock } = vi.hoisted(() => ({
    executeLocalRequestMock: vi.fn(),
    importAllMock: vi.fn(),
    dispatchMock: vi.fn(),
}));

vi.mock('../../../react/atoms/executeLocalRun', () => ({
    executeLocalRequest: (...args: unknown[]) => executeLocalRequestMock(...args),
}));
// The window's event bus is not under test; a staged question asks it to
// focus the composer, and that request is all these cases look at.
vi.mock('../../../react/events/eventManager', () => ({
    eventManager: { dispatch: dispatchMock, subscribe: vi.fn(() => () => {}) },
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
vi.mock('@beaver/agent-llm/threadTitle', () => ({
    generateThreadTitle: vi.fn(async () => null),
}));
// A sync backend that brings in whatever the test says arrived.
vi.mock('../../../src/services/conversationSync', () => ({
    conversationSyncMode: () => 'folder',
    getConversationBackend: () => ({
        kind: 'folder',
        reconcileArchive: vi.fn(async () => ({ archived: 0, restored: 0 })),
        importAll: importAllMock,
        writeThread: vi.fn(async () => true),
    }),
}));
vi.mock('../../../react/utils/settingsSyncClient', () => ({
    importSettingsNow: vi.fn(async () => {}),
}));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';
import {
    activeRunAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
    isLoadingThreadAtom,
    threadRunsAtom,
} from '@beaver/agent-core/run-state/atoms';
import { store } from '../../../react/store';
import { selectedModelAtom } from '../../../react/atoms/models';
import { localZoteroLibrariesAtom } from '../../../react/atoms/profile';
import {
    clearComposerAtom,
    currentMessageCollectionsAtom,
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
    stagedReaderPromptAtom,
} from '../../../react/atoms/messageComposition';
import {
    clearClientShutDownLatch,
    createWSCallbacks,
    isWSChatPendingAtom,
    retryPendingRunIdAtom,
    sendWSMessageAtom,
} from '../../../react/atoms/agentRunAtoms';
import { loadThreadAtom, newThreadAtom } from '../../../react/atoms/threads';
import { continueOrStartThread, deliverPrompt } from '../../../react/utils/readerChatDelivery';
import { syncConversationsNow } from '../../../react/atoms/loadLocalThreads';

// =============================================================================
// Harness
// =============================================================================

interface StartedRun {
    run: AgentRun;
    callbacks: WSCallbacks;
    finish: () => void;
}

let started: StartedRun[] = [];

executeLocalRequestMock.mockImplementation((run: AgentRun, _request: unknown, _get: unknown, set: any) => {
    const callbacks = createWSCallbacks(set);
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    started.push({ run, callbacks, finish });
    return settled;
});

async function until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** Send, let the run start, and end it at once. */
async function sendAndFinish(message: string, options?: any): Promise<StartedRun> {
    const count = started.length;
    const sending = store.set(sendWSMessageAtom, message, options);
    await until(() => started.length === count + 1, `run for "${message}"`);
    const local = started[count];
    local.callbacks.onDone();
    local.finish();
    await sending;
    return local;
}

function item(key: string): Zotero.Item {
    return {
        libraryID: 1,
        key,
        id: key.length,
        isRegularItem: () => true,
        isAttachment: () => false,
        isNote: () => false,
        isAnnotation: () => false,
        parentItem: null,
    } as unknown as Zotero.Item;
}

function attachedKeys(run: AgentRun): string[] {
    return (run.user_prompt.attachments ?? []).map((a: any) => a.zotero_key);
}

function stagedKeys(): string[] {
    return store.get(currentMessageItemsAtom).map((i: Zotero.Item) => i.key);
}

class FakeDb {
    threads = new Map<string, { id: string; name: string | null; updatedAt: string }>();
    runs: any[] = [];

    saveRun = vi.fn(async (run: any) => {
        this.runs = this.runs.filter((r) => r.id !== run.id).concat([structuredClone(run)]);
        const thread = this.threads.get(run.thread_id);
        if (thread) thread.updatedAt = new Date().toISOString();
        else this.threads.set(run.thread_id, { id: run.thread_id, name: null, updatedAt: new Date().toISOString() });
    });
    ensureThread = vi.fn(async (id: string, _user: string, name: string) => {
        if (!this.threads.has(id)) this.threads.set(id, { id, name: name || null, updatedAt: '' });
    });
    getThread = vi.fn(async (_user: string, id: string) => {
        const thread = this.threads.get(id);
        return thread ? { id, name: thread.name ?? '', createdAt: '', updatedAt: thread.updatedAt } : null;
    });
    setThreadName = vi.fn(async () => {});
    getRunsForThread = vi.fn(async (threadId: string) =>
        this.runs.filter((r) => r.thread_id === threadId).map((r) => structuredClone(r.payload)));
    getRunIdsForThread = vi.fn(async (threadId: string) =>
        this.runs.filter((r) => r.thread_id === threadId).map((r) => r.id));
    recordThreadItems = vi.fn(async () => {});
}

let db: FakeDb;

beforeEach(() => {
    executeLocalRequestMock.mockClear();
    importAllMock.mockReset();
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
    store.set(localZoteroLibrariesAtom, [{ library_id: 1, name: 'My Library', is_group: false } as any]);
    store.set(activeRunAtom, null);
    store.set(threadRunsAtom, []);
    store.set(currentThreadIdAtom, null);
    store.set(currentThreadNameAtom, null);
    store.set(isWSChatPendingAtom, false);
    store.set(retryPendingRunIdAtom, null);
    store.set(clearComposerAtom);
    store.set(currentMessageItemsAtom, []);
    store.set(currentMessageCollectionsAtom, []);
});

afterEach(async () => {
    for (const local of started) local.finish();
    await settle();
});

// =============================================================================
// Switching conversations
// =============================================================================

describe('a draft stays with its conversation', () => {
    it('is kept when the user leaves it and comes back', () => {
        store.set(currentMessageContentAtom, 'a follow-up about waggle dances');
        store.set(currentMessageItemsAtom, [item('PAPER1')]);

        store.set(clearComposerAtom, { from: 'thread-a', to: 'thread-b' });
        expect(store.get(currentMessageContentAtom)).toBe('');
        expect(stagedKeys()).toEqual([]);

        store.set(clearComposerAtom, { from: 'thread-b', to: 'thread-a' });
        expect(store.get(currentMessageContentAtom)).toBe('a follow-up about waggle dances');
        expect(stagedKeys()).toEqual(['PAPER1']);
    });

    it('stays put when the conversation it is in is reloaded', () => {
        store.set(currentMessageContentAtom, 'half a question');

        store.set(clearComposerAtom, { from: 'thread-a', to: 'thread-a' });

        expect(store.get(currentMessageContentAtom)).toBe('half a question');
    });

    it('is still cleared after it is sent', () => {
        store.set(currentMessageContentAtom, 'sent already');
        store.set(currentMessagePillsAtom, [{ commandName: 'summarize', actionId: 'a1' } as any]);

        store.set(clearComposerAtom);

        expect(store.get(currentMessageContentAtom)).toBe('');
        expect(store.get(currentMessagePillsAtom)).toEqual([]);
    });

    it('survives New chat and opening it again from the history', async () => {
        store.set(currentThreadIdAtom, 'thread-a');
        store.set(currentMessageContentAtom, 'a long careful question');
        store.set(currentMessageItemsAtom, [item('PAPER1')]);

        await store.set(newThreadAtom, { skipAutoPopulate: true });
        expect(store.get(currentMessageContentAtom)).toBe('');

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'thread-a',
            skipInstanceMismatchConfirm: true,
        });
        expect(store.get(currentMessageContentAtom)).toBe('a long careful question');
        expect(stagedKeys()).toEqual(['PAPER1']);
    });

    it('survives switching to another chat and back', async () => {
        store.set(currentThreadIdAtom, 'thread-a');
        store.set(currentMessageContentAtom, 'a draft for thread a');

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'thread-b',
            skipInstanceMismatchConfirm: true,
        });
        expect(store.get(currentMessageContentAtom)).toBe('');

        await store.set(loadThreadAtom, {
            user_id: 'local-user',
            threadId: 'thread-a',
            skipInstanceMismatchConfirm: true,
        });
        expect(store.get(currentMessageContentAtom)).toBe('a draft for thread a');
    });
});

// =============================================================================
// Sends from outside the composer
// =============================================================================

describe('a question sent from outside the composer', () => {
    it('leaves the draft in the composer', async () => {
        store.set(currentThreadIdAtom, 'thread-a');
        store.set(currentMessageContentAtom, 'my half-written follow-up');

        const local = await sendAndFinish('Compare with the 2023 Science paper');

        expect(local.run.user_prompt.content).toBe('Compare with the 2023 Science paper');
        expect(store.get(currentMessageContentAtom)).toBe('my half-written follow-up');
    });

    it('still clears the composer when the composer sent it', async () => {
        store.set(currentThreadIdAtom, 'thread-a');
        store.set(currentMessageContentAtom, 'my question');
        store.set(currentMessageItemsAtom, [item('PAPER1')]);

        const local = await sendAndFinish('my question');

        expect(attachedKeys(local.run)).toEqual(['PAPER1']);
        expect(store.get(currentMessageContentAtom)).toBe('');
        expect(stagedKeys()).toEqual([]);
    });

    it('from the reader takes only what the reader staged, not the user\'s papers', async () => {
        store.set(currentThreadIdAtom, 'thread-a');
        store.set(currentMessageContentAtom, 'a question about my two papers');
        store.set(currentMessageItemsAtom, [item('MINE1'), item('MINE2')]);

        // An annotation Explain: continue the chat, stage the annotation, send.
        await continueOrStartThread(async () => {});
        store.set(currentMessageItemsAtom, [...store.get(currentMessageItemsAtom), item('ANNOT1')]);
        const count = started.length;
        // Sending resolves when the run ends, so the run is ended by hand.
        const delivering = deliverPrompt(
            (message: string) => store.set(sendWSMessageAtom, message),
            'Explain the selected annotation(s)',
        );
        await until(() => started.length === count + 1, 'the explain run');
        const local = started[count];
        local.callbacks.onDone();
        local.finish();
        expect(await delivering).toBe('sent');

        expect(attachedKeys(local.run)).toEqual(['ANNOT1']);
        expect(stagedKeys()).toEqual(['MINE1', 'MINE2']);
        expect(store.get(currentMessageContentAtom)).toBe('a question about my two papers');
    });

    it('from the reader on an empty panel keeps the typed question and its papers', async () => {
        store.set(currentMessageContentAtom, 'what links these two?');
        store.set(currentMessageItemsAtom, [item('MINE1'), item('MINE2')]);

        // "Ask AlphainZ..." starts a conversation when there is none.
        await continueOrStartThread((options) => store.set(newThreadAtom, options));

        expect(store.get(currentMessageContentAtom)).toBe('what links these two?');
        expect(stagedKeys()).toEqual(['MINE1', 'MINE2']);
    });
});

// =============================================================================
// Staged mid-run
// =============================================================================

describe('a reader question staged while an answer streams', () => {
    it('goes after the draft instead of over it', async () => {
        store.set(currentMessageContentAtom, 'my own next question');
        store.set(isWSChatPendingAtom, true);

        await deliverPrompt(vi.fn(async () => {}), 'Explain the selected passage');

        expect(store.get(currentMessageContentAtom)).toBe(
            'my own next question\n\nExplain the selected passage',
        );
    });

    it('is still a selection question when it is sent later', async () => {
        store.set(currentThreadIdAtom, 'thread-a');
        store.set(isWSChatPendingAtom, true);
        const origin = { kind: 'selection_chat', annotation_key: 'ANCHOR1', library_id: 1 };

        await deliverPrompt(vi.fn(async () => {}), 'what does this term mean?', { origin });
        expect(store.get(stagedReaderPromptAtom)).toEqual({ text: 'what does this term mean?', origin });

        store.set(isWSChatPendingAtom, false);
        const local = await sendAndFinish(store.get(currentMessageContentAtom));

        expect(local.run.user_prompt.origin).toEqual(origin);
        expect(store.get(stagedReaderPromptAtom)).toBeNull();
    });

    it('does not lend its origin to a message it is no longer part of', async () => {
        store.set(currentThreadIdAtom, 'thread-a');
        store.set(isWSChatPendingAtom, true);
        await deliverPrompt(vi.fn(async () => {}), 'what does this term mean?', {
            origin: { kind: 'selection_chat', annotation_key: 'ANCHOR1', library_id: 1 },
        });

        store.set(isWSChatPendingAtom, false);
        store.set(currentMessageContentAtom, 'something else entirely');
        const local = await sendAndFinish('something else entirely');

        expect(local.run.user_prompt.origin).toBeUndefined();
    });
});

// =============================================================================
// A conversation arriving from another computer
// =============================================================================

describe('a conversation arriving from another computer', () => {
    function storedRun(id: string, threadId: string, content: string) {
        return {
            id,
            thread_id: threadId,
            payload: {
                id,
                thread_id: threadId,
                user_id: 'local-user',
                status: 'completed',
                user_prompt: { content },
                model_messages: [],
                created_at: '2026-09-24T10:00:00.000Z',
            },
        };
    }

    it('refreshes the open chat in place, leaving the draft and staged papers alone', async () => {
        db.threads.set('thread-open', { id: 'thread-open', name: 'Open chat', updatedAt: 'T1' });
        db.runs.push(storedRun('run-here', 'thread-open', 'asked here'));
        store.set(currentThreadIdAtom, 'thread-open');
        store.set(threadRunsAtom, [structuredClone(db.runs[0].payload)]);
        store.set(currentMessageContentAtom, 'typing a follow-up');
        store.set(currentMessageItemsAtom, [item('PAPER1')]);
        importAllMock.mockImplementation(async () => {
            db.runs.push(storedRun('run-there', 'thread-open', 'asked on the laptop'));
            db.threads.get('thread-open')!.updatedAt = 'T2';
            return { imported: 1, skipped: 0, unreadable: 0, conflictCopies: 0 };
        });
        const loadingStates: boolean[] = [];
        const unsubscribe = store.sub(isLoadingThreadAtom, () => loadingStates.push(store.get(isLoadingThreadAtom)));

        await syncConversationsNow();
        await until(() => store.get(threadRunsAtom).length === 2, 'the refreshed runs');
        unsubscribe();

        expect(store.get(threadRunsAtom).map((run: AgentRun) => run.id)).toEqual(['run-here', 'run-there']);
        expect(store.get(currentMessageContentAtom)).toBe('typing a follow-up');
        expect(stagedKeys()).toEqual(['PAPER1']);
        expect(loadingStates).not.toContain(true);
    });

    it('refreshes the open chat when an import only took out an answer a retry replaced', async () => {
        // The other computer retried the last answer; its older copy of the
        // chat still counts, and importing it takes the replaced answer out
        // without touching the thread's row.
        db.threads.set('thread-open', { id: 'thread-open', name: 'Open chat', updatedAt: 'T1' });
        db.runs.push(storedRun('run-first', 'thread-open', 'first question'));
        db.runs.push(storedRun('run-replaced', 'thread-open', 'retried elsewhere'));
        store.set(currentThreadIdAtom, 'thread-open');
        store.set(threadRunsAtom, db.runs.map((run) => structuredClone(run.payload)));
        importAllMock.mockImplementation(async () => {
            db.runs = db.runs.filter((run) => run.id !== 'run-replaced');
            return { imported: 1, skipped: 0, unreadable: 0, conflictCopies: 0 };
        });

        await syncConversationsNow();
        await until(() => store.get(threadRunsAtom).length === 1, 'the refreshed runs');

        expect(store.get(threadRunsAtom).map((run: AgentRun) => run.id)).toEqual(['run-first']);
    });

    it('leaves the open chat alone when what arrived was another conversation', async () => {
        db.threads.set('thread-open', { id: 'thread-open', name: 'Open chat', updatedAt: 'T1' });
        store.set(currentThreadIdAtom, 'thread-open');
        importAllMock.mockImplementation(async () => {
            db.runs.push(storedRun('run-elsewhere', 'thread-other', 'another chat'));
            return { imported: 1, skipped: 0, unreadable: 0, conflictCopies: 0 };
        });

        await syncConversationsNow();
        await settle();

        expect(db.getRunsForThread).not.toHaveBeenCalledWith('thread-open');
    });

    it('comes back a minute later only for files still downloading', async () => {
        const setTimeoutSpy = vi.fn(() => 1);
        const original = (Zotero as any).getMainWindow;
        (Zotero as any).getMainWindow = () => ({ setTimeout: setTimeoutSpy, clearTimeout: vi.fn() });
        try {
            // Every file is one this computer already has.
            importAllMock.mockResolvedValue({ imported: 0, skipped: 3, unreadable: 0, conflictCopies: 0, waiting: 0 });
            await syncConversationsNow();
            expect(setTimeoutSpy).not.toHaveBeenCalled();

            // One is still on its way.
            importAllMock.mockResolvedValue({ imported: 0, skipped: 3, unreadable: 0, conflictCopies: 0, waiting: 1 });
            await syncConversationsNow();
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
        } finally {
            (Zotero as any).getMainWindow = original;
        }
    });
});
