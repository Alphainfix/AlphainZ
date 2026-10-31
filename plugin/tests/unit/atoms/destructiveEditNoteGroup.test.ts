/**
 * A whole-note rewrite that would discard most of a note is its own approval
 * group, whichever note tool proposed it.
 *
 * The local tool proposes `edit_note`, and validation marks a destructive
 * rewrite on its action data. Read only for `edit_note_batch`, the mark was
 * ignored: "Allow all note edits for this run" on another card approved the
 * rewrite, and the review card's Apply all carried it along.
 */
import { describe, expect, it } from 'vitest';

import {
    canOfferToolGroupRunApproval,
    getActionToolGroup,
    getPendingApprovalIdsForToolGroup,
    isBulkApprovable,
    isDestructiveNoteRewriteAction,
} from '../../../react/atoms/runApprovalPolicy';
import { isBulkApplicable } from '../../../react/host/zotero/components/reviewChangeRows';

const destructive = { operation: 'rewrite', destructive_rewrite: true, zotero_key: 'NOTE0001', library_id: 1 };
const ordinary = { operation: 'str_replace', zotero_key: 'NOTE0002', library_id: 1 };

describe('a destructive edit_note rewrite', () => {
    it('is classified as a rewrite, not a note edit', () => {
        expect(isDestructiveNoteRewriteAction('edit_note', destructive)).toBe(true);
        expect(getActionToolGroup('edit_note', destructive)).toBe('note_rewrite');
        expect(getActionToolGroup('edit_note', ordinary)).toBe('note_edits');
        expect(getActionToolGroup('edit_note_batch', destructive)).toBe('note_rewrite');
    });

    it('is not approved by a run grant for note edits', () => {
        const pending = [
            { actionId: 'rewrite', actionType: 'edit_note', actionData: destructive },
            { actionId: 'edit', actionType: 'edit_note', actionData: ordinary },
        ];
        expect(getPendingApprovalIdsForToolGroup(pending, 'edit_note')).toEqual(['edit']);
        expect(canOfferToolGroupRunApproval([pending[0]], 'edit_note')).toBe(false);
    });

    it('is left out of a bulk apply', () => {
        expect(isBulkApprovable('edit_note', destructive)).toBe(false);
        expect(isBulkApprovable('edit_note', ordinary)).toBe(true);
        expect(isBulkApplicable({
            id: 'a',
            action_type: 'edit_note',
            status: 'pending',
            proposed_data: destructive,
        } as any)).toBe(false);
    });
});

describe('a run grant', () => {
    it('answers only the run it was given for, when told which that is', () => {
        // Proposals outlive their runs: an earlier run's — another chat's —
        // can be pending when this run's card grants its group.
        const pending = [
            { actionId: 'this-run', actionType: 'create_item', actionData: {}, runId: 'run-2' },
            { actionId: 'earlier-run', actionType: 'create_item', actionData: {}, runId: 'run-1' },
            { actionId: 'socket', actionType: 'create_item', actionData: {} },
        ];
        expect(getPendingApprovalIdsForToolGroup(pending, 'create_items', 'run-2')).toEqual(['this-run', 'socket']);
        expect(getPendingApprovalIdsForToolGroup(pending, 'create_items')).toEqual(['this-run', 'earlier-run', 'socket']);
    });
});

describe('isBulkApprovable', () => {
    it('holds back annotation deletions but not other annotation edits', () => {
        expect(isBulkApprovable('edit_annotations', { operation: 'delete' })).toBe(false);
        expect(isBulkApprovable('edit_annotations', { operation: 'edit' })).toBe(true);
        expect(isBulkApprovable('create_highlight_annotations', {})).toBe(true);
    });
});
