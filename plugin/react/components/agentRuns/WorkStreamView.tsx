import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import { Spinner, Icon, ArrowRightIcon, ArrowDownIcon, ToolsIcon } from '../icons/icons';
import { thinkingVisibilityAtom, toggleThinkingVisibilityAtom } from '../../atoms/messageUIState';

interface WorkStreamViewProps {
    /** Stable id for the remembered open/closed state. */
    streamId: string;
    /** One line saying what happened, e.g. "18 highlights proposed, 4 pages read". */
    summary: string;
    /** Whether the run is still producing steps. */
    isWorking: boolean;
    /** Open by default even after the run finishes — something needs answering. */
    keepOpen?: boolean;
    children: React.ReactNode;
}

/**
 * The run's working steps, behind one disclosure.
 *
 * Colour-coding a paper is twenty tool calls, and every one of them rendered as
 * its own row — a column of eighteen identical "Proposing a highlight" lines
 * that pushed the answer off the screen. The steps are worth keeping (they are
 * how you check what it actually did) but they are not worth reading by
 * default.
 *
 * Open while the run is working, so there is something to watch, and closed
 * once it finishes — except when a step is still waiting on the user, since
 * Apply and Reject live inside these rows and a decision that cannot be seen
 * cannot be taken. A click either way is remembered for that run, so a user who
 * opened it to look does not have it shut again underneath them.
 */
export const WorkStreamView: React.FC<WorkStreamViewProps> = ({
    streamId,
    summary,
    isWorking,
    keepOpen = false,
    children,
}) => {
    const visibility = useAtomValue(thinkingVisibilityAtom);
    const toggleVisibility = useSetAtom(toggleThinkingVisibilityAtom);
    const [isHovered, setIsHovered] = useState(false);

    // Closed unless the user opens it. What the model did is worth being able
    // to check, not worth reading every time.
    const isExpanded = visibility[streamId] ?? (isWorking || keepOpen);

    const icon = isExpanded ? ArrowDownIcon : isHovered ? ArrowRightIcon : isWorking ? Spinner : ToolsIcon;

    // No margin of its own: the messages container spaces its children with one
    // gap, so the work/answer boundary is the same whether this box is open,
    // closed, or absent.
    return (
        <div className={`work-stream rounded-md display-flex flex-col min-w-0 ${isExpanded ? 'border-popup' : ''}`}>
            <div
                className={`display-flex flex-row py-15 ${isExpanded ? 'border-bottom-quinary bg-senary' : ''}`}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row cursor-pointer gap-2 w-full text-left"
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    aria-controls={`work-stream-${streamId}`}
                    // Distinguishes this disclosure from a tool row's own
                    // expander, which is also aria-expanded.
                    data-step-group="true"
                    onClick={() => toggleVisibility(streamId)}
                >
                    <div className="display-flex flex-row px-3 gap-2 min-w-0">
                        <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={icon} />
                        </div>
                        <div
                            className={`display-flex truncate ${isExpanded ? 'font-color-primary' : 'font-color-secondary'} ${isWorking ? 'shimmer-text' : ''}`}
                        >
                            {summary}
                        </div>
                    </div>
                </button>
                <div className="flex-1" />
            </div>

            {isExpanded && (
                // py-1 squares the interior with the row rhythm: the top pad
                // keeps the first row's gap to the header bar from reading
                // tighter than the rows below it, and the bottom pad covers a
                // text step ending the stream (markdown carries no trailing
                // margin, so its last line would sit on the box's border).
                <div id={`work-stream-${streamId}`} className="px-1 py-1">
                    {children}
                </div>
            )}
        </div>
    );
};

export default WorkStreamView;
