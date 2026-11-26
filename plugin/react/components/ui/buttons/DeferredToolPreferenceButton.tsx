import React, { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { ArrowDownIcon, Icon, TickIcon } from '../../icons/icons';
import {
    DeferredToolPreference,
    getGroupForToolAtom,
    getPreferenceForToolAtom,
    updateToolPreferenceAtom,
    DEFERRED_TOOL_PREFERENCE_LABELS,
} from '../../../atoms/deferredToolPreferences';
import { NO_STANDING_APPROVAL_GROUPS } from '../../../atoms/runApprovalPolicy';
import { msg, t } from '../../../../src/utils/i18n';

/**
 * What the button says for a kind of change that has no standing preference.
 * Adding papers always asks: a saved "always apply" would be ignored, so none
 * is offered.
 */
const FIXED_PREFERENCE_LABEL = msg('Always asks');
const FIXED_PREFERENCE_TOOLTIP = msg('Adding papers always asks: each paper is added only once you apply it.');
/** The same, on a card whose Apply button can also allow the rest of the run. */
const FIXED_PREFERENCE_RUN_GRANT_TOOLTIP = msg('Adding papers always asks: each paper is added only once you apply it. '
    + '"Allow for this run" on the Apply button covers the rest of this run.');

interface DeferredToolPreferenceButtonProps {
    /** The tool name to get/set preference for */
    toolName: string;
    /** Optional callback after preference changes */
    onPreferenceChange?: (preference: DeferredToolPreference) => void;
    /** Optional allowed preference subset (defaults to all deferred preferences) */
    allowedPreferences?: DeferredToolPreference[];
    /** Show the current preference without allowing it to be changed. */
    disabled?: boolean;
    /** Optional explanation shown when hovering the button. */
    tooltipContent?: string;
    /**
     * Whether the card's Apply button offers "Allow for this run" — it does
     * only while a live approval is waiting — so the explanation of a kind of
     * change that always asks can point to it.
     */
    offersRunGrant?: boolean;
}

/**
 * Dropdown button for selecting the preference for a deferred tool action.
 * Shows the current preference and allows changing it.
 */
const DeferredToolPreferenceButton: React.FC<DeferredToolPreferenceButtonProps> = ({
    toolName,
    onPreferenceChange,
    allowedPreferences,
    disabled = false,
    tooltipContent = t('How to handle this action'),
    offersRunGrant = false,
}) => {
    const getPreferenceForTool = useAtomValue(getPreferenceForToolAtom);
    const getGroupForTool = useAtomValue(getGroupForToolAtom);
    const updateToolPreference = useSetAtom(updateToolPreferenceAtom);
    
    const currentPreference = getPreferenceForTool(toolName);
    const isFixed = NO_STANDING_APPROVAL_GROUPS.has(getGroupForTool(toolName));

    const handleSelect = (preference: DeferredToolPreference) => {
        updateToolPreference({ toolName, preference });
        onPreferenceChange?.(preference);
    };

    const menuItems = useMemo((): MenuItem[] => {
        const preferences: DeferredToolPreference[] = allowedPreferences ?? [
            'always_ask',
            'always_apply',
            'continue_without_applying',
        ];

        return preferences.map((pref) => ({
            label: t(DEFERRED_TOOL_PREFERENCE_LABELS[pref]),
            onClick: () => handleSelect(pref),
            customContent: (
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <div className={`display-flex text-sm ${currentPreference === pref ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                        {t(DEFERRED_TOOL_PREFERENCE_LABELS[pref])}
                    </div>
                    {currentPreference === pref && (
                        <Icon icon={TickIcon} className="font-color-primary scale-11" />
                    )}
                </div>
            ),
        }));
    }, [allowedPreferences, currentPreference, toolName]);

    const buttonLabel = t(isFixed ? FIXED_PREFERENCE_LABEL : DEFERRED_TOOL_PREFERENCE_LABELS[currentPreference]);
    const isDisabled = disabled || isFixed;

    return (
        <MenuButton
            menuItems={isFixed ? [] : menuItems}
            variant="ghost-secondary"
            buttonLabel={buttonLabel}
            rightIcon={isDisabled ? undefined : ArrowDownIcon}
            style={{
                padding: '2px 2px',
                fontSize: '0.90rem',
            }}
            rightIconClassName="scale-11 -ml-05"
            ariaLabel={isFixed ? t('Adding papers always asks') : t('Select action preference')}
            tooltipContent={isFixed
                ? t(offersRunGrant ? FIXED_PREFERENCE_RUN_GRANT_TOOLTIP : FIXED_PREFERENCE_TOOLTIP)
                : tooltipContent}
            disabled={isDisabled}
            showArrow={false}
        />
    );
};

export default DeferredToolPreferenceButton;
