import React, { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { ConversationRail } from '@beaver/agent-ui/conversation/ConversationRail';
import { conversationRailAtom, conversationTurnsAtom } from '../../atoms/conversationNav';
import { userScrolledAtom, windowUserScrolledAtom } from '../../atoms/ui';
import { store } from '../../store';

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
 * and pads its text clear of the rail (agent-ui-components.css); turning the setting off
 * takes both away at once.
 *
 * The thread view comes in as `children`, so switching the rail re-renders
 * this wrapper and not the conversation.
 */
const ConversationView: React.FC<ConversationViewProps> = ({ containerRef, isWindow, children }) => {
    const isRailOn = useAtomValue(conversationRailAtom);
    const turns = useAtomValue(conversationTurnsAtom);
    // The separate window keeps its own scroll state.
    const onScrolled = useCallback(
        (scrolledAway: boolean) => store.set(isWindow ? windowUserScrolledAtom : userScrolledAtom, scrolledAway),
        [isWindow],
    );
    return (
        <div className={`conversation-view flex-1 min-h-0 min-w-0 display-flex flex-col relative ${isRailOn ? 'has-rail' : ''}`}>
            {children}
            {isRailOn && <ConversationRail containerRef={containerRef} turns={turns} onScrolled={onScrolled} />}
        </div>
    );
};

export default ConversationView;
