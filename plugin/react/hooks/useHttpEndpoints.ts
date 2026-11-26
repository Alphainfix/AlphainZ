/**
 * Hook to register HTTP endpoints for local FrontendCapability.
 *
 * This hook registers HTTP endpoints on Zotero's local server (port 23119)
 * that expose the agent data provider handlers. The endpoints are only
 * registered when the user is authenticated and the React store is available.
 *
 * Endpoints are unregistered when the hook unmounts (e.g., user logs out).
 *
 * `/alphainz/test/pdf-*` endpoints
 * ------------------------------
 * The pure PDF extraction endpoints (page count, render, extract,
 * analyze-layout, render-overlay, sentence bboxes, etc.) have BeaverExtract
 * CLI equivalents — see `docs-zotero/beaver-extract-cli.md` for the mapping.
 * Prefer the CLI for new debugging work; it skips the Zotero round-trip
 * and runs the same extraction code in Node. Endpoints that exercise
 * Zotero state (cache, notes, editor, item resolution, worker lifecycle)
 * stay HTTP-only.
 */

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { isAuthenticatedAtom, LOCAL_USER_ID } from '../atoms/auth';
import { discardThreadCompaction, maybeCompactThread } from '../atoms/threadCompaction';
import { logger } from '@beaver/agent-core/platform/logger';
import { getZoteroUserIdentifier } from '../../src/utils/zoteroUtils';
import { BeaverUIFactory } from '../../src/ui/ui';
import { conversationSyncMode } from '../../src/services/conversationSync';
import { flushSettingsExportNow } from '../../src/services/conversationSync/settingsSync';
import { importSettingsNow } from '../utils/settingsSyncClient';
import { providerConnection } from '@beaver/agent-core/transport/providerConnection';
import { enqueueMutatingAction } from '@beaver/agent-core/transport/agentActionQueue';
import { getPref, setPref } from '../../src/utils/prefs';
import {
    handleZoteroDataRequest,
    handleExternalReferenceCheckRequest,
    handleZoteroDocumentRequest,
    handleZoteroAttachmentPageImagesRequest,
    handleZoteroAttachmentSearchRequest,
    handleItemSearchByMetadataRequest,
    handleItemSearchByTopicRequest,
    handleItemQuickSearchRequest,
    // Library management tools
    handleZoteroSearchRequest,
    handleListItemsRequest,
    handleResolvePopulationRequest,
    handleGetMetadataRequest,
    handleFindAnnotationsRequest,
    handleListLibrariesRequest,
    handleListCollectionsRequest,
    handleListTagsRequest,
    // Deferred tools
    handleAgentActionValidateRequest,
    handleAgentActionExecuteRequest,
    // Utility
    handleDeleteItemsRequest,
    // Notes
    handleReadNoteRequest,
} from '../../src/services/agentDataProvider';
import {
    handleTestPingHttpRequest,
    handleTestCacheMetadataHttpRequest,
    handleTestCachePayloadHttpRequest,
    handleTestCacheInvalidateHttpRequest,
    handleTestCacheSeedPageLabelsHttpRequest,
    handleTestCacheClearAllHttpRequest,
    handleTestReadAttachmentHttpRequest,
    handleTestMcpReadNoteHttpRequest,
    handleTestMcpCreateNoteHttpRequest,
    handleTestWorkerStatsHttpRequest,
    handleTestWorkerMarkStaleHttpRequest,
    handleTestWorkerCacheClearHttpRequest,
    handleTestWorkerWedgeProbeHttpRequest,
    handleTestWorkerIdleProbeHttpRequest,
    handleTestWorkerRealmProbeHttpRequest,
    handleTestFileStatusHttpRequest,
    handleTestResolveItemHttpRequest,
    handleTestResolveReadableHttpRequest,
    handleTestBestEpubAttachmentHttpRequest,
    handleTestValidateItemHttpRequest,
    handleTestValidateRegularItemHttpRequest,
    handleTestExternalFileAttachHttpRequest,
    handleTestExternalFileDeleteHttpRequest,
    handleTestExternalFileViewImagesHttpRequest,
    handleTestDocumentSerializedHttpRequest,
} from './httpHandlers/testCacheHandlers';
import {
    handleTestNoteCreateHttpRequest,
    handleTestNoteDeleteHttpRequest,
    handleTestNoteReadHttpRequest,
    handleTestNoteOpenEditorHttpRequest,
    handleTestNoteCloseEditorHttpRequest,
    handleTestNoteUndoHttpRequest,
} from './httpHandlers/testNoteHandlers';
import {
    handleTestCollectionCreateHttpRequest,
    handleTestCollectionDeleteHttpRequest,
} from './httpHandlers/testCollectionHandlers';
import {
    handleTestAnnotationCreateHttpRequest,
    handleTestAnnotationTrashHttpRequest,
} from './httpHandlers/testAnnotationHandlers';
import {
    handleTestSyncPauseHttpRequest,
} from './httpHandlers/testSyncHandlers';
import {
    handleTestSidebarWidthHandlerHttpRequest,
} from './httpHandlers/testUiHandlers';
import {
    handleTestPdfPageCountHttpRequest,
    handleTestPdfPageLabelsHttpRequest,
    handleTestPdfRenderPagesHttpRequest,
    handleTestPdfRenderPagesWithMetaHttpRequest,
    handleTestPdfExtractRawDetailedHttpRequest,
    handleTestPdfExtractHttpRequest,
    handleTestPdfExtractParagraphHttpRequest,
    handleTestPdfHasTextLayerHttpRequest,
    handleTestPdfAnalyzeOcrHttpRequest,
    handleTestPdfSearchScoredHttpRequest,
    handleTestPdfSentenceBBoxesHttpRequest,
    handleTestPdfRenderOverlayHttpRequest,
    handleTestPdfExtractTraceHttpRequest,
    handleTestPdfAnalyzeLayoutHttpRequest,
} from './httpHandlers/testPdfHandlers';
import {
    handleTestEpubExtractHttpRequest,
} from './httpHandlers/testEpubHandlers';
import {
    handleTestSnapshotExtractHttpRequest,
} from './httpHandlers/testSnapshotHandlers';
import {
    handleTestCreateReportHttpRequest,
} from './httpHandlers/testReportHandlers';
import {
    handleTestEpubAnnotationParityHttpRequest,
} from './httpHandlers/testEpubAnnotationHandlers';
import {
    handleTestSnapshotAnnotationParityHttpRequest,
} from './httpHandlers/testSnapshotAnnotationHandlers';
import {
    handleTestReaderStateHttpRequest,
    handleTestReaderSelectionProbeHttpRequest,
    handleTestItemMenuProbeHttpRequest,
    handleTestEpubCitationNavigateHttpRequest,
} from './httpHandlers/testReaderHandlers';
import {
    handleTestResolveItemDisplayHttpRequest,
} from './httpHandlers/testCitationHandlers';
import {
    handleTestBackgroundEnqueueHttpRequest,
    handleTestBackgroundStatsHttpRequest,
    handleTestBackgroundPeekHttpRequest,
    handleTestBackgroundProcessOnceHttpRequest,
    handleTestBackgroundClearHttpRequest,
} from './httpHandlers/testBackgroundHandlers';
import {
    handleTestExcludedLibrariesHttpRequest,
    handleTestGetAnnotationsHttpRequest,
    handleTestViewImagesHttpRequest,
    handleTestAttachmentImageHttpRequest,
} from './httpHandlers/testExclusionHandlers';
import {
    handleTestLibraryIdentityHttpRequest,
} from './httpHandlers/testLibraryIdentityHandlers';
import {
    handleTestNewThreadHttpRequest,
    handleTestAnswerQuestionHttpRequest,
    handleTestEraseTrashedHttpRequest,
    handleTestImportPdfHttpRequest,
    handleTestRemoveTaggedHttpRequest,
    handleTestChatSendHttpRequest,
    handleTestCurrentIdsHttpRequest,
    handleTestDumpRunsHttpRequest,
    handleTestListThreadsHttpRequest,
    handleTestThreadListHttpRequest,
    handleTestDeleteThreadsHttpRequest,
    handleTestRetryRunHttpRequest,
    handleTestLoadThreadHttpRequest,
    handleTestListActionsHttpRequest,
    handleTestApproveActionHttpRequest,
    handleTestConfirmCreditsHttpRequest,
    handleTestUndoActionHttpRequest,
} from './httpHandlers/testChatHandlers';
import {
    handleTestApplicationStateHttpRequest,
    handleTestBeaverSidebarHttpRequest,
    handleTestBeaverWindowHttpRequest,
    handleTestSelectTabHttpRequest,
    handleTestSelectItemsHttpRequest,
} from './httpHandlers/testApplicationStateHandlers';
import {
    handleTestReopenAnchorHttpRequest,
    handleTestSelectionChatHttpRequest,
} from './httpHandlers/testSelectionChatHandlers';
import {
    handleTestFulltextStatsHttpRequest,
    handleTestIndexFulltextHttpRequest,
    handleTestIndexStateHttpRequest,
    handleTestIndexModelsHttpRequest,
    handleTestSemanticSearchHttpRequest,
    handleTestIndexPageImagesHttpRequest,
    handleTestPageImageStatusHttpRequest,
    handleTestFigureSearchHttpRequest,
    handleTestPaneStateHttpRequest,
    handleTestFigurePanelHttpRequest,
handleTestReindexHttpRequest,
} from './httpHandlers/testIndexHandlers';
import { handleTestListModelsHttpRequest, handleTestVisionProbeHttpRequest } from './httpHandlers/testVisionHandlers';
import type {
    WSZoteroDataRequest,
    WSExternalReferenceCheckRequest,
    WSZoteroDocumentRequest,
    WSZoteroAttachmentPageImagesRequest,
    WSZoteroAttachmentSearchRequest,
    WSItemSearchByMetadataRequest,
    WSItemSearchByTopicRequest,
    WSItemQuickSearchRequest,
    // Library management tools
    WSZoteroSearchRequest,
    WSListItemsRequest,
    WSResolvePopulationRequest,
    WSGetMetadataRequest,
    WSFindAnnotationsRequest,
    WSListLibrariesRequest,
    WSListCollectionsRequest,
    WSListTagsRequest,
    // Deferred tools
    WSAgentActionValidateRequest,
    WSAgentActionExecuteRequest,
    // Notes
    WSReadNoteRequest,
} from '@beaver/agent-core/protocol/agentProtocol';


// =============================================================================
// Types
// =============================================================================

interface ZoteroRequestData {
    method: string;
    pathname: string;
    pathParams: Record<string, string>;
    searchParams: URLSearchParams;
    headers: Headers;
    data: any;
}


// =============================================================================
// Endpoint Helpers
// =============================================================================

