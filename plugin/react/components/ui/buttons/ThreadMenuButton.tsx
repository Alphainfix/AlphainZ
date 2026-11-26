import React, { useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { MoreHorizontalIcon } from '../../icons/icons';
import { copyToClipboard } from '../../../utils/clipboard';
import { renderToMarkdown, preprocessNoteContent } from '../../../utils/citationRenderers';
import { buildThreadNoteHTML } from '../../../utils/threadExport';
import { extractThreadContent, ExtractThreadContentOptions } from '../../../utils/threadContent';
import { resolveToolCallLabelEnrichMap } from '../../../utils/toolCallLabelEnrich';
import { allRunsAtom, toolResultsMapAtom } from '@beaver/agent-core/run-state/atoms';
import { currentThreadIdAtom, currentThreadNameAtom, newThreadAtom, recentThreadsAtom, ThreadData } from '../../../atoms/threads';
import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { getZoteroTargetContextSync } from '../../../../src/utils/zoteroUtils';
import { getSelectedCollection } from '../../../../src/utils/zoteroSelection';
import {
    currentDestination,
    destinationChoices,
    destinationValue,
    type ImportDestination,
} from '../../../atoms/importDestination';
import { selectItem, selectItemById } from '../../../../src/utils/selectItem';
import { store } from '../../../store';
import { prepareCitationRenderContext } from '../../../utils/citationRenderContext';
import { threadService } from '@beaver/agent-core/transport/threadService';
import { localDeleteThread, localRenameThread } from '../../../atoms/loadLocalThreads';
import { isLocalBrain } from '../../../../src/services/llm/agentConfig';
import { clearRecentChatsCache } from '../../RecentChats';
import { clearThreadListCache } from '../../ThreadListView';
import { t } from '../../../../src/utils/i18n';

interface ThreadMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

const ThreadMenuButton: React.FC<ThreadMenuButtonProps> = ({
    className = '',
    ariaLabel = t('Chat actions'),
}) => {
    const [, forceUpdate] = useState({});
    // 'root' or the destination list for "Save chat as note".
    const [view, setView] = useState<'root' | 'note-destination'>('root');

    const handleMenuToggle = useCallback((isOpen: boolean) => {
        if (isOpen) {
            setView('root');
            forceUpdate({});
        }
    }, []);

    const runs = useAtomValue(allRunsAtom);
    const toolResultsMap = useAtomValue(toolResultsMapAtom);
    const citationDataMap = useAtomValue(citationMapAtom);
    const externalReferenceMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);

    const getThreadMeta = () => {
        const threadId = store.get(currentThreadIdAtom);
        const currentName = store.get(currentThreadNameAtom);
        const threads = store.get(recentThreadsAtom);
        const threadName = currentName
            || (threads as ThreadData[]).find(th => th.id === threadId)?.name
            || null;
        return { threadId, threadName };
    };

    /**
     * Tool-call labels need host-resolved library/collection names, which are
     * resolved asynchronously — without them a list_* label falls back to the
     * raw library ref ("u") instead of the library name.
     */
    const getThreadContent = async (overrides?: Partial<ExtractThreadContentOptions>) => {
        const { threadId, threadName } = getThreadMeta();
        const enrichMap = await resolveToolCallLabelEnrichMap(runs, toolResultsMap);
        return extractThreadContent(runs, toolResultsMap, {
            threadId,
            threadName,
            includeRunLinks: true,
            enrichMap,
            ...overrides,
        });
    };

    const handleCopyThread = async () => {
        const content = await getThreadContent();
        const formatted = renderToMarkdown(content);
        await copyToClipboard(formatted);
    };

    /**
     * Save the conversation as a note, in a place the user picked.
     *
     * It used to land in whatever collection Zotero happened to have selected —
     * so a note the user asked for could appear anywhere, with nothing on
     * screen saying where. The destination comes from the same picker the paper
     * import uses; passing null keeps the old behaviour for the callers that
     * have no picker (the child-note path, which has a parent instead).
     */
    const handleSaveAsNote = async (destination: ImportDestination | null) => {
        const content = await getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
        const renderContent = preprocessNoteContent(content);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        const context = getZoteroTargetContextSync();
        const threadId = store.get(currentThreadIdAtom);
        const htmlContent = buildThreadNoteHTML({
            content: renderContent,
            renderContext: renderContextData,
            threadId,
        });

        const newNote = new Zotero.Item('note');
        const libraryId = destination?.libraryId ?? context.targetLibraryId;
        if (libraryId !== undefined) {
            newNote.libraryID = libraryId;
        }
        newNote.setNote(htmlContent);
        await newNote.saveTx();

        const zp = Zotero.getActiveZoteroPane();
        const targetCollection = destination
            ? (destination.collectionKey
                ? Zotero.Collections.getByLibraryAndKey(destination.libraryId, destination.collectionKey)
                : null)
            : getSelectedCollection(zp);
        if (targetCollection) {
            await Zotero.DB.executeTransaction(async () => {
                (targetCollection as any).addItem(newNote.id);
            });
        }

        const win = Zotero.getMainWindow();
        const isInReader = win.Zotero_Tabs?.selectedType === 'reader';
        if (!isInReader) {
            await selectItemById(newNote.id, true, (targetCollection as any)?.id);
        }
    };

    const handleSaveAsChildNote = async () => {
        const content = await getThreadContent({ includeRunLinks: false, userMessageAsBlockquote: true });
        const renderContent = preprocessNoteContent(content);
        const renderContextData = await prepareCitationRenderContext(renderContent, {
            citationDataMap,
            externalMapping: externalReferenceMapping,
            externalReferencesMap,
        });
        const context = getZoteroTargetContextSync();
        if (!context.parentReference) return;

        const threadId = store.get(currentThreadIdAtom);
        const htmlContent = buildThreadNoteHTML({
            content: renderContent,
            renderContext: renderContextData,
            threadId,
        });

        const newNote = new Zotero.Item('note');
        newNote.libraryID = context.parentReference.library_id;
        newNote.parentKey = context.parentReference.zotero_key;
        newNote.setNote(htmlContent);
        await newNote.saveTx();

        const win = Zotero.getMainWindow();
        const isInReader = win.Zotero_Tabs?.selectedType === 'reader';
        if (!isInReader) {
            selectItem(newNote);
        }
    };

    const handleCopyThreadUrl = async () => {
        const threadId = store.get(currentThreadIdAtom);
        if (!threadId) return;
        await copyToClipboard(`zotero://alphainz/thread/${threadId}`);
    };

    const handleRenameChat = async () => {
        const { threadId, threadName } = getThreadMeta();
        if (!threadId) return;

        // Native text-input dialog for renaming (no in-panel edit UI needed here).
        const input = { value: threadName || t('Unnamed conversation') };
        const confirmed = Services.prompt.prompt(
            Zotero.getMainWindow() as any,
            t('Rename chat'),
            t('Enter a new name for this chat:'),
            input,
            null as unknown as string,
            { value: false },
        );
        if (!confirmed) return;

        const newName = input.value.trim();
        if (!newName || newName === threadName) return;

        try {
            // This menu acts on the open conversation. Locally that record is
            // on disk, not on a server, so the REST call renamed nothing.
            if (isLocalBrain()) await localRenameThread(threadId, newName);
            else await threadService.renameThread(threadId, newName);
            // Reflect the new name immediately in the current-thread and recent-thread state
            store.set(currentThreadNameAtom, newName);
            store.set(recentThreadsAtom, (prev: ThreadData[]) =>
                prev.map(th => (th.id === threadId ? { ...th, name: newName } : th)),
            );
            // Invalidate caches so chat lists refetch fresh names
            clearThreadListCache();
            clearRecentChatsCache();
        } catch (error) {
            console.error('Error renaming thread:', error);
        }
    };

    const handleDeleteChat = async () => {
        const threadId = store.get(currentThreadIdAtom);
        if (!threadId) return;

        // It goes to the archive, which is what this says: Delete from the
        // chat history and Delete here are the same action.
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: t('Delete chat?'),
            text: t('This chat moves to the archive. You can restore it from Chat history → Archive.'),
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        try {
            if (isLocalBrain()) await localDeleteThread(threadId);
            else await threadService.deleteThread(threadId);
            // Drop it from the recent-thread list and invalidate caches
            store.set(recentThreadsAtom, (prev: ThreadData[]) => prev.filter(th => th.id !== threadId));
            clearThreadListCache();
            clearRecentChatsCache(threadId);
            // This menu always targets the current thread, so switch to a new chat.
            // The delete was already confirmed above, so skip the active-run confirmation.
            await store.set(newThreadAtom, { skipActiveRunConfirm: true });
        } catch (error) {
            console.error('Error deleting thread:', error);
        }
    };

    const getMenuItems = (): MenuItem[] => {
        const threadId = store.get(currentThreadIdAtom);
        const hasRuns = runs.length > 0;
        const context = getZoteroTargetContextSync();
        const hasParent = context.parentReference !== null;

        if (view === 'note-destination') {
            const here = destinationValue(currentDestination());
            return [
                {
                    label: t('‹ Save chat as note'),
                    isGroupHeader: true,
                    onClick: () => {},
                },
                ...destinationChoices().map((choice) => ({
                    label: choice.label,
                    role: 'menuitemradio' as const,
                    ariaChecked: destinationValue(choice) === here,
                    onClick: () => {
                        void handleSaveAsNote({
                            libraryId: choice.libraryId,
                            collectionKey: choice.collectionKey,
                        });
                    },
                })),
            ];
        }

        const items: MenuItem[] = [
            {
                label: t('Copy entire chat'),
                onClick: handleCopyThread,
                disabled: !hasRuns,
            },
            {
                label: t('Save chat as note…'),
                onClick: () => setView('note-destination'),
                keepOpen: true,
                disabled: !hasRuns,
            },
            {
                label: t('Save chat as child note'),
                onClick: handleSaveAsChildNote,
                disabled: !hasParent || !hasRuns,
            },
            {
                label: t('Copy link to chat'),
                onClick: handleCopyThreadUrl,
                disabled: !threadId,
            },
            {
                label: 'thread-actions-divider',
                onClick: () => {},
                isDivider: true,
            },
            {
                label: t('Rename chat'),
                onClick: handleRenameChat,
                disabled: !threadId,
            },
            {
                label: t('Delete chat'),
                onClick: handleDeleteChat,
                disabled: !threadId,
            },
        ];
        return items;
    };

    return (
        <MenuButton
            icon={MoreHorizontalIcon}
            menuItems={getMenuItems()}
            className={className}
            ariaLabel={ariaLabel}
            variant="ghost"
            toggleCallback={handleMenuToggle}
            tooltipContent={t('Chat actions')}
            showArrow={true}
        />
    );
};

export default ThreadMenuButton;
