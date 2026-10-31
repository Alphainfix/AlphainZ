/**
 * What a write does under each permission setting, and what it leaves behind.
 *
 * - "Always review later" queues the change for the review card instead of
 *   dropping it as rejected.
 * - "Always apply" never reaches a change that validation says must be asked
 *   about, and reports APPLIED only once the write has actually landed.
 * - Every decision leaves its own record carrying what reopening the thread
 *   needs: run, tool call, action type, status, proposal and result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeTools } from '../../../react/atoms/executeLocalRun';
import { resolveAllLocalApprovals, resolveLocalApproval } from '../../../react/utils/localApprovals';
import { buildReviewRows } from '../../../react/host/zotero/components/reviewChangeRows';

const PAGE_TEXT = 'The waggle dance tells nestmates how far away the food source lies.';

function makeProvider(options: {
    execute?: (payload: any) => any;
    validate?: (payload: any) => any;
} = {}) {
    const execute = options.execute ?? (() => ({ success: true, result_data: {} }));
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
        ...(options.validate
            ? { agent_action_validate: { handle: async (payload: any) => options.validate!(payload) } }
            : {}),
    };
}

/**
 * Records as the thread holds them: one per id, a later write to the same id
 * (a decision superseding a pending record) replacing the earlier one.
 */
function keepRecords(recorded: any[], payload: any[]) {
    for (const action of payload) {
        const at = recorded.findIndex((existing) => existing.id === action.id);
        if (at >= 0) recorded[at] = { ...recorded[at], ...action };
        else recorded.push(action);
    }
}

function harness(options: Parameters<typeof makeProvider>[0] = {}, found = new Map<string, any>()) {
    const executed: any[] = [];
    const cards: any[] = [];
    const recorded: any[] = [];
    const set = vi.fn((_atom: unknown, payload: any) => {
        if (payload?.event === 'deferred_approval_request') cards.push(payload);
        else if (Array.isArray(payload) && payload[0]?.action_type) keepRecords(recorded, payload);
    }) as any;
    const execute = options.execute ?? (() => ({ success: true, result_data: {} }));
    const tools = writeTools(
        makeProvider({
            ...options,
            execute: async (payload) => {
                executed.push(payload);
                return execute(payload);
            },
        }),
        set,
        found,
        'run-1',
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

let restorePreference: (() => void) | null = null;

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
});

afterEach(() => {
    restorePreference?.();
    restorePreference = null;
    vi.useRealTimers();
});

describe('"Always review later"', () => {
    it('queues the change for review instead of rejecting it', async () => {
        restorePreference = await withPreference('annotations', 'continue_without_applying');
        const { tools, cards, executed, recorded } = harness();

        const result: any = await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );

        // Not asked now, and nothing written.
        expect(cards).toHaveLength(0);
        expect(executed).toHaveLength(0);
        // Waiting for the user, and the model is told exactly that.
        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe('pending');
        expect(result.status).toMatch(/^PROPOSED — nothing has been written yet; it is queued for the user to review/);
    });

    it('queues something the end-of-run review card offers', async () => {
        restorePreference = await withPreference('annotations', 'continue_without_applying');
        const { tools, recorded } = harness();
        await tools.create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });

        const rows = buildReviewRows(recorded);
        expect(rows).toHaveLength(1);
        expect(rows[0].toolcallId).toBe('call-1');
        expect(rows[0].resolved).toBe(false);
    });
});

