/**
 * What happens once a question from the reader reaches the chat panel.
 *
 * The popup question, "Chat about this highlight", and Explain / Ask on a
 * selection or on annotations — driven through the handlers the hooks
 * subscribe, with the send itself stood in for. What is checked is what the
 * user would see: whether anything is written into or sent about an excluded
 * library, what the popup is told, which page the passage is on, whether a
 * highlight is left behind, and what the question says it is about.
 */
import { atom } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchMock, revealMock } = vi.hoisted(() => ({
    dispatchMock: vi.fn(),
    revealMock: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/events/eventManager', () => ({
    eventManager: { dispatch: dispatchMock, subscribe: vi.fn(() => () => {}) },
}));
vi.mock('../../../react/hooks/useToggleSidebar', () => ({ revealChatForReaderQuestion: revealMock }));
vi.mock('../../../react/atoms/agentRunAtoms', () => ({
    isWSChatPendingAtom: atom(false),
    isWSReadyAtom: atom(false),
    wsErrorAtom: atom(null),
    sendWSMessageAtom: atom(null, async () => {}),
}));
vi.mock('../../../react/atoms/threads', async () => {
    const { currentThreadIdAtom } = await import('@beaver/agent-core/run-state/atoms');
    return {
        currentThreadIdAtom,
        newThreadAtom: atom(null, async () => {}),
        loadThreadAtom: atom(null, async () => {}),
    };
});

import { activeRunAtom, currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../../../react/store';
import { isWSChatPendingAtom, isWSReadyAtom, wsErrorAtom } from '../../../react/atoms/agentRunAtoms';
import {
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentReaderAttachmentAtom,
    notifyReaderLibraryExcludedAtom,
    readerTextSelectionAtom,
    stagedReaderPromptAtom,
} from '../../../react/atoms/messageComposition';
import { excludedLibrariesAtom, localZoteroLibrariesAtom } from '../../../react/atoms/profile';
import { popupMessagesAtom } from '../../../react/atoms/ui';
import { EXCLUDED_LIBRARY_READER_POPUP_ID } from '../../../react/utils/popupMessageUtils';
import {
    askFromSelectionPopup,
    chatAboutAnnotation,
    releaseHighlightQuestion,
    stopAwaitingQuestionSend,
    watchHighlightQuestion,
} from '../../../react/hooks/useSelectionChatHandler';
import { handleReaderAnnotationAction } from '../../../react/hooks/useReaderAnnotationActionHandler';
import { handleReaderSelectionAction } from '../../../react/hooks/useReaderSelectionActionHandler';
import { clearPendingAnchor, drainPendingAnchor, isAnchorParked } from '../../../react/utils/selectionAnchors';
import { ALPHAIN_ANCHOR_AUTHOR } from '../../../src/constants/annotations';

// Library 1 is the user's; library 2 is a group the user excluded.
const libraries = [
    { library_id: 1, group_id: null, name: 'My Library', is_group: false, type: 'user', type_id: 1, read_only: false },
    { library_id: 2, group_id: 99, name: 'Lab Group', is_group: true, type: 'group', type_id: 2, read_only: false },
];

let created: any[];
let items: Map<string, any>;
let annotationsOnFile: any[];
let getThreadAnchor: any;
let saveThreadAnchor: any;

function attachmentIn(libraryID: number, id: number) {
    return {
        id,
        key: `ATT${id}`,
        libraryID,
        isAnnotation: () => false,
        getAnnotations: () => annotationsOnFile,
    };
}

const paper = attachmentIn(1, 204);
const excludedPaper = attachmentIn(2, 305);

const position = { pageIndex: 13, rects: [[1, 2, 3, 4]] };
const readerAnnotation = {
    type: 'highlight',
    text: 'a passage on page fourteen',
    pageLabel: '14',
    sortIndex: '00013|000000|00100',
    position,
};

function popupQuestion(overrides: Record<string, unknown> = {}) {
    return {
        prompt: 'what does this mean?',
        selectedText: 'a passage on page fourteen',
        annotation: readerAnnotation,
        page: 1,
        pageIndex: 13,
        readerItemID: paper.id,
        onOutcome: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    releaseHighlightQuestion();
    stopAwaitingQuestionSend();
    clearPendingAnchor();
    created = [];
    items = new Map();
    annotationsOnFile = [];
    getThreadAnchor = vi.fn(async () => null);
    saveThreadAnchor = vi.fn(async () => undefined);

    store.set(localZoteroLibrariesAtom, libraries as any);
    store.set(excludedLibrariesAtom, [{ type: 'group', group_id: 99 }]);
    store.set(isWSChatPendingAtom, false);
    // Up from the last answer, as the flag stays once a run has ended.
    store.set(isWSReadyAtom, true);
    store.set(wsErrorAtom, null);
    store.set(activeRunAtom, null);
    store.set(currentThreadIdAtom, 'thread-open');
    store.set(currentReaderAttachmentAtom, paper as any);
    store.set(readerTextSelectionAtom, null);
    store.set(stagedReaderPromptAtom, null);
    store.set(currentMessageContentAtom, '');
    store.set(currentMessageItemsAtom, []);
    store.set(popupMessagesAtom, []);

    (Zotero as any).Item = function (this: any, itemType: string) {
        this.itemType = itemType;
        this.key = `NEWANCH${created.length}`;
        this.deleted = false;
        this.isAnnotation = () => true;
        this.saveTx = vi.fn(async () => {
            items.set(`${this.libraryID}-${this.key}`, this);
        });
        this.eraseTx = vi.fn(async () => undefined);
        created.push(this);
    };
    (Zotero as any).Items = {
        getAsync: vi.fn(async (id: number) => [paper, excludedPaper].find((a) => a.id === id) ?? null),
        getLibraryAndKeyFromID: vi.fn((id: number) => {
            const found = [paper, excludedPaper].find((a) => a.id === id);
            return found ? { libraryID: found.libraryID, key: found.key } : false;
        }),
        getByLibraryAndKey: vi.fn((libraryID: number, key: string) => items.get(`${libraryID}-${key}`) ?? false),
        getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) => items.get(`${libraryID}-${key}`) ?? false),
    };
    (Zotero as any).AlphainZ = { db: { getThreadAnchor, saveThreadAnchor } };
});

