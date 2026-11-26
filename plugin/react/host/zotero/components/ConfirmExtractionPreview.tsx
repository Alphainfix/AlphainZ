import React from 'react';
import { t, tn } from '../../../../src/utils/i18n';
import { tr } from '../../../utils/i18nNodes';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface ConfirmExtractionPreviewProps {
    /** Total number of attachments to extract from */
    attachmentCount: number;
    /** Number of additional credits (surcharge) */
    extraCredits: number;
    /** Total credits including base cost */
    totalCredits: number;
    /** Number of papers included in base cost */
    includedFree: number;
    /** Brief label describing the extraction (e.g., "Extracting wealth measures") */
    label?: string | null;
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for confirm_extraction actions.
 * Shows a concise cost summary for a batch extraction.
 */
export const ConfirmExtractionPreview: React.FC<ConfirmExtractionPreviewProps> = ({
    attachmentCount,
    extraCredits,
    label,
    status = 'pending',
}) => {
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isApplied = status === 'applied';
    const papers = (
        <span className="font-color-primary font-medium">
            {tn(attachmentCount, '{count} paper', '{count} papers')}
        </span>
    );
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
                            ? tn(
                                attachmentCount,
                                'Approved extraction from {count} paper — {label}.',
                                'Approved extraction from {count} papers — {label}.',
                                { label },
                            )
                            : tn(attachmentCount, 'Approved extraction from {count} paper.', 'Approved extraction from {count} papers.')}
                    </span>
                ) : isRejectedOrUndone ? (
                    <span>
                        {label
                            ? tn(
                                attachmentCount,
                                'Declined extraction from {count} paper — {label}.',
                                'Declined extraction from {count} papers — {label}.',
                                { label },
                            )
                            : tn(attachmentCount, 'Declined extraction from {count} paper.', 'Declined extraction from {count} papers.')}
                    </span>
                ) : (
                    <span>
                        {label
                            ? tr('Extracting {label} from {papers} will use up to {credits}.', {
                                label: <span className="font-color-primary font-medium">{label}</span>,
                                papers,
                                credits,
                            })
                            : tr('Extracting from {papers} will use up to {credits}.', { papers, credits })}
                        {' '}{t('You\'re only charged for successful extractions.')}
                    </span>
                )}
            </div>
        </div>
    );
};

export default ConfirmExtractionPreview;
