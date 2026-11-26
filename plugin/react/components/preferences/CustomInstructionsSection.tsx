import React, { useState } from "react";
import SharedCustomInstructionsSection from "@beaver/agent-ui/settings/CustomInstructionsSection";
import { SectionLabel } from "./components/SettingsElements";
import { ZoteroSettingsHost } from "./settingsHost";
import { getPref, setPref } from "../../../src/utils/prefs";
import { logger } from "@beaver/agent-core/platform/logger";
import { t } from '../../../src/utils/i18n';


/**
 * Custom instructions (shared with the other clients), then the prompt the
 * reader's Explain button sends, which only this plugin has.
 */
const CustomInstructionsSection: React.FC = () => {

    // --- Atoms ---
    const [readerExplainPrompt, setReaderExplainPrompt] = useState(() => getPref('readerExplainPrompt'));

    // --- Save Preferences ---
    const handlePrefSave = (key: "readerExplainPrompt", value: string) => {
        if (value !== getPref(key)) {
            setPref(key, value);
            logger(`Saved pref ${key}`);
        }
    };

    // --- Reader Explain Prompt Change Handler ---
    const handleReaderExplainPromptChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setReaderExplainPrompt(newValue);
        handlePrefSave('readerExplainPrompt', newValue);
    };


    return (
        <ZoteroSettingsHost>
            <SharedCustomInstructionsSection>
                <SectionLabel>{t('Reader Explain Prompt')}</SectionLabel>
                <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                    {t('The prompt sent when you click "Explain" on selected text or annotations in the PDF reader.')}
                </div>
                <div className="custom-prompt-card" style={{ cursor: 'default' }}>
                    <textarea
                        value={readerExplainPrompt}
                        onChange={handleReaderExplainPromptChange}
                        placeholder={t('Explain the selected passage from this paper in plain language...')}
                        aria-label={t('Reader explain prompt')}
                        rows={4}
                        className="chat-input custom-prompt-edit-textarea text-base"
                        style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                        maxLength={1500}
                    />
                </div>
            </SharedCustomInstructionsSection>
        </ZoteroSettingsHost>
    );
};

export default CustomInstructionsSection;
