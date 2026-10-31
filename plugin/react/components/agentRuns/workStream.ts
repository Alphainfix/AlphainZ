/**
 * Splitting a run into the part you read and the part you can check.
 *
 * The transcript used to fold tool calls and nothing else, one model response
 * at a time. That failed on both counts. Folding inside a response cannot span
 * responses, so a run that alternates "call, sentence, call, sentence" folded
 * into a ladder of one-row groups; and the sentences and thinking rows between
 * them were never folded at all, so the ladder had rungs.
 *
 * The split that actually matches what a reader wants is not by response and
 * not by part kind — it is *the answer versus the work that produced it*. So:
 * everything up to and including the last tool call is work, whatever kind of
 * part it is, and the text after it is the answer. A run with no tool calls is
 * all answer, which is why a plain question still looks like a plain answer.
 *
 * One exception, and it is not cosmetic: a tool call waiting on the user is
 * never work. Apply and Reject live in that row.
 */

import { ModelMessage, ModelResponse, ToolCallPart } from '@beaver/agent-core/agents/types';
import { isRenderableMessage } from '@beaver/agent-core/agents/messageVisibility';
import { TOOL_BASE_LABELS } from '@beaver/agent-core/run-state/toolCallRequest';
import { WRITE_TOOL_NAMES } from '../../../src/services/llm/writeTools';

/** Which tool calls a unit renders. */
export type ToolSlice = 'none' | 'settled' | 'awaiting';

export interface StreamUnit {
    /** Unique within the run; also the React key and the DOM id suffix. */
    key: string;
    /** Index into the original message array — callers still need it. */
    messageIndex: number;
    /**
     * `work` units fold together with their neighbours. `decision` units hold
     * the steps waiting on the user and never fold. `answer` units are the
     * model's closing text.
     */
    role: 'work' | 'decision' | 'answer';
    thinking: boolean;
    text: boolean;
    tools: ToolSlice;
    /** Tool names in this unit, for the fold's one-line summary. */
    toolNames: string[];
    /** Rows this unit contributes, used to decide whether folding is worth a click. */
    rows: number;
}

/** A run of consecutive work units, or a single non-work unit. */
export interface StreamGroup {
    key: string;
    kind: 'work' | 'single';
    units: StreamUnit[];
    /** Total rows across the group — a one-row group is not worth a disclosure. */
    rows: number;
    /** Tool names across the group. */
    toolNames: string[];
    /** Highest message index in the group, for "is this the live one". */
    lastMessageIndex: number;
}

/*
 * Every read of `parts` tolerates a hole.
 *
 * Parts arrive by index off the stream, and an index that skips leaves the
 * array sparse. Reading `part.part_kind` on the gap threw during render and
 * took the whole panel down — the user was left with a blank sidebar and no
 * way back except a restart. The stream no longer creates holes; this is so
 * that if one ever appears again it costs a missing row, not the panel.
 */
function partsOf(message: ModelResponse): ModelResponse['parts'] {
    return (message.parts ?? []).filter(Boolean) as ModelResponse['parts'];
}

function toolCallsOf(message: ModelResponse): ToolCallPart[] {
    return partsOf(message).filter(
        (part): part is ToolCallPart =>
            part.part_kind === 'tool-call' && part.tool_name !== 'return_suggestions',
    );
}

const WRITE_TOOLS: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

/**
 * Whether a tool call is *work* — a read or a search on the way to the answer.
 *
 * A write tool is not. `create_highlight`, `create_note` and the rest act on
 * an answer the model has already reached, so the text around them is the
 * answer, not the model talking its way somewhere. Counting them as work
 * folded exactly the sentence the user had asked for: "The limit is set by
 * the nectar supply. I'll propose a highlight on that sentence." went inside the
 * disclosure, and the only line left in the open was "Proposed one highlight."
 * The proposal row itself still renders where it falls; it just does not
 * decide what is narration.
 */
function isWorkToolCall(part: ToolCallPart): boolean {
    return !WRITE_TOOLS.has(part.tool_name);
}

function hasText(message: ModelResponse): boolean {
    return partsOf(message).some(
        (part) => part.part_kind === 'text' && (part.content ?? '').trim() !== '',
    );
}

function hasThinking(message: ModelResponse): boolean {
    return partsOf(message).some(
        (part) => part.part_kind === 'thinking' && (part.content ?? '').trim() !== '',
    );
}

/**
 * Plan how a run's messages render.
 *
 * `isAwaiting` is injected rather than read from the store so this stays a pure
 * function of the run — the grouping is the part worth testing, and it should
 * be testable without a Jotai provider.
 */
