import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ThinkingPart } from '@beaver/agent-core/agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import { Spinner, Icon, BrainIcon, ArrowRightIcon, ArrowDownIcon } from '../icons/icons';
import { thinkingVisibilityAtom, toggleThinkingVisibilityAtom } from '../../atoms/messageUIState';

interface ThinkingPartViewProps {
    parts: ThinkingPart[];
    isThinking: boolean;
    hasFollowingContent: boolean;
    /** Unique ID for persistent visibility state */
    thinkingId: string;
}

/**
 * Renders a collapsible thinking/reasoning section.
 * Shows a button that can be expanded to reveal the thinking content.
 */
export const ThinkingPartView: React.FC<ThinkingPartViewProps> = ({
    parts,
    isThinking,
    hasFollowingContent,
    thinkingId,
}) => {
    // Use Jotai atom for persistent visibility state (matches ThinkingContent behavior)
    const thinkingVisibilityMap = useAtomValue(thinkingVisibilityAtom);
    const toggleVisibility = useSetAtom(toggleThinkingVisibilityAtom);
    const isExpanded = thinkingVisibilityMap[thinkingId] ?? false;
    const [isHovered, setIsHovered] = useState(false);

    const toggleExpanded = () => {
        toggleVisibility(thinkingId);
    };

    const getIcon = () => {
        if (isExpanded) return ArrowDownIcon;
        if (isHovered) return ArrowRightIcon;
        if (isThinking) return Spinner;
        return BrainIcon;
    };

    const content = parts.map(part => part.content).join('\n\n');

    if (!content || content.trim() === '') {
        return null;
    }

    /*
     * The collapsed row carries a glimpse of the thought, not just the word
     * "Thinking". Eight identical rows say nothing; eight rows each starting
     * with their own first line ("the user wants the ensemble T2 paper…",
     * "that search missed, try the author…") read as the story of the run.
     * First line only, one line high, secondary colour — a hint, not a
     * transcript. Hidden while streaming: it would rewrite under the shimmer.
     */
    const preview = !isThinking && !isExpanded
        ? content.trim().replace(/^undefined/, '').split('\n')[0]
            // The thought is markdown; the preview is one plain-text line.
            .replace(/[*_`#>]/g, '').trim()
        : '';

    return (
        <div
            className={`
                thinking-block rounded-md display-flex flex-col min-w-0
                ${isExpanded ? 'border-popup mb-2' : 'border-transparent'}
            `}
        >
            <div
                className={`
                    display-flex flex-row py-15
                    ${isExpanded ? 'border-bottom-quinary bg-senary' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row cursor-pointer gap-2 w-full text-left min-w-0"
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={isExpanded}
                    aria-controls={`thinking-content-${thinkingId}`}
                    onClick={toggleExpanded}
                >
                    <div className="display-flex flex-row px-3 gap-2 min-w-0">
                        <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={getIcon()} />
                        </div>
                        
                        <div className={`display-flex flex-shrink-0 ${isExpanded ? 'font-color-primary' : ''} ${isThinking ? 'shimmer-text' : ''}`}>
                            {isThinking ? 'Thinking' : 'Thoughts'}
                        </div>
                        {preview && (
                            <div className="display-flex truncate font-color-tertiary min-w-0">
                                {preview}
                            </div>
                        )}
                    </div>
                </button>
                <div className="flex-1"/>
            </div>

            {isExpanded && (
                <div className="opacity-70 p-3 text-sm" id={`thinking-content-${thinkingId}`}>
                    <MarkdownRenderer 
                        className="markdown" 
                        content={content.trim().replace(/^undefined/, '')}
                        enableNoteBlocks={false}
                    />
                </div>
            )}
        </div>
    );
};

export default ThinkingPartView;

