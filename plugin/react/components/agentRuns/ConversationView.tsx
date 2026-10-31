import React from 'react';
import { useAtomValue } from 'jotai';
import { conversationRailAtom } from '../../atoms/conversationNav';
import ConversationRail from './ConversationRail';

interface ConversationViewProps {
    /** The thread view's scroll container, which the rail reads and scrolls. */
    containerRef: React.RefObject<HTMLDivElement>;
    /** Whether this is the separate window, which keeps its own scroll state. */
    isWindow: boolean;
    /** The thread view. */
    children: React.ReactNode;
}

/**
 * The thread view and, while the setting is on, the question rail over its
 * right edge. With the rail on, `has-rail` hides the thread view's scroll bar
 * and pads its text clear of the rail (beaver.css); turning the setting off
 * takes both away at once.
 *
 * The thread view comes in as `children`, so switching the rail re-renders
 * this wrapper and not the conversation.
 */
const ConversationView: React.FC<ConversationViewProps> = ({ containerRef, isWindow, children }) => {
    const isRailOn = useAtomValue(conversationRailAtom);
    return (
        <div className={`conversation-view flex-1 min-h-0 min-w-0 display-flex flex-col relative ${isRailOn ? 'has-rail' : ''}`}>
            {children}
            {isRailOn && <ConversationRail containerRef={containerRef} isWindow={isWindow} />}
        </div>
    );
};

export default ConversationView;
