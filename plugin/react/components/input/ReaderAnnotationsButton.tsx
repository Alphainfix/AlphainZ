import React, { forwardRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Icon, HighlighterIcon } from '../icons/icons'
import {
    readerAnnotationsAtom,
    readerAnnotationCountAtom,
    clearReaderAnnotationsAtom,
} from '../../atoms/messageComposition'
import { revealAnnotationInCurrentReader } from '../../utils/readerUtils'
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu'
import { truncateText } from '@beaver/agent-ui/utils/stringUtils'
import { ChipWithListPopup, type ChipListPopupContent } from '@beaver/agent-ui/chat/ChipPopup'
import { ChipButton } from '../agentRuns/requestChips/ChipButton'
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon'

/** Rows the hover list shows before it summarizes the rest. */
const MAX_POPUP_ROWS = 5;
const MAX_POPUP_TEXT = 110;

/**
 * One chip for every highlight on the open paper.
 *
 * These used to be one chip each, which is the right shape for something the
 * user attached deliberately and the wrong one for a set that arrives on its
 * own: a paper with thirty marks pushed every other source into the overflow
 * and took thirty clicks to take back off. They arrive together and they leave
 * together, so they are one thing.
 *
 * A highlight the user attached on its own — the one they chose Explain or Ask
 * on — has a chip of its own and is not counted here again.
 */
export const ReaderAnnotationsButton = forwardRef<HTMLButtonElement, {
    canEdit?: boolean;
    disabled?: boolean;
    onRemoveAll?: () => void;
    /** `${libraryID}-${key}` of highlights shown as chips of their own. */
    shownSeparately?: ReadonlySet<string>;
}>(function ReaderAnnotationsButton({ canEdit = true, disabled = false, onRemoveAll, shownSeparately }, ref) {
    const staged = useAtomValue(readerAnnotationsAtom);
    const annotations = React.useMemo(
        () => shownSeparately && shownSeparately.size > 0
            ? staged.filter((annotation) => !shownSeparately.has(`${annotation.libraryID}-${annotation.key}`))
            : staged,
        [staged, shownSeparately],
    );
    const total = useAtomValue(readerAnnotationCountAtom);
    const clearReaderAnnotations = useSetAtom(clearReaderAnnotationsAtom);

    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => clearReaderAnnotations(),
        onRemoveAll,
        canEdit,
        disabled,
    });

    const popup = React.useMemo<ChipListPopupContent>(() => {
        const rows = annotations.slice(0, MAX_POPUP_ROWS).map((annotation) => {
            const page = (annotation as any).annotationPageLabel;
            const text = String((annotation as any).annotationText ?? '').replace(/\s+/g, ' ').trim();
            const comment = String((annotation as any).annotationComment ?? '').trim();
            return {
                key: annotation.key,
                icon: <Icon icon={HighlighterIcon} className="scale-90 font-color-secondary" />,
                title: truncateText(text || comment || '(no text)', MAX_POPUP_TEXT),
                subtitle: page ? { text: `p.${page}` } : null,
            };
        });
        // The attached set is capped; the count is the paper's whole set, and
        // the difference is exactly what the model is told to go and fetch.
        const beyondList = annotations.length - rows.length;
        const beyondAttached = Math.max(0, total - staged.length);
        const parts: string[] = [];
        if (beyondList > 0) parts.push(`${beyondList} more attached`);
        if (beyondAttached > 0) parts.push(`${beyondAttached} not attached — the agent can fetch them`);
        return { rows, footer: parts.length > 0 ? parts.join(' · ') : null };
    }, [annotations, staged, total]);

    if (annotations.length === 0) return null;

    const normalIcon = <Icon icon={HighlighterIcon} className="mt-015 font-color-secondary" />;
    const label = annotations.length === 1 ? '1 Highlight' : `${annotations.length} Highlights`;

    return (
        <>
            <ChipWithListPopup content={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton
                    ref={ref}
                    {...contextMenuHandlers}
                    className={disabled ? 'disabled-but-styled' : ''}
                    disabled={disabled}
                    onClick={(e) => {
                        e.stopPropagation();
                        // Jump to the first one, the way the selection chip jumps
                        // to its passage. By the annotation's own position: its
                        // printed page label ("1043", "xii") is not a page
                        // number, and selecting it would take a staged passage
                        // off the message.
                        if (annotations[0]) void revealAnnotationInCurrentReader(annotations[0]);
                    }}
                >
                    {canEdit ? (
                        <ChipRemovableIcon
                            normalIcon={normalIcon}
                            removeHandlers={removeHandlers}
                            removeMenuOpen={isRemoveMenuOpen}
                        />
                    ) : normalIcon}
                    <span className="truncate">{label}</span>
                </ChipButton>
            </ChipWithListPopup>
            {removeMenu}
        </>
    );
});
