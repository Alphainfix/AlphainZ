import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { BulletListIcon, Icon } from '../../icons/icons';
import {
    conversationTurnCountAtom,
    outlineElementId,
    outlineOpenAtomFor,
    toggleConversationOutlineAtom,
} from '../../../atoms/conversationNav';
import { questionCountLabel } from '../../../utils/conversationTurns';

interface ConversationOutlineButtonProps {
    /** Whether this is the separate window, which has its own outline. */
    isWindow?: boolean;
    className?: string;
}

/**
 * Opens the conversation outline: every question in the chat, filterable,
 * each one click from its place in the thread. Shown whenever the
 * conversation has a question, whether or not the question rail is on. The
 * small number on it is how many questions there are.
 */
const ConversationOutlineButton = React.forwardRef<HTMLButtonElement, ConversationOutlineButtonProps>(
    function ConversationOutlineButton({ isWindow = false, className = '' }, ref) {
        const count = useAtomValue(conversationTurnCountAtom);
        const isOpen = useAtomValue(outlineOpenAtomFor(isWindow));
        const toggle = useSetAtom(toggleConversationOutlineAtom);

        if (count === 0) return null;

        return (
            <Tooltip content="Conversation outline" secondaryContent={questionCountLabel(count)} showArrow singleLine>
                <button
                    ref={ref}
                    type="button"
                    className={`variant-ghost icon-only conversation-outline-button ${isOpen ? 'thread-list-toggle-active' : ''} ${className}`}
                    aria-label="Conversation outline"
                    aria-haspopup="dialog"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? outlineElementId(isWindow) : undefined}
                    onClick={() => toggle(isWindow)}
                >
                    <Icon icon={BulletListIcon} />
                    <span className="conversation-outline-count" aria-hidden="true">
                        {count > 99 ? '99+' : count}
                    </span>
                </button>
            </Tooltip>
        );
    },
);

export default ConversationOutlineButton;
