import { logger } from '@beaver/agent-core/platform/logger';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { batchFindExistingReferences, BatchReferenceCheckItem } from '../../../../react/utils/batchFindExistingReferences';
import { store } from '../../../../react/store';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    FrontendTimingMetadata,
} from '@beaver/agent-core/protocol/agentProtocol';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference } from '../utils';
import { libraryRefForLibraryID, resolveWriteTargetLibrary, writeTargetLibraryError } from '../../../utils/libraryIdentity';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';
import { TimingAccumulator } from '../../../utils/timing';
import type { CreateItemProposedData, CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import { applyCreateItemData } from '../../../../react/utils/addItemActions';


/**
 * Item data sent from backend for validation
 */
interface CreateItemValidationItem {
    source_id: string;
    title?: string;
    authors?: string[];
    year?: number;
    doi?: string;
    isbn?: string;
}


/**
 * Validate a create_item action.
 * Checks which items already exist in the library using batch reference checking.
 * Returns validation result with existing items info for partial processing.
 */
async function validateCreateItemAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id: rawLibraryId, library_ref, library_name, items: batchItemsRaw, collections: batchCollections, collection_keys, tags } = request.action_data as {
        library_id?: number | null;
        library_ref?: string | null;
        library_name?: string | null;
        items?: CreateItemValidationItem[];
        collections?: string[];
        /** The single-item (execute) shape's spelling of the same thing. */
        collection_keys?: string[];
        tags?: string[];
    };
    const collections = batchCollections ?? collection_keys;

    /*
     * Two payload dialects reach this validator. The batch shape carries
     * `items[]`. The local agent's proposeWrite sends the same payload to
     * validate and execute, and the execute shape (CreateItemProposedData) is
     * a single `item: ExternalReference` — accept it here too, or every
     * locally proposed paper fails validation before the user ever sees it.
     */
    const single = (request.action_data as { item?: ExternalReference }).item;
    const items: CreateItemValidationItem[] =
        Array.isArray(batchItemsRaw) && batchItemsRaw.length > 0
            ? batchItemsRaw
            : single && typeof single === 'object'
                ? [{
                    source_id: String(single.source_id ?? single.id ?? 'proposed-item'),
                    ...(single.title ? { title: single.title } : {}),
                    ...(Array.isArray(single.authors) ? { authors: single.authors } : {}),
                    ...(typeof single.year === 'number' ? { year: single.year } : {}),
                    ...(single.identifiers?.doi ? { doi: single.identifiers.doi } : {}),
                    ...(single.identifiers?.isbn ? { isbn: single.identifiers.isbn } : {}),
                }]
                : [];

    // Validate at least one item is provided
    if (!items || items.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one item must be provided',
            error_code: 'no_items',
            preference: 'always_ask',
        };
    }

    // Get searchable library IDs - these are the libraries we can check for duplicates
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    if (searchableLibraryIds.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'No libraries are available to AlphainZ',
            error_code: 'no_searchable_libraries',
            preference: 'always_ask',
        };
    }

    const targetResolution = resolveWriteTargetLibrary({ library_ref, library_id: rawLibraryId, library_name });
    if (!targetResolution.ok) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            ...writeTargetLibraryError(targetResolution),
            preference: 'always_ask',
        };
    }
    const targetLibraryId = targetResolution.libraryID;

    // Validate library exists
    const targetLibrary = Zotero.Libraries.get(targetLibraryId);
    if (!targetLibrary) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${targetLibraryId}. Omit the library parameter to use the default library.`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library is searchable (synced with Beaver)
    if (!searchableLibraryIds.includes(targetLibraryId)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: excludedLibraryMessage(targetLibraryId),
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }
    
    // Validate library is editable
    if (!targetLibrary.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library "${targetLibrary.name}" is read-only and cannot be modified. Omit the library parameter to use the default library.`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // Validate collections exist (if specified)
    const resolvedCollections: Array<{ key: string; name: string }> = [];
    if (collections && collections.length > 0) {
        for (const collectionKey of collections) {
            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(targetLibraryId, collectionKey);
            if (!collection) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Collection not found: ${collectionKey}`,
                    error_code: 'collection_not_found',
                    preference: 'always_ask',
                };
            }
            resolvedCollections.push({
                key: collectionKey,
                name: collection.name,
            });
        }
    }

    // Check which items already exist in the library using batch reference checking
    const batchItems: BatchReferenceCheckItem[] = items.map(item => ({
        id: item.source_id,
        data: {
            title: item.title,
            date: item.year?.toString(),
            DOI: item.doi,
            ISBN: item.isbn,
            creators: item.authors,
        }
    }));

    // Map from source_id to Zotero item_id (format: "library_id-zotero_key")
    const existingItems: Record<string, string> = {};
    try {
        const batchOutput = await batchFindExistingReferences(batchItems, [targetLibraryId]);
        for (const result of batchOutput.results) {
            if (result.item !== null) {
                existingItems[result.id] = `${result.item.library_id}-${result.item.zotero_key}`;
            }
        }

        logger(`validateCreateItemAction: Found ${Object.keys(existingItems).length}/${items.length} items already in target library (${batchOutput.timing.total_ms}ms)`, 1);
    } catch (error) {
        logger(`validateCreateItemAction: Batch reference check failed: ${error}`, 1);
        // Continue with empty existing items - let the frontend handle per-item checks
    }
    
    // Get user preference
    const preference = getDeferredToolPreference('create_item');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: targetLibraryId,
            library_ref: libraryRefForLibraryID(targetLibraryId) ?? undefined,
            library_name: targetLibrary.name,
            items_count: items.length,
            existing_items: existingItems,
            resolved_collections: resolvedCollections,
            tags: tags || [],
        },
        preference,
    };
}


/**
 * Execute a create_item action.
 * Creates the item in Zotero from the proposed data.
 * 
 * Note: This handler is called once PER ITEM from the backend.
 * The action_data contains a single item's proposed_data.
 */
async function executeCreateItemAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const startTime = Date.now();
    const ta = new TimingAccumulator();

    const buildTiming = (): FrontendTimingMetadata => ({
        total_ms: Date.now() - startTime,
        ...ta.getAll(),
    });

    // The action_data is the proposed_data for a single create_item action
    const proposedData = request.action_data as CreateItemProposedData;

    // Validate we have item data
    if (!proposedData || !proposedData.item) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'No item data provided',
            error_code: 'missing_item_data',
            timing: buildTiming(),
        };
    }

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    const libResolveStart = Date.now();
    const targetResolution = resolveWriteTargetLibrary(proposedData);
    ta.record('resolve_library_ms', Date.now() - libResolveStart);
    if (!targetResolution.ok) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            ...writeTargetLibraryError(targetResolution),
            timing: buildTiming(),
        };
    }
    const library_id = targetResolution.libraryID;

    // TOCTOU guard: never create in a library the user excluded from AlphainZ,
    // even if validation passed earlier or the execute request skipped it.
    const excluded = checkLibraryExcluded(library_id);
    if (excluded) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: excluded.message,
            error_code: 'library_not_searchable',
            timing: buildTiming(),
        };
    }

    try {
        logger(`executeCreateItemAction: Creating item "${proposedData.item.title}" in library ${library_id}`, 1);

        // Checkpoint: abort before starting item creation
        checkAborted(ctx, 'create_item:before_apply');

        // Create the item using the existing utility function.
        // Forward action/run/thread IDs so the background PDF fetch task can
        // emit `attachment_resolved` back to the right thread on completion.
        /*
         * Where the user said to put it.
         *
         * `collection_keys` has always been on the proposal and the single-item
         * path never read it, so an import always landed in whatever collection
         * happened to be selected in Zotero — which is not something the user
         * was asked about, and not something the card told them afterwards.
         */
        let collectionId: number | undefined;
        const chosenKey = proposedData.collection_keys?.[0];
        if (chosenKey) {
            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
                library_id,
                chosenKey,
            );
            if (collection) collectionId = collection.id;
            else logger(`executeCreateItemAction: collection ${chosenKey} not found; using the current selection`, 1);
        }

        const result: CreateItemResultData = await ta.track('apply_ms', () =>
            applyCreateItemData(proposedData, {
                libraryId: library_id,
                ...(collectionId !== undefined ? { collectionId } : {}),
                skipUrlTranslation: true,
                timing: ta,
                actionId: request.action_id,
                runId: request.run_id,
                threadId: request.thread_id,
            })
        );

        logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: result,
            timing: buildTiming(),
        };
    } catch (error: any) {
        // Re-throw TimeoutError so it propagates to the main handler
        if (error instanceof TimeoutError) throw error;
        const errorMsg = error?.message || String(error) || 'Failed to create item';
        const errorStack = error?.stack || '';
        logger(`executeCreateItemAction: Failed to create item: ${errorMsg}`, 1);
        if (errorStack) {
            logger(`executeCreateItemAction: Stack: ${errorStack}`, 1);
        }
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: errorMsg,
            error_code: 'create_failed',
            timing: buildTiming(),
        };
    }
}

export { validateCreateItemAction, executeCreateItemAction };
