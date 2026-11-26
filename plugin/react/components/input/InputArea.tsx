import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { StopIcon, GlobalSearchIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue, useStore } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessagePillsAtom, pendingPillInsertsAtom, composerResetTokenAtom, pendingAttachmentTokensAtom } from '../../atoms/messageComposition';
import { sendWSMessageAtom, isWSChatPendingAtom, closeWSConnectionAtom } from '../../atoms/agentRunAtoms';
import { pendingApprovalsByLocationAtom } from '../../agents/agentActions';
import Button from '@beaver/agent-ui/primitives/Button';
import SearchMenu from '@beaver/agent-ui/primitives/SearchMenu';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import RunUsageChip from './RunUsageChip';
import { logger } from '@beaver/agent-core/platform/logger';
import { isLibraryTabAtom } from '../../atoms/ui';
import { currentNoteItemAtom } from '../../atoms/zoteroContext';
import { selectedModelAtom, isUsingBeaverCreditsAtom } from '../../atoms/models';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import PendingActionsBar from './PendingActionsBar';
import HighTokenUsageWarningBar, { longChatInputTokens } from './HighTokenUsageWarningBar';
import NextStepsPanel from '../pages/firstRun/NextStepsPanel';
import BackToSuggestions, { FirstRunBackTarget } from '../pages/firstRun/BackToSuggestions';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { PromptOrigin } from '@beaver/agent-core/agents/types';
import { firstRunNextStepsDismissedAtom } from '../../atoms/firstRun';
import { dismissHighTokenWarningForThreadAtom, dismissedHighTokenWarningByThreadAtom, backendHighTokenUsageRunsAtom } from '../../atoms/messageUIState';
import { getPref } from '../../../src/utils/prefs';
import { LexicalEditorInput, LexicalEditorInputHandle, SlashCommandDescriptor } from '@beaver/agent-ui/composer/LexicalEditorInput';
import { TextareaComposer } from '@beaver/agent-ui/composer/TextareaComposer';
import { getHost } from '@beaver/agent-ui/host';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { useSlashMenu } from '../../hooks/useSlashMenu';
import { useAddSourcesMenu, AddSourcesMenuHandle } from '@beaver/agent-ui/composer/useAddSourcesMenu';
import { useComposerPasteHandlers } from '../../hooks/useComposerPasteHandlers';
import { useActionPopupResolver } from '../../hooks/useActionPopupResolver';
import { sendComposedMessageAtom } from '../../atoms/actions';
import { t } from '../../../src/utils/i18n';



