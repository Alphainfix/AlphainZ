import { atom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import { allRunsAtom, currentThreadIdAtom, isLoadingThreadAtom } from '@beaver/agent-core/run-state/atoms';
import { isLibraryReferencePortable, resolveItemReference, resolveLibraryRef } from '../../src/utils/libraryIdentity';
import { checkLibraryExcluded } from '../../src/services/agentDataProvider/utils';
import { isLocalApprovalWaiting, settleLocalApproval } from '../utils/localApprovals';
import { updateDiffPreviewForNote } from '../utils/diffPreviewCoordinator';
import { agentActionsService, AckActionLink } from '@beaver/agent-core/transport/clients/agentActionsService';
import { notifyApprovalRequest } from '../../src/services/systemNotifications';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { ActionStatus } from '@beaver/agent-core/types/agentActions/base';
import type { WSDeferredApprovalRequest, AgentActionType } from '@beaver/agent-core/protocol/agentProtocol';
// Declared in the shared host contract, since the render layer hands it to the
// host's in-stream action UI.
import type { PendingApproval } from '@beaver/agent-ui/host';
import {
    AgentAction,
    CreateItemAgentAction,
    isCreateItemAgentAction,
    isCreateAnnotationsAgentAction,
    isEditAnnotationsAgentAction,
    isAnnotationAgentAction,
    hasAppliedZoteroItem,
    hasAppliedBulkAnnotations,
    getZoteroItemReferenceFromAgentAction,
} from '@beaver/agent-core/agents/agentActionTypes';

export * from '@beaver/agent-core/agents/agentActionTypes';

// =============================================================================
// Applied Action Validation
// =============================================================================

/**
 * Get Zotero item from an applied agent action
 */
export const getZoteroItemFromAgentAction = async (action: AgentAction): Promise<Zotero.Item | null> => {
    const ref = getZoteroItemReferenceFromAgentAction(action);
    if (!ref) return null;
    const resolved = await resolveItemReference(ref);
    return resolved.status === 'found' ? resolved.item : null;
};

/**
 * Validation result for an applied agent action.
 *
 * - 'valid': the applied item was found and matches expectations.
 * - 'invalid': the item is verifiably gone (or has the wrong type). The user
 *   reverted the action in Zotero.
 * - 'unverifiable': the reference cannot be checked on this device.
 */
export type AppliedActionValidity = 'valid' | 'invalid' | 'unverifiable';

const checkAppliedReference = async (
    ref: ZoteroItemReference,
    mustBeAnnotation: boolean,
    // Actions that only move an item to the trash leave it resolvable, so its
    // existence proves nothing: being trashed *is* the applied state. Restoring
    // it from the trash is the user reverting the action.
    mustBeTrashed: boolean = false
): Promise<AppliedActionValidity> => {
    // Validation reads live Zotero state and can flip the action to "undone"
    // both locally and on the backend, so it stays behind the exclusion
    // boundary — unlike rendering persisted history, which is allowed. An
    // excluded library is simply not checkable; the status is left alone.
    const libraryId = resolveLibraryRef(ref);
    if (libraryId !== null && checkLibraryExcluded(libraryId)) return 'unverifiable';
    const resolved = await resolveItemReference(ref);
    if (resolved.status === 'library_unavailable') return 'unverifiable';
    if (resolved.status === 'not_found') {
        // "Not found" is only decisive when the reference identifies its
        // library portably. A legacy reference (no library_ref) into a group
        // library resolves through a device-local library_id, so a miss may
        // just mean that id maps to a different group on this device — not
        // that the item is gone. Never conclude anything from that.
        if (!isLibraryReferencePortable(ref)) return 'unverifiable';
        // Portable and missing: for an action whose applied state IS deletion,
        // the user emptied the trash and the deletion became permanent, so the
        // action still holds. For anything else, the item being gone is the
        // revert.
        return mustBeTrashed ? 'valid' : 'invalid';
    }
    if (mustBeAnnotation && !resolved.item.isAnnotation()) return 'invalid';
    if (mustBeTrashed && !resolved.item.deleted) return 'invalid';
    return 'valid';
};

/**
 * Validates that an applied agent action is still valid on this device.
 * @param action - The agent action to validate
 * @returns 'valid', 'invalid' (verifiably reverted), or 'unverifiable'
 */
export const validateAppliedAgentAction = async (action: AgentAction): Promise<AppliedActionValidity> => {
    if (isCreateAnnotationsAgentAction(action)) {
        if (!hasAppliedBulkAnnotations(action)) return 'valid';
        const created = action.result_data?.created ?? [];
        let unverifiable = false;
        for (const ref of created) {
            const validity = await checkAppliedReference(ref, true);
            if (validity === 'invalid') return 'invalid';
            if (validity === 'unverifiable') unverifiable = true;
        }
        return unverifiable ? 'unverifiable' : 'valid';
    }

    if (isEditAnnotationsAgentAction(action)) {
        const updated = action.result_data?.applied_refs ?? [];
        // A delete keeps its applied_refs pointing at the (soft-deleted)
        // originals, so the applied state is "still in the trash". An edit's
        // applied_refs are live annotations — a move rewrites them in place,
        // so identity is stable there too.
        const mustBeTrashed = action.result_data?.operation === 'delete';
        let unverifiable = false;
        for (const ref of updated) {
            const validity = await checkAppliedReference(ref, true, mustBeTrashed);
            if (validity === 'invalid') return 'invalid';
            if (validity === 'unverifiable') unverifiable = true;
        }
        return unverifiable ? 'unverifiable' : 'valid';
    }

    // If action doesn't have an applied Zotero item, it's valid (nothing to check)
    if (!hasAppliedZoteroItem(action)) return 'valid';

    const ref = getZoteroItemReferenceFromAgentAction(action);
    if (!ref) return 'valid';

    // For annotation actions, the resolved item must still be an annotation
    return checkAppliedReference(ref, isAnnotationAgentAction(action));
};

// =============================================================================
// State Atoms
// =============================================================================

/**
 * All agent actions for the current thread/session.
 */
export const threadAgentActionsAtom = atom<AgentAction[]>([]);

// =============================================================================
// Derived Atoms - Group by toolcall_id
// =============================================================================

function groupActionsByToolcall(actions: AgentAction[]): Map<string, AgentAction[]> {
    const grouped = new Map<string, AgentAction[]>();
    actions.forEach((action) => {
        const targetId = action.toolcall_id;
        if (!targetId) return;
        if (!grouped.has(targetId)) {
            grouped.set(targetId, []);
        }
        grouped.get(targetId)!.push(action);
    });
    return grouped;
}

export const agentActionsByToolcallAtom = atom<Map<string, AgentAction[]>>((get) => {
    const actions = get(threadAgentActionsAtom);
    return groupActionsByToolcall(actions);
});

export const getAgentActionsByToolcallAtom = atom(
    (get) => (toolcallId: string, filter: (action: AgentAction) => boolean = () => true) => 
        get(agentActionsByToolcallAtom).get(toolcallId)?.filter(filter) || []
);

// =============================================================================
// Derived Atoms - Group by run_id
// =============================================================================

function groupActionsByRun(actions: AgentAction[]): Map<string, AgentAction[]> {
    const grouped = new Map<string, AgentAction[]>();
    actions.forEach((action) => {
        const targetId = action.run_id;
        if (!targetId) return;
        if (!grouped.has(targetId)) {
            grouped.set(targetId, []);
        }
        grouped.get(targetId)!.push(action);
    });
    return grouped;
}

export const agentActionsByRunAtom = atom<Map<string, AgentAction[]>>((get) => {
    const actions = get(threadAgentActionsAtom);
    return groupActionsByRun(actions);
});

export const getAgentActionsByRunAtom = atom(
    (get) => (runId: string, filter: (action: AgentAction) => boolean = () => true) => 
        get(agentActionsByRunAtom).get(runId)?.filter(filter) || []
);

export const getAgentActionByIdAtom = atom(
    (get) => (actionId: string): AgentAction | null => {
        return get(threadAgentActionsAtom).find((action) => action.id === actionId) ?? null;
    }
);

/**
 * Compare two raw tag strings for equality.
 * Used to match against the raw_tag from agent actions.
 */
function tagsMatch(tag1: string, tag2: string): boolean {
    const parseTag = (tag: string) => {
        const match = tag.match(/<(\w+)([^>]*)>/);
        if (!match) return null;
        
        const tagName = match[1];
        const attrsString = match[2];
        
        // Extract attributes
        const attrs: Record<string, string> = {};
        const attrRegex = /(\w+)="([^"]*)"/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrsString)) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
        }
        
        return { tagName, attrs };
    };
    
    const parsed1 = parseTag(tag1);
    const parsed2 = parseTag(tag2);
    
    if (!parsed1 || !parsed2) return false;
    if (parsed1.tagName !== parsed2.tagName) return false;
    
    // Compare attributes
    const keys1 = Object.keys(parsed1.attrs).sort();
    const keys2 = Object.keys(parsed2.attrs).sort();
    
    if (keys1.length !== keys2.length) return false;
    
    return keys1.every((key, i) => 
        key === keys2[i] && parsed1.attrs[key] === parsed2.attrs[key]
    );
}

