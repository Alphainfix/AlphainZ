import React, { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { ModelMessage, AgentRunStatus, ModelResponse } from '@beaver/agent-core/agents/types';
import { ModelResponseView } from './ModelResponseView';
import { RunStatusIndicator } from './RunStatusIndicator';
import { WorkStreamView } from './WorkStreamView';
import { getPendingApprovalForToolcallAtom } from '../../agents/agentActions';
import { streamDisplayModeAtom } from '../../atoms/streamDisplay';
import { groupStreamUnits, planRunStream, summarizeGroup, type StreamUnit } from './workStream';

interface ModelMessagesViewProps {
    messages: ModelMessage[];
    runId: string;
    isStreaming: boolean;
    /** Whether to show the status indicator inside this container */
    showStatusIndicator?: boolean;
    /** The run status (required when showStatusIndicator is true) */
    status: AgentRunStatus;
    /**
     * When the wait the indicator is reporting began, in epoch ms, or null when
     * the run has produced nothing to date it from.
     */
    waitingSince?: number | null;
}

/**
 * Renders the model messages in an agent run.
 *
 * Only ModelResponse messages are rendered — see `isRenderableMessage` for why
 * a ModelRequest never is. Their tool-return parts surface elsewhere, inline
 * with the matching tool call via `toolResultsMapAtom`; their user-prompt parts
 * have no consumer by design.
 *
 * The work/answer split lives here rather than in ModelResponseView because a
 * run alternates between talking and calling tools across several responses,
 * and a fold that stops at a response boundary is not a fold. See
 * `workStream.ts` for the rules.
 */
export const ModelMessagesView: React.FC<ModelMessagesViewProps> = React.memo(function ModelMessagesView({
    messages,
    runId,
    isStreaming,
    showStatusIndicator,
    status,
    waitingSince,
}) {
    const getPendingApproval = useAtomValue(getPendingApprovalForToolcallAtom);
    const displayMode = useAtomValue(streamDisplayModeAtom);

    const isAwaiting = useCallback(
        (toolCallId: string) => !!getPendingApproval(toolCallId),
        [getPendingApproval],
    );

    const groups = useMemo(
        () => groupStreamUnits(planRunStream(messages, isAwaiting, { streaming: isStreaming })),
        [messages, isAwaiting, isStreaming],
    );

    // Don't render anything if there's no content to show
    if (messages.length === 0 && !showStatusIndicator) {
        return null;
    }

    const renderUnit = (unit: StreamUnit) => {
        const message = messages[unit.messageIndex] as ModelResponse;
        const isLastMessage = unit.messageIndex === messages.length - 1;
        return (
            <ModelResponseView
                key={`${runId}-response-${unit.key}`}
                message={message}
                isStreaming={isStreaming && isLastMessage}
                runId={runId}
                responseIndex={unit.messageIndex}
                runStatus={status}
                slice={{ thinking: unit.thinking, text: unit.text, tools: unit.tools }}
                sliceKey={unit.role}
            />
        );
    };

    const lastWorkGroupKey = [...groups].reverse().find((g) => g.kind === 'work')?.key;

    return (
        // gap-4 is the one boundary rhythm of the stream: fold box or bare
        // rows to the answer, answer to the next stretch of work, wait
        // indicator to whatever it follows. Children carry no margins of
        // their own toward each other.
        <div className="display-flex flex-col gap-4 px-4">
            {groups.map((group) => {
                if (group.kind !== 'work') {
                    return (
                        <React.Fragment key={group.key}>
                            {group.units.map(renderUnit)}
                        </React.Fragment>
                    );
                }

                /*
                 * Live = the last work group of a streaming run — by position,
                 * not by message index. The index comparison flapped: every
                 * iteration appends an empty message before any part lands in
                 * it, so for a frame or two the group was no longer "last",
                 * its default flipped closed, twenty kilobytes of children
                 * unmounted, and then it all came back — a visible blink of
                 * the whole fold at every iteration boundary of every run.
                 */
                const isLive = isStreaming && group.key === lastWorkGroupKey;

                /*
                 * Answer-only: everything while it works, nothing once it stops.
                 *
                 * Not one line, and not per-group. Keying the reveal to whether
                 * *this* group is the last one meant each stretch of work
                 * vanished the moment the next one started, so the panel jumped
                 * repeatedly on its way to the answer — content appearing and
                 * disappearing under the reader's eyes. A collapsed summary line
                 * jumps for the same reason: its text is rewritten every time a
                 * tool lands.
                 *
                 * So the whole run stays expanded and only grows downward, and
                 * when it finishes all of it goes at once, leaving the answer.
                 * One transition instead of a dozen.
                 */
                /*
                 * A work group rendered without its fold still renders as ONE
                 * flex child with the fold interior's own gap. Left as bare
                 * siblings, its units would be spaced by the container's
                 * boundary gap — rows inside one response 16px apart, the same
                 * rows across responses 24px apart, for no reason a reader can
                 * see.
                 */
                if (displayMode === 'answer') {
                    if (!isStreaming) return null;
                    return (
                        <div key={group.key} className="display-flex flex-col gap-1">
                            {group.units.map(renderUnit)}
                        </div>
                    );
                }

                // A single row is already one line. Wrapping it in a disclosure
                // costs a click and saves nothing.
                if (displayMode === 'expanded' || group.rows < 2) {
                    return (
                        <div key={group.key} className="display-flex flex-col gap-1">
                            {group.units.map(renderUnit)}
                        </div>
                    );
                }

                return (
                    <WorkStreamView
                        key={group.key}
                        streamId={`${runId}:${group.key}`}
                        summary={summarizeGroup(group)}
                        isWorking={isLive}
                    >
                        <div className="display-flex flex-col gap-1">
                            {group.units.map(renderUnit)}
                        </div>
                    </WorkStreamView>
                );
            })}
            {/* Status indicator rendered inside the same container for smooth transitions */}
            {showStatusIndicator && status && (
                <RunStatusIndicator
                    status={status}
                    runId={runId}
                    waitingSince={waitingSince}
                />
            )}
        </div>
    );
});

export default ModelMessagesView;
