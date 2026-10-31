import React from 'react';
import { useAtom } from 'jotai';
import { conversationRailAtom } from '../../atoms/conversationNav';
import { SectionLabel, SettingsGroup, SettingsRow } from './components/SettingsElements';

const RAIL_TITLE = 'Question ticks instead of a scroll bar';

/**
 * Settings → Advanced → Conversation View: the question rail's switch.
 *
 * Takes effect at once in the sidebar and the separate window: they follow the
 * preference, so turning it off removes the ticks and brings the scroll bar back.
 */
const ConversationViewSection: React.FC = () => {
    const [isRailOn, setRailOn] = useAtom(conversationRailAtom);
    const toggle = () => setRailOn(!isRailOn);

    return (
        <>
            <SectionLabel>Conversation View</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title={RAIL_TITLE}
                    description="One tick per question at the right edge of the chat. Point at a tick to preview that question, click it to jump there; the wheel, trackpad and keys still scroll. Off brings the scroll bar back. The outline button in the chat header is there either way"
                    onClick={toggle}
                    control={
                        <input type="checkbox" aria-label={RAIL_TITLE}
                            checked={isRailOn}
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
