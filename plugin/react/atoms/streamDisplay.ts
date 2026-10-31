/**
 * How much of the run's working steps the transcript shows.
 *
 * A colour-coding run is sixty tool calls and a dozen short sentences of the
 * model narrating itself between them. Rendering all of it inline buries the
 * answer, and folding only the tool calls did not help: the narration and the
 * thinking rows stayed behind as a ladder of one-line fragments that read
 * worse than the wall they replaced.
 *
 * So the fold takes the whole working stretch — thinking, the sentences the
 * model writes on its way to a tool call, and the calls themselves — and this
 * preference says what happens to it:
 *
 *   expanded   show it inline, the way it was before any of this
 *   collapsed  one disclosure line, closed (the default)
 *   answer     everything while it works, then nothing but the answer
 *
 * One thing is exempt at every setting: a step waiting on the user. Apply and
 * Reject live in that row, so hiding it would hide a decision the run is
 * blocked on — a "hidden" that silently swallowed approvals would be a way to
 * lose work, not a display preference.
 */

import { atom } from 'jotai';

import { getPref, setPref } from '../../src/utils/prefs';

export type StreamDisplayMode = 'expanded' | 'collapsed' | 'answer';

export const STREAM_DISPLAY_MODES: StreamDisplayMode[] = ['expanded', 'collapsed', 'answer'];

export const STREAM_DISPLAY_LABELS: Record<StreamDisplayMode, string> = {
    expanded: 'Show all steps',
    collapsed: 'Collapse steps',
    answer: 'Answer only',
};

export const STREAM_DISPLAY_HINTS: Record<StreamDisplayMode, string> = {
    expanded: 'Thinking and tool calls inline',
    collapsed: 'One line you can open',
    answer: 'Everything while it works, then just the answer',
};

/**
 * `hidden` was this mode's name before it had a description worth reading.
 *
 * Renaming the value would have silently reset the preference of anyone who
 * had already chosen it, so the old spelling still resolves.
 */
const LEGACY_MODE_NAMES: Record<string, StreamDisplayMode> = { hidden: 'answer' };

export function readStreamDisplayPref(): StreamDisplayMode {
    const raw = getPref('streamDisplay');
    if (STREAM_DISPLAY_MODES.includes(raw as StreamDisplayMode)) return raw as StreamDisplayMode;
    return LEGACY_MODE_NAMES[String(raw)] ?? 'collapsed';
}

/**
 * Mirrors the pref rather than owning the value.
 *
 * The pref is the source of truth so the choice survives a restart, but a
 * pref read is not reactive — nothing re-renders when it changes. The atom
 * holds the last known value so the transcript re-renders on the same tick the
 * user picks a mode, and writes through so the next launch agrees.
 */
const modeOverrideAtom = atom<StreamDisplayMode | null>(null);

export const streamDisplayModeAtom = atom(
    (get) => get(modeOverrideAtom) ?? readStreamDisplayPref(),
    (_get, set, mode: StreamDisplayMode) => {
        setPref('streamDisplay', mode);
        set(modeOverrideAtom, mode);
    },
);
