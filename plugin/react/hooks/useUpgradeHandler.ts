import { useEffect } from 'react';
import { logger } from '@beaver/agent-core/platform/logger';
import { clearPendingVersionNotifications, getPendingVersionNotifications } from '../../src/utils/versionNotificationPrefs';

/**
 * Version-upgrade housekeeping.
 *
 * Nothing announces itself here: release notes live in the manual, not in a
 * popup. The one job left is to clear any pending-notification queue carried
 * over from an older install, so it can never surface later.
 */
export const useUpgradeHandler = () => {
    useEffect(() => {
        try {
            const pending = getPendingVersionNotifications();
            if (pending.length > 0) {
                clearPendingVersionNotifications();
                logger(`useUpgradeHandler: cleared ${pending.length} stale version notification(s)`);
            }
        } catch (error) {
            logger(`useUpgradeHandler: ${error}`, 1);
        }
    }, []);
};
