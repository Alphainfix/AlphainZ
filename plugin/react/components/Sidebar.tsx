import React, { useMemo, useRef, useEffect, type ReactNode } from 'react';
import InputArea from "./input/InputArea"
import { welcomeWizardVisibleAtom } from '../atoms/welcomeWizard';
import WelcomeWizardPage from './pages/wizard/WelcomeWizardPage';
import AskUserQuestionPanel from "./input/AskUserQuestionPanel"
import BatchApprovalPanel from "./input/BatchApprovalPanel"
import CreditConfirmationPanel from "./input/CreditConfirmationPanel"
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { pendingBatchApprovalsAtom } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import { pendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import { selectComposerTakeover } from '@beaver/agent-ui/chat/composerTakeover';
import Header from "./Header"
import { useEventSubscription } from '../hooks/useEventSubscription';
import { ThreadView } from "./agentRuns";
import { currentThreadScrollPositionAtom, windowScrollPositionAtom } from '../atoms/threads';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { isFirstRunOrigin } from '@beaver/agent-core/agents/types';
import { useAtomValue, useSetAtom } from 'jotai';
import { ScrollDownButton } from './ui/buttons/ScrollDownButton';
import { scrollToBottom } from '../utils/scrollToBottom';
import { userScrolledAtom, windowUserScrolledAtom, isSkippedFilesDialogVisibleAtom, isThreadListViewAtom } from '../atoms/ui';
import HomePage from './pages/HomePage';
import DragDropWrapper from './input/DragDropWrapper';
import DialogContainer from './dialog/DialogContainer';
import ThreadListView from './ThreadListView';
import CreditInfoBar from './input/CreditInfoBar';
import { store } from '../store';
import { isLoadingThreadAtom } from '../atoms/threads';
import { Spinner } from './icons/icons';
import { threadWarningsAtom } from '../atoms/warnings';
import PopupOverlayContainer from './PopupOverlayContainer';
import { isMigratingDataAtom, profileWithPlanAtom } from '../atoms/profile';
import FirstRunPage from './pages/FirstRunPage';
import { firstRunReturnRequestedAtom, isFirstRunVisibleAtom } from '../atoms/firstRun';
import WhereToStartPage from './pages/WhereToStartPage';
import { whereToStartVisibleAtom } from '../atoms/whereToStart';
import ScreenReaderRunAnnouncer from './agentRuns/ScreenReaderRunAnnouncer';
import { getFirstRunSelectionVariant } from '../utils/firstRunSelection';
import ConversationView from './agentRuns/ConversationView';
import ConversationOutline from './agentRuns/ConversationOutline';
import { t } from '../../src/utils/i18n';

interface SidebarProps {
    location: 'library' | 'reader';
    isWindow?: boolean;
}

interface SidebarShellProps {
    children: ReactNode;
    className?: string;
    id?: string;
    isWindow: boolean;
}

/**
 * Provides a named Beaver landmark for screen reader navigation.
 */
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Returns visible, sequentially focusable elements inside Beaver.
 */
const getFocusableElements = (root: HTMLElement): HTMLElement[] => {
    const win = root.ownerDocument.defaultView;
    if (!win) return [];

    const elements: HTMLElement[] = [];
    root.querySelectorAll(FOCUSABLE_SELECTOR).forEach((node) => {
        if (!(node instanceof win.HTMLElement)) return;
        if (node.tabIndex < 0) return;
        if ('disabled' in node && Boolean(node.disabled)) return;
        if (node.closest('[hidden],[aria-hidden="true"],[inert]')) return;

        const style = win.getComputedStyle(node);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return;
        if (node.getClientRects().length === 0) return;

        elements.push(node);
    });

    return elements;
};

const SidebarShell = ({
    children,
    className = "bg-sidepane h-full w-full display-flex flex-col min-w-0 relative",
    id,
    isWindow,
}: SidebarShellProps) => {
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) {
            return;
        }

        const root = event.currentTarget;
        const activeElement = root.ownerDocument.activeElement;
        const win = root.ownerDocument.defaultView;
        if (!win || !(activeElement instanceof win.HTMLElement) || !root.contains(activeElement)) {
            return;
        }

        const focusableElements = getFocusableElements(root);
        const activeIndex = focusableElements.indexOf(activeElement);
        if (activeIndex === -1) {
            return;
        }

        const nextIndex = activeIndex + (event.shiftKey ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= focusableElements.length) {
            return;
        }

        event.preventDefault();
        focusableElements[nextIndex].focus();
    };

    return (
        <div
            id={id}
            className={className}
            role={isWindow ? "main" : "region"}
            aria-label="AlphainZ"
            onKeyDown={handleKeyDown}
        >
            {children}
        </div>
    );
};

