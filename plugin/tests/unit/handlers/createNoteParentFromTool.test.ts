/**
 * The local create_note tool and the create_note validator agree on where a
 * note goes.
 *
 * The tool proposes `parent_item_id` and `library_ref`; the validator must turn
 * exactly that into a parent key and the parent's library, which is what makes
 * the note a child of the paper instead of a standalone note in My Library.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({ store: { get: vi.fn(() => [1, 5]), set: vi.fn() } }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom') }));
vi.mock('../../../react/atoms/threads', () => ({ currentThreadIdAtom: Symbol('currentThreadIdAtom') }));
vi.mock('../../../react/utils/citationRenderers', () => ({ renderToHTML: vi.fn((content: string) => content) }));
vi.mock('../../../react/utils/citationRenderContext', () => ({
    prepareCitationRenderContext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../react/utils/noteActions', () => ({
    wrapWithSchemaVersion: vi.fn((html: string) => html),
    getBeaverNoteFooterHTML: vi.fn(() => ''),
}));
vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({ getOrSimplify: vi.fn() }));
vi.mock('../../../src/utils/noteCitationExpand', () => ({ preloadNotePageLabels: vi.fn() }));
vi.mock('../../../src/utils/noteEditorIO', () => ({ getLatestNoteHtml: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider/lookupZoteroReferences', () => ({
    lookupZoteroReferences: vi.fn(),
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn(() => null),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} is excluded`),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    getLibraryByIdOrName: vi.fn(() => ({ library: null, wasExplicitlyRequested: false })),
    getCollectionByIdOrName: vi.fn(() => null),
}));

import { validateCreateNoteAction } from '../../../src/services/agentDataProvider/actions/createNote';

const GROUP_LIBRARY_ID = 5;

beforeEach(() => {
    (Zotero as any).Utilities = {
        ...((Zotero as any).Utilities ?? {}),
        isValidObjectKey: (key: string) => /^[A-Z0-9]{8}$/.test(key),
    };
    (Zotero as any).Libraries = {
        ...((Zotero as any).Libraries ?? {}),
        userLibraryID: 1,
        get: (libraryID: number) =>
            libraryID === GROUP_LIBRARY_ID ? { libraryID, name: 'Lab', editable: true } : null,
    };
    (Zotero as any).Groups = {
        getLibraryIDFromGroupID: (groupID: number) => (groupID === 42 ? GROUP_LIBRARY_ID : false),
        getGroupIDFromLibraryID: (libraryID: number) => (libraryID === GROUP_LIBRARY_ID ? 42 : false),
    };
    (Zotero as any).Items = {
        ...((Zotero as any).Items ?? {}),
        getByLibraryAndKeyAsync: async (libraryID: number, key: string) =>
            libraryID === GROUP_LIBRARY_ID && key === 'PAPER001'
                ? {
                    libraryID,
                    key,
                    isRegularItem: () => true,
                    isAttachment: () => false,
                    isNote: () => false,
                    isAnnotation: () => false,
                }
                : false,
    };
});

describe('create_note placement', () => {
    it('makes the note a child of the paper, in the paper\'s library', async () => {
        const response: any = await validateCreateNoteAction({
            event: 'agent_action_validate',
            request_id: 'validate-1',
            action_type: 'create_note',
            // Exactly what the local tool proposes.
            action_data: {
                parent_item_id: 'g42-PAPER001',
                library_ref: 'g42',
                title: 'Summary',
                content: 'The paper shows a thing.',
            },
        } as any);

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toMatchObject({
            parent_key: 'PAPER001',
            library_id: GROUP_LIBRARY_ID,
            library_ref: 'g42',
        });
    });
});
