import React, { useEffect, useState } from 'react';
import { Icon, ArrowRightIcon } from '../../../components/icons/icons';
import type { ManageTagsResultData } from '@beaver/agent-core/types/agentActions/base';
import { shortenActionError } from './agentActionViewHelpers';
import { TagPill } from '../../../components/agentRuns/TagPill';
import { resolveLibraryRef } from '../../../../src/utils/libraryIdentity';
import { t, tn } from '../../../../src/utils/i18n';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface ManageTagsPreviewProps {
    /** Raw action_data from proposed_data */
    actionData: {
        action?: 'rename' | 'delete';
        name?: string;
        new_name?: string | null;
        is_merge?: boolean | null;
        library_id?: number;
        library_ref?: string;
    };
    /** current_value returned from validation */
    currentValue?: {
        library_name?: string;
        item_count?: number;
        is_merge?: boolean;
    };
    status?: ActionStatus;
    resultData?: ManageTagsResultData;
    /** Server-provided error detail when status === 'error' */
    errorMessage?: string;
}

function buildTagErrorText(
    action: 'rename' | 'delete',
    errorMessage: string | undefined,
): string {
    const isDelete = action === 'delete';
    if (!errorMessage) return isDelete ? t('Failed to delete tag.') : t('Failed to rename tag.');
    // The error message is matched in English: it is the executor's own text.
    const m = errorMessage.toLowerCase();
    if (m.includes('safety cap') || m.includes('too many')) {
        return isDelete
            ? t('Failed to delete tag because it is used on too many items.')
            : t('Failed to rename tag because it is used on too many items.');
    }
    const reason = shortenActionError(errorMessage);
    return isDelete
        ? t('Failed to delete tag. {reason}.', { reason })
        : t('Failed to rename tag. {reason}.', { reason });
}

/**
 * Preview component for manage_tags actions.
 * The outer AgentActionView header already shows the operation summary,
 * so this body focuses on visual context + impact (library, item count, warnings).
 */
export const ManageTagsPreview: React.FC<ManageTagsPreviewProps> = ({
    actionData,
    currentValue,
    status = 'pending',
    resultData,
    errorMessage,
}) => {
    const action: 'rename' | 'delete' = actionData.action ?? 'rename';
    const name = actionData.name ?? '';
    const newName = actionData.new_name ?? undefined;
    const libraryId = resolveLibraryRef({
        library_ref: resultData?.library_ref ?? actionData.library_ref,
        library_id: resultData?.library_id ?? actionData.library_id,
    });

    const isApplied = status === 'applied';
    const isError = status === 'error';

    // currentValue is only available while awaiting approval. After a final
    // state (rejected/applied/…) it is gone, so fall back to live Zotero
    // lookups so the rejected view still shows library + item-count context
    // (the user may still re-apply).
    const [fallbackLibraryName, setFallbackLibraryName] = useState<string | null>(null);
    const [fallbackItemCount, setFallbackItemCount] = useState<number | null>(null);

    useEffect(() => {
        if (currentValue || typeof Zotero === 'undefined' || libraryId == null) return;
        try {
            const lib = Zotero.Libraries.get(libraryId) as Zotero.Library | false;
            if (lib) setFallbackLibraryName(lib.name);
            const tagID = name ? Zotero.Tags.getID(name) : false;
            if (tagID !== false && tagID != null) {
                Zotero.Tags.getTagItems(libraryId, tagID)
                    .then((ids: number[]) => setFallbackItemCount(ids.length))
                    .catch(() => {});
            } else {
                setFallbackItemCount(0);
            }
        } catch {
            // ignore — preview is best-effort
        }
    }, [currentValue, libraryId, name, status]);

    const libraryName = currentValue?.library_name ?? fallbackLibraryName ?? undefined;
    const itemCount =
        resultData?.items_affected
        ?? currentValue?.item_count
        ?? fallbackItemCount
        ?? 0;

    return (
        <div className={`manage-tags-preview overflow-hidden`}>
            <div className="display-flex flex-col px-3 py-2 gap-2">
                <div className="display-flex flex-row items-center gap-2 flex-wrap">
                    {action === 'delete' && (
                        <span className="display-flex">
                            {isApplied ? t('Deleted') : t('Delete')}
                        </span>
                    )}
                    <TagPill name={name} strike={isApplied && action === 'delete'} />
                    {action === 'rename' && newName && (
                        <>
                            <span className="scale-75 display-flex opacity-60">
                                <Icon icon={ArrowRightIcon} className="icon-16" />
                            </span>
                            <TagPill name={newName} />
                        </>
                    )}
                </div>

                <div className="display-flex flex-col gap-1 text-sm font-color-secondary">
                    {libraryName && (
                        <div>
                            <span className="font-color-primary">{t('Library:')}</span> {libraryName}
                            {itemCount > 0 && (
                                <span>
                                    {' '}{tn(itemCount, '({count} item affected)', '({count} items affected)')}
                                </span>
                            )}
                        </div>
                    )}
                    {isError && (
                        <div className="font-color-red">
                            {buildTagErrorText(action, errorMessage)}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ManageTagsPreview;
