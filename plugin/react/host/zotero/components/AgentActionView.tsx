import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { navigateToAnnotation } from '../../../utils/readerUtils';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus } from '@beaver/agent-core/agents/types';
import {
    AgentAction,
    getAgentActionsByToolcallAtom,
    inFlightAgentActionIdsAtom,
    pendingApprovalsAtom,
    pendingApprovalsForToolcall,
    removePendingApprovalAtom,
    removePendingApprovalsAtom,
    isCreateAnnotationsAgentAction,
} from '../../../agents/agentActions';
import type { PendingApproval } from '@beaver/agent-ui/host';
import {
    approveToolGroupForRunAtom,
    approvalResponseIntentsAtom,
    isWSChatPendingAtom,
    removeApprovalResponseIntentAtom,
    sendApprovalResponseAtom,
} from '../../../atoms/agentRunAtoms';
import {
    agentActionItemTitlesAtom,
    setAgentActionItemTitleAtom,
    toolExpandedAtom,
    setToolExpandedAtom,
} from '../../../atoms/messageUIState';
import {
    applyAgentActionsAtom,
    rejectAgentActionsAtom,
    undoAgentActionsAtom,
} from '../agentActionExecution';
import { shortItemTitle } from '../../../../src/utils/zoteroUtils';
import { resolveItemReference, resolveLibraryRef } from '../../../../src/utils/libraryIdentity';
import { notifyReferenceUnavailable } from '../sourceActions';
import {
    TickIcon,
    CancelIcon,
    ChevronIcon,
    Spinner,
    Icon,
    RepeatIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
} from '../../../components/icons/icons';
import { revealSource, openNoteByKey, getCurrentCollectionKeyForItem } from '../../../utils/sourceUtils';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import SplitApplyButton from '../../../components/ui/buttons/SplitApplyButton';
import DeferredToolPreferenceButton from '../../../components/ui/buttons/DeferredToolPreferenceButton';
import {
    ActionStatus,
    STATUS_CONFIGS,
    NEVER_AUTO_COLLAPSE_TOOLS,
    getOverallStatus,
    getActionLabel,
    getActionTitle,
    buildPreviewData,
    PreviewData,
    getCreateAnnotationsDisplayStatus,
    getAgentActionToolIcon,
    hasFailedUndo,
    actionsToApply,
} from './agentActionViewHelpers';
import { ActionPreview } from './ActionPreview';
import { useApprovalRecovery } from './useApprovalRecovery';
import {
    getToolGroupRunApprovalLabel,
    getToolGroupRunApprovalScope,
} from '../../../atoms/runApprovalPolicy';
import { t } from '../../../../src/utils/i18n';

export { STATUS_CONFIGS, getOverallStatus } from './agentActionViewHelpers';
export type { ActionStatus } from './agentActionViewHelpers';

interface AgentActionViewProps {
    toolcallId: string;
    toolName: string;
    runId: string;
    responseIndex: number;
    pendingApproval: PendingApproval | null;
    hasToolReturn?: boolean;
    streamingArgs?: Record<string, any> | null;
    runStatus?: AgentRunStatus;
}

type HeaderLinkAction = {
    tooltip: string;
    onClick: () => void | Promise<void>;
};

type HeaderLinkActionRule = HeaderLinkAction & {
    matches: () => boolean;
};

