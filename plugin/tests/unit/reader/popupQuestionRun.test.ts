/**
 * A question typed into the selection popup, through the real send.
 *
 * The popup is told the question was sent only once its run has started, and
 * gets it back — with the panel's reason — when the run could not start; the
 * highlight placed for it then goes. A second question asked while the first
 * one's run is still being prepared waits in the composer, leaves the first
 * one its highlight, and links its own once it is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeLocalRequestMock } = vi.hoisted(() => ({
    executeLocalRequestMock: vi.fn(),
}));

vi.mock('../../../react/atoms/executeLocalRun', () => ({
    executeLocalRequest: (...args: unknown[]) => executeLocalRequestMock(...args),
}));
vi.mock('../../../react/events/eventManager', () => ({
    eventManager: { dispatch: vi.fn(), subscribe: vi.fn(() => () => {}) },
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
vi.mock('../../../src/services/llm/threadTitle', () => ({
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
    askFromSelectionPopup,
    releaseHighlightQuestion,
    stopAwaitingQuestionSend,
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

/** What the local runner says first, once it is about to ask the model. */
function runStarts(local: StartedRun, threadId = 'thread-open') {
    local.callbacks.onThread(threadId);
    local.callbacks.onReady({ subscriptionStatus: 'inactive', processingMode: 'frontend', indexingComplete: true } as any);
}

function runEnds(local: StartedRun) {
    local.callbacks.onDone();
    local.finish();
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
    getAnnotations: () => [],
} as any;

let created: any[];
let items: Map<string, any>;
let db: any;

function popupQuestion(prompt: string, text: string, pageIndex: number) {
    return {
        prompt,
        selectedText: text,
        annotation: {
            type: 'highlight',
            text,
            pageLabel: String(pageIndex + 1),
            sortIndex: `${String(pageIndex).padStart(5, '0')}|000000|00100`,
            position: { pageIndex, rects: [[1, 2, 3, 4 + pageIndex]] },
        },
        page: 1,
        pageIndex,
        readerItemID: paper.id,
        onOutcome: vi.fn(),
    };
}

function outcomes(question: { onOutcome: any }) {
    return question.onOutcome.mock.calls.map((call: any[]) => call[0]);
}

const deps = {
    newThread: vi.fn(async () => {}),
    sendWSMessage: (message: string, options?: any) => store.set(sendWSMessageAtom, message, options),
};

beforeEach(() => {
    executeLocalRequestMock.mockClear();
    clearClientShutDownLatch();
    releaseHighlightQuestion();
    stopAwaitingQuestionSend();
    clearPendingAnchor();
    started = [];
    created = [];
    items = new Map();
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
    (Zotero as any).Item = function (this: any, itemType: string) {
        this.itemType = itemType;
        this.key = `NEWANCH${created.length}`;
        this.isAnnotation = () => true;
        this.saveTx = vi.fn(async () => {
            items.set(`${this.libraryID}-${this.key}`, this);
        });
        this.eraseTx = vi.fn(async () => undefined);
        created.push(this);
    };
    (Zotero as any).Items = {
        getByLibraryAndKey: vi.fn((libraryID: number, key: string) => items.get(`${libraryID}-${key}`) ?? false),
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
});

afterEach(async () => {
    for (const local of started) local.finish();
    await settle();
});

function linkedKeys(): string[] {
    return db.saveThreadAnchor.mock.calls.map((call: any[]) => call[0].annotationKey);
}

describe('a popup question sent from the reader', () => {
    it('is told it was sent once its run has started, not when it is handed over', async () => {
        const question = popupQuestion('what does this mean?', 'a passage on page fourteen', 13);
        const asking = askFromSelectionPopup(question as any, deps);
        await until(() => started.length === 1, 'the run');

        expect(outcomes(question)).toEqual([{ status: 'sending' }]);

        runStarts(started[0]);
        await until(() => outcomes(question).length === 2, 'the popup to hear back');
        expect(outcomes(question)[1]).toEqual({ status: 'sent' });
        expect(linkedKeys()).toEqual(['NEWANCH0']);

        runEnds(started[0]);
        await asking;
        await settle();
        expect(created[0].eraseTx).not.toHaveBeenCalled();
    });

    it('gets the question back with the reason when no model is set up here, and its highlight goes', async () => {
        const question = popupQuestion('what does this mean?', 'a passage on page fourteen', 13);
        const asking = askFromSelectionPopup(question as any, deps);
        await until(() => started.length === 1, 'the run');

        const local = started[0];
        local.callbacks.onError({
            event: 'error',
            type: 'not_configured',
            message: 'OpenRouter has no API key on this computer.',
            run_id: local.run.id,
            is_retryable: false,
        } as any);
        runEnds(local);
        await asking;

        expect(outcomes(question).at(-1)).toEqual({
            status: 'failed',
            reason: 'OpenRouter has no API key on this computer.',
        });
        expect(created[0].eraseTx).toHaveBeenCalled();
        expect(linkedKeys()).toEqual([]);
    });

    it('keeps its highlight when a second question is asked while its run is being prepared', async () => {
        const first = popupQuestion('what does this mean?', 'a passage on page fourteen', 13);
        const askingFirst = askFromSelectionPopup(first as any, deps);
        await until(() => started.length === 1, 'the first run');

        // Asked before the first run has reported its thread: it waits in the composer.
        const second = popupQuestion('and this one?', 'another passage', 20);
        await askFromSelectionPopup(second as any, deps);
        expect(outcomes(second)).toEqual([{ status: 'staged' }]);

        runStarts(started[0]);
        await until(() => outcomes(first).length === 2, 'the first popup to hear back');
        runEnds(started[0]);
        await askingFirst;
        await settle();

        expect(outcomes(first)[1]).toEqual({ status: 'sent' });
        expect(created[0].eraseTx).not.toHaveBeenCalled();
        expect(linkedKeys()).toEqual(['NEWANCH0']);

        // The second question goes out from the composer; its own run links its highlight.
        const composed = store.get(currentMessageContentAtom);
        expect(composed).toContain('and this one?');
        const sending = store.set(sendWSMessageAtom, composed);
        await until(() => started.length === 2, 'the second run');
        expect(started[1].run.user_prompt.origin).toEqual({
            kind: 'selection_chat',
            annotation_key: 'NEWANCH1',
            library_id: 1,
        });
        runStarts(started[1]);
        runEnds(started[1]);
        await sending;
        await settle();

        expect(linkedKeys()).toEqual(['NEWANCH0', 'NEWANCH1']);
    });
});
