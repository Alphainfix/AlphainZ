import React, { useCallback, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    embeddingIndexStateAtom,
    forceReindexAtom,
    isEmbeddingIndexingAtom,
    hasEmbeddingIndexErrorAtom,
    hasFailedEmbeddingsAtom
} from "../../../atoms/embeddingIndex";
import { fulltextIndexStateAtom } from "../../../atoms/fulltextIndex";
import Icon from "@beaver/agent-ui/icons/Icon";
import { AlertIcon, SyncIcon } from "../../icons/icons";
import Tooltip from "@beaver/agent-ui/primitives/Tooltip";
import { logger } from "@beaver/agent-core/platform/logger";
import { openPreferencesWindow } from "../../../../src/ui/openPreferencesWindow";

/**
 * Index status, in the toolbar.
 *
 * This used to be two separate things: a spinner here that only knew about the
 * embedding pass, and a full-width bar below the composer that knew about
 * both. The bar appeared and vanished under the input while you were typing —
 * a status message has no business moving the thing you are aiming at — so the
 * bar is gone and everything it said lives here.
 *
 * Two indexes report through this one control, and they are genuinely
 * different work: one reads titles and abstracts, the other reads every page
 * of every PDF. Which one is running is named, because "Indexing" while
 * full-text search still answers from half the library is the kind of message
 * that teaches someone to distrust the whole feature.
 *
 * The percentage is on the face rather than behind a hover: it is the one
 * thing anybody wants from this control, and a number that only exists in a
 * tooltip may as well not exist.
 */

export interface IndexStatusInput {
    embedding: {
        phase?: string;
        progress: number;
        totalItems: number;
        indexedItems: number;
        failedItems: number;
        error?: string | null;
    };
    isEmbeddingIndexing: boolean;
    hasError: boolean;
    hasFailedItems: boolean;
    fulltext: {
        status: string;
        /** Documents finished / to do in the pass that is running. */
        done: number;
        total: number;
        /** Documents indexed / in the library — the coverage the settings show. */
        indexed?: number;
        library?: number;
    };
}

export interface IndexStatus {
    visible: boolean;
    isIndexing: boolean;
    /** Which pass the numbers describe; null when nothing is running. */
    pass: 'metadata' | 'fulltext' | null;
    /** Rounded percentage, or null when there is nothing meaningful to show. */
    percent: number | null;
    title: string;
    detail?: string;
    /** Where a click should go while a pass is running. */
    preferencesTab: 'sync' | 'models' | null;
}

/**
 * What the control should say, given the two indexes' states.
 *
 * Pure and exported so the decisions can be tested without a DOM: which pass
 * wins when both run, when the control is hidden at all, and that no
 * percentage is shown against a total of zero — which is how a pass that has
 * just finished briefly reports itself, and how a `NaN%` reaches the screen.
 */
