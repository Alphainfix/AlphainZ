/**
 * Agent Data Provider
 * 
 * This service provides WebSocket communication for agent runs,
 * enabling bidirectional communication between the Zotero plugin and the backend.
 * 
 * The Beaver agent is the primary agent that handles chat completions and tool execution.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { deduplicateItems } from '../../utils/zoteroUtils';
import { agentItemFilter } from '../../utils/agentItemSupport';
import { serializeItem } from '../../utils/zoteroSerializers';
import {
    WSItemSearchByTopicRequest,
    WSItemSearchByTopicResponse,
    ItemSearchFrontendResultItem,
    FrontendTimingMetadata,
} from '@beaver/agent-core/protocol/agentProtocol';
import { semanticSearchService, SearchResult } from '../semanticSearchService';
import { BeaverDB } from '../database';
import {
    collectionsFilterError,
    getCollectionScopeItemIds,
    getSearchableLibraryIds,
    librariesFilterError,
    prepareAttachmentInfoBatchData,
    processAttachmentInfoBatch,
    resolveCollectionsFilter,
    resolveLibrariesFilter,
    resolveTagsFilter,
    tagsFilterError,
} from '../agentDataProvider/utils';
import { TimingAccumulator } from '../../utils/timing';


/**
 * Handle item_search_by_topic_request event.
 * Searches the user's Zotero library by topic using semantic search and returns matching items.
 * 
 * Algorithm:
 * 1. Use semantic search service to find items by topic similarity
 * 2. Apply filters (year, libraries, etc.)
 * 3. Serialize items with attachments and similarity scores
 * 4. Return items sorted by similarity
 */