/**
 * Get a note agent action by matching raw_tag within a specific run.
 * Used for streaming when note tags don't have an id attribute.
 */
export const getAgentNoteActionByRawTagAtom = atom(
    (get) => (runId: string, rawTag: string): AgentAction | null => {
        return get(threadAgentActionsAtom).find((action) => 
            action.run_id === runId &&
            action.action_type === 'zotero_note' &&
            tagsMatch(action.proposed_data?.raw_tag ?? '', rawTag)
        ) ?? null;
    }
);

// =============================================================================
// Mutation Atoms
// =============================================================================

/**
 * Add agent actions to the thread state
 */
export const addAgentActionsAtom = atom(
    null,
    (_, set, actions: AgentAction[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => [...prev, ...actions]);
    }
);

/**
 * Upsert agent actions - updates existing actions (by id) or adds new ones.
 * Used when receiving agent_actions events which may contain updates to existing actions.
 */
export const upsertAgentActionsAtom = atom(
    null,
    (_, set, newActions: AgentAction[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const newActionsById = new Map(newActions.map(a => [a.id, a]));
            
            // Update existing actions if they match
            const updated = prev.map(existing => {
                const update = newActionsById.get(existing.id);
                if (update) {
                    newActionsById.delete(existing.id); // Mark as processed
                    const merged = { ...existing, ...update };
                    // Preserve existing proposed_data when update has empty proposed_data
                    // (backend may send status updates without full proposed_data)
                    if (existing.proposed_data && Object.keys(existing.proposed_data).length > 0 &&
                        (!update.proposed_data || Object.keys(update.proposed_data).length === 0)) {
                        merged.proposed_data = existing.proposed_data;
                    }
                    // Same for result_data
                    if (existing.result_data && Object.keys(existing.result_data).length > 0 &&
                        (!update.result_data || Object.keys(update.result_data).length === 0)) {
                        merged.result_data = existing.result_data;
                    }
                    return merged;
                }
                return existing;
            });
            
            // Add remaining new actions (those not already in the list)
            const additions = Array.from(newActionsById.values());
            return [...updated, ...additions];
        });
    }
);