const Sidebar = ({ location, isWindow = false }: SidebarProps) => {
    // Input element is now a contenteditable div (Lexical editor) rather than
    // a textarea. Typed as HTMLElement so `.focus()` keeps working.
    const inputRef = useRef<HTMLElement | null>(null);
    const runs = useAtomValue(allRunsAtom);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const outlineButtonRef = useRef<HTMLButtonElement>(null);
    const setIsSkippedFilesDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);
    const isLoadingThread = useAtomValue(isLoadingThreadAtom);
    const isMigratingData = useAtomValue(isMigratingDataAtom);
    const isThreadListView = useAtomValue(isThreadListViewAtom);
    const setIsThreadListView = useSetAtom(isThreadListViewAtom);

    const allWarnings = useAtomValue(threadWarningsAtom);
    const creditInfoWarning = allWarnings.findLast((w) => w.type === 'credit_info');
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    const isWelcomeWizardVisible = useAtomValue(welcomeWizardVisibleAtom);
    const isFirstRunReturnRequested = useAtomValue(firstRunReturnRequestedAtom);
    const isWhereToStartVisible = useAtomValue(whereToStartVisibleAtom);
    const profile = useAtomValue(profileWithPlanAtom);
    const shouldAssignFirstRunVariant = isFirstRunVisible
        && !isFirstRunReturnRequested
        && !!profile?.user_id;
    const firstRunVariant = useMemo(() => {
        return shouldAssignFirstRunVariant && profile?.user_id
            ? getFirstRunSelectionVariant(profile.user_id)
            : 'first_run';
    }, [profile?.user_id, shouldAssignFirstRunVariant]);

    // Composer takeover: while the run blocks on a batch approval, a question
    // or a credit confirmation, that panel replaces the composer entirely (the
    // draft message atom is untouched, so the composer restores it afterwards).
    // selectComposerTakeover is shared across clients and owns the precedence
    // between the blocking states; this client reports all three of them.
    // Proposed changes waiting on their cards are not one: they block nothing,
    // and a question the run asks meanwhile must still be seen.
    const pendingQuestionsMap = useAtomValue(pendingQuestionsAtom);
    const pendingBatchApprovalsMap = useAtomValue(pendingBatchApprovalsAtom);
    const pendingCreditConfirmationsMap = useAtomValue(pendingCreditConfirmationsAtom);
    const composerTakeover = selectComposerTakeover({
        batchApprovals: pendingBatchApprovalsMap,
        creditConfirmations: pendingCreditConfirmationsMap,
        questions: pendingQuestionsMap,
    });

    useEffect(() => {
        setIsSkippedFilesDialogVisible(false);
    }, []);

    // Focus textarea when focusInput event is dispatched (e.g. reader "Ask..." button)
    useEventSubscription('focusInput', () => {
        setTimeout(() => inputRef.current?.focus(), 50);
    });

    // Select the correct atoms based on whether we're in the separate window
    const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
    const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;

    // Determine if we're in the run view (has runs) or home view (no runs)
    const isThreadView = runs.length > 0;

    const handleScrollToBottom = () => {
        if (messagesContainerRef.current) {
            store.set(scrolledAtom, false);
            // Clear stored scroll position to let natural scroll-to-bottom take over
            store.set(scrollPositionAtom, null);
            scrollToBottom(messagesContainerRef, false);
        }
    };

    if (isLoadingThread || isMigratingData) {
        return (
            <SidebarShell
                id="thread-loading"
                className="display-flex flex-col flex-1 w-full"
                isWindow={isWindow}
            >
                <Header isWindow={isWindow} />
                <div className="display-flex flex-1 items-center justify-center">
                    <div className="display-flex flex-col items-center gap-3">
                        <Spinner size={22}/>
                        <span className="font-color-tertiary">
                            {isMigratingData ? t('Upgrading your data...') : t('Loading...')}
                        </span>
                    </div>
                </div>
            </SidebarShell>
        );
    }

    /*
     * The welcome wizard outranks everything below: it is where keys, sync and
     * the index are chosen, so no other page may run ahead of it. Shown once
     * per WIZARD_VERSION per machine; the dev-tools entry forces it back.
     */
    if (isWelcomeWizardVisible) {
        return (
            <SidebarShell isWindow={isWindow}>
                <ScreenReaderRunAnnouncer inputRef={inputRef} surface={isWindow ? 'window' : 'sidebar'} />
                <Header isWindow={isWindow} />
                <WelcomeWizardPage />
                <DialogContainer />
            </SidebarShell>
        );
    }

    /*
     * Six account gates used to stand here, each returning its own page before
     * the chat could render: sign-in, profile-loading, a backend-driven
     * "update required" block, downgrade acknowledgement, upgrade consent, and
     * onboarding.
     *
     * Every one of them is a question about a Beaver cloud account — is there a
     * session, what plan is it on, has it consented, which libraries were
     * synced. AlphainZ has no account: the model is reached with the
     * user's own key and the library is read locally, so all six answers are
     * "not applicable" and the gates would simply never open.
     *
     * Removed rather than defaulted-open so the chat is the first thing the
     * panel renders. The page components are still in `pages/` — unreferenced
     * from here, and listed in the cleanup TODO rather than deleted in the same
     * change that made them unreachable.
     */

    {/* First-run suggestions page (see isFirstRunVisibleAtom in firstRun.ts):
        - explicit "Try another starting point" return (session atom), or
        - Free user, device authorized, never completed first-run on this account. */}
    if (isFirstRunVisible) {
        const showWhereToStart = !isFirstRunReturnRequested
            && firstRunVariant === 'where_to_start';
        return (
            <SidebarShell isWindow={isWindow}>
                <ScreenReaderRunAnnouncer inputRef={inputRef} surface={isWindow ? 'window' : 'sidebar'} />
                <Header isWindow={isWindow} />
                {showWhereToStart ? (
                    <WhereToStartPage />
                ) : (
                    <FirstRunPage isWindow={isWindow} inputRef={inputRef} />
                )}
                <DialogContainer />
            </SidebarShell>
        );
    }

    {/* "Where should we start?" launcher shown outside the first-run gate:
        reopened via "Back to starting points" after a launcher follow-up, or
        from the Dev Tools menu. */}
    if (isWhereToStartVisible) {
        return (
            <SidebarShell isWindow={isWindow}>
                <Header isWindow={isWindow} />
                <WhereToStartPage />
                <DialogContainer />
            </SidebarShell>
        );
    }

    const handleCloseThreadList = () => {
        setIsThreadListView(false);
    };

    // First-run threads use a follow-up-specific composer placeholder.
    const isFirstRunThread = runs.some(
        (r) => isFirstRunOrigin(r.user_prompt?.origin),
    );
    const inputPlaceholder = isFirstRunThread ? t('Ask a follow-up question') : undefined;

    {/* Main page */}
    return (
        <SidebarShell isWindow={isWindow}>
            <ScreenReaderRunAnnouncer inputRef={inputRef} surface={isWindow ? 'window' : 'sidebar'} />

            {/* Header */}
            <Header isWindow={isWindow} outlineButtonRef={outlineButtonRef} />

            {/* Content area - relative container for overlay positioning */}
            <div className="flex-1 min-h-0 display-flex flex-col relative overflow-hidden">
                {/* Thread view with agent runs, and the question rail beside it */}
                {isThreadView ? (
                    <ConversationView containerRef={messagesContainerRef} isWindow={isWindow}>
                        <ThreadView ref={messagesContainerRef} isWindow={isWindow} />
                    </ConversationView>
                ) : (
                    <HomePage isWindow={isWindow} inputRef={inputRef} />
                )}

                {/* Prompt area (footer) - only in thread view */}
                {isThreadView && (
                    <div id="alphainz-prompt" className="flex-none px-3 pb-3 relative">
                        <PopupOverlayContainer />
                        <ScrollDownButton onClick={handleScrollToBottom} isWindow={isWindow} />
                        {composerTakeover.kind === 'batch-approval' ? (
                            // key resets local decision state per approval request
                            <BatchApprovalPanel
                                key={composerTakeover.approval.approvalId}
                                approval={composerTakeover.approval}
                            />
                        ) : composerTakeover.kind === 'credit-confirmation' ? (
                            // key resets local decision state per confirmation
                            <CreditConfirmationPanel
                                key={composerTakeover.confirmation.confirmationId}
                                confirmation={composerTakeover.confirmation}
                            />
                        ) : composerTakeover.kind === 'question' ? (
                            // key resets local answer state per question request
                            <AskUserQuestionPanel
                                key={composerTakeover.question.questionId}
                                pendingQuestion={composerTakeover.question}
                            />
                        ) : (
                            <DragDropWrapper>
                                <InputArea inputRef={inputRef} placeholder={inputPlaceholder} />
                            </DragDropWrapper>
                        )}
                    </div>
                )}

                {/* Conversation outline, opened from the header button */}
                {isThreadView && (
                    <ConversationOutline
                        isWindow={isWindow}
                        containerRef={messagesContainerRef}
                        buttonRef={outlineButtonRef}
                    />
                )}

                {/* Thread list overlay */}
                {isThreadListView && (
                    <div className="thread-overlay-container">
                        <div className="thread-overlay-backdrop" onClick={handleCloseThreadList} />
                        <div className="thread-overlay-panel">
                            <ThreadListView isWindow={isWindow} />
                        </div>
                    </div>
                )}
            </div>

            {/* Credit info bar - always visible at bottom */}
            {creditInfoWarning && (
                <div className="flex-none px-2 pb-1 -mt-3">
                    <CreditInfoBar warning={creditInfoWarning} />
                </div>
            )}

            {/* Dialog Container */}
            <DialogContainer />
        </SidebarShell>
    );
};

export default Sidebar;