export function describeIndexStatus(input: IndexStatusInput): IndexStatus {
    const { embedding, isEmbeddingIndexing, hasError, hasFailedItems, fulltext } = input;

    const metadataRunning = isEmbeddingIndexing
        && embedding.phase === 'initial'
        && embedding.totalItems > 0;
    const fulltextRunning = fulltext.status === 'indexing' && fulltext.total > 0;
    const isIndexing = isEmbeddingIndexing || fulltextRunning;

    const hidden: IndexStatus = {
        visible: false, isIndexing: false, pass: null, percent: null,
        title: '', preferencesTab: null,
    };

    if (!isIndexing && !hasError && !hasFailedItems) return hidden;

    if (isIndexing) {
        /*
         * An embedding pass can report itself as running with nothing to do —
         * that is the steady state once a library is indexed and a single new
         * item arrives. Neither pass has a countable total then, and naming
         * one of them would be a guess; "Indexing" is the honest word.
         */
        if (!metadataRunning && !fulltextRunning) {
            return {
                visible: true, isIndexing: true, pass: null, percent: null,
                title: 'Indexing', preferencesTab: 'sync',
            };
        }

        /*
         * The metadata pass wins when both are going: it is the one that makes
         * the library searchable at all, and it finishes far sooner.
         */
        /*
         * The full-text pass reports the documents it still has to read, not
         * the library. Shown raw, "36/179 · 20%" sat next to "64 of 207 PDFs
         * indexed" in the settings and looked like a different index. Both now
         * describe coverage: what is indexed out of what the library holds,
         * with this pass's finished documents counted in as they complete.
         */
        const fulltextLibrary = fulltext.library ?? 0;
        const fulltextCovered = fulltextLibrary > 0
            ? Math.max(0, Math.min(fulltextLibrary, fulltextLibrary - Math.max(0, fulltext.total - fulltext.done)))
            : fulltext.done;
        const done = metadataRunning ? embedding.indexedItems : fulltextCovered;
        const total = metadataRunning ? embedding.totalItems : (fulltextLibrary > 0 ? fulltextLibrary : fulltext.total);
        const raw = metadataRunning
            ? embedding.progress
            : (total > 0 ? (done / total) * 100 : 0);
        const percent = total > 0
            ? Math.round(Math.max(0, Math.min(100, raw)))
            : null;
        const unit = metadataRunning ? 'items' : 'papers';
        return {
            visible: true,
            isIndexing: true,
            pass: metadataRunning ? 'metadata' : 'fulltext',
            percent,
            title: metadataRunning ? 'Indexing titles and abstracts' : 'Reading your PDFs',
            detail: percent === null
                ? undefined
                : `${percent}% · ${done.toLocaleString()}/${total.toLocaleString()} ${unit}`,
            // The full-text pass is configured next to the embedding provider
            // it spends; the metadata one lives under Search.
            preferencesTab: metadataRunning ? 'sync' : 'models',
        };
    }

    if (hasError) {
        return {
            visible: true, isIndexing: false, pass: null, percent: null,
            title: 'Indexing Error',
            detail: embedding.error || 'Click to retry',
            preferencesTab: null,
        };
    }

    return {
        visible: true, isIndexing: false, pass: null, percent: null,
        title: `${embedding.failedItems} items failed to index`,
        detail: 'Click to retry indexing',
        preferencesTab: null,
    };
}

const EmbeddingIndexStatusButton: React.FC = () => {
    const [isHovered, setIsHovered] = useState(false);

    const indexState = useAtomValue(embeddingIndexStateAtom);
    const isEmbeddingIndexing = useAtomValue(isEmbeddingIndexingAtom);
    const hasError = useAtomValue(hasEmbeddingIndexErrorAtom);
    const hasFailedItems = useAtomValue(hasFailedEmbeddingsAtom);
    const fulltext = useAtomValue(fulltextIndexStateAtom);
    const forceReindex = useSetAtom(forceReindexAtom);

    const status = describeIndexStatus({
        embedding: indexState,
        isEmbeddingIndexing,
        hasError,
        hasFailedItems,
        fulltext,
    });

    /*
     * While a pass is running the useful action is to go and look at it; only
     * once it has stopped — errored, or left items behind — is starting it
     * again the useful action.
     */
    const preferencesTab = status.preferencesTab;
    const handleClick = useCallback(() => {
        if (preferencesTab) {
            openPreferencesWindow(preferencesTab);
            return;
        }
        logger(`EmbeddingIndexStatusButton: User-initiated reindex`);
        forceReindex();
    }, [preferencesTab, forceReindex]);

    if (!status.visible) return null;

    const icon = status.isIndexing ? SyncIcon : (isHovered ? SyncIcon : AlertIcon);
    const iconClassName = status.isIndexing
        ? "animate-spin"
        : (isHovered ? "" : "font-color-red");
    const ariaLabel = status.isIndexing
        ? `${status.title}${status.percent !== null ? `, ${status.percent} percent` : ''}`
        : "Rebuild Search Index";

    return (
        <Tooltip
            content={status.title}
            secondaryContent={status.detail}
            showArrow
            singleLine
        >
            <button
                type="button"
                className="index-status-button variant-ghost has-text display-flex flex-row items-center gap-1"
                onClick={handleClick}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                aria-label={ariaLabel}
            >
                <Icon icon={icon} className={`scale-11 ${iconClassName}`} />
                {status.percent !== null && (
                    <span className="text-sm font-color-secondary tabular-nums">
                        {status.percent}%
                    </span>
                )}
            </button>
        </Tooltip>
    );
};

export default EmbeddingIndexStatusButton;
