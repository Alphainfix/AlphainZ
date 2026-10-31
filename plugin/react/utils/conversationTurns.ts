/**
 * The questions in a conversation, as the question rail and the outline show
 * them.
 *
 * A turn is one question and the answer to it: the run the user started, plus
 * any run that later continued that answer after a failure or an interruption.
 * A continuation asks nothing of its own (its prompt is empty and the thread
 * shows no request bubble for it), so it reads as part of the answer above it
 * and never gets a mark or a row of its own.
 *
 * Everything here is derived from the runs alone, so the rail, the outline and
 * the header badge always agree on what the questions are.
 */
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { getRunErrorTitle, stripRunErrorTypePrefix } from '@beaver/agent-core/run-state/runErrorCopy';
import { isInterruptedRun } from '@beaver/agent-core/run-state/runResumeHelpers';
import { ensurePromptActionTokens } from '@beaver/agent-ui/composer/slashCommands';
import { WRITE_TOOL_NAMES } from '../../src/services/llm/writeTools';
import { mathToPlainText, replaceMath } from '../../src/utils/latexToRichText';
import { extractAssistantResponseMarkdown, toScreenReaderText } from './screenReaderAnnouncements';
import { finalAnswerText } from './selectionChatComment';

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

/** Long enough to search a long answer, short enough that a hundred of them stay cheap. */
const MAX_ANSWER_CHARS = 20_000;
const MAX_QUESTION_CHARS = 1_000;
const MAX_ERROR_CHARS = 140;

/** What a table in an answer becomes: named, rather than flattened into a run of cells. */
export const TABLE_LABEL = '(table)';

const WRITE_TOOLS: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

/** A run that continues an earlier answer: the thread shows no request for it. */
function isContinuation(run: AgentRun): boolean {
    return run.user_prompt.is_resume === true && (run.user_prompt.content ?? '').length === 0;
}

/**
 * The run that asked the conversation's newest question — the last run, or
 * the run a trailing continuation continues.
 */
export function lastQuestionRunId(runs: readonly AgentRun[]): string | undefined {
    for (let i = runs.length - 1; i >= 0; i--) {
        if (!isContinuation(runs[i])) return runs[i].id;
    }
    return undefined;
}

/** Shorten to `max` characters, marking the cut. */
export function clipText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A GFM table's delimiter row (`| --- | :---: |`), which a thematic break (`---`) is not. */
function isTableDelimiterRow(line: string): boolean {
    return line.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

/** Replace each markdown table with {@link TABLE_LABEL} on a line of its own. */
function nameTables(markdown: string): string {
    const lines = markdown.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('|') && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1])) {
            let end = i + 2;
            while (end < lines.length && lines[end].trim() !== '' && lines[end].includes('|')) end++;
            out.push('', TABLE_LABEL, '');
            i = end - 1;
            continue;
        }
        out.push(lines[i]);
    }
    return out.join('\n');
}

/** Where a converted formula waits while the markdown around it is stripped. */
const FORMULA_SLOT = /\uE000(\d+)\uE001/g;

/**
 * Answer markdown as one line of plain text: no markdown syntax, no citation
 * tags, formulas as characters (`|0⟩ ↔ |1⟩`, not `|0\rangle`), and a table
 * named rather than flattened.
 */
export function plainAnswerText(markdown: string): string {
    // Formulas are converted first and kept out of the stripping, which would
    // take the underscore out of `x_2` and the asterisk out of `x_2^*`.
    const formulas: string[] = [];
    const guarded = replaceMath(nameTables(markdown), (source) => `\uE000${formulas.push(mathToPlainText(source)) - 1}\uE001`);
    // A citation tag usually sits right before the full stop; without it the
    // stop would be left standing apart from its sentence.
    return toScreenReaderText(guarded)
        .replace(FORMULA_SLOT, (_slot, index: string) => formulas[Number(index)])
        .replace(/\s+([.,;:!?。，；：！？])/g, '$1');
}

interface RunSummary {
    answer: string;
    citations: number;
    changes: number;
}

/*
 * A finished run never changes, so its summary is computed once. The runs
 * atom hands back the same objects for finished runs on every streamed token,
 * which keeps rebuilding the turns as cheap as the one run still working.
 */
const runSummaries = new WeakMap<AgentRun, RunSummary>();

