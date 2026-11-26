import React, { useState, type ReactNode } from "react";
import { logger } from "@beaver/agent-core/platform/logger";
import { SectionLabel } from "./SettingsElements";
import { useSettingsHost } from "./host";
import { t } from "../i18n";

const stringPref = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Custom instructions: standing words the user adds to every chat. A client
 * with more prompts of its own shows them after it, as `children`.
 */
const CustomInstructionsSection: React.FC<{ children?: ReactNode }> = ({ children }) => {
    const host = useSettingsHost();
    const [customInstructions, setCustomInstructions] = useState(() => stringPref(host.getPref('customInstructions')));

    // --- Custom Instructions Change Handler ---
    const handleCustomInstructionsChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setCustomInstructions(newValue);
        if (newValue !== host.getPref('customInstructions')) {
            host.setPref('customInstructions', newValue);
            logger('Saved pref customInstructions');
        }
    };

    return (
        <>
            <SectionLabel>{t('Custom Instructions')}</SectionLabel>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                {t('Custom instructions are added to all chats and help steer responses. (Max ~250 words)')}
            </div>
            <div className="custom-prompt-card" style={{ cursor: 'default' }}>
                <textarea
                    value={customInstructions}
                    onChange={handleCustomInstructionsChange}
                    placeholder={t('Enter custom instructions here...')}
                    aria-label={t('Custom instructions')}
                    rows={5}
                    className="chat-input custom-prompt-edit-textarea text-base"
                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                    maxLength={1500}
                />
            </div>
            {children}
        </>
    );
};

export default CustomInstructionsSection;