export async function handleItemSearchByTopicRequest(
    request: WSItemSearchByTopicRequest
): Promise<WSItemSearchByTopicResponse> {
    // Start timing
    const startTime = Date.now();
    let searchEndTime = 0;
    let serializationEndTime = 0;
    
    // Get database instance from global addon
    const db = Zotero.AlphainZ?.db as BeaverDB | null;
    if (!db) {
        logger('handleItemSearchByTopicRequest: Database not available', 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    // Get searchable library IDs. An explicit libraries_filter is resolved even
    // when none are searchable, so the model is told the library is excluded
    // instead of reading an empty result as "that library holds nothing".
    const searchableLibraryIds = getSearchableLibraryIds();
    if (searchableLibraryIds.length === 0 && !request.libraries_filter?.length) {
        logger('handleItemSearchByTopicRequest: no searchable libraries available', 1);
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            timing: {
                total_ms: Date.now() - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    // Resolve library IDs from filter, but always intersect with searchable libraries.
    // Accepts portable library refs ("u"/"g<groupID>"), numeric IDs, numeric-ID
    // strings, and library name substrings.
    let libraryIds: number[] = [...searchableLibraryIds];
    if (request.libraries_filter && request.libraries_filter.length > 0) {
        const resolution = resolveLibrariesFilter(request.libraries_filter);

        // A libraries_filter that resolves to nothing must narrow the search to no
        // results, never widen it to every library — and it is reported as an error
        // rather than an empty result so a bad library reference is not mistaken for
        // a library that holds no matching items.
        const filterError = librariesFilterError(resolution);
        if (filterError) {
            logger(`handleItemSearchByTopicRequest: ${filterError.message}`, 1);
            return {
                type: 'item_search_by_topic',
                request_id: request.request_id,
                items: [],
                error: filterError.message,
                error_code: filterError.error_code,
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }

        libraryIds = resolution.libraryIds;
    }

    // Resolve collections_filter, then turn the scope into an item allowlist
    // before ranking, so the candidate pool isn't spent on items outside the
    // requested collections. Both are read from Zotero before the embedding
    // query narrows by library.
    let collectionItemIds: number[] | undefined;
    if (request.collections_filter && request.collections_filter.length > 0) {
        const resolution = resolveCollectionsFilter(request.collections_filter, libraryIds);

        // A collections_filter that resolves to nothing must narrow the search to
        // no results, never widen it to the whole library — and it is reported as
        // an error rather than an empty result so a bad collection reference is
        // not mistaken for a collection that holds no matching items.
        const filterError = collectionsFilterError(resolution);
        if (filterError) {
            logger(`handleItemSearchByTopicRequest: ${filterError.message}`, 1);
            return {
                type: 'item_search_by_topic',
                request_id: request.request_id,
                items: [],
                error: filterError.message,
                error_code: filterError.error_code,
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }

        // An empty allowlist here means the collections resolved but hold no
        // items: an honest empty result, not a bad reference.
        collectionItemIds = await getCollectionScopeItemIds(resolution.collections);
        if (collectionItemIds.length === 0) {
            logger(`handleItemSearchByTopicRequest: collections_filter resolved to ${resolution.collections.length} collections holding no items`, 1);
            return {
                type: 'item_search_by_topic',
                request_id: request.request_id,
                items: [],
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }
    }

    // Resolve tags_filter to the tag names Zotero stores, before the embedding
    // query: a tag the library doesn't have is a bad filter, not an empty result,
    // and the model can only tell the two apart if it is told.
    const tagsFilter = request.tags_filter ?? [];
    let tagNames: string[] | undefined;
    if (tagsFilter.length > 0) {
        const resolution = await resolveTagsFilter(tagsFilter, libraryIds);

        const filterError = tagsFilterError(resolution);
        if (filterError) {
            logger(`handleItemSearchByTopicRequest: ${filterError.message}`, 1);
            return {
                type: 'item_search_by_topic',
                request_id: request.request_id,
                items: [],
                error: filterError.message,
                error_code: filterError.error_code,
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }

        // A tags_filter must narrow the search, never drop off it: when nothing
        // resolved and no error explained why (no library in scope), return no
        // results instead of ranking as if no tag had been requested.
        if (resolution.tags.length === 0) {
            logger('handleItemSearchByTopicRequest: tags_filter resolved to no tags', 1);
            return {
                type: 'item_search_by_topic',
                request_id: request.request_id,
                items: [],
                timing: {
                    total_ms: Date.now() - startTime,
                    item_count: 0,
                    attachment_count: 0,
                },
            };
        }

        tagNames = resolution.tags;
    }

    logger('handleItemSearchByTopicRequest: Searching by topic', {
        topic_query: request.topic_query,
        libraryIds: libraryIds.length > 0 ? libraryIds : 'all',
        collectionItemIds: collectionItemIds ? collectionItemIds.length : 'all',
        limit: request.limit,
    }, 1);

    // Create search service and run semantic search
    const searchService = new semanticSearchService(db, 512);

    // Calculate offset for pagination (default 0, guard against negative values)
    const offset = Math.max(0, request.offset ?? 0);

    let searchResults: SearchResult[];
    try {
        searchResults = await searchService.search(request.topic_query, {
            topK: (offset + request.limit) * 4, // Fetch extra to account for filtering and pagination offset
            minSimilarity: 0.3,
            libraryIds,
            itemIds: collectionItemIds,
        });
    } catch (error) {
        logger(`handleItemSearchByTopicRequest: Semantic search failed: ${error}`, 1);
        return semanticSearchFailure(request, error, startTime);
    }
    
    // Record search completion time
    searchEndTime = Date.now();

    logger(`handleItemSearchByTopicRequest: Semantic search returned ${searchResults.length} results`, 1);

    if (searchResults.length === 0) {
        const titleHits = await titleSearchFallback(request);
        const timing: FrontendTimingMetadata = {
            total_ms: Date.now() - startTime,
            search_ms: searchEndTime - startTime,
            item_count: titleHits.length,
            attachment_count: 0,
        };
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: titleHits,
            search_note: titleHits.length > 0
                ? TITLE_MATCH_NOTE
                : 'Nothing matched by meaning, and a title search found nothing either. The '
                    + 'meaning-based index may not cover items added in the last few minutes; '
                    + '`item_search_by_metadata` reads the library directly.',
            timing,
        };
    }

    // Load items from search results
    const itemIds = searchResults.map(r => r.itemId);
    const items = await Zotero.Items.getAsync(itemIds);
    let validItems = items.filter((item): item is Zotero.Item => item !== null);

    if (validItems.length === 0) {
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: [],
            timing: {
                total_ms: Date.now() - startTime,
                search_ms: searchEndTime - startTime,
                item_count: 0,
                attachment_count: 0,
            },
        };
    }

    // Timing accumulator for serialization breakdown
    const ta = new TimingAccumulator();

    // Load item data (needed for deduplication which checks title, DOI, ISBN, creators)
    await ta.track('data_loading_ms', () =>
        Zotero.Items.loadDataTypes(validItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"])
    );

    // Deduplicate items, prioritizing items from user's main library (library ID 1)
    validItems = deduplicateItems(validItems, 1);
    const deduplicatedItemIds = new Set(validItems.map(item => item.id));
    
    // Create a map for item lookup by ID
    const itemById = new Map<number, Zotero.Item>();
    for (const item of validItems) {
        itemById.set(item.id, item);
    }
    
    // Filter searchResults to only include items that survived deduplication
    searchResults = searchResults.filter(result => deduplicatedItemIds.has(result.itemId));

    // Create similarity map
    const similarityByItemId = new Map<number, number>();
    for (const result of searchResults) {
        similarityByItemId.set(result.itemId, result.similarity);
    }

    // Apply filters first (before serialization)
    const filteredItems: { item: Zotero.Item; similarity: number }[] = [];

    for (const searchResult of searchResults) {
        const item = itemById.get(searchResult.itemId);
        if (!item) continue;

        // Apply filters
        // Year filter
        if (request.year_min || request.year_max) {
            const yearStr = item.getField('date', false, true);
            const yearMatch = yearStr ? String(yearStr).match(/\d{4}/) : null;
            const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

            if (year) {
                if (request.year_min && year < request.year_min) continue;
                if (request.year_max && year > request.year_max) continue;
            }
        }

        // Author filter
        if (request.author_filter && request.author_filter.length > 0) {
            const creators = item.getCreators();
            const creatorLastNames = creators.map(c => (c.lastName || '').toLowerCase());
            const matchesAuthor = request.author_filter.some(authorName =>
                creatorLastNames.some(lastName => lastName.includes(authorName.toLowerCase()))
            );
            if (!matchesAuthor) continue;
        }

        // Tags filter, applied to the resolved tag names rather than the request's
        // own spelling so it matches what the library actually stores.
        if (tagNames) {
            const itemTags = item.getTags().map(t => t.tag.toLowerCase());
            const matchesTag = tagNames.some(tag =>
                itemTags.includes(tag.toLowerCase())
            );
            if (!matchesTag) continue;
        }

        // Validate item is regular item and not in trash
        const isValidItem = agentItemFilter(item);
        if (!isValidItem) continue;

        filteredItems.push({
            item,
            similarity: searchResult.similarity,
        });
    }

    // Serialize items in parallel in bounded batches (with backfill on failures to ensure limit is reached)
    const targetLimit = request.limit > 0 ? request.limit : filteredItems.length;
    const candidates = filteredItems.slice(offset);
    const BATCH_SIZE = Math.min(targetLimit, 20);

    // Batch-fetch best attachments and sync dates for all candidate items
    const candidateItems = candidates.map(c => c.item);
    const batchAttachmentData = await prepareAttachmentInfoBatchData(candidateItems, ta);

    const resultItems: ItemSearchFrontendResultItem[] = [];
    for (let batchStart = 0; batchStart < candidates.length && resultItems.length < targetLimit; batchStart += BATCH_SIZE) {
        const batch = candidates.slice(batchStart, batchStart + BATCH_SIZE);

        const serialized = await Promise.all(
            batch.map(async ({ item, similarity }): Promise<ItemSearchFrontendResultItem | null> => {
                try {
                    const [itemData, attachments] = await Promise.all([
                        ta.track('item_serialization_ms', () => serializeItem(item, undefined, { skipHash: true })),
                        ta.track('attachment_processing_ms', () => processAttachmentInfoBatch(
                            item,
                            batchAttachmentData,
                            {
                                skipWorkerFallback: true,
                                timing: ta,
                                includeAnnotationsCount: true,
                            },
                        )),
                    ]);
                    return { item: itemData, attachments, similarity };
                } catch (error) {
                    logger(`handleItemSearchByTopicRequest: Failed to serialize item ${item.key}: ${error}`, 1);
                    return null;
                }
            })
        );

        for (const result of serialized) {
            if (result !== null) {
                resultItems.push(result);
                if (resultItems.length >= targetLimit) break;
            }
        }
    }

    // Record serialization completion time
    serializationEndTime = Date.now();

    // Calculate total attachment count
    const totalAttachments = resultItems.reduce((sum, item) => sum + item.attachments.length, 0);
    
    // Build timing metadata with serialization breakdown
    const timing: FrontendTimingMetadata = {
        total_ms: Date.now() - startTime,
        search_ms: searchEndTime - startTime,
        serialization_ms: serializationEndTime - searchEndTime,
        item_count: resultItems.length,
        attachment_count: totalAttachments,
        ...ta.getAll(),
    };

    logger(`handleItemSearchByTopicRequest: Returning ${resultItems.length} items (offset=${offset}, filtered=${filteredItems.length}), timing: ${JSON.stringify(timing)}`, 1);

    /*
     * A title match goes in front of the meaning-based ones.
     *
     * Returning nothing is not the failure that hurt — returning five
     * plausible neighbours is. Asked for "Arneberg's dance-language paper",
     * this handed back items that were merely nearby and the model told the
     * user the library did not have it. It did: under almost exactly the words
     * they had typed, added minutes earlier and therefore not in the index at
     * all.
     *
     * The title search costs one local query, needs no index, and is direct
     * evidence rather than a similarity score, so it is not something to fall
     * back to only when everything else came up empty.
     */
    const titleHits = await titleSearchFallback(request);
    let mergedItems = resultItems;
    let searchNote: string | undefined;
    if (titleHits.length > 0) {
        const seen = new Set(resultItems.map((item: any) => `${item.library_id}-${item.zotero_key}`));
        const fresh = titleHits
            .filter((item: any) => !seen.has(`${item.library_id}-${item.zotero_key}`))
            .slice(0, MAX_TITLE_HITS);
        if (fresh.length > 0) {
            mergedItems = [...fresh, ...resultItems].slice(0, targetLimit);
            searchNote = TITLE_MATCH_NOTE;
        }
    }

    const response: WSItemSearchByTopicResponse = {
        type: 'item_search_by_topic',
        request_id: request.request_id,
        items: mergedItems,
        ...(searchNote ? { search_note: searchNote } : {}),
        timing,
    };

    return response;
}


/**
 * A topic search that could not run, reported as one.
 *
 * Ranking starts with embedding the query, a request to the user's embedding
 * provider — and that fails for ordinary reasons: a spent quota, a revoked key,
 * an Ollama that stopped. Returned as an empty list, the failure reads as
 * "nothing in the library is about this", and the model tells the user exactly
 * that. Title matches need no index, so they are still returned when there are
 * any, with a note saying the meaning-based part failed; with none, the call
 * fails outright, naming the reason and the search that still works.
 */
async function semanticSearchFailure(
    request: WSItemSearchByTopicRequest,
    error: unknown,
    startTime: number,
): Promise<WSItemSearchByTopicResponse> {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
    const failure = `The meaning-based search could not run${reason ? ` (${reason.slice(0, 300)})` : ''}. `
        + 'That says nothing about what the library holds.';
    const titleHits = await titleSearchFallback(request);
    const timing: FrontendTimingMetadata = {
        total_ms: Date.now() - startTime,
        item_count: titleHits.length,
        attachment_count: 0,
    };
    if (titleHits.length > 0) {
        return {
            type: 'item_search_by_topic',
            request_id: request.request_id,
            items: titleHits,
            search_note: `${failure} Only items whose title matches the query are listed, so papers that `
                + 'discuss the topic in other words are missing; tell the user topic search is failing, and '
                + 'use `item_search_by_metadata` with other keywords to look further.',
            timing,
        };
    }
    return {
        type: 'item_search_by_topic',
        request_id: request.request_id,
        items: [],
        error: `${failure} Search with \`item_search_by_metadata\` (title keywords, authors, journal) instead, `
            + 'and tell the user that topic search is failing rather than that nothing matched.',
        error_code: 'semantic_search_failed',
        timing,
    };
}

/** How many title matches may precede the semantic results. */
const MAX_TITLE_HITS = 3;

/** Said whenever a title match is standing in front of the semantic results. */
const TITLE_MATCH_NOTE =
    'Items whose title matches the query are listed first. They come from a direct '
    + 'title search, not the meaning-based index, so they are current even for '
    + 'something added moments ago — semantic results follow.';

/**
 * Ask Zotero's own title search the same question.
 *
 * Deliberately narrow: the topic query as a title match, honouring the same
 * library and collection filters. It is not a second semantic search and does
 * not pretend to be — it is there to catch the case the index has not reached
 * yet, which in practice is the paper the user added a minute ago and is
 * asking about now.
 */
async function titleSearchFallback(
    request: WSItemSearchByTopicRequest,
): Promise<any[]> {
    const query = String(request.topic_query ?? '').trim();
    if (!query) return [];
    try {
        const { handleItemSearchByMetadataRequest } = await import(
            './handleItemSearchByMetadataRequest'
        );
        const response = await handleItemSearchByMetadataRequest({
            type: 'item_search_by_metadata',
            request_id: request.request_id,
            title_query: query,
            libraries_filter: request.libraries_filter,
            collections_filter: request.collections_filter,
            tags_filter: request.tags_filter,
            year_min: request.year_min,
            year_max: request.year_max,
            limit: request.limit,
        } as any);
        return response?.items ?? [];
    } catch (error) {
        logger(`titleSearchFallback: ${error}`, 1);
        return [];
    }
}
