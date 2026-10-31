import React, { useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { AgentRunStatus, ModelResponse, ToolCallPart } from '@beaver/agent-core/agents/types';
import { TextPartView } from './TextPartView';
import { ThinkingPartView } from './ThinkingPartView';
import { ToolCallPartView } from './ToolCallPartView';
import { isAnnotationToolResult } from '@beaver/agent-core/run-state/toolResultTypes';
import { isAutoLoadingToolCall, isThinkingInProgress } from '@beaver/agent-core/agents/messageVisibility';
import ContextMenu from '@beaver/agent-ui/primitives/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { buildEditNoteRenderItems, getEditNoteGroupInstanceId } from './editNoteShared';
import { getHost } from '@beaver/agent-ui/host';
import { GenericAgentActionView } from './GenericAgentActionView';
import { getPendingApprovalForToolcallAtom } from '../../agents/agentActions';
import type { ToolSlice } from './workStream';

interface ModelResponseViewProps {
    /** The model response */
    message: ModelResponse;
    /** Whether the response is streaming */
    isStreaming: boolean;
    /** Run ID for element identification */
    runId: string;
    /** Index of this response within the run (for unique DOM IDs) */
    responseIndex: number;
    /** Run status */
    runStatus: AgentRunStatus;
    /**
     * Which parts of the response this instance renders.
     *
     * One response can appear in two places: its thinking and settled tool
     * calls inside the folded work stream, and the step waiting on the user
     * outside it. Both instances render the same message, so each needs to
     * know which slice is its own — and a distinct `sliceKey`, or the two
     * would collide on every React key and DOM id they generate.
     */
    slice?: { thinking: boolean; text: boolean; tools: ToolSlice };
    sliceKey?: string;
}

const WHOLE_RESPONSE = { thinking: true, text: true, tools: 'settled' as ToolSlice };

/**
 * Renders one slice of a model response: thinking, text, and tool calls.
 *
 * Grouping and folding are not decided here — they cannot be, because a fold
 * spans responses and this component only sees one. `workStream.ts` plans the
 * split and `ModelMessagesView` renders it; this component's job is to draw
 * whichever slice it is handed.
 *
 * All edit_note runs are routed through EditNoteGroupView, including
 * single-call runs, so note edits have one container path.
 */
export const ModelResponseView: React.FC<ModelResponseViewProps> = React.memo(function ModelResponseView({
    message,
    isStreaming,
    runId,
    responseIndex,
    runStatus,
    slice = WHOLE_RESPONSE,
    sliceKey = 'all',
}) {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const getPendingApproval = useAtomValue(getPendingApprovalForToolcallAtom);

    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    // Separate parts by type for rendering
    const thinkingParts = slice.thinking
        ? message.parts.filter(part => part.part_kind === 'thinking')
        : [];
    const textParts = slice.text
        ? message.parts.filter(part => part.part_kind === 'text')
        : [];
    // Memoized so the arrays keep their identity across unrelated re-renders
    // (e.g. selection-menu state): they feed EditNoteGroupView's memoized
    // per-part state and its React.memo'd rows.
    const allToolCallParts = useMemo(
        () => message.parts.filter(
            (part): part is ToolCallPart =>
                part.part_kind === 'tool-call' && part.tool_name !== 'return_suggestions',
        ),
        [message.parts],
    );
    const toolCallParts = useMemo(() => {
        if (slice.tools === 'none') return [];
        const wantAwaiting = slice.tools === 'awaiting';
        return allToolCallParts.filter(
            (part) => !!getPendingApproval(part.tool_call_id) === wantAwaiting,
        );
    }, [allToolCallParts, slice.tools, getPendingApproval]);
    const editNoteRenderItems = useMemo(
        () => buildEditNoteRenderItems(toolCallParts),
        [toolCallParts],
    );

    // Check if we have any visible content
    const hasContent =
        thinkingParts.length > 0 ||
        textParts.length > 0 ||
        toolCallParts.length > 0;

    // Model response that is auto-loading a search capability
    const isAutoLoadingResponse =
        toolCallParts.length > 0 &&
        textParts.length === 0 &&
        toolCallParts.every(isAutoLoadingToolCall);

    if (!hasContent || isAutoLoadingResponse) {
        return null;
    }

    // Generate a unique ID for this response slice (used for DOM identification
    // and UI state persistence).
    const responseId = `${runId}-response-${responseIndex}-${sliceKey}`;

    return (
        <div
            id={`response-${responseId}`}
            className="hover-trigger user-select-text display-flex flex-col gap-1"
            ref={contentRef}
            onContextMenu={handleContextMenu}
        >
            {/* Thinking parts (collapsible) */}
            {thinkingParts.length > 0 && (
                <ThinkingPartView
                    key={`${responseId}-thinking`}
                    parts={thinkingParts}
                    isThinking={isStreaming && isThinkingInProgress(message)}
                    hasFollowingContent={textParts.length > 0 || toolCallParts.length > 0}
                    thinkingId={`${responseId}-thinking`}
                />
            )}

            {/* Text parts (markdown rendered) */}
            {textParts.length > 0 && (
                <div>
                    {textParts.map((part, index) => (
                        part.part_kind === 'text' && (
                            <TextPartView
                                key={`text-${index}`}
                                part={part}
                                runId={runId}
                            />
                        )
                    ))}
                </div>
            )}

            {/* Tool call parts. No padding of its own: every step row carries
                the same py-15 halo, so row-to-row spacing is uniform whether
                two rows share this wrapper or sit in different responses. */}
            {toolCallParts.length > 0 && (
                <div className="display-flex flex-col gap-1">
                    {editNoteRenderItems.map((item) => {
                        if (item.kind === 'edit-note-group') {
                            // Agent-action UI is host-injected; non-Zotero clients
                            // get a request-side summary via the generic fallback.
                            const groupKey = `edit-note-group-${getEditNoteGroupInstanceId(item.parts)}`;
                            return (
                                <React.Fragment key={groupKey}>
                                    {getHost().components?.agentActionInStream({
                                        kind: 'edit-note-group',
                                        parts: item.parts,
                                        target: item.target,
                                        runId,
                                        responseIndex,
                                        runStatus,
                                    }) ?? <GenericAgentActionView editNoteParts={item.parts} runStatus={runStatus} />}
                                </React.Fragment>
                            );
                        }

                        const part = item.part;

                        // Use specialized (host-injected) view for annotation tools
                        if (isAnnotationToolResult(part.tool_name)) {
                            return (
                                <React.Fragment key={`tool-${part.tool_call_id}`}>
                                    {getHost().components?.agentActionInStream({
                                        kind: 'annotation',
                                        part,
                                        runId,
                                        runStatus,
                                    }) ?? <GenericAgentActionView part={part} runStatus={runStatus} />}
                                </React.Fragment>
                            );
                        }

                        // Default view for other tools
                        return (
                            <ToolCallPartView
                                key={`tool-${responseIndex}-${part.tool_call_id}`}
                                part={part}
                                runId={runId}
                                responseIndex={responseIndex}
                                runStatus={runStatus}
                            />
                        );
                    })}
                </div>
            )}

            {/* Text selection context menu */}
            <ContextMenu
                menuItems={selectionMenuItems}
                isOpen={isSelectionMenuOpen}
                onClose={closeSelectionMenu}
                position={selectionMenuPosition}
                useFixedPosition={true}
            />
        </div>
    );
});

export default ModelResponseView;