const deps = (send: (...args: any[]) => Promise<unknown> = vi.fn(async () => {})) => ({
    newThread: vi.fn(async () => {}),
    loadThread: vi.fn(async () => {}),
    sendWSMessage: send,
});

let runCount = 0;

/**
 * The run a send starts, the way the chat panel runs it: it takes the active
 * slot, reports its thread — which links a parked anchor — and says it is
 * ready, before anything is asked of the model.
 */
function startRun(message: string, origin: unknown, threadId = 'thread-open', whilePreparing?: () => Promise<void>) {
    return async () => {
        store.set(isWSChatPendingAtom, true);
        store.set(isWSReadyAtom, false);
        store.set(activeRunAtom, { id: `run-${++runCount}`, user_prompt: { content: message, origin } } as any);
        if (whilePreparing) await whilePreparing();
        store.set(currentThreadIdAtom, threadId);
        await drainPendingAnchor(threadId);
        store.set(isWSReadyAtom, true);
    };
}

/** A send whose run starts (see `startRun`), and ends. */
function sendThatStarts(threadId = 'thread-open') {
    return vi.fn(async (message: string, options?: { origin?: unknown }) => {
        await startRun(message, options?.origin, threadId)();
        store.set(isWSChatPendingAtom, false);
    });
}

/** The composer sending a message: its run takes the active slot. */
function composerSends(message: string, origin?: unknown) {
    store.set(activeRunAtom, { id: `run-${++runCount}`, user_prompt: { content: message, origin } } as any);
}

function outcomes(question: { onOutcome: any }) {
    return question.onOutcome.mock.calls.map((call: any[]) => call[0]);
}

