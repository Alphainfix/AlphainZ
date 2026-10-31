import React, { useEffect, useState } from 'react';
import { logger } from '@beaver/agent-core/platform/logger';
import type { AgentAction } from '../../../agents/agentActions';
import type { OrganizeItemsResultData } from '@beaver/agent-core/types/agentActions/base';
import { EditMetadataPreview } from './EditMetadataPreview';
import { CreateCollectionPreview } from './CreateCollectionPreview';
import { OrganizeItemsPreview } from './OrganizeItemsPreview';
import { CreateItemsPreview } from './CreateItemsPreview';
import { ConfirmExtractionPreview } from './ConfirmExtractionPreview';
import { ConfirmExternalSearchPreview } from './ConfirmExternalSearchPreview';
import { EditNotePreview } from '../../../components/agentRuns/EditNotePreview';
import { CreateNotePreview } from './CreateNotePreview';
import { ManageTagsPreview } from './ManageTagsPreview';
import { ManageCollectionsPreview } from './ManageCollectionsPreview';
import { CreateAnnotationsPreview } from './CreateAnnotationsPreview';
import { EditAnnotationsPreview } from './EditAnnotationsPreview';
import { DeleteAnnotationsPreview } from './DeleteAnnotationsPreview';
import { resolveItemReference, resolveLibraryRef, resolveObjectId } from '../../../../src/utils/libraryIdentity';
import { shortItemTitle } from '../../../../src/utils/zoteroUtils';
import type { ActionStatus, PreviewData } from './agentActionViewHelpers';
import {
    getBatchRewriteOldContent,
    getEditNotePreviewKind,
} from './editNoteBatchPreviewData';

/** A library's name, when it is on this device. */
function libraryNameFor(libraryRef: string | undefined, libraryId: number | undefined): string | null {
    try {
        const localId = resolveLibraryRef({ library_ref: libraryRef, library_id: libraryId });
        if (!localId) return null;
        const library = Zotero.Libraries.get(localId);
        return library ? library.name : null;
    } catch {
        return null;
    }
}

/**
 * Where a new note goes: under a paper, or on its own in a library.
 *
 * A note the assistant writes for a paper is filed as that paper's child,
 * which the note's text does not say. The card says it before the note is
 * approved, and once it is saved, where it went.
 */
const NoteDestination: React.FC<{ previewData: PreviewData; status: ActionStatus | 'awaiting' }> = ({
    previewData,
    status,
}) => {
    const saved = status === 'applied' && !!previewData.resultData;
    const source: Record<string, any> = (saved ? previewData.resultData : previewData.actionData) ?? {};
    const proposal: Record<string, any> = previewData.actionData ?? {};
    /*
     * Which paper the note goes under. Once it is saved, the result says: it
     * carries `parent_key` only when the note was filed under a paper. Before
     * that, validation says: it always sets `parent_key`, to the paper's key,
     * or to null for a note that stands on its own (the id the model gave
     * named a standalone PDF or note, which cannot hold child notes). Only a
     * proposal validation has not seen lacks the field, and then the id the
     * model gave still names the paper.
     */
    const validated = Object.prototype.hasOwnProperty.call(proposal, 'parent_key');
    const fromId = !saved && !validated && typeof proposal.parent_item_id === 'string'
        ? resolveObjectId(proposal.parent_item_id)
        : null;
    const parentKey: string | null = source.parent_key ?? fromId?.zotero_key ?? null;
    const libraryRef: string | undefined = source.library_ref ?? proposal.library_ref ?? fromId?.library_ref;
    const libraryId: number | undefined = source.library_id ?? proposal.library_id ?? fromId?.library_id;

    const [paperTitle, setPaperTitle] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        setPaperTitle(null);
        if (!parentKey) return;
        void (async () => {
            try {
                const resolved = await resolveItemReference({
                    library_ref: libraryRef,
                    library_id: libraryId,
                    zotero_key: parentKey,
                });
                if (resolved.status !== 'found') return;
                const title = await shortItemTitle(resolved.item);
                if (!cancelled && title) setPaperTitle(title);
            } catch (error) {
                logger(`NoteDestination: could not name the note's paper: ${error}`, 1);
            }
        })();
        return () => { cancelled = true; };
    }, [parentKey, libraryRef, libraryId]);

    let text: string | null = null;
    if (parentKey) {
        if (paperTitle) text = `${saved ? 'Added to' : 'Adding to'}: ${paperTitle}`;
    } else {
        const libraryName = previewData.currentValue?.library_name ?? libraryNameFor(libraryRef, libraryId);
        if (libraryName) text = `${saved ? 'Saved as a standalone note in' : 'A standalone note in'} ${libraryName}`;
    }
    if (!text) return null;

    return (
        <div className="px-3 pt-2 text-sm font-color-secondary truncate" data-note-destination="true">
            {text}
        </div>
    );
};

