/**
 * Splitting a run into the part you read and the part you can check: the
 * shared planner (`@beaver/agent-ui/conversation/workStream`, which AlphainO
 * uses too), with this plugin's write tools — the ones that act on an answer
 * already reached, and so never count as work.
 */
import type { ModelMessage } from '@beaver/agent-core/agents/types';
import {
    groupStreamUnits,
    planRunStream as planSharedRunStream,
    summarizeGroup,
    type StreamGroup,
    type StreamUnit,
    type ToolSlice,
} from '@beaver/agent-ui/conversation/workStream';
import { WRITE_TOOL_NAMES } from '../../../src/services/llm/writeTools';

const WRITE_TOOLS: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

/** Plan how a run's messages render (see the shared `planRunStream`). */
export function planRunStream(
    messages: ModelMessage[],
    isAwaiting: (toolCallId: string) => boolean,
    options?: { streaming?: boolean },
): StreamUnit[] {
    return planSharedRunStream(messages, isAwaiting, { ...options, writeTools: WRITE_TOOLS });
}

export { groupStreamUnits, summarizeGroup };
export type { StreamGroup, StreamUnit, ToolSlice };
