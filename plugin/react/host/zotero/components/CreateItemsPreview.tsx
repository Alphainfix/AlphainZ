import React, { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import ReferenceMetadataDisplay from '../../../components/externalReferences/ReferenceMetadataDisplay';
import { AgentAction } from '../../../agents/agentActions';
import { CreateItemProposedData, CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import { CheckmarkCircleIcon, CancelCircleIcon, AlertIcon, CancelIcon, Icon, TickIcon } from '../../../components/icons/icons';
import { revealSource } from '../../../utils/sourceUtils';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { ArrowUpRightIcon } from '../../../components/icons/icons';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import { usePdfFetchStatus } from '../../../hooks/useBackgroundTasks';
import {
    chooseImportDestinationAtom,
    chosenImportDestination,
    currentDestination,
    destinationChoices,
    destinationValue,
    importDestinationAtom,
    parseDestinationValue,
    proposedDestination,
    resolveImportDestination,
} from '../../../atoms/importDestination';
import { searchableLibraryIdsAtom } from '../../../atoms/profile';
import { t } from '../../../../src/utils/i18n';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface CreateItemsPreviewProps {
    /** Array of create_item agent actions */
    actions: AgentAction[];
    /** Current status of the actions (batch status) */
    status?: ActionStatus;
    /** Whether to show status icons for individual items (defaults to true for multiple items, false for single item) */
    showStatusIcons?: boolean;
    /** The run that proposed these papers; the destination picked here is kept for it. */
    runId?: string;
    /**
     * Add or leave out one paper of several. Given, each paper that is still
     * undecided gets its own Add and Don't add, and a paper left out can be
     * added after all.
     */
    onDecide?: (action: AgentAction, approved: boolean) => void;
    /** Papers whose decision is being carried out; their row shows a spinner. */
    busyActionIds?: ReadonlySet<string>;
}

/**
 * Get the overall status for a group of actions.
 * Priority: error > pending/awaiting > applied > rejected/undone
 */
function getOverallStatus(actions: AgentAction[]): ActionStatus {
    const statuses = actions.map(a => a.status);
    
    // If any has error, show error
    if (statuses.some(s => s === 'error')) return 'error';
    // If any is pending, show pending
    if (statuses.some(s => s === 'pending')) return 'pending';
    // If all are applied, show applied
    if (statuses.every(s => s === 'applied')) return 'applied';
    // If any is rejected or undone
    if (statuses.some(s => s === 'rejected' || s === 'undone')) {
        // If all are rejected/undone, show rejected
        if (statuses.every(s => s === 'rejected' || s === 'undone')) return 'rejected';
    }
    
    return 'pending';
}

/**
 * Get status icon and styling for a single action
 */
function getStatusIndicator(status: ActionStatus): { icon: React.FC<React.SVGProps<SVGSVGElement>> | null; className: string } {
    switch (status) {
        case 'applied':
            return { icon: CheckmarkCircleIcon, className: 'font-color-green scale-11' };
        case 'rejected':
        case 'undone':
            return { icon: CancelCircleIcon, className: 'font-color-red scale-11' };
        case 'error':
            return { icon: AlertIcon, className: 'color-error' };
        default:
            return { icon: null, className: '' };
    }
}

/**
 * A single item row, extracted so it can use hooks (usePdfFetchStatus).
 */
const CreateItemPreviewRow: React.FC<{
    action: AgentAction;
    shouldShowStatusIcons: boolean;
    getTextClasses: (defaultClass?: string) => string;
    onDecide?: (action: AgentAction, approved: boolean) => void;
    isBusy?: boolean;
}> = ({ action, shouldShowStatusIcons, getTextClasses, onDecide, isBusy = false }) => {
    const proposedData = action.proposed_data as CreateItemProposedData;
    const resultData = action.result_data as CreateItemResultData | undefined;
    const item = proposedData?.item;
    const actionStatus = action.status as ActionStatus;
    const statusIndicator = getStatusIndicator(actionStatus);
    const paperName = item?.title ? `“${item.title}”` : t('this paper');
    const canReject = !!onDecide && actionStatus === 'pending';
    const canAdd = !!onDecide
        && (actionStatus === 'pending' || actionStatus === 'rejected' || actionStatus === 'undone');

    // Track background PDF fetch for applied items
    const pdfStatus = usePdfFetchStatus(
        actionStatus === 'applied' ? resultData?.library_id : undefined,
        actionStatus === 'applied' ? resultData?.zotero_key : undefined
    );

    if (!item) {
        return (
            <div className="text-sm font-color-secondary">
                {t('No item data available')}
            </div>
        );
    }

    return (
        <div className="display-flex flex-row items-start gap-2 py-1 border-bottom-quinary last:border-b-0">
            {/* Status indicator - only show if enabled */}
            {shouldShowStatusIcons && (
                <div className="mt-015 flex-shrink-0 w-4">
                    {statusIndicator.icon && (
                        <Icon icon={statusIndicator.icon} className={statusIndicator.className} />
                    )}
                </div>
            )}

            <div className="display-flex flex-col gap-2 flex-1 min-w-0">
                {/* Item metadata */}
                <ReferenceMetadataDisplay
                    title={item.title}
                    authors={item.authors}
                    publicationTitle={item.journal?.name || item.venue}
                    year={item.year}
                    getTextClasses={getTextClasses}
                />

                {/* Where it landed — the question "applied" leaves open. */}
                {actionStatus === 'applied' && (resultData as any)?.location && (
                    <div className="font-color-secondary text-sm">
                        {t('Added to {location}', { location: (resultData as any).location })}
                    </div>
                )}

                {/* Background PDF fetch indicator */}
                {pdfStatus.isLoading && (
                    <div className="display-flex items-center gap-1 font-color-secondary text-sm">
                        <Spinner size={12} />
                        <span>{t('Fetching PDF…')}</span>
                    </div>
                )}
            </div>

            {/* Reveal button (only for applied items) */}
            {actionStatus === 'applied' && resultData?.library_id && resultData?.zotero_key && (
                <Tooltip content={t('Reveal in Zotero')} singleLine>
                    <IconButton
                        variant="ghost-secondary"
                        icon={ArrowUpRightIcon}
                        className="font-color-secondary scale-11 flex-shrink-0"
                        ariaLabel={t('Reveal {paper} in Zotero', { paper: paperName })}
                        onClick={() => revealSource(
                            {
                                library_id: resultData.library_id,
                                zotero_key: resultData.zotero_key,
                                library_ref: resultData.library_ref,
                            },
                            proposedData.collection_keys?.[0]
                        )}
                    />
                </Tooltip>
            )}

            {/* This paper's own decision, when the card offers one per paper. */}
            {(canReject || canAdd) && (
                <div className="display-flex flex-row items-center gap-1 flex-shrink-0">
                    {canReject && (
                        <Tooltip content={t('Don\'t add')} showArrow singleLine>
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-red"
                                ariaLabel={t('Don\'t add {paper}', { paper: paperName })}
                                onClick={() => onDecide!(action, false)}
                                disabled={isBusy}
                            />
                        </Tooltip>
                    )}
                    {canAdd && (
                        <Tooltip content={t('Add')} showArrow singleLine>
                            <IconButton
                                icon={TickIcon}
                                variant="ghost-secondary"
                                iconClassName="font-color-green scale-14"
                                ariaLabel={t('Add {paper}', { paper: paperName })}
                                onClick={() => onDecide!(action, true)}
                                loading={isBusy}
                                disabled={isBusy}
                            />
                        </Tooltip>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * Where these papers go, asked once.
 *
 * Modelled on the Zotero browser connector, which asks before it saves rather
 * than filing into whatever happens to be selected. One picker for the whole
 * proposal: a run that suggests four papers suggested them for the same
 * reason, so choosing four times is three extra chances to misfile one.
 */
const ImportDestinationPicker: React.FC<{ actions: AgentAction[]; runId?: string }> = ({ actions, runId }) => {
    const chosenByRun = useAtomValue(importDestinationAtom);
    const chooseDestination = useSetAtom(chooseImportDestinationAtom);
    // Only the libraries the agent may write to: an excluded one would be
    // refused on Apply.
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const choices = useMemo(() => destinationChoices(searchableLibraryIds), [searchableLibraryIds]);
    const pickRunId = runId ?? actions[0]?.run_id;
    const destination = chosenImportDestination(chosenByRun, pickRunId);
    const proposalData = actions[0]?.proposed_data as any;
    // The folder the assistant proposed, when it named one — the user's own
    // pick for this run still wins. The rule is resolveImportDestination's,
    // which is what the approval actually applies, so the folder shown here is
    // always one of the options and always the one written to.
    const proposed = useMemo(() => proposedDestination(proposalData, choices), [proposalData, choices]);
    const effective = resolveImportDestination(destination, proposalData, currentDestination, choices);

    if (choices.length === 0 || !effective) return null;

    const isSuggestion = proposed !== null
        && destinationValue(effective) === destinationValue(proposed)
        && !destination;

    return (
        <label className="display-flex flex-row items-center gap-2 text-sm font-color-secondary">
            <span className="flex-shrink-0">{isSuggestion ? t('Add to (suggested)') : t('Add to')}</span>
            <select
                className="p-1 m-0 preference-input text-sm flex-1 min-w-0"
                value={destinationValue(effective)}
                onChange={(event) => {
                    if (!pickRunId) return;
                    chooseDestination({
                        runId: pickRunId,
                        destination: parseDestinationValue(event.target.value),
                    });
                }}
                aria-label={t('Collection to add these papers to')}
            >
                {choices.map((choice) => (
                    <option key={destinationValue(choice)} value={destinationValue(choice)}>
                        {choice.label}
                    </option>
                ))}
            </select>
        </label>
    );
};

/**
 * Preview component for create_item actions in the deferred tool workflow.
 * Shows a list of items that will be created. For single items, status icons
 * are hidden by default to provide a cleaner UI.
 */
export const CreateItemsPreview: React.FC<CreateItemsPreviewProps> = ({
    actions,
    status: propStatus,
    showStatusIcons,
    runId,
    onDecide,
    busyActionIds,
}) => {
    // Compute overall status from actions if not provided
    const overallStatus = propStatus ?? getOverallStatus(actions);

    // Default behavior: hide status icons for single item, show for multiple
    const shouldShowStatusIcons = showStatusIcons ?? actions.length > 1;
    // One paper is decided by the card's own buttons; several each get theirs.
    const perPaperDecisions = actions.length > 1 ? onDecide : undefined;

    // Styled by the paper's own status once papers are decided one by one, so
    // the one left out is struck through and the ones added are not.
    const textClassesFor = (status: ActionStatus) => (defaultClass: string = 'font-color-primary') => {
        if (status === 'rejected' || status === 'undone') return 'font-color-tertiary line-through';
        if (status === 'error') return 'font-color-tertiary';
        return defaultClass;
    };

    return (
        <div className="create-items-preview px-3 py-2">
            <div className="display-flex flex-col gap-3">
                {overallStatus === 'awaiting' && <ImportDestinationPicker actions={actions} runId={runId} />}
                {actions.map((action) => (
                    <CreateItemPreviewRow
                        key={action.id}
                        action={action}
                        shouldShowStatusIcons={shouldShowStatusIcons}
                        getTextClasses={textClassesFor(
                            actions.length > 1 ? (action.status as ActionStatus) : overallStatus,
                        )}
                        onDecide={perPaperDecisions}
                        isBusy={busyActionIds?.has(action.id) ?? false}
                    />
                ))}
            </div>
        </div>
    );
};

export default CreateItemsPreview;