/**
 * Dispatches to action-specific preview components
 */
export const ActionPreview: React.FC<{
    toolName: string;
    previewData: PreviewData;
    status: ActionStatus | 'awaiting';
    /** All actions for the tool call (for multi-item create_items) */
    actions?: AgentAction[];
    /** Whether tool call arguments are actively streaming */
    isStreaming?: boolean;
    /** Use the compact presentation intended for the end-of-run review card. */
    compact?: boolean;
    /** The run the actions belong to. */
    runId?: string;
    /** Decide one of several papers on its own (create_items). */
    onDecideItem?: (action: AgentAction, approved: boolean) => void;
    /** Actions whose decision is being carried out. */
    busyActionIds?: ReadonlySet<string>;
}> = ({
    toolName,
    previewData,
    status,
    actions,
    isStreaming,
    compact = false,
    runId,
    onDecideItem,
    busyActionIds,
}) => {
    const editNotePreviewKind = getEditNotePreviewKind(toolName, previewData.actionType);
    if (toolName === 'edit_metadata' || previewData.actionType === 'edit_metadata') {
        const edits = previewData.actionData.edits || [];

        // Get current values from previewData.currentValue (pending approval)
        // or extract from edits[].old_value (stored actions)
        let currentValues = previewData.currentValue || {};
        if (Object.keys(currentValues).length === 0 && edits.length > 0) {
            currentValues = {};
            for (const edit of edits) {
                if (edit.old_value !== undefined) {
                    currentValues[edit.field] = edit.old_value;
                }
            }
        }

        // For applied actions, show the applied values if available
        const appliedEdits = previewData.resultData?.applied_edits;

        // Creator data: old from resultData, proposed_data, or currentValue
        const oldCreators = previewData.resultData?.old_creators
            ?? previewData.actionData.old_creators
            ?? previewData.currentValue?.current_creators
            ?? null;
        const newCreators = previewData.resultData?.new_creators
            ?? previewData.actionData.creators
            ?? null;

        // Resolve the edited item's type so the preview can display the field
        // that will actually change (the edit handler remaps wrong-type labels
        // to the type's equivalent field). Falls back to the agent-supplied
        // label when the item is not loaded.
        let itemTypeID: number | undefined;
        const zoteroKey = previewData.actionData.zotero_key;
        // Resolve the portable library_ref to a local library id first: a group
        // item's device-local library_id is UNRESOLVED_LIBRARY_ID (0) — its
        // identity is the ref — so keying off library_id alone would skip the
        // lookup for an available group item. resolveLibraryRef returns the
        // local id (or null when the library isn't on this device); fall back
        // to the agent-supplied label when the item isn't available here.
        const libraryId = resolveLibraryRef({
            library_ref: previewData.actionData.library_ref,
            library_id: previewData.actionData.library_id,
        });
        if (libraryId && zoteroKey) {
            const item = Zotero.Items.getByLibraryAndKey(libraryId, zoteroKey);
            if (item) itemTypeID = item.itemTypeID;
        }

        return (
            <EditMetadataPreview
                edits={edits}
                currentValues={currentValues}
                appliedEdits={appliedEdits}
                status={status}
                oldCreators={oldCreators}
                newCreators={newCreators}
                itemTypeID={itemTypeID}
            />
        );
    }

    if (toolName === 'create_collection' || previewData.actionType === 'create_collection') {
        const name = previewData.actionData.name || '';
        const parentKey = previewData.actionData.parent_key;
        const itemIds = previewData.actionData.item_ids || [];

        // Resolve the library id from the sources that survive into stored
        // actions (current_value is only present while an approval is pending).
        // Without this the preview cannot reveal collections in group libraries.
        const rawLibraryId = previewData.resultData?.library_id
            ?? previewData.currentValue?.library_id
            ?? previewData.actionData.library_id;
        const libraryId = typeof rawLibraryId === 'number' && rawLibraryId > 0 ? rawLibraryId : null;
        const libraryRef = previewData.resultData?.library_ref
            ?? previewData.currentValue?.library_ref
            ?? previewData.actionData.library_ref;

        // Get library name and item count from current_value
        const libraryName = previewData.currentValue?.library_name;
        const itemCount = previewData.currentValue?.item_count ?? itemIds.length;

        return (
            <CreateCollectionPreview
                name={name}
                libraryId={libraryId}
                libraryRef={libraryRef}
                libraryName={libraryName}
                parentKey={parentKey}
                itemCount={itemCount}
                status={status}
                resultData={previewData.resultData}
            />
        );
    }

    if (toolName === 'organize_items' || previewData.actionType === 'organize_items') {
        const itemIds = previewData.actionData.item_ids || [];
        const tags = previewData.actionData.tags;
        const collections = previewData.actionData.collections;

        return (
            <OrganizeItemsPreview
                itemIds={itemIds}
                tags={tags}
                collections={collections}
                status={status}
                resultData={previewData.resultData as OrganizeItemsResultData | undefined}
            />
        );
    }

    if (toolName === 'manage_tags' || previewData.actionType === 'manage_tags') {
        return (
            <ManageTagsPreview
                actionData={previewData.actionData}
                currentValue={previewData.currentValue}
                status={status}
                resultData={previewData.resultData as any}
                errorMessage={previewData.errorMessage}
            />
        );
    }

    if (toolName === 'manage_collections' || previewData.actionType === 'manage_collections') {
        return (
            <ManageCollectionsPreview
                actionData={previewData.actionData}
                currentValue={previewData.currentValue}
                status={status}
                resultData={previewData.resultData as any}
                errorMessage={previewData.errorMessage}
            />
        );
    }

    if (toolName === 'create_highlight_annotations' || previewData.actionType === 'create_highlight_annotations') {
        return (
            <CreateAnnotationsPreview
                kind="highlight"
                actionData={previewData.actionData}
                currentValue={previewData.currentValue}
                resultData={previewData.resultData as any}
                status={status}
                isStreaming={isStreaming}
            />
        );
    }

    if (toolName === 'create_note_annotations' || previewData.actionType === 'create_note_annotations') {
        return (
            <CreateAnnotationsPreview
                kind="note"
                actionData={previewData.actionData}
                currentValue={previewData.currentValue}
                resultData={previewData.resultData as any}
                status={status}
                isStreaming={isStreaming}
            />
        );
    }

    if (
        toolName === 'edit_annotations' ||
        toolName === 'delete_annotations' ||
        previewData.actionType === 'edit_annotations'
    ) {
        const isDelete =
            toolName === 'delete_annotations' ||
            previewData.actionData.operation === 'delete';
        const AnnotationPreview = isDelete
            ? DeleteAnnotationsPreview
            : EditAnnotationsPreview;
        return (
            <AnnotationPreview
                actionData={previewData.actionData}
                currentValue={previewData.currentValue}
                resultData={previewData.resultData as any}
                status={status}
            />
        );
    }

    if (toolName === 'confirm_extraction' || previewData.actionType === 'confirm_extraction') {
        return (
            <ConfirmExtractionPreview
                attachmentCount={previewData.actionData.attachment_count ?? 0}
                extraCredits={previewData.actionData.extra_credits ?? 0}
                totalCredits={previewData.actionData.total_credits ?? 0}
                includedFree={previewData.actionData.included_free ?? 0}
                label={previewData.actionData.label}
                status={status}
            />
        );
    }

    if (toolName === 'confirm_external_search' || previewData.actionType === 'confirm_external_search') {
        return (
            <ConfirmExternalSearchPreview
                extraCredits={previewData.actionData.extra_credits ?? 0}
                totalCredits={previewData.actionData.total_credits ?? 0}
                label={previewData.actionData.label}
                status={status}
            />
        );
    }

    if (toolName === 'create_items' || toolName === 'create_item' || previewData.actionType === 'create_item') {
        /*
         * This row renders from agent actions. A local proposal is recorded as
         * a pending action the moment its card appears, but an approval can
         * arrive before any record of it does, and with nothing to render the
         * card would read "No item data available" for exactly the paper it
         * is asking about.
         *
         * The proposal carries the same payload, so stand one in.
         */
        const fromProposal: AgentAction[] = previewData.actionData?.item
            ? [{
                id: 'proposal',
                action_type: 'create_item',
                status: status === 'awaiting' ? 'pending' : (status as ActionStatus),
                proposed_data: previewData.actionData,
                ...(previewData.resultData ? { result_data: previewData.resultData } : {}),
            } as AgentAction]
            : [];
        const rows = actions && actions.length > 0 ? actions : fromProposal;

        if (rows.length === 0) {
            return (
                <div className="text-sm font-color-secondary px-3 py-2">
                    No item data available
                </div>
            );
        }

        return (
            <CreateItemsPreview
                actions={rows}
                status={status}
                runId={runId}
                onDecide={onDecideItem}
                busyActionIds={busyActionIds}
            />
        );
    }

    if (editNotePreviewKind === 'batch') {
        const edits: any[] = Array.isArray(previewData.actionData.edits) ? previewData.actionData.edits : [];
        const applied: any[] = Array.isArray(previewData.resultData?.applied) ? previewData.resultData!.applied : [];
        const occurrencesByIndex = new Map<number, number>(
            applied
                .filter((entry) => typeof entry?.index === 'number')
                .map((entry) => [entry.index, entry.occurrences_replaced]),
        );

        // Resolve the portable library_ref to a local id, same as the edit_note
        // branch below — passed to every stacked EditNotePreview so each can
        // fetch note context (page labels, surrounding text) when needed.
        const resolvedNoteLibraryId = resolveLibraryRef({
            library_ref: previewData.actionData.library_ref,
            library_id: previewData.actionData.library_id,
        });
        const noteLibraryId = resolvedNoteLibraryId ?? undefined;

        return (
            <div className="flex flex-col gap-3">
                {edits.map((edit, position) => {
                    const editIndex = typeof edit?.index === 'number' ? edit.index : position;
                    const op = (edit?.operation ?? 'str_replace') as import('@beaver/agent-core/types/agentActions/editNote').EditNoteOperation;
                    const isRewrite = op === 'rewrite';
                    const oldString = isRewrite ? '' : (edit?.old_string || '');
                    const newString = edit?.new_string || '';
                    const oldContent = isRewrite
                        ? getBatchRewriteOldContent(previewData, editIndex)
                        : undefined;

                    return (
                        <div key={`edit-${editIndex}`} className="flex flex-col gap-1">
                            {/* Row labels only separate STACKED diffs (full edits[]
                                render). Group rows slice to one edit each and are
                                already delimited by row borders — no label there.
                                A rewrite needs no label here: it is always the only
                                edit in its batch, and EditNotePreview heads it with
                                its own scope line. */}
                            {edits.length > 1 && !isRewrite && (
                                <div className="text-sm font-color-secondary px-3 py-1">
                                    {`Edit ${position + 1}`}
                                </div>
                            )}
                            <EditNotePreview
                                oldString={oldString}
                                newString={newString}
                                operation={op}
                                oldContent={oldContent}
                                occurrencesReplaced={occurrencesByIndex.get(editIndex)}
                                status={status}
                                libraryId={noteLibraryId}
                                zoteroKey={previewData.actionData.zotero_key}
                            />
                        </div>
                    );
                })}
            </div>
        );
    }

    if (editNotePreviewKind === 'legacy') {
        const op = (previewData.actionData.operation ?? 'str_replace') as import('@beaver/agent-core/types/agentActions/editNote').EditNoteOperation;
        const isRewrite = op === 'rewrite';
        const oldString = isRewrite ? '' : (previewData.actionData.old_string || '');
        const newString = previewData.actionData.new_string || '';
        const occurrencesReplaced = previewData.resultData?.occurrences_replaced;
        const warnings = previewData.resultData?.warnings;
        // For rewrite, get old content from validation's current_value
        // or from undo_full_html in result_data (post-apply)
        const oldContent = isRewrite
            ? (previewData.currentValue?.old_content || previewData.resultData?.undo_full_html)
            : undefined;

        // Resolve the portable library_ref to a local id before handing it to
        // EditNotePreview, which fetches note HTML + page labels. Pass
        // undefined when unresolvable so the preview's own guard treats it as
        // unavailable.
        const resolvedNoteLibraryId = resolveLibraryRef({
            library_ref: previewData.actionData.library_ref,
            library_id: previewData.actionData.library_id,
        });
        const noteLibraryId = resolvedNoteLibraryId ?? undefined;

        return (
            <EditNotePreview
                oldString={oldString}
                newString={newString}
                operation={op}
                oldContent={oldContent}
                occurrencesReplaced={occurrencesReplaced}
                warnings={warnings}
                status={status}
                libraryId={noteLibraryId}
                zoteroKey={previewData.actionData.zotero_key}
            />
        );
    }

    if (toolName === 'create_note' || previewData.actionType === 'create_note') {
        const noteContent = previewData.actionData.content || '';

        return (
            <div className="display-flex flex-col">
                {!isStreaming && <NoteDestination previewData={previewData} status={status} />}
                <CreateNotePreview
                    content={noteContent}
                    resultData={previewData.resultData}
                    status={status}
                    isStreaming={isStreaming}
                    compact={compact}
                />
            </div>
        );
    }

    // Fallback for unsupported action types
    return (
        <div className="text-sm font-color-secondary">
            <div className="font-medium mb-1">Action: {previewData.actionType}</div>
            <pre className="text-xs overflow-auto max-h-32 p-2 rounded">
                {JSON.stringify(previewData.actionData, null, 2)}
            </pre>
        </div>
    );
};
