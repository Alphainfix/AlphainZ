import React from 'react';
import { SectionLabel, SettingsGroup, SettingsRow } from './SettingsElements';
import { msg, t } from '../i18n';

const RAIL_TITLE = msg('Question ticks instead of a scroll bar');

/**
 * Settings → Advanced → Conversation View: the question rail's switch.
 *
 * The client holds the setting and keeps its open chats in step with it, so
 * turning it off removes the ticks and brings the scroll bar back.
 * `description` replaces the explanation, for a client whose chat differs
 * from the one it describes.
 */
const ConversationViewSection: React.FC<{
    railOn: boolean;
    onRailChange: (on: boolean) => void;
    description?: string;
}> = ({ railOn, onRailChange, description }) => {
    const toggle = () => onRailChange(!railOn);

    return (
        <>
            <SectionLabel>{t('Conversation View')}</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title={t(RAIL_TITLE)}
                    description={description ?? t('One tick per question at the right edge of the chat. Point at a tick to preview that question, click it to jump there; the wheel, trackpad and keys still scroll. Off brings the scroll bar back. The outline button in the chat header is there either way')}
                    onClick={toggle}
                    control={
                        <input type="checkbox" aria-label={t(RAIL_TITLE)}
                            checked={railOn}
                            onChange={toggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }} />
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default ConversationViewSection;
