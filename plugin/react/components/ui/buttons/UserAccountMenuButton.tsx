import React from 'react';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { SettingsIcon } from '../../icons/icons';
import { openPreferencesWindow } from '../../../../src/ui/openPreferencesWindow';
import { t } from '../../../../src/utils/i18n';

interface UserAccountMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

/**
 * The header's Settings button: a gear that opens the settings window.
 *
 * The model runs on the user's own key and there is no account, so there is
 * no account menu to open first — the gear goes straight to Settings, which is
 * what the guide and the error messages ("Settings → Model") point at.
 */
const UserAccountMenuButton: React.FC<UserAccountMenuButtonProps> = ({
    className = '',
    ariaLabel = t('Settings'),
}) => (
    <Tooltip content={t('Settings')} showArrow singleLine>
        <IconButton
            icon={SettingsIcon}
            onClick={() => openPreferencesWindow()}
            className={className}
            ariaLabel={ariaLabel}
        />
    </Tooltip>
);

export default UserAccountMenuButton; 