interface InputAreaProps {
    // Kept for backward-compat with callers that only need `.focus()`.
    // The underlying element is now a contenteditable div managed by Lexical.
    inputRef: React.RefObject<HTMLElement | null>;
    verticalPosition?: 'above' | 'below';
    placeholder?: string;
    hideModelSelector?: boolean;
    hideAttachmentMenu?: boolean;
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef,
    verticalPosition = 'above',
    placeholder,
    hideModelSelector = false,
    hideAttachmentMenu = false,
}) => {
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const [messagePills, setMessagePills] = useAtom(currentMessagePillsAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const isUsingBeaverCredits = useAtomValue(isUsingBeaverCreditsAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [selectionRestoreTick, setSelectionRestoreTick] = useState(0);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const allRuns = useAtomValue(allRunsAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const dismissedHighTokenByThread = useAtomValue(dismissedHighTokenWarningByThreadAtom);
    const dismissHighTokenWarning = useSetAtom(dismissHighTokenWarningForThreadAtom);
    const backendHighTokenUsageRuns = useAtomValue(backendHighTokenUsageRunsAtom);
    const currentNoteItem = useAtomValue(currentNoteItemAtom);
    // Only the oldest staged pill is claimable; the rest follow as it is
    // dequeued (see the claim effect below).
    const pendingPillInsert = useAtomValue(pendingPillInsertsAtom)[0] ?? null;
    const composerResetToken = useAtomValue(composerResetTokenAtom);
    const store = useStore();

    // Turns a paste carrying files or image bytes into message attachments.
    const pasteHandlers = useComposerPasteHandlers();

    // Supplies the /command pill hover cards with the live action definitions.
    const resolveAction = useActionPopupResolver();

    // Imperative handle exposed by the Lexical editor (focus / clear).
    /*
     * The composer engine. The textarea is the default: its caret is the
     * control's own state, immune to the chrome document's selection resets
     * the Lexical engine needed a stack of repair plugins to survive. Lexical
     * stays selectable as the escape hatch (inline pill chips, hover cards).
     */
    const ComposerEngine = getHost().config?.composerEngine?.() === 'lexical'
        ? LexicalEditorInput
        : TextareaComposer;
    const editorHandleRef = useRef<LexicalEditorInputHandle | null>(null);
    const pendingSelectionRestoreRef = useRef<{ offset: number; skipFocus: boolean } | null>(null);
    const focusEditor = useCallback(() => {
        editorHandleRef.current?.focus();
    }, []);
    // The open Add Sources menu, for stepping back out of one of its submenus.
    const addSourcesMenuRef = useRef<AddSourcesMenuHandle | null>(null);
    const deleteTrailingQuery = useCallback((length: number) => {
        editorHandleRef.current?.deleteTrailingQuery(length);
    }, []);
    // Stable forwarder so the slash menu can insert a command pill into the
    // Lexical editor (the editor handle isn't available until after mount).
    const insertSlashCommand = useCallback((descriptor: SlashCommandDescriptor, queryLength: number | null) => {
        editorHandleRef.current?.insertSlashCommand(descriptor, queryLength);
    }, []);

    // A programmatic composer reset (new thread, thread switch, send) can write
    // the same empty value the editor already published, which its value sync
    // cannot see. Tell the editor explicitly, so text it is withholding for an
    // IME composition is dropped instead of resurfacing in the new context.
    useEffect(() => {
        editorHandleRef.current?.discardPendingText();
    }, [composerResetToken]);

    // WebSocket state
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const sendComposedMessage = useSetAtom(sendComposedMessageAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);

    // A file staged for THIS composition is still being attached, so sending is
    // held until it lands. Work left over from a composition the user has since
    // replaced does not hold. Excludes the pending case, where the button is
    // "Stop" and must stay live.
    const pendingAttachmentTokens = useAtomValue(pendingAttachmentTokensAtom);
    const isAttachingFiles = pendingAttachmentTokens.includes(composerResetToken) && !isPending;

    /*
     * Proposals waiting for a decision never lock the composer.
     *
     * A proposed change does not hold its run: the call returns at once, the
     * run carries on or ends, and the card waits for the user for as long as
     * they like — across later messages and in other conversations. So the
     * user can always type, attach, change the model and send; deciding is
     * done on the cards, or from the bar above this one, never by the send
     * button. Only this conversation's proposals make the first-run panels
     * below give way to that bar.
     *
     * While ask_user_question waits, Sidebar renders AskUserQuestionPanel
     * instead of this component, so no question-mode handling is needed here.
     */
    const hasApprovalsHere = useAtomValue(pendingApprovalsByLocationAtom).here.length > 0;

    const lastRun = allRuns.length > 0 ? allRuns[allRuns.length - 1] : null;
    const lastRunUsage = lastRun?.total_usage;
    // The warning bar's own measure of a long chat, so it is mounted only when
    // it will show something.
    const longChatTokens = longChatInputTokens(lastRunUsage);
    const warningThreadId = lastRun?.thread_id ?? currentThreadId;
    const isHighTokenDismissed = warningThreadId ? dismissedHighTokenByThread[warningThreadId] : false;
    const showHighTokenUsageWarningMessage = getPref('showHighTokenUsageWarningMessage');
    const threadHasHighTokenUsage = allRuns.some(r => backendHighTokenUsageRuns[r.id])
        || longChatTokens !== null;
    const shouldShowHighTokenWarning = Boolean(
        showHighTokenUsageWarningMessage &&
        !hasApprovalsHere &&
        warningThreadId &&
        threadHasHighTokenUsage &&
        !isHighTokenDismissed
    );

    // First-run next steps — driven by persisted origin on the last run, with
    // session-only dismissal tracked in a Set atom. Mirrors the predicates
    // previously used in AgentRunView.
    const nextStepsDismissedRunIds = useAtomValue(firstRunNextStepsDismissedAtom);
    const setNextStepsDismissedRunIds = useSetAtom(firstRunNextStepsDismissedAtom);
    const lastRunId = lastRun?.id;
    const handleDismissNextSteps = useCallback(() => {
        if (!lastRunId) return;
        setNextStepsDismissedRunIds((prev) => {
            if (prev.has(lastRunId)) return prev;
            const next = new Set(prev);
            next.add(lastRunId);
            return next;
        });
    }, [setNextStepsDismissedRunIds, lastRunId]);
    // Guided next steps surface after a suggestion-card run or a "Where should
    // we start?" launcher run — both carry the context NextStepsPanel needs.
    const lastRunOriginKind = lastRun?.user_prompt.origin?.kind;
    const showNextSteps = Boolean(
        !hasApprovalsHere &&
        lastRun &&
        (lastRunOriginKind === 'first_run_card' || lastRunOriginKind === 'where_to_start') &&
        lastRun.status === 'completed' &&
        !nextStepsDismissedRunIds.has(lastRun.id)
    );
    const showBackToSuggestions = Boolean(
        !hasApprovalsHere &&
        lastRun &&
        lastRun.user_prompt.origin?.kind === 'first_run_followup' &&
        lastRun.status === 'completed' &&
        !nextStepsDismissedRunIds.has(lastRun.id)
    );
    // The follow-up run's origin
    const firstRunBackTarget: FirstRunBackTarget = allRuns.some(
        (r) => r.user_prompt?.origin?.kind === 'where_to_start',
    ) ? 'launcher' : 'suggestions';

    // Mutual exclusion: NextSteps/BackToSuggestions take precedence over the
    // high-token warning bar.
    const firstRunPanelVisible = showNextSteps || showBackToSuggestions;
    const showHighTokenWarningBar = shouldShowHighTokenWarning && !firstRunPanelVisible;
    const canRenderHighTokenWarningBar = showHighTokenWarningBar && longChatTokens !== null;

    const {
        isSlashMenuOpen,
        slashMenuPosition,
        slashSearchQuery,
        setSlashSearchQuery,
        slashMenuItems,
        handleSlashDismiss,
        handleSlashMenuChange,
        handleSlashTrigger,
        handleSlashMenuKeyDown,
    } = useSlashMenu(inputRef, verticalPosition, focusEditor, insertSlashCommand);

    // A `@` typed in the editor drives the Add Sources menu the same way: the
    // caret never leaves the editor and the text after the `@` is the menu's
    // search query. Opened from the "+" button, the menu brings its own
    // focused search field instead and the composer is left alone.
    const {
        isOpen: isAddSourcesMenuOpen,
        position: addSourcesMenuPosition,
        query: addSourcesSearchQuery,
        querySource: addSourcesQuerySource,
        setQuery: setAddSourcesSearchQuery,
        openFromButton: openAddSourcesMenu,
        handleTrigger: handleAddSourcesTrigger,
        handleChange: handleAddSourcesChange,
        handleKeyDown: handleAddSourcesKeyDown,
        dismiss: dismissAddSourcesMenu,
        commit: commitAddSourcesMenu,
        resetQuery: resetAddSourcesQuery,
    } = useAddSourcesMenu({
        verticalPosition,
        deleteTrailingQuery,
        focusEditor,
        setMessageContent,
        menuRef: addSourcesMenuRef,
    });

    useEffect(() => {
        if (isPending && getPref('focusResponseForScreenReaders')) {
            return;
        }
        // Focus on mount via the Lexical handle.
        focusEditor();
    }, []);

    // Consume a staged /command pill (home launcher, context menu, reader
    // toolbar). This component owns the editor handle, so the pill is inserted
    // here; running on mount as well covers the sidebar-just-opened case.
    // The user submits the message themselves (no auto-send).
    //
    // Multiple InputAreas can be mounted at once (main-window sidebar + the
    // separate Beaver window), all subscribed to the same atom. Consumption is
    // therefore a CLAIM: the editor in the payload's `targetWindow` (where the
    // user triggered the action) claims immediately; other editors act only as
    // a delayed fallback in case the target never consumes (e.g. its editor is
    // not mounted). The synchronous re-check + dequeue of the live atom value
    // guarantees exactly one editor inserts the pill.
    //
    // Only the head of the queue is claimed; dequeuing it re-runs this effect
    // for the next entry, so pills staged in quick succession are all inserted,
    // in the order they were staged.
    useEffect(() => {
        const descriptor = pendingPillInsert?.descriptor;
        if (!descriptor) return;
        const claim = () => {
            const queue = store.get(pendingPillInsertsAtom);
            // Another editor may have claimed this pill already.
            if (queue[0] !== pendingPillInsert) return;
            store.set(pendingPillInsertsAtom, queue.slice(1));
            editorHandleRef.current?.insertSlashCommand(descriptor, null);
            focusEditor();
        };
        const ownWindow = inputRef.current?.ownerDocument.defaultView ?? null;
        const isTarget = pendingPillInsert.targetWindow
            ? pendingPillInsert.targetWindow === ownWindow
            : (inputRef.current?.ownerDocument.hasFocus() ?? false);
        const timer = setTimeout(claim, isTarget ? 0 : 150);
        return () => clearTimeout(timer);
    }, [focusEditor, inputRef, pendingPillInsert, store]);

    const queueSelectionRestore = useCallback((offset: number, skipFocus: boolean) => {
        pendingSelectionRestoreRef.current = { offset, skipFocus };
        setSelectionRestoreTick((tick) => tick + 1);
    }, []);

    useEffect(() => {
        const pendingRestore = pendingSelectionRestoreRef.current;
        if (!pendingRestore) return;
        pendingSelectionRestoreRef.current = null;
        const win = inputRef.current?.ownerDocument.defaultView;
        const timer = win?.setTimeout(() => {
            editorHandleRef.current?.selectRange(
                pendingRestore.offset,
                pendingRestore.offset,
                { skipFocus: pendingRestore.skipFocus },
            );
        }, 0);
        return () => {
            if (timer !== undefined) win?.clearTimeout(timer);
        };
    }, [inputRef, selectionRestoreTick]);

    const handleEditorChange = useCallback((value: string) => {
        // The open Add Sources menu owns every keystroke until it closes, so a
        // `/` typed into its query is a search term, not an actions trigger.
        if (handleAddSourcesChange(value)) {
            queueSelectionRestore(value.length, false);
            return;
        }

        if (handleSlashMenuChange(value)) {
            queueSelectionRestore(value.length, false);
            return;
        }

        const inputEl = inputRef.current;
        if (inputEl && handleSlashTrigger(value, inputEl.getBoundingClientRect())) {
            queueSelectionRestore(value.length, false);
            return;
        }

        if (
            inputEl &&
            !hideAttachmentMenu &&
            handleAddSourcesTrigger(value, inputEl.getBoundingClientRect())
        ) {
            queueSelectionRestore(value.length, false);
            return;
        }

        setMessageContent(value);
    }, [
        handleAddSourcesChange,
        handleAddSourcesTrigger,
        handleSlashMenuChange,
        handleSlashTrigger,
        hideAttachmentMenu,
        inputRef,
        queueSelectionRestore,
        setMessageContent,
    ]);

    const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        // Keys owned by an active IME composition must not drive menus or
        // shortcuts (and must not be preventDefault'ed away from the IME).
        if (isImeKeyEvent(e.nativeEvent)) return;
        if (handleAddSourcesKeyDown(e)) return;
        if (handleSlashMenuKeyDown(e)) return;
        if ((e.key === 'n' || e.key === 'N') && ((Zotero.isMac && e.metaKey) || (!Zotero.isMac && e.ctrlKey))) {
            e.preventDefault();
            newThread();
        }
    }, [handleAddSourcesKeyDown, handleSlashMenuKeyDown, newThread]);

    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>
    ) => {
        e.preventDefault();
        // Guard against double submission
        if (isPending) {
            logger('handleSubmit: Blocked - request already in progress');
            return;
        }
        if (isAttachingFiles) return;
        sendMessage(messageContent);
    };

    const sendMessage = (composedMessage: string) => {
        // Text typed with an input method reaches `messageContent` one
        // composition at a time, and the last one lands shortly after the user
        // commits it. Publish anything still withheld so a send that follows
        // the commit immediately carries the committed text instead of the
        // state before it (see flushPendingText).
        const message = editorHandleRef.current?.flushPendingText() ?? composedMessage;
        if (isPending || message.length === 0) return;
        // If the message contains /command pills, resolve each back to its
        // action's prompt (and attach its items/collection) before sending.
        const pills = editorHandleRef.current?.getSlashCommands() ?? [];
        if (pills.length > 0) {
            logger(`Sending composed message with ${pills.length} action pill(s)`);
            sendComposedMessage({ baseText: message, pills });
            return;
        }
        logger(`Sending message: ${message}`);
        sendWSMessage(message);
    };

    const handleStop = (e?: React.MouseEvent) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        logger('Stopping chat completion');
        // Stops the run; the changes it proposed stay on their cards, pending.
        closeWSConnection();
    };

    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check if the click target is a button or within a button
        const target = e.target as Element;
        const isButtonClick = target.closest('button') !== null;
        const isEditorClick = target.closest('.alphainz-lexical-content') !== null;

        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick && !isEditorClick) {
            focusEditor();
        }
    };

    // Handle the editor's submit signal (Enter without Shift).
    const handleEditorSubmit = useCallback(() => {
        if (isPending) {
            logger('handleEditorSubmit: Blocked - request already in progress');
            return;
        }
        if (isSlashMenuOpen) return;
        // Enter belongs to the open Add Sources menu (it picks the focused row).
        if (isAddSourcesMenuOpen) return;
        if (isAttachingFiles) return;
        sendMessage(messageContent);
    }, [isPending, isSlashMenuOpen, isAddSourcesMenuOpen, isAttachingFiles, messageContent]);

    const handleDismissHighTokenWarning = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!warningThreadId) return;
        dismissHighTokenWarning(warningThreadId);
    };


    const getPlaceholderText = () => {
        if (placeholder !== undefined) return placeholder;
        if (isLibraryTab) return t("@ to add a source, / for actions");
        if (currentNoteItem) return t("@ to add a source, / for actions");
        return t("@ to add a source, / for actions, drag to add annotations");
    }

    const menuPortalContainer = inputRef.current?.closest('[id^="alphainz-react-root-"], #alphainz-pane-window') as HTMLElement | null;

    return (
        <div
            className="user-message-display"
            onClick={handleContainerClick}
            style={{ minHeight: 'fit-content' }}
        >
            {/* Proposals waiting for a decision: this chat's, and a pointer to other chats' */}
            <PendingActionsBar />
            {canRenderHighTokenWarningBar && (
                <HighTokenUsageWarningBar
                    onNewThread={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        newThread();
                    }}
                    onDismiss={handleDismissHighTokenWarning}
                    isUsingBeaverCredits={isUsingBeaverCredits}
                />
            )}

            {/* First-run "Next steps" panel — shown after a run that originated
                from a first-run suggestion card. Auto-dismisses on type. */}
            {showNextSteps && lastRun && (
                <NextStepsPanel
                    origin={lastRun.user_prompt.origin as Extract<PromptOrigin, { kind: 'first_run_card' | 'where_to_start' }>}
                    onDismiss={handleDismissNextSteps}
                />
            )}

            {/* After a first-run follow-up run, offer a path back to the
                originating surface (suggestion grid or launcher). */}
            {showBackToSuggestions && (
                <div className="next-steps-panel px-3 py-2">
                    <BackToSuggestions onDismiss={handleDismissNextSteps} backTarget={firstRunBackTarget} />
                </div>
            )}

            {/* Message attachments */}
            {!hideAttachmentMenu && (
                <MessageAttachmentDisplay
                    isAddAttachmentMenuOpen={isAddSourcesMenuOpen}
                    menuPosition={addSourcesMenuPosition}
                    addSourcesSearchQuery={addSourcesSearchQuery}
                    addSourcesQuerySource={addSourcesQuerySource}
                    onAddSourcesQueryChange={setAddSourcesSearchQuery}
                    onOpenAddSourcesMenu={openAddSourcesMenu}
                    onDismissAddSourcesMenu={dismissAddSourcesMenu}
                    onCommitAddSourcesMenu={commitAddSourcesMenu}
                    onResetAddSourcesQuery={resetAddSourcesQuery}
                    addSourcesMenuRef={addSourcesMenuRef}
                    menuPortalContainer={menuPortalContainer}
                    verticalPosition={verticalPosition}
                />
            )}

            <SearchMenu
                menuItems={slashMenuItems}
                isOpen={isSlashMenuOpen}
                onClose={handleSlashDismiss}
                position={slashMenuPosition}
                verticalPosition={verticalPosition}
                useFixedPosition={true}
                width="250px"
                searchQuery={slashSearchQuery}
                setSearchQuery={setSlashSearchQuery}
                onSearch={() => {}}
                noResultsText={t('No actions found')}
                placeholder={t('Search actions...')}
                closeOnSelect={false}
                showSearchInput={false}
                selectOnTab={true}
                portalContainer={menuPortalContainer}
                groupHeaderClassName="font-color-primary opacity-70"
            />

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="display-flex flex-col">
                {/* Message Input - Lexical-backed rich input with inline pills */}
                <div className="mb-2 -ml-1">
                    <ComposerEngine
                        ref={editorHandleRef}
                        value={messageContent}
                        onChange={handleEditorChange}
                        pills={messagePills}
                        onPillsChange={setMessagePills}
                        onSubmit={handleEditorSubmit}
                        pasteHandlers={pasteHandlers}
                        resolveAction={resolveAction}
                        // Nothing else tells the user that what they type after
                        // the `@` searches — that menu has no input of its own.
                        // Drops away the moment they start typing.
                        inlineHint={
                            isAddSourcesMenuOpen &&
                            addSourcesQuerySource === 'editor' &&
                            addSourcesSearchQuery.length === 0
                                ? t('Type to search')
                                : null
                        }
                        placeholder={getPlaceholderText()}
                        ariaLabel={t('Message AlphainZ')}
                        onKeyDown={handleEditorKeyDown}
                        suspendKeyboardNavigation={isSlashMenuOpen || isAddSourcesMenuOpen}
                        onContentEditableRef={(el) => {
                            // Forward the Lexical content-editable element to the
                            // parent's inputRef so legacy `.focus()` callers work.
                            (inputRef as React.MutableRefObject<HTMLElement | null>).current = el;
                        }}
                    />
                </div>

                {/* Button Row */}
                <div className="composer-controls display-flex flex-row items-center pt-2 min-w-0">
                    {!hideModelSelector && (
                        <ModelSelectionButton inputRef={inputRef} focusInput={focusEditor} />
                    )}
                    {/* Between the model and the send buttons, where what a run
                        will cost belongs: next to the choice that determines it. */}
                    <RunUsageChip />
                    <div className="flex-1 min-w-0" />
                    <div className="display-flex flex-row items-center gap-4">
                        {/*
                          * A web-search toggle used to sit here, permanently
                          * disabled: it gated a flag sent to Beaver's backend and
                          * required credits. Locally the literature tool is always
                          * registered, so the agent searches whenever the question
                          * calls for it — there is nothing to switch on, and a
                          * greyed-out button implied a capability that was missing
                          * when it was in fact always present.
                          */}
                        {/* Stop while a run is live, Send otherwise — never anything
                            else: proposals are decided on their cards, and a draft
                            is only ever cleared by sending it. */}
                        <Button
                            rightIcon={isPending ? StopIcon : undefined}
                            ariaLabel={isPending ? t('Stop generating') : t('Send message')}
                            type="button"
                            variant={isPending ? 'surface' : 'solid'}
                            style={{ padding: '2px 5px' }}
                            onClick={isPending ? (e) => handleStop(e as any) : handleSubmit}
                            disabled={
                                // Stop is always live; Send needs something to send and a model.
                                !isPending
                                && (messageContent.length === 0 || !selectedModel || isSlashMenuOpen || isAttachingFiles)
                            }
                        >
                            {isPending
                                ? t('Stop')
                                : (<span>{t('Send')}{' '}<span className="opacity-50">⏎</span></span>)
                            }
                        </Button>
                    </div>
                </div>
            </form>
        </div>
    );
};

export default InputArea;
