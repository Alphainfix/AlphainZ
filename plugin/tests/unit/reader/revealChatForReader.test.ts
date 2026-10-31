/**
 * Showing the chat for a question asked from the reader.
 *
 * A user who keeps AlphainZ in its separate window is working there: the
 * reader's entry points bring that window forward instead of opening the main
 * window's pane beside the paper. And opening the pane, however it happens,
 * leaves the papers staged for a half-written message where they are.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchMock, openWindowMock } = vi.hoisted(() => ({
    dispatchMock: vi.fn(),
    openWindowMock: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/events/eventManager', () => ({
    eventManager: { dispatch: dispatchMock, subscribe: vi.fn(() => () => {}) },
}));
vi.mock('../../../src/ui/openBeaverWindow', () => ({ openBeaverWindow: openWindowMock }));
vi.mock('../../../react/ui/UIManager', () => ({
    uiManager: { updateUI: vi.fn(), announceSidebarState: vi.fn(), focusToggleButton: vi.fn() },
}));

import { store } from '../../../react/store';
import { isBeaverWindowOpenAtom, isSidebarVisibleAtom } from '../../../react/atoms/ui';
import {
    currentMessageContentAtom,
    currentMessageItemsAtom,
    currentMessagePillsAtom,
} from '../../../react/atoms/messageComposition';
import {
    prepareComposerForOpenedPanel,
    revealChatForReaderQuestion,
} from '../../../react/hooks/useToggleSidebar';

const paper = { libraryID: 1, key: 'PAPER001' } as any;

beforeEach(() => {
    vi.clearAllMocks();
    store.set(isBeaverWindowOpenAtom, false);
    store.set(isSidebarVisibleAtom, false);
    store.set(currentMessageContentAtom, '');
    store.set(currentMessagePillsAtom, []);
    store.set(currentMessageItemsAtom, [paper]);
});

describe('showing the chat for a reader question', () => {
    it('brings the separate window forward when that is where the user works', () => {
        store.set(isBeaverWindowOpenAtom, true);
        revealChatForReaderQuestion();
        expect(openWindowMock).toHaveBeenCalledTimes(1);
        expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('opens the pane, without staging the Zotero selection, when there is no separate window', () => {
        revealChatForReaderQuestion();
        expect(openWindowMock).not.toHaveBeenCalled();
        expect(dispatchMock).toHaveBeenCalledWith('toggleChat', { forceOpen: true, skipAutoPopulate: true });
    });

    it('uses the pane when it is already open, even with the separate window up', () => {
        store.set(isBeaverWindowOpenAtom, true);
        store.set(isSidebarVisibleAtom, true);
        revealChatForReaderQuestion();
        expect(openWindowMock).not.toHaveBeenCalled();
        expect(dispatchMock).toHaveBeenCalledWith('toggleChat', { forceOpen: true, skipAutoPopulate: true });
    });
});

describe('the composer when the pane opens', () => {
    it('keeps the papers staged for a message still being written', () => {
        store.set(currentMessageContentAtom, 'compare this with the Tang paper and');
        prepareComposerForOpenedPanel({ skipAutoPopulate: true, isLibraryTab: false });
        expect(store.get(currentMessageItemsAtom)).toEqual([paper]);
    });

    it('keeps them when the draft holds an action pill', () => {
        store.set(currentMessagePillsAtom, [{ id: 'summarize' } as any]);
        prepareComposerForOpenedPanel({ skipAutoPopulate: true, isLibraryTab: false });
        expect(store.get(currentMessageItemsAtom)).toEqual([paper]);
    });

    it('starts afresh when nothing is being written', () => {
        prepareComposerForOpenedPanel({ skipAutoPopulate: true, isLibraryTab: false });
        expect(store.get(currentMessageItemsAtom)).toEqual([]);
    });
});