/**
 * Delete agent actions by IDs
 */
export const deleteAgentActionsAtom = atom(
    null,
    (_, set, actionIds: string[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => 
            prev.filter((action) => !actionIds.includes(action.id))
        );
    }
);

export type AgentActionUpdate = Partial<AgentAction> & { id: string };

/**
 * Update multiple agent actions
 */
export const updateAgentActionsAtom = atom(
    null,
    (_, set, updates: AgentActionUpdate[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const updateMap = new Map(updates.map((update) => [update.id, update]));
            return prev.map((action) => 
                updateMap.has(action.id) 
                    ? { ...action, ...updateMap.get(action.id)! } 
                    : action
            );
        });
    }
);

/**
 * Record agent actions as applied, with their result data.
 *
 * The record on screen — stored with its run — is what makes a change
 * "applied": it is what Undo works from and what a reopened thread shows. The
 * acknowledgement sent to Beaver's server afterwards is a courtesy the server
 * may not be there to receive: with the model run locally there is no account,
 * and the request fails before it is sent. That failure is logged and never
 * thrown, because the write has already happened: a caller that treated it as
 * the write failing would show "Failed" over a change that is in the library,
 * and a retry would make it a second time.
 */
export const ackAgentActionsAtom = atom(
    null,
    async (_, set, runId: string, actionResultData: AckActionLink[]) => {
        // Note: this is not where the completed-changes card learns about a
        // write. Both a run's own writes and the applies the user makes from
        // the review card afterwards acknowledge here, and the card shows only
        // the former — see `sessionAppliedActionIdsAtom`.

        const actionIds = actionResultData.map((result) => result.action_id);
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) =>
                actionIds.includes(action.id)
                    ? {
                        ...action,
                        status: 'applied' as ActionStatus,
                        result_data: actionResultData.find((result) => result.action_id === action.id)?.result_data
                    }
                    : action
            );
        });

        // A proposal applied some other way — a paper imported from its
        // reference in the answer, say — is decided: its card must not stay
        // up asking, and an Approve on it would add the paper a second time.
        const settled = actionIds.filter((actionId) => settleLocalApproval(actionId));
        if (settled.length > 0) set(removePendingApprovalsAtom, settled);

        try {
            const response = await agentActionsService.acknowledgeActions(
                runId,
                actionResultData
            );
            if (!response.success) {
                logger(`ackAgentActionsAtom: failed to acknowledge actions for run ${runId}: ${response.errors.map((error) => error.detail).join(', ')}`, 1);
                return;
            }
            return response;
        } catch (error) {
            logger(`ackAgentActionsAtom: could not acknowledge actions for run ${runId} (${error}); the local record stands`, 1);
            return;
        }
    }
);

