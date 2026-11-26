import React from 'react';
import { AgentAction, isCreateAnnotationsAgentAction } from '../../../agents/agentActions';
import type { PendingApproval } from '@beaver/agent-ui/host';
import {
    CheckmarkCircleIcon,
    CancelCircleIcon,
    AlertIcon,
    Spinner,
    ClockIcon,
    PropertyEditIcon,
    FolderAddIcon,
    FolderDetailIcon,
    TaskDoneIcon,
    TagIcon,
    HighlighterIcon,
    DocumentValidationIcon,
    DollarCircleIcon,
    GlobalSearchIcon,
    NoteIcon,
    EditIcon,
} from '../../../components/icons/icons';
import { truncateText } from '@beaver/agent-ui/utils/stringUtils';
import { countEditAnnotationTargets } from './reviewChangeRows';
import { msg, t, tn } from '../../../../src/utils/i18n';

export type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error';

/**
 * Prompt user to confirm overwriting manually modified fields during undo.
 * Returns true if user confirms, false otherwise.
 */
export function confirmOverwriteManualChanges(modifiedFields: string[]): boolean {
    const fieldList = modifiedFields.join(', ');
    const title = t('Overwrite manual changes?');
    const message = modifiedFields.length === 1
        ? t('The field "{field}" has been manually modified since the edit was applied. Do you want to overwrite '
            + 'your changes and revert to the original value?', { field: fieldList })
        : t('The following fields have been manually modified since the edit was applied: {fields}. Do you want '
            + 'to overwrite your changes and revert to the original values?', { fields: fieldList });

    const buttonIndex = Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text: message,
        button0: Zotero.Prompt.BUTTON_TITLE_YES,
        button1: Zotero.Prompt.BUTTON_TITLE_NO,
        defaultButton: 1,
    });

    return buttonIndex === 0;
}

/**
 * Tools whose card stays open after the decision.
 *
 * Only a created note: its card is the note's record in the thread, with the
 * Reveal and Delete the user will want next. Highlights and sticky notes used
 * to be here too, and that is what kept a decided proposal at full height in
 * the answer — the card is a request, and once answered it folds to one line
 * like any other tool row (see `AgentActionView`).
 */
export const NEVER_AUTO_COLLAPSE_TOOLS = new Set(['create_note']);

/**
 * Shorten a backend error_message for inline display in action previews.
 *
 * Backend messages include agent-facing detail (multi-line lists, Zotero keys,
 * "Cannot <verb> <entity> '<name>' because ..." framing) that duplicates what
 * the headline + pill already show. Keep just the concise reason.
 */
export function shortenActionError(msg: string): string {
    let s = msg.split('\n')[0].replace(/[:.\s]+$/, '').trim();
    const becauseIdx = s.toLowerCase().indexOf(' because ');
    if (becauseIdx >= 0) {
        s = s.slice(becauseIdx + ' because '.length);
        s = s.charAt(0).toUpperCase() + s.slice(1);
    }
    return s;
}

export interface StatusConfig {
    icon: React.FC<React.SVGProps<SVGSVGElement>> | null;
    /** English; shown through `t`. */
    label: string;
    iconClassName?: string;
    showApply: boolean;
    showReject: boolean;
    showUndo: boolean;
    showRetry: boolean;
}

