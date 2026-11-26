import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { SearchIcon } from '../icons/icons';
import {
    conversationTurnsAtom,
    outlineElementId,
    outlineOpenAtomFor,
} from '../../atoms/conversationNav';
import { currentThreadIdAtom } from '../../atoms/threads';
import { isThreadListViewAtom, userScrolledAtom, windowUserScrolledAtom } from '../../atoms/ui';
import { useCurrentTurnIndex } from '@beaver/agent-ui/conversation/useCurrentTurn';
import { jumpToRun } from '../../utils/conversationNavigation';
import { answerSnippet, filterTurns, highlightSegments } from '../../utils/conversationTurns';
import { t } from '../../../src/utils/i18n';

interface ConversationOutlineProps {
    /** Whether this is the separate window, which has its own outline and scroll state. */
    isWindow: boolean;
    /** The thread view's scroll container. */
    containerRef: React.RefObject<HTMLDivElement>;
    /** The header button that opens the outline; focus goes back to it on close. */
    buttonRef: React.RefObject<HTMLButtonElement>;
}

/** `text` with every stretch matching `query` in the accent colour, as the chat list marks a match. */
function Highlighted({ text, query }: { text: string; query: string }) {
    return (
        <>
            {highlightSegments(text, query).map((segment, i) => (
                segment.match
                    ? <span key={i} className="font-color-accent-blue">{segment.text}</span>
                    : <React.Fragment key={i}>{segment.text}</React.Fragment>
            ))}
        </>
    );
}

