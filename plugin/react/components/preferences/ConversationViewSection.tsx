import React from 'react';
import { useAtom } from 'jotai';
import SharedConversationViewSection from '@beaver/agent-ui/settings/ConversationViewSection';
import { conversationRailAtom } from '../../atoms/conversationNav';

/**
 * Settings → Advanced → Conversation View: the question rail's switch
 * (@beaver/agent-ui/settings/ConversationViewSection).
 *
 * Takes effect at once in the sidebar and the separate window: they follow the
 * preference, so turning it off removes the ticks and brings the scroll bar back.
 */
const ConversationViewSection: React.FC = () => {
    const [isRailOn, setRailOn] = useAtom(conversationRailAtom);
    return <SharedConversationViewSection railOn={isRailOn} onRailChange={setRailOn} />;
};

export default ConversationViewSection;