/**
 * Set agent actions to error status.
 * Updates both UI state and backend.
 */
export const setAgentActionsToErrorAtom = atom(
    null,
    (_, set, actionIds: string[], errorMessage: string, errorDetails?: Record<string, any>) => {
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => 
                actionIds.includes(action.id)
                    ? { ...action, status: 'error' as ActionStatus, error_message: errorMessage }
                    : action
            );
        });
        // Backend: Update each action
        for (const actionId of actionIds) {
            agentActionsService.updateAction(actionId, {
                status: 'error',
                error_message: errorMessage,
                error_details: errorDetails,
            }).catch((error) => {
                logger(`setAgentActionsToErrorAtom: failed to persist error status for action ${actionId}: ${error}`, 1);
            });
        }
    }
);

/**
 * Reject an agent action.
 * Updates both UI state and backend.
 */
export const rejectAgentActionAtom = atom(
    null,
    (_, set, actionId: string) => {
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => action.id === actionId
                ? { ...action, status: 'rejected' as ActionStatus, result_data: undefined, error_message: undefined }
                : action
            );
        });
        // Backend: Update action state
        agentActionsService.updateAction(actionId, {
            status: 'rejected',
            clear_result_data: true,
            clear_error_message: true,
        }).catch((error) => {
            logger(`rejectAgentActionAtom: failed to persist state for action ${actionId}: ${error}`, 1);
        });
    }
);

/**
 * Undo an applied agent action.
 * Updates both UI state and backend.
 */
export const undoAgentActionAtom = atom(
    null,
    (_, set, actionId: string) => {
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => {
                if (action.id !== actionId) return action;
                // Preserve undo-critical fields from result_data into proposed_data before
                // clearing, so the preview can show the before/after diff in the "undone" state.
                let proposed_data = action.proposed_data;
                if (action.result_data?.old_creators && !proposed_data?.old_creators) {
                    proposed_data = { ...proposed_data, old_creators: action.result_data.old_creators };
                }
                if (action.result_data?.undo_full_html && !proposed_data?.undo_full_html) {
                    proposed_data = { ...proposed_data, undo_full_html: action.result_data.undo_full_html };
                }
                return { ...action, proposed_data, status: 'undone' as ActionStatus, result_data: undefined, error_message: undefined };
            });
        });
        // Backend: Update action state
        agentActionsService.updateAction(actionId, {
            status: 'undone',
            clear_result_data: true,
            clear_error_message: true,
        }).catch((error) => {
            logger(`undoAgentActionAtom: failed to persist state for action ${actionId}: ${error}`, 1);
        });
    }
);

