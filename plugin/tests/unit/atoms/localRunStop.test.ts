/**
 * A stopped run stops acting for the user.
 *
 * Stop, New chat and Switch chat end a local run. The tools the run started
 * must then propose nothing, write nothing and ask nothing — a loop winding
 * down after the user pressed Stop must not land a highlight in their PDF or
 * put a question card in front of them. A card the user already has on screen
 * stays theirs to decide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    askUserQuestionToolForTest,
    writeTools,
} from '../../../react/atoms/executeLocalRun';
import { resolveAllLocalApprovals, resolveLocalApproval } from '../../../react/utils/localApprovals';
import { resolveAllLocalQuestions, resolveLocalQuestion } from '../../../react/utils/localQuestions';
import {
    addPendingQuestionAtom,
    removePendingQuestionAtom,
} from '@beaver/agent-core/run-state/pendingQuestions';

const PAGE_TEXT = 'The waggle dance tells nestmates how far away the food source lies.';

function makeProvider(
    execute: (payload: any) => any,
    validate?: (payload: any) => any,
) {
    return {
        zotero_document_request: {
            handle: async () => ({
                result: {
                    document: {
                        pages: [
                            {
                                index: 0,
                                label: '1',
                                items: [
                                    { sentences: [{ text: PAGE_TEXT, bboxes: [[10, 20, 300, 32]] }] },
                                ],
                            },
                        ],
                    },
                },
            }),
        },
        agent_action_execute: { handle: async (payload: any) => execute(payload) },
        ...(validate ? { agent_action_validate: { handle: async (payload: any) => validate(payload) } } : {}),
    };
}

function harness(options: {
    stopped: () => boolean;
    validate?: (payload: any) => any;
}) {
    const executed: any[] = [];
    const cards: any[] = [];
    const recorded: any[] = [];
    const set = vi.fn((_atom: unknown, payload: any) => {
        if (payload?.event === 'deferred_approval_request') cards.push(payload);
        else if (Array.isArray(payload) && payload[0]?.action_type) recorded.push(...payload);
    }) as any;
    const tools = writeTools(
        makeProvider((p) => { executed.push(p); return { success: true, result_data: {} }; }, options.validate),
        set,
        new Map(),
        'run-1',
        options.stopped,
    );
    return { tools, executed, cards, recorded };
}

async function withPreference(group: string, preference: string) {
    const { store } = await import('../../../react/store');
    const { deferredToolPreferencesAtom } = await import('../../../react/atoms/deferredToolPreferences');
    const current: any = store.get(deferredToolPreferencesAtom as any);
    store.set(deferredToolPreferencesAtom as any, {
        ...current,
        groupPreferences: { ...current.groupPreferences, [group]: preference },
    } as any);
    return () => store.set(deferredToolPreferencesAtom as any, current);
}

beforeEach(() => {
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    (Zotero as any).Libraries = { ...((Zotero as any).Libraries ?? {}), userLibraryID: 1 };
    (Zotero as any).Items = {
        ...((Zotero as any).Items ?? {}),
        getByLibraryAndKeyAsync: async (libraryID: number, key: string) => ({
            libraryID,
            key,
            isAttachment: () => true,
            isPDFAttachment: () => true,
        }),
    };
    resolveAllLocalApprovals('test reset');
    resolveAllLocalQuestions('test reset');
});

describe('write tools after the run was stopped', () => {
    it('propose nothing once the run is stopped', async () => {
        const { tools, cards, executed, recorded } = harness({ stopped: () => true });
        await expect(
            tools.create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' }),
        ).rejects.toThrow(/stopped/);
        expect(cards).toHaveLength(0);
        expect(executed).toHaveLength(0);
        expect(recorded).toHaveLength(0);
    });

    it('write nothing under "always apply" once the run is stopped', async () => {
        const restore = await withPreference('annotations', 'always_apply');
        try {
            const { tools, executed } = harness({ stopped: () => true });
            await expect(
                tools.create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' }),
            ).rejects.toThrow(/stopped/);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(executed).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('write nothing when the run is stopped while the change is being validated', async () => {
        const restore = await withPreference('annotations', 'always_apply');
        try {
            let stopped = false;
            const { tools, cards, executed } = harness({
                stopped: () => stopped,
                // The user presses Stop while validation is reading the library.
                validate: () => { stopped = true; return { valid: true }; },
            });
            await expect(
                tools.create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' }),
            ).rejects.toThrow(/stopped/);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(executed).toHaveLength(0);
            expect(cards).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('stop proposing partway through a batch of papers', async () => {
        let stopped = false;
        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event !== 'deferred_approval_request') return;
            cards.push(payload);
            // The user stops the run as soon as the first card appears.
            stopped = true;
        }) as any;
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'One', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
            ['W2', { id: 'W2', title: 'Two', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const tools = writeTools(makeProvider(() => ({ success: true })), set, found, 'run-1', () => stopped);
        await expect(
            tools.add_papers_to_library({ openalex_ids: ['W1', 'W2'] }, { toolCallId: 'call-1' }),
        ).rejects.toThrow(/stopped/);
        expect(cards).toHaveLength(1);
    });

    it('still apply a card the user approves after stopping', async () => {
        let stopped = false;
        const { tools, cards, executed } = harness({ stopped: () => stopped });
        await tools.create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });
        expect(cards).toHaveLength(1);

        stopped = true;
        resolveLocalApproval(cards[0].action_id, true);
        await vi.waitFor(() => expect(executed).toHaveLength(1));
    });
});

describe('the question tool when the run is stopped', () => {
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

    function questionHarness(signal?: AbortSignal, isStopped?: () => boolean) {
        const calls: Array<[unknown, any]> = [];
        const set = vi.fn((atom: unknown, payload: any) => { calls.push([atom, payload]); }) as any;
        const tool = askUserQuestionToolForTest(set, signal, isStopped);
        return { tool, calls };
    }

    it('does not ask at all once the run is stopped', async () => {
        const controller = new AbortController();
        controller.abort();
        const { tool, calls } = questionHarness(controller.signal);
        await expect(tool(QUESTION, { toolCallId: 'q-call' })).rejects.toThrow(/stopped/);
        expect(calls.find(([atom]) => atom === addPendingQuestionAtom)).toBeUndefined();
    });

    it('takes its card down and ends when the run is stopped while waiting', async () => {
        const controller = new AbortController();
        const { tool, calls } = questionHarness(controller.signal);
        const pending = tool(QUESTION, { toolCallId: 'q-call' });
        expect(calls.find(([atom]) => atom === addPendingQuestionAtom)).toBeDefined();

        controller.abort();

        expect(await outcomeOf(pending)).toMatch(/^rejected: .*stopped/);
        expect(calls.some(([atom, payload]) => atom === removePendingQuestionAtom && payload === 'q-call'))
            .toBe(true);
    });

    it('never tells a stopped run to carry on, even when Stop cleared the card as a skip', async () => {
        let stopped = false;
        const { tool, calls } = questionHarness(undefined, () => stopped);
        const pending = tool(QUESTION, { toolCallId: 'q-call' });
        const card = calls.find(([atom]) => atom === addPendingQuestionAtom)![1];

        // Stop gives the run's slot up and clears its question the way Skip does.
        stopped = true;
        resolveLocalQuestion(card.question_id, [], true);

        expect(await outcomeOf(pending)).toMatch(/^rejected: .*stopped/);
    });

    it('still hands a real skip back to the model', async () => {
        const { tool, calls } = questionHarness(new AbortController().signal);
        const pending = tool(QUESTION, { toolCallId: 'q-call' });
        const card = calls.find(([atom]) => atom === addPendingQuestionAtom)![1];

        resolveLocalQuestion(card.question_id, [], true);

        expect(await outcomeOf(pending)).toMatch(/^resolved: The user skipped the question/);
    });

    it('still hands a real answer back to the model', async () => {
        const { tool, calls } = questionHarness(new AbortController().signal);
        const pending = tool(QUESTION, { toolCallId: 'q-call' });
        const card = calls.find(([atom]) => atom === addPendingQuestionAtom)![1];

        resolveLocalQuestion(card.question_id, [{ item_id: 'q0', selected_option_ids: ['q0o1'] } as any], false);

        expect(await outcomeOf(pending)).toMatch(/Which colour scheme\? → Cool/);
    });
});
