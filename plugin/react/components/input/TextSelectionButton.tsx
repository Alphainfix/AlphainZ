import React, { forwardRef } from 'react'
import { Icon, TextAlignLeftIcon, PdfIcon, FileViewIcon } from "../icons/icons"
import { useSetAtom } from 'jotai'
import { readerTextSelectionAtom } from '../../atoms/messageComposition'
import { getCurrentReader, revealTextSelectionInCurrentReader, textSelectionLocation } from '../../utils/readerUtils'
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu'
import { TextSelection } from '@beaver/agent-core/types/attachments/apiTypes'
import { truncateText } from '@beaver/agent-ui/utils/stringUtils'
import { ChipWithPopup, type ChipPopupContent } from '@beaver/agent-ui/chat/ChipPopup'
import { ChipButton } from '../agentRuns/requestChips/ChipButton'
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon'
import { t } from '../../../src/utils/i18n';


const MAX_TEXT_SELECTION_TOOLTIP_TEXT_LENGTH = 160;

/**
 * What the chip's reveal action says, or null when there is nowhere to go.
 *
 * A PDF names the page the passage starts on (`page_index`), not the page that
 * was in view when it was staged. An EPUB or snapshot passage can only be
 * revealed by its position — page numbers mean nothing to those views.
 */
function textSelectionRevealLabel(
    selection: TextSelection,
    readerType: string | undefined,
): string | null {
    if (!textSelectionLocation(selection, readerType)) return null;
    if (readerType === 'pdf') {
        const page = typeof selection.page_index === 'number'
            ? selection.page_index + 1
            : selection.page;
        return page != null ? t('Reveal page {page} in PDF', { page }) : t('Reveal in PDF');
    }
    const readerTypeName = readerType === 'epub' ? 'EPUB'
        : readerType === 'snapshot' ? t('Snapshot')
        : t('Document');
    return t('Reveal in {type}', { type: readerTypeName });
}

interface TextSelectionButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'source'> {
    selection: TextSelection
    canEdit?: boolean
    disabled?: boolean
    /** Long-press the remove "x" to clear every editable context item at once. */
    onRemoveAll?: () => void
}

export const TextSelectionButton = forwardRef<HTMLButtonElement, TextSelectionButtonProps>(
    function TextSelectionButton(props: TextSelectionButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            selection,
            className,
            disabled = false,
            canEdit = true,
            onRemoveAll,
            onMouseEnter,
            onMouseLeave,
            onClick,
            ...rest
        } = props

        // States/Atoms needed for non-preview logic
        const setReaderTextSelection = useSetAtom(readerTextSelectionAtom)

        // Where the passage is decides both the label and whether there is a
        // reveal at all: a PDF page, or the reader's own position for it.
        const readerType = getCurrentReader()?.type;
        const revealIcon = readerType === 'pdf' ? PdfIcon : FileViewIcon;
        const revealLabel = textSelectionRevealLabel(selection, readerType);

        const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
            onRemove: () => {
                setReaderTextSelection(null) // Remove the selection itself
            },
            onRemoveAll,
            canEdit,
            disabled,
            // Mirror the button click: scroll the reader back to the passage.
            extraMenuItems: revealLabel ? [{
                label: revealLabel,
                icon: revealIcon,
                onClick: () => { revealTextSelectionInCurrentReader(selection); },
            }] : [],
        })

        const popup = React.useMemo<ChipPopupContent>(() => {
            const selectionText = truncateText(selection.text.replace(/\s+/g, ' ').trim(), MAX_TEXT_SELECTION_TOOLTIP_TEXT_LENGTH);
            return {
                icon: <Icon icon={TextAlignLeftIcon} className="scale-90 font-color-primary mt-020" />,
                title: t('Text Selection'),
                subtitle: selectionText ? { text: selectionText } : null,
                action: revealLabel ? { icon: revealIcon, label: revealLabel } : null,
            };
        }, [selection.text, revealIcon, revealLabel]);

        const normalIcon = (
            <Icon icon={TextAlignLeftIcon} className="mt-015 font-color-secondary" />
        );

        return (
            <>
            <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton
                    ref={ref}
                    {...rest}
                    {...contextMenuHandlers}
                    className={`${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
                    disabled={disabled}
                    onMouseEnter={onMouseEnter}
                    onMouseLeave={onMouseLeave}
                    onClick={(e) => {
                        e.stopPropagation();
                        revealTextSelectionInCurrentReader(selection);
                        onClick?.(e);
                    }}
                >
                    {canEdit ? (
                        <ChipRemovableIcon
                            normalIcon={normalIcon}
                            removeHandlers={removeHandlers}
                            removeMenuOpen={isRemoveMenuOpen}
                        />
                    ) : normalIcon}
                    <span className={`truncate`}>
                        {t('Text Selection')}
                    </span>
                </ChipButton>
            </ChipWithPopup>
            {removeMenu}
            </>
        )
    }
)