/**
 * Find a pending create_item agent action by source_id.
 * Used to sync external-reference action buttons with pending create-item actions.
 */
export const getPendingCreateItemActionBySourceIdAtom = atom(
    (get) => (sourceId: string): CreateItemAgentAction | null => {
        const actions = get(threadAgentActionsAtom);
        return actions.find(
            (action): action is CreateItemAgentAction =>
                isCreateItemAgentAction(action) &&
                (action.status === 'pending' || action.status === 'undone' || action.status === 'error' || action.status === 'rejected') &&
                action.proposed_data.item.source_id === sourceId
        ) ?? null;
    }
);

/**
 * Clear all agent actions (e.g., when switching threads)
 */
export const clearAgentActionsAtom = atom(
    null,
    (_, set) => {
        set(threadAgentActionsAtom, []);
    }
);

// =============================================================================
// Writes in flight
// =============================================================================

/**
 * Action ids with a Zotero write in flight, claimed where a write starts rather
 * than by any one surface.
 *
 * An action stays `pending` until its write finishes and its record is
 * updated, and every surface that can reach a pending action offers to apply
 * it — the in-stream card, the review card, the per-paper rows of an import.
 * Surfaces each guarding only their own buttons would let a second click
 * through: two applies duplicate the change, and a reject landing on an action
 * whose write is still running is overwritten by the write's `applied`, so the
 * user's "no" is lost while the change stays in the library.
 *
 * Both write paths claim here: the executor behind those surfaces, and a
 * proposal the user answers on its approval card, from the moment the answer
 * arrives until its outcome is recorded. An atom rather than a plain Set
 * because the claim is the only thing that knows a write is running — the
 * status says `pending` throughout — so surfaces observe it to disable their
 * controls.
 */
export const inFlightAgentActionIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

/** Claim these ids for a write; returns the ones this call claimed (not already in flight). */
export const claimAgentActionIdsAtom = atom(
    null,
    (get, set, actionIds: Iterable<string>): string[] => {
        const inFlight = get(inFlightAgentActionIdsAtom);
        const claimed = [...new Set(actionIds)].filter((id) => !inFlight.has(id));
        if (claimed.length > 0) {
            const next = new Set(inFlight);
            for (const id of claimed) next.add(id);
            set(inFlightAgentActionIdsAtom, next);
        }
        return claimed;
    },
);

/** Release ids claimed with `claimAgentActionIdsAtom`. */
export const releaseAgentActionIdsAtom = atom(
    null,
    (get, set, actionIds: Iterable<string>) => {
        const inFlight = get(inFlightAgentActionIdsAtom);
        const next = new Set(inFlight);
        for (const id of actionIds) next.delete(id);
        if (next.size !== inFlight.size) set(inFlightAgentActionIdsAtom, next);
    },
);

/**
 * Proposals whose approval has been answered and whose outcome is still being
 * recorded.
 *
 * The card goes the moment the user answers, but the proposal's record stays
 * pending until its write lands. It is still the card's business meanwhile:
 * the review card leaves it alone, as it does a live approval, instead of
 * listing it for review for as long as the write takes.
 */
export const answeredApprovalIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

/**
 * A proposal's approval was answered: claim its write, and keep it with the
 * card that asked until `endProposalOutcomeAtom`.
 */
export const beginProposalOutcomeAtom = atom(null, (get, set, actionId: string) => {
    set(claimAgentActionIdsAtom, [actionId]);
    const answered = get(answeredApprovalIdsAtom);
    if (!answered.has(actionId)) set(answeredApprovalIdsAtom, new Set([...answered, actionId]));
});

/** The answered proposal's outcome is recorded. */
export const endProposalOutcomeAtom = atom(null, (get, set, actionId: string) => {
    set(releaseAgentActionIdsAtom, [actionId]);
    const answered = get(answeredApprovalIdsAtom);
    if (!answered.has(actionId)) return;
    const next = new Set(answered);
    next.delete(actionId);
    set(answeredApprovalIdsAtom, next);
});


