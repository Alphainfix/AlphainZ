import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { conversationTurnsAtom } from '../../atoms/conversationNav';
import { userScrolledAtom, windowUserScrolledAtom } from '../../atoms/ui';
import { useCurrentTurnIndex } from '../../hooks/useCurrentTurn';
import { jumpToRun, scrollByWheel } from '../../utils/conversationNavigation';
import { clipText, nearestCentreIndex, turnMeta, type ConversationTurn } from '../../utils/conversationTurns';

interface ConversationRailProps {
    /** The thread view's scroll container. */
    containerRef: React.RefObject<HTMLDivElement>;
    /** Whether this is the separate window, which keeps its own scroll state. */
    isWindow: boolean;
}

/** Space kept between the preview card and the edges of the chat area. */
const CARD_MARGIN = 8;
/** In a chat area shorter than this the card shows two lines of question and of answer. */
const COMPACT_AREA_PX = 260;

/** Whether focus came from the keyboard: a click that focuses a mark is not a reason to show its card. */
function isKeyboardFocus(element: Element): boolean {
    try {
        return element.matches(':focus-visible');
    } catch {
        return true;
    }
}

function markLabel(turn: ConversationTurn): string {
    return `Question ${turn.index + 1}: ${clipText(turn.question, 120)}`;
}

/**
 * The question rail: one short mark per question at the right edge of the
 * conversation, standing in for the thread view's scroll bar.
 *
 * The marks are spaced evenly and centred, and close up when there are many.
 * The question being read has the long accent mark, and it follows the scroll.
 *
 * Pointing anywhere on the rail previews the question whose mark is nearest:
 * the marks' hit areas tile the rail with no gaps, the pointer is tracked on
 * the rail as a whole, and the one card moves and changes in place — so it
 * neither disappears nor flickers while the pointer runs along the rail, and
 * goes only when the pointer leaves. Keyboard focus on a mark (Tab lands on the
 * current question, the arrow keys move between marks) shows that mark's card.
 * A click or Enter jumps to the question.
 *
 * Memoised: its parent re-renders on every streamed token, and nothing the
 * rail draws changes with one (see `conversationTurnsAtom`).
 */
