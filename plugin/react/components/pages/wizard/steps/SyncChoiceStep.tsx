import React, { useCallback, useState } from 'react';
import Button from '@beaver/agent-ui/primitives/Button';
import { SettingsGroup, SettingsRow } from '../../../preferences/components/SettingsElements';
import { getPref } from '../../../../../src/utils/prefs';
import { conversationSyncMode } from '../../../../../src/services/conversationSync';
import { confirmAndSwitchSyncMode } from '../../../../utils/syncModeSwitch';
import { pickFolder } from '../../../../utils/folderPicker';
import { t } from '../../../../../src/utils/i18n';

/**
 * Step ②: where conversations and settings live — one place, or nowhere.
 *
 * The wizard writes only the preference; joining the location (see
 * WelcomeWizardPage) runs when the wizard completes, so backing out of a step
 * never leaves half a backend configured. A user who already had Zotero sync
 * on arrives with that row preselected and labeled — the upgrade path
 * acknowledges existing setup.
 */
const SyncChoiceStep: React.FC = () => {
    const wasAlreadySet = React.useMemo(() => conversationSyncMode() !== 'off', []);
    const [mode, setMode] = useState(() => conversationSyncMode());
    const [folderPath, setFolderPath] = useState(
        () => String(getPref('conversationSyncFolderPath') ?? ''),
    );

    /*
     * Through the shared switch helper, not a bare setPref, the same as the
     * settings page: leaving a live backend asks whether to keep its remote
     * copies or delete them. Keep is the default and Esc or closing the dialog
     * cancels the switch; deleting needs a second confirmation that gives the
     * number of files.
     */
    const choose = useCallback((next: 'off' | 'zotero' | 'folder', repick = false) => {
        void (async () => {
            /*
             * The picker is handed in as a callback, not run first: the shared
             * helper asks the keep/delete question about the backend being
             * LEFT before the new folder is chosen, and deletes nothing until
             * both answers are in.
             */
            const needsPicker = next === 'folder' && (repick || !folderPath);
            const outcome = await confirmAndSwitchSyncMode(next, {
                ...(needsPicker
                    ? {
                        pickFolder: async () => {
                            const picked = await pickFolder(t('Choose the sync folder'));
                            return picked.ok ? picked.path : null;
                        },
                    }
                    : {}),
            });
            if (outcome === 'cancelled') return;
            setMode(conversationSyncMode());
            setFolderPath(String(getPref('conversationSyncFolderPath') ?? ''));
        })();
    }, [folderPath]);

    return (
        <>
            <div className="text-base font-color-secondary mb-2">
                {t('Conversations (and these settings) can follow you between machines.')}
                {wasAlreadySet && <span className="font-color-green">{' '}{t('Already set ✓ — your current choice is selected below.')}</span>}
            </div>
            <SettingsGroup>
                <SettingsRow
                    title={t('Not now')}
                    description={t('Everything stays on this computer. You can turn sync on later in Settings → Advanced.')}
                    onClick={() => choose('off')}
                    control={<input type="radio" name="wizard-sync" aria-label={t('No sync')} checked={mode === 'off'} onChange={() => choose('off')} onClick={(e) => e.stopPropagation()} />}
                />
                <SettingsRow
                    title={t('Through Zotero sync')}
                    description={t('Stored as attachments in your Zotero library; your existing Zotero account carries them.')}
                    onClick={() => choose('zotero')}
                    control={<input type="radio" name="wizard-sync" aria-label={t('Zotero sync')} checked={mode === 'zotero'} onChange={() => choose('zotero')} onClick={(e) => e.stopPropagation()} />}
                />
                <SettingsRow
                    title={t('Synced folder')}
                    description={mode === 'folder' && folderPath
                        ? folderPath
                        : t('Plain JSON files in a folder you choose. Put it inside iCloud Drive, OneDrive or any synced folder — the plugin only reads and writes files there, like Obsidian.')}
                    onClick={() => choose('folder')}
                    control={
                        <div className="display-flex flex-row items-center gap-2">
                            <input type="radio" name="wizard-sync" aria-label={t('Synced folder')}
                                checked={mode === 'folder'}
                                onChange={() => choose('folder')}
                                onClick={(e) => e.stopPropagation()} />
                            <Button variant="outline" onClick={(e: any) => { e.stopPropagation(); choose('folder', true); }}>
                                {folderPath ? t('Change…') : t('Choose…')}
                            </Button>
                        </div>
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default SyncChoiceStep;
