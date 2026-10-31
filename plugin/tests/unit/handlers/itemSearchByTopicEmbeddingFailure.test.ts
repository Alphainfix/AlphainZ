/**
 * A topic search whose embedding call fails says so.
 *
 * The query is embedded by the user's own provider, which fails for ordinary
 * reasons — a spent quota, a revoked key, a stopped Ollama. Returned as an
 * empty list, that reads as "the library has nothing on this", and the model
 * tells the user exactly that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchMock, metadataSearchMock } = vi.hoisted(() => ({
    searchMock: vi.fn(),
    metadataSearchMock: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/semanticSearchService', () => ({
    semanticSearchService: vi.fn(() => ({ search: searchMock })),
}));

vi.mock('../../../src/services/database', () => ({
    BeaverDB: class {},
}));

vi.mock('../../../src/services/agentDataProvider/handleItemSearchByMetadataRequest', () => ({
    handleItemSearchByMetadataRequest: metadataSearchMock,
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    resolveCollectionsFilter: vi.fn(),
    collectionsFilterError: vi.fn(() => null),
    getCollectionScopeItemIds: vi.fn(),
    getSearchableLibraryIds: vi.fn(() => [1]),
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
    resolveLibrariesFilter: vi.fn(() => ({ libraryIds: [1], unresolved: [], excluded: [] })),
    librariesFilterError: vi.fn(() => null),
    resolveTagsFilter: vi.fn(async () => ({ tags: [], unresolved: [] })),
    tagsFilterError: vi.fn(() => null),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    deduplicateItems: vi.fn((items: any[]) => items),
}));

vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn(() => true),
}));

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeItem: vi.fn(async (item: any) => ({ zotero_key: item.key })),
}));

import type { WSItemSearchByTopicRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { handleItemSearchByTopicRequest } from '../../../src/services/agentDataProvider/handleItemSearchByTopicRequest';
import { shapeToolResult } from '../../../src/services/llm/zoteroToolDispatch';

const request = (): WSItemSearchByTopicRequest => ({
    type: 'item_search_by_topic_request',
    request_id: 'req-1',
    topic_query: 'waggle dance odometry',
    limit: 10,
} as WSItemSearchByTopicRequest);

const QUOTA = 'OpenAI embeddings failed: 429 Too Many Requests Monthly quota exceeded';

describe('handleItemSearchByTopicRequest when the query cannot be embedded', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchMock.mockRejectedValue(new Error(QUOTA));
        metadataSearchMock.mockResolvedValue({ items: [] });
        (globalThis as any).Zotero = {
            AlphainZ: { db: {} },
            Collections: { get: vi.fn(() => null) },
            Items: { getAsync: vi.fn(async () => []), loadDataTypes: vi.fn(async () => undefined) },
        };
    });

    it('fails with the provider\'s reason and the search that still works, not an empty list', async () => {
        const response: any = await handleItemSearchByTopicRequest(request());

        expect(response.items).toEqual([]);
        expect(response.error_code).toBe('semantic_search_failed');
        expect(response.error).toContain('Monthly quota exceeded');
        expect(response.error).toContain('item_search_by_metadata');
        expect(response.error).toContain('says nothing about what the library holds');
        // The dispatcher turns it into a failed tool call, which the model cannot
        // mistake for a real zero-hit search.
        expect(() => shapeToolResult('item_search_by_topic', response)).toThrow(/Monthly quota exceeded.*semantic_search_failed/);
    });

    it('still returns title matches, with a note that the meaning-based part failed', async () => {
        metadataSearchMock.mockResolvedValue({ items: [{ library_id: 1, zotero_key: 'TITLE001' }] });

        const response: any = await handleItemSearchByTopicRequest(request());

        expect(metadataSearchMock).toHaveBeenCalledWith(expect.objectContaining({ title_query: 'waggle dance odometry' }));
        expect(response.items).toEqual([{ library_id: 1, zotero_key: 'TITLE001' }]);
        expect(response.error).toBeUndefined();
        expect(response.search_note).toContain('could not run');
        expect(response.search_note).toContain('Monthly quota exceeded');
        expect(response.search_note).toContain('topic search is failing');
        expect((shapeToolResult('item_search_by_topic', response) as any).items).toHaveLength(1);
    });

    it('leaves a real zero-hit search as the honest empty result it is', async () => {
        searchMock.mockResolvedValue([]);

        const response: any = await handleItemSearchByTopicRequest(request());

        expect(response.items).toEqual([]);
        expect(response.error).toBeUndefined();
        expect(response.search_note).toContain('Nothing matched by meaning');
    });
});
