/**
 * Bringing a question up to read, for this plugin's thread view: the shared
 * navigation (@beaver/agent-ui/conversation/navigation) with the scroll state
 * kept in this plugin's atoms.
 */
import type { WritableAtom } from 'jotai';
import { store } from '../store';
import { jumpToRun as jumpToRunShared } from '@beaver/agent-ui/conversation/navigation';

export {
    FLASH_ATTRIBUTE,
    FLASH_MS,
    JUMP_LOCK_MS,
    endWheelTurn,
    flashQuestion,
    isConversationJumpLocked,
    prefersReducedMotion,
    readingTopOf,
    scrollByWheel,
} from '@beaver/agent-ui/conversation/navigation';

/**
 * Bring a question's request to the top of the thread view and mark it (see
 * the shared `jumpToRun`). The scrolled atom is set to where the scroll will
 * end before it starts, so nothing that reads it pulls the view elsewhere.
 *
 * @returns false when the question is not in this thread view
 */
export function jumpToRun(
    container: HTMLElement,
    runId: string,
    scrolledAtom: WritableAtom<boolean, [boolean], void>,
    options: { flash?: boolean } = {},
): boolean {
    return jumpToRunShared(container, runId, (scrolledAway) => store.set(scrolledAtom, scrolledAway), options);
}