export const AgentActionView: React.FC<AgentActionViewProps> = ({
    toolcallId,
    toolName,
    runId,
    responseIndex,
    pendingApproval: pendingApprovalProp,
    hasToolReturn = false,
    streamingArgs,
    runStatus,
}) => {
    const [isHovered, setIsHovered] = useState(false);

    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    // A tool call id already names one call; the run filter only guards against
    // a stale duplicate from another run. When nothing matches — a recorded
    // action whose run id was never filled in, as locally proposed writes did
    // for a while — the call's own actions are still its record, and showing
    // "No preview available" with a live Apply button over an applied change
    // is far worse than trusting the id.
    const actionsForRun = getAgentActionsByToolcall(toolcallId, (a) => a.run_id === runId);
    const actions = actionsForRun.length > 0 ? actionsForRun : getAgentActionsByToolcall(toolcallId);
    const action = actions.length > 0 ? actions[0] : null;

    /*
     * Every approval this call is waiting on, not just the first.
     *
     * Adding papers proposes one per paper under the same call. Reading only
     * the first approval, and dropping it once the first paper was decided,
     * left the rest pending with nothing on screen to decide them by. An
     * approval stands while its own record is still pending; one whose record
     * has not arrived stands unless the call's first record is already
     * decided, which is how the backend's approvals have always read.
     */
    const allPendingApprovals = useAtomValue(pendingApprovalsAtom);
    const liveApprovals = useMemo(() => {
        const forCall = pendingApprovalsForToolcall(allPendingApprovals.values(), toolcallId);
        if (forCall.length === 0 && pendingApprovalProp) forCall.push(pendingApprovalProp);
        const firstDecided = !!action && action.status !== 'pending';
        return forCall.filter((approval) => {
            const record = actions.find((candidate) => candidate.id === approval.actionId);
            return record ? record.status === 'pending' : !firstDecided;
        });
    }, [allPendingApprovals, toolcallId, pendingApprovalProp, action, actions]);
    const pendingApproval: PendingApproval | null = liveApprovals[0] ?? null;
    const isAwaitingApproval = pendingApproval !== null;

    // A write under way from any surface — this card, the review card, a
    // paper's own row, or an approval answered elsewhere — is claimed here,
    // and the card waits on it rather than offering the change again.
    const inFlightActionIds = useAtomValue(inFlightAgentActionIdsAtom);
    const isWriting = actions.some((candidate) => inFlightActionIds.has(candidate.id));

    // The rule this change answers to. A deletion shares its action type with
    // annotation edits but has a group of its own, and the card's permission
    // menu and "for this run" grant must be that group's: the edits group's
    // would not touch the deletion the card is asking about.
    const preferenceToolName = toolName === 'edit_annotations'
        && (pendingApproval?.actionData ?? action?.proposed_data)?.operation === 'delete'
        ? 'delete_annotations'
        : toolName;

    const runIsStreamable = runStatus === undefined || runStatus === 'in_progress';
    const isStreaming = !action
        && !pendingApproval
        && !!streamingArgs
        && Object.keys(streamingArgs).length > 0
        && runIsStreamable;

    /*
     * The wait for a decision has an expansion key of its own.
     *
     * The card opens itself while it waits, and it used to write that "open"
     * under the same key the plain tool row and the settled record read. So
     * the moment the user decided, whatever replaced the card inherited an
     * open state it had never asked for: the plain row unfolded the raw tool
     * return, the record refused to fold. Keyed apart, the open card is
     * forgotten with the wait, and what follows starts closed.
     */
    const baseExpansionKey = `${runId}:${responseIndex}:${toolcallId}`;
    const expansionKey = isAwaitingApproval ? `${baseExpansionKey}:awaiting` : baseExpansionKey;
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const hasExistingState = expansionState[expansionKey] !== undefined;
    const neverAutoCollapse = NEVER_AUTO_COLLAPSE_TOOLS.has(toolName);
    const isExpanded = expansionState[expansionKey] ?? (isAwaitingApproval || neverAutoCollapse);

    const prevAwaitingRef = useRef(isAwaitingApproval);
    const hasInitializedRef = useRef(false);
    useEffect(() => {
        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            if (!hasExistingState) {
                setExpanded({ key: expansionKey, expanded: isAwaitingApproval || neverAutoCollapse });
            }
            return;
        }

        if (prevAwaitingRef.current !== isAwaitingApproval) {
            setExpanded({
                key: expansionKey,
                expanded: neverAutoCollapse ? true : isAwaitingApproval,
            });
        }
        prevAwaitingRef.current = isAwaitingApproval;
    }, [isAwaitingApproval, expansionKey, hasExistingState, neverAutoCollapse, setExpanded]);

    const [isProcessingApproval, setIsProcessingApproval] = useState(false);
    const [isProcessingAction, setIsProcessingAction] = useState(false);
    const [isUndoError, setIsUndoError] = useState(false);
    const [isExternallyProcessing, setIsExternallyProcessing] = useState(false);
    const [clickedButton, setClickedButton] = useState<'approve' | 'reject' | 'undo' | null>(null);
    const prevPendingApprovalRef = useRef<PendingApproval | null>(pendingApproval);

    const isRunPending = useAtomValue(isWSChatPendingAtom);
    const approvalResponseIntents = useAtomValue(approvalResponseIntentsAtom);
    const isMultiAction = (toolName === 'create_items' || toolName === 'create_item') && actions.length > 1;

    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const approveToolGroupForRun = useSetAtom(approveToolGroupForRunAtom);
    const removeApprovalResponseIntent = useSetAtom(removeApprovalResponseIntentAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const removePendingApprovals = useSetAtom(removePendingApprovalsAtom);
    const applyAgentActions = useSetAtom(applyAgentActionsAtom);
    const rejectAgentActions = useSetAtom(rejectAgentActionsAtom);
    const undoAgentActions = useSetAtom(undoAgentActionsAtom);

    // Keyed on the tool call id alone: surfaces without a responseIndex then
    // share the same resolved title and the same fetch.
    const itemTitleKey = toolcallId;
    const itemTitleMap = useAtomValue(agentActionItemTitlesAtom);
    const itemTitle = itemTitleMap[itemTitleKey] ?? null;
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);

    const hasAssociatedItem =
        toolName === 'edit_metadata' ||
        toolName === 'edit_item' ||
        toolName === 'create_highlight_annotations' ||
        toolName === 'create_note_annotations';

    useEffect(() => {
        if (!hasAssociatedItem || itemTitle) return;

        const fetchTitle = async () => {
            const libraryId: number | undefined =
                action?.proposed_data?.resolved_ref?.library_id ??
                action?.proposed_data?.library_id ??
                pendingApproval?.actionData?.library_id;
            const libraryRef: string | undefined =
                action?.proposed_data?.resolved_ref?.library_ref ??
                action?.proposed_data?.library_ref ??
                pendingApproval?.actionData?.library_ref;
            const zoteroKey: string | undefined =
                action?.proposed_data?.resolved_ref?.zotero_key ??
                action?.proposed_data?.zotero_key ??
                pendingApproval?.actionData?.zotero_key;

            if (!libraryId || !zoteroKey) return;

            const resolved = await resolveItemReference({ library_ref: libraryRef, library_id: libraryId, zotero_key: zoteroKey });
            if (resolved.status === 'found') {
                const title = await shortItemTitle(resolved.item);
                setItemTitle({ key: itemTitleKey, title });
            }
        };

        fetchTitle();
    }, [action, pendingApproval, itemTitle, itemTitleKey, hasAssociatedItem, setItemTitle]);

    const handleApprovalRecovered = useCallback(() => {
        setIsProcessingApproval(false);
        setIsExternallyProcessing(false);
        setClickedButton(null);
    }, []);
    const { setProcessingApproval } = useApprovalRecovery({
        isAwaitingDecision: isProcessingApproval || isExternallyProcessing,
        // While the answer's write is claimed, the call having returned says
        // nothing about the decision: a local proposal's call returns as soon
        // as it is proposed.
        hasToolReturn: hasToolReturn && !isWriting,
        actionStatus: action?.status,
        onRecover: handleApprovalRecovered,
        label: `AgentActionView(${toolName})`,
    });

    useEffect(() => {
        const previousPendingApproval = prevPendingApprovalRef.current;
        const wasAwaiting = previousPendingApproval !== null;
        const isNoLongerAwaiting = pendingApproval === null;

        if (wasAwaiting && isNoLongerAwaiting) {
            const previousActionId = previousPendingApproval.actionId;
            const previousIntent = approvalResponseIntents.get(previousActionId);

            if (!isProcessingApproval && isRunPending && !hasToolReturn) {
                setIsExternallyProcessing(true);
                setClickedButton(previousIntent === false ? 'reject' : 'approve');
                // Record it for recovery too: a decision made from another
                // surface (Approve All, the composer, the diff-preview banner)
                // can miss its window exactly like one made here.
                setProcessingApproval({
                    actionId: previousActionId,
                    kind: previousIntent === false ? 'reject' : 'approve',
                });
            }

            if (previousIntent !== undefined) {
                removeApprovalResponseIntent(previousActionId);
            }
        }

        prevPendingApprovalRef.current = pendingApproval;
    }, [
        pendingApproval,
        isProcessingApproval,
        isRunPending,
        hasToolReturn,
        approvalResponseIntents,
        removeApprovalResponseIntent,
        setProcessingApproval,
    ]);

    useEffect(() => {
        if ((isProcessingApproval || isExternallyProcessing) && action && action.status !== 'pending') {
            setIsProcessingApproval(false);
            setProcessingApproval(null);
            setIsExternallyProcessing(false);
            setClickedButton(null);
        }
        if (isExternallyProcessing && (hasToolReturn || !isRunPending)) {
            setIsExternallyProcessing(false);
            setProcessingApproval(null);
            setClickedButton(null);
        }
    }, [isProcessingApproval, isExternallyProcessing, action?.status, hasToolReturn, isRunPending, action, setProcessingApproval]);

    const isProcessing = isProcessingApproval || isProcessingAction || isExternallyProcessing || isWriting;
    const actionDisplayStatus = action ? getCreateAnnotationsDisplayStatus(action) : null;
    const status: ActionStatus | 'awaiting' = (isAwaitingApproval || isProcessing)
        ? 'awaiting'
        : isMultiAction
            ? getOverallStatus(actions)
            : (actionDisplayStatus ?? action?.status ?? 'pending');
    const isConfirmExtraction = toolName === 'confirm_extraction';
    const isConfirmExternalSearch = toolName === 'confirm_external_search';
    const isConfirmAction = isConfirmExtraction || isConfirmExternalSearch;
    const hasNoActionData = !action && !pendingApproval && !isStreaming;
    const baseConfig = STATUS_CONFIGS[status];
    const config = (isConfirmAction && status !== 'awaiting')
        ? { ...baseConfig, showApply: false, showReject: false, showUndo: false, showRetry: false }
        : baseConfig;

    // The card's own Apply and Reject answer everything it is waiting on: for
    // several papers, all of them — the rows below carry each paper's own.
    const decideAll = useCallback((approved: boolean) => {
        if (liveApprovals.length === 0) return;
        setIsProcessingApproval(true);
        setProcessingApproval({ actionId: liveApprovals[0].actionId, kind: approved ? 'approve' : 'reject' });
        setClickedButton(approved ? 'approve' : 'reject');
        for (const approval of liveApprovals) {
            sendApprovalResponse({ actionId: approval.actionId, approved });
        }
        removePendingApprovals(liveApprovals.map((approval) => approval.actionId));
    }, [liveApprovals, sendApprovalResponse, removePendingApprovals, setProcessingApproval]);

    const handleApprove = useCallback(() => decideAll(true), [decideAll]);
    const handleReject = useCallback(() => decideAll(false), [decideAll]);

    const handleApproveForRun = useCallback(() => {
        if (!pendingApproval) return;
        setIsProcessingApproval(true);
        setProcessingApproval({ actionId: pendingApproval.actionId, kind: 'approve' });
        setClickedButton('approve');
        approveToolGroupForRun({ runId, toolName: preferenceToolName });
    }, [pendingApproval, approveToolGroupForRun, runId, preferenceToolName, setProcessingApproval]);

    const handleApplyPending = useCallback(async () => {
        if (actions.length === 0 || isProcessing) return;

        // The undecided ones while any are, else the failed ones (Try Again),
        // else — every change rejected or undone — all of them. A paper left
        // out on its own row is not added by the card's Apply or Try Again
        // while others are still undecided or failed.
        const targets = actionsToApply(actions);
        if (targets.length === 0) return;
        setIsUndoError(false);
        setIsProcessingAction(true);
        setClickedButton('approve');
        try {
            await applyAgentActions({ actions: targets, runId });
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [actions, isProcessing, runId, applyAgentActions]);

    const handleRejectPending = useCallback(() => {
        if (actions.length === 0 || isProcessing) return;

        // Only what is still undecided: rejecting a paper already added would
        // drop the record its Undo works from while the item stays.
        const undecided = (isMultiAction ? actions : [action!]).filter(
            (candidate) => candidate.status === 'pending',
        );
        if (undecided.length === 0) return;
        setClickedButton('reject');
        rejectAgentActions({ actions: undecided });
        setTimeout(() => setClickedButton(null), 100);
    }, [action, actions, isProcessing, isMultiAction, rejectAgentActions]);

    /*
     * One paper of several, decided on its own row: through its approval
     * while one is waiting on it, otherwise through its record, as the card's
     * own pending controls would.
     */
    const handleDecideItem = useCallback((item: AgentAction, approved: boolean) => {
        if (inFlightActionIds.has(item.id)) return;
        const live = liveApprovals.find((approval) => approval.actionId === item.id);
        if (live) {
            sendApprovalResponse({ actionId: live.actionId, approved });
            removePendingApproval(live.actionId);
            return;
        }
        if (approved) void applyAgentActions({ actions: [item], runId });
        else rejectAgentActions({ actions: [item] });
    }, [inFlightActionIds, liveApprovals, sendApprovalResponse, removePendingApproval, applyAgentActions, rejectAgentActions, runId]);

    const handleUndo = useCallback(async () => {
        if (!action || isProcessing) return;

        setIsProcessingAction(true);
        setClickedButton('undo');
        try {
            const result = await undoAgentActions({ actions });
            if (result.fatalError) setIsUndoError(true);
        } finally {
            setIsProcessingAction(false);
            setClickedButton(null);
        }
    }, [action, actions, isProcessing, undoAgentActions]);

    // Read off the records as well as this card's own state: a change that
    // failed after it was written still carries its result, and retrying it
    // means undoing it — applying it again would make it twice.
    const isUndoRetry = isUndoError || hasFailedUndo(actions);
    const handleRetry = useCallback(async () => {
        if (isUndoRetry) {
            setIsUndoError(false);
            await handleUndo();
        } else {
            await handleApplyPending();
        }
    }, [isUndoRetry, handleUndo, handleApplyPending]);

    const handleRevealNote = useCallback(async () => {
        const libraryId = action?.result_data?.library_id;
        const zoteroKey = action?.result_data?.zotero_key;
        const libraryRef = action?.result_data?.library_ref;
        if (!libraryId || !zoteroKey) return;
        // Reveal within the current collection when the note belongs to it,
        // instead of switching to the library root.
        const collectionKey = await getCurrentCollectionKeyForItem(libraryId, zoteroKey);
        revealSource({ library_id: libraryId, zotero_key: zoteroKey, library_ref: libraryRef }, collectionKey);
    }, [action]);

    const toggleExpanded = () => setExpanded({ key: expansionKey, expanded: !isExpanded });
    const previewData = buildPreviewData(toolName, pendingApproval, action);
    const runApprovalLabel = getToolGroupRunApprovalLabel(preferenceToolName);
    const runApprovalScope = getToolGroupRunApprovalScope(preferenceToolName);

    const getHeaderIcon = () => {
        if (isAwaitingApproval) return getAgentActionToolIcon(toolName);
        if (isHovered && isExpanded) return ArrowDownIcon;
        if (isHovered && !isExpanded) return ArrowRightIcon;
        if (config.icon === null) return getAgentActionToolIcon(toolName);
        return config.icon;
    };

    const shouldShowStatusIcon = () => {
        if (isHovered) return false;
        return config.icon !== null || !isAwaitingApproval;
    };

    const actionTitle = getActionTitle(toolName, action?.proposed_data, itemTitle, actions);
    const bulkAnnotationRevealRef = action && isCreateAnnotationsAgentAction(action)
        ? action.proposed_data.resolved_ref
        : null;
    const headerLinkActionRules: HeaderLinkActionRule[] = [
        {
            matches: () => (
                toolName === 'create_note' &&
                action?.status === 'applied' &&
                !!action?.result_data?.library_id &&
                !!action?.result_data?.zotero_key
            ),
            tooltip: t('Open note'),
            onClick: () => {
                // Resolve through the device-portable library_ref so a note created
                // in a group library on another computer opens the right local item.
                const libraryId = resolveLibraryRef({
                    library_ref: action!.result_data!.library_ref,
                    library_id: action!.result_data!.library_id,
                });
                if (libraryId) void openNoteByKey(libraryId, action!.result_data!.zotero_key);
                else notifyReferenceUnavailable('item', 'library_unavailable');
            },
        },
        {
            matches: () => (
                (toolName === 'create_highlight_annotations' || toolName === 'create_note_annotations')&&
                action?.status === 'applied' &&
                action?.result_data?.created?.length > 0
            ),
            tooltip: t('Open annotation'),
            onClick: async () => {
                const firstCreated = action!.result_data!.created[0];
                const resolved = await resolveItemReference({
                    library_ref: firstCreated.library_ref,
                    library_id: firstCreated.library_id,
                    zotero_key: firstCreated.zotero_key,
                });
                if (resolved.status === 'found') {
                    await navigateToAnnotation(resolved.item as Zotero.Item);
                } else {
                    notifyReferenceUnavailable('annotation', resolved.status === 'library_unavailable' ? 'library_unavailable' : 'missing');
                }
            },
        },
    ];

    const defaultHeaderLinkAction: HeaderLinkAction | null = (() => {
        const revealRef = bulkAnnotationRevealRef ?? {
            library_id: action?.proposed_data?.library_id,
            zotero_key: action?.proposed_data?.zotero_key,
            library_ref: action?.proposed_data?.library_ref,
        };
        if (!revealRef.library_id || !revealRef.zotero_key) return null;

        return {
            tooltip: t('Reveal in Zotero'),
            onClick: () => {
                revealSource({
                    library_id: revealRef.library_id,
                    zotero_key: revealRef.zotero_key,
                    library_ref: revealRef.library_ref,
                });
            },
        };
    })();
    const headerLinkAction = headerLinkActionRules.find((rule) => rule.matches()) ?? defaultHeaderLinkAction;

    if (isStreaming) {
        const effectiveArgs = streamingArgs ?? {};
        const streamingTitle = getActionTitle(toolName, effectiveArgs, itemTitle, undefined);
        const streamingPreviewData: PreviewData = {
            actionType: toolName,
            actionData: effectiveArgs,
        };

        return (
            <div className="agent-action-view rounded-md flex flex-col min-w-0 border-popup mb-2">
                <div className="display-flex flex-row py-15 bg-senary border-bottom-quinary">
                    <div
                        className="variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015"
                        style={{ background: 'transparent', border: 0, padding: 0 }}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className="flex-1 display-flex mt-010">
                                <Icon icon={Spinner} />
                            </div>
                            <div className="two-line-header shimmer-text">
                                <span className="font-color-primary font-medium" style={{ fontWeight: '500' }}>{getActionLabel(toolName, effectiveArgs)}</span>
                                {streamingTitle && <span className="font-color-secondary ml-15" style={{ fontWeight: '400' }}>{streamingTitle}</span>}
                            </div>
                        </div>
                    </div>
                </div>
                <ActionPreview
                    toolName={toolName}
                    previewData={streamingPreviewData}
                    status="pending"
                    isStreaming={true}
                />
            </div>
        );
    }

    /*
     * Once the user has decided, the card is a record, not a request.
     *
     * A resolved proposal used to keep its boxed two-line header on screen —
     * for a single highlight, a block several times the height of the tool
     * rows around it, sitting in the answer for the rest of the thread. Folded,
     * it is one line like any other tool call: what was proposed, on what, and
     * what became of it. The card, with its preview and Undo, is one click
     * away, and the reader's own expand state is remembered like everywhere
     * else in the stream.
     */
    const isSettledRecord =
        !isExpanded
        && !!action
        && !isAwaitingApproval
        && !isProcessing
        && status !== 'pending'
        && status !== 'awaiting';
    if (isSettledRecord) {
        const recordLabel = [
            getActionLabel(toolName, previewData?.actionData ?? action?.proposed_data),
            actionTitle,
            t(config.label),
        ]
            .filter((part) => !!part)
            .join(' · ');
        return (
            <div id={`tool-${toolcallId}`} className="agent-action-view rounded-md flex flex-col min-w-0 border-transparent">
                <div
                    className="display-flex flex-row py-15"
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <button
                        type="button"
                        className="variant-ghost-secondary display-flex flex-row gap-2 w-full text-left min-w-0 cursor-pointer"
                        style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                        aria-expanded={false}
                        data-settled-action="true"
                        onClick={toggleExpanded}
                    >
                        <div className="display-flex flex-row px-3 gap-2 min-w-0">
                            <div className="flex-1 display-flex mt-010">
                                <Icon
                                    icon={isHovered ? ArrowRightIcon : (config.icon ?? getAgentActionToolIcon(toolName))}
                                    className={isHovered ? undefined : config.iconClassName}
                                />
                            </div>
                            <div className="min-w-0 truncate font-color-secondary">{recordLabel}</div>
                        </div>
                    </button>
                    {headerLinkAction && (
                        <div className="display-flex flex-row items-center mr-2">
                            <Tooltip content={headerLinkAction.tooltip} singleLine>
                                <span
                                    className="font-color-secondary scale-10"
                                    style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={headerLinkAction.tooltip}
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        await headerLinkAction.onClick();
                                    }}
                                    onKeyDown={async (e) => {
                                        if (e.key !== 'Enter' && e.key !== ' ') return;
                                        e.stopPropagation();
                                        e.preventDefault();
                                        await headerLinkAction.onClick();
                                    }}
                                >
                                    <Icon icon={ArrowUpRightIcon} />
                                </span>
                            </Tooltip>
                        </div>
                    )}
                    <div className="flex-1" />
                </div>
            </div>
        );
    }

    // What the decision buttons act on, for assistive technology: two icon
    // buttons that both read "button" cannot be told apart.
    const actionLabel = getActionLabel(toolName, previewData?.actionData ?? action?.proposed_data);
    const decisionTarget = [actionLabel, actionTitle].filter((part) => !!part).join(' · ');
    // A change recorded without anyone being asked — queued under "Always
    // review later", or kept from a session that has ended — says it is
    // waiting on the user, since nothing else on the card does.
    const waitsForReview = !!action && !isAwaitingApproval && !isProcessing && status === 'pending';

    return (
        <div
            id={`tool-${toolcallId}`}
            data-approval-toolcall={toolcallId}
            className="agent-action-view rounded-md flex flex-col min-w-0 border-popup mb-2"
        >
            <div
                className={`
                    display-flex flex-row py-15 bg-senary items-start
                    ${isExpanded ? 'border-bottom-quinary' : ''}
                `}
            >
                <button
                    type="button"
                    className={`
                        variant-ghost-secondary display-flex flex-row py-15 gap-2 text-left mt-015
                        ${isProcessing ? 'opacity-80' : ''}
                    `}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    onClick={isProcessing ? () => {} : toggleExpanded}
                    disabled={isProcessing}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex flex-row ml-3 gap-2">
                        <div className="flex-1 display-flex mt-010 font-color-primary">
                            <Icon icon={getHeaderIcon()} className={shouldShowStatusIcon() ? config.iconClassName : undefined} />
                        </div>
                        <div className="two-line-header">
                            {/* Label off the same data the preview renders: a
                                count-carrying label would otherwise read as
                                singular while an approval is still pending and
                                no action row exists yet. */}
                            <span className="font-color-primary font-medium">{actionLabel}</span>
                            {actionTitle && <span className="font-color-secondary ml-15">{actionTitle}</span>}
                            {waitsForReview && (
                                <span className="font-color-tertiary ml-15">{t('Waiting for your review')}</span>
                            )}
                            {headerLinkAction && (
                                <>
                                    {'\u00A0'}
                                    <Tooltip content={headerLinkAction.tooltip} singleLine>
                                        <span
                                            className="font-color-secondary scale-10"
                                            style={{ display: 'inline-flex', verticalAlign: 'middle', cursor: 'pointer' }}
                                            role="button"
                                            aria-label={headerLinkAction.tooltip}
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                await headerLinkAction.onClick();
                                            }}
                                        >
                                            <Icon icon={ArrowUpRightIcon} />
                                        </span>
                                    </Tooltip>
                                </>
                            )}
                        </div>
                    </div>
                </button>

                <div className="flex-1" />

                <div
                    className="display-flex flex-row items-center gap-25 mr-2 mt-015"
                    style={{ visibility: !(isAwaitingApproval || status === 'pending') ? 'visible' : 'hidden' }}
                >
                    <Tooltip content={isExpanded ? t('Collapse') : t('Expand')} showArrow singleLine>
                        <IconButton
                            icon={ChevronIcon}
                            variant="ghost-secondary"
                            iconClassName="scale-12"
                            onClick={toggleExpanded}
                            ariaLabel={isExpanded ? t('Collapse {target}', { target: decisionTarget }) : t('Expand {target}', { target: decisionTarget })}
                        />
                    </Tooltip>
                </div>

                {((isAwaitingApproval || status === 'pending') && !isProcessing && !isConfirmAction && !hasNoActionData) && (
                    <div className="display-flex flex-row items-center gap-25 mr-3 mt-015">
                        {(!isProcessing || clickedButton === 'reject') && (
                            <Tooltip content={t('Reject')} showArrow singleLine>
                                <IconButton
                                    icon={CancelIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-red"
                                    onClick={isAwaitingApproval ? handleReject : handleRejectPending}
                                    disabled={isProcessing}
                                    loading={isProcessing && clickedButton === 'reject'}
                                    ariaLabel={t('Reject {target}', { target: decisionTarget })}
                                />
                            </Tooltip>
                        )}
                        {(!isProcessing || clickedButton === 'approve') && (
                            <Tooltip content={t('Apply')} showArrow singleLine>
                                <IconButton
                                    icon={TickIcon}
                                    variant="ghost-secondary"
                                    iconClassName="font-color-green scale-14"
                                    onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                                    disabled={isProcessing}
                                    loading={isProcessing && clickedButton === 'approve'}
                                    ariaLabel={t('Apply {target}', { target: decisionTarget })}
                                />
                            </Tooltip>
                        )}
                    </div>
                )}
            </div>

            {isExpanded && (
                <div className="display-flex flex-col">
                    {previewData ? (
                        <ActionPreview
                            toolName={toolName}
                            previewData={previewData}
                            status={status}
                            actions={actions}
                            runId={runId}
                            onDecideItem={isMultiAction ? handleDecideItem : undefined}
                            busyActionIds={inFlightActionIds}
                        />
                    ) : (
                        <div className="text-sm font-color-secondary">
                            {t('No preview available')}
                        </div>
                    )}

                    <div className="display-flex flex-row gap-2 px-2 py-2">
                        {/* A cost confirmation has no per-tool preference to offer:
                            what a request may spend is set once by the credit limit. */}
                        {(isAwaitingApproval || status === 'pending') && !hasNoActionData && !isConfirmAction && (
                            <DeferredToolPreferenceButton
                                toolName={preferenceToolName}
                                offersRunGrant={isAwaitingApproval && !!runApprovalLabel}
                                disabled={preferenceToolName === 'delete_annotations'}
                                tooltipContent={
                                    preferenceToolName === 'delete_annotations'
                                        ? t('Deleting annotations has its own rule, under Settings → Permissions → Annotation Deletion')
                                        : undefined
                                }
                            />
                        )}
                        <div className="flex-1" />

                        {config.showReject && (!isProcessing || clickedButton === 'reject') && (
                            <Button
                                variant="outline"
                                onClick={isAwaitingApproval ? handleReject : handleRejectPending}
                                loading={isProcessing && clickedButton === 'reject'}
                                disabled={isProcessing}
                            >
                                {t('Reject')}
                            </Button>
                        )}

                        {toolName === 'create_note' && action?.status === 'applied' && action?.result_data?.library_id && action?.result_data?.zotero_key && (
                            <Button
                                variant="outline"
                                onClick={handleRevealNote}
                                disabled={isProcessing}
                            >
                                {t('Reveal')}
                            </Button>
                        )}

                        {(config.showUndo || (isProcessing && clickedButton === 'undo')) && (
                            <Button
                                variant="outline"
                                onClick={handleUndo}
                                loading={isProcessing && clickedButton === 'undo'}
                                disabled={isProcessing}
                            >
                                {toolName === 'create_note' ? t('Delete') : t('Undo')}
                            </Button>
                        )}

                        {config.showRetry && (
                            <Button
                                variant="outline"
                                icon={RepeatIcon}
                                onClick={handleRetry}
                                loading={isProcessing}
                            >
                                {isUndoRetry ? t('Retry Undo') : t('Try Again')}
                            </Button>
                        )}

                        {config.showApply && (!isProcessing || clickedButton === 'approve') && (
                            isAwaitingApproval && runApprovalLabel ? (
                                <SplitApplyButton
                                    onApply={handleApprove}
                                    onApplyAll={handleApproveForRun}
                                    loading={isProcessing && clickedButton === 'approve'}
                                    disabled={isProcessing}
                                    applyAllLabel={runApprovalLabel}
                                    applyAllScope={runApprovalScope ?? undefined}
                                />
                            ) : (
                                <Button
                                    variant="solid"
                                    onClick={isAwaitingApproval ? handleApprove : handleApplyPending}
                                    loading={isProcessing && clickedButton === 'approve'}
                                    disabled={isProcessing}
                                >
                                    <span>{isConfirmAction ? t('Confirm') : t('Apply')}</span>
                                </Button>
                            )
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AgentActionView;
