import React from 'react';
import { t, tn } from '../../../../src/utils/i18n';
import { tr } from '../../../utils/i18nNodes';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface ConfirmExternalSearchPreviewProps {
    /** Number of additional credits (surcharge) */
    extraCredits: number;
    /** Total credits including base cost */
    totalCredits: number;
    /** Brief label describing the search (e.g., "Hinton's papers") */
    label?: string | null;
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for confirm_external_search actions.
 * Shows a concise cost summary for an external literature search.
 */
export const ConfirmExternalSearchPreview: React.FC<ConfirmExternalSearchPreviewProps> = ({
    extraCredits,
    label,
    status = 'pending',
}) => {
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isApplied = status === 'applied';
    const credits = (
        <span className="font-color-primary font-medium">
            {tn(extraCredits, '{count} extra credit', '{count} extra credits')}
        </span>
    );

    return (
        <div className={`confirm-extraction-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="px-3 py-3 text-sm font-color-secondary">
                {isApplied ? (
                    <span>
                        {label
                            ? t('Approved external literature search — {label}.', { label })
                            : t('Approved external literature search.')}
                    </span>
                ) : isRejectedOrUndone ? (
                    <span>
                        {label
                            ? t('Declined external literature search — {label}.', { label })
                            : t('Declined external literature search.')}
                    </span>
                ) : (
                    <span>
                        {label
                            ? tr('Searching external sources for {label} will use {credits}.', {
                                label: <span className="font-color-primary font-medium">{label}</span>,
                                credits,
                            })
                            : tr('This external search will use {credits}.', { credits })}
                        {' '}{t('You\'re only charged for successful searches.')}
                    </span>
                )}
            </div>
        </div>
    );
};

export default ConfirmExternalSearchPreview;
