/**
 * A rolling summary standing in for a conversation's oldest turns.
 *
 * History replay stops at `maxPriorRuns` (10), so before this existed the
 * eleventh-oldest exchange simply vanished from the model's view — silently.
 * Compaction turns that cliff into a summary: once enough old runs pile up,
 * they are summarised into one block that rides ahead of the remaining
 * history, and the covered runs stop being replayed. The runs themselves are
 * never touched — compaction changes what is SENT, not what is stored or
 * shown.
 *
 * The summary is produced by the conversation's own model, after the answer
 * is already on screen, so its latency costs nothing; every failure path
 * leaves the thread exactly as it was (the 10-run window), never a broken
 * request.
 */

import type { ChatProvider } from './types';
import { COMPACT_AT_WINDOW_SHARE } from './thinkingTiers';
import type { ThreadCompaction } from '../database';

/** Runs newer than this many are never compacted: the model keeps their full replay. */
export const KEEP_RECENT_RUNS = 4;

/**
 * Compact once MORE THAN this many uncompacted runs exist. At the default it
 * fires exactly when the 10-run replay window would start dropping the oldest
 * run — the summary picks it up (from storage) in the same pass, so nothing
 * is ever both un-replayed and un-summarised for long.
 */
export const COMPACT_AFTER_RUNS = 10;

/**
 * Also compact when a run's FIRST request carried this many input tokens —
 * that request is system prompt + history + context, the exact part a summary
 * shrinks. (The last request would count in-run tool results, which a heavy
 * reading turn inflates and compaction cannot reduce.)
 */
export const COMPACT_WHEN_REQUEST_TOKENS = 80_000;

/**
 * The request size at which a conversation is compacted: the user's threshold
 * (or the default), held under a share of the model's context window when the
 * window is known — a model with a small one would otherwise overflow long
 * before the threshold. A large window does not raise it: the threshold is
 * also what a long conversation costs to send again.
 */
export function compactionThreshold(setting: number | undefined, contextWindow: number | undefined): number {
    const base = setting ?? COMPACT_WHEN_REQUEST_TOKENS;
    return contextWindow ? Math.min(base, Math.floor(contextWindow * COMPACT_AT_WINDOW_SHARE)) : base;
}

/**
 * The token rule never compacts fewer than this many runs. Without a floor, a
 * standing-heavy thread would compact one run after every message — a summary
 * call per message is the failure mode this feature exists to avoid.
 */
export const COMPACT_MIN_BATCH = 3;

/**
 * The token rule also demands this much actual text in the runs it would
 * cover. A heavy first request whose weight is standing context (a fat
 * annotation preamble, a huge system prompt) re-fires forever, because
 * compaction cannot shrink what is regenerated every message — the only
 * defence is to check there is real replay weight to remove.
 */
export const COMPACT_MIN_COVER_CHARS = 8_000;

/** Per-run clipping for the summary prompt: the subject survives, the bulk does not. */
const CLIP_QUESTION_CHARS = 300;
const CLIP_ANSWER_CHARS = 900;

/** A summary that outgrows this failed at its one job. */
const MAX_SUMMARY_CHARS = 2400;

const PROMPT = [
    'Summarize the earlier part of this conversation between a user and a research assistant working inside their Zotero library.',
    'The summary will be the ONLY memory of these exchanges in future turns, so keep every fact that a follow-up question might rely on.',
    'Structure it as short sections: Topic; Key findings so far; Decisions and preferences the user stated; Open questions.',
    'Keep paper titles, page numbers, and citation ids (like u-XXXXXXXX or W123456) exactly as written — they are how sources are referred to later.',
    'Write in the language the user wrote in. At most 250 words. Reply with the summary alone.',
].join(' ');

/** The slice of a stored run the summary prompt needs. */
export interface CompactableRun {
    id: string;
    user_prompt?: { content?: string } | null;
    model_messages?: Array<{ kind: string; parts: Array<Record<string, any>> }> | null;
}