export const ConversationRail = React.memo(function ConversationRail({ containerRef, isWindow }: ConversationRailProps) {
    const turns = useAtomValue(conversationTurnsAtom);
    const runIds = useMemo(() => turns.map((turn) => turn.runId), [turns]);
    const current = useCurrentTurnIndex(containerRef, runIds);
    const count = turns.length;
    const cardId = useId();

    const marksRef = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);

    // The mark nearest the pointer while the pointer is on the rail.
    const [hovered, setHovered] = useState<number | null>(null);
    const hoveredRef = useRef<number | null>(null);
    // The mark with keyboard focus.
    const [focused, setFocused] = useState<number | null>(null);
    // The mark the card last showed, so the card keeps its text while it fades out.
    const [lastShown, setLastShown] = useState<number | null>(null);
    // A mark whose card was put away (clicked, or Escape) until another mark is chosen.
    const [dismissed, setDismissed] = useState<number | null>(null);

    const inRange = (index: number | null) => (index !== null && index < count ? index : null);
    const active = inRange(hovered) ?? inRange(focused);
    const visible = active !== null && active !== dismissed;
    const cardIndex = active ?? inRange(lastShown);
    const cardTurn = cardIndex !== null ? turns[cardIndex] : undefined;
    const tabStop = inRange(focused) ?? (current >= 0 ? current : 0);
    const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;

    const jump = (index: number) => {
        const container = containerRef.current;
        const turn = turns[index];
        if (container && turn) jumpToRun(container, turn.runId, scrolledAtom);
        // Out of the way of the question it just brought up.
        setDismissed(index);
    };

    // Set while the arrow keys move focus between marks: keyboard focus, whatever
    // the browser's focus-visible heuristic makes of a focus moved by script.
    const arrowingRef = useRef(false);
    const focusMark = (index: number) => {
        arrowingRef.current = true;
        try {
            (marksRef.current?.children[index] as HTMLElement | undefined)?.focus();
        } finally {
            arrowingRef.current = false;
        }
    };

    // Pointer and wheel, on the rail as a whole.
    useEffect(() => {
        const marks = marksRef.current;
        const win = marks?.ownerDocument.defaultView;
        if (!marks || !win) return;

        // Mark centres, read once per visit to the rail and again after a resize.
        let centres: number[] | null = null;
        const readCentres = () => Array.from(marks.children, (mark) => {
            const rect = mark.getBoundingClientRect();
            return rect.top + rect.height / 2;
        });

        const track = (event: PointerEvent) => {
            centres ??= readCentres();
            const index = nearestCentreIndex(centres, event.clientY);
            if (index < 0 || index === hoveredRef.current) return;
            hoveredRef.current = index;
            setHovered(index);
            setLastShown(index);
            setDismissed(null);
        };
        const enter = (event: PointerEvent) => {
            centres = null;
            track(event);
        };
        const leave = () => {
            centres = null;
            hoveredRef.current = null;
            setHovered(null);
            setDismissed(null);
        };
        const wheel = (event: WheelEvent) => {
            const container = containerRef.current;
            if (container && scrollByWheel(container, event)) event.preventDefault();
        };
        const observer = typeof win.ResizeObserver === 'function'
            ? new win.ResizeObserver(() => { centres = null; })
            : null;
        observer?.observe(marks);

        marks.addEventListener('pointerenter', enter);
        marks.addEventListener('pointermove', track);
        marks.addEventListener('pointerleave', leave);
        marks.addEventListener('pointercancel', leave);
        // Not passive: the wheel goes to the conversation, not to whatever surrounds the pane.
        marks.addEventListener('wheel', wheel, { passive: false });
        return () => {
            marks.removeEventListener('pointerenter', enter);
            marks.removeEventListener('pointermove', track);
            marks.removeEventListener('pointerleave', leave);
            marks.removeEventListener('pointercancel', leave);
            marks.removeEventListener('wheel', wheel);
            observer?.disconnect();
        };
    }, [containerRef, count]);

    // Place the card level with its mark, inside the chat area.
    const wasVisibleRef = useRef(false);
    useLayoutEffect(() => {
        const card = cardRef.current;
        const area = card?.parentElement;
        const mark = cardIndex !== null ? marksRef.current?.children[cardIndex] : undefined;
        if (!card || !area || !mark || !visible) {
            wasVisibleRef.current = visible;
            return;
        }
        const areaRect = area.getBoundingClientRect();
        card.dataset.compact = areaRect.height < COMPACT_AREA_PX ? 'true' : 'false';
        const markRect = mark.getBoundingClientRect();
        const height = card.offsetHeight;
        const centre = markRect.top + markRect.height / 2 - areaRect.top;
        const top = Math.max(CARD_MARGIN, Math.min(centre - height / 2, areaRect.height - height - CARD_MARGIN));
        if (wasVisibleRef.current) {
            card.style.setProperty('--conversation-peek-y', `${top}px`);
        } else {
            // Appearing: fade in where it belongs. Sliding is for moving between marks.
            card.style.transitionProperty = 'opacity';
            card.style.setProperty('--conversation-peek-y', `${top}px`);
            void card.offsetHeight;
            card.style.transitionProperty = '';
        }
        wasVisibleRef.current = true;
    }, [cardIndex, visible, cardTurn]);

    if (count === 0) return null;

    const meta = cardTurn ? turnMeta(cardTurn) : '';

    return (
        <>
            <nav className="conversation-rail" aria-label="Questions in this conversation">
                <div ref={marksRef} className="conversation-rail-marks">
                    {turns.map((turn, index) => (
                        <button
                            key={turn.runId}
                            type="button"
                            className={`conversation-rail-mark${index === current ? ' is-current' : ''}${index === active ? ' is-active' : ''}`}
                            aria-label={markLabel(turn)}
                            aria-current={index === current ? 'location' : undefined}
                            aria-describedby={visible && index === active ? cardId : undefined}
                            tabIndex={index === tabStop ? 0 : -1}
                            onClick={(event) => {
                                // A click jumps to the mark the card shows, the one nearest the
                                // pointer; Enter or Space on a focused mark is a click with no pointer.
                                jump(event.detail === 0 ? index : (hoveredRef.current ?? index));
                            }}
                            onFocus={(event) => {
                                if (!arrowingRef.current && !isKeyboardFocus(event.currentTarget)) {
                                    setFocused(null);
                                    return;
                                }
                                setFocused(index);
                                setLastShown(index);
                                setDismissed(null);
                            }}
                            onBlur={(event) => {
                                // Arrowing to the next mark: its own focus takes over without a gap.
                                const next = event.relatedTarget as Node | null;
                                if (next && marksRef.current?.contains(next)) return;
                                setFocused(null);
                            }}
                            onKeyDown={(event) => {
                                switch (event.key) {
                                    case 'ArrowUp':
                                        event.preventDefault();
                                        focusMark(Math.max(0, index - 1));
                                        break;
                                    case 'ArrowDown':
                                        event.preventDefault();
                                        focusMark(Math.min(count - 1, index + 1));
                                        break;
                                    case 'Home':
                                        event.preventDefault();
                                        focusMark(0);
                                        break;
                                    case 'End':
                                        event.preventDefault();
                                        focusMark(count - 1);
                                        break;
                                    case 'Escape':
                                        if (visible) {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setDismissed(active);
                                        }
                                        break;
                                }
                            }}
                        />
                    ))}
                </div>
            </nav>
            <div
                ref={cardRef}
                id={cardId}
                role="tooltip"
                className="conversation-peek"
                data-visible={visible ? 'true' : 'false'}
                aria-hidden={visible ? undefined : true}
            >
                {cardTurn && (
                    <>
                        <div className="conversation-peek-meta">
                            <span className="conversation-peek-number">Question {cardTurn.index + 1}</span>
                            {meta.split(' · ').filter(Boolean).map((part) => (
                                <span key={part}>· {part}</span>
                            ))}
                        </div>
                        <div className="conversation-peek-question">{cardTurn.question}</div>
                        <div className={`conversation-peek-answer is-${cardTurn.status}`}>{cardTurn.answer}</div>
                        <div className="conversation-peek-foot">
                            {hovered === null ? 'Press Enter to jump' : 'Click to jump'}
                        </div>
                    </>
                )}
            </div>
        </>
    );
});

export default ConversationRail;