describe('"Always apply"', () => {
    it('still asks when validation says the change needs approval', async () => {
        // Validation holds the live annotations and sees that this comment
        // would replace one the user wrote.
        restorePreference = await withPreference('annotations', 'always_apply');
        const { tools, cards, executed } = harness({
            validate: (request) => ({
                valid: true,
                preference: 'always_ask',
                normalized_action_data: request.action_data,
            }),
        });

        const result: any = await tools.edit_annotations(
            { annotation_ids: ['u-P4SYGK2Y'], comment: 'Replaced' },
            { toolCallId: 'call-1' },
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(executed).toHaveLength(0);
        expect(cards).toHaveLength(1);
        expect(result.status).toMatch(/^PROPOSED/);
    });

    it('never lets validation loosen what the user chose', async () => {
        const { tools, cards, executed } = harness({
            validate: (request) => ({
                valid: true,
                preference: 'always_apply',
                normalized_action_data: request.action_data,
            }),
        });

        await tools.edit_annotations(
            { annotation_ids: ['u-P4SYGK2Y'], color: 'blue' },
            { toolCallId: 'call-1' },
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(executed).toHaveLength(0);
        expect(cards).toHaveLength(1);
    });

    it('asks before deleting annotations, whatever annotations are set to', async () => {
        restorePreference = await withPreference('annotations', 'always_apply');
        const { tools, cards, executed } = harness();

        await tools.delete_annotations({ annotation_ids: ['u-P4SYGK2Y'] }, { toolCallId: 'call-1' });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(executed).toHaveLength(0);
        expect(cards).toHaveLength(1);
    });

    it('reports APPLIED only once the write has landed', async () => {
        restorePreference = await withPreference('annotations', 'always_apply');
        let landed = false;
        const { tools } = harness({
            execute: async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                landed = true;
                return { success: true, result_data: {} };
            },
        });

        const result: any = await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );

        expect(landed).toBe(true);
        expect(result.status).toMatch(/^APPLIED/);
    });

    it('names the paper that did not go in when the others did', async () => {
        // The user allowed item creation for this run from a card.
        const { store } = await import('../../../react/store');
        const { runApprovalPolicyAtom } = await import('../../../react/atoms/runApprovalPolicy');
        const { activeRunAtom } = await import('@beaver/agent-core/run-state/atoms');
        store.set(activeRunAtom, { id: 'run-1', status: 'in_progress' } as any);
        store.set(runApprovalPolicyAtom, {
            runId: 'run-1',
            approvedGroups: new Set(['create_items']),
            approvedResources: new Set<string>(),
        });
        try {
            const found = new Map<string, any>([
                ['W1', { id: 'W1', title: 'One', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
                ['W2', { id: 'W2', title: 'Two', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
            ]);
            const { tools, cards } = harness({
                execute: (payload) => (payload.action_data.item.title === 'Two'
                    ? { success: false, error: 'No translator found' }
                    : { success: true, result_data: {} }),
            }, found);

            const result: any = await tools.add_papers_to_library(
                { openalex_ids: ['W1', 'W2'] },
                { toolCallId: 'call-1' },
            );

            expect(cards).toHaveLength(0);
            expect(result.status).toMatch(/^APPLIED/);
            expect(result.note).toMatch(/^1 paper\(s\) added/);
            expect(result.papers[0].not_added).toBeUndefined();
            expect(result.papers[1].not_added).toBe('No translator found');
        } finally {
            store.set(activeRunAtom, null);
            store.set(runApprovalPolicyAtom, {
                runId: null,
                approvedGroups: new Set<string>(),
                approvedResources: new Set<string>(),
            });
        }
    });

    it('reports a write that failed as failed, with the reason', async () => {
        restorePreference = await withPreference('annotations', 'always_apply');
        const { tools, recorded } = harness({
            execute: () => ({ success: false, error: 'The PDF file is missing' }),
        });

        const result: any = await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );

        expect(result.status).toBe('FAILED — nothing was written: The PDF file is missing');
        expect(result.note).not.toMatch(/already in the (document|library)/);
        expect(recorded.map((action) => action.status)).toEqual(['error']);
    });
});

describe('a whole-note rewrite validation marks as destructive', () => {
    /** What the edit_note validator answers for a rewrite that discards most of a note. */
    const destructiveRewrite = (request: any) => ({
        valid: true,
        preference: 'always_ask',
        normalized_action_data: { ...request.action_data, destructive_rewrite: true },
    });
    const REWRITE = { note_id: 'u-NOTE0001', operation: 'rewrite', new_string: '<p>One line now.</p>' };

    it('asks on a card that still carries the mark, under "Always apply"', async () => {
        restorePreference = await withPreference('note_edits', 'always_apply');
        const { tools, cards, executed } = harness({ validate: destructiveRewrite });

        await tools.edit_note(REWRITE, { toolCallId: 'call-1' });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(executed).toHaveLength(0);
        expect(cards).toHaveLength(1);
        // What the approval layer tells it from an ordinary note edit by.
        expect(cards[0].action_data.destructive_rewrite).toBe(true);
    });

    it('is queued still carrying the mark, under "Always review later"', async () => {
        restorePreference = await withPreference('note_edits', 'continue_without_applying');
        const { tools, cards, recorded } = harness({ validate: destructiveRewrite });

        await tools.edit_note(REWRITE, { toolCallId: 'call-1' });

        expect(cards).toHaveLength(0);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            status: 'pending',
            action_type: 'edit_note',
            proposed_data: { destructive_rewrite: true },
        });
    });
});

describe('records of decisions', () => {
    it('carry what a reopened thread needs to show the card and its Undo', async () => {
        const { tools, cards, recorded } = harness({
            execute: () => ({
                success: true,
                result_data: { created: [{ library_id: 1, zotero_key: 'ANNOT001' }] },
            }),
        });
        await tools.create_highlight({ attachment_id: 'u-ABCD1234', text: PAGE_TEXT }, { toolCallId: 'call-1' });
        resolveLocalApproval(cards[0].action_id, true);
        await vi.waitFor(() => expect(recorded[0]?.status).toBe('applied'));

        expect(recorded).toHaveLength(1);
        const [action] = recorded;
        expect(action).toMatchObject({
            run_id: 'run-1',
            toolcall_id: 'call-1',
            action_type: 'create_highlight_annotations',
            status: 'applied',
            result_data: { created: [{ library_id: 1, zotero_key: 'ANNOT001' }] },
        });
        expect(action.proposed_data.items[0].text).toBe(PAGE_TEXT);
    });

    it('get an id each, even for decisions on one call made in the same instant', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'One', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
            ['W2', { id: 'W2', title: 'Two', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const { tools, cards, recorded } = harness({}, found);
        await tools.add_papers_to_library({ openalex_ids: ['W1', 'W2'] }, { toolCallId: 'call-1' });
        expect(cards).toHaveLength(2);

        // Both cards answered together.
        resolveLocalApproval(cards[0].action_id, false);
        resolveLocalApproval(cards[1].action_id, false);
        await vi.waitFor(() => expect(recorded.map((action) => action.status)).toEqual(['rejected', 'rejected']));

        expect(recorded.every((action) => action.toolcall_id === 'call-1' && action.status === 'rejected'))
            .toBe(true);
        expect(new Set(recorded.map((action) => action.id)).size).toBe(2);
    });
});