/** List of registered endpoint paths for cleanup */
const ENDPOINT_PATHS = [
    '/alphainz/zotero-data',
    '/alphainz/external-reference-check',
    '/alphainz/search/metadata',
    '/alphainz/search/topic',
    '/alphainz/search/quick',
    '/alphainz/attachment/document',
    '/alphainz/attachment/page-images',
    '/alphainz/attachment/search',
    // Library management tools
    '/alphainz/library/search',
    '/alphainz/library/list',
    '/alphainz/library/resolve-population',
    '/alphainz/library/metadata',
    '/alphainz/library/find-annotations',
    '/alphainz/library/libraries',
    '/alphainz/library/collections',
    '/alphainz/library/tags',
    // Deferred tools
    '/alphainz/agent-action/validate',
    '/alphainz/agent-action/execute',
    // Utility
    '/alphainz/user-info',
    '/alphainz/delete-items',
    // Notes
    '/alphainz/note/read',
    // Test-only endpoints (cache inspection/manipulation)
    '/alphainz/test/ping',
    '/alphainz/test/cache-metadata',
    '/alphainz/test/cache-payload',
    '/alphainz/test/cache-invalidate',
    '/alphainz/test/cache-seed-page-labels',
    '/alphainz/test/cache-clear-all',
    '/alphainz/test/read-attachment',
    '/alphainz/test/mcp-read-note',
    '/alphainz/test/mcp-create-note',
    '/alphainz/test/resolve-item',
    '/alphainz/test/resolve-readable',
    '/alphainz/test/best-epub-attachment',
    '/alphainz/test/validate-item',
    '/alphainz/test/validate-regular-item',
    '/alphainz/test/external-file-attach',
    '/alphainz/test/external-file-delete',
    '/alphainz/test/external-file-view-images',
    // Serialized PDF document-request wire path (responseMode: 'websocket')
    '/alphainz/test/document-serialized',
    // Test-only endpoints (note seeding/teardown/inspection)
    '/alphainz/test/note-create',
    '/alphainz/test/note-delete',
    '/alphainz/test/note-read',
    '/alphainz/test/note-open-editor',
    '/alphainz/test/note-close-editor',
    '/alphainz/test/note-undo',
    // Test-only endpoints (collection seeding/teardown)
    '/alphainz/test/collection-create',
    '/alphainz/test/collection-delete',
    // Test-only endpoints (headless PDF annotations)
    '/alphainz/test/annotation-create',
    '/alphainz/test/annotation-trash',
    // Test-only endpoints (MuPDF worker singleton stats / lifecycle)
    '/alphainz/test/worker-stats',
    '/alphainz/test/worker-mark-stale',
    '/alphainz/test/worker-cache-clear',
    '/alphainz/test/worker-wedge-probe',
    '/alphainz/test/worker-idle-probe',
    '/alphainz/test/worker-realm-probe',
    // Test-only endpoint (file-status side-effect trigger)
    '/alphainz/test/file-status',
    // Test-only endpoints (MuPDF worker plumbing)
    '/alphainz/test/pdf-page-count',
    '/alphainz/test/pdf-page-labels',
    '/alphainz/test/pdf-render-pages',
    '/alphainz/test/pdf-render-pages-with-meta',
    '/alphainz/test/pdf-extract-raw-detailed',
    // orchestration parity endpoints
    '/alphainz/test/pdf-extract',
    '/alphainz/test/pdf-extract-paragraph',
    '/alphainz/test/pdf-has-text-layer',
    '/alphainz/test/pdf-analyze-ocr',
    '/alphainz/test/pdf-search-scored',
    '/alphainz/test/pdf-sentence-bboxes',
    // Bbox-overlay debugging (sentences/items/lines/paragraphs/columns/margins)
    '/alphainz/test/pdf-render-overlay',
    // Per-page extract trace (every stage, JSON-only)
    '/alphainz/test/pdf-extract-trace',
    // Document-wide style + margin analysis context (mirrors what
    // `extract({ mode: "structured" })` builds before per-page processing)
    '/alphainz/test/pdf-analyze-layout',
    // EPUB extraction over a raw file path or attachment (corpus triage)
    '/alphainz/test/epub-extract',
    '/alphainz/test/snapshot-extract',
    // Generated HTML reports stored as snapshot attachments (dev-only)
    '/alphainz/test/create-report',
    // EPUB annotation CFI/sortIndex parity (headless resolver vs reader)
    '/alphainz/test/epub-annotation-parity',
    // Snapshot annotation selector/sortIndex parity (headless resolver vs reader)
    '/alphainz/test/snapshot-annotation-parity',
    // Reader position / EPUB citation-navigation verification (dev-only)
    '/alphainz/test/reader-state',
    '/alphainz/test/reader-selection-probe',
    '/alphainz/test/item-menu-probe',
    '/alphainz/test/epub-citation-navigate',
    // Citation host: itemData.resolveItemDisplay (dev-only)
    '/alphainz/test/resolve-item-display',
    // Background queue inspection / driving (dev-only)
    '/alphainz/test/background-enqueue',
    '/alphainz/test/background-stats',
    '/alphainz/test/background-peek',
    '/alphainz/test/background-process-once',
    '/alphainz/test/background-clear',
    // Pref control (dev-only)
    '/alphainz/test/set-pref',
    '/alphainz/test/appearance-probe',
    '/alphainz/test/preferences-window',
    '/alphainz/test/caret-watch',
    '/alphainz/test/caret-probe',
    '/alphainz/test/ui-click',
    '/alphainz/test/ui-click-text',
    '/alphainz/test/ui-text',
    '/alphainz/test/layout-probe',
    '/alphainz/test/reading-probe',
    '/alphainz/test/zotero-view',
    '/alphainz/test/conversation-sync-now',
    '/alphainz/test/purge-remote',
    // Thread compaction: force a pass / read the stored record (dev-only)
    '/alphainz/test/compact-now',
    '/alphainz/test/thread-compaction',
    // Sync-suppression control/inspection (dev-only)
    '/alphainz/test/sync-pause',
    // Reader sidebar-width wrapper lifecycle (install/unwrap/restore)
    '/alphainz/test/sidebar-width-handler',
    // Provider-mode connection control (dev-only)
    '/alphainz/test/provider-connect',
    '/alphainz/test/provider-status',
    '/alphainz/test/provider-close',

    '/alphainz/test/excluded-libraries',
    '/alphainz/test/get-annotations',
    '/alphainz/test/view-images',
    '/alphainz/test/attachment-image',
    // Device-portable library-identity resolvers (dev-only)
    '/alphainz/test/library-identity',
    // Headless chat/run lifecycle driving (dev-only)
    '/alphainz/test/new-thread',
    '/alphainz/test/chat-send',
    '/alphainz/test/answer-question',
    '/alphainz/test/import-pdf',
    '/alphainz/test/remove-tagged',
    '/alphainz/test/erase-trashed',
    '/alphainz/test/current-ids',
    '/alphainz/test/dump-runs',
    '/alphainz/test/load-thread',
    '/alphainz/test/list-threads',
    '/alphainz/test/thread-list',
    '/alphainz/test/retry-run',
    '/alphainz/test/delete-threads',
    '/alphainz/test/list-actions',
    '/alphainz/test/approve-action',
    '/alphainz/test/confirm-credits',
    '/alphainz/test/undo-action',
    '/alphainz/test/application-state',
    '/alphainz/test/alphainz-window',
    '/alphainz/test/alphainz-sidebar',
    '/alphainz/test/select-tab',
    '/alphainz/test/select-items',
    // Reader-anchored conversations (dev-only): the three events these dispatch
    // normally come from a click inside the reader.
    '/alphainz/test/reindex',
    '/alphainz/test/index-state',
    '/alphainz/test/index-models',
    '/alphainz/test/vision-probe',
    '/alphainz/test/list-models',
    '/alphainz/test/semantic-search',
    '/alphainz/test/index-page-images',
    '/alphainz/test/page-image-status',
    '/alphainz/test/figure-search',
    '/alphainz/test/pane-state',
    '/alphainz/test/figure-panel',
'/alphainz/test/index-fulltext',
    '/alphainz/test/fulltext-stats',
    '/alphainz/test/selection-chat',
    '/alphainz/test/reopen-anchor',
] as const;

/**
 * Generate a simple unique ID for requests.
 */
