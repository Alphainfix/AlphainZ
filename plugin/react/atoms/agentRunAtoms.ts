/**
 * WebSocket-based message generation atoms
 * 
 * This module provides Jotai atoms for WebSocket-based chat completion,
 * using AgentRun for structured run management.
 */

import { atom, Getter, Setter } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { connectWithRetry } from '@beaver/agent-core/transport/connectWithRetry';
import { notifyBatchApproval, notifyCreditConfirmation, notifyRunComplete, notifyUserQuestion } from '../../src/services/systemNotifications';
import { resolveAllLocalQuestions, resolveLocalQuestion } from '../utils/localQuestions';

/*
 * Release any locally-suspended question whenever the cards are cleared.
 *
 * Registered once, at module scope, rather than at each of the nine places
 * that clear them — see `setPendingQuestionsReleaseHook`.
 */
setPendingQuestionsReleaseHook((reason) => { resolveAllLocalQuestions(reason); });
import { reportConnectionFailure } from '@beaver/agent-core/transport/clients/diagnosticsService';
import {
    ConnectionFailureEvidence,
    presentConnectionFailure,
} from '@beaver/agent-core/transport/connectionFailure';
import {
    WSCallbacks,
    AgentRunRequest,
    WSReadyData,
    WSRequestAckData,
    WSPartEvent,
    WSToolReturnEvent,
    WSRunCompleteEvent,
    WSRunCitationsEvent,
    WSErrorEvent,
    WSWarningEvent,
    WSRetryEvent,
    WSAgentActionsEvent,
    WSToolCallProgressEvent,
    WSToolCallArgsStreamEvent,
    WSMissingZoteroDataEvent,
    WSDeferredApprovalRequest,
    WSDeferredApprovalStale,
    WSAskUserQuestionRequest,
    WSBatchApprovalRequest,
    WSBatchApprovalStale,
    WSCreditConfirmationRequest,
    WSCreditConfirmationStale,
    AskUserQuestionAnswer,
    BatchApprovalMode,
    WSStreamingDoneEvent,
    WSThreadNameEvent,
    ChargingPermissions,
} from '@beaver/agent-core/protocol/agentProtocol';
import { threadService } from '@beaver/agent-core/transport/threadService';
import { logger } from '@beaver/agent-core/platform/logger';
import { getConversationBackend } from '../../src/services/conversationSync';
import { buildAgentFromPrefs, isLocalBrain } from '../../src/services/llm/agentConfig';
/*
 * Imported statically, not with `await import`.
 *
 * A module reached only through a dynamic import gets its own webpack chunk,
 * and loading one here means appending a script to `document.head` — which is
 * null in this context. The failure was silent and total: every title fell
 * back to the opening line. The other dynamic imports nearby work only because
 * something else in this bundle already pulls those modules in statically.
 */
import { generateThreadTitle } from '@beaver/agent-llm/threadTitle';
import { selectedModelAtom, ModelConfig } from './models';
import { getPref } from '../../src/utils/prefs';
import { executeLocalRequest } from './executeLocalRun';
import { LOCAL_USER_ID } from './auth';
import { maybeCompactThread } from './threadCompaction';
import { clearPendingAnchor, drainPendingAnchor } from '../utils/selectionAnchors';
import { resolveLocalApproval, resolveLocalApprovalsForToolCalls } from '../utils/localApprovals';
import {
    STORED_AGENT_ACTIONS_FIELD,
    agentActionsSignature,
    differsFromStoredAgentActions,
    forgetStoredRun,
    includesUnstoredAgentActions,
    noteStoredAgentActions,
    noteStoredRunThread,
    setLocalRunStorageHooks,
    storedRunThread,
} from './loadLocalThreadRuns';
import { getHost } from '@beaver/agent-ui/host';
import {
    finalAnswerText,
    formatCommentEntry,
    saveCommentToAnnotation,
} from '../utils/selectionChatComment';
import { createElement } from 'react';