describe('a question typed into the selection popup', () => {
    it('is not asked about a file in an excluded library: nothing is written there or sent', async () => {
        const send = vi.fn(async () => {});
        const question = popupQuestion({ readerItemID: excludedPaper.id });
        store.set(currentReaderAttachmentAtom, null);

        await askFromSelectionPopup(question as any, deps(send));

        expect(created).toHaveLength(0);
        expect(send).not.toHaveBeenCalled();
        expect(store.get(currentReaderAttachmentAtom)).toBeNull();
        expect(question.onOutcome).toHaveBeenCalledWith({
            status: 'failed',
            reason: expect.stringContaining('excluded'),
        });
    });

    it('says why under its own field, without opening the panel over it', async () => {
        const question = popupQuestion({ readerItemID: excludedPaper.id });
        store.set(currentReaderAttachmentAtom, null);

        await askFromSelectionPopup(question as any, deps());

        expect(revealMock).not.toHaveBeenCalled();
        expect(store.get(popupMessagesAtom)).toHaveLength(0);
    });

    it('tells the popup it was sent once its run has started, and stages the passage on its own page', async () => {
        const send = sendThatStarts();
        const question = popupQuestion();

        await askFromSelectionPopup(question as any, deps(send));

        expect(outcomes(question)).toEqual([{ status: 'sending' }, { status: 'sent' }]);
        expect(store.get(readerTextSelectionAtom)).toMatchObject({
            text: 'a passage on page fourteen',
            page_index: 13,
            position,
        });
        expect(send).toHaveBeenCalledWith('what does this mean?', {
            origin: { kind: 'selection_chat', annotation_key: 'NEWANCH0', library_id: 1 },
        });
    });

    it('gives the question back when its send is turned away before the run starts', async () => {
        // Libraries still loading, a retry being committed, a Stop: the send
        // returns without a run ever starting.
        const question = popupQuestion();

        await askFromSelectionPopup(question as any, deps(vi.fn(async () => {})));

        expect(outcomes(question)).toEqual([
            { status: 'sending' },
            { status: 'failed', reason: 'AlphainZ did not send this question. Try again in a moment.' },
        ]);
    });

    it('gives the panel\'s reason when the run could not start', async () => {
        const question = popupQuestion();
        const send = vi.fn(async () => {
            store.set(wsErrorAtom, {
                event: 'error',
                type: 'not_configured',
                message: 'OpenRouter has no API key on this computer.',
                is_retryable: false,
            } as any);
        });

        await askFromSelectionPopup(question as any, deps(send));

        expect(outcomes(question).at(-1)).toEqual({
            status: 'failed',
            reason: 'OpenRouter has no API key on this computer.',
        });
    });

    it('tells the popup the question is waiting when an answer is still being written', async () => {
        store.set(isWSChatPendingAtom, true);
        const send = vi.fn(async () => {});
        const question = popupQuestion();

        await askFromSelectionPopup(question as any, deps(send));

        expect(question.onOutcome).toHaveBeenCalledWith({ status: 'staged' });
        expect(send).not.toHaveBeenCalled();
        expect(store.get(currentMessageContentAtom)).toContain('what does this mean?');
    });

    it('gives the question back when the file cannot be found', async () => {
        store.set(currentReaderAttachmentAtom, null);
        const question = popupQuestion({ readerItemID: 999 });
        (Zotero.Items.getLibraryAndKeyFromID as any) = vi.fn(() => ({ libraryID: 1, key: 'GONE' }));

        await askFromSelectionPopup(question as any, deps());

        expect(question.onOutcome).toHaveBeenCalledWith({ status: 'failed', reason: expect.any(String) });
        expect(created).toHaveLength(0);
    });

    it('takes back the highlight it placed when the question never became a run', async () => {
        // The run is turned away before it starts — no key on this computer —
        // so it never reports a thread, and the highlight would open nothing.
        await askFromSelectionPopup(popupQuestion() as any, deps(vi.fn(async () => {})));

        expect(created).toHaveLength(1);
        expect(created[0].eraseTx).toHaveBeenCalled();
        expect(isAnchorParked(created[0])).toBe(false);
    });

    it('keeps the highlight once its conversation has it', async () => {
        await askFromSelectionPopup(popupQuestion() as any, deps(sendThatStarts()));

        expect(created[0].eraseTx).not.toHaveBeenCalled();
        expect(saveThreadAnchor).toHaveBeenCalledWith(expect.objectContaining({
            annotationKey: 'NEWANCH0',
            threadId: 'thread-open',
        }));
    });

    function anchorOnPassage() {
        const existing = {
            key: 'OLDANCH1',
            libraryID: 1,
            isAnnotation: () => true,
            deleted: false,
            annotationType: 'highlight',
            annotationAuthorName: ALPHAIN_ANCHOR_AUTHOR,
            annotationPosition: JSON.stringify(position),
            annotationComment: '',
            eraseTx: vi.fn(),
        };
        annotationsOnFile = [existing];
        items.set('1-OLDANCH1', existing);
        return existing;
    }

    it('reuses the highlight already on the passage, and never takes it back', async () => {
        const existing = anchorOnPassage();
        const send = vi.fn(async () => {});

        await askFromSelectionPopup(popupQuestion() as any, deps(send));

        expect(created).toHaveLength(0);
        expect(existing.eraseTx).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith('what does this mean?', {
            origin: { kind: 'selection_chat', annotation_key: 'OLDANCH1', library_id: 1 },
        });
    });

    it('leaves a reused highlight opening the conversation it was first asked in', async () => {
        anchorOnPassage();
        getThreadAnchor.mockImplementation(async (_libraryID: number, key: string) =>
            key === 'OLDANCH1' ? { threadId: 'thread-first', selectedText: 'x' } : null);
        const question = popupQuestion();

        await askFromSelectionPopup(question as any, deps(sendThatStarts('thread-open')));

        expect(outcomes(question).at(-1)).toEqual({ status: 'sent' });
        expect(saveThreadAnchor).not.toHaveBeenCalled();
        expect(isAnchorParked({ libraryID: 1, key: 'OLDANCH1' })).toBe(false);
    });

    it('links a question staged mid-answer only once that question is sent', async () => {
        // An answer is being written; the question waits in the composer.
        store.set(isWSChatPendingAtom, true);
        store.set(activeRunAtom, { id: 'run-streaming', user_prompt: { content: 'earlier question' } } as any);
        const question = popupQuestion();

        await askFromSelectionPopup(question as any, deps());

        expect(outcomes(question)).toEqual([{ status: 'staged' }]);
        expect(saveThreadAnchor).not.toHaveBeenCalled();
        expect(isAnchorParked(created[0])).toBe(false);

        // The answer ends; the user sends the staged question from the composer.
        store.set(activeRunAtom, null);
        store.set(isWSChatPendingAtom, false);
        composerSends('what does this mean?', store.get(stagedReaderPromptAtom)?.origin);
        await drainPendingAnchor('thread-open');

        expect(saveThreadAnchor).toHaveBeenCalledWith(expect.objectContaining({
            annotationKey: 'NEWANCH0',
            threadId: 'thread-open',
        }));
    });

    it('does not give a staged question\'s highlight to a message sent instead of it', async () => {
        store.set(isWSChatPendingAtom, true);
        store.set(activeRunAtom, { id: 'run-streaming', user_prompt: { content: 'earlier question' } } as any);
        await askFromSelectionPopup(popupQuestion() as any, deps());

        // The user deletes the staged question and sends something else.
        store.set(activeRunAtom, null);
        store.set(isWSChatPendingAtom, false);
        composerSends('something else entirely');
        await drainPendingAnchor('thread-open');

        expect(saveThreadAnchor).not.toHaveBeenCalled();
    });

    it('keeps its highlight when a second question arrives while its run is being prepared', async () => {
        // The second question, about another passage, is asked before the
        // first run has reported its thread; it waits in the composer.
        const second = popupQuestion({
            prompt: 'and this one?',
            selectedText: 'another passage',
            annotation: { ...readerAnnotation, text: 'another passage', position: { pageIndex: 20, rects: [[9, 9, 9, 9]] } },
            pageIndex: 20,
        });
        const first = popupQuestion();
        const send = vi.fn(async (message: string, options?: { origin?: unknown }) => {
            await startRun(message, options?.origin, 'thread-open', async () => {
                await askFromSelectionPopup(second as any, deps());
            })();
            store.set(isWSChatPendingAtom, false);
            store.set(activeRunAtom, null);
        });

        await askFromSelectionPopup(first as any, deps(send));

        expect(outcomes(first).at(-1)).toEqual({ status: 'sent' });
        expect(outcomes(second)).toEqual([{ status: 'staged' }]);
        expect(created).toHaveLength(2);
        expect(created[0].eraseTx).not.toHaveBeenCalled();
        expect(saveThreadAnchor.mock.calls.map((call: any[]) => call[0].annotationKey)).toEqual(['NEWANCH0']);
    });

    it('does not let a highlight picked while its run is being prepared take its place', async () => {
        userHighlight();
        const first = popupQuestion();
        const send = vi.fn(async (message: string, options?: { origin?: unknown }) => {
            await startRun(message, options?.origin, 'thread-open', async () => {
                await chatAboutAnnotation({ annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: paper.id }, deps());
            })();
            store.set(isWSChatPendingAtom, false);
        });

        await askFromSelectionPopup(first as any, deps(send));

        expect(created[0].eraseTx).not.toHaveBeenCalled();
        expect(saveThreadAnchor.mock.calls.map((call: any[]) => call[0].annotationKey)).toEqual(['NEWANCH0']);
        expect(isAnchorParked({ libraryID: 1, key: 'HIGHLT01' })).toBe(false);
    });
});

