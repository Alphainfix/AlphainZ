import React, { useRef, useCallback } from 'react';
import { CancelIcon, PlusSignIcon, PictureInPictureIcon, ChattingIcon } from './icons/icons';
import DatabaseStatusButton from './ui/buttons/DatabaseStatusButton';
import EmbeddingIndexStatusButton from './ui/buttons/EmbeddingIndexStatusButton';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { openBeaverWindow } from '../../src/ui/openBeaverWindow';
import { newThreadAtom } from '../atoms/threads';
import { currentThreadIdAtom, runsCountAtom } from '@beaver/agent-core/run-state/atoms';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { isWaitingForProfileAtom } from '../atoms/auth';
import { isThreadListViewAtom } from '../atoms/ui';
import UserAccountMenuButton from './ui/buttons/UserAccountMenuButton';
import DevToolsMenuButton from './ui/buttons/DevToolsMenuButton';
import ThreadMenuButton from './ui/buttons/ThreadMenuButton';
import StreamDisplayButton from './ui/buttons/StreamDisplayButton';
import ConversationOutlineButton from './ui/buttons/ConversationOutlineButton';
import { hasCompletedOnboardingAtom, isDatabaseSyncSupportedAtom, updateRequiredAtom, isProfileLoadedAtom } from '../atoms/profile';
import { isFirstRunVisibleAtom } from '../atoms/firstRun';
import { getWindowFromElement } from '@beaver/agent-ui/utils/windowContext';
import { currentMessageContentAtom } from '../atoms/messageComposition';
import { getPref } from '../../src/utils/prefs';
import { t } from '../../src/utils/i18n';


interface HeaderProps {
    onClose?: () => void;
    isWindow?: boolean;
    /**
     * Passed where the conversation is on screen: the header then carries the
     * conversation outline button, and the outline hands focus back to it.
     */
    outlineButtonRef?: React.RefObject<HTMLButtonElement>;
}

const Header: React.FC<HeaderProps> = ({ onClose, isWindow = false, outlineButtonRef }) => {
    const runsCount = useAtomValue(runsCountAtom);
    const newThread = useSetAtom(newThreadAtom);
    const isWaitingForProfile = useAtomValue(isWaitingForProfileAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const updateRequired = useAtomValue(updateRequiredAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const currentMessageContent = useAtomValue(currentMessageContentAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    const [isThreadListView, setIsThreadListView] = useAtom(isThreadListViewAtom);
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    const closeButtonRef = useRef<HTMLButtonElement>(null);


    const handleNewThread = async () => {
        setIsThreadListView(false);
        await newThread();
    }

    const handleClose = useCallback(() => {
        setIsThreadListView(false);
        if (isWindow) {
            // Get the actual window where the button is rendered, not the main window
            const currentWindow = getWindowFromElement(closeButtonRef.current);
            currentWindow?.close();
        } else {
            triggerToggleChat(Zotero.getMainWindow());
        }
    }, [isWindow, setIsThreadListView]);

    // Get platform-specific shortcut text
    const keyboardShortcut = getPref("keyboardShortcut").toUpperCase() || "J";
    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';
    const closeChatShortcut = Zotero.isMac ? `⌘${keyboardShortcut}` : `Ctrl+${keyboardShortcut}`;
    const openWindowShortcut = Zotero.isMac ? `⌘⇧${keyboardShortcut}` : `Ctrl+Shift+${keyboardShortcut}`;

    return (
        <div id="alphainz-header" className="display-flex flex-row px-3 py-2">
            {/* Left side: Navigation & Workspace */}
            <div className="flex-1 display-flex gap-4">

                {/* Close chat */}
                {!isWindow && (
                    <Tooltip
                        content={t('Close chat')}
                        secondaryContent={closeChatShortcut}
                        showArrow
                        singleLine
                    >
                        <IconButton
                            ref={closeButtonRef}
                            icon={CancelIcon}
                            onClick={handleClose}
                            className="scale-14"
                            ariaLabel={t('Close AlphainZ panel')}
                        />
                    </Tooltip>
                )}

                {/* Chat history and new chat */}
                {/* Chat history and new chat were gated on a signed-in, onboarded,
                    up-to-date account. Every clause is false without one, so both
                    buttons were permanently hidden — including the only route to
                    the thread list. Only the first-run check survives, which is
                    about the panel already showing its own starting points. */}
                {!isFirstRunVisible && (
                    <>
                    <Tooltip content={t('Chat history')} showArrow singleLine>
                        <IconButton
                            icon={ChattingIcon}
                            onClick={() => setIsThreadListView(!isThreadListView)}
                            className={`scale-14 ${isThreadListView ? 'thread-list-toggle-active' : ''}`}
                            ariaLabel={t('Show chat history')}
                        />
                    </Tooltip>
                    <Tooltip content={t('New chat')} secondaryContent={newChatShortcut} showArrow singleLine>
                        <IconButton
                            icon={PlusSignIcon}
                            onClick={handleNewThread}
                            className="scale-14"
                            ariaLabel={t('New chat')}
                            disabled={runsCount === 0}
                        />
                    </Tooltip>
                    {/* Every question in this chat; hidden until there is one. */}
                    {outlineButtonRef && (
                        <ConversationOutlineButton
                            ref={outlineButtonRef}
                            isWindow={isWindow}
                            className="scale-14"
                        />
                    )}
                    </>
                )}
            </div>

            {/* Right side: Current Context & Global Actions */}
            {/* Also gated on an account, which hid the settings menu — the only
                entry point to the preferences window. */}
            <div className="display-flex gap-4 items-center">
                    {/* Embedding index status for users without databaseSync */}
                    {!isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible && (
                        <EmbeddingIndexStatusButton />
                    )}
                    {/* Database status for users with databaseSync */}
                    {isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible && (
                        <DatabaseStatusButton />
                    )}
                    {/* Development tools */}
                    {process.env.NODE_ENV === 'development' && (
                        <DevToolsMenuButton
                            className="scale-14"
                            ariaLabel={t('Development tools')}
                            currentMessageContent={currentMessageContent}
                        />
                    )}
                    {/* How much of the run's working steps to show */}
                    {!isFirstRunVisible && (
                        <StreamDisplayButton className="scale-14" />
                    )}
                    {threadId && !isFirstRunVisible && (
                        <ThreadMenuButton
                            className="scale-14"
                            ariaLabel={t('Chat actions')}
                        />
                    )}
                    {/* Open in separate window */}
                    {!isWindow && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible && (
                        <Tooltip content={t('Open in separate window')} secondaryContent={openWindowShortcut} showArrow singleLine>
                            <IconButton
                                icon={PictureInPictureIcon}
                                onClick={openBeaverWindow}
                                className="scale-14"
                                ariaLabel={t('Open in separate window')}
                            />
                        </Tooltip>
                    )}
                    {/* Settings */}
                    <UserAccountMenuButton
                        className="scale-14"
                        ariaLabel={t('AlphainZ settings')}
                    />
                </div>
        </div>
    );
};

export default Header;
