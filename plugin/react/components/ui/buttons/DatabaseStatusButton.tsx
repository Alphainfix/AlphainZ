import React, { useState } from "react";
import { useAtomValue } from "jotai";
import { syncingAtom, syncErrorAtom } from "../../../atoms/sync";
import { syncZoteroDatabase } from '../../../../src/utils/sync';
import IconButton from "@beaver/agent-ui/primitives/IconButton";
import { AlertIcon, SyncIcon } from "../../icons/icons";
import { syncedLibraryIdsAtom } from "../../../atoms/profile";
import { logger } from '@beaver/agent-core/platform/logger';
import Tooltip from "@beaver/agent-ui/primitives/Tooltip";
import { t } from '../../../../src/utils/i18n';


const DatabaseStatusButton: React.FC = () => {
    const [isHovered, setIsHovered] = useState(false);
    
    // Combined atoms
    const isSyncing = useAtomValue(syncingAtom);
    const hasError = useAtomValue(syncErrorAtom);
    const syncedLibraryIds = useAtomValue(syncedLibraryIdsAtom);
    
    // Handle manual sync button click
    const handleSyncClick = () => {
        if (!isSyncing) {
            logger(`Beaver Sync: User-initiated database sync`);
            syncZoteroDatabase(syncedLibraryIds, { resetSyncStatus: true });
        }
    };
    
    if (!isSyncing && !hasError) return null;
    
    // Determine which icon to show
    const icon = isSyncing ? SyncIcon : (isHovered ? SyncIcon : AlertIcon);
    const iconClassName = isSyncing 
        ? "animate-spin" 
        : (isHovered ? "" : "font-color-red");
    
    return (
        <Tooltip
            content={isSyncing ? t('Syncing...') : hasError ? t('Sync Error') : t('Sync Database')}
            secondaryContent={hasError && !isSyncing ? t('Click to retry sync') : undefined}
            showArrow
        >
            <div
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <IconButton
                    icon={icon}
                    onClick={handleSyncClick}
                    className="scale-13"
                    iconClassName={iconClassName}
                    ariaLabel={isSyncing ? t('Syncing...') : t('Sync Database')}
                    disabled={isSyncing}
                />
            </div>
        </Tooltip>
    );
};

export default DatabaseStatusButton;