describe('a question refused from a reader menu', () => {
    it('gives one notice for an excluded file, not the reader\'s and its own', async () => {
        // The reader already says the file was not added.
        store.set(notifyReaderLibraryExcludedAtom, { itemID: excludedPaper.id });
        expect(store.get(popupMessagesAtom).map((m) => m.title)).toEqual(['File Not Added']);

        await handleReaderSelectionAction(
            { action: 'explain', text: 'x', page: 1, readerItemID: excludedPaper.id },
            deps(),
        );

        expect(store.get(popupMessagesAtom).map((m) => [m.id, m.title])).toEqual([
            [EXCLUDED_LIBRARY_READER_POPUP_ID, 'Not asked'],
        ]);
    });

    it('still gives one when the panel it opened raises the reader\'s notice afterwards', async () => {
        await handleReaderSelectionAction(
            { action: 'explain', text: 'x', page: 1, readerItemID: excludedPaper.id },
            deps(),
        );
        store.set(notifyReaderLibraryExcludedAtom, { itemID: excludedPaper.id });

        expect(store.get(popupMessagesAtom)).toHaveLength(1);
        expect(revealMock).toHaveBeenCalled();
    });
});

function userHighlight(overrides: Record<string, unknown> = {}) {
    const highlight = {
        key: 'HIGHLT01',
        libraryID: 1,
        isAnnotation: () => true,
        annotationType: 'highlight',
        annotationText: 'the gap closes at the transition',
        // A journal PDF: the printed label is 1043, the page index 41.
        annotationPageLabel: '1043',
        annotationPosition: JSON.stringify({ pageIndex: 41, rects: [[5, 6, 7, 8]] }),
        ...overrides,
    };
    items.set(`${highlight.libraryID}-${highlight.key}`, highlight);
    return highlight;
}