import SelectionCommentOfferContent from '../components/ui/popup/SelectionCommentOfferContent';
import { navigateToAnnotation } from '../utils/readerUtils';
import { evidenceKey, resolveCitationsInText, type CitationEvidence } from '../utils/localCitations';
import { isLocalApprovalWaiting } from '../utils/localApprovals';
import {
    attachHighlightCitations,
    attachPageCitations,
    takeProposedHighlights,
    takeReadAttachments,
    withRewrittenAnswer,
    stripStrayLocators,
    promoteBareReferences,
    promoteBareSentenceLocators,
    takeShownLocators,
    takeShownText,
    passageForLocator,
    clipPassage,
    validateComposedLocators,
} from '../utils/highlightCitations';
import {
    externalReferenceMappingAtom,
    formatExternalCitation,
} from '@beaver/agent-core/citations/externalReferences';
import { extractAuthorLastName } from '@beaver/agent-core/types/externalReferences';
import { saveInterruptedThread } from '../../src/utils/interruptedThreadPrefs';
import { MessageAttachment, SourceAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import type { ZoteroCollection } from '@beaver/agent-core/types/zotero';
import { toMessageAttachment } from '../types/attachments/converters';
import { safeStub, serializeAttachmentStub, serializeCollection, serializeItemStub, serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import { SubscriptionStatus, ProcessingMode } from '@beaver/agent-core/types/profile';
import { isDatabaseSyncSupportedAtom, profileSyncStatusAtom, searchableLibraryIdsAtom, syncWithZoteroAtom, isLibraryAccessReadyAtom } from './profile';
import { addPopupMessageAtom, removePopupMessageAtom } from '../utils/popupMessageUtils';
import {
    currentMessageItemsAtom,
    currentMessageCollectionsAtom,
    currentMessageExternalFilesAtom,
    currentReaderAttachmentAtom,
    readerAnnotationsAtom,
    currentMessageFiltersAtom,
    clearComposerAtom,
    currentMessageContentAtom,
    composerDraftMarkAtom,
    composerItemKey,
    stagedReaderPromptAtom,
} from './messageComposition';
import { isWebSearchEnabledAtom, removePopupMessagesByTypeAtom, isWebSearchAllowedAtom } from './ui';
import { currentNoteItemAtom } from './zoteroContext';
import { isAnnotationAttachment, messageAttachmentKey, zoteroReferenceLookupKeys } from '@beaver/agent-core/types/attachments/apiTypes';
import type { ExternalFileAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { getApplicationStateProvider } from './applicationState';
import { uint8ArrayToBase64 } from '../utils/fileUtils';
import { isAttachmentOnServer } from '../../src/utils/webAPI';
import { AgentRun, BeaverAgentPrompt, MessageSearchFilters, PromptAction, PromptOrigin, ResumeTrigger, ToolRequest, isRunActive, isSelectionChatOrigin } from '@beaver/agent-core/agents/types';
import {
    threadRunsAtom,
    activeRunAtom,
    currentThreadIdAtom,
    isLoadingThreadAtom,
    updateRunWithPart,
    updateRunWithToolReturn,
    updateRunComplete,
    updateRunWithToolCallProgress,
    updateRunWithToolCallArgsStream,
    allUserAttachmentKeysAtom,
    resetRunMessages,
    wsReconnectingAtom,
    wsRetryAtom,
} from '@beaver/agent-core/run-state/atoms';
import {
    createStreamActivityTracker,
    streamQuietAtom,
} from '@beaver/agent-core/run-state/streamActivity';
import { userIdAtom } from './auth';
import { citationsAtom, processCitationsAtom, resetCitationMarkersAtom, mergePageLabelsByAttachmentIdAtom } from '@beaver/agent-core/citations/atoms';
import { maybeShowCitationTipAtom } from './citationTip';
import type { Citation } from '@beaver/agent-core/types/citations';
import { preloadPageLabelsForCitations } from '../utils/pageLabels';
import { sanitizeMessageFiltersForSearchableLibraries } from '../utils/messageFilters';
import {
    addAgentActionsAtom,
    upsertAgentActionsAtom,
    toAgentAction,
    clearAgentActionsAtom,
    threadAgentActionsAtom,
    isAnnotationAgentAction,
    isEditAnnotationsAgentAction,
    isEditMetadataAgentAction,
    isZoteroNoteAgentAction,
    isCreateItemAgentAction,
    isCreateCollectionAgentAction,
    isOrganizeItemsAgentAction,
    isManageTagsAgentAction,
    isManageCollectionsAgentAction,
    isEditNoteAgentAction,
    isEditNoteBatchAgentAction,
    isAnyEditNoteAgentAction,
    isCreateNoteAgentAction,
    hasAppliedZoteroItem,
    hasAppliedBulkAnnotations,
    isCreateAnnotationsAgentAction,
    undoAgentActionAtom,
    AgentAction,
    addPendingApprovalAtom,
    removePendingApprovalAtom,
    removePendingApprovalsAtom,
    pendingApprovalsAtom,
    clearAllPendingApprovalsAtom,
} from '../agents/agentActions';
import {
    addPendingQuestionAtom,
    removePendingQuestionAtom,
    clearAllPendingQuestionsAtom,
    setPendingQuestionsReleaseHook,
} from '@beaver/agent-core/run-state/pendingQuestions';
import {
    addPendingCreditConfirmationAtom,
    removePendingCreditConfirmationAtom,
    clearAllPendingCreditConfirmationsAtom,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    addPendingBatchApprovalAtom,
    pendingBatchApprovalsAtom,
    removePendingBatchApprovalAtom,
    clearAllPendingBatchApprovalsAtom,
} from '@beaver/agent-core/run-state/pendingBatchApprovals';
import { readCreditThreshold } from '../utils/creditThreshold';
import { getAppliedPdfAnnotationCount } from '../agents/agentActionCounts';
import { undoEditMetadataAction } from '../utils/editMetadataActions';
import { undoCreateItemAction } from '../utils/createItemActions';
import { undoCreateCollectionAction } from '../utils/createCollectionActions';
import { undoOrganizeItemsAction } from '../utils/organizeItemsActions';
import { undoManageTagsAction } from '../utils/manageTagsActions';
import { undoManageCollectionsAction } from '../utils/manageCollectionsActions';
import { undoEditNoteAction, undoEditNoteBatchAction } from '../utils/editNoteActions';
import { undoCreateNoteAction } from '../utils/createNoteActions';
import { undoCreateAnnotationsAction } from '../utils/createAnnotationsActions';
import { undoEditAnnotationsAction } from '../utils/editAnnotationsActions';
import { processToolReturnResults } from '../agents/toolResultProcessing';
import { upgradeToolReturn } from '../compat/legacyToolResults';
import { isToolResultView } from '@beaver/agent-core/run-state/toolResultViews';
import { addWarningAtom, clearWarningsAtom } from './warnings';
import { backendHighTokenUsageRunsAtom, recordAppliedActionsAtom } from './messageUIState';
import { currentThreadNameAtom, loadThreadAtom, threadsChangedAtom } from './threads';
import { loadItemDataForAgentActions, autoApplyAnnotationAgentActions, autoCreateNoteAgentActions } from '../utils/agentActionUtils';
import { extractZoteroReferencesFromToolCall } from '@beaver/agent-core/run-state/toolLabels';
import {
    clearRunApprovalPolicyAtom,
    getPendingApprovalIdsForToolGroup,
    getToolGroup,
    grantToolGroupForRunAtom,
    isActionApprovedForCurrentRun,
    runApprovalPolicyAtom,
} from './runApprovalPolicy';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';
import { store } from '../store';
import { triggerProfileRefresh } from '../hooks/useProfileSync';
import { agentItemFilterAsync, isAgentSupportedItem } from '../../src/utils/agentItemSupport';
import { safeIsInTrash } from '../../src/utils/zoteroUtils';
import { wasItemAddedBeforeLastSync } from '../utils/sourceUtils';
import { libraryRefForLibraryID, resolveItemReference, resolveLibraryRef } from '../../src/utils/libraryIdentity';
import { ZoteroItemReference, collectionReferenceKey } from '@beaver/agent-core/types/zotero';
import { createZoteroItemReference } from '../utils/zoteroReferences';
import { markExternalReferenceImportedAtom } from './externalReferences';
import type { CreateItemProposedData, CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import { appendRunIfMissing, findResumeChainRoot, findRunForResume, hasOnlyThinkingParts, isInterruptedRun, lingeringCompletedRun, resolveErrorRunId, toRunError } from '@beaver/agent-core/run-state/runResumeHelpers';
import { prewarmMuPDFWorker } from '../../src/beaver-extract';
import { BeaverTemporaryAnnotations } from '../utils/annotationUtils';
import { isRejectedItemValidation, itemValidationResultsAtom } from './itemValidation';
import { msg, t, tn } from '../../src/utils/i18n';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Processes annotation attachments of type image to add base64 data.
 * 
 * @param attachments - Array of MessageAttachment objects to process
 * @returns Array of MessageAttachment objects with base64 data
 */
export async function processImageAnnotations(attachments: MessageAttachment[]): Promise<MessageAttachment[]> {
    // Process image annotations to add base64 data
    const processedAttachments = await Promise.all(
        attachments.map(async (attachment) => {
            // Only process AnnotationAttachment of type image
            if (!isAnnotationAttachment(attachment)) return attachment;
            if (attachment.annotation_type !== 'image') return attachment;

            // Create a reference to the Zotero item
            const item = {
                libraryID: attachment.library_id,
                key: attachment.zotero_key
            };

            // Check if image exists in cache
            const hasCachedImage = await Zotero.Annotations.hasCacheImage(item);
            if (!hasCachedImage) {
                logger(`processImageAnnotations: No cached image found for attachment ${attachment.zotero_key}`);
                return attachment;
            }

            try {
                // Get image path
                const imagePath = Zotero.Annotations.getCacheImagePath(item);
                
                // Read the image file and convert to base64
                const imageData = await IOUtils.read(imagePath);
                const image_base64 = uint8ArrayToBase64(imageData);
                
                // Return attachment with image data
                return {
                    ...attachment,
                    image_base64: image_base64
                };
            } catch (error) {
                logger(`processImageAnnotations: Failed to process image for attachment ${attachment.zotero_key}: ${error}`);
                return attachment;
            }
        })
    );
    return processedAttachments;
}

/**
 * Get the user's API key for a model.
 * 
 * Returns a key in these cases:
 * - Custom models: Use the API key from the custom model config
 * - BYOK models (access_mode='byok'): Use the user's configured API key for the provider
 * - App-key models (access_mode='app_key'): No user API key needed (returns undefined)
 * - Legacy models without access_mode: Use app_key if available, otherwise BYOK if only BYOK is allowed
 */
function getUserApiKey(model: ModelConfig): string | undefined {
    // Custom models use the API key from their config
    if (model.is_custom && model.custom_model?.api_key) {
        return model.custom_model.api_key;
    }

    // Check access_mode to determine key usage
    // If access_mode is explicitly 'app_key', don't provide user API key
    if (model.access_mode === 'app_key') return undefined;

    // If access_mode is 'byok', use user's key
    if (model.access_mode === 'byok') {
        if (model.provider === 'google') {
            return getPref('googleGenerativeAiApiKey') || undefined;
        } else if (model.provider === 'openai') {
            return getPref('openAiApiKey') || undefined;
        } else if (model.provider === 'anthropic') {
            return getPref('anthropicApiKey') || undefined;
        }
        return undefined;
    }

    // Legacy handling: no access_mode set (e.g., from old saved preferences)
    // Default to app_key behavior if available, otherwise fall back to BYOK if only BYOK is allowed
    if (!model.access_mode) {
        if (model.allow_app_key) {
            // Prefer app_key when both are available
            return undefined;
        } else if (model.allow_byok) {
            // Only use BYOK if app_key is not available
            if (model.provider === 'google') {
                return getPref('googleGenerativeAiApiKey') || undefined;
            } else if (model.provider === 'openai') {
                return getPref('openAiApiKey') || undefined;
            } else if (model.provider === 'anthropic') {
                return getPref('anthropicApiKey') || undefined;
            }
        }
    }

    return undefined;
}

/** Model selection options to be included in the AgentRunRequest */
interface ModelSelectionOptions {
    model_id?: string;
    api_key?: string;
}

/**
 * Build model selection options to include in the AgentRunRequest.
 * - Custom models: Use the custom_model field in the request (no model_id/api_key)
 * - App-key models (access_mode='app_key' or default): model_id only, no api_key
 * - BYOK models (access_mode='byok'): model_id + user's api_key
 */
function buildModelSelectionOptions(model: ModelConfig | null): ModelSelectionOptions {
    if (!model) return {};

    // Custom models use the custom_model field in the request, not model_id/api_key
    if (model.is_custom) return {};

    const options: ModelSelectionOptions = {};

    // Include model_id for non-custom models
    options.model_id = model.id;

    // Include api_key only for BYOK access mode
    // Legacy models without access_mode default to app_key if available
    if (model.access_mode === 'byok' || (!model.access_mode && !model.allow_app_key && model.allow_byok)) {
        const apiKey = getUserApiKey(model);
        if (apiKey) {
            options.api_key = apiKey;
        }
    }

    return options;
}

/**
 * Clear reader-only citation highlights before removing the runs that created them.
 */
async function cleanupTemporaryAnnotationsForRunReplacement(logPrefix: string): Promise<void> {
    try {
        await BeaverTemporaryAnnotations.cleanupAll();
    } catch (error) {
        logger(`${logPrefix}: Error cleaning up temporary annotations: ${error}`);
    }
}

/**
 * Decline what the runs a retry removes proposed and nobody decided.
 *
 * Their cards go with them, so a proposal of theirs left waiting would count
 * as pending with nothing on screen to decide. Proposals of every other run —
 * finished or stopped — stay the user's to decide.
 */
function releaseProposalsOfRemovedRuns(set: Setter, removedRuns: AgentRun[]): void {
    const toolCallIds = new Set<string>();
    for (const run of removedRuns) {
        for (const message of run.model_messages ?? []) {
            if (message.kind !== 'response') continue;
            for (const part of message.parts) {
                if (part.part_kind === 'tool-call' && part.tool_call_id) toolCallIds.add(part.tool_call_id);
            }
        }
    }
    if (toolCallIds.size === 0) return;
    const declined = resolveLocalApprovalsForToolCalls(toolCallIds, 'retry replaced the run');
    if (declined.length > 0) set(removePendingApprovalsAtom, declined);
}

// =============================================================================
// Retry truncation
// =============================================================================

/**
 * Move a terminal run out of the active slot into thread history.
 *
 * Failed and canceled runs stay in `activeRunAtom` (there is no terminal
 * `done` to archive them). A send or resume that is not replacing that run
 * has to keep it — the run is persisted server-side, and dropping it locally
 * would make the history on screen diverge from the history the model reads.
 *
 * Live runs (`in_progress`, `awaiting_deferred`) are left in place. Callers
 * overwrite `activeRunAtom` with the new shell immediately after, so this
 * does not null the slot.
 */
function archiveTerminalActiveRun(get: Getter, set: Setter): void {
    const activeRun = get(activeRunAtom);
    if (!activeRun || isRunActive(activeRun)) return;
    set(threadRunsAtom, (runs) => appendRunIfMissing(runs, activeRun));
}

/**
 * Archive a terminal active run into thread history and clear the slot.
 *
 * The retry paths use this instead of `archiveTerminalActiveRun`: they await
 * a truncate POST before installing the replacement shell, and `allRunsAtom`
 * concatenates thread history and the active slot without deduplication, so a
 * run left in both places would render twice for the whole round trip.
 *
 * Folding the run into `threadRunsAtom` first is also what puts a failed run
 * that sits in the active slot into the retry's removed set — its applied
 * actions belong in the confirm dialog, and its ID in the POSTed removal.
 */
function archiveAndClearTerminalActiveRun(get: Getter, set: Setter): void {
    const activeRun = get(activeRunAtom);
    if (!activeRun || isRunActive(activeRun)) return;
    set(threadRunsAtom, (runs) => appendRunIfMissing(runs, activeRun));
    set(activeRunAtom, null);
}

/**
 * The run whose retry is in its pre-send phase — set while the truncate POST
 * and any undo work run, cleared once the replacement shell is installed (or
 * the retry aborts). Drives the loading state of the retry controls; the
 * replacement run's own status takes over from there.
 *
 * Doubles as the retry lock. While set, no other retry, resume, or send may
 * start (`retryCommitInFlight`), and the failed run's dying socket must not
 * release `isWSChatPendingAtom` — the close event of the run being replaced
 * arrives mid-commit, and clearing the flag there would re-enable the
 * composer while the truncation is still in flight. Only the retry flow
 * itself clears this atom, on every one of its exits.
 */
export const retryPendingRunIdAtom = atom<string | null>(null);

/**
 * Whether a retry is between its truncate POST and its replacement shell.
 * Guards every path that would mutate run state concurrently: a second
 * truncation issued in this window would commit against a thread the first
 * is about to rewrite.
 */
function retryCommitInFlight(get: Getter, logPrefix: string): boolean {
    const pendingRetryRunId = get(retryPendingRunIdAtom);
    if (!pendingRetryRunId) return false;
    logger(`${logPrefix}: Blocked — retry of run ${pendingRetryRunId} is still committing`, 1);
    return true;
}

/**
 * Commit a retry's removal on the backend before anything local changes.
 *
 * This ordering is what the retry design hangs on: no run leaves the screen
 * and no Zotero change is undone until the backend confirms the deletion.
 * On 'failed' and 'refused' the caller must leave local state untouched —
 * client and server still agree, because neither moved.
 *
 * `expectedTailRunId` names the run the client expects to survive as the
 * thread's last (null when the whole thread is removed); the backend refuses
 * when the actual survivor differs, which catches a thread rewritten by
 * another client even when every named run is already gone.
 *
 * The transport already re-POSTs once on network-shaped failures (the
 * endpoint is idempotent), so 'failed' here means the retry genuinely could
 * not reach the backend.
 */
// =============================================================================
// Local run storage
// =============================================================================

/** The local database, when runs are stored by this install. */
function localRunDb(): any | null {
    if (!isLocalBrain()) return null;
    return (Zotero as any).AlphainZ?.db ?? null;
}

/**
 * Local runs' database writes, chained per run.
 *
 * A run is written several times — as a shell when it is sent, when it ends,
 * and again whenever one of its agent actions changes — and every write is
 * detached from the UI. Chaining them keeps a later write from landing under
 * an earlier one, and gives a retry something to wait on before it deletes
 * runs. Each write resolves to whether it went through.
 */
const localRunWrites = new Map<string, Promise<boolean>>();

/**
 * Runs a retry is deleting or has deleted. A write for one of them that has not
 * started yet is dropped: it would put the run back.
 */
const deletedLocalRunIds = new Set<string>();

function queueLocalRunWrite(runId: string, write: () => Promise<void>): Promise<boolean> {
    const previous = localRunWrites.get(runId) ?? Promise.resolve(true);
    const next = previous.then(async () => {
        if (deletedLocalRunIds.has(runId)) return false;
        try {
            await write();
            return true;
        } catch (error) {
            logger(`queueLocalRunWrite: could not store run ${runId}: ${error}`, 1);
            return false;
        }
    });
    localRunWrites.set(runId, next);
    void next.then(() => {
        if (localRunWrites.get(runId) === next) localRunWrites.delete(runId);
    });
    return next;
}

/** Wait until every local run write queued so far has landed. */
async function settleLocalRunWrites(): Promise<void> {
    await Promise.all([...localRunWrites.values()]);
}

/** Remove the named runs from the local database, shaped like the server's report. */
async function truncateThreadLocally(
    threadId: string,
    removedRunIds: string[],
    expectedTailRunId: string | null,
): Promise<{ deleted_run_ids: string[]; refused_run_ids: string[]; reason?: string }> {
    const db = (Zotero as any).AlphainZ?.db;
    if (!db?.deleteRuns) {
        // No database is not the same as a refusal: the runs on screen are still
        // the runs the caller means, so let the retry proceed rather than
        // blocking it over a store that is not there.
        return { deleted_run_ids: [], refused_run_ids: [] };
    }
    /*
     * The tail check compares the runs on screen with the stored ones, and the
     * runs on screen include writes still on their way — the answer the user
     * stopped a moment ago, the shell of the last message. Those land first.
     * A write queued for one of the doomed runs from here on is dropped, or it
     * would bring the run back after the delete.
     */
    for (const runId of removedRunIds) deletedLocalRunIds.add(runId);
    try {
        await settleLocalRunWrites();
        const report = await db.deleteRuns(threadId, removedRunIds, expectedTailRunId);
        if (report?.reason) {
            for (const runId of removedRunIds) deletedLocalRunIds.delete(runId);
        } else {
            for (const runId of removedRunIds) forgetStoredRun(runId);
        }
        return report;
    } catch (error) {
        for (const runId of removedRunIds) deletedLocalRunIds.delete(runId);
        throw error;
    }
}

async function truncateThreadOnServer(
    threadId: string,
    removedRunIds: string[],
    expectedTailRunId: string | null,
    logPrefix: string,
): Promise<'ok' | 'refused' | 'failed'> {
    try {
        // Locally the runs are rows in this install's database, not records on a
        // server. Without this branch the POST failed, the caller read that as
        // 'failed', and Retry threw instead of retrying.
        const report = isLocalBrain()
            ? await truncateThreadLocally(threadId, removedRunIds, expectedTailRunId)
            : await threadService.truncateThread(
                  threadId,
                  removedRunIds,
                  expectedTailRunId,
              );
        if (report.reason) {
            logger(
                `${logPrefix}: truncation refused (${report.reason}) — thread rewritten elsewhere ` +
                    `(named ${removedRunIds.length}, refused ${report.refused_run_ids.length})`,
                1,
            );
            return 'refused';
        }
        logger(
            `${logPrefix}: truncation confirmed ` +
                `(deleted ${report.deleted_run_ids.length} of ${removedRunIds.length} named run(s))`,
            1,
        );
        return 'ok';
    } catch (error) {
        logger(`${logPrefix}: truncation failed: ${error}`, 1);
        return 'failed';
    }
}

/**
 * Create the initial AgentRun shell when user presses send.
 * This happens BEFORE WebSocket connection.
 */
function createAgentRunShell(
    userPrompt: BeaverAgentPrompt,
    threadId: string | null,
    userId: string,
    modelName: string,
    modelSelectionOptions: ModelSelectionOptions,
    providerName?: string,
    customInstructions?: string,
    customModel?: ModelConfig['custom_model'],
    runIdOverride?: string,
    permissionsOverride?: Partial<ChargingPermissions>,
): { run: AgentRun; request: AgentRunRequest } {
    const runId = runIdOverride ?? uuidv4();

    // Get user preferences for charging permissions, then apply any partial override.
    // What a request may spend is one run-level preference: the credit limit,
    // or no limit at all. The per-tool cost booleans and the turn pause this
    // build no longer sets are left to their default on a backend old enough to
    // read them, so such a backend asks per tool and keeps pausing long runs
    // rather than charging silently.
    const confirmCredits = getPref('confirmCredits');
    const permissions: ChargingPermissions = {
        confirm_credits: confirmCredits,
        credit_confirm_threshold: confirmCredits ? readCreditThreshold() : null,
        ...permissionsOverride,
    };

    // Send request_plus_tools when pref is enabled and request uses a user API key
    const usesUserKey = !!modelSelectionOptions.api_key || !!customModel;
    const requestPlusTools = getPref('requestPlusTools') && usesUserKey;

    // Create the request that will be sent to the backend
    // thread_id is null for new threads - backend generates the ID
    // Model selection is included in the request (model_id/api_key for backend models, custom_model for custom)
    const request: AgentRunRequest = {
        type: 'chat',
        run_id: runId,
        thread_id: threadId,
        user_prompt: {
            ...userPrompt,
            ...(customInstructions ? { custom_instructions: customInstructions } : {}),
        },
        permissions: permissions,
        ...(requestPlusTools ? { request_plus_tools: true } : {}),
        ...(modelSelectionOptions.model_id ? { model_id: modelSelectionOptions.model_id } : {}),
        ...(modelSelectionOptions.api_key ? { api_key: modelSelectionOptions.api_key } : {}),
        ...(customModel ? { custom_model: customModel } : {}),
    };

    // Create the shell AgentRun for immediate UI rendering
    // thread_id will be updated when we receive the 'thread' event from backend
    const run: AgentRun = {
        id: runId,
        user_id: userId,
        thread_id: threadId,
        agent_name: 'beaver',
        user_prompt: userPrompt,
        status: 'in_progress',
        model_messages: [],
        model_name: modelName,
        provider_name: providerName,
        created_at: new Date().toISOString(),
        consent_to_share: false,
    };

    return { run, request };
}

type StartResumeRunOptions = {
    requireResumable: boolean;
    /**
     * Who is asking. Sent to the backend, which reorders its model chain only
     * for `auto` — a user-clicked resume usually follows a dropped connection
     * or a closed client, where no provider failed.
     */
    trigger: ResumeTrigger;
    logPrefix: string;
    failureErrorType: string;
    failureMessage: string;
};

async function startResumeRun(
    get: Getter,
    set: Setter,
    failedRunId: string,
    options: StartResumeRunOptions,
): Promise<void> {
    logger(`${options.logPrefix}: Resuming from run ${failedRunId}`, 1);

    // A resume overwriting the active slot mid-commit would be clobbered
    // when the retry installs its own replacement shell.
    if (retryCommitInFlight(get, options.logPrefix)) return;

    let newRunId: string | null = null;

    try {
        const model = get(selectedModelAtom);
        if (!model) {
            logger(`${options.logPrefix}: No model selected`, 1);
            return;
        }

        const userId = get(userIdAtom);
        if (!userId) {
            logger(`${options.logPrefix}: No user ID found`, 1);
            return;
        }

        const threadRuns = get(threadRunsAtom);
        const activeRun = get(activeRunAtom);
        const failedRun = findRunForResume(threadRuns, activeRun, failedRunId);

        if (!failedRun) {
            logger(`${options.logPrefix}: Failed run ${failedRunId} not found`, 1);
            return;
        }

        // Two shapes resume. A failed run carries the backend's own verdict in
        // `is_resumable`, which the user-driven path insists on. A run that was
        // cut off has no such flag — nothing failed, the client went away — so
        // its termination cause is the signal instead.
        const isResumableError =
            failedRun.status === 'error'
            && (!options.requireResumable || !!failedRun.error?.is_resumable);
        if (!isResumableError && !isInterruptedRun(failedRun)) {
            logger(`${options.logPrefix}: Run ${failedRunId} is not resumable`, 1);
            return;
        }

        const threadId = get(currentThreadIdAtom) || failedRun.thread_id;
        if (!threadId) {
            logger(`${options.logPrefix}: No thread ID found`, 1);
            return;
        }

        // Keep the failed run in local history: the resume continues from it
        // rather than replacing it, so the next request has to still hold it.
        archiveTerminalActiveRun(get, set);

        set(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        raisePendingFlag(set);

        const modelOptions = buildModelSelectionOptions(model);
        const customInstructions = getPref('customInstructions') || undefined;

        const resumePrompt: BeaverAgentPrompt = {
            content: '',
            is_resume: true,
            resumes_run_id: failedRunId,
            resume_trigger: options.trigger,
        };

        const { run: newRun, request } = createAgentRunShell(
            resumePrompt,
            threadId,
            userId,
            model.name,
            modelOptions,
            model.provider,
            customInstructions,
            model.is_custom ? model.custom_model : undefined,
        );

        newRunId = newRun.id;
        set(activeRunAtom, newRun);

        await executeWSRequest(newRun, request, get, set);
    } catch (error) {
        logger(`${options.logPrefix}: Unexpected error:`, error, 1);
        set(wsErrorAtom, {
            event: 'error',
            type: options.failureErrorType,
            message: error instanceof Error ? error.message : options.failureMessage,
            is_retryable: true,
        });
        set(activeRunAtom, prev => (newRunId && prev?.id === newRunId ? null : prev));
        set(isWSChatPendingAtom, false);
    }
}

/**
 * Retry a failed run by deleting it (and any preceding resume-chain runs) and
 * starting fresh from the original user prompt. Used by auto-retry when the
 * frontend has only received thinking content — nothing user-visible to keep.
 *
 * Like the user-driven retries, the removal is committed on the backend
 * first. There is no confirm dialog and no undo — applied actions in the
 * removed runs stay in place, as before. A failed or refused truncation
 * takes the ordinary auto-retry error path with nothing local to unwind.
 */
async function startAutoRetryRun(
    get: Getter,
    set: Setter,
    failedRunId: string,
): Promise<void> {
    const logPrefix = 'autoRetryErroredRunAtom';
    logger(`${logPrefix}: Retrying from run ${failedRunId}`, 1);

    if (retryCommitInFlight(get, logPrefix)) return;

    let newRunId: string | null = null;

    try {
        const model = get(selectedModelAtom);
        if (!model) {
            logger(`${logPrefix}: No model selected`, 1);
            return;
        }

        const userId = get(userIdAtom);
        if (!userId) {
            logger(`${logPrefix}: No user ID found`, 1);
            return;
        }

        // Fold the failed run out of the active slot into thread history so
        // the removal below names it — the backend persisted it, and leaving
        // it out would strand an error run in the middle of the thread.
        archiveAndClearTerminalActiveRun(get, set);

        const threadRuns = get(threadRunsAtom);
        const failedRun = findRunForResume(threadRuns, get(activeRunAtom), failedRunId);

        if (!failedRun) {
            logger(`${logPrefix}: Failed run ${failedRunId} not found`, 1);
            return;
        }

        if (failedRun.status !== 'error') {
            logger(`${logPrefix}: Run ${failedRunId} is not in error state`, 1);
            return;
        }

        const threadId = get(currentThreadIdAtom) || failedRun.thread_id;
        if (!threadId) {
            logger(`${logPrefix}: No thread ID found`, 1);
            return;
        }

        // Walk back to the original user message — resume runs carry an empty
        // user_prompt.content, so we need the root to preserve the question.
        const rootRun = findResumeChainRoot(failedRun, threadRuns);
        const chainRootIndex = threadRuns.findIndex(r => r.id === rootRun.id);
        const truncateFromIndex = chainRootIndex >= 0 ? chainRootIndex : threadRuns.length;
        const runIdsToRemove = threadRuns.slice(truncateFromIndex).map(r => r.id);

        // The failed run's error card shows a loading state while the
        // truncate round trip runs; every exit below clears it (the catch
        // handles the throw on a failed POST).
        set(retryPendingRunIdAtom, failedRunId);
        raisePendingFlag(set);

        // Commit the removal on the backend before anything local changes.
        // Skipped when nothing was removed (nothing persisted to delete).
        if (runIdsToRemove.length > 0) {
            const expectedTailRunId =
                truncateFromIndex > 0 ? threadRuns[truncateFromIndex - 1].id : null;
            const outcome = await truncateThreadOnServer(
                threadId,
                runIdsToRemove,
                expectedTailRunId,
                logPrefix,
            );
            if (outcome === 'refused') {
                // The thread was rewritten by another client. There is no
                // user decision to retry against a history this client has
                // never seen — reload instead, so the UI shows the thread
                // whole (including the failed run's error card, from which
                // the user can retry deliberately).
                set(retryPendingRunIdAtom, null);
                set(isWSChatPendingAtom, false);
                set(addPopupMessageAtom, {
                    type: 'warning',
                    title: t('Chat changed elsewhere'),
                    text: t('This chat was changed somewhere else, so the failed run was not retried automatically. Reloading the chat.'),
                    expire: true,
                });
                await set(loadThreadAtom, {
                    user_id: userId,
                    threadId,
                    skipInstanceMismatchConfirm: true,
                });
                return;
            }
            if (outcome === 'failed') {
                throw new Error('Failed to automatically retry run');
            }

            await cleanupTemporaryAnnotationsForRunReplacement(logPrefix);

            releaseProposalsOfRemovedRuns(set, threadRuns.slice(truncateFromIndex));

            set(threadRunsAtom, prev => prev.filter(r => !runIdsToRemove.includes(r.id)));
            set(threadAgentActionsAtom, prev => prev.filter(a => !runIdsToRemove.includes(a.run_id)));
            set(citationsAtom, prev => prev.filter(c => !runIdsToRemove.includes(c.run_id ?? '')));
            set(processCitationsAtom);
            set(maybeShowCitationTipAtom);
        }

        set(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        raisePendingFlag(set);

        const modelOptions = buildModelSelectionOptions(model);
        const customInstructions = getPref('customInstructions') || undefined;

        const { run: newRun, request } = createAgentRunShell(
            rootRun.user_prompt,
            threadId,
            userId,
            model.name,
            modelOptions,
            model.provider,
            customInstructions,
            model.is_custom ? model.custom_model : undefined,
        );

        newRunId = newRun.id;
        set(activeRunAtom, newRun);
        set(retryPendingRunIdAtom, null);

        await executeWSRequest(newRun, request, get, set);
    } catch (error) {
        logger(`${logPrefix}: Unexpected error:`, error, 1);
        const failureMessage = error instanceof Error ? error.message : t('Failed to automatically retry run');
        set(wsErrorAtom, {
            event: 'error',
            type: 'auto_retry_error',
            message: failureMessage,
            is_retryable: true,
        });
        set(activeRunAtom, prev => (newRunId && prev?.id === newRunId ? null : prev));
        set(retryPendingRunIdAtom, prev => (prev === failedRunId ? null : prev));
        set(isWSChatPendingAtom, false);
    }
}

/**
 * Undo all applied agent actions from removed runs in reverse chronological order.
 *
 * A single ordered loop is required because actions have cross-type dependencies.
 * Undoing in reverse chronological order restores the original state.
 *
 * Per-action failures are logged and do not stop the loop.
 */
async function undoAppliedActionsInReverse(actions: AgentAction[]): Promise<void> {
    // Filter applied actions, keeping their original array position as the
    // tiebreaker for chronological ordering.
    const indexed = actions
        .map((action, index) => ({ action, index }))
        .filter(({ action }) => {
            if (isCreateAnnotationsAgentAction(action)) {
                return hasAppliedBulkAnnotations(action);
            }
            if (isAnnotationAgentAction(action) || isZoteroNoteAgentAction(action)) {
                return hasAppliedZoteroItem(action);
            }
            return action.status === 'applied';
        });

    // Sort reverse-chronologically by `created_at`, falling back to array
    // position (which reflects insertion order in threadAgentActionsAtom).
    indexed.sort((a, b) => {
        const ta = a.action.created_at ? Date.parse(a.action.created_at) : NaN;
        const tb = b.action.created_at ? Date.parse(b.action.created_at) : NaN;
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
        return b.index - a.index;
    });

    for (const { action } of indexed) {
        try {
            if (isCreateAnnotationsAgentAction(action)) {
                await undoCreateAnnotationsAction(action);
            } else if (isEditAnnotationsAgentAction(action)) {
                // Preserve fields the user manually modified after apply, as
                // the other edit-action retry paths do.
                await undoEditAnnotationsAction(action, false);
            } else if (isAnnotationAgentAction(action) || isZoteroNoteAgentAction(action)) {
                const ref = action.result_data as ZoteroItemReference | undefined;
                if (!ref) continue;
                const resolved = await resolveItemReference(ref);
                if (resolved.status === 'found') await resolved.item.eraseTx();
            } else if (isEditMetadataAgentAction(action)) {
                // false = preserve fields the user manually modified after apply
                await undoEditMetadataAction(action, false);
            } else if (isEditNoteAgentAction(action)) {
                await undoEditNoteAction(action);
            } else if (isEditNoteBatchAgentAction(action)) {
                await undoEditNoteBatchAction(action);
            } else if (isCreateItemAgentAction(action)) {
                await undoCreateItemAction(action);
            } else if (isCreateCollectionAgentAction(action)) {
                await undoCreateCollectionAction(action);
            } else if (isOrganizeItemsAgentAction(action)) {
                await undoOrganizeItemsAction(action);
            } else if (isManageTagsAgentAction(action)) {
                await undoManageTagsAction(action);
            } else if (isManageCollectionsAgentAction(action)) {
                await undoManageCollectionsAction(action);
            } else if (isCreateNoteAgentAction(action)) {
                await undoCreateNoteAction(action);
            }
        } catch (error) {
            logger(`undoAppliedActionsInReverse: Failed to undo action ${action.id} (${action.action_type}): ${error}`, 1);
        }
    }
}

/**
 * Actions to undo when regenerating a run.
 */
interface ActionsToUndo {
    annotations: AgentAction[];
    annotationEdits: AgentAction[];
    zoteroNotes: AgentAction[];
    metadataEdits: AgentAction[];
    noteEdits: AgentAction[];
    createItems: AgentAction[];
    createCollections: AgentAction[];
    organizeItems: AgentAction[];
    manageTags: AgentAction[];
    manageCollections: AgentAction[];
    createNotes: AgentAction[];
}

type UndoConfirmResult = 'undo' | 'skip' | 'cancel';

/**
 * Prompt user to confirm undoing applied agent actions during regeneration.
 * Shows a combined dialog listing all types of changes that will be undone,
 * and says so when the retry also removes later exchanges in the chat.
 * Returns 'undo' to undo and regenerate, 'skip' to regenerate without undoing,
 * or 'cancel' to abort regeneration entirely.
 */
function confirmUndoAppliedActions(
    actions: ActionsToUndo,
    laterExchanges = 0,
    stopsAnswerBeingWritten = false,
): UndoConfirmResult {
    const { annotations, annotationEdits, zoteroNotes, metadataEdits, noteEdits, createItems, createCollections, organizeItems, manageTags, manageCollections, createNotes } = actions;
    const totalActions = annotations.length + annotationEdits.length + zoteroNotes.length + metadataEdits.length +
                         noteEdits.length + createItems.length + createCollections.length + organizeItems.length +
                         manageTags.length + manageCollections.length + createNotes.length;

    if (totalActions === 0) return 'skip';

    // Build a list of changes
    const changeLines: string[] = [];
    if (annotations.length > 0) {
        const annotationCount = annotations.reduce(
            (sum, action) => sum + getAppliedPdfAnnotationCount(action),
            0,
        );
        changeLines.push(tn(annotationCount, '• {count} PDF annotation', '• {count} PDF annotations'));
    }
    if (annotationEdits.length > 0) {
        const annotationCount = annotationEdits.reduce((sum, action) => {
            const before = action.result_data?.before;
            const appliedRefs = action.result_data?.applied_refs;
            const count = Array.isArray(before)
                ? before.length
                : Array.isArray(appliedRefs)
                    ? appliedRefs.length
                    : 1;
            return sum + count;
        }, 0);
        changeLines.push(tn(annotationCount, '• {count} PDF annotation change', '• {count} PDF annotation changes'));
    }
    if (zoteroNotes.length > 0) {
        changeLines.push(tn(zoteroNotes.length, '• {count} Zotero note', '• {count} Zotero notes'));
    }
    if (metadataEdits.length > 0) {
        changeLines.push(tn(metadataEdits.length, '• {count} metadata edit', '• {count} metadata edits'));
    }
    if (noteEdits.length > 0) {
        changeLines.push(tn(noteEdits.length, '• {count} note edit', '• {count} note edits'));
    }
    if (createItems.length > 0) {
        changeLines.push(tn(createItems.length, '• {count} created item', '• {count} created items'));
    }
    if (createCollections.length > 0) {
        changeLines.push(tn(createCollections.length, '• {count} created collection', '• {count} created collections'));
    }
    if (organizeItems.length > 0) {
        changeLines.push(tn(organizeItems.length, '• {count} organize action', '• {count} organize actions'));
    }
    if (manageTags.length > 0) {
        changeLines.push(tn(manageTags.length, '• {count} tag change', '• {count} tag changes'));
    }
    if (manageCollections.length > 0) {
        changeLines.push(tn(manageCollections.length, '• {count} collection change', '• {count} collection changes'));
    }
    if (createNotes.length > 0) {
        changeLines.push(tn(createNotes.length, '• {count} created note', '• {count} created notes'));
    }
    
    const title = t('Retry?');
    const later = laterExchanges > 0
        ? `${laterExchangesSentence(laterExchanges, stopsAnswerBeingWritten)}\n\n`
        : '';
    const message = `${later}${t('The following changes were applied and can be undone:')}\n\n${changeLines.join('\n')}\n\n`
        + t('Undo them and retry, or retry without undoing?');

    const buttonIndex = Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text: message,
        button0: t('Undo && Retry'),
        // Cancel must be at button1 so Escape/dialog-close routes here
        // (Services.prompt.confirmEx returns index 1 on Esc).
        button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
        button2: t('Retry'),
        defaultButton: 1,
    });

    if (buttonIndex === 0) return 'undo';
    if (buttonIndex === 2) return 'skip';
    return 'cancel';
}


// =============================================================================
// Missing Zotero Data Handling
// =============================================================================

/** Reason why an item might be missing from the backend */
type MissingItemReason = 
    | 'not_found'           // Item doesn't exist in Zotero
    | 'library_unavailable' // Library is not available on this computer
    | 'in_trash'            // Item is in trash
    | 'library_not_synced'  // Library not configured to sync
    | 'filtered_from_sync'  // Doesn't pass sync filters (e.g., not a PDF)
    | 'pending_sync'        // Added after last sync
    | 'file_unavailable_locally_and_on_server' // File unavailable locally and on server
    | 'unknown';            // Unknown reason

/**
 * Determine why an item is missing from the backend.
 * Returns the most likely reason based on item status checks.
 */
async function determineMissingReason(ref: ZoteroItemReference, userId: string | null): Promise<MissingItemReason> {
    try {
        // Get searchable libraries from store
        const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
        const syncWithZotero = store.get(syncWithZoteroAtom);
        const resolvedLibraryId = resolveLibraryRef(ref);
        if (!resolvedLibraryId) {
            return 'library_unavailable';
        }

        // Check if library is searchable (synced for Pro, all local for Free)
        if (!searchableLibraryIds.includes(resolvedLibraryId)) {
            return 'library_not_synced';
        }

        // Try to get the item from Zotero
        const item = await Zotero.Items.getByLibraryAndKeyAsync(resolvedLibraryId, ref.zotero_key);
        if (!item) {
            return 'not_found';
        }

        // Load item and parent item data for proper status checks
        await Zotero.Items.loadDataTypes([item], ["primaryData"]);
        if (item.parentID) {
            const parentItem = await Zotero.Items.getAsync(item.parentID);
            if (parentItem) {
                await Zotero.Items.loadDataTypes([parentItem], ["primaryData"]);
            }
        }

        // Check if in trash
        const trashState = safeIsInTrash(item);
        if (trashState === true) {
            return 'in_trash';
        }

        // Check if the item is a kind Beaver supports and is available
        const passesAgentFilters = await agentItemFilterAsync(item);
        if (!passesAgentFilters) {
            return 'filtered_from_sync';
        }

        // Check if available locally or on server
        const availableLocallyOrOnServer = !item.isAttachment() || (await item.fileExists()) || isAttachmentOnServer(item);
        if (!availableLocallyOrOnServer) {
            return 'file_unavailable_locally_and_on_server';
        }

        // Check if pending sync (added after last sync)
        if (userId) {
            try {
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                if (!wasAddedBeforeSync) {
                    return 'pending_sync';
                }
            } catch {
                // Unable to determine pending status
            }
        }

        // If we get here and item exists but wasn't found in backend, it's unknown
        return 'unknown';
    } catch (error) {
        logger(`determineMissingReason: Error checking item ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
        return 'unknown';
    }
}

/** Human-readable messages for each missing reason */
const MISSING_REASON_MESSAGES: Record<MissingItemReason, string> = {
    'not_found': msg('Item not found in your Zotero library'),
    'library_unavailable': msg("Library is not available on this computer. It may be a group library you haven't joined on this device"),
    'in_trash': msg('Item is in trash'),
    'library_not_synced': msg('Library is not configured to sync with AlphainZ'),
    'filtered_from_sync': msg('Item type not supported'),
    'pending_sync': msg('Item was added after the last sync. Please wait for sync to complete or sync manually in settings'),
    'file_unavailable_locally_and_on_server': msg('File is unavailable'),
    'unknown': msg('Unexpected error. Try again; if it keeps happening, Zotero\'s debug output (Help → Debug Output Logging) will show why.'),
};

/**
 * Process missing Zotero data event and generate a warning message.
 * Determines reasons for all items and creates a warning with a list of reasons and counts.
 */
async function handleMissingZoteroData(
    event: WSMissingZoteroDataEvent,
    userId: string | null,
    addWarning: (params: { run_id: string; type: string; message: string; data?: Record<string, unknown> }) => void
): Promise<void> {
    if (event.items.length === 0) return;

    // Determine reasons for each item
    const reasons = await Promise.all(
        event.items.map(async (item) => ({
            item,
            reason: await determineMissingReason(item, userId)
        }))
    );
    logger('handleMissingZoteroData: reasons', reasons, 1);

    // Count reasons
    const reasonCounts = new Map<MissingItemReason, number>();
    for (const { reason } of reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    // Sort reasons by count (descending) for better readability
    const sortedReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1]);

    // Determine the primary reason to show
    // Prioritize 'unknown' as it's most severe, otherwise show the most common reason
    const unknownEntry = sortedReasons.find(([reason]) => reason === 'unknown');
    const [primaryReason, primaryCount] = unknownEntry || sortedReasons[0];
    
    // Build user-friendly message
    const itemCount = event.items.length;
    const otherCount = itemCount - primaryCount;
    
    let message = tn(itemCount, 'Unable to process {count} attachment: {reason}', 'Unable to process {count} attachments: {reason}',
        { reason: t(MISSING_REASON_MESSAGES[primaryReason]) });
    
    // Add count if not all items have the same reason
    if (primaryCount < itemCount) {
        message += ` (${primaryCount}/${itemCount})`;
    }
    
    // Mention other reasons exist without listing them all
    if (otherCount > 0) {
        message += '\n\n' + tn(otherCount, '{count} other attachment has a different reason.', '{count} other attachments have different reasons.');
    }
    
    // Add warning
    addWarning({
        run_id: event.run_id,
        type: 'missing_zotero_data',
        message,
        data: {
            items: event.items,
            reason_counts: Object.fromEntries(reasonCounts),
        },
    });
}

// =============================================================================
// State Atoms
// =============================================================================

/** Whether a WebSocket chat request is currently in progress */
export const isWSChatPendingAtom = atom(false);

/**
 * How many requests have raised `isWSChatPendingAtom` for themselves: every
 * send, retry and resume raises it as it starts (`raisePendingFlag`).
 *
 * A run that ends after a later request raised the flag must leave it alone,
 * because the flag is the later request's by then. The active slot does not
 * show that on its own: a message is prepared — its attachments read, its
 * images encoded — before its run takes the slot, and a stopped local loop
 * that only now noticed can end in that gap.
 */
let pendingFlagRaises = 0;

function raisePendingFlag(set: Setter): void {
    pendingFlagRaises++;
    set(isWSChatPendingAtom, true);
}

/** Run IDs where LLM streaming finished but post-processing (citations) is still in progress */
export const streamingDoneRunIdsAtom = atom<Set<string>>(new Set<string>());

/** Whether the WebSocket is currently connected */
export const isWSConnectedAtom = atom(false);

/** Whether the server has sent the ready event (validation complete) */
export const isWSReadyAtom = atom(false);

/** Ready event data from server (subscription, processing info) */
export const wsReadyDataAtom = atom<WSReadyData | null>(null);

/** Request acknowledgment data from server (model, charge type info) */
export const wsRequestAckDataAtom = atom<WSRequestAckData | null>(null);

/** Last error from WebSocket */
export const wsErrorAtom = atom<WSErrorEvent | null>(null);

/** Last warning from WebSocket */
export const wsWarningAtom = atom<WSWarningEvent | null>(null);

/** Deduplicates concurrent auto-resume/auto-retry scheduling for the same run. */
const scheduledAutoResumeRunIdsAtom = atom<Set<string>>(new Set<string>());

// =============================================================================
// Action Atoms
// =============================================================================

/**
 * The one tracker measuring how long the stream has been quiet.
 *
 * Module-level rather than mounted with a component: the events it measures
 * arrive at these handlers whether or not anything is on screen, and a tracker
 * that had to be mounted would silently stop measuring in any window state that
 * failed to mount it. Every handler below that advances a run calls it — one
 * left out would make its event look like more silence, which is exactly the
 * false report this exists to prevent.
 */
const streamActivity = createStreamActivityTracker({
    publish: (state) => store.set(streamQuietAtom, state),
});

/**
 * Reset all WebSocket state atoms
 */
export const resetWSStateAtom = atom(null, (_get, set) => {
    set(isWSChatPendingAtom, false);
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
    set(wsReadyDataAtom, null);
    set(wsRequestAckDataAtom, null);
    set(wsErrorAtom, null);
    set(wsWarningAtom, null);
    set(wsRetryAtom, null);
    set(wsReconnectingAtom, null);
    set(streamingDoneRunIdsAtom, new Set<string>());
    streamActivity.reset();
});

/**
 * Retire the approval cards a run's end leaves unanswerable, and only those.
 *
 * An approval the backend asked for over the socket dies with its run: the
 * backend stops waiting, and the card could never be answered. A proposal a
 * local run made is different by design — the tool returned at once, and the
 * proposal waits here for the user, outliving its run. It is a decision the
 * user has not made yet, so a new message, a failed run or Stop leaves it
 * pending, and only the user's own click declines it.
 */
export const retireUnanswerableApprovalsAtom = atom(null, (get, set) => {
    const unanswerable = [...get(pendingApprovalsAtom).keys()]
        .filter((actionId) => !isLocalApprovalWaiting(actionId));
    if (unanswerable.length > 0) set(removePendingApprovalsAtom, unanswerable);
});

/**
 * Clear transient frontend state before starting a replacement run.
 * This is separate from transport-level onClose cleanup so reconnect handoffs
 * do not leak per-run approval UI or auto-approve settings into the new run.
 */
export const prepareForNewRunAtom = atom(null, (_get, set) => {
    set(resetWSStateAtom);
    set(retireUnanswerableApprovalsAtom);
    set(clearAllPendingQuestionsAtom);
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearAllPendingBatchApprovalsAtom);
    set(clearApprovalResponseIntentsAtom);
    set(clearStaleApprovalsAtom);
    set(clearRunApprovalPolicyAtom);
});

/**
 * Find the args of the tool-call part that produced a given tool return, by
 * scanning the run's response messages. Used to derive the annotation-list
 * variant when synthesizing a legacy view; null when the call can't be found.
 */
function findToolCallArgs(
    run: AgentRun | null,
    toolCallId: string,
): string | Record<string, any> | null {
    if (!run) return null;
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-call' && part.tool_call_id === toolCallId) {
                return part.args;
            }
        }
    }
    return null;
}

/**
 * Ids of the actions a live run has already written to Zotero, for the
 * completed-changes card. Only the WS handlers call this: an action arrives
 * `applied` because the run executed it — the user approved it while it was
 * streaming, or an always-apply permission let it run unattended. Thread
 * hydration loads actions through a different atom, so reopening a thread
 * cannot rebuild the card from history. See `sessionAppliedActionIdsAtom`.
 */
function appliedActionIds(actions: AgentAction[]): string[] {
    return actions.filter((action) => action.status === 'applied').map((action) => action.id);
}

function surfaceAndDiagnoseConnectionFailure(
    set: Setter,
    runId: string,
    evidence: ConnectionFailureEvidence,
    connectAttempts?: number,
): void {
    const applyPresentation = (
        diagnostic?: Awaited<ReturnType<typeof reportConnectionFailure>>,
    ) => {
        const presentation = presentConnectionFailure(evidence, diagnostic);
        // The diagnostic POST can take several seconds; if the user retried in
        // the meantime, this run is no longer active and the refined
        // presentation must not resurface its error over the new run's state.
        const activeId = store.get(activeRunAtom)?.id ?? null;
        if (activeId !== runId) return;
        set(wsErrorAtom, (current) =>
            current?.type && current.type !== 'connection_error'
                ? current
                : current?.run_id && current.run_id !== runId
                  ? current
                  : {
                        event: 'error',
                        type: 'connection_error',
                        message: presentation.message,
                        run_id: runId,
                        is_retryable: true,
                    },
        );
        set(activeRunAtom, (prev) =>
            prev?.id === runId &&
            (prev.status === 'in_progress' ||
                prev.status === 'awaiting_deferred' ||
                (prev.status === 'error' && prev.error?.type === 'connection_error'))
                ? {
                      ...prev,
                      status: 'error',
                      error: {
                          type: 'connection_error',
                          message: presentation.message,
                          user_facing_details: presentation.details,
                          is_retryable: true,
                      },
                  }
                : prev,
        );
    };

    applyPresentation();
    // Refine the error card once the reachability check finishes.
    void reportConnectionFailure({
        evidence,
        run_id: runId,
        connect_attempts: connectAttempts ?? null,
    }).then((diagnostic) => applyPresentation(diagnostic));
}

/**
 * Apply a run's resolved citations, whichever frame carried them.
 *
 * Citations reach the client two ways. Current backends send them on their own
 * `run_citations` event, so `run_complete` no longer has to wait out a Zotero
 * lookup. Backends that predate CLIENT_FEATURES.CITATIONS_EVENT embed them in
 * `run_complete` instead. The two frames differ in when they arrive, not in
 * what the client does with what is inside them.
 */
function applyRunCitations(
    set: Setter,
    runId: string,
    citations: Citation[] | null | undefined,
): void {
    if (!citations || citations.length === 0) return;

    logger(`WS: Processing ${citations.length} citations for run ${runId}`, 1);
    set(citationsAtom, (prev) => [
        ...prev,
        ...citations.map(c => ({ ...c, run_id: runId }))
    ]);
    set(processCitationsAtom);
    set(maybeShowCitationTipAtom);

    // Preload PDF page labels for cited attachments so the rendering path can
    // resolve page numbers from explicit render state. Runs after metadata is
    // exposed to avoid blocking the UI on PDF extraction.
    preloadPageLabelsForCitations(citations)
        .then((labelsByAttachmentId) => {
            set(mergePageLabelsByAttachmentIdAtom, labelsByAttachmentId);
        })
        .catch((err) =>
            logger(`WS: Failed to preload page labels: ${err}`, 1)
        );
}

/**
 * Create WebSocket callbacks for handling streaming events.
 * Shared between sendWSMessageAtom and regenerateFromRunAtom.
 *
 * @param connectAttempts Reads how many attempts opened the connection these
 * callbacks belong to. A drop after `ready` has no attempt count of its own —
 * the connection it lost is the one that succeeded — so the number that
 * describes it is the number that got it open. Read lazily because the count is
 * only known once the connect settles, which is after these callbacks exist.
 */
/**
 * Write a finished run to the local database.
 *
 * Only for locally-executed runs: a cloud run is already stored server-side,
 * and writing it here too would leave two copies to disagree. Failure is logged
 * and swallowed — losing a transcript is bad, but taking the chat panel down
 * with a database error is worse, and the run is already rendered by the time
 * this is reached.
 */
/**
 * The library items a run drew on.
 *
 * Two sources, and they mean different things. Items the user staged on the
 * message are explicit references. The document open in the reader is an
 * implicit one — upstream's behaviour, which this fork keeps: asking a question
 * with a paper open is asking about that paper, and the run's context says so
 * whether or not the user attached it.
 */
function referencedItems(
    run: AgentRun,
): Array<{ libraryId: number; itemKey: string; source: string }> {
    const found = new Map<string, { libraryId: number; itemKey: string; source: string }>();
    const add = (libraryId: unknown, itemKey: unknown, source: string) => {
        const library = Number(libraryId);
        if (!Number.isFinite(library) || typeof itemKey !== 'string' || !itemKey) return;
        const dedupeKey = `${library}-${itemKey}`;
        // First writer wins, so an explicitly attached item is not relabelled
        // as merely open.
        if (!found.has(dedupeKey)) found.set(dedupeKey, { libraryId: library, itemKey, source });
    };

    for (const attachment of (run.user_prompt as any)?.attachments ?? []) {
        add(attachment?.library_id, attachment?.zotero_key, 'attachment');
        // An attachment's parent is the paper the user would look for.
        add(attachment?.library_id, attachment?.parent_key, 'attachment');
    }

    const reader = (run.user_prompt as any)?.application_state?.reader_state;
    if (reader) {
        add(reader.library_id, reader.zotero_key, 'reader');
        add(reader.library_id, reader.parent_key, 'reader');
    }

    return [...found.values()];
}

/**
 * Resolve and publish the citations a locally-run answer emitted.
 *
 * A cloud run received these on their own frame, already resolved. Running
 * locally, the tags arrive inside the answer text and nothing else will turn
 * them into sources — so the run's own completion is where that happens, using
 * the same store path the socket frame used.
 */
/**
 * Resolve the answer's citation tags and put them on screen.
 *
 * Returns the run carrying its citations under `metadata.citations`, which is
 * where the thread loader looks for them. Upstream the server attached them
 * before the run was ever stored; here the run is stored by this client, so
 * without this the sources were live-only — the markers rendered until the
 * thread was closed and came back empty, because the raw `<citation>` tags in
 * the stored text have nothing to resolve against on the way back in.
 */
function publishLocalCitations(run: AgentRun, set: Setter): AgentRun {
    if (!isLocalBrain()) return run;

    /*
     * Link the answer to the passages this run proposed highlights on.
     *
     * The model is handed a ready citation tag by the tool and does not place
     * it, so the answer quotes the passage, names the page, and gives the
     * reader nothing to click. Done here it is exact: the quote is matched in
     * the answer's own text and the marker goes right after it.
     */
    const proposed = takeProposedHighlights(run.id);
    const withHighlights = proposed.length
        ? withRewrittenAnswer(run, (text) => attachHighlightCitations(text, proposed))
        : run;

    /*
     * And link the pages the answer merely names.
     *
     * The same problem one level out: the model writes "on page 7" and leaves
     * the marker off, so the reader has the number and no way to get there.
     * Restricted to the pages this run actually highlighted — see
     * `attachPageCitations` for the answer that taught us why.
     */
    const read = takeReadAttachments(run.id);
    const highlightedPages = [...new Set(proposed.map((h) => h.page))];
    const linked = read.length === 1 && highlightedPages.length > 0
        ? withRewrittenAnswer(withHighlights, (text) =>
            attachPageCitations(text, read, highlightedPages))
        : withHighlights;

    /*
     * And tidy the marks the model wrote by hand instead of as tags.
     *
     * Two different failures with two different remedies: a bare attachment id
     * carries enough to rebuild the tag, so it is promoted into one and becomes
     * clickable; a locator label names a sentence in a document and is useful
     * to nobody once the answer is written, so it goes. Both happen despite the
     * prompt forbidding them.
     */
    /*
     * Sentence locators are promoted before the residue sweep: with exactly
     * one document read this run, `s223–s225` names a reachable passage and
     * becomes a clickable citation; with several documents it stays ambiguous
     * and the strip below removes it as before, because a link that can jump
     * into the wrong paper is worse than no link.
     */
    const soleReadId = read.length === 1 ? read[0] : null;
    /*
     * And check every `loc` against the labels this run was actually shown
     * (read_document text) or handed (search hits). The model composes `loc`
     * from the labels it read, which is what makes a citation land on the
     * sentence — and a label it made up would land the reader on the wrong
     * one. Unknown labels are dropped; the citation keeps its page.
     */
    const shownLocators = takeShownLocators(run.id);
    // Taken here, before any early return, so a run that cited nothing does
    // not leave its page text behind in the record.
    const shownText = takeShownText(run.id);
    const cleaned = withRewrittenAnswer(
        linked,
        (text) => validateComposedLocators(
            stripStrayLocators(
                promoteBareSentenceLocators(promoteBareReferences(text), soleReadId),
            ),
            shownLocators,
        ),
    );

    const answer = finalAnswerText(cleaned as any);
    if (!answer.includes('<citation')) return cleaned;

    const service = (Zotero as any).AlphainZ?.citationService;
    const format = service
        ? (item: Zotero.Item) => service.formatCitation(item, true)
        : undefined;

    // A paper the model found on the web has no local item to describe it. The
    // search that found it cached the metadata under the same id the citation
    // names, so that is where the row's title and bibliographic line come from.
    const externalRefs = store.get(externalReferenceMappingAtom);
    const lookupExternal = (externalId: string) => {
        const ref = externalRefs[externalId];
        if (!ref) return undefined;
        const first = ref.authors?.[0];
        const surname = first ? extractAuthorLastName(first) : undefined;
        const many = (ref.authors?.length ?? 0) > 2;
        const name = surname
            ? `${surname}${many ? ' et al.' : ''}${ref.year ? `, ${ref.year}` : ''}`
            : ref.title;
        return {
            ...(name ? { display_name: name } : {}),
            formatted_citation: formatExternalCitation(ref),
        };
    };

    /*
     * What this run learned about the passages it cited.
     *
     * A highlight proposal knows both the sentence and its rects, so a citation
     * on that page can carry them: the hover card shows the sentence instead of
     * the bibliographic line, and clicking opens the PDF with the passage
     * highlighted rather than just turning to the page.
     */
    const evidence = new Map<string, CitationEvidence>();
    for (const highlight of proposed) {
        evidence.set(evidenceKey(highlight.attachmentId, highlight.page), {
            text: highlight.text,
            ...(highlight.boxes ? { boxes: highlight.boxes } : {}),
        });
    }

    /*
     * And the sentences the answer cites by label.
     *
     * `loc="s12"` names one sentence of one page. The run was shown that
     * sentence — as read_document text or inside a search hit — and kept it, so
     * the hover card can show the sentence back instead of "Page 7". Text
     * only: the click resolves the rectangles from the cached extraction, as
     * it already did.
     */
    const locatorEvidence = (attachmentId: string, loc: string) => {
        const passage = passageForLocator(loc, shownText.get(attachmentId));
        return passage ? { text: clipPassage(passage.text), page: passage.page } : undefined;
    };

    try {
        const citations = resolveCitationsInText(answer, format, lookupExternal, evidence, locatorEvidence);
        if (citations.length === 0) return cleaned;
        applyRunCitations(set, linked.id, citations);
        /*
         * `cleaned`, not `linked`.
         *
         * This returned the run from *before* the cleanup rewrite, so the
         * promotion of bare ids and the removal of locator labels were thrown
         * away on exactly the path where they had worked — promoting an id
         * creates a citation, which makes this branch the one that runs. Every
         * answer that needed the fix was the one that did not get it, and
         * `[u-GPQ4HIAG]` went on reaching the user. Found by an evaluation
         * sweep: forty bare ids across fifty-two answers.
         */
        return {
            ...cleaned,
            metadata: { ...(cleaned.metadata ?? {}), citations },
        } as AgentRun;
    } catch (error) {
        // A citation failure must not take the answer down with it.
        logger(`publishLocalCitations: ${error}`, 1);
        return cleaned;
    }
}

/**
 * Replace the placeholder name with one the model writes.
 *
 * The name is the first 35 characters of the opening message, which reads as a
 * title without being one — a list of them says nothing about which
 * conversation is which. Only for the first answer in a thread, and only while
 * the name is still that placeholder: a title the user typed, or one already
 * generated, is not something to overwrite.
 *
 * Detached and silent. It is one small request after the answer is already on
 * screen, so it costs no latency, and a failure leaves the old name rather
 * than an empty row.
 */
async function nameThreadFromContent(
    db: any,
    run: AgentRun,
    threadId: string,
): Promise<void> {
    try {
        // The first answer the thread got. Runs that never finished are stored
        // too (a question the user stopped), and they do not make this one any
        // less the first answer.
        const runs = await db.getRunsForThread?.(threadId);
        if (!Array.isArray(runs) || runs.length === 0) return;
        const answered = runs.filter((stored: AgentRun) => stored?.status === 'completed');
        if (answered.length !== 1 || answered[0].id !== run.id) return;

        const userId = run.user_id || LOCAL_USER_ID;
        const thread = await db.getThread?.(userId, threadId);
        const question = String(run.user_prompt?.content ?? '').trim();
        // The placeholder is the opening message's, which is the first run's.
        const placeholder = String(runs[0]?.user_prompt?.content ?? '').trim().substring(0, 35);
        const current = String(thread?.name ?? '').trim();
        if (!current || current !== placeholder) return;

        const agent = buildAgentFromPrefs();
        if (!agent.ok) return;

        const title = await generateThreadTitle(agent.provider, question, finalAnswerText(run as any));
        if (!title || title === current) return;

        await db.setThreadName?.(threadId, userId, title);
        if (store.get(currentThreadIdAtom) === threadId) {
            store.set(currentThreadNameAtom, title);
        }
        store.set(threadsChangedAtom, (n: number) => n + 1);
        await mirrorRenamedThread(threadId, userId);
    } catch (error) {
        logger(`nameThreadFromContent: ${threadId}: ${error}`, 1);
    }
}

/** Push the new name into the mirrored copy, so the other machine sees it too. */
async function mirrorRenamedThread(threadId: string, userId: string): Promise<void> {
    try {
        const backend = getConversationBackend();
        if (!backend) return;
        await backend.writeThread(
            (Zotero as any).AlphainZ?.db, userId, threadId, new Date().toISOString(),
        );
    } catch (error) {
        logger(`mirrorRenamedThread: ${threadId}: ${error}`, 1);
    }
}

/**
 * Store one local run as it is right now, queued behind its earlier writes.
 *
 * Everything written is read when this is called, not when the write lands:
 * the run, the agent actions recorded against it (they are stored with it, and
 * come back with the thread — see `loadLocalThreadRuns`), and the thread's
 * placeholder name. A thread switch may replace all of those before the
 * database gets to the write.
 *
 * A run with no thread is its own thread: the local runner uses the run id as
 * the thread id, so the two agree without a server to assign one.
 */
function saveLocalRun(db: any, run: AgentRun): { threadId: string; userId: string; written: Promise<boolean> } {
    const threadId = run.thread_id ?? run.id;
    const userId = run.user_id || LOCAL_USER_ID;
    noteStoredRunThread(run.id, threadId);
    const actions = (store.get(threadAgentActionsAtom) as AgentAction[])
        .filter((action) => action.run_id === run.id);
    const openThreadId = store.get(currentThreadIdAtom);
    // The name is client-side here (the first 35 characters of the opening
    // message) — there is no server to generate one — so it is stored with the
    // run when the thread row does not have one yet.
    const name = openThreadId === null || openThreadId === threadId
        ? store.get(currentThreadNameAtom)
        : null;
    const written = queueLocalRunWrite(run.id, async () => {
        await db.saveRun({
            id: run.id,
            thread_id: threadId,
            user_id: userId,
            created_at: run.created_at,
            payload: { ...run, thread_id: threadId, [STORED_AGENT_ACTIONS_FIELD]: actions },
        });
        noteStoredAgentActions(run.id, actions);
        noteStoredProposals(actions);
        /*
         * Only while the row has none. Once named, the name is the user's own
         * (a rename from the history list or the header) or the title written
         * from the first answer, and neither is a later run's to overwrite.
         */
        if (name && db.setThreadName) {
            const thread = await db.getThread?.(userId, threadId);
            if (!thread?.name) await db.setThreadName(threadId, userId, name);
        }
    });
    return { threadId, userId, written };
}

/**
 * Mirror a thread into the Zotero library (or the sync folder), if the user
 * asked for that.
 *
 * Detached and swallowed on purpose: this writes an item and a file, and a
 * library that is momentarily locked, read-only or mid-sync must not turn a
 * finished answer into an error. The next write rewrites the same attachment,
 * so a miss costs one version, not the thread.
 */
function mirrorThreadInBackground(db: any, userId: string, threadId: string): void {
    const backend = getConversationBackend();
    if (!backend) return;
    void (async () => {
        try {
            await backend.writeThread(db as any, userId, threadId, new Date().toISOString());
        } catch (error) {
            logger(`mirrorThreadInBackground: could not mirror thread ${threadId}: ${error}`, 1);
        }
    })();
}

async function persistRunLocally(run: AgentRun): Promise<void> {
    const db = localRunDb();
    if (!db?.saveRun) return;

    const { threadId, userId, written } = saveLocalRun(db, run);
    if (!(await written)) return;
    try {
        await db.recordThreadItems(threadId, referencedItems(run));
        // A history list that is already open has no other way to learn the
        // thread's name and timestamp just changed.
        store.set(threadsChangedAtom, (n: number) => n + 1);
        void nameThreadFromContent(db, run, threadId);
        // After everything above persisted (including the citation rewrite,
        // which ran before this function), the thread may have earned a
        // rolling summary. Fire-and-forget: a failure leaves the plain replay.
        void maybeCompactThread(db as any, userId, threadId);
    } catch (error) {
        logger(`persistRunLocally: failed to store run ${run.id}: ${error}`, 1);
        return;
    }
    mirrorThreadInBackground(db, userId, threadId);
}

/**
 * Store a run the moment it is sent, before the model has said anything.
 *
 * A run that never finishes — stopped, cut off by Zotero quitting or the
 * plugin updating — would otherwise leave nothing behind, and the chat would
 * reopen without the question in it.
 *
 * Stored as the stopped turn it becomes if nothing more is heard from it: the
 * answer, or the stopped copy with what had streamed, replaces it when the run
 * ends. Stored runs are read by more than this chat — the summary of older
 * exchanges, the copy mirrored to the user's other computer — and none of
 * them can tell a turn still being written here from one a crash cut off.
 */
function persistLocalRunShell(run: AgentRun): void {
    const db = localRunDb();
    if (!db?.saveRun) return;
    void saveLocalRun(db, { ...run, status: 'canceled' }).written;
}

/** Store a run that was stopped, with whatever it had streamed by then. */
function persistCanceledLocalRun(run: AgentRun): void {
    const db = localRunDb();
    if (!db?.saveRun) return;
    const { threadId, userId, written } = saveLocalRun(db, run);
    void written.then(async (ok) => {
        if (!ok) return;
        try {
            await db.recordThreadItems?.(threadId, referencedItems(run));
        } catch (error) {
            logger(`persistCanceledLocalRun: could not record items for ${run.id}: ${error}`, 1);
        }
        store.set(threadsChangedAtom, (n: number) => n + 1);
        mirrorThreadInBackground(db, userId, threadId);
    });
}

/**
 * Keep a finished local run's stored copy in step with its agent actions.
 *
 * What a run proposed, and what the user did about it — applied, rejected,
 * undone, a change queued for review — is recorded after the run has been
 * stored, often long after: the cards are decided once the answer is there to
 * judge them against. Each record is saved into the run it belongs to as it
 * arrives or changes, so the Applied/Rejected cards and their Undo survive a
 * thread switch and a restart, and a Retry after reopening knows what to undo.
 *
 * A run still streaming is saved with its actions when it ends. While a
 * conversation is being loaded, what arrives for its runs is the stored copy
 * (and the loader's check of it against the library), so that is not written
 * back — only a decision that landed during the load: a record the stored copy
 * does not have, or a proposal it holds undecided that has since been decided
 * (see `storedProposalIds`). That, and any record for a run of another
 * conversation, is merged into the run's stored copy
 * (`mergeActionsIntoStoredRun`).
 */
const queuedActionSignatures = new Map<string, string>();

/**
 * Proposals the database is known to hold undecided, by action id: as this
 * session last wrote them, or last saw them on screen as the stored copy.
 *
 * A decision on a proposal keeps the proposal's id and changes its status,
 * whether it is made on the proposal's card or with the record's own Apply and
 * Reject. While a conversation loads, a status change on screen is otherwise
 * taken for the stored copy being checked against the library, which is not
 * written back. That check only ever marks an applied change undone; it never
 * decides a pending proposal. So a proposal stored undecided and decided on
 * screen is the user's decision, and it is stored like a record the database
 * does not have.
 */
const storedProposalIds = new Set<string>();

/** Record that the database holds these actions in the state they are in. */
function noteStoredProposals(actions: readonly AgentAction[]): void {
    for (const action of actions) {
        if (action.status === 'pending') storedProposalIds.add(action.id);
        else storedProposalIds.delete(action.id);
    }
}

/** Whether any of these actions decides a proposal the database holds undecided. */
function decidesStoredProposals(actions: readonly AgentAction[]): boolean {
    return actions.some((action) => action.status !== 'pending' && storedProposalIds.has(action.id));
}

/** Mirror writes for action changes, held briefly so a burst of decisions writes once. */
const pendingActionMirrors = new Map<string, ReturnType<typeof setTimeout>>();

function mirrorThreadSoon(db: any, userId: string, threadId: string): void {
    const pending = pendingActionMirrors.get(threadId);
    if (pending) clearTimeout(pending);
    pendingActionMirrors.set(threadId, setTimeout(() => {
        pendingActionMirrors.delete(threadId);
        mirrorThreadInBackground(db, userId, threadId);
    }, 3000));
}

function saveChangedAgentActions(): void {
    const db = localRunDb();
    if (!db?.saveRun) return;
    const actions: AgentAction[] = store.get(threadAgentActionsAtom);
    if (actions.length === 0) return;

    const byRun = new Map<string, AgentAction[]>();
    for (const action of actions) {
        if (!action.run_id) continue;
        const forRun = byRun.get(action.run_id);
        if (forRun) forRun.push(action);
        else byRun.set(action.run_id, [action]);
    }

    const loading = store.get(isLoadingThreadAtom);
    const openThreadId = store.get(currentThreadIdAtom);
    const activeRunId = store.get(activeRunAtom)?.id ?? null;
    const runs: AgentRun[] = store.get(threadRunsAtom);
    for (const [runId, forRun] of byRun) {
        if (runId === activeRunId) continue;
        const run = runs.find((candidate: AgentRun) => candidate.id === runId);
        const threadId = storedRunThread(runId) ?? (run ? run.thread_id ?? run.id : null);
        if (threadId !== null && threadId !== openThreadId) {
            mergeActionsIntoStoredRun(db, runId, threadId, forRun);
            continue;
        }
        if (loading) {
            if (threadId !== null
                && (includesUnstoredAgentActions(runId, forRun) || decidesStoredProposals(forRun))) {
                mergeActionsIntoStoredRun(db, runId, threadId, forRun);
            } else {
                noteStoredAgentActions(runId, forRun);
                noteStoredProposals(forRun);
            }
            continue;
        }
        if (!run) continue;
        if (!differsFromStoredAgentActions(runId, forRun)) {
            noteStoredProposals(forRun);
            continue;
        }
        const signature = agentActionsSignature(forRun);
        if (queuedActionSignatures.get(runId) === signature) continue;
        queuedActionSignatures.set(runId, signature);
        const { threadId: savedThreadId, userId, written } = saveLocalRun(db, run);
        void written.then((ok) => {
            if (queuedActionSignatures.get(runId) === signature) queuedActionSignatures.delete(runId);
            if (ok) mirrorThreadSoon(db, userId, savedThreadId);
        });
    }
}

/**
 * Write records into a run's stored copy, next to what that copy already
 * holds, without the run itself to hand.
 *
 * For a decision that lands where no save of the run would pick it up. An
 * Apply that takes a moment to finish, or Approve All pressed while another
 * chat is open, adds its record to the list on screen — another
 * conversation's, where no card shows it — or arrives while the run's own
 * conversation is still being loaded. The record is stored with its run
 * either way, and taken off another conversation's list; it comes back when
 * its conversation is opened.
 */
function mergeActionsIntoStoredRun(db: any, runId: string, threadId: string, actions: AgentAction[]): void {
    if (!db.getRunsForThread) return;
    const signature = agentActionsSignature(actions);
    if (queuedActionSignatures.get(runId) === signature) return;
    queuedActionSignatures.set(runId, signature);
    const arrivingIds = new Set(actions.map((action) => action.id));
    let userId = LOCAL_USER_ID;
    const written = queueLocalRunWrite(runId, async () => {
        const storedRuns: any[] = await db.getRunsForThread(threadId);
        const stored = storedRuns.find((candidate) => candidate?.id === runId);
        if (!stored) throw new Error(`run ${runId} is not stored under thread ${threadId}`);
        userId = stored.user_id || LOCAL_USER_ID;
        const kept = Array.isArray(stored[STORED_AGENT_ACTIONS_FIELD])
            ? (stored[STORED_AGENT_ACTIONS_FIELD] as AgentAction[]).filter((action) => !arrivingIds.has(action?.id))
            : [];
        const merged = [...kept, ...actions];
        await db.saveRun({
            id: runId,
            thread_id: threadId,
            user_id: userId,
            created_at: stored.created_at,
            payload: { ...stored, thread_id: threadId, [STORED_AGENT_ACTIONS_FIELD]: merged },
        });
        noteStoredAgentActions(runId, merged);
        noteStoredProposals(merged);
    });
    void written.then((ok) => {
        if (queuedActionSignatures.get(runId) === signature) queuedActionSignatures.delete(runId);
        if (!ok) return;
        mirrorThreadSoon(db, userId, threadId);
        // Unless its own conversation has been opened meanwhile: then the list
        // on screen is that conversation's, read back with these records in it.
        if (store.get(currentThreadIdAtom) === threadId) return;
        store.set(threadAgentActionsAtom, (current: AgentAction[]) =>
            current.filter((action) => !(action.run_id === runId && arrivingIds.has(action.id))));
    });
}

// =============================================================================
// Local runs in flight
// =============================================================================

/** A locally-run request, from the moment it is handed to the model until it ends. */
interface LocalRun {
    runId: string;
    /** Aborts the model request in flight and every step after it. */
    controller: AbortController;
    /** Whether the runner has reported the run's thread — its first event. */
    reportedThread: boolean;
    /** Whether the run ended on its own, while it still held the active slot. */
    finished: boolean;
}

/**
 * The local runs this bundle is driving, by run id.
 *
 * A local run keeps going only while its shell holds the active slot. Stop,
 * New chat, Switch chat, retrying the run while it streams, and shutdown all
 * take it out of the slot, and that is what ends it (`stopLocalRunsThatLeftTheSlot`):
 * the model request is aborted, nothing more is dispatched, and the canceled
 * copy the path archived is saved. One rule rather than a call at each of
 * those paths, because they all end the run the same way and one that forgot
 * would leave a loop billing, asking and writing in the background.
 */
const localRuns = new Map<string, LocalRun>();

/** Whether this bundle is driving a local run that has not ended. */
function hasLiveLocalRun(): boolean {
    for (const localRun of localRuns.values()) {
        if (!localRun.finished && !localRun.controller.signal.aborted) return true;
    }
    return false;
}

function stopLocalRunsThatLeftTheSlot(): void {
    if (localRuns.size === 0) return;
    const activeRunId = store.get(activeRunAtom)?.id ?? null;
    for (const localRun of localRuns.values()) {
        if (localRun.finished || localRun.controller.signal.aborted) continue;
        if (localRun.runId === activeRunId) continue;
        logger(`stopLocalRunsThatLeftTheSlot: stopping local run ${localRun.runId}`, 1);
        localRun.controller.abort();
        // A highlight parked for this run's question was never linked: the run
        // had not reported its thread. It must not be linked to the next one.
        if (!localRun.reportedThread) clearPendingAnchor();
        const canceled = store.get(threadRunsAtom).find(
            (run: AgentRun) => run.id === localRun.runId && run.status === 'canceled',
        );
        if (canceled) persistCanceledLocalRun(canceled);
    }
}

/**
 * Offers to save a selection answer into its highlight, by popup id, with the
 * conversation each belongs to. One per highlight: a newer answer about the
 * same highlight takes the id, and its card the place, of the older one. Each
 * is withdrawn when its conversation is no longer the one on screen.
 */
const selectionCommentOffers = new Map<string, { threadId: string; offer: object }>();

function withdrawSelectionCommentOffersOfOtherThreads(): void {
    if (selectionCommentOffers.size === 0) return;
    const openThreadId = store.get(currentThreadIdAtom);
    for (const [popupId, { threadId }] of [...selectionCommentOffers]) {
        if (threadId === openThreadId) continue;
        selectionCommentOffers.delete(popupId);
        store.set(removePopupMessageAtom, popupId);
    }
}

let runStateObserversRegistered = false;

/**
 * Start following the run state the functions above watch.
 *
 * Each follows one piece of state wherever it changes, so no writer of that
 * state can bypass it. Registered on first use — the first run, the first
 * thread read back from the database, the first selection offer — rather than
 * at module scope: `agentActions` and this module import each other (through
 * the diff preview), so its atoms may not be initialized yet while this module
 * is evaluated.
 */
function ensureRunStateObservers(): void {
    if (runStateObserversRegistered) return;
    runStateObserversRegistered = true;
    store.sub(activeRunAtom, stopLocalRunsThatLeftTheSlot);
    store.sub(threadAgentActionsAtom, saveChangedAgentActions);
    store.sub(currentThreadIdAtom, withdrawSelectionCommentOffersOfOtherThreads);
}

setLocalRunStorageHooks({ beforeRead: settleLocalRunWrites, afterRead: ensureRunStateObservers });

/**
 * Offer to save a selection answer into its highlight's comment.
 *
 * Zotero shows an annotation's comment when the highlight is clicked and syncs
 * it with the library, so that field — not a panel this plugin draws — is where
 * an anchored answer belongs. Offered rather than written by default: the
 * comment is the user's own annotation, and a preference exists for those who
 * want it automatic.
 *
 * One offer per highlight: asking about the same passage again replaces the
 * earlier offer rather than stacking a second card over the answer. An offer
 * belongs to its conversation and is withdrawn when another one is opened.
 */
async function offerSelectionComment(run: AgentRun, set: Setter): Promise<void> {
    const origin = run.user_prompt?.origin as any;
    if (origin?.kind !== 'selection_chat' || !origin.annotation_key) return;
    if (run.status !== 'completed') return;

    const answer = finalAnswerText(run as any);
    if (!answer) return;

    const entry = { question: run.user_prompt?.content ?? '', answer };
    const libraryId = Number(origin.library_id);
    const annotationKey = String(origin.annotation_key);

    if (getPref('selectionChatAutoComment')) {
        const result = await saveCommentToAnnotation(libraryId, annotationKey, entry);
        if (!result.saved) {
            set(addPopupMessageAtom, {
                type: 'error',
                title: t('Could not save the answer to the highlight'),
                text: result.message,
                expire: true,
                duration: 6000,
            });
        }
        return;
    }

    // Read the highlight so the card can name what it is about to change. A
    // highlight that has since been deleted needs no offer at all.
    const annotation = Zotero.Items.getByLibraryAndKey(libraryId, annotationKey) as
        | Zotero.Item
        | false;
    if (!annotation) return;

    // The conversation the answer is in. An offer for one the user has
    // already left would sit over a different chat.
    const threadId = run.thread_id ?? run.id;
    const openThreadId = store.get(currentThreadIdAtom);
    if (openThreadId && openThreadId !== threadId) return;

    const popupId = `selection-comment-${libraryId}-${annotationKey}`;
    // This offer, apart from a newer one that takes its place under the same
    // id: a Save still finishing here must not take that one's card away.
    const offer = {};
    const withdraw = () => {
        if (selectionCommentOffers.get(popupId)?.offer !== offer) return;
        selectionCommentOffers.delete(popupId);
        set(removePopupMessageAtom, popupId);
    };
    ensureRunStateObservers();
    selectionCommentOffers.set(popupId, { threadId, offer });

    set(addPopupMessageAtom, {
        id: popupId,
        type: 'info',
        title: t('Save to the highlight?'),
        expire: false,
        customContent: createElement(SelectionCommentOfferContent, {
            highlightText: annotation.annotationText || '',
            pageLabel: annotation.annotationPageLabel || null,
            preview: formatCommentEntry(entry),
            color: annotation.annotationColor || undefined,
            onReveal: () => {
                void navigateToAnnotation(annotation);
            },
            onDismiss: withdraw,
            onSave: async () => {
                const result = await saveCommentToAnnotation(libraryId, annotationKey, entry);
                if (result.saved) {
                    withdraw();
                } else if (result.reason === 'missing') {
                    // Nothing left to save into: the card goes, and says why.
                    withdraw();
                    set(addPopupMessageAtom, {
                        type: 'error',
                        title: t('Could not save'),
                        text: result.message,
                        expire: true,
                        duration: 4000,
                    });
                }
                // Any other failure keeps the card, which shows the reason and
                // lets Save be tried again.
                return result;
            },
        }),
    });
}

/**
 * End a run's "Retrying…" notice once the retried request produces output.
 *
 * The notice is raised by `retry` and otherwise lasts until the run completes
 * or fails, so a retry that worked would keep every later quiet stretch of the
 * same run reading "Retrying…" instead of the generating clock.
 */
function clearRetryNoticeOnOutput(set: Setter, runId: string): void {
    if (store.get(wsRetryAtom)?.runId === runId) set(wsRetryAtom, null);
}

export function createWSCallbacks(
    set: Setter,
    connectAttempts: () => number | null = () => null,
): WSCallbacks {
    /*
     * The local run these callbacks belong to, when they belong to one.
     *
     * The local executor builds its callbacks as the run starts, while the
     * run's shell holds the active slot, so that is the run they are for. From
     * then on they act only for it: once it has been stopped or replaced, a
     * loop still winding down must not stream into, finalize, save or unlock
     * the run that took its place — nor, with the slot empty, report its
     * thread over a chat the user has since opened. Callbacks for a socket run
     * are not tied to a local run and behave as before.
     */
    const localRun = localRuns.get(store.get(activeRunAtom)?.id ?? '') ?? null;
    const outlivedRun = (): boolean =>
        !!localRun && (
            localRun.finished
            || localRun.controller.signal.aborted
            || store.get(activeRunAtom)?.id !== localRun.runId
        );

    return {
        onReady: (data: WSReadyData) => {
            if (outlivedRun()) return;
            logger('WS onReady:', data, 1);
            set(isWSReadyAtom, true);
            set(wsReadyDataAtom, data);

            // A successful WS handshake proves the backend is reachable and the session is valid.
            // If the profile sync was stuck in transient/fatal (and its retry backoff or the OS
            // online event hasn't cleared it), force a refresh so the header indicator drops
            // promptly instead of lingering until the next backoff tick.
            if (store.get(profileSyncStatusAtom).kind !== 'ok') {
                triggerProfileRefresh();
            }

            // Show popup if subscription is active but using frontend processing
            if (data.subscriptionStatus === SubscriptionStatus.ACTIVE &&
                store.get(isDatabaseSyncSupportedAtom) &&
                data.processingMode === ProcessingMode.FRONTEND
            ) {
                set(addPopupMessageAtom, {
                    type: 'info',
                    title: t('Indexing your library'),
                    text: t('We are processing your library to enable Beta features. You can use standard features in the meantime.'),
                    expire: true,
                    duration: 10000
                });
            }
        },

        onRequestAck: (data: WSRequestAckData) => {
            logger('WS onRequestAck:', data, 1);
            set(wsRequestAckDataAtom, data);
        },

        onPart: async (event: WSPartEvent) => {
            if (outlivedRun()) return;
            // Stamped before the item-data load below, not after: the wait this
            // reports is the provider's, and our own lookup is not silence.
            streamActivity.noteActivity(event.run_id);
            clearRetryNoticeOnOutput(set, event.run_id);
            // Load item data for tool call
            if (event.part.part_kind === "tool-call") {
                logger(`WS onPart (${event.part.part_kind}):`, {
                    runId: event.run_id,
                    messageIndex: event.message_index,
                    part: event.part,
                });
                const itemReferences = extractZoteroReferencesFromToolCall(event.part);
                if (itemReferences.length > 0) {
                    logger(`WS onPart: Loading ${itemReferences.length} item data for tool call`, 1);
                    const itemPromises = itemReferences.map(async ref => {
                        const resolved = await resolveItemReference(ref);
                        return resolved.status === 'found' ? resolved.item : null;
                    });
                    const items = (await Promise.all(itemPromises)).filter((item): item is Zotero.Item => !!item);
                    if (items.length > 0) {
                        await loadFullItemDataWithAllTypes(items).catch(err => 
                            logger(`WS onPart: Failed to load item data for tool call: ${err}`, 1)
                        );
                    }
                }
            }
            // The run may have been stopped while its items loaded.
            if (outlivedRun()) return;
            // Update run with part
            set(activeRunAtom, (prev) => prev ? updateRunWithPart(prev, event) : prev);
        },

        onToolReturn: async (event: WSToolReturnEvent) => {
            if (outlivedRun()) return;
            streamActivity.noteActivity(event.run_id);
            clearRetryNoticeOnOutput(set, event.run_id);
            logger('WS onToolReturn:', {
                runId: event.run_id,
                messageIndex: event.message_index,
                toolName: event.part.part_kind === "tool-return" ? event.part.tool_name : undefined,
                toolCallId: event.part.part_kind === "tool-return" ? event.part.tool_call_id : undefined,
            });

            // Process tool return results
            if (event.part.part_kind === "tool-return") {
                await processToolReturnResults(event.part, set);

                // Safety net: the current backend ships a hydrated `metadata.view`
                // on every tool return, but synthesize one from the legacy summary
                // when it is missing OR malformed so the shared render layer always
                // has a valid view to render. The `isToolResultView` check matches
                // the render-time predicate; `upgradeToolReturn` no-ops on a valid view.
                if (!isToolResultView(event.part.metadata?.view)) {
                    logger(`WS onToolReturn: No view model available for tool call ${event.part.tool_call_id}`, 1);
                    const toolCallArgs = findToolCallArgs(store.get(activeRunAtom), event.part.tool_call_id);
                    await upgradeToolReturn(event.part, toolCallArgs);
                }
            }

            // The run may have been stopped while its result was processed.
            if (outlivedRun()) return;

            // Update run with tool return (event.part now carries a synthesized
            // `view` when the backend omitted one).
            set(activeRunAtom, (prev) => prev ? updateRunWithToolReturn(prev, event) : prev);

            // Remove pending approval for this specific tool call (if any)
            // Note: We find approval by toolCallId since that's what we have in the event
            if (event.part.part_kind === "tool-return") {
                const toolCallId = event.part.tool_call_id;
                // Get current pending approvals and find the one for this tool call
                const pendingMap = store.get(pendingApprovalsAtom);
                for (const [actionId, pending] of pendingMap.entries()) {
                    if (pending.toolcallId !== toolCallId) continue;
                    /*
                     * A locally proposed write is not stale just because its
                     * call returned.
                     *
                     * This removal assumes the blocking design: the tool
                     * suspended until the user answered, so a return meant the
                     * card had been dealt with and anything left over was
                     * debris. Proposals now return immediately, so the return
                     * arrived microseconds after the card was registered and
                     * deleted it — the card was never really on screen, the
                     * promise behind it was never answered, and nothing the
                     * agent proposed could be approved. Skip the ones still
                     * genuinely waiting on the user.
                     */
                    if (isLocalApprovalWaiting(actionId)) continue;
                    set(removePendingApprovalAtom, actionId);
                    break;
                }

                // Remove any pending question for this tool call. This covers
                // the backend-timeout path: after the wait expires the tool
                // returns 'no_response' and the run continues — without this
                // removal the stale card would keep the composer disabled for
                // the rest of the run (the full-clear sites only fire on run
                // end / disconnect / thread switch).
                set(removePendingQuestionAtom, toolCallId);

                // Remove any pending batch approval owned by this tool call,
                // covering the same backend-timeout path: batch_start returns
                // with no coverage granted and the run continues. Batch
                // approvals are keyed by approval id, so the owning entry is
                // the one whose toolcallId is the call that just returned.
                const pendingBatchApprovals = store.get(pendingBatchApprovalsAtom);
                for (const [approvalId, pending] of pendingBatchApprovals.entries()) {
                    if (pending.toolcallId === toolCallId) {
                        set(removePendingBatchApprovalAtom, approvalId);
                        break;
                    }
                }
            }
        },

        onToolCallProgress: (event: WSToolCallProgressEvent) => {
            if (outlivedRun()) return;
            streamActivity.noteActivity(event.run_id);
            logger(`WS onToolCallProgress: ${event.run_id} - ${event.tool_call_id} - ${event.progress}`, 1);
            set(activeRunAtom, (prev) => prev ? updateRunWithToolCallProgress(prev, event) : prev);
        },

        onToolCallArgsStream: (event: WSToolCallArgsStreamEvent) => {
            if (outlivedRun()) return;
            streamActivity.noteActivity(event.run_id);
            set(activeRunAtom, (prev) => prev ? updateRunWithToolCallArgsStream(prev, event) : prev);
        },

        onStreamingDone: (event: WSStreamingDoneEvent) => {
            if (outlivedRun()) return;
            logger('WS onStreamingDone:', { runId: event.run_id }, 1);
            // The model is done; what is left is the citation lookup, and the
            // footer reports that. Stop measuring rather than counting it as a
            // gap the model is sitting in.
            streamActivity.reset();
            set(streamingDoneRunIdsAtom, (prev) => new Set([...prev, event.run_id]));
        },

        onRunComplete: async (event: WSRunCompleteEvent) => {
            if (outlivedRun()) return;
            logger('WS onRunComplete:', {
                runId: event.run_id,
                usage: event.usage,
                cost: event.cost,
                citationsCount: event.citations?.length ?? 0,
                actionsCount: event.agent_actions?.length ?? 0,
                highTokenUsage: event.high_token_usage,
            }, 1);
            set(activeRunAtom, (prev) => prev ? updateRunComplete(prev, event) : prev);
            // Streaming-done is deliberately left set: this frame now arrives
            // as soon as the run is durable, with the citation lookup still
            // running, and that state is what tells the user their sources are
            // still being linked. `onRunCitations` ends it. A backend too old
            // to send that event embeds the citations below, and `onDone` —
            // which follows immediately — is the backstop there.

            // Clear retry state when run completes
            set(wsRetryAtom, null);

            // Store transient backend flags (not persisted on AgentRun)
            if (event.high_token_usage) {
                set(backendHighTokenUsageRunsAtom, (prev) => ({ ...prev, [event.run_id]: true }));
            }

            // Citations, for a backend that still embeds them here. Current
            // ones send `citations: null` and follow with `run_citations`.
            applyRunCitations(set, event.run_id, event.citations);

            // Process agent actions from run complete event
            if (event.agent_actions && event.agent_actions.length > 0) {
                logger(`WS onRunComplete: Processing ${event.agent_actions.length} agent actions`, 1);
                const actions = event.agent_actions.map(toAgentAction);
                set(addAgentActionsAtom, actions);
                set(recordAppliedActionsAtom, appliedActionIds(actions));
                // Load item data for agent actions
                await loadItemDataForAgentActions(actions).catch(err => 
                    logger(`WS onRunComplete: Failed to load item data for agent actions: ${err}`, 1)
                );
                // Auto-apply annotations if enabled
                autoApplyAnnotationAgentActions(event.run_id, actions);
                // Auto-create notes if enabled
                await autoCreateNoteAgentActions(event.run_id, actions, set).catch(err =>
                    logger(`WS onRunComplete: Failed to auto-create notes: ${err}`, 1)
                );
            }

            // Surface an OS-native notification if the user can't currently see
            // the completed response (e.g. working in another app).
            notifyRunComplete(event.run_id);
        },

        onRunCitations: (event: WSRunCitationsEvent) => {
            if (outlivedRun()) return;
            logger('WS onRunCitations:', {
                runId: event.run_id,
                citationsCount: event.citations?.length ?? 0,
            }, 1);

            applyRunCitations(set, event.run_id, event.citations);

            // The lookup is over — whatever it found, including nothing. Every
            // other way it can end (`done`, an error, a cancel, the socket
            // closing) clears this state wholesale; only the ordinary success
            // path needs it retired one run at a time.
            set(streamingDoneRunIdsAtom, (prev) => {
                if (!prev.has(event.run_id)) return prev;
                const next = new Set(prev);
                next.delete(event.run_id);
                return next;
            });
        },

        // The event's `retry_truncation` report is deliberately not consumed:
        // this client never asks the server to reconcile a thread mid-request
        // — retries commit their removal through `POST /truncate` before the
        // run request is sent.
        onThread: (newThreadId: string) => {
            if (outlivedRun()) return;
            if (localRun) localRun.reportedThread = true;
            logger('WS onThread:', { threadId: newThreadId }, 1);
            set(currentThreadIdAtom, newThreadId);
            set(activeRunAtom, (prev) => prev ? { ...prev, thread_id: newThreadId } : prev);
            // A conversation started from a highlight parked its anchor before
            // sending, because the thread had no id yet. This is where the id
            // first exists, so it is where the link is written.
            void drainPendingAnchor(newThreadId);
        },

        onThreadName: (event: WSThreadNameEvent) => {
            if (outlivedRun()) return;
            logger('WS onThreadName:', { threadId: event.thread_id, name: event.name }, 1);
            set(currentThreadNameAtom, event.name);
        },

        onDone: () => {
            // A stopped or replaced run was archived, and saved, by whatever
            // stopped it; the slot, the composer and the cards now belong to
            // someone else.
            if (outlivedRun()) return;
            // Before the slot empties below, so that leaving it is not read as
            // the run being abandoned.
            if (localRun) {
                localRun.finished = true;
                // A run that ended before it reported its thread never linked
                // the highlight parked for its question; the next run must not
                // claim it either.
                if (!localRun.reportedThread) clearPendingAnchor();
            }
            logger('WS onDone: Request fully complete', 1);
            streamActivity.reset();

            // Clear any remaining streaming-done state (safety net)
            set(streamingDoneRunIdsAtom, new Set<string>());

            // Move active run to completed runs
            set(activeRunAtom, (prev) => {
                if (prev) {
                    /*
                     * Notify here too, not only from `run_complete`.
                     *
                     * A local run never emits `run_complete` — it ends here —
                     * so the "response is ready" notification never fired for
                     * anyone running the model locally, which is everyone using
                     * this fork. The run id makes the server path's second call
                     * a no-op rather than a second notification.
                     */
                    notifyRunComplete(prev.id);
                    const finalRun: AgentRun = {
                        ...prev,
                        status: prev.status === 'in_progress' ? 'completed' : prev.status,
                        completed_at: prev.completed_at || new Date().toISOString(),
                    };
                    // Citations first: they are resolved onto the run, and the
                    // stored copy has to carry them or a reopened thread loses
                    // its sources.
                    const runWithCitations = publishLocalCitations(finalRun, set);
                    set(threadRunsAtom, (runs) => [...runs, runWithCitations]);
                    // Deliberately not awaited: this is the last step of a run
                    // that is already on screen, and the panel should not wait
                    // on a disk write to release.
                    void persistRunLocally(runWithCitations);
                    void offerSelectionComment(finalRun, set);
                }
                return null;
            });

            agentService.close();
            set(isWSChatPendingAtom, false);
            /*
             * Pending approvals deliberately survive the run.
             *
             * A proposal does not hold its run open — the tool returns at once
             * — so one still outstanding when the run ends is the normal case:
             * the cards are decided once the answer is there to judge them
             * against. Clearing them declines them, which would throw away
             * every highlight and paper the moment the answer finished. Only
             * the cards that do hold a run open are released here.
             */
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearAllPendingBatchApprovalsAtom);
            set(clearRunApprovalPolicyAtom);
        },

        onError: (event: WSErrorEvent) => {
            // A stopped run's loop reports its own end as it winds down; the
            // run was archived as canceled, and there is no error to show.
            if (outlivedRun()) return;
            logger('WS onError:', event, 1);
            const errorRunId = resolveErrorRunId(event, store.get(activeRunAtom));

            // Clear streaming-done state
            set(streamingDoneRunIdsAtom, new Set<string>());
            streamActivity.reset();

            // The connect loop in executeWSRequest reads this atom to tell a
            // server application error from a transport failure. Leaving it
            // null makes the connect rejection that follows a pre-ready error
            // look like a connection failure, which files a false connection
            // diagnostic.
            set(wsErrorAtom, event);
            set(activeRunAtom, (prev) => {
                if (!prev) return prev;
                if (errorRunId && prev.id !== errorRunId) return prev;
                return {
                    ...prev,
                    status: 'error',
                    error: toRunError(event),
                };
            });
            set(isWSChatPendingAtom, false);
            // Clear retry state on error
            set(wsRetryAtom, null);
            // Release the cards that held the run open. Proposals it made stay
            // pending: the failure does not decide them.
            set(retireUnanswerableApprovalsAtom);
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearAllPendingBatchApprovalsAtom);
            set(clearRunApprovalPolicyAtom);

            // Run quality flag for a run that did not complete. Keyed by run id
            // in an atom that never consults run status, so a failed run drives
            // the same composer warning a finished one does — the composer's
            // own fallback reads `total_usage`, which a failed run has none of.
            // Defensive: the backend carries this on the `run_complete` frame it
            // sends ahead of the error, so `onRunComplete` normally has it first.
            if (errorRunId && event.high_token_usage) {
                set(backendHighTokenUsageRunsAtom, (prev) => ({ ...prev, [errorRunId]: true }));
            }

            if (
                event.try_auto_resume &&
                errorRunId &&
                !store.get(scheduledAutoResumeRunIdsAtom).has(errorRunId)
            ) {
                // Retry when only thinking has streamed so far (nothing
                // user-visible to preserve). Otherwise resume from the
                // failure point so streamed text/tool calls are kept.
                //
                // If the failed run is itself a resume run, always auto-resume
                // — earlier runs in the resume chain may hold user-visible
                // content, and a retry would truncate the chain from its root.
                const failedRun = findRunForResume(
                    store.get(threadRunsAtom),
                    store.get(activeRunAtom),
                    errorRunId,
                );
                const retryInsteadOfResume =
                    !failedRun?.user_prompt.is_resume &&
                    hasOnlyThinkingParts(failedRun);

                set(scheduledAutoResumeRunIdsAtom, (prev: Set<string>) => {
                    const next = new Set(prev);
                    next.add(errorRunId);
                    return next;
                });

                // Run synchronously so the replacement run is set in the
                // same batch as the error state — React renders once with the
                // final state, avoiding an intermediate flash of the error or
                // resume placeholder.
                if (retryInsteadOfResume) {
                    store.set(autoRetryErroredRunAtom, errorRunId);
                } else {
                    store.set(autoResumeErroredRunAtom, errorRunId);
                }
            }
        },

        onWarning: (event: WSWarningEvent) => {
            if (outlivedRun()) return;
            logger('WS onWarning:', event, 1);
            set(wsWarningAtom, event);
            // Add to dismissable warnings
            set(addWarningAtom, {
                run_id: event.run_id,
                type: event.type,
                message: event.message,
                data: event.data,
            });
        },

        onRetry: (event: WSRetryEvent) => {
            if (outlivedRun()) return;
            logger('WS onRetry:', event, 1);
            set(wsRetryAtom, {
                runId: event.run_id,
                attempt: event.attempt,
                maxAttempts: event.max_attempts,
                reason: event.reason,
                waitSeconds: event.wait_seconds,
            });

            // A new wait, dated from the retry: `noteActivity` would drop an
            // already-showing indicator for a second, and leaving the old clock
            // would count seconds from the last token rather than from now.
            streamActivity.startWait(event.run_id);

            // If reset is true, clear any partial content that was streamed
            if (event.reset) {
                logger(`WS onRetry: resetting run messages for run ${event.run_id}`, 1);
                set(activeRunAtom, (prev) => prev ? resetRunMessages(prev) : prev);
            }
        },

        onAgentActions: async (event: WSAgentActionsEvent) => {
            if (outlivedRun()) return;
            logger('WS onAgentActions:', {
                runId: event.run_id,
                actionsCount: event.actions.length,
            }, 1);
            const actions = event.actions.map(toAgentAction);
            set(upsertAgentActionsAtom, actions);
            set(recordAppliedActionsAtom, appliedActionIds(actions));
            
            // Mark external references as imported for applied create_items actions
            // This handles cases where actions are applied via PendingActionsBar
            for (const action of actions) {
                if (
                    action.action_type === 'create_item' &&
                    action.status === 'applied' &&
                    action.result_data
                ) {
                    const proposedData = action.proposed_data as CreateItemProposedData;
                    const resultData = action.result_data as CreateItemResultData;
                    
                    if (proposedData?.item?.source_id && resultData.library_id && resultData.zotero_key) {
                        set(markExternalReferenceImportedAtom, proposedData.item.source_id, {
                            library_id: resultData.library_id,
                            zotero_key: resultData.zotero_key,
                            library_ref: resultData.library_ref,
                        });
                        logger(`WS onAgentActions: Marked external reference ${proposedData.item.source_id} as imported`, 1);
                    }
                }
            }
            
            // Load item data for agent actions
            await loadItemDataForAgentActions(actions).catch(err => 
                logger(`WS onAgentActions: Failed to load item data for agent actions: ${err}`, 1)
            );
            // Auto-apply annotations if enabled
            autoApplyAnnotationAgentActions(event.run_id, actions);
        },

        onMissingZoteroData: (event: WSMissingZoteroDataEvent) => {
            if (outlivedRun()) return;
            logger('WS onMissingZoteroData:', {
                runId: event.run_id,
                itemCount: event.items.length,
                items: event.items,
            }, 1);
            // Get userId from store for pending sync check
            const userId = store.get(userIdAtom);
            // Process asynchronously to determine reasons and add warning
            handleMissingZoteroData(
                event,
                userId,
                (params) => set(addWarningAtom, params)
            ).catch(err => 
                logger(`WS onMissingZoteroData: Failed to handle missing data: ${err}`, 1)
            );
        },

        onDeferredApprovalRequest: (event: WSDeferredApprovalRequest) => {
            logger('WS onDeferredApprovalRequest:', {
                actionId: event.action_id,
                toolcallId: event.toolcall_id,
                actionType: event.action_type,
            }, 1);

            // Cost confirmations arrive this way only from a backend that
            // predates the run-level credit confirmation. They are shown like
            // any other approval: what a request may spend is decided once per
            // run by the credit limit, never per tool call.

            // A grant can be selected while other validation requests are
            // already in flight. Catch those requests here even though future
            // validations will return always_apply directly.
            const runPolicy = store.get(runApprovalPolicyAtom);
            const activeRunId = store.get(activeRunAtom)?.id ?? null;
            if (isActionApprovedForCurrentRun(
                runPolicy,
                activeRunId,
                event.action_type,
                event.action_data,
            )) {
                logger(`Auto-approving ${event.action_type} for the current run`, 1);
                agentService.sendApprovalResponse(event.action_id, true);
                return;
            }

            // Default: add to pending approvals map for UI rendering
            set(addPendingApprovalAtom, event);
        },

        onDeferredApprovalStale: (event: WSDeferredApprovalStale) => {
            logger('WS onDeferredApprovalStale:', {
                actionId: event.action_id,
                reason: event.reason,
            }, 1);
            // The decision arrived after the backend stopped waiting, so the run
            // never saw it. Retire the approval and let the card fall back to
            // applying the (still valid) proposal locally.
            set(markApprovalStaleAtom, event.action_id);
            set(removePendingApprovalAtom, event.action_id);
            set(removeApprovalResponseIntentAtom, event.action_id);
        },

        onCreditConfirmationRequest: (event: WSCreditConfirmationRequest) => {
            logger('WS onCreditConfirmationRequest:', {
                confirmationId: event.confirmation_id,
                runId: event.run_id,
                pendingCredits: event.pending_credits,
                projectedTotalCredits: event.projected_total_credits,
                threshold: event.threshold,
            }, 1);
            // Always surface the card. Whether to ask at all, and above which
            // projected total, is decided by the backend from the preferences
            // sent with the run request.
            set(addPendingCreditConfirmationAtom, event);

            // Surface an OS-native notification if the user can't currently see
            // the card — the run stays parked until they decide.
            notifyCreditConfirmation(event);
        },

        onCreditConfirmationStale: (event: WSCreditConfirmationStale) => {
            logger('WS onCreditConfirmationStale:', {
                confirmationId: event.confirmation_id,
                reason: event.reason,
            }, 1);
            // The run moved on without the answer and there is nothing to apply
            // locally, so the card is simply retired.
            set(removePendingCreditConfirmationAtom, event.confirmation_id);
        },

        onBatchApprovalRequest: (event: WSBatchApprovalRequest) => {
            logger('WS onBatchApprovalRequest:', {
                approvalId: event.approval_id,
                runId: event.run_id,
                toolcallId: event.toolcall_id,
                batchId: event.batch_id,
                defaultMode: event.default_mode,
                hasDestructiveWarning: Boolean(event.destructive_warning),
            }, 1);
            set(addPendingBatchApprovalAtom, event);

            // Surface an OS-native notification if the user can't currently see
            // the card — the batch stays parked until they decide.
            notifyBatchApproval(event);
        },

        onBatchApprovalStale: (event: WSBatchApprovalStale) => {
            logger('WS onBatchApprovalStale:', {
                approvalId: event.approval_id,
                reason: event.reason,
            }, 1);
            // The batch moved on without the decision and there is nothing to
            // apply locally, so the card is simply retired.
            set(removePendingBatchApprovalAtom, event.approval_id);
        },

        onAskUserQuestionRequest: (event: WSAskUserQuestionRequest) => {
            logger('WS onAskUserQuestionRequest:', {
                questionId: event.question_id,
                toolcallId: event.toolcall_id,
                questionCount: event.questions.length,
            }, 1);
            set(addPendingQuestionAtom, event);

            // Surface an OS-native notification if the user can't currently see
            // the question panel (e.g. working in another app), mirroring the
            // deferred-approval path.
            notifyUserQuestion(event);
        },

        onOpen: () => {
            logger('WS onOpen: Connection established, waiting for ready...', 1);
            set(isWSConnectedAtom, true);
        },

        onClose: (code: number, reason: string, wasClean: boolean, transportEvidence) => {
            logger(`WS onClose: code=${code}, reason=${reason}, clean=${wasClean}`, 1);
            // Whether this connection had received the `ready` event, read
            // before the flag is cleared below. Distinguishes a connect-phase
            // failure (reported once by executeWSRequest's catch) from a
            // post-ready drop (handled here).
            const hadReachedReady = store.get(isWSReadyAtom);
            // set(activeRunAtom, null);
            set(isWSConnectedAtom, false);
            set(isWSReadyAtom, false);
            // A retry commit in flight owns the pending flag: this close
            // belongs to the failed run the retry is replacing (onError
            // dispatched it before the server closed the socket), and
            // clearing here would re-enable the composer mid-commit. The
            // retry flow clears or re-asserts the flag on every exit.
            if (!store.get(retryPendingRunIdAtom)) {
                set(isWSChatPendingAtom, false);
            }
            // Clear streaming-done state (connection lost during post-processing)
            set(streamingDoneRunIdsAtom, new Set<string>());
            streamActivity.reset();
            // Clear pending approvals and dismiss diff preview (connection lost)
            set(clearAllPendingApprovalsAtom);
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearAllPendingBatchApprovalsAtom);
            set(clearRunApprovalPolicyAtom);

            // A run that reached `completed` (run_complete processed) but whose
            // terminal `done` never arrived — the socket closed while run_complete
            // post-processing was still draining the message queue, so the queued
            // `done` was skipped by the connection-generation guard — lingers in
            // activeRunAtom. Finalize it the way onDone would, so the next send does
            // not overwrite and drop it from local history. Idempotent: the normal
            // path nulls activeRunAtom in onDone before close, making this a no-op.
            set(activeRunAtom, (prev) => {
                const finalRun = lingeringCompletedRun(prev);
                if (finalRun) {
                    set(threadRunsAtom, (runs) => appendRunIfMissing(runs, finalRun));
                    return null;
                }
                return prev;
            });

            // A post-ready close that carries transport evidence came from the real
            // socket (the client's own close()/cancel() paths notify without
            // evidence). When it lands while the run is still nonterminal the server
            // never delivered a terminal event — including a clean code-1000 close,
            // which would otherwise leave the run spinning forever with no error and
            // no retry. Connect-phase failures (before ready) are reported by
            // executeWSRequest's catch, so gate on hadReachedReady to avoid
            // double-reporting them.
            if (hadReachedReady && transportEvidence) {
                const activeRun = store.get(activeRunAtom);
                if (
                    activeRun &&
                    (activeRun.status === 'in_progress' ||
                        activeRun.status === 'awaiting_deferred')
                ) {
                    surfaceAndDiagnoseConnectionFailure(
                        set,
                        activeRun.id,
                        transportEvidence,
                        connectAttempts() ?? undefined,
                    );
                }
            }
        }
    };
}

/**
 * Connect loops this bundle currently owns, including pre-ready attempts and
 * backoff. `agentService.isConnected()` is false in that window, so shutdown
 * uses this count to abort an in-flight loop. Module-scoped: the store is
 * shared across windows, a connect loop is not.
 */
let connectLoopsInFlight = 0;

/**
 * Set once this bundle's client is going away. A send still preparing a
 * message has no socket or run yet; continuations check this so they don't
 * connect after the client is gone.
 */
let clientShutDown = false;

/** Test-only: reset `clientShutDown` between cases. */
export function clearClientShutDownLatch(): void {
    clientShutDown = false;
}

/**
 * Execute a WebSocket request with the given run and request.
 * Handles connection, callbacks, and error handling.
 * Model selection options are included in the request itself.
 *
 * Transient pre-`ready` transport failures (1005/1006, connect timeout) are
 * retried automatically with jittered backoff before anything is surfaced to
 * the user: a cold-starting instance or momentary network block routinely
 * succeeds on the next attempt. The shared loop owns that policy, including
 * which failures never qualify; this function owns only what the user and the
 * store see. One error surface and one diagnostics report (carrying the attempt
 * count) happen only after the final attempt fails.
 */
async function executeWSRequest(
    run: AgentRun,
    request: AgentRunRequest,
    get: Getter,
    set: Setter
): Promise<void> {
    // Every send/retry/resume lands here; stop if the client is already gone.
    if (clientShutDown) {
        logger('executeWSRequest: client is shutting down, not connecting', 1);
        set(abandonActiveRunLocallyAtom);
        return;
    }

    /**
     * Whether a different run has taken over the state this function writes.
     *
     * A run outlives its own place in the active slot — a connect loop by up to
     * one backoff, a local model loop by however long its last step takes to
     * notice it was stopped — and the reconnect state and the pending flag are
     * both connection-wide rather than per-run. So a run cancelled and followed
     * straight away by another leaves an older loop about to write over the
     * newer run's state — clearing a reconnect it is in the middle of, or
     * releasing a composer it is still holding.
     *
     * The newer request counts from the moment it raises the pending flag,
     * while its message is still being prepared and the slot is still empty.
     */
    const pendingFlagRaisesAtStart = pendingFlagRaises;
    const supersededByLiveRun = (): boolean => {
        if (pendingFlagRaises !== pendingFlagRaisesAtStart) return true;
        const activeRun = store.get(activeRunAtom);
        return (
            !!activeRun &&
            activeRun.id !== run.id &&
            (activeRun.status === 'in_progress' || activeRun.status === 'awaiting_deferred')
        );
    };

    /*
     * Local execution, when a model is configured in preferences.
     *
     * Placed here rather than at each of the four call sites (send, retry,
     * resume, regenerate) precisely because they all funnel through this
     * function — one branch covers every path and none of them can drift.
     *
     * The socket path below stays intact and reachable: it is what runs when no
     * local model is configured, which also makes this change reversible by
     * clearing a single preference.
     */
    if (isLocalBrain()) {
        ensureRunStateObservers();
        // Stopped while its message was still being prepared: nothing to run.
        if (store.get(activeRunAtom)?.id !== run.id) {
            logger(`executeWSRequest: run ${run.id} left the active slot before it started`, 1);
            if (!get(retryPendingRunIdAtom) && !supersededByLiveRun()) set(isWSChatPendingAtom, false);
            return;
        }
        logger(`executeWSRequest: running locally for run ${run.id}`, 1);
        const localRun: LocalRun = {
            runId: run.id,
            controller: new AbortController(),
            reportedThread: false,
            finished: false,
        };
        localRuns.set(run.id, localRun);
        persistLocalRunShell(run);
        try {
            await executeLocalRequest(run, request, get, set, localRun.controller.signal);
        } finally {
            localRuns.delete(run.id);
            // The pending flag holds the composer until a run resolves, and is
            // normally released by the socket closing. A local run has no
            // socket, so it releases it here — unless it was stopped and a
            // newer run, or a retry committing its removal, now holds it.
            if (!get(retryPendingRunIdAtom) && !supersededByLiveRun()) {
                set(isWSChatPendingAtom, false);
            }
        }
        return;
    }

    // How many attempts this run's connection cost, once it has one.
    let attemptsMade: number | null = null;

    connectLoopsInFlight++;
    const result = await connectWithRetry({
        service: agentService,
        request,
        callbacks: createWSCallbacks(set, () => attemptsMade),
        logLabel: `run ${run.id}`,
        // Every attempt starts from a clean ready state.
        onAttempt: () => set(isWSReadyAtom, false),
        onRetrying: (progress) => {
            if (supersededByLiveRun()) return;
            if (!progress) {
                set(wsReconnectingAtom, null);
                return;
            }
            // The failed attempt's own close cleared the pending flag on its way
            // out; restore it so the composer stays blocked while we quietly
            // retry.
            set(isWSChatPendingAtom, true);
            set(wsReconnectingAtom, progress);
        },
        // An error already set by the onError callback must not be overwritten
        // with a generic connection_error.
        isAlreadyReported: () => {
            const currentError = get(wsErrorAtom);
            return !!currentError && currentError.type !== 'connection_error';
        },
        // The run may have been cancelled, replaced, or rolled back during the
        // backoff wait — a retry whose tail was restored drops its shell here.
        isStillWanted: () => {
            const activeRun = store.get(activeRunAtom);
            return (
                activeRun?.id === run.id &&
                (activeRun.status === 'in_progress' || activeRun.status === 'awaiting_deferred')
            );
        },
    }).finally(() => {
        connectLoopsInFlight--;
    });

    attemptsMade = result.attemptsMade;

    if (result.kind === 'connected') return;

    if (result.kind === 'abandoned') {
        if (result.reason === 'already_reported') {
            logger('WS connection error: Error already set by onError callback, not overwriting', 1);
            // The onError that set this error may have dispatched an auto-retry
            // whose commit is now in flight and owns the pending flag (see
            // retryPendingRunIdAtom) — or a newer run may be holding it, which
            // this loop has no business releasing.
            if (!get(retryPendingRunIdAtom) && !supersededByLiveRun()) {
                set(isWSChatPendingAtom, false);
            }
            return;
        }
        logger(`WS connect retry abandoned: run ${run.id} is no longer active`, 1);
        // Release the flag the quiet retry raised. Nothing downstream clears it
        // on this path, and a stuck flag leaves the composer blocked with no run
        // to finish and no error to show. Unless the run that superseded this one
        // is now holding the flag for itself, in which case releasing it would
        // open the composer over a run that is still going.
        if (!supersededByLiveRun()) set(isWSChatPendingAtom, false);
        return;
    }

    surfaceAndDiagnoseConnectionFailure(set, run.id, result.evidence, result.attemptsMade);
    // Guarded like the abandoned paths above, because this one is reachable with
    // a newer run live too: an attempt can be in flight for twenty seconds, and a
    // run that starts in that window has already raised the flag for itself
    // before its own connect begins. Releasing it here would open the composer
    // over that run and let a second send go out behind it. The error itself
    // needs no such guard — it is filed against this run, and
    // `surfaceAndDiagnoseConnectionFailure` drops it if that run is gone.
    if (!supersededByLiveRun()) set(isWSChatPendingAtom, false);
}

/**
 * Send a chat message via WebSocket
 * 
 * Flow:
 * 1. Create AgentRun shell → set activeRunAtom → UI shows user message + spinner
 * 2. Connect WebSocket with auth params
 * 3. Receive "ready" event → send AgentRunRequest
 * 4. "part" events → update model_messages with text/thinking/tool_call
 * 5. "tool_return" events → add ToolReturnPart to model_messages
 * 6. "run_complete" event → update usage, set status="completed"
 * 7. "done" event → move activeRun to threadRuns, close connection
 */
export interface SendWSMessageOptions {
    runIdOverride?: string;
    permissionsOverride?: Partial<ChargingPermissions>;
    origin?: PromptOrigin;
    /** Saved actions invoked as /command tokens in the message content */
    actions?: PromptAction[];
}

/**
 * Let go of the highlight a selection question parked, when the question goes
 * no further than the send.
 *
 * The highlight waits for the thread its run reports (`drainPendingAnchor`).
 * A question that never became a run reports none, and the next run that does
 * — about something else entirely — would be recorded as the conversation
 * behind that highlight.
 *
 * Only the question's own highlight is let go: by the time a question is
 * turned away, a newer one may have parked its anchor in the same slot.
 */
function releaseAnchorOfUnsentQuestion(origin: PromptOrigin | undefined): void {
    if (!isSelectionChatOrigin(origin) || origin?.kind !== 'selection_chat') return;
    const { annotation_key: key, library_id: libraryID } = origin;
    if (key && typeof libraryID === 'number') clearPendingAnchor({ libraryID, key });
}

export const sendWSMessageAtom = atom(
    null,
    async (
        get,
        set,
        message: string,
        options?: SendWSMessageOptions,
    ) => {
        const { runIdOverride, permissionsOverride, origin, actions } = options ?? {};
        const isPending = get(isWSChatPendingAtom);
        logger('sendWSMessageAtom: Called at ' + Date.now() + ' with message: ' + message.substring(0, 50) + ' (isPending: ' + isPending + ')', 1);
        
        // Guard: Don't allow concurrent requests. The retry lock is checked
        // separately because the failed run's dying socket can clear the
        // pending flag mid-commit — the lock is released only by the retry
        // flow itself.
        if (isPending) {
            logger('sendWSMessageAtom: Blocked - already have request in progress', 1);
            releaseAnchorOfUnsentQuestion(origin);
            return;
        }
        if (retryCommitInFlight(get, 'sendWSMessageAtom')) {
            releaseAnchorOfUnsentQuestion(origin);
            return;
        }

        /*
         * Whether this message is the composer's draft (Enter in the
         * composer) or came from elsewhere — a suggestion chip, the reader's
         * Explain or selection popup, a launcher. A message from elsewhere
         * must not take the draft with it: its text and pills stay, and so do
         * the attachments a reader action marked as the user's (see
         * `composerDraftMarkAtom`).
         */
        const composerText = get(currentMessageContentAtom);
        const fromComposer = composerText.trim() !== '' && message.trim() === composerText.trim();
        const draftMark = fromComposer ? null : get(composerDraftMarkAtom);
        const reservedItemKeys = new Set(draftMark?.itemKeys ?? []);
        const reservedCollectionKeys = new Set(draftMark?.collectionKeys ?? []);
        const reservedExternalFileKeys = new Set(draftMark?.externalFileKeys ?? []);
        // A reader question staged while an answer was streaming is sent from
        // the composer later, and is still the kind of question it was asked
        // as — as long as the composer still holds it.
        const stagedPrompt = get(stagedReaderPromptAtom);
        const stagedOrigin = fromComposer && stagedPrompt?.origin && message.includes(stagedPrompt.text.trim())
            ? stagedPrompt.origin
            : undefined;
        const messageOrigin = origin ?? stagedOrigin;

        // Dismiss any open diff preview before sending
        dismissDiffPreview();

        // Reset state
        set(prepareForNewRunAtom);
        // Best effort: the worker is constructed here for the first time in a
        // session, and a failure to build it must not swallow the message.
        try {
            prewarmMuPDFWorker();
        } catch (error) {
            logger(`sendWSMessageAtom: worker prewarm failed: ${error}`, 2);
        }
        raisePendingFlag(set);
        const ownPendingFlagRaise = pendingFlagRaises;

        try {
            // Get current model and build model selection options for the request
            const model = get(selectedModelAtom);
            const modelOptions = buildModelSelectionOptions(model);

            // Log model and model selection info
            logger('Selected model:', model ? {
                id: model.id,
                name: model.name,
                provider: model.provider,
                is_custom: model.is_custom,
                allow_app_key: model.allow_app_key,
                allow_byok: model.allow_byok,
                access_mode: model.access_mode,
            } : null);
            logger('Model selection options:', {
                model_id: modelOptions.model_id || '(not set - using custom model or plan default)',
                hasApiKey: !!modelOptions.api_key,
            });

            // Custom instructions (if any)
        const customInstructions = getPref('customInstructions') || undefined;

        // Build attachments from current message items. Final send gate: drop
        // anything validation already rejected AND anything in a library the user
        // excluded from AlphainZ
        const validationResults = get(itemValidationResultsAtom);
        const searchableLibraryIds = get(searchableLibraryIdsAtom);
        const rawSelectedItems = get(currentMessageItemsAtom)
            .filter((item) => !reservedItemKeys.has(composerItemKey(item)));
        // Before the local libraries have loaded, the searchable set is empty
        // and every attached item would read as "excluded". Say what is
        // actually happening and let the user try again in a moment.
        if (rawSelectedItems.length > 0 && !get(isLibraryAccessReadyAtom)) {
            set(isWSChatPendingAtom, false);
            releaseAnchorOfUnsentQuestion(messageOrigin);
            set(addPopupMessageAtom, {
                type: 'warning',
                title: t('Libraries still loading'),
                text: t('AlphainZ is still reading your Zotero libraries. Try sending again in a moment.'),
                expire: true,
                duration: 4000,
            });
            return;
        }
        const rejectedSelectedItems = rawSelectedItems.filter((item) =>
            !searchableLibraryIds.includes(item.libraryID) ||
            isRejectedItemValidation(item, validationResults.get(`${item.libraryID}-${item.key}`))
        );
        const selectedItems = rejectedSelectedItems.length > 0
            ? rawSelectedItems.filter((item) => !rejectedSelectedItems.includes(item))
            : rawSelectedItems;
        if (rejectedSelectedItems.length > 0) {
            set(currentMessageItemsAtom, (items) => items.filter((item) => !rejectedSelectedItems.includes(item)));
            set(addPopupMessageAtom, {
                type: 'error',
                title: rejectedSelectedItems.length === 1 ? t('Item Removed') : t('Items Removed'),
                text: rejectedSelectedItems.length === 1
                    ? t('An item that AlphainZ cannot use was removed from this message.')
                    : t('{count} items that AlphainZ cannot use were removed from this message.', { count: rejectedSelectedItems.length }),
                expire: true,
                duration: 4000,
            });
        }

        // Load note data for any note items (getNoteTitle() requires 'note' data type)
        const currentNoteTabItem = get(currentNoteItemAtom);
        const noteItems = selectedItems.filter(item => item.isNote());
        const allNoteItems = currentNoteTabItem
            ? [...noteItems, currentNoteTabItem]
            : noteItems;
        if (allNoteItems.length > 0) {
            await Promise.all(allNoteItems.map(item => item.loadDataType('note')));
        }
        const regularItems = selectedItems.filter(item => item.isRegularItem());
        if (regularItems.length > 0) {
            await Zotero.Items.loadDataTypes(regularItems, ['itemData', 'creators']);
        }
        const attachmentItems = selectedItems.filter(item => item.isAttachment());
        if (attachmentItems.length > 0) {
            await Zotero.Items.loadDataTypes(attachmentItems, ['itemData']);
        }
        const attachmentParentItemsById = new Map<number, Zotero.Item>();
        for (const attachment of attachmentItems) {
            const parent = attachment.parentItem;
            if (parent) attachmentParentItemsById.set(parent.id, parent);
        }
        const attachmentParentItems = Array.from(attachmentParentItemsById.values());
        if (attachmentParentItems.length > 0) {
            await Zotero.Items.loadDataTypes(attachmentParentItems, ['itemData', 'creators']);
        }

        let attachments: MessageAttachment[] =
            selectedItems
                .map(item => toMessageAttachment(item))
                .filter((attachment): attachment is MessageAttachment => attachment !== null);
        attachments = await processImageAnnotations(attachments);

        // Add collection attachments if set
        const stagedCollections = get(currentMessageCollectionsAtom)
            .filter(col => !reservedCollectionKeys.has(collectionReferenceKey(col)));
        const messageCollections = stagedCollections
            .filter(col => searchableLibraryIds.includes(col.library_id));
        for (const col of messageCollections) {
            attachments.push({
                type: 'collection',
                library_id: col.library_id,
                zotero_key: col.zotero_key,
                library_ref: col.library_ref,
                name: col.name,
                parent_key: col.parent_key,
            });
        }

        // Add external file attachments (metadata only; content stays local and
        // is served on demand through the read/view request paths). Files whose
        // managed copy disappeared since attach are dropped with a popup.
        const externalFiles = get(currentMessageExternalFilesAtom)
            .filter((file) => !reservedExternalFileKeys.has(file.extKey));
        for (const file of externalFiles) {
            const exists = await IOUtils.exists(file.storedPath).catch(() => false);
            if (!exists) {
                logger(`sendWSMessageAtom: External file copy missing, dropping: ext-${file.extKey} ('${file.filename}')`, 1);
                set(addPopupMessageAtom, {
                    type: 'warning',
                    title: t('File unavailable'),
                    text: t('"{filename}" is no longer available and was removed from the message.', { filename: file.filename }),
                    expire: true,
                });
                continue;
            }
            const externalAttachment: ExternalFileAttachment = {
                type: 'external_file',
                ext_key: file.extKey,
                filename: file.filename,
                content_kind: file.contentKind,
                mime_type: file.mimeType,
                file_size: file.fileSize,
                ...(file.pageCount ? { page_count: file.pageCount } : {}),
                date_added: new Date(file.createdAt).toISOString(),
            };
            attachments.push(externalAttachment);
        }

        // Add the current reader attachment as a source if it is not already in
        // the thread. Reader position is captured in application state. Send gate:
        // never auto-attach a reader source in a library the user excluded from
        // Beaver — this path bypasses the currentMessageItems gate above.
        const readerAttachment = get(currentReaderAttachmentAtom);
        if (readerAttachment && searchableLibraryIds.includes(readerAttachment.libraryID)) {
            const allUserAttachmentKeys = get(allUserAttachmentKeysAtom);
            const existingKeys = new Set([
                ...attachments.map(messageAttachmentKey),
                ...allUserAttachmentKeys
            ]);
            logger(`sendWSMessageAtom: Handeling reader attachment - existingKeys: ${JSON.stringify(existingKeys)}`, 1);
            const readerKeys = zoteroReferenceLookupKeys({
                library_id: readerAttachment.libraryID,
                zotero_key: readerAttachment.key,
                library_ref: libraryRefForLibraryID(readerAttachment.libraryID),
            });
            if (!readerKeys.some(key => existingKeys.has(key))) {
                logger(`sendWSMessageAtom: Handeling reader attachment - Adding reader attachment: ${readerKeys[0]}`, 1);
                await Zotero.Items.loadDataTypes([readerAttachment], ['itemData']);
                if (readerAttachment.parentItem) {
                    await Zotero.Items.loadDataTypes([readerAttachment.parentItem], ['itemData', 'creators']);
                }
                attachments.push({
                    library_id: readerAttachment.libraryID,
                    zotero_key: readerAttachment.key,
                    library_ref: libraryRefForLibraryID(readerAttachment.libraryID) ?? undefined,
                    type: 'source',
                    attachment: safeStub(() => serializeAttachmentStub(readerAttachment)),
                    parent_item: safeStub(() => readerAttachment.parentItem ? serializeItemStub(readerAttachment.parentItem) : undefined),
                    include: 'fulltext'
                } as SourceAttachment);
            } else {
                logger(`sendWSMessageAtom: Handeling reader attachment - Skipping reader attachment: ${readerKeys[0]}`, 1);
            }

            /*
             * And the highlights on it, re-attached every turn.
             *
             * Deduping these against the thread the way the PDF is deduped
             * loses them: a highlight's text lives only in the context preamble
             * of the turn it was attached to, and history is replayed as the
             * raw text the user typed. Skipping it on turn two left the model
             * with an id and no quote, so a follow-up about the same highlights
             * got "I don't have them". Re-quoting thirty short lines is cheap;
             * the PDF is not, which is why only that one is deduped.
             */
            const readerAnnotations = get(readerAnnotationsAtom);
            const thisMessageKeys = new Set(attachments.map(messageAttachmentKey));
            for (const annotation of readerAnnotations) {
                const keys = zoteroReferenceLookupKeys({
                    library_id: annotation.libraryID,
                    zotero_key: annotation.key,
                    library_ref: libraryRefForLibraryID(annotation.libraryID),
                });
                if (keys.some((key) => thisMessageKeys.has(key))) continue;
                const attachment = toMessageAttachment(annotation);
                if (!attachment) continue;
                attachments.push(attachment);
                keys.forEach((key) => thisMessageKeys.add(key));
            }
        }

        // Add current note tab item as note attachment if not already present.
        // Send gate: never auto-attach a note in a library the user excluded from
        // Beaver — this path bypasses the currentMessageItems gate above.
        if (currentNoteTabItem && searchableLibraryIds.includes(currentNoteTabItem.libraryID)) {
            const allUserAttachmentKeys = get(allUserAttachmentKeysAtom);
            const existingKeys = new Set([
                ...attachments.map(messageAttachmentKey),
                ...allUserAttachmentKeys
            ]);
            const noteKeys = zoteroReferenceLookupKeys({
                library_id: currentNoteTabItem.libraryID,
                zotero_key: currentNoteTabItem.key,
                library_ref: libraryRefForLibraryID(currentNoteTabItem.libraryID),
            });
            if (!noteKeys.some(key => existingKeys.has(key))) {
                const noteAttachment = toMessageAttachment(currentNoteTabItem);
                if (noteAttachment) {
                    attachments.push(noteAttachment);
                }
            }
        }

        // Build filters payload
        const rawFilterState = get(currentMessageFiltersAtom);
        const sanitizedFilters = sanitizeMessageFiltersForSearchableLibraries(
            rawFilterState,
            searchableLibraryIds,
        );
        const filterState = sanitizedFilters.state;
        if (sanitizedFilters.changed) {
            set(currentMessageFiltersAtom, filterState);
        }
        const filterLibraries = filterState.libraryIds.length > 0
            ? filterState.libraryIds
                .map(id => Zotero.Libraries.get(id))
                .filter((l): l is Zotero.Library => !!l)
                .map(serializeZoteroLibrary)
            : null;
        const filterCollections = filterState.collectionIds.length > 0
            ? (await Promise.all(filterState.collectionIds.map((id) => {
                const collection = Zotero.Collections.get(id);
                return collection ? serializeCollection(collection) : null;
            }))).filter((collection): collection is ZoteroCollection => collection !== null)
            : null;
        const filterTags = filterState.tagSelections.length > 0
            ? filterState.tagSelections.map(tag => ({ ...tag }))
            : null;
        const filtersPayload: MessageSearchFilters = {
            libraries: filterLibraries,
            collections: filterCollections,
            tags: filterTags
        };

        // Tool requests (web search)
        const toolRequests = get(isWebSearchEnabledAtom) && get(isWebSearchAllowedAtom)
            ? [{ function: "search_external_references", parameters: {} } as ToolRequest]
            : undefined;

        // Application state (current view, reader/note state, library context,
        // indexing status). Built via the injectable provider so a non-Zotero
        // host can supply its own document state through the same slot.
        const applicationState = await getApplicationStateProvider()(get);

        /*
         * Stopped before it went out. Stop shows as soon as the flag is raised,
         * and Stop, New chat and Switch chat all let go of it — while the
         * message above was still being put together, with no run to stop yet.
         * It stays unsent; a draft it came from is still in the composer. A
         * request that started meanwhile — a retry, or a message sent after the
         * Stop — has raised the flag for itself, and it is that request's.
         */
        if (pendingFlagRaises !== ownPendingFlagRaise) {
            logger('sendWSMessageAtom: superseded before it was sent', 1);
            return;
        }
        if (!get(isWSChatPendingAtom)) {
            logger('sendWSMessageAtom: stopped before it was sent', 1);
            releaseAnchorOfUnsentQuestion(messageOrigin);
            return;
        }

        // Build the message
        const userPrompt: BeaverAgentPrompt = {
            content: message,
            ...(attachments.length > 0 ? { attachments } : {}),
            // TESTING ATTACHMENTS
            // attachments: [{library_id: 1, zotero_key: 'VV4QGPZN', type: 'source', include: 'fulltext'}], // TRASH ATTACHMENT
            // attachments: [{library_id: 1, zotero_key: 'B3ISAGTY', type: 'source', include: 'fulltext'}], // TRASH ITEM
            // attachments: [{library_id: 3, zotero_key: 'FR35E8GK', type: 'source', include: 'fulltext'}], // UNSYNCED LIBRARY ITEM
            // attachments: [{library_id: 3, zotero_key: 'V4W5CH8S', type: 'source', include: 'fulltext'}], // UNSYNCED LIBRARY ATTACHMENT
            // attachments: [{library_id: 1, zotero_key: 'SUEAB6YR', type: 'source', include: 'fulltext'}], // ZOTERO NOTE
            // attachments: [{library_id: 1, zotero_key: '85JCJJKS', type: 'source', include: 'fulltext'}], // ZOTERO SCREENSHOT
            // attachments: [{library_id: 1, zotero_key: '6U4SGES3', type: 'source', include: 'fulltext'}], // UNSYNCED ATTACHMENT
            application_state: applicationState,
            filters: filtersPayload,
            ...(toolRequests ? { tool_requests: toolRequests } : {}),
            ...(messageOrigin ? { origin: messageOrigin } : {}),
            ...(actions?.length ? { actions } : {}),
        };

        // Get current thread ID (null for new thread)
        const threadId = get(currentThreadIdAtom);

            // Set temporary thread name for new threads (mirrors backend thread_name_hint[:35])
            if (!threadId && message) {
                set(currentThreadNameAtom, message.substring(0, 35));
            }

            // Get user ID for the run
            const userId = get(userIdAtom);
            if (!userId) {
                logger('User ID not found', 1);
                set(isWSChatPendingAtom, false);
                releaseAnchorOfUnsentQuestion(messageOrigin);
                return;
            }

            // A failed run still in the active slot has to stay in local
            // history: the server persisted it, and overwriting the slot
            // without archiving would drop it from the client's view — a
            // ghost in the middle of the server thread.
            archiveTerminalActiveRun(get, set);

            // Create AgentRun shell and request
            const { run, request } = createAgentRunShell(
                userPrompt,
                threadId,
                userId,
                model?.name ?? 'unknown',
                modelOptions,
                model?.provider,
                customInstructions,
                model?.is_custom ? model.custom_model : undefined,
                runIdOverride,
                permissionsOverride,
            );

            // Set active run - UI now shows user message + spinner
            set(activeRunAtom, run);

            /*
             * And give it a row in history straight away.
             *
             * The row used to be written by `saveRun` when the answer landed,
             * so a conversation the user had just started was missing from the
             * chat history for as long as it took to answer — fourteen seconds
             * on a short question, and it reads as the history being broken.
             *
             * Detached and swallowed: this is a convenience, and a database
             * hiccup must not stop a message being sent. `saveRun` still
             * writes the row if this misses.
             */
            void (async () => {
                try {
                    const db = (Zotero as any).AlphainZ?.db;
                    const localThreadId = run.thread_id ?? run.id;
                    if (!db?.ensureThread || !localThreadId) return;
                    await db.ensureThread(
                        localThreadId,
                        run.user_id || LOCAL_USER_ID,
                        get(currentThreadNameAtom) || '',
                        run.created_at ?? new Date().toISOString(),
                    );
                    set(threadsChangedAtom, (n: number) => n + 1);
                } catch (error) {
                    logger(`sendWSMessageAtom: could not pre-create thread row: ${error}`, 1);
                }
            })();

            if (fromComposer) {
                // Reset user message input after creating the run
                set(clearComposerAtom);
                set(currentMessageItemsAtom, []);
                set(currentMessageCollectionsAtom, []);
                set(currentMessageExternalFilesAtom, []);
            } else {
                // The draft stays as the user left it; only what went out with
                // this message leaves the composer.
                const sentItems = new Set(rawSelectedItems.map(composerItemKey));
                const sentCollections = new Set(stagedCollections.map(collectionReferenceKey));
                const sentExternalFiles = new Set(externalFiles.map((file) => file.extKey));
                set(currentMessageItemsAtom, (items) =>
                    items.filter((item) => !sentItems.has(composerItemKey(item))));
                set(currentMessageCollectionsAtom, (collections) =>
                    collections.filter((col) => !sentCollections.has(collectionReferenceKey(col))));
                set(currentMessageExternalFilesAtom, (files) =>
                    files.filter((file) => !sentExternalFiles.has(file.extKey)));
                set(composerDraftMarkAtom, null);
            }
            set(removePopupMessagesByTypeAtom, ['items_summary']);

            // Execute the WebSocket request
            await executeWSRequest(run, request, get, set);
        } catch (error) {
            // Catch any unexpected errors during message preparation
            logger('sendWSMessageAtom: Unexpected error:', error, 1);
            set(wsErrorAtom, {
                event: 'error',
                type: 'preparation_error',
                message: error instanceof Error ? error.message : t('Failed to prepare message'),
                is_retryable: true,
            });
            set(activeRunAtom, null);
            set(isWSChatPendingAtom, false);
            // A run that failed this way has not reported a thread, and never will.
            releaseAnchorOfUnsentQuestion(messageOrigin);
        }
    }
);

/** How a regenerate path replaces the target run. */
interface RegenerateRunOptions {
    logPrefix: string;
    /**
     * Walk a resume chain back to its root so the regeneration starts from
     * the original user message (retry buttons). Edited-prompt retries target
     * the named run itself.
     */
    walkResumeChain: boolean;
    /** Replacement prompt; defaults to the target run's own prompt. */
    editedPrompt?: BeaverAgentPrompt;
    /** Failure message for the generic error card. */
    failureMessage: string;
    /**
     * Told once the user has agreed to what the retry removes, before
     * anything is removed. Not called when they cancel.
     */
    onProceed?: () => void;
}

/**
 * Ask before a retry removes the exchanges that came after it.
 *
 * Retrying replaces the target run and everything after it, and the removed
 * runs are deleted, not kept anywhere. That is expected when retrying the last
 * answer; further up the thread it discards turns the user may not realise
 * are part of the deal. Hosts without dialogs proceed as confirmed.
 */
function confirmRemovingLaterExchanges(laterExchanges: number, stopsAnswerBeingWritten: boolean): boolean {
    return getHost().dialogs?.confirm({
        title: t('Retry from here?'),
        text: `${laterExchangesSentence(laterExchanges, stopsAnswerBeingWritten)} ${t('They cannot be brought back.')}`,
        confirmLabel: t('Retry'),
    }) ?? true;
}

/**
 * What a retry takes with it, for the question asked before it goes ahead —
 * naming the answer still being written when that is one of them.
 */
function laterExchangesSentence(laterExchanges: number, stopsAnswerBeingWritten: boolean): string {
    if (stopsAnswerBeingWritten) {
        return tn(laterExchanges,
            'Retrying this message also removes the question and answer after it in this chat, including the answer still being written.',
            'Retrying this message also removes the {count} questions and answers after it in this chat, including the answer still being written.');
    }
    return tn(laterExchanges,
        'Retrying this message also removes the question and answer after it in this chat.',
        'Retrying this message also removes the {count} questions and answers after it in this chat.');
}

/**
 * Move whatever run holds the active slot into the thread, stopped if it was
 * still going — the later answer an earlier retry removes along with the rest.
 *
 * Leaving the slot is what stops a locally-run request (see `localRuns`), and
 * the canceled copy in the thread is what gets saved. Read from the slot as it
 * is now rather than as it was when the user was asked: the answer may have
 * gone on, or ended, while they decided. Returns the run as it went into the
 * thread, or null when the slot was empty.
 */
async function takeLaterRunOutOfSlot(get: Getter, set: Setter): Promise<AgentRun | null> {
    const laterRun = get(activeRunAtom);
    if (!laterRun) return null;
    const wasRunning = isRunActive(laterRun);
    const archived: AgentRun = wasRunning
        ? { ...laterRun, status: 'canceled', completed_at: new Date().toISOString() }
        : laterRun;
    set(threadRunsAtom, (runs) => appendRunIfMissing(runs, archived));
    set(activeRunAtom, null);
    if (wasRunning) await agentService.cancel();
    return archived;
}

/**
 * Regenerate a response from a specific run. The single implementation behind
 * every user-driven retry (retry button, error-card retry, edit-and-retry).
 *
 * Flow:
 * 1. Find the run to regenerate from (canceling it first if still live)
 * 2. Confirm what the retry removes: the later exchanges, a later answer still
 *    being written among them, and whether to undo applied agent actions
 *    (cancel aborts, nothing sent, and that later answer keeps going)
 * 3. Stop that later answer, then commit the removal on the backend
 *    (`POST /truncate`) — on failure or refusal nothing else has changed on
 *    either side, so the exits are a popup (plus a thread reload on refusal)
 *    and an intact thread
 * 4. Undo applied actions if the user chose to, remove the runs and their
 *    actions/citations locally
 * 5. Create the replacement run and execute it via WebSocket
 */
async function startRegenerateRun(
    get: Getter,
    set: Setter,
    runId: string,
    options: RegenerateRunOptions,
): Promise<void> {
    const { logPrefix, walkResumeChain, editedPrompt, failureMessage } = options;
    logger(`${logPrefix}: Regenerating from run ${runId}`, 1);

    // One retry at a time: retry controls of other runs stay clickable while
    // a commit is in flight, and a second truncation would race the first.
    if (retryCommitInFlight(get, logPrefix)) return;

    // Dismiss any open diff preview before regenerating
    dismissDiffPreview();

    let newRunId: string | null = null;

    try {
        // Get current model
        const model = get(selectedModelAtom);
        if (!model) {
            logger(`${logPrefix}: No model selected`, 1);
            return;
        }

        // Get user ID
        const userId = get(userIdAtom);
        if (!userId) {
            logger(`${logPrefix}: No user ID found`, 1);
            return;
        }

        // Fold a terminal run out of the active slot into thread history
        // before the removed set is computed: a failed run being replaced
        // contributes its applied actions to the confirm dialog and its ID
        // to the POSTed removal (it is persisted server-side).
        archiveAndClearTerminalActiveRun(get, set);

        // Find the run — a terminal run was archived into threadRuns above,
        // so only a still-live run is found through the active slot.
        const threadRuns = get(threadRunsAtom);
        const activeRun = get(activeRunAtom);

        let targetRun: AgentRun | null = null;
        let runIndex = threadRuns.findIndex(r => r.id === runId);
        // The target, stopped, when it was still running: it goes back into
        // the thread as stopped if the retry does not go ahead.
        let stoppedLiveTarget: AgentRun | null = null;

        if (runIndex >= 0) {
            targetRun = threadRuns[runIndex];
        } else if (activeRun?.id === runId) {
            // The run is currently active - cancel it and resubmit
            targetRun = activeRun;
            runIndex = threadRuns.length;
            stoppedLiveTarget = {
                ...activeRun,
                status: 'canceled',
                completed_at: new Date().toISOString(),
            };
            // Clear the active run before awaiting cancel: agentService.cancel()
            // waits for the cancel message to flush, and if the socket closes
            // uncleanly during that window, the onclose handler must not see this
            // run still marked active and misattribute the close as a connection
            // failure. The pending flag stays set until cancel resolves so the
            // composer guard keeps blocking new sends during the flush. Leaving
            // the slot is also what stops a local run's model loop.
            set(activeRunAtom, null);
            await agentService.cancel();
            set(isWSChatPendingAtom, false);
        }

        if (!targetRun) {
            logger(`${logPrefix}: Run ${runId} not found`, 1);
            return;
        }

        const keepStoppedTarget = () => {
            if (!stoppedLiveTarget) return;
            const stopped = stoppedLiveTarget;
            set(threadRunsAtom, (runs) => appendRunIfMissing(runs, stopped));
            persistCanceledLocalRun(stopped);
        };

        // If the target is a resume run, walk the resume chain back to the
        // root so we regenerate from the original user message, not from an
        // intermediate resume prompt (whose content is empty). The root
        // always lives in threadRuns — startResumeRun guarantees the failed
        // run is appended to threadRuns before the resume is started.
        if (walkResumeChain) {
            const allRunsForChain: AgentRun[] = activeRun && !threadRuns.some(r => r.id === activeRun.id)
                ? [...threadRuns, activeRun]
                : threadRuns;
            const rootRun = findResumeChainRoot(targetRun, allRunsForChain);
            if (rootRun.id !== targetRun.id) {
                const rootIndex = threadRuns.findIndex(r => r.id === rootRun.id);
                if (rootIndex >= 0) {
                    logger(`${logPrefix}: walking resume chain, using root run ${rootRun.id}`, 1);
                    targetRun = rootRun;
                    runIndex = rootIndex;
                }
            }
        }

        // Get thread ID from the target run (may not be set in currentThreadIdAtom yet)
        const threadId = get(currentThreadIdAtom) || targetRun.thread_id;

        /*
         * An earlier answer retried while a later one is still being written.
         * The later one is among the exchanges the retry removes: counted and
         * named in the question below, stopped once the user has agreed, and
         * deleted with the rest. Saying no leaves it running.
         */
        const liveLaterRun = !stoppedLiveTarget && activeRun && isRunActive(activeRun) ? activeRun : null;

        // Runs the retry replaces: the target and everything after it. A live
        // target canceled out of the active slot is not in threadRuns, so it
        // is named explicitly — the backend ignores IDs it never persisted.
        const removedRuns = liveLaterRun
            ? [...threadRuns.slice(runIndex), liveLaterRun]
            : threadRuns.slice(runIndex);
        const runIdsToRemove = removedRuns.map(r => r.id);
        if (!runIdsToRemove.includes(targetRun.id)) {
            runIdsToRemove.push(targetRun.id);
        }
        // The exchanges after the target's own message. Continuations of it
        // (resume runs) are part of that message, not later ones.
        const targetRunId = targetRun.id;
        const laterExchanges = removedRuns
            .filter((r) => r.id !== targetRunId && !r.user_prompt?.is_resume)
            .length;

        // Find applied actions for runs being removed
        const allAgentActions = get(threadAgentActionsAtom);
        const actionsInRemovedRuns = allAgentActions.filter(a => runIdsToRemove.includes(a.run_id));

        // Categorize by type - only include applied actions
        const annotationsToDelete = actionsInRemovedRuns
            .filter((action) =>
                (isAnnotationAgentAction(action) && hasAppliedZoteroItem(action)) ||
                (isCreateAnnotationsAgentAction(action) && hasAppliedBulkAnnotations(action))
            );
        const annotationEditsToUndo = actionsInRemovedRuns
            .filter(isEditAnnotationsAgentAction)
            .filter(a => a.status === 'applied');
        const zoteroNotesToDelete = actionsInRemovedRuns
            .filter(isZoteroNoteAgentAction)
            .filter(hasAppliedZoteroItem);
        const metadataEditsToUndo = actionsInRemovedRuns
            .filter(isEditMetadataAgentAction)
            .filter(a => a.status === 'applied');
        const createItemsToUndo = actionsInRemovedRuns
            .filter(isCreateItemAgentAction)
            .filter(a => a.status === 'applied');
        const createCollectionsToUndo = actionsInRemovedRuns
            .filter(isCreateCollectionAgentAction)
            .filter(a => a.status === 'applied');
        const organizeItemsToUndo = actionsInRemovedRuns
            .filter(isOrganizeItemsAgentAction)
            .filter(a => a.status === 'applied');
        const manageTagsToUndo = actionsInRemovedRuns
            .filter(isManageTagsAgentAction)
            .filter(a => a.status === 'applied');
        const manageCollectionsToUndo = actionsInRemovedRuns
            .filter(isManageCollectionsAgentAction)
            .filter(a => a.status === 'applied');
        const noteEditsToUndo = actionsInRemovedRuns
            .filter(isAnyEditNoteAgentAction)
            .filter(a => a.status === 'applied');
        const createNotesToUndo = actionsInRemovedRuns
            .filter(isCreateNoteAgentAction)
            .filter(a => a.status === 'applied');

        // Prompt the user to confirm undoing applied actions. The dialog is
        // the consent and must precede the truncate POST: a user who cancels
        // leaves no trace anywhere. The undo itself executes only after the
        // backend confirms, so a failed POST changes nothing.
        let confirmResult: UndoConfirmResult = 'skip';
        const hasActionsToUndo = annotationsToDelete.length > 0 || annotationEditsToUndo.length > 0 ||
                                 zoteroNotesToDelete.length > 0 ||
                                 metadataEditsToUndo.length > 0 || noteEditsToUndo.length > 0 ||
                                 createItemsToUndo.length > 0 ||
                                 createCollectionsToUndo.length > 0 || organizeItemsToUndo.length > 0 ||
                                 manageTagsToUndo.length > 0 || manageCollectionsToUndo.length > 0 ||
                                 createNotesToUndo.length > 0;
        if (hasActionsToUndo) {
            confirmResult = confirmUndoAppliedActions({
                annotations: annotationsToDelete,
                annotationEdits: annotationEditsToUndo,
                zoteroNotes: zoteroNotesToDelete,
                metadataEdits: metadataEditsToUndo,
                noteEdits: noteEditsToUndo,
                createItems: createItemsToUndo,
                createCollections: createCollectionsToUndo,
                organizeItems: organizeItemsToUndo,
                manageTags: manageTagsToUndo,
                manageCollections: manageCollectionsToUndo,
                createNotes: createNotesToUndo,
            }, laterExchanges, liveLaterRun !== null);
            if (confirmResult === 'cancel') {
                keepStoppedTarget();
                return;
            }
        } else if (laterExchanges > 0 && !confirmRemovingLaterExchanges(laterExchanges, liveLaterRun !== null)) {
            keepStoppedTarget();
            return;
        }
        options.onProceed?.();

        // Commit the removal on the backend before anything local changes.
        // The retry control's spinner and the composer's pending flag cover
        // the round trip; every failure exit clears both. A thread the
        // backend never assigned has nothing persisted to truncate (a first
        // run that died before the thread event).
        set(retryPendingRunIdAtom, runId);
        raisePendingFlag(set);

        /*
         * The later answer still being written goes with the rest now that the
         * user has agreed. Stopped only once the retry holds the composer, so
         * its loop winding down cannot let go of it. Whatever holds the slot
         * by now came after the target, so it is part of what the user agreed
         * to remove, even a continuation that started while they were asked.
         */
        const stoppedLaterRun = await takeLaterRunOutOfSlot(get, set);
        if (stoppedLaterRun) {
            const index = removedRuns.findIndex((r) => r.id === stoppedLaterRun.id);
            if (index >= 0) removedRuns[index] = stoppedLaterRun;
            else removedRuns.push(stoppedLaterRun);
            if (!runIdsToRemove.includes(stoppedLaterRun.id)) runIdsToRemove.push(stoppedLaterRun.id);
        }
        // Stored again if the retry does not go ahead: the removal below may
        // have dropped the write of its stopped copy.
        const keepStoppedLaterRun = () => {
            if (stoppedLaterRun?.status === 'canceled') persistCanceledLocalRun(stoppedLaterRun);
        };

        if (threadId) {
            // The run the client expects to survive as the thread's last —
            // the backend refuses when its survivor differs (rewritten by
            // another client), instead of misreading a stale retry as an
            // idempotent replay.
            const expectedTailRunId = runIndex > 0 ? threadRuns[runIndex - 1].id : null;
            const outcome = await truncateThreadOnServer(
                threadId,
                runIdsToRemove,
                expectedTailRunId,
                logPrefix,
            );
            if (outcome === 'failed') {
                set(retryPendingRunIdAtom, null);
                set(isWSChatPendingAtom, false);
                keepStoppedTarget();
                keepStoppedLaterRun();
                set(addPopupMessageAtom, {
                    type: 'error',
                    title: t('Retry failed'),
                    text: t('AlphainZ could not be reached to start the retry. Nothing was changed — please try again.'),
                    expire: true,
                });
                return;
            }
            if (outcome === 'refused') {
                set(retryPendingRunIdAtom, null);
                set(isWSChatPendingAtom, false);
                // A run stopped for this retry is stored as stopped before the
                // thread is read back.
                keepStoppedTarget();
                keepStoppedLaterRun();
                set(addPopupMessageAtom, {
                    type: 'warning',
                    title: t('Chat changed elsewhere'),
                    text: t('This chat was changed somewhere else (for example on another device), so the retry was not applied. Reloading the chat.'),
                    expire: true,
                });
                // Show the thread whole, including whatever was added elsewhere.
                await set(loadThreadAtom, {
                    user_id: userId,
                    threadId,
                    skipInstanceMismatchConfirm: true,
                });
                return;
            }
        }

        if (confirmResult === 'undo') {
            // Single reverse-chronological pass across all applied
            // actions. Cross-type ordering matters — e.g. a
            // create_collection undo cascades to descendants, so any
            // later manage_collections moves into it must be undone
            // first. See undoAppliedActionsInReverse for details.
            await undoAppliedActionsInReverse(actionsInRemovedRuns);
        }

        await cleanupTemporaryAnnotationsForRunReplacement(logPrefix);

        // Each as the thread holds it now: a run that was still being written
        // when the user was asked may have proposed more since.
        const threadRunsNow = new Map(get(threadRunsAtom).map((r: AgentRun) => [r.id, r]));
        const runsGoing = removedRuns.map((r) => threadRunsNow.get(r.id) ?? r);
        releaseProposalsOfRemovedRuns(set, stoppedLiveTarget ? [...runsGoing, stoppedLiveTarget] : runsGoing);

        // Truncate runs - keep only runs before the target
        set(threadRunsAtom, (prev) =>
            prev.filter(r => !runIdsToRemove.includes(r.id))
        );

        // Clear agent actions for removed runs
        set(threadAgentActionsAtom, (prev) =>
            prev.filter(a => !runIdsToRemove.includes(a.run_id))
        );

        // Clear citations for removed runs
        set(citationsAtom, (prev) =>
            prev.filter(c => !runIdsToRemove.includes(c.run_id ?? ''))
        );
        set(processCitationsAtom);
        set(maybeShowCitationTipAtom);

        // Reset WS state and set pending
        set(prepareForNewRunAtom);
        prewarmMuPDFWorker();
        raisePendingFlag(set);

        // Build model selection options
        const modelOptions = buildModelSelectionOptions(model);
        const customInstructions = getPref('customInstructions') || undefined;

        // Create new AgentRun shell with the replacement prompt
        const { run: newRun, request } = createAgentRunShell(
            editedPrompt ?? targetRun.user_prompt,
            threadId,
            userId,
            model.name,
            modelOptions,
            model.provider,
            customInstructions,
            model.is_custom ? model.custom_model : undefined,
        );

        // Set active run - UI now shows user message + spinner, which takes
        // over from the retry control's own loading state.
        newRunId = newRun.id;
        set(activeRunAtom, newRun);
        set(retryPendingRunIdAtom, null);

        // Execute the WebSocket request
        await executeWSRequest(newRun, request, get, set);
    } catch (error) {
        // Catch any unexpected errors during regeneration
        logger(`${logPrefix}: Unexpected error:`, error, 1);
        set(wsErrorAtom, {
            event: 'error',
            type: 'regeneration_error',
            message: error instanceof Error ? error.message : failureMessage,
            is_retryable: true,
        });
        set(activeRunAtom, prev => (newRunId && prev?.id === newRunId ? null : prev));
        set(retryPendingRunIdAtom, prev => (prev === runId ? null : prev));
        set(isWSChatPendingAtom, false);
    }
}

/**
 * Regenerate a response from a specific run (retry button and error card).
 */
export const regenerateFromRunAtom = atom(
    null,
    async (get, set, runId: string) => {
        await startRegenerateRun(get, set, runId, {
            logPrefix: 'regenerateFromRunAtom',
            walkResumeChain: true,
            failureMessage: t('Failed to regenerate response'),
        });
    }
);

/**
 * Regenerate from a run with an edited user prompt.
 * Same flow as regenerateFromRunAtom, with a replacement prompt.
 *
 * `onProceed` is told once the user has agreed to what the retry removes, so
 * the editor can stay open with the edit in it when they cancel instead.
 */
export const regenerateWithEditedPromptAtom = atom(
    null,
    async (
        get,
        set,
        params: { runId: string; editedPrompt: BeaverAgentPrompt; onProceed?: () => void },
    ) => {
        await startRegenerateRun(get, set, params.runId, {
            logPrefix: 'regenerateWithEditedPromptAtom',
            walkResumeChain: false,
            editedPrompt: params.editedPrompt,
            failureMessage: t('Failed to regenerate with edited prompt'),
            onProceed: params.onProceed,
        });
    }
);

/**
 * Resume a failed run from its error point.
 * 
 * Flow:
 * 1. Find the failed run
 * 2. Create a new run with is_resume=true and empty content
 * 3. Execute via WebSocket
 * 
 * The backend will continue from where it left off and the UI will hide the error run
 * when displaying the resumed run.
 */
export const autoResumeErroredRunAtom = atom(
    null,
    async (get, set, failedRunId: string) => {
        try {
            await startResumeRun(get, set, failedRunId, {
                requireResumable: false,
                trigger: 'auto',
                logPrefix: 'autoResumeErroredRunAtom',
                failureErrorType: 'auto_resume_error',
                failureMessage: t('Failed to automatically resume run'),
            });
        } finally {
            set(scheduledAutoResumeRunIdsAtom, (prev: Set<string>) => {
                const next = new Set(prev);
                next.delete(failedRunId);
                return next;
            });
        }
    }
);

/**
 * Auto-retry a failed run from the original user prompt.
 *
 * Used when the frontend has received only thinking content (no text or tool
 * calls) at the time of the error — nothing user-visible to preserve, so we
 * restart cleanly instead of resuming.
 */
export const autoRetryErroredRunAtom = atom(
    null,
    async (get, set, failedRunId: string) => {
        try {
            await startAutoRetryRun(get, set, failedRunId);
        } finally {
            set(scheduledAutoResumeRunIdsAtom, (prev: Set<string>) => {
                const next = new Set(prev);
                next.delete(failedRunId);
                return next;
            });
        }
    }
);

export const resumeFromRunAtom = atom(
    null,
    async (get, set, failedRunId: string) => {
        await startResumeRun(get, set, failedRunId, {
            requireResumable: true,
            trigger: 'user',
            logPrefix: 'resumeFromRunAtom',
            failureErrorType: 'resume_error',
            failureMessage: t('Failed to resume run'),
        });
    }
);

/**
 * Archive the active run as canceled and clear live-run UI state.
 * Store-only — does not touch the socket.
 *
 * Taking a locally-run request out of the active slot is what stops it (see
 * `localRuns`): its model loop is aborted and the canceled copy — the
 * question and whatever had streamed — is saved. So the run is archived
 * first, and a question card cleared after it reads as the stop it is, not as
 * a skip the model should carry on from.
 */
export const abandonActiveRunLocallyAtom = atom(null, (get, set) => {
    // Set pending to false immediately for better UI responsiveness
    set(isWSChatPendingAtom, false);

    // Archive live runs (including deferred-approval). Error runs keep their
    // slot so Retry still works.
    const activeRun = get(activeRunAtom);
    if (activeRun && isRunActive(activeRun)) {
        const canceledRun: AgentRun = {
            ...activeRun,
            status: 'canceled',
            completed_at: new Date().toISOString(),
        };
        // Move canceled run to completed runs
        set(threadRunsAtom, (runs) => [...runs, canceledRun]);
        set(activeRunAtom, null);
    }

    // Release the cards that held the run open. Proposals it made stay
    // pending: stopping the run does not decide them.
    set(retireUnanswerableApprovalsAtom);
    set(clearAllPendingQuestionsAtom);
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearAllPendingBatchApprovalsAtom);
    set(clearApprovalResponseIntentsAtom);
    set(clearRunApprovalPolicyAtom);

    // Clear streaming-done state (abandoned during post-processing)
    set(streamingDoneRunIdsAtom, new Set<string>());
    streamActivity.reset();
});

/**
 * User-initiated close: cancel on the backend, then close.
 * Local bookkeeping is shared with shutdown via `abandonActiveRunLocallyAtom`.
 */
export const closeWSConnectionAtom = atom(null, async (_get, set) => {
    set(abandonActiveRunLocallyAtom);

    // Send cancel message and close connection
    await agentService.cancel();
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
});

/**
 * Close because this client is going away (window close, quit, or plugin disable).
 *
 * Sends a 1000 close, not a cancel (cancel is billed as user-stop). Close is
 * synchronous and happens first. Also aborts in-flight connect loops; if this
 * bundle owns neither a socket, a loop nor a local run there is no live run of
 * its own to abandon, so skip. Each main window evaluates its own copy of this
 * bundle, so a window only ever closes the connection it opened.
 *
 * A local run is abandoned the same way as a socket one: archived as canceled
 * and saved, and recorded as interrupted so the next session offers to reopen
 * its chat.
 *
 * `reason` is logged server-side as the disconnect path.
 */
export const closeWSConnectionForShutdownAtom = atom(
    null,
    (
        get,
        set,
        reason: string,
        options?: { rememberInterruptedThread?: boolean },
    ) => {
        // Latch first: a send still preparing has nothing to close or abandon.
        clientShutDown = true;
        if (!agentService.isConnected() && connectLoopsInFlight === 0 && !hasLiveLocalRun()) return;
        agentService.close(1000, reason);
        if (options?.rememberInterruptedThread) rememberInterruptedThread(get);
        set(abandonActiveRunLocallyAtom);
    },
);

/**
 * Persist the thread whose run this shutdown cut off, so the next session can
 * offer to reopen it. Only a live run counts as interrupted — the socket also
 * stays open for a moment around a run that already finished.
 *
 * The thread id is null until the backend assigns one during a new thread's
 * first run; there is nothing to reopen in that window. A local run needs no
 * backend for it: its thread is the run's own id until one is reported, and
 * the run was stored under it when it was sent. The account is stamped on the
 * record because the next session may start under a different one.
 */
function rememberInterruptedThread(get: Getter): void {
    const activeRun = get(activeRunAtom);
    if (!activeRun || !isRunActive(activeRun)) return;

    const threadId = get(currentThreadIdAtom)
        || activeRun.thread_id
        || (localRuns.has(activeRun.id) ? activeRun.id : null);
    const userId = get(userIdAtom);
    if (!threadId || !userId) return;

    saveInterruptedThread({
        threadId,
        userId,
        threadName: get(currentThreadNameAtom),
    });
}

/**
 * Clear the current thread and start fresh
 */
export const clearThreadAtom = atom(null, (_get, set) => {
    set(threadRunsAtom, []);
    set(activeRunAtom, null);
    set(currentThreadIdAtom, null);
    set(resetWSStateAtom);
    // Clear agent actions, citations, and warnings for the thread
    set(clearAgentActionsAtom);
    set(citationsAtom, []);
    set(resetCitationMarkersAtom);  // Reset citation markers for cleared thread
    set(clearWarningsAtom);
    // Clear pending questions so a reset never leaves the composer disabled
    // behind an unanswerable card (pending approvals are left as-is here).
    set(clearAllPendingQuestionsAtom);
    set(clearAllPendingCreditConfirmationsAtom);
    set(clearAllPendingBatchApprovalsAtom);
    set(clearRunApprovalPolicyAtom);
});

/**
 * Best-effort local record of approval/reject intent keyed by deferred action id.
 * Used by views to keep the correct spinner visible after a pending approval is removed.
 */
export const approvalResponseIntentsAtom = atom<Map<string, boolean>>(new Map());

export const removeApprovalResponseIntentAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(approvalResponseIntentsAtom, (prev) => {
            if (!prev.has(actionId)) return prev;
            const next = new Map(prev);
            next.delete(actionId);
            return next;
        });
    },
);

export const clearApprovalResponseIntentsAtom = atom(
    null,
    (_get, set) => {
        set(approvalResponseIntentsAtom, new Map());
    },
);

/**
 * Deferred actions whose approval channel is closed: the user's decision either
 * never left the client (socket down) or reached a backend that had already
 * stopped waiting (`deferred_approval_stale`). The run cannot act on it.
 *
 * The proposal itself is untouched — still stored, still applicable — so views
 * use this to drop the "awaiting approval" spinner and restore the local
 * apply/reject controls. Without it a card waits forever on a reply that the
 * backend will never send.
 */
export const staleApprovalActionIdsAtom = atom<Set<string>>(new Set<string>());

export const markApprovalStaleAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(staleApprovalActionIdsAtom, (prev) => {
            if (prev.has(actionId)) return prev;
            const next = new Set(prev);
            next.add(actionId);
            return next;
        });
    },
);

export const clearStaleApprovalsAtom = atom(
    null,
    (_get, set) => {
        set(staleApprovalActionIdsAtom, new Set<string>());
    },
);

// Note: clearing `pendingApprovalsAtom` when a run ends does not strand the
// proposals it was carrying. Every deferred tool emits and persists its action
// before it starts waiting, so each card falls back to the `status === 'pending'`
// controls it already has and stays appliable. Recovering a card whose decision
// was already sent is the view's job — see `useApprovalRecovery`.

/**
 * Send approval response for a deferred action.
 * Called by the UI when user approves/rejects an action.
 *
 * A send that never left the client is recorded as stale immediately: the
 * backend cannot answer a message it never received, so the card would
 * otherwise sit on a spinner until the thread is reloaded.
 */
export const sendApprovalResponseAtom = atom(
    null,
    (_get, set, { actionId, approved, userInstructions }: { actionId: string; approved: boolean; userInstructions?: string | null }) => {
        set(approvalResponseIntentsAtom, (prev) => {
            const next = new Map(prev);
            next.set(actionId, approved);
            return next;
        });
        logger(`sendApprovalResponseAtom: Sending approval response for ${actionId}: ${approved}${userInstructions ? ' (with instructions)' : ''}`, 1);
        // A locally-executed write is waiting on a promise in this process, not
        // on a reply over a socket. Answer it here; the socket has nothing to
        // deliver to and would mark the card stale.
        if (resolveLocalApproval(actionId, approved, userInstructions)) return;
        const delivered = agentService.sendApprovalResponse(actionId, approved, userInstructions);
        if (!delivered) {
            logger(`sendApprovalResponseAtom: Approval response for ${actionId} was not sent; marking stale`, 1);
            set(markApprovalStaleAtom, actionId);
        }
    }
);

/**
 * Grant a tool group for the rest of a run and approve every request from that
 * group that is already pending in that run. Future validations and
 * late-arriving approval requests read the same transient policy.
 *
 * Proposals outlive their run and chat, so the approval is limited to the run
 * the grant was given for: the user granted it on this run's card and cannot
 * see another chat's proposals from here.
 */
export const approveToolGroupForRunAtom = atom(
    null,
    (
        get,
        set,
        { runId, toolName }: { runId: string; toolName: string },
    ): number => {
        const group = getToolGroup(toolName);
        if (!group) return 0;

        set(grantToolGroupForRunAtom, { runId, toolName });

        const matchingActionIds = getPendingApprovalIdsForToolGroup(
            get(pendingApprovalsAtom).values(),
            toolName,
            runId,
        );
        for (const actionId of matchingActionIds) {
            set(sendApprovalResponseAtom, { actionId, approved: true });
        }
        set(removePendingApprovalsAtom, matchingActionIds);

        logger(
            `approveToolGroupForRunAtom: Granted ${group} for run ${runId} and approved ${matchingActionIds.length} pending action(s)`,
            1,
        );
        return matchingActionIds.length;
    },
);

/**
 * Send the user's answers (or a skip) for an ask_user_question request and
 * remove the pending question so the composer re-enables immediately.
 */
export const sendAskUserQuestionResponseAtom = atom(
    null,
    (_get, set, { questionId, toolcallId, answers, cancelled }: {
        questionId: string;
        toolcallId: string;
        answers: AskUserQuestionAnswer[];
        cancelled?: boolean;
    }) => {
        logger(`sendAskUserQuestionResponseAtom: Sending question response for ${questionId}: ${cancelled ? 'cancelled' : `${answers.length} answer(s)`}`, 1);
        // A locally-run question is a suspended tool call in this process, not
        // a socket round trip. Delivering it here means the same card, the same
        // buttons and the same notification serve both.
        if (!resolveLocalQuestion(questionId, answers, cancelled ?? false)) {
            agentService.sendAskUserQuestionResponse(questionId, answers, cancelled ?? false);
        }
        set(removePendingQuestionAtom, toolcallId);
    }
);

/**
 * Send the user's decision for a run-level credit confirmation and retire the
 * pending card.
 *
 * The card is removed even when the send fails: the decision can no longer
 * reach the run, so leaving it up would strand the user on a card that can
 * never be answered.
 */
export const sendCreditConfirmationResponseAtom = atom(
    null,
    (_get, set, { confirmationId, approved, userInstructions }: {
        confirmationId: string;
        approved: boolean;
        userInstructions?: string | null;
    }) => {
        logger(`sendCreditConfirmationResponseAtom: Sending credit confirmation response for ${confirmationId}: ${approved}`, 1);
        const delivered = agentService.sendCreditConfirmationResponse(
            confirmationId,
            approved,
            userInstructions,
        );
        if (!delivered) {
            logger(`sendCreditConfirmationResponseAtom: Credit confirmation response for ${confirmationId} was not sent`, 1);
        }
        set(removePendingCreditConfirmationAtom, confirmationId);
    }
);

/**
 * Send the user's decision for a batch approval and retire the pending card.
 *
 * The card is removed even when the send fails: the decision can no longer
 * reach the run, so leaving it up would strand the user on a card that can
 * never be answered.
 */
export const sendBatchApprovalResponseAtom = atom(
    null,
    (_get, set, { approvalId, approved, mode, userInstructions }: {
        approvalId: string;
        approved: boolean;
        mode: BatchApprovalMode;
        userInstructions?: string | null;
    }) => {
        logger(`sendBatchApprovalResponseAtom: Sending batch approval response for ${approvalId}: ${approved} (${mode})`, 1);
        const delivered = agentService.sendBatchApprovalResponse(
            approvalId,
            approved,
            mode,
            userInstructions,
        );
        if (!delivered) {
            logger(`sendBatchApprovalResponseAtom: Batch approval response for ${approvalId} was not sent`, 1);
        }
        set(removePendingBatchApprovalAtom, approvalId);
    }
);
