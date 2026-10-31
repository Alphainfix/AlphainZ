/**
 * State for finding your way around a conversation: the question rail at the
 * right edge of the thread, and the outline the header button opens.
 *
 * Where the reader is in the conversation is deliberately not here. It changes
 * as the view scrolls, so the rail and the outline each track it themselves
 * (`useCurrentTurnIndex`) — anything subscribed to an atom holding it would
 * re-render on every scroll.
 */
import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import pkg from '../../package.json';
import { getPref, setPref } from '../../src/utils/prefs';
import { buildConversationTurns, sameTurns } from '../utils/conversationTurns';
import { isThreadListViewAtom } from './ui';

const PREFS_PREFIX = pkg.config.prefsPrefix;

/** Whether the question rail is on; it is unless the user turned it off. */
export function readConversationRailPref(): boolean {
    return getPref('conversationRail') !== false;
}

const conversationRailBaseAtom = atom<boolean>(readConversationRailPref());

/*
 * The preference is the source of truth and can change from outside the pane:
 * the settings window, or settings sync landing on this computer. While
 * anything shows the rail, an observer keeps this copy in step, so turning it
 * off takes the rail away (and brings the scroll bar back) at once.
 */
conversationRailBaseAtom.onMount = (set) => {
    set(readConversationRailPref());
    const symbol = Zotero.Prefs.registerObserver(
        `${PREFS_PREFIX}.conversationRail`,
        () => set(readConversationRailPref()),
        true,
    );
    return () => Zotero.Prefs.unregisterObserver(symbol);
};

/** The question rail's on/off setting. Writing it writes the preference. */
export const conversationRailAtom = atom(
    (get) => get(conversationRailBaseAtom),
    (_get, set, on: boolean) => {
        setPref('conversationRail', on);
        set(conversationRailBaseAtom, on);
    },
);

/*
 * Open or closed, per surface: the sidebar and the separate window share one
 * store but each has its own outline, as each has its own scroll state.
 */
export const conversationOutlineOpenAtom = atom(false);
export const windowConversationOutlineOpenAtom = atom(false);

export function outlineOpenAtomFor(isWindow: boolean) {
    return isWindow ? windowConversationOutlineOpenAtom : conversationOutlineOpenAtom;
}

/** The outline's element id, which its button names in `aria-controls`. */
export function outlineElementId(isWindow: boolean): string {
    return isWindow ? 'alphainz-conversation-outline-window' : 'alphainz-conversation-outline';
}

/** Open the outline if it is closed and close it if it is open. Opening it closes the chat history. */
export const toggleConversationOutlineAtom = atom(null, (get, set, isWindow: boolean) => {
    const openAtom = outlineOpenAtomFor(isWindow);
    const open = !get(openAtom);
    if (open) set(isThreadListViewAtom, false);
    set(openAtom, open);
});

/**
 * The conversation's questions. Recomputed whenever the runs change — on every
 * streamed token — but only a change in what a mark or a row shows reaches
 * its subscribers; see `sameTurns`.
 */
export const conversationTurnsAtom = selectAtom(
    allRunsAtom,
    (runs) => buildConversationTurns(runs),
    sameTurns,
);

export const conversationTurnCountAtom = atom((get) => get(conversationTurnsAtom).length);