function countCitationTags(text: string): number {
    return text.match(/<citation\b/gi)?.length ?? 0;
}

function summarizeRun(run: AgentRun): RunSummary {
    const cached = runSummaries.get(run);
    if (cached) return cached;

    // The answer as the transcript's fold defines it; a run whose text all
    // came before its last tool call still says something, so fall back to
    // all of its text rather than to nothing.
    const markdown = finalAnswerText(run);
    const answer = plainAnswerText(markdown || extractAssistantResponseMarkdown(run)).slice(0, MAX_ANSWER_CHARS);

    const resolved = run.metadata?.citations;
    const citations = Array.isArray(resolved)
        ? resolved.filter((citation) => !citation.invalid).length
        : countCitationTags(markdown);

    let changes = 0;
    for (const message of run.model_messages ?? []) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts ?? []) {
            if (part && part.part_kind === 'tool-call' && WRITE_TOOLS.has(part.tool_name)) changes++;
        }
    }

    const summary = { answer, citations, changes };
    runSummaries.set(run, summary);
    return summary;
}

function statusOf(run: AgentRun): TurnStatus {
    switch (run.status) {
        case 'in_progress': return 'answering';
        case 'awaiting_deferred': return 'waiting';
        case 'error': return 'failed';
        case 'canceled': return 'stopped';
        default: return 'done';
    }
}

/** One short line saying why a run failed. */
function failureLine(run: AgentRun): string {
    const error = run.error;
    const message = error?.message
        ? toScreenReaderText(stripRunErrorTypePrefix(error.message, error.type))
        : '';
    const sentence = message.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? message;
    return `Failed: ${clipText(sentence || getRunErrorTitle(error?.type), MAX_ERROR_CHARS)}`;
}

function questionText(run: AgentRun): string {
    const prompt = run.user_prompt;
    const text = replaceMath(ensurePromptActionTokens(prompt.content ?? '', prompt.actions), mathToPlainText)
        .replace(/\s+/g, ' ')
        .trim();
    if (text) return clipText(text, MAX_QUESTION_CHARS);
    const attachments = prompt.attachments?.length ?? 0;
    if (attachments > 0) return attachments === 1 ? '1 attachment' : `${attachments} attachments`;
    return prompt.is_resume ? 'Continued answer' : 'Untitled question';
}

function changesLabel(count: number): string {
    return count === 1 ? '(1 library change)' : `(${count} library changes)`;
}

function toTurn(runs: AgentRun[], index: number): ConversationTurn {
    const first = runs[0];
    const last = runs[runs.length - 1];
    const status = statusOf(last);
    let answer: string;
    let citations = 0;

    if (status === 'answering') {
        answer = 'Answering…';
    } else if (status === 'waiting') {
        answer = 'Waiting for your approval…';
    } else {
        const summaries = runs.map(summarizeRun);
        citations = summaries.reduce((sum, summary) => sum + summary.citations, 0);
        const changes = summaries.reduce((sum, summary) => sum + summary.changes, 0);
        const text = summaries.map((summary) => summary.answer).filter(Boolean).join(' ');
        const written = changes > 0 ? `${text} ${changesLabel(changes)}`.trim() : text;
        if (status === 'failed') {
            answer = failureLine(last);
        } else if (written) {
            answer = written;
        } else if (status === 'stopped') {
            answer = isInterruptedRun(last) ? 'Cut off before it answered.' : 'Stopped before it answered.';
        } else {
            answer = 'No written answer.';
        }
    }

    return {
        runId: first.id,
        index,
        question: questionText(first),
        answer,
        status,
        createdAt: first.created_at,
        citations,
    };
}

/** The conversation's questions, in order. */
export function buildConversationTurns(runs: readonly AgentRun[]): ConversationTurn[] {
    const groups: AgentRun[][] = [];
    const groupByRunId = new Map<string, AgentRun[]>();
    for (const run of runs) {
        if (isContinuation(run)) {
            const continued = groupByRunId.get(run.user_prompt.resumes_run_id ?? '')
                ?? groups[groups.length - 1];
            if (continued) {
                continued.push(run);
                groupByRunId.set(run.id, continued);
                continue;
            }
        }
        const group = [run];
        groups.push(group);
        groupByRunId.set(run.id, group);
    }
    return groups.map((group, index) => toTurn(group, index));
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
