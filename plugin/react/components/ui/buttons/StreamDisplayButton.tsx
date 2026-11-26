import React, { useMemo } from 'react';
import { useAtom } from 'jotai';

import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { ViewIcon } from '../../icons/icons';
import {
    STREAM_DISPLAY_HINTS,
    STREAM_DISPLAY_LABELS,
    STREAM_DISPLAY_MODES,
    streamDisplayModeAtom,
    type StreamDisplayMode,
} from '../../../atoms/streamDisplay';
import { t } from '../../../../src/utils/i18n';

interface StreamDisplayButtonProps {
    className?: string;
    ariaLabel?: string;
}

/**
 * Chooses how much of the run's working steps the transcript shows.
 *
 * Next to the chat actions rather than buried in settings because it is a
 * reading preference, not a configuration one: the same user wants the steps
 * out of the way while reading an answer and wants them back the moment
 * something looks wrong.
 *
 * An eye, for how much you see. The brain belongs to the model picker in the
 * composer; two controls sharing one icon read as one control.
 */
const StreamDisplayButton: React.FC<StreamDisplayButtonProps> = ({
    className = '',
    ariaLabel = t('Step display'),
}) => {
    const [mode, setMode] = useAtom(streamDisplayModeAtom);

    const menuItems = useMemo<MenuItem[]>(
        () =>
            STREAM_DISPLAY_MODES.map((option: StreamDisplayMode) => ({
                label: t(STREAM_DISPLAY_LABELS[option]),
                role: 'menuitemradio' as const,
                ariaChecked: mode === option,
                onClick: () => setMode(option),
                customContent: (
                    <div className="display-flex flex-col min-w-0">
                        <span
                            className={`text-sm ${mode === option ? 'font-color-primary font-semibold' : 'font-color-primary'}`}
                        >
                            {t(STREAM_DISPLAY_LABELS[option])}
                        </span>
                        <span className="text-xs font-color-tertiary">
                            {t(STREAM_DISPLAY_HINTS[option])}
                        </span>
                    </div>
                ),
            })),
        [mode, setMode],
    );

    return (
        <MenuButton
            icon={ViewIcon}
            menuItems={menuItems}
            className={className}
            ariaLabel={ariaLabel}
            variant="ghost"
            tooltipContent={t(STREAM_DISPLAY_LABELS[mode])}
            showArrow={true}
        />
    );
};

export default StreamDisplayButton;