export function planRunStream(
    messages: ModelMessage[],
    isAwaiting: (toolCallId: string) => boolean,
    options?: { streaming?: boolean },
): StreamUnit[] {
    let lastToolIndex = -1;
    messages.forEach((message, index) => {
        if (isRenderableMessage(message) && toolCallsOf(message).some(isWorkToolCall)) lastToolIndex = index;
    });

    /*
     * While the run is still streaming, there is no answer yet.
     *
     * "Text after the last tool call" is only knowable once the run has ended.
     * Applying it live meant every narration sentence was first classified as
     * the answer (nothing follows it yet), rendered below the fold, and then
     * — the moment the next tool call arrived and moved `lastToolIndex` —
     * reclassified as work and pulled inside. On a chatty model that is a
     * paragraph appearing and vanishing at every iteration, and because the
     * unit keys carry the role, every flip also reset the disclosure ids, so
     * remembered open/closed state was thrown away mid-run: the fold the user
     * had just opened snapped shut on its own.
     *
     * So: while streaming, all text in a run that has called a tool is work,
     * and the classification flips exactly once, at completion. A run that has
     * called no tool keeps streaming its text as the answer — folding a plain
     * reply inside a disclosure would hide the very thing being watched. Its
     * one flip, if a first tool call ever arrives, is the true correction.
     */
    const streaming = options?.streaming === true;

    const units: StreamUnit[] = [];

    messages.forEach((message, index) => {
        if (!isRenderableMessage(message)) return;

        const toolCalls = toolCallsOf(message);
        const awaiting = toolCalls.filter((part) => isAwaiting(part.tool_call_id));
        const settled = toolCalls.filter((part) => !isAwaiting(part.tool_call_id));
        const thinking = hasThinking(message);
        const text = hasText(message);
        // Text before the last *work* tool call is the model talking its way
        // there; text after it is the answer — except mid-stream, where the
        // run's trailing text is not yet anything (see above). A write tool
        // (a proposed highlight, a note) does not move the line: see
        // `isWorkToolCall`.
        const textIsWork = index <= lastToolIndex || (streaming && lastToolIndex >= 0);

        const workText = text && textIsWork;

        const pushWork = (key: string, slice: { thinking: boolean; text: boolean; settled: ToolCallPart[] }) => {
            const rows = (slice.thinking ? 1 : 0) + (slice.text ? 1 : 0) + slice.settled.length;
            if (rows === 0) return;
            units.push({
                key,
                messageIndex: index,
                role: 'work',
                thinking: slice.thinking,
                text: slice.text,
                tools: slice.settled.length > 0 ? 'settled' : 'none',
                toolNames: slice.settled.map((part) => part.tool_name),
                rows,
            });
        };

        if (text && !textIsWork) {
            // The message is read in the order the model produced it: any
            // thinking, then the answer, then the rows of what it did with the
            // answer — "The limit is the nectar supply; I'll propose a highlight on
            // it" above the proposal card, not captioning it from below. So a
            // message whose text is the answer splits its work into two units,
            // one either side of the text.
            pushWork(`${index}-work`, { thinking, text: false, settled: [] });
            units.push({
                key: `${index}-answer`,
                messageIndex: index,
                role: 'answer',
                thinking: false,
                text: true,
                tools: 'none',
                toolNames: [],
                rows: 1,
            });
            pushWork(`${index}-rows`, { thinking: false, text: false, settled });
        } else {
            pushWork(`${index}-work`, { thinking, text: workText, settled });
        }

        if (awaiting.length > 0) {
            units.push({
                key: `${index}-decision`,
                messageIndex: index,
                role: 'decision',
                thinking: false,
                text: false,
                tools: 'awaiting',
                toolNames: awaiting.map((part) => part.tool_name),
                rows: awaiting.length,
            });
        }
    });

    return units;
}

/** Collect consecutive work units so one disclosure can cover the stretch. */
export function groupStreamUnits(units: StreamUnit[]): StreamGroup[] {
    const groups: StreamGroup[] = [];
    let work: StreamUnit[] = [];

    const flush = () => {
        if (work.length === 0) return;
        groups.push({
            key: `work-${work[0].key}`,
            kind: 'work',
            units: work,
            rows: work.reduce((sum, unit) => sum + unit.rows, 0),
            toolNames: work.flatMap((unit) => unit.toolNames),
            lastMessageIndex: work[work.length - 1].messageIndex,
        });
        work = [];
    };

    for (const unit of units) {
        if (unit.role === 'work') {
            work.push(unit);
            continue;
        }
        flush();
        groups.push({
            key: unit.key,
            kind: 'single',
            units: [unit],
            rows: unit.rows,
            toolNames: unit.toolNames,
            lastMessageIndex: unit.messageIndex,
        });
    }
    flush();

    return groups;
}

/** One line saying what a folded stretch did. */
export function summarizeGroup(group: StreamGroup): string {
    const counts = new Map<string, number>();
    for (const name of group.toolNames) {
        const label = TOOL_BASE_LABELS[name] ?? name;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (counts.size === 0) return 'Thinking';

    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const shown = ranked.slice(0, 3).map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
    const rest = ranked.length - shown.length;
    return rest > 0 ? `${shown.join(' · ')} · +${rest} more` : shown.join(' · ');
}
