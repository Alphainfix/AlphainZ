/**
 * The question typed after "Chat about this highlight", through the real send.
 *
 * What the user types in the composer goes out the way a popup question does:
 * as a selection question anchored to the highlight — a short answer, and the
 * offer to save it into the highlight's comment — and its run links the
 * highlight to the conversation. Taken off the message first, the passage
 * takes that with it, and the question is an ordinary one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeLocalRequestMock, dispatchMock } = vi.hoisted(() => ({
    executeLocalRequestMock: vi.fn(),
    dispatchMock: vi.fn(),
}));

vi.mock('../../../react/atoms/executeLocalRun', () => ({
    executeLocalRequest: (...args: unknown[]) => executeLocalRequestMock(...args),
}));
vi.mock('../../../react/events/eventManager', () => ({
    eventManager: { dispatch: dispatchMock, subscribe: vi.fn(() => () => {}) },
}));
vi.mock('../../../react/hooks/useToggleSidebar', () => ({ revealChatForReaderQuestion: vi.fn() }));
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

import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { WSCallbacks } from '@beaver/agent-core/protocol/agentProtocol';
import {
    activeRunAtom,
    currentThreadIdAtom,
    threadRunsAtom,
} from '@beaver/agent-core/run-state/atoms';
import { store } from '../../../react/store';
import { selectedModelAtom } from '../../../react/atoms/models';
import { localZoteroLibrariesAtom } from '../../../react/atoms/profile';
import {
    clearComposerAtom,
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentReaderAttachmentAtom,
    readerTextSelectionAtom,
} from '../../../react/atoms/messageComposition';
import {
    clearClientShutDownLatch,
    createWSCallbacks,
    isWSChatPendingAtom,
    sendWSMessageAtom,
} from '../../../react/atoms/agentRunAtoms';
import {
    chatAboutAnnotation,
    releaseHighlightQuestion,
    stopAwaitingQuestionSend,
    watchHighlightQuestion,
} from '../../../react/hooks/useSelectionChatHandler';
import { clearPendingAnchor } from '../../../react/utils/selectionAnchors';

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

/** Type a question into the composer and send it; the run reports its thread. */
async function askFromComposer(question: string): Promise<AgentRun> {
    const count = started.length;
    store.set(currentMessageContentAtom, question);
    const sending = store.set(sendWSMessageAtom, question);
    await until(() => started.length === count + 1, `run for "${question}"`);
    const local = started[count];
    local.callbacks.onThread('thread-open');
    local.callbacks.onDone();
    local.finish();
    await sending;
    await settle();
    return local.run;
}

const paper = {
    id: 204,
    key: 'ATTACH01',
    libraryID: 1,
    parentItem: null,
    isAnnotation: () => false,
    isAttachment: () => true,
    isRegularItem: () => false,
    isNote: () => false,
} as any;

const highlight = {
    key: 'HIGHLT01',
    libraryID: 1,
    isAnnotation: () => true,
    annotationType: 'highlight',
    annotationText: 'the gap closes at the transition',
    annotationPageLabel: '1043',
    annotationPosition: JSON.stringify({ pageIndex: 41, rects: [[5, 6, 7, 8]] }),
};

let db: any;
let stopWatching: () => void;

beforeEach(() => {
    executeLocalRequestMock.mockClear();
    clearClientShutDownLatch();
    releaseHighlightQuestion();
    stopAwaitingQuestionSend();
    clearPendingAnchor();
    started = [];
    db = {
        saveRun: vi.fn(async () => {}),
        ensureThread: vi.fn(async () => {}),
        getThread: vi.fn(async () => null),
        setThreadName: vi.fn(async () => {}),
        getRunsForThread: vi.fn(async () => []),
        getRunIdsForThread: vi.fn(async () => []),
        recordThreadItems: vi.fn(async () => {}),
        getThreadAnchor: vi.fn(async () => null),
        saveThreadAnchor: vi.fn(async () => {}),
    };
    (Zotero as any).AlphainZ = { db };
    (Zotero as any).Items = {
        getByLibraryAndKey: vi.fn((libraryID: number, key: string) =>
            libraryID === 1 && key === 'HIGHLT01' ? highlight : false),
        getByLibraryAndKeyAsync: vi.fn(async () => null),
        getAsync: vi.fn(async (id: number) => (id === 204 ? paper : null)),
        getLibraryAndKeyFromID: vi.fn((id: number) => (id === 204 ? { libraryID: 1, key: 'ATTACH01' } : false)),
        loadDataTypes: vi.fn(async () => {}),
    };
    store.set(selectedModelAtom, { name: 'test-model', provider: 'test' } as any);
    store.set(localZoteroLibrariesAtom, [{ library_id: 1, name: 'My Library', is_group: false } as any]);
    store.set(activeRunAtom, null);
    store.set(threadRunsAtom, []);
    store.set(currentThreadIdAtom, 'thread-open');
    store.set(isWSChatPendingAtom, false);
    store.set(clearComposerAtom);
    store.set(currentMessageItemsAtom, []);
    store.set(currentReaderAttachmentAtom, paper);
    store.set(readerTextSelectionAtom, null);
    stopWatching = watchHighlightQuestion();
});

afterEach(async () => {
    stopWatching();
    for (const local of started) local.finish();
    await settle();
});

const deps = { newThread: vi.fn(async () => {}), loadThread: vi.fn(async () => {}) };

describe('the question typed after "Chat about this highlight"', () => {
    it('goes out as a selection question anchored to the highlight, and links it', async () => {
        await chatAboutAnnotation({ annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: 204 }, deps);

        const run = await askFromComposer('why does it close there?');

        expect(run.user_prompt.origin).toEqual({
            kind: 'selection_chat',
            annotation_key: 'HIGHLT01',
            library_id: 1,
        });
        expect(db.saveThreadAnchor).toHaveBeenCalledWith(expect.objectContaining({
            annotationKey: 'HIGHLT01',
            threadId: 'thread-open',
        }));
    });

    it('is an ordinary question once the passage has been taken off the message', async () => {
        await chatAboutAnnotation({ annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: 204 }, deps);
        store.set(readerTextSelectionAtom, null);

        const run = await askFromComposer('something else entirely');

        expect(run.user_prompt.origin).toBeUndefined();
        expect(db.saveThreadAnchor).not.toHaveBeenCalled();
    });

    it('is not linked by a run already on its way when the highlight was picked', async () => {
        store.set(currentMessageContentAtom, 'an earlier question');
        const sending = store.set(sendWSMessageAtom, 'an earlier question');
        await until(() => started.length === 1, 'the earlier run');

        // Picked while that run is still being prepared.
        await chatAboutAnnotation({ annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: 204 }, deps);
        started[0].callbacks.onThread('thread-open');
        started[0].callbacks.onDone();
        started[0].finish();
        await sending;
        await settle();
        expect(db.saveThreadAnchor).not.toHaveBeenCalled();

        // Its own question links it.
        await askFromComposer('why does it close there?');
        expect(db.saveThreadAnchor).toHaveBeenCalledWith(expect.objectContaining({
            annotationKey: 'HIGHLT01',
            threadId: 'thread-open',
        }));
    });

    it('makes only the first question the anchored one; follow-ups are ordinary', async () => {
        await chatAboutAnnotation({ annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: 204 }, deps);
        await askFromComposer('why does it close there?');

        const followUp = await askFromComposer('and above the transition?');

        expect(followUp.user_prompt.origin).toBeUndefined();
    });
});
