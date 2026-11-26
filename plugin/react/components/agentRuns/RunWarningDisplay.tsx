import React from 'react';
import { useSetAtom } from 'jotai';
import { Icon, AlertIcon, CancelIcon, InformationCircleIcon } from '../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';
import { RunWarning, dismissWarningAtom, warningTone } from '../../atoms/warnings';
import type { PreferencePageTab } from '../../atoms/ui';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { msg, t } from '../../../src/utils/i18n';

interface RunWarningDisplayProps {
    warning: RunWarning;
}

/** The Settings tab a warning's text sends the user to, for the warnings that name one. */
const SETTINGS_LINK_BY_TYPE: Record<string, { tab: PreferencePageTab; label: string }> = {
    semantic_search_unavailable: { tab: 'models', label: msg('Open Settings → Model') },
    semantic_search_failed: { tab: 'models', label: msg('Open Settings → Model') },
    output_limit: { tab: 'advanced', label: msg('Open Settings → Advanced') },
    iteration_limit: { tab: 'advanced', label: msg('Open Settings → Advanced') },
};

/**
 * Displays a dismissable warning for an agent run.
 *
 * Warnings are non-fatal: the answer is still there. Their look follows their
 * tone (see `warningTone`) — a notice is a quiet line, a warning about the
 * answer is a box with an orange mark, and a change that could not be applied
 * reads as an error — so the ones that need something from the user do not
 * blend in with the ones that only inform.
 */
export const RunWarningDisplay: React.FC<RunWarningDisplayProps> = ({ warning }) => {
    const dismissWarning = useSetAtom(dismissWarningAtom);
    const tone = warningTone(warning.type);
    const settingsLink = SETTINGS_LINK_BY_TYPE[warning.type];

    const handleDismiss = () => {
        dismissWarning(warning.id);
    };

    const link = settingsLink && (
        <button
            type="button"
            className={`${tone === 'notice' ? 'text-link-muted' : 'text-link'} text-sm`}
            style={{ padding: 0 }}
            onClick={() => openPreferencesWindow(settingsLink.tab)}
            data-warning-action="open-settings"
        >
            {t(settingsLink.label)}
        </button>
    );

    if (tone === 'notice') {
        return (
            <div
                className="display-flex flex-row gap-2 items-start font-color-tertiary"
                role="note"
                data-warning-tone="notice"
            >
                <Icon icon={InformationCircleIcon} className="scale-90 mt-010 flex-shrink-0" />
                <div className="text-sm flex-1 min-w-0">
                    {parseTextWithLinksAndNewlines(warning.message)}
                    {link && <>{' '}{link}</>}
                </div>
                <IconButton
                    variant="ghost-tertiary"
                    icon={CancelIcon}
                    className="scale-85"
                    ariaLabel={t('Hide this notice for the rest of the session')}
                    title={t('Hide for the rest of the session')}
                    onClick={handleDismiss}
                />
            </div>
        );
    }

    const isError = tone === 'error';
    return (
        <div
            className={`display-flex flex-col p-3 gap-3 rounded-lg ${isError ? 'border-error' : 'bg-quinary'}`}
            style={isError
                ? { background: 'var(--tag-red-quinary)' }
                : { boxShadow: 'inset 3px 0 0 var(--tag-orange-secondary)' }}
            data-warning-tone={tone}
        >
            <div className={`${isError ? 'font-color-red' : 'font-color-secondary'} display-flex flex-row gap-3 items-start`}>
                <Icon
                    icon={AlertIcon}
                    className={`scale-11 mt-020 flex-shrink-0 ${isError ? 'font-color-red' : 'font-color-orange'}`}
                />
                <div className="display-flex flex-col flex-1 gap-2 min-w-0">
                    <div className="display-flex flex-row gap-2 items-start">
                        <div className="display-flex flex-col gap-1 min-w-0">
                            <div className="text-base">
                                {parseTextWithLinksAndNewlines(warning.message, isError ? 'text-link-red' : undefined)}
                            </div>
                            {link && <div>{link}</div>}
                        </div>
                        <div className="flex-1" />
                        <IconButton
                            variant="ghost-secondary"
                            icon={CancelIcon}
                            className="mr-1 scale-90 mt-015"
                            ariaLabel={t('Dismiss this warning')}
                            onClick={handleDismiss}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default RunWarningDisplay;
