/**
 * The offer to write a highlight-chat answer into the highlight's own comment.
 *
 * Shaped after the approval cards the agent's library changes already use
 * (`AgentActionView` + its previews): the target on one row with the annotation
 * icon in its own colour and the page on the right, then the exact text that
 * will be written, then a footer whose outline button declines and whose solid
 * button applies. Nothing here is a new idiom — a second visual language for
 * "may I change something in your library?" is worse than a slightly imperfect
 * fit with the first one.
 *
 * Showing the text as Zotero will show it is the part that matters — the
 * converted formulas included, rendered with the same four tags the comment
 * field understands. The earlier version of
 * this offer described the change in prose, which asks the user to approve a
 * write they cannot see; every one of Beaver's own approval cards shows the
 * change itself.
 */

import React, { useState } from 'react';

import Button from '@beaver/agent-ui/primitives/Button';

import { ALPHAIN_ANCHOR_COLOR } from '../../../../src/constants/annotations';
import type { CommentSaveResult } from '../../../utils/selectionChatComment';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { RichCommentText } from './RichCommentText';
import { t } from '../../../../src/utils/i18n';

/** Enough to judge the answer without the card taking over the sidebar. */
const PREVIEW_MAX_HEIGHT = 132;

/** What a save reports: the result with its reason, or only whether it wrote. */
type SaveOutcome = boolean | CommentSaveResult | void;

/**
 * Why a save did not write, in the words the card shows; null when it wrote
 * or said nothing. A bare `false` carries no reason, so none is made up.
 */
function saveFailureText(outcome: SaveOutcome): string | null {
    if (outcome === false) return t('The answer was not saved.');
    if (outcome && typeof outcome === 'object' && outcome.saved === false) return outcome.message;
    return null;
}

export interface SelectionCommentOfferContentProps {
    /** The highlighted passage, for telling one highlight from another. */
    highlightText: string;
    /** Page label as the reader knows it, when there is one. */
    pageLabel?: string | null;
    /** The comment text, exactly as it will be appended. */
    preview: string;
    /** Colour of the highlight this will be written to. */
    color?: string;
    /** Reveal the highlight in the reader. */
    onReveal?: () => void;
    /**
     * Write it. Resolves with what happened — `saveCommentToAnnotation`'s
     * result, or just whether it was written. A card still on screen after a
     * failed save says why.
     */
    onSave: () => Promise<SaveOutcome> | SaveOutcome;
    /** Leave the comment alone. */
    onDismiss: () => void;
}

const SelectionCommentOfferContent: React.FC<SelectionCommentOfferContentProps> = ({
    highlightText,
    pageLabel,
    preview,
    color = ALPHAIN_ANCHOR_COLOR,
    onReveal,
    onSave,
    onDismiss,
}) => {
    const [saving, setSaving] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const handleSave = () => {
        // Guarded rather than debounced: a second write would append the same
        // exchange to the comment twice.
        if (saving) return;
        setSaving(true);
        setFailure(null);
        let pending: Promise<SaveOutcome>;
        try {
            pending = Promise.resolve(onSave());
        } catch (error) {
            pending = Promise.reject(error);
        }
        void pending
            .then((outcome) => setFailure(saveFailureText(outcome)))
            .catch(() => setFailure(t('The answer was not saved.')))
            .finally(() => setSaving(false));
    };

    return (
        <div className="display-flex flex-col w-full">
            <div
                className={`display-flex flex-row items-start gap-2 py-15 ${
                    onReveal ? 'cursor-pointer' : ''
                }`}
                onClick={onReveal}
            >
                <ZoteroIcon
                    icon={ZOTERO_ICONS.ANNOTATE_HIGHLIGHT}
                    size={14}
                    color={color}
                    style={{ marginTop: 2 }}
                />
                <div className="display-flex flex-row min-w-0 flex-1 justify-between gap-3">
                    <div className="truncate">{highlightText || t('Highlighted passage')}</div>
                    {pageLabel && (
                        <div className="font-color-tertiary whitespace-nowrap">{t('Page {pageLabel}', { pageLabel })}</div>
                    )}
                </div>
            </div>

            <div
                className="text-sm font-color-secondary whitespace-pre-wrap mt-1 overflow-y-auto"
                style={{ maxHeight: PREVIEW_MAX_HEIGHT }}
            >
                <RichCommentText text={preview} />
            </div>

            {failure && (
                <div className="text-sm font-color-red mt-1" role="alert">{failure}</div>
            )}

            <div className="display-flex flex-row gap-2 pt-2">
                <div className="flex-1" />
                <Button variant="outline" onClick={onDismiss} disabled={saving}>
                    {t('Not now')}
                </Button>
                <Button variant="solid" onClick={handleSave} loading={saving} disabled={saving}>
                    {t('Save')}
                </Button>
            </div>
        </div>
    );
};

export default SelectionCommentOfferContent;
