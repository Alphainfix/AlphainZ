/**
 * A conversation as a list of its questions: what the question rail and the
 * outline show. Each client builds the list from its own runs; these are the
 * shared shape and the helpers that read it.
 */

/** Where a turn's answer stands, taken from the last run that worked on it. */
export type TurnStatus = 'answering' | 'waiting' | 'done' | 'stopped' | 'failed';

export interface ConversationTurn {
    /** The run that asked the question; its element in the thread view is `#run-<runId>`. */
    runId: string;
    /** Position in the conversation, from 0. */
    index: number;
    /** The question as one line of plain text. */
    question: string;
    /**
     * The answer as one line of plain text, or what stands in for it while
     * the run is working or after it failed.
     */
    answer: string;
    status: TurnStatus;
    /** When the question was asked (ISO 8601). */
    createdAt: string;
    /** Citations in the answer. */
    citations: number;
}

/** Shorten to `max` characters, marking the cut. */
export function clipText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Whether two turn lists would draw the same, so a streamed token re-renders nothing. */
export function sameTurns(a: readonly ConversationTurn[], b: readonly ConversationTurn[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    return a.every((turn, i) => {
        const other = b[i];
        return turn.runId === other.runId
            && turn.question === other.question
            && turn.answer === other.answer
            && turn.status === other.status
            && turn.createdAt === other.createdAt
            && turn.citations === other.citations;
    });
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "14:32" today, "Oct 3 14:32" earlier this year, "Oct 3, 2025 14:32" before that. */
export function formatTurnTime(createdAt: string, now: Date = new Date()): string {
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return '';
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    if (date.toDateString() === now.toDateString()) return time;
    const day = date.toLocaleDateString('en-US', date.getFullYear() === now.getFullYear()
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
    return `${day} ${time}`;
}

/** "14:32 · 2 citations": when the question was asked and what the answer cites. */
export function turnMeta(turn: ConversationTurn, now?: Date): string {
    const parts = [formatTurnTime(turn.createdAt, now)];
    if (turn.citations > 0) parts.push(turn.citations === 1 ? '1 citation' : `${turn.citations} citations`);
    return parts.filter(Boolean).join(' · ');
}

/** "3 questions". */
export function questionCountLabel(count: number): string {
    return count === 1 ? '1 question' : `${count} questions`;
}

/** Turns whose question or answer contains `query`, ignoring case. An empty query keeps all. */
export function filterTurns(turns: readonly ConversationTurn[], query: string): ConversationTurn[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...turns];
    return turns.filter((turn) =>
        turn.question.toLowerCase().includes(needle) || turn.answer.toLowerCase().includes(needle));
}

export interface TextSegment {
    text: string;
    match: boolean;
}

/** `text` cut into the stretches that match `query` (ignoring case) and those that do not. */
export function highlightSegments(text: string, query: string): TextSegment[] {
    const needle = query.trim().toLowerCase();
    const haystack = text.toLowerCase();
    // A few characters change length when lower-cased; offsets into the
    // lower-cased copy would then cut the original in the wrong places.
    if (!needle || haystack.length !== text.length) return text ? [{ text, match: false }] : [];
    const segments: TextSegment[] = [];
    let from = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
        if (at > from) segments.push({ text: text.slice(from, at), match: false });
        segments.push({ text: text.slice(at, at + needle.length), match: true });
        from = at + needle.length;
    }
    if (from < text.length) segments.push({ text: text.slice(from), match: false });
    return segments;
}

/** The answer snippet the outline shows has to fit two lines; anything longer is hidden anyway. */
const SNIPPET_CHARS = 280;

/**
 * The part of a turn's answer to show under the question. When only the
 * answer matches the filter, the snippet starts just before the first match,
 * so the match is not cut off below the second line.
 */
export function answerSnippet(turn: ConversationTurn, query: string): string {
    const needle = query.trim().toLowerCase();
    const answer = turn.answer;
    if (needle && !turn.question.toLowerCase().includes(needle)) {
        const at = answer.toLowerCase().indexOf(needle);
        if (at > 24) return clipText(`…${answer.slice(at - 18)}`, SNIPPET_CHARS);
    }
    return clipText(answer, SNIPPET_CHARS);
}

/**
 * Index of the centre nearest to `y` (a tie goes to the earlier one), or -1
 * for none. `centres` ascend, as the marks on the rail do from top to bottom.
 */
export function nearestCentreIndex(centres: readonly number[], y: number): number {
    if (centres.length === 0) return -1;
    let low = 0;
    let high = centres.length - 1;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (centres[mid] < y) low = mid + 1;
        else high = mid;
    }
    if (low > 0 && Math.abs(centres[low - 1] - y) <= Math.abs(centres[low] - y)) return low - 1;
    return low;
}