describe('chat about an existing highlight', () => {
    it('stages the highlight as the passage, on the page its position gives', async () => {
        userHighlight();
        await chatAboutAnnotation(
            { annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: paper.id },
            deps(),
        );

        const selection = store.get(readerTextSelectionAtom) as any;
        expect(selection).toMatchObject({
            text: 'the gap closes at the transition',
            page_index: 41,
            position: { pageIndex: 41, rects: [[5, 6, 7, 8]] },
        });
        expect(selection.highlight).toEqual({ libraryID: 1, key: 'HIGHLT01', attachmentID: paper.id });
        expect(dispatchMock).toHaveBeenCalledWith('focusInput', {});
    });

    it('makes the question the user types a selection question anchored to the highlight', async () => {
        userHighlight();
        await chatAboutAnnotation(
            { annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: paper.id },
            deps(),
        );

        expect(store.get(stagedReaderPromptAtom)).toEqual({
            text: '',
            origin: { kind: 'selection_chat', annotation_key: 'HIGHLT01', library_id: 1 },
        });
        // Linked by the run that sends the question, not by whichever run
        // reports a thread next.
        expect(isAnchorParked({ libraryID: 1, key: 'HIGHLT01' })).toBe(false);
        composerSends('why does it close there?', store.get(stagedReaderPromptAtom)?.origin);
        expect(isAnchorParked({ libraryID: 1, key: 'HIGHLT01' })).toBe(true);
    });

    it('lets the question go when its passage is taken off the message', async () => {
        const stop = watchHighlightQuestion();
        userHighlight();
        await chatAboutAnnotation(
            { annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: paper.id },
            deps(),
        );

        store.set(readerTextSelectionAtom, null);

        expect(store.get(stagedReaderPromptAtom)).toBeNull();
        expect(isAnchorParked({ libraryID: 1, key: 'HIGHLT01' })).toBe(false);
        stop();
    });

    it('leaves a question already sent alone when its passage goes', async () => {
        const stop = watchHighlightQuestion();
        userHighlight();
        await chatAboutAnnotation(
            { annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: paper.id },
            deps(),
        );
        // The composer's send takes the staged origin with it, and clears it;
        // its run links the anchor.
        composerSends('why does it close there?', store.get(stagedReaderPromptAtom)?.origin);
        store.set(stagedReaderPromptAtom, null);

        store.set(readerTextSelectionAtom, null);

        expect(isAnchorParked({ libraryID: 1, key: 'HIGHLT01' })).toBe(true);
        stop();
    });

    it('reopens the conversation behind a highlight that has one', async () => {
        userHighlight();
        getThreadAnchor.mockResolvedValueOnce({ threadId: 'thread-behind', selectedText: 'x' });
        const d = deps();

        await chatAboutAnnotation({ annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: paper.id }, d);

        expect(d.loadThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-behind' }));
        expect(store.get(readerTextSelectionAtom)).toBeNull();
    });

    it('is not started in an excluded library', async () => {
        userHighlight({ libraryID: 2, key: 'HIGHLT02' });
        await chatAboutAnnotation({ annotationKey: 'HIGHLT02', libraryId: 2, readerItemID: excludedPaper.id }, deps());
        expect(store.get(readerTextSelectionAtom)).toBeNull();
        expect(store.get(stagedReaderPromptAtom)).toBeNull();
    });
});

function annotationOnPaper(key: string, libraryID = 1) {
    const annotation = {
        key,
        libraryID,
        isAnnotation: () => true,
        isRegularItem: () => false,
        isAttachment: () => false,
        isNote: () => false,
        parentItem: null,
        annotationType: 'highlight',
    };
    items.set(`${libraryID}-${key}`, annotation);
    return annotation;
}

describe('Explain and Ask on annotations', () => {
    it('explains a highlight with an origin naming it among the paper\'s others', async () => {
        annotationOnPaper('ANNOT001');
        const send = vi.fn(async () => {});

        await handleReaderAnnotationAction(
            { action: 'explain', annotationIds: ['ANNOT001'], readerItemID: paper.id },
            deps(send),
        );

        expect(send).toHaveBeenCalledWith(expect.any(String), {
            origin: { kind: 'annotation_question', annotation_keys: ['ANNOT001'], library_id: 1 },
        });
    });

    it('gives the question the user types for Ask the same name', async () => {
        annotationOnPaper('ANNOT001');
        annotationOnPaper('ANNOT002');
        const send = vi.fn(async () => {});

        await handleReaderAnnotationAction(
            { action: 'ask', annotationIds: ['ANNOT001', 'ANNOT002'], readerItemID: paper.id },
            deps(send),
        );

        expect(send).not.toHaveBeenCalled();
        expect(store.get(stagedReaderPromptAtom)).toEqual({
            text: '',
            origin: { kind: 'annotation_question', annotation_keys: ['ANNOT001', 'ANNOT002'], library_id: 1 },
        });
        expect(dispatchMock).toHaveBeenCalledWith('focusInput', {});
    });

    it('is not asked in an excluded library', async () => {
        annotationOnPaper('ANNOT009', 2);
        const send = vi.fn(async () => {});
        await handleReaderAnnotationAction(
            { action: 'explain', annotationIds: ['ANNOT009'], readerItemID: excludedPaper.id },
            deps(send),
        );
        expect(send).not.toHaveBeenCalled();
        expect(store.get(currentMessageItemsAtom)).toHaveLength(0);
        expect(store.get(popupMessagesAtom).map((m) => m.title)).toContain('Not asked');
    });
});

describe('Explain and Ask on selected text', () => {
    it('stages the passage on the page it is on, with where it is', async () => {
        const selectionPosition = { pageIndex: 6, rects: [[1, 1, 2, 2]] };
        await handleReaderSelectionAction(
            { action: 'ask', text: 'selected on page seven', page: 5, pageIndex: 6, position: selectionPosition, readerItemID: paper.id },
            deps(),
        );
        expect(store.get(readerTextSelectionAtom)).toMatchObject({
            text: 'selected on page seven',
            page_index: 6,
            position: selectionPosition,
        });
    });

    it('lets a pending highlight question go: the new passage is what is asked about', async () => {
        const stop = watchHighlightQuestion();
        userHighlight();
        await chatAboutAnnotation({ annotationKey: 'HIGHLT01', libraryId: 1, readerItemID: paper.id }, deps());

        await handleReaderSelectionAction(
            { action: 'ask', text: 'something else', page: 2, pageIndex: 1, readerItemID: paper.id },
            deps(),
        );

        expect(store.get(stagedReaderPromptAtom)).toBeNull();
        expect(isAnchorParked({ libraryID: 1, key: 'HIGHLT01' })).toBe(false);
        stop();
    });

    it('is not asked in an excluded library', async () => {
        const send = vi.fn(async () => {});
        await handleReaderSelectionAction(
            { action: 'explain', text: 'x', page: 1, readerItemID: excludedPaper.id },
            deps(send),
        );
        expect(send).not.toHaveBeenCalled();
        expect(store.get(readerTextSelectionAtom)).toBeNull();
    });
});