// =============================================================================
// Deferred Tool Approval State
// =============================================================================

/**
 * Where a proposal was made: the run whose card shows it, and that run's
 * conversation.
 *
 * Proposals a local run makes outlive the run — they stay on their cards until
 * the user decides, across later messages and while other conversations are
 * open — so every surface that lists them needs to know whose they are. An
 * approval without a scope is one the backend asked for over the socket, which
 * only ever concerns the run on screen.
 */
export interface PendingApprovalScope {
    runId: string;
    threadId: string;
    /** The conversation's name when the proposal was made, for pointing back at it. */
    threadName?: string | null;
}

/** A pending approval together with where it was proposed, when that is known. */
export type ScopedPendingApproval = PendingApproval & Partial<PendingApprovalScope>;

/**
 * Atom storing all pending approval requests, keyed by actionId.
 * Supports multiple parallel approvals for parallel tool calls.
 */
export const pendingApprovalsAtom = atom<Map<string, ScopedPendingApproval>>(new Map());

/**
 * Add a pending approval from a WS event.
 * Supports multiple concurrent approvals for parallel tool calls.
 *
 * @param scope  The run and conversation a local proposal belongs to.
 */
export const addPendingApprovalAtom = atom(
    null,
    (_, set, event: WSDeferredApprovalRequest, scope?: PendingApprovalScope) => {
        set(pendingApprovalsAtom, (prev) => {
            const next = new Map(prev);
            next.set(event.action_id, {
                actionId: event.action_id,
                toolcallId: event.toolcall_id,
                actionType: event.action_type as AgentActionType,
                actionData: event.action_data,
                currentValue: event.current_value,
                ...(scope ?? {}),
            });
            return next;
        });

        // Trigger in-editor diff preview for edit_note / edit_note_batch approvals
        if (event.action_type === 'edit_note' || event.action_type === 'edit_note_batch') {
            const { library_id, zotero_key } = event.action_data || {};
            if (library_id != null && zotero_key) {
                updateDiffPreviewForNote(library_id, zotero_key);
            }
        }

        // Surface an OS-native notification if the user can't currently see
        // the approval UI (e.g. working in another app).
        notifyApprovalRequest(event);
    }
);

/**
 * Remove pending approvals in one map update, then refresh any affected note
 * previews from the final state. This avoids briefly re-showing a preview while
 * a same-group approval batch is being removed.
 */
export const removePendingApprovalsAtom = atom(
    null,
    (get, set, actionIds: Iterable<string>) => {
        const ids = new Set(actionIds);
        if (ids.size === 0) return;

        const prev = get(pendingApprovalsAtom);
        const affectedNotes = new Map<string, { libraryId: number; zoteroKey: string }>();
        for (const actionId of ids) {
            const removed = prev.get(actionId);
            if (removed?.actionType !== 'edit_note' && removed?.actionType !== 'edit_note_batch') continue;
            const libraryId = removed.actionData?.library_id;
            const zoteroKey = removed.actionData?.zotero_key;
            if (libraryId == null || !zoteroKey) continue;
            affectedNotes.set(`${libraryId}-${zoteroKey}`, { libraryId, zoteroKey });
        }

        set(pendingApprovalsAtom, (p) => {
            const next = new Map(p);
            for (const actionId of ids) next.delete(actionId);
            return next;
        });

        for (const { libraryId, zoteroKey } of affectedNotes.values()) {
            updateDiffPreviewForNote(libraryId, zoteroKey);
        }
    }
);

/** Remove a specific pending approval by actionId (after user responds). */
export const removePendingApprovalAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(removePendingApprovalsAtom, [actionId]);
    },
);

/**
 * Clear the approvals a connection carried, when it goes away.
 *
 * An approval the backend asked for over the socket dies with the socket: the
 * backend is no longer waiting, and its card could never be answered. A
 * proposal a local run made is not carried by any connection. It waits here
 * for the user, and only the user's own click declines it — so it keeps its
 * card, and the write behind it still happens if they approve.
 */