export const STATUS_CONFIGS: Record<ActionStatus | 'awaiting', StatusConfig> = {
    awaiting: {
        icon: Spinner,
        label: msg('Awaiting approval'),
        showApply: true,
        showReject: true,
        showUndo: false,
        showRetry: false,
    },
    pending: {
        icon: null,
        label: msg('Pending'),
        iconClassName: 'font-color-secondary',
        showApply: true,
        showReject: true,
        showUndo: false,
        showRetry: false,
    },
    applied: {
        icon: CheckmarkCircleIcon,
        label: msg('Applied'),
        iconClassName: 'font-color-green scale-11',
        showApply: false,
        showReject: false,
        showUndo: true,
        showRetry: false,
    },
    rejected: {
        icon: CancelCircleIcon,
        label: msg('Rejected'),
        iconClassName: 'font-color-red scale-11',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    undone: {
        icon: CancelCircleIcon,
        label: msg('Undone'),
        iconClassName: 'font-color-red scale-11',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    error: {
        icon: AlertIcon,
        label: msg('Failed'),
        iconClassName: 'color-error',
        showApply: false,
        showReject: false,
        showUndo: false,
        showRetry: true,
    },
};

/** Tool-specific icon shared by Zotero agent-action review surfaces. */
export function getAgentActionToolIcon(toolName: string): React.FC<React.SVGProps<SVGSVGElement>> {
    if (toolName === 'edit_metadata' || toolName === 'edit_item') return PropertyEditIcon;
    if (toolName === 'edit_note' || toolName === 'edit_note_batch') return EditIcon;
    if (toolName === 'create_note') return NoteIcon;
    if (toolName === 'create_highlight_annotations') return HighlighterIcon;
    if (toolName === 'create_note_annotations') return NoteIcon;
    if (toolName === 'edit_annotations' || toolName === 'delete_annotations') return HighlighterIcon;
    if (toolName === 'create_collection') return FolderAddIcon;
    if (toolName === 'organize_items') return TaskDoneIcon;
    if (toolName === 'manage_tags') return TagIcon;
    if (toolName === 'manage_collections') return FolderDetailIcon;
    if (toolName === 'create_items' || toolName === 'create_item') return DocumentValidationIcon;
    if (toolName === 'confirm_extraction') return DollarCircleIcon;
    if (toolName === 'confirm_external_search') return GlobalSearchIcon;
    return ClockIcon;
}

/**
 * Compute the overall status for a group of actions.
 * Used for batch operations where we need a single status to display.
 * Priority: pending > applied (even partial) > error (only if none applied) > rejected/undone
 *
 * Note: We prioritize 'applied' over 'error' when there are mixed results,
 * so users can still undo successfully applied items even if some failed.
 */
export function getOverallStatus(actions: AgentAction[]): ActionStatus {
    if (actions.length === 0) return 'pending';

    const statuses = actions.map(a => a.status);
    const hasApplied = statuses.some(s => s === 'applied');
    const hasPending = statuses.some(s => s === 'pending');
    const hasError = statuses.some(s => s === 'error');

    // If any is pending, show pending (still waiting)
    if (hasPending) return 'pending';
    // If any are applied, show applied (enables Undo for partial success)
    if (hasApplied) return 'applied';
    // If all have errors (none applied), show error
    if (hasError) return 'error';
    // If all are rejected or undone
    if (statuses.every(s => s === 'rejected' || s === 'undone')) return 'rejected';

    return 'pending';
}

/**
 * A bulk annotation apply that acked with nothing created reads as an error, not
 * as the `applied` its action record claims.
 */
export function getCreateAnnotationsDisplayStatus(action: AgentAction): ActionStatus | null {
    if (!isCreateAnnotationsAgentAction(action) || action.status !== 'applied') return null;
    const createdCount = Array.isArray(action.result_data?.created)
        ? action.result_data.created.length
        : 0;
    const failedCount = Array.isArray(action.result_data?.failed)
        ? action.result_data.failed.length
        : 0;
    return createdCount === 0 && failedCount > 0 ? 'error' : null;
}

/**
 * True when the failure on these actions came from an undo rather than an apply,
 * so a Retry can be pointed back at undo instead of re-running the change.
 *
 * Read off the records rather than remembered in component state, which does not
 * survive a remount or a failure triggered from another pane: only an applied
 * action carries `result_data`, a successful undo clears it, and the error path
 * preserves it — so an errored action that still has a result is one whose undo
 * failed. A write that succeeded but failed to acknowledge lands here too, where
 * undo is likewise the safer direction: re-applying would duplicate it.
 */
export function hasFailedUndo(actions: AgentAction[]): boolean {
    return actions.some((action) => action.status === 'error' && action.result_data != null);
}

/**
 * The changes a card's Apply or Try Again writes, of those it holds.
 *
 * While some are undecided, those: a paper the user left out on its own row
 * stays out. Otherwise the ones that failed, which is what Try Again offers
 * to retry — a paper declined beside a failed one is not part of it. With
 * none undecided or failed, every change on the card was rejected or undone,
 * and Apply takes that decision back for all of them.
 */
export function actionsToApply(actions: AgentAction[]): AgentAction[] {
    const undecided = actions.filter((action) => action.status === 'pending');
    if (undecided.length > 0) return undecided;
    const failed = actions.filter((action) => action.status === 'error');
    if (failed.length > 0) return failed;
    return actions.filter((action) => action.status === 'rejected' || action.status === 'undone');
}

/**
 * Get human-readable label for the action.
 *
 * `completed` switches the labels whose whole text is the verb into the past
 * tense, for the surfaces that describe a change already made rather than one
 * being proposed. The types left alone are the ones whose label is a noun
 * ("3 Highlights") or whose verb lives in the title instead (manage_tags,
 * manage_collections) — past-tensing those would fight the title.
 */
export function getActionLabel(
    toolName: string,
    actionData?: Record<string, any>,
    completed = false,
): string {
    switch (toolName) {
        case 'edit_metadata':
        case 'edit_item':
            return completed ? t('Edited') : t('Edit');
        case 'edit_note':
            return completed ? t('Edited Note') : t('Note Edit');
        case 'edit_note_batch':
            return completed ? t('Edited Note') : t('Note Edits');
        case 'create_note':
            return completed ? t('Created Note') : t('Create Note');
        case 'create_highlight_annotations': {
            const count = actionData?.items?.length ?? 0;
            return count > 1
                ? t('{count} Highlights', { count })
                : t('Highlight');
        }
        case 'create_note_annotations': {
            const count = actionData?.items?.length ?? 0;
            return count > 1
                ? t('{count} Sticky Notes', { count })
                : t('Sticky Note');
        }
        // Both annotation-mutation tools share one action type. The tool name is
        // what settles the verb: streaming tool arguments carry no `operation`,
        // so a deletion would otherwise read as an edit until its action row
        // arrives. The label carries the whole headline here — these actions
        // have no separate title.
        case 'edit_annotations':
        case 'delete_annotations': {
            const count = countEditAnnotationTargets(actionData);
            const isDelete = toolName === 'delete_annotations' || actionData?.operation === 'delete';
            if (count > 1) {
                return isDelete
                    ? (completed ? t('Deleted {count} Annotations', { count }) : t('Delete {count} Annotations', { count }))
                    : (completed ? t('Edited {count} Annotations', { count }) : t('Edit {count} Annotations', { count }));
            }
            return isDelete
                ? (completed ? t('Deleted Annotation') : t('Delete Annotation'))
                : (completed ? t('Edited Annotation') : t('Edit Annotation'));
        }
        case 'create_item':
        case 'create_items':
            return completed ? t('Imported') : t('Import');
        case 'create_collection':
            return completed ? t('Created Collection') : t('Create Collection');
        case 'organize_items':
            return completed ? t('Organized') : t('Organize');
        case 'manage_tags':
            return t('Tag');
        case 'manage_collections':
            return t('Collection');
        case 'confirm_extraction':
            return t('Extract');
        case 'confirm_external_search':
            return t('Search');
        default:
            return toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
}

export function getActionTitle(
    toolName: string,
    actionData: Record<string, any> | undefined,
    itemTitle: string | null,
    actions: AgentAction[] | undefined
): string | null {
    switch (toolName) {
        case 'edit_metadata':
        case 'edit_item':
        case 'edit_note':
        case 'edit_note_batch':
            return itemTitle ? itemTitle : null;
        case 'create_note':
            return actionData?.title ?? null;
        case 'create_highlight_annotations': {
            return itemTitle;
        }
        case 'create_note_annotations': {
            return itemTitle;
        }
        // No title: the label already reads "Edit 2 Annotations", and the
        // preview names the annotations themselves.
        case 'edit_annotations':
        case 'delete_annotations':
            return null;
        case 'create_collection':
            return actionData?.name ?? actionData?.proposed_data?.name ?? null;
        case 'organize_items': {
            const itemCount = actionData?.item_ids?.length ?? 0;
            if (itemCount === 0) return null;
            return itemCount === 1 && itemTitle
                ? itemTitle
                : tn(itemCount, '{count} item', '{count} items');
        }
        case 'manage_tags': {
            const name = actionData?.name;
            const op = actionData?.action;
            if (!name) return null;
            if (op === 'delete') return t('Delete tag "{name}"', { name });
            const newName = actionData?.new_name;
            if (newName) {
                return actionData?.is_merge
                    ? t('Merge "{name}" → "{newName}"', { name, newName })
                    : t('Rename "{name}" → "{newName}"', { name, newName });
            }
            return t('Tag "{name}"', { name });
        }
        case 'manage_collections': {
            const op = actionData?.action;
            const collectionName = actionData?.collection_name ?? actionData?.old_name ?? actionData?.name;
            if (op === 'delete') {
                return collectionName ? t('Delete "{name}"', { name: collectionName }) : t('Delete collection');
            }
            if (op === 'move') {
                return collectionName ? t('Move "{name}"', { name: collectionName }) : t('Move collection');
            }
            if (op === 'rename') {
                const newName = actionData?.new_name;
                if (collectionName && newName) {
                    return t('Rename "{name}" → "{newName}"', { name: collectionName, newName });
                }
                if (newName) return t('Rename → "{newName}"', { newName });
            }
            return collectionName ?? null;
        }
        case 'confirm_extraction': {
            const count = actionData?.attachment_count ?? 0;
            return t('Confirm {count} Item Batch Processing', { count });
        }
        case 'confirm_external_search': {
            return t('Confirm External Search');
        }
        case 'create_item':
        case 'create_items': {
            // For create_item, get title from the item data
            // Check actions first, then fall back to actionData (for pending approvals where actions may be empty)
            if (actions && actions.length === 1) {
                const item = actions[0].proposed_data?.item ?? actionData?.item;
                if (item?.title) {
                    return truncateText(item.title, 70);
                }
            } else if ((!actions || actions.length === 0) && actionData?.item?.title) {
                // Pending approval case: actions not yet stored, but we have item data
                return truncateText(actionData.item.title, 60);
            }
            return actions && actions.length > 1 ? t('{count} Items', { count: actions.length }) : t('Item');
        }
        default:
            return null;
    }
}

/**
 * Preview data produced from either a pending approval or a stored agent action.
 * Consumed by the ActionPreview dispatcher component.
 */
export interface PreviewData {
    actionType: string;
    actionData: Record<string, any>;
    currentValue?: any;
    resultData?: Record<string, any>;
    errorMessage?: string;
}

/**
 * Build preview data from either pending approval or agent action
 */
export function buildPreviewData(
    toolName: string,
    pendingApproval: PendingApproval | null,
    action: AgentAction | null
): PreviewData | null {
    if (pendingApproval) {
        return {
            actionType: pendingApproval.actionType,
            actionData: pendingApproval.actionData,
            currentValue: pendingApproval.currentValue,
        };
    }

    if (action) {
        return {
            actionType: action.action_type,
            actionData: action.proposed_data,
            currentValue: undefined, // We don't have this for stored actions
            resultData: action.result_data,
            errorMessage: action.error_message,
        };
    }

    return null;
}
