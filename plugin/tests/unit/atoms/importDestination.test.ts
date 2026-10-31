/**
 * Where an approved import goes — one rule, shared by the card's picker and
 * the apply path, so the folder shown is the folder written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'jotai';

import {
    chooseImportDestinationAtom,
    chosenImportDestination,
    destinationChoices,
    importDestinationAtom,
    proposedDestination,
    resolveImportDestination,
    type DestinationChoice,
} from '../../../react/atoms/importDestination';

const choices: DestinationChoice[] = [
    { libraryId: 1, collectionKey: null, label: 'My Library' },
    { libraryId: 1, collectionKey: 'AAAA1111', label: '  Thesis' },
    { libraryId: 1, collectionKey: 'RLST8KEY', label: '    Batch7' },
    { libraryId: 2, collectionKey: null, label: 'Group' },
    { libraryId: 2, collectionKey: 'GGGG2222', label: '  Shared' },
];
const current = () => ({ libraryId: 1, collectionKey: 'CURRENT1' });

describe('proposedDestination', () => {
    it('finds the library a proposed collection key lives in', () => {
        expect(proposedDestination({ collection_keys: ['GGGG2222'] }, choices))
            .toEqual({ libraryId: 2, collectionKey: 'GGGG2222' });
    });

    it('is null when the proposal names no folder, or one that does not exist', () => {
        expect(proposedDestination({}, choices)).toBeNull();
        expect(proposedDestination({ collection_keys: [] }, choices)).toBeNull();
        expect(proposedDestination({ collection_keys: ['ZZZZ9999'] }, choices)).toBeNull();
        expect(proposedDestination(null, choices)).toBeNull();
    });
});

describe('resolveImportDestination', () => {
    const listed = () => ({ libraryId: 1, collectionKey: 'AAAA1111' });

    it("the user's pick for this run wins over everything", () => {
        const chosen = { libraryId: 2, collectionKey: null };
        expect(resolveImportDestination(chosen, { collection_keys: ['RLST8KEY'] }, listed, choices)).toBe(chosen);
    });

    it('a proposal that names a folder goes to that folder, in the library that holds it', () => {
        // Written with the library as well as the key: a group collection's key
        // means nothing in My Library, which is where a bare key would land.
        expect(resolveImportDestination(null, { collection_keys: ['GGGG2222'] }, listed, choices))
            .toEqual({ libraryId: 2, collectionKey: 'GGGG2222' });
    });

    it("falls back to Zotero's current selection when nobody named a folder", () => {
        expect(resolveImportDestination(null, {}, listed, choices)).toEqual({ libraryId: 1, collectionKey: 'AAAA1111' });
        expect(resolveImportDestination(null, { collection_keys: [] }, listed, choices))
            .toEqual({ libraryId: 1, collectionKey: 'AAAA1111' });
    });

    it('never answers with something the picker does not list', () => {
        // A read-only or excluded library selected in Zotero is not a choice:
        // the card would show the first option and the paper would go
        // elsewhere. My Library stands in for it.
        const readOnlySelection = () => ({ libraryId: 9, collectionKey: null });
        expect(resolveImportDestination(null, {}, readOnlySelection, choices)).toEqual({ libraryId: 1, collectionKey: null });
        // A folder the proposal named that is not offered falls through too.
        expect(resolveImportDestination(null, { collection_keys: ['ZZZZ9999'] }, listed, choices))
            .toEqual({ libraryId: 1, collectionKey: 'AAAA1111' });
        // A pick that is no longer listed does not stick.
        expect(resolveImportDestination({ libraryId: 9, collectionKey: null }, {}, listed, choices))
            .toEqual({ libraryId: 1, collectionKey: 'AAAA1111' });
    });

    it('applies the proposal as written only when nothing is listed at all', () => {
        expect(resolveImportDestination(null, { collection_keys: ['RLST8KEY'] }, listed, [])).toBeNull();
    });
});

describe('the pick is kept per run', () => {
    it("does not carry one run's pick over to another run's papers", () => {
        const store = createStore();
        store.set(chooseImportDestinationAtom, { runId: 'run-1', destination: { libraryId: 2, collectionKey: 'GGGG2222' } });

        const picks = store.get(importDestinationAtom);
        expect(chosenImportDestination(picks, 'run-1')).toEqual({ libraryId: 2, collectionKey: 'GGGG2222' });
        // A later run's proposal names its own folder, which the old pick must
        // not override.
        expect(chosenImportDestination(picks, 'run-2')).toBeNull();
        expect(resolveImportDestination(chosenImportDestination(picks, 'run-2'), { collection_keys: ['RLST8KEY'] }, () => ({ libraryId: 1, collectionKey: null }), choices))
            .toEqual({ libraryId: 1, collectionKey: 'RLST8KEY' });
    });
});

describe('destinationChoices', () => {
    const zotero = globalThis as any;
    const original = { Libraries: zotero.Zotero.Libraries, Collections: zotero.Zotero.Collections };

    afterEach(() => {
        zotero.Zotero.Libraries = original.Libraries;
        zotero.Zotero.Collections = original.Collections;
    });

    it('lists only the libraries the agent may write to, when told which those are', () => {
        zotero.Zotero.Libraries = {
            ...original.Libraries,
            getAll: () => [
                { libraryID: 1, name: 'My Library', editable: true },
                { libraryID: 2, name: 'Lab group', editable: true },
                { libraryID: 3, name: 'Read-only group', editable: false },
            ],
        };
        zotero.Zotero.Collections = { getByLibrary: () => [], getByParent: () => [] };

        // Library 2 is excluded from AlphainZ: offered, it would be refused on Apply.
        expect(destinationChoices([1, 3]).map((choice) => choice.libraryId)).toEqual([1]);
        expect(destinationChoices().map((choice) => choice.libraryId)).toEqual([1, 2]);
    });
});