/** Keep `row` in view inside the scrolling `list`, moving the list as little as possible. */
function keepRowInView(list: HTMLElement, row: HTMLElement): void {
    const top = row.offsetParent === list ? row.offsetTop : row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

interface OutlinePanelProps extends ConversationOutlineProps {
    onClose: () => void;
}

/**
 * The open outline: every question in the conversation, with the start of its
 * answer, and a search over both. It is the chat history's panel, in the same
 * place and drawn by the same styles; the question being read is marked the
 * way the chat list marks the current chat.
 *
 * ↑↓ select, Enter jumps, Escape closes. Focus stays in the search field the
 * whole time (the list is its listbox), and goes back to the header button when
 * the panel closes with focus inside it.
 */
const OutlinePanel: React.FC<OutlinePanelProps> = ({ isWindow, containerRef, buttonRef, onClose }) => {
    const turns = useAtomValue(conversationTurnsAtom);
    const runIds = useMemo(() => turns.map((turn) => turn.runId), [turns]);
    const current = useCurrentTurnIndex(containerRef, runIds);

    const [query, setQuery] = useState('');
    // The row under the pointer or picked with the arrow keys.
    const [active, setActive] = useState<number | null>(null);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const baseId = useId();
    const listId = `${baseId}-list`;
    const optionId = (index: number) => `${baseId}-option-${index}`;

    const filter = query.trim();
    const results = useMemo(() => filterTurns(turns, filter), [turns, filter]);
    const activeIndex = active !== null && results.some((turn) => turn.index === active) ? active : null;

    const jump = useCallback((index: number) => {
        const container = containerRef.current;
        const turn = turns[index];
        if (container && turn) {
            jumpToRun(container, turn.runId, isWindow ? windowUserScrolledAtom : userScrolledAtom);
        }
        onClose();
    }, [containerRef, turns, isWindow, onClose]);

    // The arrows start from the question being read, or from the ends of a filtered list.
    const move = (step: number) => {
        if (results.length === 0) return;
        const from = activeIndex ?? current;
        const at = results.findIndex((turn) => turn.index === from);
        const next = at < 0
            ? (step > 0 ? 0 : results.length - 1)
            : Math.max(0, Math.min(results.length - 1, at + step));
        setActive(results[next].index);
        const row = listRef.current?.querySelector<HTMLElement>(`[data-turn-index="${results[next].index}"]`);
        if (listRef.current && row) keepRowInView(listRef.current, row);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (isImeKeyEvent(event.nativeEvent)) return;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                move(1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                move(-1);
                break;
            case 'Enter': {
                event.preventDefault();
                const target = activeIndex ?? (filter ? results[0]?.index : undefined);
                if (target !== undefined) jump(target);
                break;
            }
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                onClose();
                break;
        }
    };

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Opened in a long conversation, the list starts where the reader is.
    const scrolledToCurrentRef = useRef(false);
    useLayoutEffect(() => {
        if (scrolledToCurrentRef.current || current < 0) return;
        const list = listRef.current;
        const row = list?.querySelector<HTMLElement>(`[data-turn-index="${current}"]`);
        if (list && row) keepRowInView(list, row);
        scrolledToCurrentRef.current = true;
    }, [current]);

    // Closing with focus inside (Escape, Enter, a row) hands focus back to the
    // button; a click beside the panel leaves it where it went. A layout
    // cleanup runs while the panel is still in the document.
    useLayoutEffect(() => {
        const root = rootRef.current;
        return () => {
            const active = root?.ownerDocument.activeElement;
            if (root && active && root.contains(active)) buttonRef.current?.focus();
        };
    }, [buttonRef]);

    return (
        <div className="thread-overlay-container">
            <div className="thread-overlay-backdrop" onClick={onClose} />
            <div
                ref={rootRef}
                id={outlineElementId(isWindow)}
                className="thread-overlay-panel"
                role="dialog"
                aria-label={t('Conversation outline')}
                onKeyDown={handleKeyDown}
            >
                <div className="display-flex flex-col flex-1 min-h-0">
                    <div className="thread-overlay-title mb-1">{t('Questions')}</div>

                    <div className="px-3 pb-2">
                        <div className="thread-search-wrapper">
                            <SearchIcon width={14} height={14} className="thread-search-icon" />
                            <input
                                ref={inputRef}
                                type="text"
                                className="thread-search-input"
                                role="combobox"
                                aria-label={t('Search questions and answers')}
                                aria-controls={listId}
                                aria-expanded="true"
                                aria-autocomplete="list"
                                aria-activedescendant={activeIndex !== null ? optionId(activeIndex) : undefined}
                                placeholder={t('Search questions...')}
                                value={query}
                                onChange={(event) => {
                                    setQuery(event.target.value);
                                    setActive(null);
                                }}
                            />
                        </div>
                    </div>

                    {results.length > 0 ? (
                        <div ref={listRef} id={listId} className="flex-1 overflow-y-auto px-1" role="listbox" aria-label={t('Questions')}>
                            {results.map((turn) => {
                                const isActive = turn.index === activeIndex;
                                const isCurrent = turn.index === current;
                                return (
                                    <div
                                        key={turn.runId}
                                        id={optionId(turn.index)}
                                        role="option"
                                        aria-selected={isActive}
                                        aria-current={isCurrent ? 'location' : undefined}
                                        aria-label={isCurrent
                                            ? t('Question {number}: {question}, current question', { number: turn.index + 1, question: turn.question })
                                            : t('Question {number}: {question}', { number: turn.index + 1, question: turn.question })}
                                        data-turn-index={turn.index}
                                        className={`thread-list-item ${isActive ? 'thread-list-item-hovered' : ''}`}
                                        // Keep focus in the search field, as a listbox under a combobox does.
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => jump(turn.index)}
                                        onMouseEnter={() => setActive(turn.index)}
                                        onMouseLeave={() => setActive(null)}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <div className="thread-list-item-name truncate">
                                                {turn.index + 1}. <Highlighted text={turn.question} query={filter} />
                                            </div>
                                            <div className="thread-list-item-time">
                                                <span className="min-w-0 truncate">
                                                    <Highlighted text={answerSnippet(turn, filter)} query={filter} />
                                                </span>
                                                {isCurrent && <span className="flex-shrink-0">{t('(current)')}</span>}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div id={listId} className="display-flex items-center justify-center py-6" role="status">
                            <span className="font-color-tertiary text-sm">{t('No matching questions')}</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

/**
 * The conversation outline, over the chat area where the chat history opens.
 * Opened and closed by the header's outline button; closes itself when the
 * conversation changes or the chat history opens. Memoised, as its parent
 * re-renders on every streamed token.
 */
export const ConversationOutline = React.memo(function ConversationOutline(props: ConversationOutlineProps) {
    const [open, setOpen] = useAtom(outlineOpenAtomFor(props.isWindow));
    const isThreadListView = useAtomValue(isThreadListViewAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    const close = useCallback(() => setOpen(false), [setOpen]);

    // The chat history takes the same space.
    useEffect(() => {
        if (isThreadListView) setOpen(false);
    }, [isThreadListView, setOpen]);

    // Another conversation: the list was about this one.
    const openedInThreadRef = useRef(threadId);
    useEffect(() => {
        if (openedInThreadRef.current && threadId !== openedInThreadRef.current) setOpen(false);
        openedInThreadRef.current = threadId;
    }, [threadId, setOpen]);

    // Leaving the conversation view (loading another thread, a new chat): closed when it comes back.
    useEffect(() => () => setOpen(false), [setOpen]);

    return open ? <OutlinePanel {...props} onClose={close} /> : null;
});

export default ConversationOutline;