/** All assistant prose of a run, concatenated. Thinking and tool traffic are not memory. */
export function runAnswerText(run: CompactableRun): string {
    const blocks: string[] = [];
    for (const message of run.model_messages ?? []) {
        if (message.kind !== 'response') continue;
        const text = (message.parts ?? [])
            .filter((part) => part?.part_kind === 'text' && typeof part.content === 'string')
            .map((part) => part.content as string)
            .join('')
            .trim();
        if (text) blocks.push(text);
    }
    return blocks.join('\n\n');
}

/**
 * The document the summariser reads: any prior summary first (so it rolls
 * forward instead of forgetting), then each newly covered exchange, clipped.
 */
export function buildCompactionInput(runs: CompactableRun[], priorSummary?: string | null): string {
    const sections: string[] = [];
    if (priorSummary && priorSummary.trim()) {
        sections.push(`[Existing summary of even earlier exchanges — carry its facts forward]\n${priorSummary.trim()}`);
    }
    runs.forEach((run, index) => {
        const question = String(run.user_prompt?.content ?? '').slice(0, CLIP_QUESTION_CHARS).trim();
        const answer = runAnswerText(run).slice(0, CLIP_ANSWER_CHARS).trim();
        if (!question && !answer) return;
        sections.push(`[Exchange ${index + 1}]\nUser: ${question || '(no text)'}\nAssistant: ${answer || '(no text)'}`);
    });
    return sections.join('\n\n');
}

/**
 * Ask the model for the summary. Returns null when it cannot produce a usable
 * one — the caller then simply leaves the thread uncompacted.
 */
export async function generateThreadSummary(
    provider: ChatProvider,
    input: string,
    signal?: AbortSignal,
): Promise<string | null> {
    const body = input.trim();
    if (!body) return null;

    let text = '';
    try {
        await provider.stream(
            {
                messages: [
                    { role: 'system', content: PROMPT },
                    { role: 'user', content: body },
                ],
                tools: [],
                signal,
            } as any,
            (event: any) => {
                if (event.type === 'text') text += event.text ?? '';
            },
        );
    } catch {
        return null;
    }

    const summary = text.trim();
    if (summary.length < 40) return null;
    return summary.length > MAX_SUMMARY_CHARS
        ? `${summary.slice(0, MAX_SUMMARY_CHARS).trim()}…`
        : summary;
}

/**
 * Should this thread be compacted now, and if so through which run?
 *
 * `runs` is the thread's full run list, oldest first, completed runs only.
 * Returns the runs to newly cover and the cutoff, or null when there is
 * nothing worth doing.
 */
export function planCompaction(
    runs: CompactableRun[],
    existing: ThreadCompaction | null,
    firstRequestInputTokens: number | null,
    thresholdTokens: number = COMPACT_WHEN_REQUEST_TOKENS,
    afterRuns: number = COMPACT_AFTER_RUNS,
): { cover: CompactableRun[]; throughRunId: string; runCount: number } | null {
    if (runs.length <= KEEP_RECENT_RUNS) return null;

    // Runs already covered by the standing summary stay covered; the new pass
    // extends it. A cutoff id we cannot find means the covered runs are not in
    // this list (imported divergence) — treat everything present as new.
    const cutIndex = existing
        ? runs.findIndex((run) => run.id === existing.throughRunId)
        : -1;
    const uncompacted = runs.slice(cutIndex + 1);
    const compactable = uncompacted.slice(0, Math.max(0, uncompacted.length - KEEP_RECENT_RUNS));
    if (compactable.length === 0) return null;

    const coverChars = compactable.reduce(
        (total, run) =>
            total
            + String(run.user_prompt?.content ?? '').length
            + runAnswerText(run).length,
        0,
    );
    const heavy = firstRequestInputTokens != null
        && firstRequestInputTokens > thresholdTokens
        && compactable.length >= COMPACT_MIN_BATCH
        && coverChars >= COMPACT_MIN_COVER_CHARS;
    if (uncompacted.length <= afterRuns && !heavy) return null;

    return {
        cover: compactable,
        throughRunId: compactable[compactable.length - 1].id,
        // A cutoff this machine has never seen means the old count refers to
        // runs that may be in this very list — adding them again would double
        // count. Start the count over; the rolled-forward summary text still
        // carries the earlier machine's facts.
        runCount: (cutIndex >= 0 ? (existing?.runCount ?? 0) : 0) + compactable.length,
    };
}
