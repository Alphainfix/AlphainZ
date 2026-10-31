/**
 * An id the model passes for an item in a group library resolves to that
 * library's id on this computer.
 *
 * `g42-KEY` names group 42, whose library here is a local row id (5 below).
 * Lookups go by `library_ref` and worked with either number, but anything
 * keyed on the numeric id did not: the run's grant to edit a note it created
 * this run is keyed on the note's local library id, so every edit of such a
 * note in a group library asked again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'jotai';

import { buildToolRequest, parseCompositeItemId } from '../../../src/services/llm/toolSchemas';
import {
    grantCreatedNoteEditsForRunAtom,
    isActionApprovedForRun,
    runApprovalPolicyAtom,
} from '../../../react/atoms/runApprovalPolicy';

const GROUP_ID = 42;
const GROUP_LIBRARY_ID = 5;

let savedGroups: unknown;
beforeEach(() => {
    savedGroups = (Zotero as any).Groups;
    (Zotero as any).Groups = {
        getLibraryIDFromGroupID: (groupID: number) => (groupID === GROUP_ID ? GROUP_LIBRARY_ID : false),
        getGroupIDFromLibraryID: (libraryID: number) => (libraryID === GROUP_LIBRARY_ID ? GROUP_ID : false),
    };
});
afterEach(() => {
    (Zotero as any).Groups = savedGroups;
});

describe('a composite id', () => {
    it('resolves a group ref to the library id on this computer', () => {
        expect(parseCompositeItemId('g42-ABCD1234')).toEqual({
            zotero_key: 'ABCD1234',
            library_id: GROUP_LIBRARY_ID,
            library_ref: 'g42',
        });
    });

    it('marks a group this computer does not have as unresolved, keeping its ref', () => {
        // 0 is UNRESOLVED_LIBRARY_ID: the handlers report the library as not
        // available here, by its ref.
        expect(parseCompositeItemId('g77-ABCD1234')).toEqual({
            zotero_key: 'ABCD1234',
            library_id: 0,
            library_ref: 'g77',
        });
    });

    it('keeps the personal library at id 1', () => {
        expect(parseCompositeItemId('u-ABCD1234')).toEqual({ zotero_key: 'ABCD1234', library_id: 1, library_ref: 'u' });
    });

    it('refuses what is not an id', () => {
        for (const id of ['g0-ABCD1234', 'g012-ABCD1234', 'g-ABCD1234', '5-ABCD1234', 'u-', 'ABCD1234']) {
            expect(parseCompositeItemId(id)).toBeNull();
        }
    });

    it('reaches a tool request with the local id', () => {
        const request = buildToolRequest('read_document', { attachment_id: 'g42-ABCD1234' }, 'req-1');
        expect(request.attachment).toEqual({ zotero_key: 'ABCD1234', library_id: GROUP_LIBRARY_ID, library_ref: 'g42' });
    });
});

describe("the run's grant to edit a note it created", () => {
    it('covers an edit that names the note by its group ref', () => {
        const store = createStore();
        // Granted when the note is created, from the saved note itself.
        store.set(grantCreatedNoteEditsForRunAtom, { runId: 'run-1', libraryId: GROUP_LIBRARY_ID, zoteroKey: 'NOTE0001' });
        const reference = parseCompositeItemId('g42-NOTE0001')!;
        expect(isActionApprovedForRun(store.get(runApprovalPolicyAtom), 'run-1', 'edit_note', {
            library_id: reference.library_id,
            zotero_key: reference.zotero_key,
            library_ref: reference.library_ref,
        })).toBe(true);
    });
});
