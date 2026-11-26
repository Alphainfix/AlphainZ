import React from "react";
import { useAtomValue } from "jotai";
import { embeddingIndexStateAtom, isEmbeddingIndexingAtom } from "../../../atoms/embeddingIndex";
import { ProgressBar } from "../../status/ProgressBar";
import { CheckmarkIcon, SpinnerIcon } from "../../status/icons";
import { ZapIcon } from "../../icons/icons";
import { t } from '../../../../src/utils/i18n';

interface EmbeddingIndexProgressProps {
    /** Whether to show as compact inline version */
    compact?: boolean;
}

/**
 * Displays the progress of local embedding index generation
 * Used in the Free onboarding flow to show indexing progress
 */
const EmbeddingIndexProgress: React.FC<EmbeddingIndexProgressProps> = ({ compact = false }) => {
    const indexState = useAtomValue(embeddingIndexStateAtom);
    const isIndexing = useAtomValue(isEmbeddingIndexingAtom);

    const getStatusIcon = () => {
        if (indexState.status === 'error') return null;
        if (isIndexing) return SpinnerIcon;
        if (indexState.progress >= 100 || indexState.status === 'idle' && indexState.phase === 'incremental') {
            return CheckmarkIcon;
        }
        return SpinnerIcon;
    };

    const getStatusText = (): string => {
        if (indexState.status === 'error') {
            return t('Error: {message}', { message: indexState.error || t('Unknown error') });
        }
        if (isIndexing) {
            if (indexState.totalItems > 0) {
                return t('Indexing {done} of {total} items...', { done: indexState.indexedItems.toLocaleString(), total: indexState.totalItems.toLocaleString() });
            }
            return t("Indexing your library...");
        }
        if (indexState.progress >= 100 || (indexState.status === 'idle' && indexState.phase === 'incremental')) {
            return t("Indexing complete");
        }
        return t("Ready to index");
    };

    // Compact inline version for showing during button loading state
    if (compact) {
        return (
            <div className="display-flex flex-row items-center gap-2">
                {getStatusIcon()}
                <span className="font-color-secondary text-sm">{getStatusText()}</span>
            </div>
        );
    }

    // Full card version
    const isComplete = indexState.progress >= 100 || (indexState.status === 'idle' && indexState.phase === 'incremental');
    const showProgress = isIndexing && indexState.totalItems > 0;

    return (
        <div className="display-flex flex-col gap-4 p-3 rounded-md bg-quinary min-w-0">
            <div className="display-flex flex-row gap-4">
                <div className="mt-1">
                    {getStatusIcon()}
                </div>
                <div className="display-flex flex-col gap-3 items-start flex-1">
                    {/* Title and status */}
                    <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                        <div className={`${isComplete ? 'font-color-secondary' : 'font-color-tertiary'} text-lg`}>
                            {isComplete ? t('Library Indexed') : t('Indexing Library')}
                        </div>
                        <div className="flex-1"/>
                        {indexState.totalItems > 0 && (
                            <div className="font-color-tertiary text-base">
                                {t('{totalItems} Items', { totalItems: indexState.totalItems.toLocaleString() })}
                            </div>
                        )}
                    </div>

                    {/* Progress bar and text */}
                    {showProgress && (
                        <div className="w-full">
                            <ProgressBar progress={indexState.progress} />
                            <div className="display-flex flex-row gap-4">
                                <div className="font-color-tertiary text-base">
                                    {getStatusText()}
                                </div>
                                <div className="flex-1"/>
                                <div className="font-color-tertiary text-base">
                                    {`${indexState.progress.toFixed(1)}%`}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Simple status text when no progress bar */}
                    {!showProgress && (
                        <div className="font-color-tertiary text-base">
                            {getStatusText()}
                        </div>
                    )}
                </div>
            </div>

            {/* Speed note - shown before/during indexing */}
            {!isComplete && indexState.status !== 'error' && (
                <div className="display-flex flex-row gap-2 items-center font-color-tertiary text-sm">
                    <ZapIcon size={14} />
                    <span>{t('Indexing takes less than a minute')}</span>
                </div>
            )}
        </div>
    );
};

export default EmbeddingIndexProgress;