export const clearAllPendingApprovalsAtom = atom(
    null,
    (get, set) => {
        const unanswerable = [...get(pendingApprovalsAtom).keys()]
            .filter((actionId) => !isLocalApprovalWaiting(actionId));
        // Refreshes the in-editor diff preview of any note these were about.
        set(removePendingApprovalsAtom, unanswerable);
    }
);

// Note: the run-blocking ask_user_question state (PendingQuestion,
// pendingQuestionsAtom, ...) lives in `./pendingQuestions.ts` — questions are
// deliberately NOT agent actions (no apply/undo/validate lifecycle).

/**
 * Get pending approval for a specific toolcall_id.
 * Searches the map for an approval matching the toolcall_id.
 */
export const getPendingApprovalForToolcallAtom = atom(
    (get) => (toolcallId: string): ScopedPendingApproval | null => {
        const pendingMap = get(pendingApprovalsAtom);
        for (const pending of pendingMap.values()) {
            if (pending.toolcallId === toolcallId) {
                return pending;
            }
        }
        return null;
    }
);

/**
 * Every pending approval of one tool call, in the order they were proposed.
 *
 * Most calls propose one change, but adding papers proposes one per paper
 * under the same call, and a card that looked only at the first would leave
 * the others pending with nothing on screen to decide them by.
 */
export function pendingApprovalsForToolcall(
    approvals: Iterable<ScopedPendingApproval>,
    toolcallId: string,
): ScopedPendingApproval[] {
    const matching: ScopedPendingApproval[] = [];
    for (const approval of approvals) {
        if (approval.toolcallId === toolcallId) matching.push(approval);
    }
    return matching;
}

/**
 * Check if there are any pending approvals.
 */
export const hasPendingApprovalsAtom = atom(
    (get) => get(pendingApprovalsAtom).size > 0
);

/**
 * Split pending approvals by where their cards are: in the conversation on
 * screen, or in another one.
 *
 * A proposal's card renders with the run that made it, so it is here when
 * that run is one of the runs on screen — or, while the open conversation's
 * runs are still loading, when it names that conversation. Once they have
 * loaded, a proposal of the open conversation whose run is not among them
 * has no card anywhere — its run is gone, as when the chat was deleted
 * forever — so it is in neither list: nothing on screen shows what it would
 * change, and there is no other chat to open. An approval without a run is
 * one the backend asked for, which concerns the run on screen.
 *
 * @param isLoadingOpenThread  Whether the open conversation's runs are still
 *   being read.
 */
export function partitionPendingApprovals(
    approvals: Iterable<ScopedPendingApproval>,
    openRunIds: ReadonlySet<string>,
    openThreadId: string | null,
    isLoadingOpenThread: boolean,
): { here: ScopedPendingApproval[]; elsewhere: ScopedPendingApproval[] } {
    const here: ScopedPendingApproval[] = [];
    const elsewhere: ScopedPendingApproval[] = [];
    for (const approval of approvals) {
        if (!approval.runId || openRunIds.has(approval.runId)) {
            here.push(approval);
        } else if (openThreadId === null || approval.threadId !== openThreadId) {
            elsewhere.push(approval);
        } else if (isLoadingOpenThread) {
            here.push(approval);
        }
    }
    return { here, elsewhere };
}

/** Pending approvals split into this conversation's and other conversations'. */
export const pendingApprovalsByLocationAtom = atom((get) => partitionPendingApprovals(
    get(pendingApprovalsAtom).values(),
    new Set(get(allRunsAtom).map((run) => run.id)),
    get(currentThreadIdAtom),
    get(isLoadingThreadAtom),
));

// Note: an entry in `pendingApprovalsAtom` means something is waiting on this
// decision — the backend over the socket, or a local proposal's task. Do not
// rebuild entries from stored pending actions — a stored pending action has no
// waiter (it outlived its session, or a backend timeout), so a re-added entry
// would show an "awaiting approval" card whose Approve button sends into the
// void. Such actions are applied locally through the `status === 'pending'`
// controls instead, and `staleApprovalActionIdsAtom` marks approvals whose
// channel has closed.
