import { beforeEach, describe, expect, it, vi } from 'vitest';

// zoteroSerializers.ts transitively imports the Supabase client (via
// `./sync`), which throws at module load time without env vars. Stub it at
// the root so every transitive path resolves to a harmless stand-in.
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

// `react/atoms/profile` calls `getZoteroUserIdentifier()` (needs
// `Zotero.Users`, unavailable in unit tests) as a module-level side effect.
// Stub it — its atoms are not exercised by the serializer functions tested
// here, only pulled in transitively via `./sync`.
vi.mock('../../../react/atoms/profile', () => ({
    isProfileLoadedAtom: Symbol('isProfileLoadedAtom'),
    profileWithPlanAtom: Symbol('profileWithPlanAtom'),
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

import {
    getCollectionPathsFromItem,
    serializeItemStub,
    serializeAttachmentStub,
    serializeNote,
    serializeAnnotation,
} from '../../../src/utils/zoteroSerializers';

/**
 * Minimal Zotero item stand-in covering the fields each serializer reads.
 * Kept intentionally light — these tests target id emission, not the full
 * serialization surface (creators, tags, dates, etc.).
 */
function baseItem(overrides: Record<string, any> = {}) {
    return {
        libraryID: 1,
        key: 'ABCD1234',
        itemType: 'journalArticle',
        itemTypeID: 1,
        parentKey: null,
        attachmentFilename: null,
        getField: vi.fn(() => ''),
        getCreators: vi.fn(() => []),
        getTags: vi.fn(() => []),
        getDisplayTitle: vi.fn(() => 'Title'),
        ...overrides,
    };
}

describe('zoteroSerializers portable id emission', () => {
    beforeEach(() => {
        // Library 1 is the personal library; library 7 maps to group 42;
        // library 99 has no reverse mapping (mirrors a feed/unrecognized library).
        (globalThis as any).Zotero.Libraries = {
            ...(globalThis as any).Zotero.Libraries,
            userLibraryID: 1,
        };
        (globalThis as any).Zotero.Groups = {
            getGroupIDFromLibraryID: vi.fn((libraryID: number) => (libraryID === 7 ? 42 : null)),
        };
        (globalThis as any).Zotero.CreatorTypes = {
            getPrimaryIDForType: vi.fn(() => 8),
            getName: vi.fn(() => 'author'),
        };
    });

    describe('serializeItemStub', () => {
        it('emits a portable item_id for the personal library', () => {
            const item = baseItem({ libraryID: 1, key: 'ABCD1234' });
            const stub = serializeItemStub(item as any);
            expect(stub.item_id).toBe('u-ABCD1234');
            expect(stub.library_ref).toBe('u');
        });

        it('emits a portable item_id for a mapped group library', () => {
            const item = baseItem({ libraryID: 7, key: 'GRPKEY01' });
            const stub = serializeItemStub(item as any);
            expect(stub.item_id).toBe('g42-GRPKEY01');
            expect(stub.library_ref).toBe('g42');
        });

        it('falls back to the numeric library id when no portable ref is computable', () => {
            const item = baseItem({ libraryID: 99, key: 'FEEDKEY1' });
            const stub = serializeItemStub(item as any);
            expect(stub.item_id).toBe('99-FEEDKEY1');
            expect(stub.library_ref).toBeUndefined();
        });
    });

    describe('serializeAttachmentStub', () => {
        it('emits a portable attachment_id and parent_item_id for the personal library', () => {
            const item = baseItem({
                libraryID: 1,
                key: 'ATT12345',
                parentKey: 'PARENT01',
                attachmentFilename: 'file.pdf',
            });
            const stub = serializeAttachmentStub(item as any, 'pdf');
            expect(stub.attachment_id).toBe('u-ATT12345');
            expect(stub.parent_item_id).toBe('u-PARENT01');
        });

        it('emits a portable attachment_id for a mapped group library', () => {
            const item = baseItem({ libraryID: 7, key: 'GATT0001', parentKey: 'GPARENT1' });
            const stub = serializeAttachmentStub(item as any, 'pdf');
            expect(stub.attachment_id).toBe('g42-GATT0001');
            expect(stub.parent_item_id).toBe('g42-GPARENT1');
        });

        it('falls back to the numeric library id when no portable ref is computable', () => {
            const item = baseItem({ libraryID: 99, key: 'ATT99999', parentKey: 'PARENT99' });
            const stub = serializeAttachmentStub(item as any, 'pdf');
            expect(stub.attachment_id).toBe('99-ATT99999');
            expect(stub.parent_item_id).toBe('99-PARENT99');
        });

        it('leaves parent_item_id null when the attachment has no parent', () => {
            const item = baseItem({ libraryID: 1, key: 'TOPLEVEL1', parentKey: null });
            const stub = serializeAttachmentStub(item as any, 'pdf');
            expect(stub.parent_item_id).toBeNull();
        });
    });

    describe('serializeNote', () => {
        it('emits a portable item_id for the personal library', () => {
            const note = baseItem({ libraryID: 1, key: 'NOTE1234' });
            const result = serializeNote(note as any);
            expect(result.item_id).toBe('u-NOTE1234');
        });

        it('emits a portable item_id for a mapped group library', () => {
            const note = baseItem({ libraryID: 7, key: 'GNOTE001' });
            const result = serializeNote(note as any);
            expect(result.item_id).toBe('g42-GNOTE001');
        });

        it('falls back to the numeric library id when no portable ref is computable', () => {
            const note = baseItem({ libraryID: 99, key: 'NOTE9999' });
            const result = serializeNote(note as any);
            expect(result.item_id).toBe('99-NOTE9999');
        });
    });

    describe('serializeAnnotation', () => {
        it('emits a portable annotation_id for the personal library', () => {
            const annotation = baseItem({ libraryID: 1, key: 'ANNOT123' });
            const result = serializeAnnotation(annotation as any);
            expect(result.annotation_id).toBe('u-ANNOT123');
        });

        it('emits a portable annotation_id for a mapped group library', () => {
            const annotation = baseItem({ libraryID: 7, key: 'ANNOTGRP' });
            const result = serializeAnnotation(annotation as any);
            expect(result.annotation_id).toBe('g42-ANNOTGRP');
        });

        it('falls back to the numeric library id when no portable ref is computable', () => {
            const annotation = baseItem({ libraryID: 99, key: 'ANNOT9999' });
            const result = serializeAnnotation(annotation as any);
            expect(result.annotation_id).toBe('99-ANNOT9999');
        });
    });
});

describe('getCollectionPathsFromItem', () => {
    const collections: Record<number, { name: string; parentID: number | null }> = {
        10: { name: 'Batch7', parentID: null },
        11: { name: 'Devices', parentID: null },
        12: { name: 'Cuprates', parentID: 11 },
    };

    beforeEach(() => {
        (globalThis as any).Zotero = {
            ...((globalThis as any).Zotero ?? {}),
            Collections: {
                get: vi.fn((id: number) => {
                    const c = collections[id];
                    return c ? { name: c.name, parentID: c.parentID } : null;
                }),
            },
        };
    });

    it('names every folder, nesting joined as a path', () => {
        const item = baseItem({ getCollections: vi.fn(() => [10, 12]) });
        expect(getCollectionPathsFromItem(item as any)).toEqual(['Batch7', 'Devices / Cuprates']);
    });

    it('returns null for an unfiled item', () => {
        const item = baseItem({ getCollections: vi.fn(() => []) });
        expect(getCollectionPathsFromItem(item as any)).toBeNull();
    });

    it('says nothing rather than lying when collections are not loaded', () => {
        const item = baseItem({
            getCollections: vi.fn(() => { throw new Error('Collections not loaded'); }),
        });
        expect(getCollectionPathsFromItem(item as any)).toBeNull();
    });
});
