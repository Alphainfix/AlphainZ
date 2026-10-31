import { useSetAtom } from 'jotai';
import { store } from '../store';
import { isBeaverWindowOpenAtom, isSidebarVisibleAtom } from '../atoms/ui';
import { useEventSubscription } from './useEventSubscription';
import { uiManager } from '../ui/UIManager';
import { getPref } from '../../src/utils/prefs';
import { removePopupMessagesByTypeAtom } from '../atoms/ui';
import {
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
    updateMessageItemsFromZoteroSelectionAtom,
} from '../atoms/messageComposition';
import { logger } from '@beaver/agent-core/platform/logger';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';
import { eventManager } from '../events/eventManager';
import { openBeaverWindow } from '../../src/ui/openBeaverWindow';

/**
 * Whether the composer holds a message the user is still writing.
 *
 * The papers staged for it belong to that message, so opening the panel must
 * not trade them for a fresh start or for whatever is selected in Zotero.
 */
function composerHoldsDraft(): boolean {
    return store.get(currentMessageContentAtom).trim() !== ''
        || store.get(currentMessagePillsAtom).length > 0;
}

/**
 * Show the chat for a question asked from the reader.
 *
 * A user who keeps AlphainZ in its separate window, so the paper gets the full
 * width, is working there: opening the main window's pane as well would squeeze
 * the paper and put the conversation in two places. That window is brought
 * forward instead. Otherwise the pane opens, without staging the Zotero
 * selection — the question brings its own context.
 */
export function revealChatForReaderQuestion(): void {
    if (store.get(isBeaverWindowOpenAtom) && !store.get(isSidebarVisibleAtom)) {
        try {
            openBeaverWindow();
            return;
        } catch (error) {
            logger(`revealChatForReaderQuestion: could not focus the separate window: ${error}`, 1);
        }
    }
    eventManager.dispatch('toggleChat', { forceOpen: true, skipAutoPopulate: true });
}

/**
 * Get the composer ready for a panel that has just opened: a fresh start, with
 * the Zotero selection staged when the preference asks for it — unless the
 * composer holds a message still being written, which keeps what was staged
 * for it.
 */
export function prepareComposerForOpenedPanel(options: { skipAutoPopulate?: boolean; isLibraryTab: boolean }): void {
    if (composerHoldsDraft()) return;
    store.set(currentMessageItemsAtom, []);
    store.set(removePopupMessagesByTypeAtom, ['items_summary']);
    if (options.skipAutoPopulate) return;
    /*
     * No profile gate.
     *
     * This waited on `isProfileLoadedAtom`, which the hosted build set once the
     * account's library-access boundary had arrived. Nothing sets it here — it
     * is only ever set to false — so "Add Selected Items When Opening" did
     * nothing at all, however the switch was set. The boundary it was waiting
     * for is a local preference now, known immediately.
     */
    const addSelectedItemsOnOpen = getPref('addSelectedItemsOnOpen');
    if (addSelectedItemsOnOpen && options.isLibraryTab) {
        const maxAddAttachmentToMessage = getPref('maxAddAttachmentToMessage');
        void store.set(updateMessageItemsFromZoteroSelectionAtom, maxAddAttachmentToMessage);
    }
}

export function useToggleSidebar() {
    const setSidebarVisible = useSetAtom(isSidebarVisibleAtom);

    useEventSubscription('toggleChat', (detail) => {
        // Update atoms
        setSidebarVisible((prev) => {
            const currentlyOpen = prev;
            const newIsVisible = detail?.forceOpen ? true : !currentlyOpen;

            // Already in the desired state — no-op
            if (newIsVisible === currentlyOpen) return prev;
            const isLibraryTab = Zotero.getMainWindow().Zotero_Tabs.selectedType === 'library';

            logger(`useToggleSidebar: toggleChat event received - currently open: ${currentlyOpen}, will be: ${newIsVisible}, location: ${isLibraryTab ? 'library' : 'reader'}`);

            // If closing, dismiss any active diff preview
            if (currentlyOpen && !newIsVisible) {
                dismissDiffPreview();
            }

            // If just opened, initialize
            if (!currentlyOpen) {
                prepareComposerForOpenedPanel({ skipAutoPopulate: detail?.skipAutoPopulate, isLibraryTab });
            }

            // Update UI through UIManager
            uiManager.updateUI({
                isVisible: newIsVisible,
                isLibraryTab,
                collapseState: {
                    library: null,
                    reader: null
                }
            });

            // Announce the state change to screen readers, and when closing
            // move focus to the toolbar button so it isn't lost on the now
            // hidden sidebar content.
            uiManager.announceSidebarState(newIsVisible);
            if (!newIsVisible) {
                uiManager.focusToggleButton();
            }

            return newIsVisible;
        });
    });
}