function generateRequestId(): string {
    if (typeof Zotero !== 'undefined' && Zotero.Utilities?.randomString) {
        return Zotero.Utilities.randomString(16);
    }
    return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Creates a Zotero HTTP endpoint from an async handler function.
 */
function createEndpoint<TRequest, TResponse>(
    handler: (request: TRequest) => Promise<TResponse>
): new () => { supportedMethods: string[]; supportedDataTypes: string[]; init: (requestData: ZoteroRequestData) => Promise<[number, string, string]> } {
    const Endpoint = function(this: any) {} as any;
    
    Endpoint.prototype = {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json"],
        
        async init(requestData: ZoteroRequestData): Promise<[number, string, string]> {
            try {
                const result = await handler(requestData.data);
                return [200, "application/json", JSON.stringify(result)];
            } catch (error) {
                logger(`useHttpEndpoints: Endpoint error: ${error}`, 1);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return [500, "application/json", JSON.stringify({
                    error: errorMessage
                })];
            }
        }
    };
    
    return Endpoint;
}


// =============================================================================
// Endpoint Handlers
// =============================================================================

async function handleZoteroDataHttpRequest(request: any) {
    const wsRequest: WSZoteroDataRequest = {
        event: 'zotero_data_request',
        request_id: generateRequestId(),
        items: request.items,
        include_attachments: request.include_attachments,
        include_parents: request.include_parents,
        include_notes: request.include_notes,
        file_status_level: request.file_status_level,
    };

    const response = await handleZoteroDataRequest(wsRequest);

    return {
        items: response.items,
        attachments: response.attachments,
        notes: response.notes,
        annotations: response.annotations,
        errors: response.errors,
    };
}

async function handleExternalReferenceCheckHttpRequest(request: any) {
    const wsRequest: WSExternalReferenceCheckRequest = {
        event: 'external_reference_check_request',
        request_id: generateRequestId(),
        library_ids: request.library_ids,
        items: request.items,
    };
    
    const response = await handleExternalReferenceCheckRequest(wsRequest);
    
    return {
        results: response.results,
    };
}

async function handleMetadataSearchHttpRequest(request: any) {
    const wsRequest: WSItemSearchByMetadataRequest = {
        event: 'item_search_by_metadata_request',
        request_id: generateRequestId(),
        title_query: request.title_query,
        author_query: request.author_query,
        publication_query: request.publication_query,
        year_min: request.year_min,
        year_max: request.year_max,
        item_type_filter: request.item_type_filter,
        libraries_filter: request.libraries_filter,
        tags_filter: request.tags_filter,
        collections_filter: request.collections_filter,
        limit: request.limit,
        offset: request.offset,
    };
    
    const response = await handleItemSearchByMetadataRequest(wsRequest);

    return {
        items: response.items,
        error: response.error ?? null,
        error_code: response.error_code ?? null,
    };
}

async function handleTopicSearchHttpRequest(request: any) {
    const wsRequest: WSItemSearchByTopicRequest = {
        event: 'item_search_by_topic_request',
        request_id: generateRequestId(),
        topic_query: request.topic_query,
        author_filter: request.author_filter,
        year_min: request.year_min,
        year_max: request.year_max,
        libraries_filter: request.libraries_filter,
        tags_filter: request.tags_filter,
        collections_filter: request.collections_filter,
        limit: request.limit,
        offset: request.offset,
    };
    
    const response = await handleItemSearchByTopicRequest(wsRequest);

    return {
        items: response.items,
        // Why the result looks the way it does. An empty list with no
        // explanation is what let a model tell the user their library held
        // nothing on a subject it had a paper about.
        ...((response as any).search_note ? { search_note: (response as any).search_note } : {}),
        error: response.error ?? null,
        error_code: response.error_code ?? null,
    };
}

async function handleQuickSearchHttpRequest(request: any) {
    const wsRequest: WSItemQuickSearchRequest = {
        event: 'item_quick_search_request',
        request_id: generateRequestId(),
        query: request.query,
        item_type_filter: request.item_type_filter,
        libraries_filter: request.libraries_filter,
        tags_filter: request.tags_filter,
        collections_filter: request.collections_filter,
        detail: request.detail,
        limit: request.limit,
        offset: request.offset,
    };

    const response = await handleItemQuickSearchRequest(wsRequest);

    return {
        items: response.items,
        detail: response.detail,
        total_count: response.total_count,
        // Without this a caller reads a truncated total as the complete match
        // count and pages into a hole. LocalhostFrontendCapability reads it.
        truncated: response.truncated ?? false,
        error: response.error ?? null,
        error_code: response.error_code ?? null,
    };
}

async function handleAttachmentDocumentHttpRequest(request: any) {
    const wsRequest: WSZoteroDocumentRequest = {
        event: 'zotero_document_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        external_file_key: request.external_file_key,
        mode: request.mode ?? 'structured',
        max_pages: request.max_pages,
        timeout_seconds: request.timeout_seconds,
    };

    const response = await handleZoteroDocumentRequest(wsRequest);

    return {
        resolved_attachment: response.resolved_attachment,
        external_file_key: response.external_file_key,
        content_type: response.content_type,
        content_kind: response.content_kind,
        result: response.result,
        total_pages: response.total_pages,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleAttachmentPageImagesHttpRequest(request: any) {
    const wsRequest: WSZoteroAttachmentPageImagesRequest = {
        event: 'zotero_attachment_page_images_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        pages: request.pages,
        scale: request.scale,
        dpi: request.dpi,
        format: request.format,
        jpeg_quality: request.jpeg_quality,
        skip_local_limits: request.skip_local_limits,
        prefer_page_labels: request.prefer_page_labels,
        timeout_seconds: request.timeout_seconds,
    };
    
    const response = await handleZoteroAttachmentPageImagesRequest(wsRequest);
    
    return {
        attachment: response.attachment,
        pages: response.pages,
        total_pages: response.total_pages,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleAttachmentSearchHttpRequest(request: any) {
    const wsRequest: WSZoteroAttachmentSearchRequest = {
        event: 'zotero_attachment_search_request',
        request_id: generateRequestId(),
        attachment: request.attachment,
        query: request.query,
        max_hits_per_page: request.max_hits_per_page,
        skip_local_limits: request.skip_local_limits,
        timeout_seconds: request.timeout_seconds,
    };
    
    const response = await handleZoteroAttachmentSearchRequest(wsRequest);
    
    return {
        attachment: response.attachment,
        query: response.query,
        total_matches: response.total_matches,
        pages_with_matches: response.pages_with_matches,
        total_pages: response.total_pages,
        pages: response.pages,
        error: response.error,
        error_code: response.error_code,
    };
}


// =============================================================================
// Library Management HTTP Handlers
// =============================================================================

async function handleLibrarySearchHttpRequest(request: any) {
    const wsRequest: WSZoteroSearchRequest = {
        event: 'zotero_search_request',
        request_id: generateRequestId(),
        conditions: request.conditions || [],
        join_mode: request.join_mode || 'all',
        library_id: request.library_id,
        include_children: request.include_children ?? false,
        item_category: request.item_category ?? 'regular',
        recursive: request.recursive ?? true,
        sort_by: request.sort_by ?? null,
        sort_order: request.sort_order ?? null,
        limit: request.limit ?? 10,
        offset: request.offset ?? 0,
        fields: request.fields,
    };
    
    const response = await handleZoteroSearchRequest(wsRequest);

    return {
        items: response.items,
        total_count: response.total_count,
        // Validation warnings identify invalid conditions that were not applied.
        warnings: response.warnings,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleLibraryListHttpRequest(request: any) {
    const wsRequest: WSListItemsRequest = {
        event: 'list_items_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        collection_key: request.collection_key,
        tag: request.tag,
        item_category: request.item_category ?? 'regular',
        recursive: request.recursive ?? true,
        sort_by: request.sort_by || 'dateModified',
        sort_order: request.sort_order || 'desc',
        limit: request.limit ?? 20,
        offset: request.offset ?? 0,
    };
    
    const response = await handleListItemsRequest(wsRequest);
    
    return {
        items: response.items,
        total_count: response.total_count,
        library_name: response.library_name,
        collection_name: response.collection_name,
        error: response.error,
        error_code: response.error_code,
    };
}

/**
 * Population resolution over HTTP. The backend's localhost frontend posts here,
 * so the accepted body and the returned shape must stay identical to the
 * `resolve_population` wire request/response.
 */
async function handleResolvePopulationHttpRequest(request: any) {
    const wsRequest: WSResolvePopulationRequest = {
        event: 'resolve_population_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        collection_keys: request.collection_keys ?? [],
        recursive: request.recursive ?? true,
        tags: request.tags ?? [],
        unfiled: request.unfiled ?? false,
        untagged: request.untagged ?? false,
        conditions: request.conditions || [],
        conditions_join_mode: request.conditions_join_mode ?? null,
        item_category: request.item_category === 'attachment' ? 'attachment' : 'regular',
        has_attachments: request.has_attachments ?? null,
        max_items: request.max_items ?? 1000,
    };

    const response = await handleResolvePopulationRequest(wsRequest);

    return {
        item_ids: response.item_ids,
        total_count: response.total_count,
        // How many bibliographic items matched, before an attachment population
        // was derived from them. Without it the caller cannot tell an empty
        // attachment population from filters that matched nothing.
        matched_item_count: response.matched_item_count,
        truncated: response.truncated,
        // The place the population lives, which the approval card states from
        // these alone — the WebSocket transport forwards them, so this one has
        // to as well or a localhost run loses the WHERE half of the card.
        library_name: response.library_name,
        collection_names: response.collection_names,
        // The join mode actually applied to `conditions`. Its absence is how the
        // caller detects a provider that predates the field, so it has to be
        // forwarded here too.
        conditions_join_mode: response.conditions_join_mode,
        // A dropped condition widens the population; the caller must not act on
        // ids that came back with a warning.
        warnings: response.warnings,
        error: response.error,
        error_code: response.error_code,
        available_libraries: response.available_libraries,
    };
}

async function handleLibraryMetadataHttpRequest(request: any) {
    const wsRequest: WSGetMetadataRequest = {
        event: 'get_metadata_request',
        request_id: generateRequestId(),
        item_ids: request.item_ids || [],
        include_attachments: request.include_attachments ?? false,
        include_notes: request.include_notes ?? false,
        detail: request.detail,
    };

    const response = await handleGetMetadataRequest(wsRequest);

    return {
        items: response.items,
        detail: response.detail,
        not_found: response.not_found,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleFindAnnotationsHttpRequest(request: any) {
    const wsRequest: WSFindAnnotationsRequest = {
        event: 'find_annotations_request',
        request_id: generateRequestId(),
        text_contains: request.text_contains,
        comment_contains: request.comment_contains,
        tag: request.tag,
        color: request.color,
        annotation_type: request.annotation_type,
        author: request.author,
        attachment_id: request.attachment_id,
        collection: request.collection,
        recursive: request.recursive ?? true,
        library_id: request.library_id,
        modified_in_last: request.modified_in_last,
        sort_by: request.sort_by ?? 'date_modified',
        sort_order: request.sort_order ?? 'desc',
        limit: request.limit ?? 25,
        offset: request.offset ?? 0,
    };

    const response = await handleFindAnnotationsRequest(wsRequest);

    return {
        annotations: response.annotations,
        total_count: response.total_count,
        note: response.note,
        error: response.error,
        error_code: response.error_code,
        available_libraries: response.available_libraries,
    };
}

async function handleListLibrariesHttpRequest(_request: any) {
    const wsRequest: WSListLibrariesRequest = {
        event: 'list_libraries_request',
        request_id: generateRequestId(),
    };

    const response = await handleListLibrariesRequest(wsRequest);

    return {
        libraries: response.libraries,
        total_count: response.total_count,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleListCollectionsHttpRequest(request: any) {
    const wsRequest: WSListCollectionsRequest = {
        event: 'list_collections_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        parent_collection_key: request.parent_collection_key,
        include_item_counts: request.include_item_counts ?? false,
        recursive: request.recursive ?? false,
        limit: request.limit ?? 50,
        offset: request.offset ?? 0,
    };

    const response = await handleListCollectionsRequest(wsRequest);

    return {
        collections: response.collections,
        total_count: response.total_count,
        library_id: response.library_id,
        library_name: response.library_name,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleListTagsHttpRequest(request: any) {
    const wsRequest: WSListTagsRequest = {
        event: 'list_tags_request',
        request_id: generateRequestId(),
        library_id: request.library_id,
        collection_key: request.collection_key,
        min_item_count: request.min_item_count ?? 0,
        name_query: request.name_query,
        limit: request.limit ?? 50,
        offset: request.offset ?? 0,
    };

    const response = await handleListTagsRequest(wsRequest);

    return {
        tags: response.tags,
        total_count: response.total_count,
        library_id: response.library_id,
        library_name: response.library_name,
        error: response.error,
        error_code: response.error_code,
    };
}

async function handleAgentActionValidateHttpRequest(request: any) {
    const wsRequest: WSAgentActionValidateRequest = {
        event: 'agent_action_validate',
        request_id: generateRequestId(),
        action_type: request.action_type,
        action_data: request.action_data,
    };

    const response = await handleAgentActionValidateRequest(wsRequest);

    // Hand-maintained projection of WSAgentActionValidateResponse minus the
    // transport envelope.
    return {
        valid: response.valid,
        error: response.error,
        error_code: response.error_code,
        error_candidates: response.error_candidates,
        edit_errors: response.edit_errors,
        current_value: response.current_value,
        normalized_action_data: response.normalized_action_data,
        collection_names: response.collection_names,
        preference: response.preference,
        warnings: response.warnings,
    };
}

async function handleAgentActionExecuteHttpRequest(request: any) {
    const wsRequest: WSAgentActionExecuteRequest = {
        event: 'agent_action_execute',
        request_id: generateRequestId(),
        action_type: request.action_type,
        action_data: request.action_data,
        timeout_seconds: request.timeout_seconds,
    };

    // Mirror the `serialize` flag the WebSocket dispatch map sets on
    // `agent_action_execute`: action handlers hold no per-item lock, so two
    // executes landing together on one item would each write back the content
    // they read and the later save would drop the earlier edit.
    const response = await enqueueMutatingAction(() =>
        handleAgentActionExecuteRequest(wsRequest),
    );

    return {
        success: response.success,
        error: response.error,
        error_code: response.error_code,
        error_candidates: response.error_candidates,
        result_data: response.result_data,
    };
}

async function handleUserInfoHttpRequest(_request: any) {
    return getZoteroUserIdentifier();
}

async function handleDeleteItemsHttpRequest(request: any) {
    return await handleDeleteItemsRequest({
        item_ids: request.item_ids || [],
    });
}

async function handleReadNoteHttpRequest(request: any) {
    const wsRequest: WSReadNoteRequest = {
        event: 'read_note_request',
        request_id: generateRequestId(),
        note_id: request.note_id,
        offset: request.offset,
        limit: request.limit,
    };

    return await handleReadNoteRequest(wsRequest);
}

// Provider-mode connection control (dev-only). Lets tests/agents open the
// provider WebSocket without a wake broadcast, inspect its state, and close it.
// Set an AlphainZ pref (dev-only). Lets agents/tests flip pref-gated features
// (e.g. dataProviderEnabled) without the RDP bridge.
async function handleTestSetPrefHttpRequest(request: any) {
    const { key, value } = request ?? {};
    if (typeof key !== 'string' || !key) {
        throw new Error('key is required');
    }
    // This endpoint only writes. Omitting `value` used to store `undefined`,
    // so a call meant as a read silently wiped the preference — and the
    // response looked like a successful read of an empty value. Refuse instead;
    // an explicit empty string still clears.
    if (!('value' in (request ?? {}))) {
        throw new Error('value is required (this endpoint writes; it cannot read)');
    }
    setPref(key as any, value);
    return { ok: true, key, value: getPref(key as any) };
}

// Appearance probe (dev-only). Reads the real panes back out of the DOM so a
// theme change can be verified without a screenshot: which classes ended up on
// each `.alphainz-root`, what the browser actually computed for a handful of
// representative elements, and — with `dump: true` — the pane's own markup and
// the host's resolved design tokens, which together are enough to rebuild the
// pane as a standalone page for a visual check.
const APPEARANCE_TOKENS = [
    '--alphainz-font-size', '--alphainz-line-height', '--alphainz-font-family',
    '--fill-primary', '--fill-secondary', '--fill-tertiary', '--fill-quarternary',
    '--fill-quinary', '--fill-senary', '--material-sidepane', '--material-background',
    '--material-menu', '--material-button', '--color-background', '--color-panedivider',
    '--color-border', '--color-border50', '--accent-blue', '--accent-blue50',
    '--accent-azure', '--accent-green', '--accent-red', '--accent-yellow',
    '--color-accent', '--font-size-small', '--font-family',
];

async function handleTestAppearanceProbeHttpRequest(request: any) {
    const selectors: string[] = Array.isArray(request?.selectors) ? request.selectors : [];
    const dump = request?.dump === true;
    const props: string[] = Array.isArray(request?.props) && request.props.length
        ? request.props
        : ['background-color', 'color', 'font-family', 'font-size', 'line-height',
           'border-color', 'border-radius', 'border-width'];

    const roots: any[] = [];
    const seen = new Set<any>();
    const windows: any[] = [...(Zotero.getMainWindows?.() ?? [])];
    // The settings and standalone chat windows are not main windows.
    try {
        const en = (Services as any)?.wm?.getEnumerator?.(null);
        while (en?.hasMoreElements?.()) windows.push(en.getNext());
    } catch { /* enumerator unavailable */ }
    for (const win of windows) {
        const doc = win?.document;
        if (!doc || seen.has(doc)) continue;
        seen.add(doc);
        for (const root of Array.from(doc.querySelectorAll('.alphainz-root')) as any[]) {
            const view = root.ownerDocument?.defaultView;
            if (!view) continue;
            const entry: any = {
                className: root.className,
                dataDark: root.getAttribute('data-alphainz-dark'),
                id: root.id || null,
                rect: (() => {
                    const r = root.getBoundingClientRect();
                    return {
                        x: Math.round(r.left), y: Math.round(r.top),
                        w: Math.round(r.width), h: Math.round(r.height),
                    };
                })(),
                box: (() => {
                    const cs = view.getComputedStyle(root);
                    return {
                        position: cs.position, zIndex: cs.zIndex,
                        background: cs.backgroundColor,
                        pointerEvents: cs.pointerEvents, visibility: cs.visibility,
                    };
                })(),
                inline: root.getAttribute('style'),
                computed: {} as Record<string, any>,
                tokens: {} as Record<string, string>,
            };
            const rootStyle = view.getComputedStyle(root);
            for (const t of APPEARANCE_TOKENS) {
                const v = rootStyle.getPropertyValue(t).trim();
                if (v) entry.tokens[t] = v;
            }
            for (const sel of ['', ...selectors]) {
                const el = sel ? root.querySelector(sel) : root;
                if (!el) { entry.computed[sel || ':root'] = null; continue; }
                const cs = view.getComputedStyle(el);
                const out: Record<string, string> = {};
                for (const prop of props) out[prop] = cs.getPropertyValue(prop);
                entry.computed[sel || ':root'] = out;
            }
            if (dump) {
                entry.html = root.outerHTML;
                entry.sheets = Array.from(root.ownerDocument.styleSheets as any)
                    .map((sheet: any) => { try { return sheet.href; } catch { return null; } })
                    .filter(Boolean);
                const bodyStyle = view.getComputedStyle(root.ownerDocument.documentElement);
                entry.hostTokens = {} as Record<string, string>;
                for (const t of APPEARANCE_TOKENS) {
                    const v = bodyStyle.getPropertyValue(t).trim();
                    if (v) entry.hostTokens[t] = v;
                }
            }
            roots.push(entry);
        }
    }
    return {
        ok: true,
        count: roots.length,
        prefs: {
            uiTheme: getPref('uiTheme'),
            uiFont: getPref('uiFont'),
            uiFontSize: getPref('uiFontSize'),
            uiLineHeight: getPref('uiLineHeight'),
        },
        roots,
    };
}

/*
 * Caret watch (dev-only).
 *
 * In Zotero's chrome document a childList mutation resets a focused
 * contenteditable's selection offsets to 0 — the composer already works around
 * that for its own placeholder. When the caret jumps to the front of the line
 * mid-typing, something *else* added or removed a node, and the only way to
 * know what is to watch.
 *
 * Records every childList mutation under the pane while the editor holds
 * focus, with the caret offsets sampled immediately before and after, plus
 * every selectionchange that puts the caret at 0 in a non-empty editor. Read
 * the buffer back after reproducing and the culprit is the mutation whose
 * `after` is 0 and whose `before` was not.
 */
interface CaretWatchEntry {
    t: number;
    kind: 'mutation' | 'caret-reset' | 'composition' | 'caret' | 'focus';
    target?: string;
    added?: string[];
    removed?: string[];
    before?: number | null;
    after?: number | null;
    textLength?: number;
    /** compositionstart / compositionupdate / compositionend / focusin / focusout. */
    event?: string;
    /** Whether the editor held focus when this was recorded. */
    focused?: boolean;
    /** Whether a mutation happened inside the AlphainZ pane or elsewhere in the chrome document. */
    inPane?: boolean;
    /** Where the document focus sits (caret-reset and focus entries). */
    active?: string;
}

let caretWatch: {
    entries: CaretWatchEntry[];
    stop: () => void;
} | null = null;

function describeNode(n: any): string {
    if (!n) return '?';
    if (n.nodeType === 3) return `#text("${String(n.nodeValue ?? '').slice(0, 24)}")`;
    const cls = typeof n.className === 'string' && n.className
        ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
    return `${(n.nodeName || '?').toLowerCase()}${n.id ? '#' + n.id : ''}${cls}`;
}

function describePath(el: any, depth = 4): string {
    const parts: string[] = [];
    let cur = el;
    for (let i = 0; i < depth && cur; i += 1) {
        parts.unshift(describeNode(cur));
        cur = cur.parentElement;
    }
    return parts.join(' > ');
}

/*
 * Does a childList mutation elsewhere really move the caret? (dev-only)
 *
 * Settles the question without anyone typing: put text in the composer, park
 * the caret at the end, add and remove a node somewhere else in the chrome
 * document, and read the caret back. The composer's own sources assert this
 * happens — this measures it, on this Zotero, in this pane.
 */
/*
 * Click something in the live pane by CSS selector (dev-only).
 *
 * Exists so a dumped DOM can include states that only a click reaches — an
 * opened work-stream disclosure, an expanded thinking block — without scripting
 * the compositor. Returns how many nodes matched and the first match's label.
 */
/*
 * Run one conversation+settings catch-up pass right now (dev-only), so live
 * tests can trigger an import deterministically instead of waiting for a
 * history-open or a poll tick.
 */
/*
 * Delete every remote copy a named backend holds (dev-only). Exists for
 * exactly one job: clearing another backend's leftovers after a switch that
 * kept them — the running UI can only clean the CURRENT backend.
 */
/**
 * Force a compaction pass on a thread (dev-only): bypasses the thresholds but
 * not the keep-window, exactly like the automatic path otherwise.
 */
async function handleTestCompactNowHttpRequest(request: any) {
    const threadId = String(request?.threadId ?? '');
    if (!threadId) return { ok: false, error: 'threadId is required' };
    const db = (Zotero as any).AlphainZ?.db ?? null;
    const outcome = await maybeCompactThread(db, LOCAL_USER_ID, threadId, { force: true });
    const record = await db?.threadCompaction?.(LOCAL_USER_ID, threadId);
    return { ok: true, outcome, compaction: record ?? null };
}

/** Read (or clear, with {clear:true}) a thread's stored compaction record (dev-only). */
async function handleTestThreadCompactionHttpRequest(request: any) {
    const threadId = String(request?.threadId ?? '');
    if (!threadId) return { ok: false, error: 'threadId is required' };
    const db = (Zotero as any).AlphainZ?.db ?? null;
    if (request?.clear === true) {
        const cleared = await discardThreadCompaction(db, LOCAL_USER_ID, threadId);
        return { ok: cleared, compaction: null };
    }
    const record = await db?.threadCompaction?.(LOCAL_USER_ID, threadId);
    return { ok: true, compaction: record ?? null };
}

async function handleTestPurgeRemoteHttpRequest(request: any) {
    const kind = String(request?.backend ?? '');
    if (kind !== 'zotero' && kind !== 'folder') {
        return { ok: false, error: 'backend must be "zotero" or "folder"' };
    }
    const { ZoteroConversationBackend } = await import(
        '../../src/services/conversationSync/zoteroBackend'
    );
    const { FolderConversationBackend } = await import(
        '../../src/services/conversationSync/folderBackend'
    );
    const backend = kind === 'zotero'
        ? new ZoteroConversationBackend()
        : new FolderConversationBackend(String(request?.folderPath ?? ''));
    const { removed } = await backend.deleteAllRemote();
    return { ok: true, backend: kind, removed };
}

async function handleTestConversationSyncNowHttpRequest(_request: any) {
    const { syncConversationsNow } = await import('../atoms/loadLocalThreads');
    const mode = conversationSyncMode();
    let flushed: boolean | undefined;
    if (_request?.flushSettings === true) {
        flushed = await flushSettingsExportNow();
    }
    await syncConversationsNow();
    const settingsApplied = await importSettingsNow();
    return { ok: true, mode, settingsApplied, ...(flushed !== undefined ? { flushed } : {}) };
}

/**
 * Where each thread view is reading (dev-only): its scroll position and size,
 * the room under the conversation, and where the newest question's request
 * sits relative to the top of the view — enough to watch a question go up when
 * it is sent, stay put while its answer streams, and come back up, marked,
 * when the answer is finished.
 *
 * `scrollTo` first scrolls every thread view there, as a reader would, and
 * reports after the scroll has been handled.
 *
 * `trace: { ms }` records the visible thread view instead, frame by frame, for
 * that long: every frame, scroll and scrollend (position, question top, room,
 * sizes), every `scrollTop` write and `scrollTo` call on the view (not
 * `scrollIntoView`), and every change of the column's minimum height. With
 * `wheel: { notches, delta, mode, gapMs, startDelayMs }` it also turns a
 * synthesized wheel over the view meanwhile (mode 1 = lines, 0 = pixels).
 * `dppx` sets layout.css.devPixelsPerPx, to look at another display scale such
 * as Windows' 125%. Sent with a trace it applies for that trace only; sent
 * alone it stays until `restoreDppx: true` puts back exactly what the profile
 * had before the first change (a user's own value, or none) — kept in a pref
 * of its own, so a restart in between does not lose it.
 */
async function handleTestReadingProbeHttpRequest(request: any) {
    const pref = 'layout.css.devPixelsPerPx';
    const kept = 'extensions.alphainz.test.dppxBefore';
    const settle = () => new Promise((resolve) => Zotero.getMainWindow().setTimeout(resolve, 600));
    const scaleNow = () => (Services.prefs.prefHasUserValue(pref) ? Services.prefs.getStringPref(pref) : null);
    const setScale = (value: string | null) => {
        if (value === null) Services.prefs.clearUserPref(pref);
        else Services.prefs.setStringPref(pref, value);
    };
    const dppx = typeof request?.dppx === 'string' && request.dppx ? request.dppx : null;
    if ((request?.restoreDppx === true || (dppx && !request?.trace)) && tracing) {
        return { ok: false, error: 'a trace is running' };
    }
    if (request?.restoreDppx === true) {
        if (Services.prefs.prefHasUserValue(kept)) {
            const before = Services.prefs.getStringPref(kept);
            setScale(before === '' ? null : before);
            Services.prefs.clearUserPref(kept);
        }
        await settle();
        return { ok: true, dppx: Zotero.getMainWindow().devicePixelRatio, scale: scaleNow() };
    }
    if (dppx && !request?.trace) {
        if (!Services.prefs.prefHasUserValue(kept)) Services.prefs.setStringPref(kept, scaleNow() ?? '');
        setScale(dppx);
        await settle();
        return { ok: true, dppx: Zotero.getMainWindow().devicePixelRatio, before: Services.prefs.getStringPref(kept) || null };
    }
    if (request?.trace) {
        if (tracing) return { ok: false, error: 'a trace is already running' };
        tracing = true;
        const before = scaleNow();
        try {
            if (dppx) {
                setScale(dppx);
                await settle();
            }
            const win: any = Zotero.getMainWindow();
            const view = (Array.from(win.document.querySelectorAll('#alphainz-thread-view')) as any[])
                .find((candidate) => candidate.clientHeight > 0);
            if (!view) return { ok: false, error: 'no visible thread view' };
            return { ok: true, dppx: win.devicePixelRatio, trace: await traceThreadView(win, view, request) };
        } finally {
            if (dppx) setScale(before);
            tracing = false;
        }
    }
    const views: any[] = [];
    const scrollTo = typeof request?.scrollTo === 'number' ? request.scrollTo : null;
    const seen = new Set<any>();
    const windows: any[] = [...(Zotero.getMainWindows?.() ?? [])];
    try {
        const en = (Services as any)?.wm?.getEnumerator?.(null);
        while (en?.hasMoreElements?.()) windows.push(en.getNext());
    } catch { /* enumerator unavailable */ }
    for (const win of windows) {
        const doc = win?.document;
        if (!doc || seen.has(doc)) continue;
        seen.add(doc);
        for (const view of Array.from(doc.querySelectorAll('#alphainz-thread-view')) as any[]) {
            if (scrollTo !== null) {
                view.scrollTop = scrollTo;
                await new Promise((resolve) => win.setTimeout(resolve, 120));
            }
            const requests = view.querySelectorAll('[id^="user-request-"]');
            const last = requests[requests.length - 1] as any;
            const viewTop = view.getBoundingClientRect().top;
            const room = view.querySelector('.thread-reading-room') as any;
            const column = view.querySelector('.thread-column') as any;
            // The box with an id that the view's top edge is in, and how far into it the edge is.
            const edge = viewTopOf(view);
            const columnBox = column?.getBoundingClientRect();
            let atTop: any = columnBox && view.clientHeight > 0
                ? doc.elementFromPoint(columnBox.left + Math.min(24, columnBox.width / 2), edge + 1)
                : null;
            while (atTop && atTop !== view && !atTop.id) atTop = atTop.parentElement;
            if (atTop === view || !view.contains(atTop)) atTop = null;
            // `track`: an element id to report the same way, wherever the edge is.
            const tracked = typeof request?.track === 'string' ? doc.getElementById(request.track) : null;
            // `markEdge`: mark the innermost element at the edge, to report as `marked` from then on.
            if (request?.markEdge === true && columnBox && view.clientHeight > 0) {
                for (const old of Array.from(view.querySelectorAll('[data-alphainz-probe-mark]')) as any[]) {
                    old.removeAttribute('data-alphainz-probe-mark');
                }
                let hit: any = doc.elementFromPoint(columnBox.left + Math.min(24, columnBox.width / 2), edge + 1);
                while (hit && !(hit instanceof win.HTMLElement)) hit = hit.parentElement;
                // Down to the box the room anchors to: the first child box at or below the edge, or the innermost crossing it.
                for (let next: any = hit; next;) {
                    hit = next;
                    next = Array.from(hit.children as ArrayLike<any>).find((child: any) => {
                        const box = child.getBoundingClientRect();
                        return child instanceof win.HTMLElement && box.height > 0 && box.bottom > edge;
                    }) ?? null;
                    if (next && next.getBoundingClientRect().top >= edge) {
                        hit = next;
                        break;
                    }
                }
                if (hit && view.contains(hit)) hit.setAttribute('data-alphainz-probe-mark', '');
            }
            const marked = view.querySelector('[data-alphainz-probe-mark]') as any;
            views.push({
                marked: marked
                    ? {
                        tag: String(marked.tagName).toLowerCase(),
                        offset: Math.round((edge - marked.getBoundingClientRect().top) * 100) / 100,
                        height: Math.round(marked.getBoundingClientRect().height * 100) / 100,
                    }
                    : null,
                atTop: atTop
                    ? { id: String(atTop.id), offset: Math.round((edge - atTop.getBoundingClientRect().top) * 100) / 100 }
                    : null,
                tracked: tracked && view.contains(tracked)
                    ? {
                        offset: Math.round((edge - tracked.getBoundingClientRect().top) * 100) / 100,
                        height: Math.round(tracked.getBoundingClientRect().height * 100) / 100,
                    }
                    : null,
                pane: view.closest('[id^="alphainz-pane-"]')?.id ?? null,
                scrollTop: Math.round(view.scrollTop),
                // The exact position, which scrollTop rounds to the pixel.
                position: column ? Math.round((viewTopOf(view) - column.getBoundingClientRect().top) * 100) / 100 : null,
                minHeight: column?.style.minHeight || null,
                scrollHeight: view.scrollHeight,
                clientHeight: view.clientHeight,
                clientWidth: view.clientWidth,
                room: room ? Math.round(room.getBoundingClientRect().height) : null,
                runs: view.querySelectorAll('[id^="run-"]').length,
                lastQuestion: last
                    ? {
                        id: String(last.id).slice('user-request-'.length),
                        top: Math.round(last.getBoundingClientRect().top - viewTop),
                        flashing: last.hasAttribute('data-conversation-flash'),
                    }
                    : null,
            });
        }
    }
    return { ok: true, views };
}

/** Where a thread view's content starts on screen: below its border and top padding. */
function viewTopOf(view: any): number {
    const style = view.ownerDocument.defaultView.getComputedStyle(view);
    return view.getBoundingClientRect().top + view.clientTop + (parseFloat(style.paddingTop) || 0);
}

/** A reading-probe trace is running; a second one would take over its hooks. */
let tracing = false;

/** The frame-by-frame record of handleTestReadingProbeHttpRequest's `trace`. */
async function traceThreadView(win: any, view: any, request: any) {
    const ms = Math.min(Math.max(Number(request.trace?.ms) || 3000, 100), 60000);
    const sleep = (wait: number) => new Promise((resolve) => win.setTimeout(resolve, wait));
    const t0 = win.performance.now();
    const at = () => Math.round((win.performance.now() - t0) * 10) / 10;
    const room = view.querySelector('.thread-reading-room');
    const columnOf = view.querySelector('.thread-column');
    const r2 = (value: number) => Math.round(value * 100) / 100;
    const sample = (kind: string) => {
        const requests = view.querySelectorAll('[id^="user-request-"]');
        const last = requests[requests.length - 1];
        const top = view.getBoundingClientRect().top;
        return {
            t: at(),
            kind,
            st: r2(view.scrollTop),
            pos: columnOf ? r2(viewTopOf(view) - columnOf.getBoundingClientRect().top) : null,
            q: last ? r2(last.getBoundingClientRect().top - top) : null,
            fl: last ? last.hasAttribute('data-conversation-flash') : null,
            room: room ? r2(room.getBoundingClientRect().height) : null,
            sh: view.scrollHeight,
            ch: view.clientHeight,
        };
    };
    const log: any[] = [];
    const scrollTopOf = Object.getOwnPropertyDescriptor(win.Element.prototype, 'scrollTop')!;
    Object.defineProperty(view, 'scrollTop', {
        configurable: true,
        get() { return scrollTopOf.get!.call(this); },
        set(value) {
            log.push({ t: at(), kind: 'write', value: r2(value), from: r2(scrollTopOf.get!.call(this)) });
            scrollTopOf.set!.call(this, value);
        },
    });
    const scrollTo = view.scrollTo;
    view.scrollTo = function (...args: any[]) {
        log.push({ t: at(), kind: 'scrollTo', value: r2(args[0]?.top ?? args[1] ?? NaN), behavior: args[0]?.behavior ?? null });
        return scrollTo.apply(this, args);
    };
    const onScroll = () => log.push(sample('scroll'));
    const onScrollEnd = () => log.push(sample('scrollend'));
    view.addEventListener('scroll', onScroll);
    view.addEventListener('scrollend', onScrollEnd);
    const roomChanges = room ? new win.MutationObserver(() => log.push({ t: at(), kind: 'room', value: room.style.cssText })) : null;
    roomChanges?.observe(room, { attributes: true, attributeFilter: ['style'] });
    const column = room?.parentElement;
    const columnChanges = column && column !== view
        ? new win.MutationObserver(() => log.push({ t: at(), kind: 'column', value: column.style.cssText }))
        : null;
    columnChanges?.observe(column, { attributes: true, attributeFilter: ['style'] });
    let running = true;
    const frame = () => {
        if (!running) return;
        log.push(sample('frame'));
        win.requestAnimationFrame(frame);
    };
    const clamp = (value: unknown, fallback: number, max: number) =>
        Math.min(Math.max(Number(value) || fallback, 0), max);
    const wheel = request.wheel;
    try {
        win.requestAnimationFrame(frame);
        const turning = wheel ? (async () => {
            await sleep(clamp(wheel.startDelayMs, 300, ms));
            const mode = wheel.mode === 0 ? 0 : 1;
            const delta = Number(wheel.delta) || (mode === 1 ? -3 : -100);
            const notches = clamp(wheel.notches, 3, 200);
            // `deltas`: one notch each, in turn; `over: 'rail'`: turned over the question rail.
            const deltas: number[] = Array.isArray(wheel.deltas) && wheel.deltas.length > 0
                ? wheel.deltas.slice(0, 200).map((value: unknown) => Number(value) || 0)
                : Array.from({ length: notches }, () => delta);
            const rail = wheel.over === 'rail' ? view.parentElement?.querySelector('.conversation-rail-marks') : null;
            if (wheel.over === 'rail' && !rail) log.push({ t: at(), kind: 'error', value: 'no question rail' });
            for (let i = 0; i < deltas.length && running && (rail || wheel.over !== 'rail'); i++) {
                const box = (rail ?? view).getBoundingClientRect();
                const x = rail ? box.left + box.width / 2 : box.left + box.width * 0.4;
                win.windowUtils.sendWheelEvent(x, box.top + box.height / 2,
                    0, deltas[i], 0, mode, 0, 0, mode === 1 ? deltas[i] : 0, 0);
                log.push({ t: at(), kind: 'wheel', value: deltas[i] });
                await sleep(clamp(wheel.gapMs, 120, 5000));
            }
        })() : null;
        await sleep(ms);
        running = false;
        await turning;
    } finally {
        running = false;
        delete view.scrollTop;
        delete view.scrollTo;
        view.removeEventListener('scroll', onScroll);
        view.removeEventListener('scrollend', onScrollEnd);
        roomChanges?.disconnect();
        columnChanges?.disconnect();
    }
    return log;
}

/**
 * Where the main window's panes sit, and what inside an AlphainZ pane is wider
 * than the pane: the evidence when the sidebar crowds the rest of Zotero out.
 * `minContent` is each pane root's narrowest possible width, measured by
 * laying it out once at `width: min-content` and restoring its style.
 */
async function handleTestLayoutProbeHttpRequest(_request: any) {
    const win: any = Zotero.getMainWindow();
    const doc = win?.document;
    if (!doc) return { ok: false, error: 'no main window' };
    const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), w: Math.round(r.width), y: Math.round(r.top), h: Math.round(r.height) };
    };
    const describe = (el: Element) => {
        const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.');
        const testid = el.getAttribute('data-testid');
        return `${el.localName}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}${testid ? `[${testid}]` : ''}`;
    };
    const ids = [
        'zotero-pane', 'zotero-collections-pane', 'zotero-items-pane-container', 'zotero-items-pane',
        'zotero-item-pane', 'tabs-deck', 'zotero-context-pane', 'zotero-context-pane-inner',
        'alphainz-pane-library', 'alphainz-pane-reader',
    ];
    const panes = Object.fromEntries(ids.map((id) => [id, box(doc.getElementById(id))]));
    const roots: any[] = [];
    for (const id of ['alphainz-pane-library', 'alphainz-pane-reader']) {
        const root = doc.getElementById(id) as HTMLElement | null;
        if (!root) continue;
        const width = root.getBoundingClientRect().width;
        const saved = root.style.getPropertyValue('width');
        const savedPriority = root.style.getPropertyPriority('width');
        root.style.setProperty('width', 'min-content', 'important');
        const minContent = Math.round(root.getBoundingClientRect().width);
        root.style.removeProperty('width');
        if (saved) root.style.setProperty('width', saved, savedPriority);
        const wide = width > 0
            ? (Array.from(root.querySelectorAll('*')) as HTMLElement[])
                .map((el) => ({ el, w: el.getBoundingClientRect().width, sw: el.scrollWidth, cw: el.clientWidth }))
                .filter((x) => x.w > width + 1 || x.sw > x.cw + 1)
                .sort((a, b) => b.w - a.w)
                .slice(0, 25)
                .map((x) => ({ el: describe(x.el), width: Math.round(x.w), scrollWidth: x.sw, clientWidth: x.cw }))
            : [];
        roots.push({ id, width: Math.round(width), minContent, minWidth: win.getComputedStyle(root).minWidth, wide });
    }
    return {
        ok: true,
        innerWidth: win.innerWidth,
        devicePixelRatio: win.devicePixelRatio,
        devPixelsPerPx: Services.prefs.getCharPref('layout.css.devPixelsPerPx', ''),
        zoteroFontSize: Zotero.Prefs.get('fontSize'),
        panes,
        roots,
    };
}

/**
 * Put the main window into a given shape to reproduce layout problems:
 * `width`/`height` resize the window (CSS px), `maximize` maximizes it, `fontSize` sets Zotero's own
 * font-size preference, `devPixelsPerPx` the global zoom, and `openReader`
 * opens that attachment id in a reader tab (`'library'` selects the library
 * tab). Each change is reported with the value it replaced, so a test can put
 * everything back.
 */
async function handleTestZoteroViewHttpRequest(request: any) {
    const win: any = Zotero.getMainWindow();
    if (!win) return { ok: false, error: 'no main window' };
    const before: Record<string, unknown> = {};
    if (typeof request?.devPixelsPerPx === 'string') {
        before.devPixelsPerPx = Services.prefs.getCharPref('layout.css.devPixelsPerPx', '');
        Services.prefs.setCharPref('layout.css.devPixelsPerPx', request.devPixelsPerPx);
    }
    if (typeof request?.fontSize === 'string') {
        before.fontSize = Zotero.Prefs.get('fontSize');
        Zotero.Prefs.set('fontSize', request.fontSize);
    }
    if (request?.maximize === true) {
        win.maximize();
    } else if (typeof request?.width === 'number' || typeof request?.height === 'number') {
        before.width = win.outerWidth;
        before.height = win.outerHeight;
        before.sizemode = win.windowState;
        if (win.windowState === win.STATE_MAXIMIZED) win.restore();
        win.resizeTo(request.width ?? win.outerWidth, request.height ?? win.outerHeight);
    }
    if (request?.openReader === 'library') {
        win.Zotero_Tabs?.select('zotero-pane');
    } else if (typeof request?.openReader === 'number') {
        await Zotero.Reader.open(request.openReader);
    } else if (request?.openReader === 'any-pdf') {
        const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
        const pdf = items.find((item: any) => item.isPDFAttachment?.());
        if (pdf) await Zotero.Reader.open(pdf.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { ok: true, before, now: { innerWidth: win.innerWidth, outerWidth: win.outerWidth, devicePixelRatio: win.devicePixelRatio } };
}

async function handleTestUiClickHttpRequest(request: any) {
    const selector = String(request?.selector ?? '');
    if (!selector) return { ok: false, error: 'selector is required' };
    const index = Number(request?.index ?? 0);
    const win: any = Zotero.getMainWindow();
    const doc = win?.document;
    const nodes = Array.from(doc?.querySelectorAll(selector) ?? []) as any[];
    const target = nodes[index];
    if (!target) return { ok: false, matched: nodes.length, error: 'no node at that index' };
    target.click();
    return {
        ok: true,
        matched: nodes.length,
        clicked: (target.textContent ?? '').trim().slice(0, 80),
    };
}

/** The window a UI probe works in: the main Zotero window, or AlphainZ's settings window. */
function probeWindow(which: unknown): any {
    return which === 'preferences' ? BeaverUIFactory.findPreferencesWindow() : Zotero.getMainWindow();
}

/** The text a part of the UI shows, as a reader sees it (default: the library sidebar). */
async function handleTestUiTextHttpRequest(request: any) {
    const win = probeWindow(request?.window);
    const doc = win?.document;
    if (!doc) return { ok: false, error: 'window not open' };
    const selector = String(request?.selector || (request?.window === 'preferences' ? 'body' : '#alphainz-pane-library'));
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) return { ok: false, error: `nothing matches ${selector}` };
    const text = String(el.innerText ?? el.textContent ?? '').replace(/\n{3,}/g, '\n\n');
    return { ok: true, text: text.slice(0, Number(request?.limit ?? 20000)) };
}

/** Click the control that shows `text` (or has it as its aria-label), the `index`th if several do. */
async function handleTestUiClickTextHttpRequest(request: any) {
    const want = String(request?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!want) return { ok: false, error: 'text is required' };
    const win = probeWindow(request?.window);
    const doc = win?.document;
    if (!doc) return { ok: false, error: 'window not open' };
    const scope = request?.selector ? doc.querySelector(String(request.selector)) : doc;
    if (!scope) return { ok: false, error: `nothing matches ${request.selector}` };
    const controls = Array.from(scope.querySelectorAll(
        'button, a, summary, label, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="option"]',
    )) as HTMLElement[];
    const shown = (el: HTMLElement) => String(el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const exact = controls.filter((el) => shown(el) === want || el.getAttribute('aria-label') === want);
    const matches = exact.length > 0 ? exact : controls.filter((el) => shown(el).includes(want));
    const target = matches[Number(request?.index ?? 0)];
    if (!target) return { ok: false, matched: matches.length, error: 'no control shows that text' };
    target.click();
    return { ok: true, matched: matches.length, clicked: shown(target).slice(0, 80) };
}

async function handleTestCaretProbeHttpRequest(request: any) {
    const win: any = Zotero.getMainWindow();
    const doc = win?.document;
    const found = findComposerForProbe(doc);
    if (!found) return { ok: false, error: 'composer not found — open the sidebar first' };
    const editor = found.el as HTMLElement;
    const engine = found.kind;

    const where: string = request?.where ?? 'header';
    const host = where === 'header'
        ? (doc.querySelector('#alphainz-header') as HTMLElement | null)
        : (doc.documentElement as HTMLElement);
    if (!host) return { ok: false, error: `no host for where="${where}"` };

    const caretOffset = (): number | null => {
        if (engine === 'textarea') {
            return typeof (editor as any).selectionStart === 'number'
                ? (editor as any).selectionStart
                : null;
        }
        const sel = win.getSelection?.();
        if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return null;
        const range = doc.createRange();
        range.selectNodeContents(editor);
        try { range.setEnd(sel.anchorNode, sel.anchorOffset); } catch { return null; }
        return range.toString().length;
    };

    editor.focus();

    /*
     * Type something first, if asked. `execCommand` goes through the same
     * `beforeinput` path a keystroke does, so Lexical builds real nodes and
     * the measurement is of the editor as it actually is mid-sentence, not of
     * a text node poked into the DOM behind its back.
     */
    if (engine !== 'textarea' && typeof request?.seed === 'string' && request.seed) {
        /*
         * `cycle: true` first types and clears, which is the state a follow-up
         * question starts from: the composer has been used, emptied on send,
         * and is being typed into again. Worth separating, because a bug that
         * only shows up on the second question is a bug in what the send left
         * behind.
         */
        if (request?.cycle === true) {
            doc.execCommand('insertText', false, request.seed);
            await Zotero.Promise.delay(120);
            doc.execCommand('selectAll');
            doc.execCommand('delete');
            await Zotero.Promise.delay(120);
        }
        doc.execCommand('insertText', false, request.seed);
        await Zotero.Promise.delay(120);
    }

    if (engine === 'textarea') {
        const ta = editor as any;
        const writeValue = async (next: string) => {
            // Drives the React controlled input directly (execCommand support
            // on text controls varies). Empty string allowed, for cleanup.
            const proto = win.HTMLTextAreaElement?.prototype;
            const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(ta, next);
            else ta.value = next;
            ta.dispatchEvent(new win.Event('input', { bubbles: true }));
            await Zotero.Promise.delay(120);
        };
        if (typeof request?.set === 'string') {
            await writeValue(request.set);
        }
        if (typeof request?.seed === 'string' && request.seed) {
            // Seed replaces whatever a previous probe left behind, so repeated
            // probes measure the same text — mirroring the Lexical branch,
            // where each probe starts from the seed alone.
            if (request?.cycle === true) {
                await writeValue(request.seed);
                await writeValue('');
            }
            await writeValue(request.seed);
        }
        if (typeof request?.caretAt === 'number') {
            ta.setSelectionRange(request.caretAt, request.caretAt);
        } else {
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        await Zotero.Promise.delay(60);
        const taText = String(ta.value ?? '');
        const taBefore = caretOffset();
        const taGhost = doc.createElement('span');
        host.appendChild(taGhost);
        const taAfterAdd = caretOffset();
        taGhost.remove();
        const taAfterRemove = caretOffset();
        await Zotero.Promise.delay(120);
        const taAfterSettle = caretOffset();
        return {
            ok: true,
            engine,
            where,
            textLength: taText.length,
            caret: { before: taBefore, afterAdd: taAfterAdd, afterRemove: taAfterRemove, afterSettle: taAfterSettle },
            moved: taBefore !== taAfterSettle,
            repaired: taBefore !== taAfterRemove && taBefore === taAfterSettle,
            note: taText.length === 0
                ? 'composer was empty — put some text in it first for a meaningful result'
                : undefined,
        };
    }

    /*
     * Park the caret. At the end by default, the way it sits after typing;
     * `caretAt` puts it mid-text instead, which is the case that separates a
     * repair that restores the position from one that merely jumps to the end.
     */
    const sel = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(editor);
    if (typeof request?.caretAt === 'number') {
        const walker = doc.createTreeWalker(editor, win.NodeFilter.SHOW_TEXT);
        let seen = 0;
        let placed = false;
        let node: any;
        while ((node = walker.nextNode())) {
            const len = node.nodeValue?.length ?? 0;
            if (seen + len >= request.caretAt) {
                range.setStart(node, request.caretAt - seen);
                placed = true;
                break;
            }
            seen += len;
        }
        if (!placed) range.collapse(false);
        else range.collapse(true);
    } else {
        range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    // Let Lexical adopt the parked selection as its model before disturbing it.
    await Zotero.Promise.delay(60);

    const text = editor.textContent ?? '';
    const before = caretOffset();

    // The mutation under test: a node appears and disappears, exactly as a
    // tooltip does when the pointer crosses a toolbar button.
    const ghost = doc.createElement('span');
    ghost.textContent = '';
    host.appendChild(ghost);
    const afterAdd = caretOffset();
    ghost.remove();
    const afterRemove = caretOffset();

    /*
     * The repair runs in the MutationObserver's microtask, so a synchronous
     * read here still sees the collapsed caret — the number that matters is
     * where the caret is by the time the next keystroke arrives.
     */
    await Zotero.Promise.delay(80);
    const afterSettle = caretOffset();

    return {
        ok: true,
        where,
        textLength: text.length,
        caret: { before, afterAdd, afterRemove, afterSettle },
        moved: before !== afterSettle,
        repaired: before !== afterRemove && before === afterSettle,
        note: text.length === 0
            ? 'composer was empty — put some text in it first for a meaningful result'
            : undefined,
    };
}


/**
 * The composer element for the caret probes, whichever engine renders it.
 * A textarea's caret is element-internal (selectionStart); the Lexical
 * contenteditable's caret is the document selection.
 */
function findComposerForProbe(doc: any): { el: any; kind: 'textarea' | 'lexical' } | null {
    const ta = doc?.querySelector('.alphainz-composer-textarea');
    if (ta) return { el: ta, kind: 'textarea' };
    const ce = doc?.querySelector('.alphainz-lexical-content');
    if (ce) return { el: ce, kind: 'lexical' };
    return null;
}

async function handleTestCaretWatchHttpRequest(request: any) {
    const action = request?.action ?? 'read';

    if (action === 'stop' || (action === 'start' && caretWatch)) {
        caretWatch?.stop();
        caretWatch = null;
        if (action === 'stop') return { ok: true, watching: false };
    }

    if (action === 'read') {
        return {
            ok: true,
            watching: !!caretWatch,
            count: caretWatch?.entries.length ?? 0,
            entries: caretWatch?.entries ?? [],
        };
    }

    if (action !== 'start') return { ok: false, error: 'action: start | read | stop' };

    const win: any = Zotero.getMainWindow();
    const doc = win?.document;
    const found = findComposerForProbe(doc);
    const editor = (found?.el ?? null) as HTMLElement | null;
    const pane = editor?.closest('.alphainz-root') as HTMLElement | null;
    if (!editor || !pane || !found) {
        return { ok: false, error: 'composer not found — open the sidebar first' };
    }
    const engine = found.kind;

    const entries: CaretWatchEntry[] = [];
    const LIMIT = 200;
    const t0 = win.performance?.now?.() ?? 0;
    const now = () => Math.round((win.performance?.now?.() ?? 0) - t0);

    /** Caret offset counted in text across the editor, or null when elsewhere. */
    const caretOffset = (): number | null => {
        if (engine === 'textarea') {
            return typeof (editor as any).selectionStart === 'number'
                ? (editor as any).selectionStart
                : null;
        }
        const sel = win.getSelection?.();
        if (!sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return null;
        const range = doc.createRange();
        range.selectNodeContents(editor);
        try {
            range.setEnd(sel.anchorNode, sel.anchorOffset);
        } catch {
            return null;
        }
        return range.toString().length;
    };

    const focused = () => doc.activeElement === editor;
    const push = (e: CaretWatchEntry) => {
        entries.push(e);
        if (entries.length > LIMIT) entries.shift();
    };

    const observer = new win.MutationObserver((records: any[]) => {
        // Recorded whether or not the editor holds focus, with the flag: an
        // IME can move focus around, and a mutation dismissed for "not
        // focused" is exactly the one worth seeing.
        const isFocused = focused();
        const after = caretOffset();
        for (const r of records) {
            if (r.type !== 'childList') continue;
            // The editor's own text edits are the expected case, not the bug.
            const inEditable = editor.contains(r.target) && r.target !== editor;
            if (inEditable) continue;
            push({
                t: now(),
                kind: 'mutation',
                target: describePath(r.target),
                added: Array.from(r.addedNodes).slice(0, 4).map(describeNode),
                removed: Array.from(r.removedNodes).slice(0, 4).map(describeNode),
                after,
                textLength: editor.textContent?.length ?? 0,
                focused: isFocused,
                inPane: pane.contains(r.target),
            });
        }
    });
    // The whole chrome document, not just the pane: the selection reset is
    // document-wide, so the clobbering mutation can come from Zotero's own
    // chrome (toolbar, tab bar, context pane) just as well as from ours.
    observer.observe(doc.documentElement, { childList: true, subtree: true });

    // Focus in/out of the editor, with where focus went — the guard stands
    // down while the editor is unfocused, so these mark the unprotected spans.
    const onFocusChange = (e: any) => {
        if (e.target !== editor && !editor.contains(e.target)) return;
        push({
            t: now(), kind: 'focus', event: e.type,
            after: caretOffset(), textLength: editor.textContent?.length ?? 0,
            focused: focused(),
            // focusin: the editor itself; focusout: wherever focus went.
            active: describePath(e.type === 'focusin' ? e.target : (e.relatedTarget ?? doc.activeElement)),
        });
    };
    doc.addEventListener('focusin', onFocusChange, true);
    doc.addEventListener('focusout', onFocusChange, true);

    /*
     * Composition events are recorded because the Windows story turns on
     * them: `WindowsImeCompositionOrderPlugin` defers composition end, so a
     * mutation can land after the user has finished a word while the editor
     * still reports itself as composing. Reading this buffer back, that shows
     * up as a mutation sitting between `compositionend` and the caret reset.
     */
    let lastOffset: number | null = null;
    const onSelectionChange = () => {
        const off = caretOffset();
        const len = editor.textContent?.length ?? 0;
        if (off === 0 && len > 0 && lastOffset !== 0) {
            push({
                t: now(), kind: 'caret-reset', before: lastOffset, after: 0,
                textLength: len, focused: focused(),
                active: describePath(doc.activeElement),
            });
        }
        lastOffset = off;
    };
    doc.addEventListener('selectionchange', onSelectionChange);

    const onComposition = (e: any) => {
        push({
            t: now(), kind: 'composition', event: e.type,
            after: caretOffset(), textLength: editor.textContent?.length ?? 0,
            focused: focused(),
        });
    };
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
        editor.addEventListener(type, onComposition, true);
    }

    caretWatch = {
        entries,
        stop: () => {
            observer.disconnect();
            doc.removeEventListener('selectionchange', onSelectionChange);
            doc.removeEventListener('focusin', onFocusChange, true);
            doc.removeEventListener('focusout', onFocusChange, true);
            for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
                editor.removeEventListener(type, onComposition, true);
            }
        },
    };
    return { ok: true, watching: true, note: 'type in the composer until the caret jumps, then action:"read"' };
}

// Open or close the settings window (dev-only), so a live test can look at it.
async function handleTestPreferencesWindowHttpRequest(request: any) {
    const open = request?.open !== false;
    if (open) {
        BeaverUIFactory.openPreferencesWindow(request?.tab || undefined);
    } else {
        BeaverUIFactory.closePreferencesWindow();
    }
    const win = BeaverUIFactory.findPreferencesWindow();
    return { ok: true, open: !!win && !win.closed };
}

async function handleTestProviderConnectHttpRequest(request: any) {
    await providerConnection.connect({
        wakeId: request?.wake_id,
        wakeInstanceId: request?.wake_instance_id,
    });
    return { ok: true, status: providerConnection.getStatus() };
}

async function handleTestProviderStatusHttpRequest(_request: any) {
    return providerConnection.getStatus();
}

async function handleTestProviderCloseHttpRequest(_request: any) {
    providerConnection.close();
    return { ok: true, status: providerConnection.getStatus() };
}


// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register the local HTTP surface.
 *
 * Callers must gate this on the build: `useHttpEndpoints` registers only in
 * development and staging builds, so NONE of the paths below — not just the
 * `/alphainz/test/*` block near the end — reach a released build. The nested
 * `NODE_ENV === 'development'` check further restricts the test-only endpoints
 * to development, keeping them out of staging.
 */
function registerEndpoints(): boolean {
    if (!Zotero?.Server?.Endpoints) {
        logger('useHttpEndpoints: Zotero.Server.Endpoints not available', 2);
        return false;
    }

    Zotero.Server.Endpoints['/alphainz/zotero-data'] =
        createEndpoint(handleZoteroDataHttpRequest);
    
    Zotero.Server.Endpoints['/alphainz/external-reference-check'] = 
        createEndpoint(handleExternalReferenceCheckHttpRequest);
    
    Zotero.Server.Endpoints['/alphainz/search/metadata'] = 
        createEndpoint(handleMetadataSearchHttpRequest);
    
    Zotero.Server.Endpoints['/alphainz/search/topic'] =
        createEndpoint(handleTopicSearchHttpRequest);

    Zotero.Server.Endpoints['/alphainz/search/quick'] =
        createEndpoint(handleQuickSearchHttpRequest);

    Zotero.Server.Endpoints['/alphainz/attachment/document'] =
        createEndpoint(handleAttachmentDocumentHttpRequest);
    
    Zotero.Server.Endpoints['/alphainz/attachment/page-images'] = 
        createEndpoint(handleAttachmentPageImagesHttpRequest);
    
    Zotero.Server.Endpoints['/alphainz/attachment/search'] = 
        createEndpoint(handleAttachmentSearchHttpRequest);
    
    // Library management endpoints
    Zotero.Server.Endpoints['/alphainz/library/search'] = 
        createEndpoint(handleLibrarySearchHttpRequest);
    
    Zotero.Server.Endpoints['/alphainz/library/list'] = 
        createEndpoint(handleLibraryListHttpRequest);
    
    Zotero.Server.Endpoints['/alphainz/library/resolve-population'] =
        createEndpoint(handleResolvePopulationHttpRequest);

    Zotero.Server.Endpoints['/alphainz/library/metadata'] =
        createEndpoint(handleLibraryMetadataHttpRequest);

    Zotero.Server.Endpoints['/alphainz/library/find-annotations'] =
        createEndpoint(handleFindAnnotationsHttpRequest);

    Zotero.Server.Endpoints['/alphainz/library/libraries'] =
        createEndpoint(handleListLibrariesHttpRequest);

    Zotero.Server.Endpoints['/alphainz/library/collections'] =
        createEndpoint(handleListCollectionsHttpRequest);

    Zotero.Server.Endpoints['/alphainz/library/tags'] =
        createEndpoint(handleListTagsHttpRequest);

    // Deferred tool endpoints
    Zotero.Server.Endpoints['/alphainz/agent-action/validate'] =
        createEndpoint(handleAgentActionValidateHttpRequest);

    Zotero.Server.Endpoints['/alphainz/agent-action/execute'] =
        createEndpoint(handleAgentActionExecuteHttpRequest);

    // Utility endpoints
    Zotero.Server.Endpoints['/alphainz/user-info'] =
        createEndpoint(handleUserInfoHttpRequest);

    Zotero.Server.Endpoints['/alphainz/delete-items'] =
        createEndpoint(handleDeleteItemsHttpRequest);

    // Note endpoints
    Zotero.Server.Endpoints['/alphainz/note/read'] =
        createEndpoint(handleReadNoteHttpRequest);

    // Test-only endpoints (dev builds only)
    if (process.env.NODE_ENV === 'development') {
        Zotero.Server.Endpoints['/alphainz/test/ping'] =
            createEndpoint(handleTestPingHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/cache-metadata'] =
            createEndpoint(handleTestCacheMetadataHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/cache-payload'] =
            createEndpoint(handleTestCachePayloadHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/cache-invalidate'] =
            createEndpoint(handleTestCacheInvalidateHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/cache-seed-page-labels'] =
            createEndpoint(handleTestCacheSeedPageLabelsHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/cache-clear-all'] =
            createEndpoint(handleTestCacheClearAllHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/read-attachment'] =
            createEndpoint(handleTestReadAttachmentHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/mcp-read-note'] =
            createEndpoint(handleTestMcpReadNoteHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/mcp-create-note'] =
            createEndpoint(handleTestMcpCreateNoteHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/resolve-item'] =
            createEndpoint(handleTestResolveItemHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/resolve-readable'] =
            createEndpoint(handleTestResolveReadableHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/best-epub-attachment'] =
            createEndpoint(handleTestBestEpubAttachmentHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/validate-item'] =
            createEndpoint(handleTestValidateItemHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/validate-regular-item'] =
            createEndpoint(handleTestValidateRegularItemHttpRequest);

        // External-file attach/delete/view-images (dev-only; seeds the registry for live tests)
        Zotero.Server.Endpoints['/alphainz/test/external-file-attach'] =
            createEndpoint(handleTestExternalFileAttachHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/external-file-delete'] =
            createEndpoint(handleTestExternalFileDeleteHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/external-file-view-images'] =
            createEndpoint(handleTestExternalFileViewImagesHttpRequest);

        // Serialized PDF document-request wire path (dev-only): exercises the
        // websocket response mode, PreparedJsonMessage splice, and
        // guardSerializedPayloadSize that the object-mode endpoint skips.
        Zotero.Server.Endpoints['/alphainz/test/document-serialized'] =
            createEndpoint(handleTestDocumentSerializedHttpRequest);

        // MuPDF worker singleton stats / lifecycle (dev-only)
        Zotero.Server.Endpoints['/alphainz/test/worker-stats'] =
            createEndpoint(handleTestWorkerStatsHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/worker-mark-stale'] =
            createEndpoint(handleTestWorkerMarkStaleHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/worker-cache-clear'] =
            createEndpoint(handleTestWorkerCacheClearHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/worker-wedge-probe'] =
            createEndpoint(handleTestWorkerWedgeProbeHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/worker-idle-probe'] =
            createEndpoint(handleTestWorkerIdleProbeHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/worker-realm-probe'] =
            createEndpoint(handleTestWorkerRealmProbeHttpRequest);

        // File-status side-effect trigger (dev-only)
        Zotero.Server.Endpoints['/alphainz/test/file-status'] =
            createEndpoint(handleTestFileStatusHttpRequest);

        // Note-specific test endpoints (seeding/teardown/inspection/undo)
        Zotero.Server.Endpoints['/alphainz/test/note-create'] =
            createEndpoint(handleTestNoteCreateHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/note-delete'] =
            createEndpoint(handleTestNoteDeleteHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/note-read'] =
            createEndpoint(handleTestNoteReadHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/note-open-editor'] =
            createEndpoint(handleTestNoteOpenEditorHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/note-close-editor'] =
            createEndpoint(handleTestNoteCloseEditorHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/note-undo'] =
            createEndpoint(handleTestNoteUndoHttpRequest);

        // Collection seeding/teardown (dev-only)
        Zotero.Server.Endpoints['/alphainz/test/collection-create'] =
            createEndpoint(handleTestCollectionCreateHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/collection-delete'] =
            createEndpoint(handleTestCollectionDeleteHttpRequest);

        // Headless PDF annotation primitives (dev-only)
        Zotero.Server.Endpoints['/alphainz/test/annotation-trash'] =
            createEndpoint(handleTestAnnotationTrashHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/annotation-create'] =
            createEndpoint(handleTestAnnotationCreateHttpRequest);

        // MuPDF worker plumbing (dev-only)
        Zotero.Server.Endpoints['/alphainz/test/pdf-page-count'] =
            createEndpoint(handleTestPdfPageCountHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-page-labels'] =
            createEndpoint(handleTestPdfPageLabelsHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-render-pages'] =
            createEndpoint(handleTestPdfRenderPagesHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-render-pages-with-meta'] =
            createEndpoint(handleTestPdfRenderPagesWithMetaHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-extract-raw-detailed'] =
            createEndpoint(handleTestPdfExtractRawDetailedHttpRequest);

        // orchestration parity endpoints
        Zotero.Server.Endpoints['/alphainz/test/pdf-extract'] =
            createEndpoint(handleTestPdfExtractHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-extract-paragraph'] =
            createEndpoint(handleTestPdfExtractParagraphHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-has-text-layer'] =
            createEndpoint(handleTestPdfHasTextLayerHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-analyze-ocr'] =
            createEndpoint(handleTestPdfAnalyzeOcrHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-search-scored'] =
            createEndpoint(handleTestPdfSearchScoredHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/pdf-sentence-bboxes'] =
            createEndpoint(handleTestPdfSentenceBBoxesHttpRequest);

        // Bbox overlay endpoint — paints columns/lines/items/paragraphs/sentences/
        // margins on a rendered page PNG for headless agent debugging.
        Zotero.Server.Endpoints['/alphainz/test/pdf-render-overlay'] =
            createEndpoint(handleTestPdfRenderOverlayHttpRequest);

        // Per-page extract trace — emits every stage of the extraction
        // pipeline as JSON with cross-stage IDs, so an agent can trace
        // one piece of text from raw line through items to sentences.
        Zotero.Server.Endpoints['/alphainz/test/pdf-extract-trace'] =
            createEndpoint(handleTestPdfExtractTraceHttpRequest);

        // Full analysis context (style profile + margin analysis + margin
        // removal) computed by the same prefix `extract({ mode:
        // "structured" })` runs before per-page processing. Backs the
        // `level: "margins"` overlay and is also exposed standalone for
        // debugging.
        Zotero.Server.Endpoints['/alphainz/test/pdf-analyze-layout'] =
            createEndpoint(handleTestPdfAnalyzeLayoutHttpRequest);

        // EPUB extraction over a raw file path / attachment (corpus triage)
        Zotero.Server.Endpoints['/alphainz/test/epub-extract'] =
            createEndpoint(handleTestEpubExtractHttpRequest);

        // Snapshot extraction over a raw HTML file path / attachment
        Zotero.Server.Endpoints['/alphainz/test/snapshot-extract'] =
            createEndpoint(handleTestSnapshotExtractHttpRequest);

        // Generated HTML report stored as a snapshot attachment
        Zotero.Server.Endpoints['/alphainz/test/create-report'] =
            createEndpoint(handleTestCreateReportHttpRequest);

        // EPUB annotation CFI/sortIndex parity: headless resolver vs the reader's
        // own getAnnotationFromRange for the same target.
        Zotero.Server.Endpoints['/alphainz/test/epub-annotation-parity'] =
            createEndpoint(handleTestEpubAnnotationParityHttpRequest);

        // Snapshot annotation selector/sortIndex parity.
        Zotero.Server.Endpoints['/alphainz/test/snapshot-annotation-parity'] =
            createEndpoint(handleTestSnapshotAnnotationParityHttpRequest);

        // Reader position (`getCurrentPage` / `content_kind`) and the EPUB
        // citation-navigation path against the live reader.
        Zotero.Server.Endpoints['/alphainz/test/reader-state'] =
            createEndpoint(handleTestReaderStateHttpRequest);

        // Both answers to "is text selected", so the two can be seen to disagree.
        Zotero.Server.Endpoints['/alphainz/test/reader-selection-probe'] =
            createEndpoint(handleTestReaderSelectionProbeHttpRequest);

        // Drive the library item context menu open/closed, to catch the cycle
        // that leaves it refusing to reopen.
        Zotero.Server.Endpoints['/alphainz/test/item-menu-probe'] =
            createEndpoint(handleTestItemMenuProbeHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/epub-citation-navigate'] =
            createEndpoint(handleTestEpubCitationNavigateHttpRequest);

        // Citation host: itemData.resolveItemDisplay (icon item type +
        // readable-attachment availability for cited-source rows).
        Zotero.Server.Endpoints['/alphainz/test/resolve-item-display'] =
            createEndpoint(handleTestResolveItemDisplayHttpRequest);

        // Background queue (dev-only)
        Zotero.Server.Endpoints['/alphainz/test/background-enqueue'] =
            createEndpoint(handleTestBackgroundEnqueueHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/background-stats'] =
            createEndpoint(handleTestBackgroundStatsHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/background-peek'] =
            createEndpoint(handleTestBackgroundPeekHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/background-process-once'] =
            createEndpoint(handleTestBackgroundProcessOnceHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/background-clear'] =
            createEndpoint(handleTestBackgroundClearHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/compact-now'] =
            createEndpoint(handleTestCompactNowHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/thread-compaction'] =
            createEndpoint(handleTestThreadCompactionHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/purge-remote'] =
            createEndpoint(handleTestPurgeRemoteHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/conversation-sync-now'] =
            createEndpoint(handleTestConversationSyncNowHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/ui-click'] =
            createEndpoint(handleTestUiClickHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/ui-click-text'] =
            createEndpoint(handleTestUiClickTextHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/ui-text'] =
            createEndpoint(handleTestUiTextHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/layout-probe'] =
            createEndpoint(handleTestLayoutProbeHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/reading-probe'] =
            createEndpoint(handleTestReadingProbeHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/zotero-view'] =
            createEndpoint(handleTestZoteroViewHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/caret-probe'] =
            createEndpoint(handleTestCaretProbeHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/caret-watch'] =
            createEndpoint(handleTestCaretWatchHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/preferences-window'] =
            createEndpoint(handleTestPreferencesWindowHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/appearance-probe'] =
            createEndpoint(handleTestAppearanceProbeHttpRequest);

        // Pref control (dev-only)
        Zotero.Server.Endpoints['/alphainz/test/set-pref'] =
            createEndpoint(handleTestSetPrefHttpRequest);

        // Sync-suppression control/inspection (dev-only): drives the real
        // syncPause module + raw Sync.Runner contract for live tests.
        Zotero.Server.Endpoints['/alphainz/test/sync-pause'] =
            createEndpoint(handleTestSyncPauseHttpRequest);

        // Reader sidebar-width wrapper lifecycle (dev-only): drives the real
        // UIManager install/unwrap/restore path against Zotero.Reader.
        Zotero.Server.Endpoints['/alphainz/test/sidebar-width-handler'] =
            createEndpoint(handleTestSidebarWidthHandlerHttpRequest);

        // Provider-mode connection control (dev-only manual trigger/inspection)
        Zotero.Server.Endpoints['/alphainz/test/provider-connect'] =
            createEndpoint(handleTestProviderConnectHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/provider-status'] =
            createEndpoint(handleTestProviderStatusHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/provider-close'] =
            createEndpoint(handleTestProviderCloseHttpRequest);

        // Library-exclusion control/inspection (dev-only): drives the in-memory
        // excluded-libraries set that gates every read/write path.
        Zotero.Server.Endpoints['/alphainz/test/excluded-libraries'] =
            createEndpoint(handleTestExcludedLibrariesHttpRequest);

        // Exclusion-gated handlers that have no production HTTP route.
        Zotero.Server.Endpoints['/alphainz/test/get-annotations'] =
            createEndpoint(handleTestGetAnnotationsHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/view-images'] =
            createEndpoint(handleTestViewImagesHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/attachment-image'] =
            createEndpoint(handleTestAttachmentImageHttpRequest);

        // Device-portable library-identity resolvers (dev-only): thin wrappers
        // over libraryRefForLibraryID / parseLibraryRef / resolveLibraryRef /
        // resolveItemReference so live tests can assert them against real
        // personal + group libraries.
        Zotero.Server.Endpoints['/alphainz/test/library-identity'] =
            createEndpoint(handleTestLibraryIdentityHttpRequest);
        // Headless chat/run lifecycle (dev-only): trigger the real send/approval/
        // undo path over HTTP by writing the same Jotai action atoms the UI writes,
        // so an automated agent can drive full agent runs without poking the
        // Lexical editor (which can't be reliably driven by synthetic events).
        Zotero.Server.Endpoints['/alphainz/test/new-thread'] =
            createEndpoint(handleTestNewThreadHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/import-pdf'] =
            createEndpoint(handleTestImportPdfHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/remove-tagged'] =
            createEndpoint(handleTestRemoveTaggedHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/erase-trashed'] =
            createEndpoint(handleTestEraseTrashedHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/answer-question'] =
            createEndpoint(handleTestAnswerQuestionHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/chat-send'] =
            createEndpoint(handleTestChatSendHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/dump-runs'] =
            createEndpoint(handleTestDumpRunsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/current-ids'] =
            createEndpoint(handleTestCurrentIdsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/load-thread'] =
            createEndpoint(handleTestLoadThreadHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/delete-threads'] =
            createEndpoint(handleTestDeleteThreadsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/retry-run'] =
            createEndpoint(handleTestRetryRunHttpRequest);
        // Drive the history list and the archive, which are otherwise
        // reachable only by clicking.
        Zotero.Server.Endpoints['/alphainz/test/thread-list'] =
            createEndpoint(handleTestThreadListHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/list-threads'] =
            createEndpoint(handleTestListThreadsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/list-actions'] =
            createEndpoint(handleTestListActionsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/approve-action'] =
            createEndpoint(handleTestApproveActionHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/confirm-credits'] =
            createEndpoint(handleTestConfirmCreditsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/undo-action'] =
            createEndpoint(handleTestUndoActionHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/application-state'] =
            createEndpoint(handleTestApplicationStateHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/alphainz-window'] =
            createEndpoint(handleTestBeaverWindowHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/alphainz-sidebar'] =
            createEndpoint(handleTestBeaverSidebarHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/select-items'] =
            createEndpoint(handleTestSelectItemsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/select-tab'] =
            createEndpoint(handleTestSelectTabHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/reindex'] =
            createEndpoint(handleTestReindexHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/index-state'] =
            createEndpoint(handleTestIndexStateHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/index-models'] =
            createEndpoint(handleTestIndexModelsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/vision-probe'] =
            createEndpoint(handleTestVisionProbeHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/list-models'] =
            createEndpoint(handleTestListModelsHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/semantic-search'] =
            createEndpoint(handleTestSemanticSearchHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/index-page-images'] =
            createEndpoint(handleTestIndexPageImagesHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/page-image-status'] =
            createEndpoint(handleTestPageImageStatusHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/figure-search'] =
            createEndpoint(handleTestFigureSearchHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/pane-state'] =
            createEndpoint(handleTestPaneStateHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/figure-panel'] =
            createEndpoint(handleTestFigurePanelHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/index-fulltext'] =
            createEndpoint(handleTestIndexFulltextHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/fulltext-stats'] =
            createEndpoint(handleTestFulltextStatsHttpRequest);

        Zotero.Server.Endpoints['/alphainz/test/selection-chat'] =
            createEndpoint(handleTestSelectionChatHttpRequest);
        Zotero.Server.Endpoints['/alphainz/test/reopen-anchor'] =
            createEndpoint(handleTestReopenAnchorHttpRequest);
    }

    logger(`useHttpEndpoints: Registered ${ENDPOINT_PATHS.length} HTTP endpoints`, 3);
    return true;
}

function unregisterEndpoints(): void {
    if (!Zotero?.Server?.Endpoints) {
        return;
    }
    
    for (const path of ENDPOINT_PATHS) {
        if (Zotero.Server.Endpoints[path]) {
            delete Zotero.Server.Endpoints[path];
        }
    }
    
    logger('useHttpEndpoints: Unregistered HTTP endpoints', 3);
}


// =============================================================================
// Hook
// =============================================================================

/**
 * Hook that registers HTTP endpoints and unregisters on unmount.
 *
 * The endpoints are accessible at http://localhost:23119/beaver/...
 * They expose the same handlers the agent loop dispatches to, which makes them
 * the way to exercise a tool end-to-end against a real library without a model
 * in the loop.
 *
 * Upstream gated this on the Supabase session, because every tool round-trip
 * went through its cloud. AlphainZ runs the loop locally, so there is no
 * session to wait for — the build gate below is the only one that remains.
 */
export function useHttpEndpoints() {
    useEffect(() => {
        // Development and staging only: these paths are unauthenticated and
        // bound to localhost, so they must not reach a released build.
        if (process.env.NODE_ENV !== 'development' && process.env.BUILD_ENV !== 'staging') {
            logger('useHttpEndpoints: Not registering endpoints in production', 3);
            return;
        }

        logger('useHttpEndpoints: Registering endpoints', 3);
        const registered = registerEndpoints();

        return () => {
            if (registered) {
                logger('useHttpEndpoints: Cleaning up endpoints', 3);
                unregisterEndpoints();
            }
        };
    }, []);
}
