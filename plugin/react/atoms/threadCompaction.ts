/**
 * The current thread's rolling summary, and the machinery that maintains it.
 *
 * Compaction is fully automatic: after a run persists, `maybeCompactThread`
 * checks whether enough old runs have piled up (or the last request got
 * heavy), summarises them on the conversation's own model, and stores the
 * result on the thread. The stored runs and the visible history never change —
 * only what the next request replays.
 *
 * Everything here fails quiet: a summary that cannot be produced leaves the
 * thread exactly as it was, which is the behaviour the plugin always had.
 */

import { atom } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';

import { store } from '../store';
import { getPref } from '../../src/utils/prefs';
import { buildAgentFromPrefs, currentModelContextWindow } from '../../src/services/llm/agentConfig';
import {
    KEEP_RECENT_RUNS,
    buildCompactionInput,
    compactionThreshold,
    generateThreadSummary,
    planCompaction,
    type CompactableRun,
} from '../../src/services/llm/threadCompaction';
import type { ThreadCompaction } from '../../src/services/database';
import { getConversationBackend } from '../../src/services/conversationSync';
import { getFirstRequestInputTokens } from '../utils/runUsage';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { t, tn } from '../../src/utils/i18n';

/**
 * The open thread's compaction record, hydrated on thread load and cleared on
 * a new thread. The wire path reads this synchronously when building the next
 * request.
 */
export const threadCompactionAtom = atom<ThreadCompaction | null>(null);

/** One summary at a time per thread — a second pass over the same runs would race the first. */
const compactionInFlight = new Set<string>();

interface DbLike {
    threadCompaction?: (userId: string, threadId: string) => Promise<ThreadCompaction | null | undefined>;
    setThreadCompaction?: (userId: string, threadId: string, c: ThreadCompaction | null) => Promise<void>;
    getRunsForThread: (threadId: string) => Promise<any[]>;
}

/**
 * Load the stored record into the atom when a thread opens.
 *
 * Applied only while that thread is still the open one: two quick thread
 * switches leave two hydrations in flight, and the slower must not land its
 * record on top of the newer thread.
 */
export async function hydrateThreadCompaction(db: DbLike | null, userId: string, threadId: string): Promise<void> {
    try {
        const record = await db?.threadCompaction?.(userId, threadId);
        if (store.get(currentThreadIdAtom) !== threadId) return;
        store.set(threadCompactionAtom, record ?? null);
    } catch (error) {
        logger(`threadCompaction: hydrate failed: ${error}`, 1);
        if (store.get(currentThreadIdAtom) === threadId) {
            store.set(threadCompactionAtom, null);
        }
    }
}

/**
 * Discard the thread's summary. The next request goes back to the plain
 * replay window; the summarised runs were never gone from storage.
 */
export async function discardThreadCompaction(db: DbLike | null, userId: string, threadId: string): Promise<boolean> {
    try {
        await db?.setThreadCompaction?.(userId, threadId, null);
        store.set(threadCompactionAtom, null);
        void getConversationBackend()?.writeThread(db as any, userId, threadId, new Date().toISOString());
        return true;
    } catch (error) {
        logger(`threadCompaction: discard failed: ${error}`, 1);
        return false;
    }
}

/**
 * The newest run that reports its token usage.
 *
 * The newest stored row is not always it: a question is stored the moment it
 * is sent, and a stopped turn is kept, and neither has usage to read — taking
 * it would skip the token trigger for that pass.
 */
export function newestRunWithUsage(runs: readonly any[]): { total_usage: any } | null {
    for (let i = runs.length - 1; i >= 0; i--) {
        if (runs[i]?.total_usage) return runs[i];
    }
    return null;
}

/**
 * Compact the thread when it has earned it. Fire-and-forget from the
 * persistence path; every failure leaves the thread untouched.
 *
 * `force` bypasses the thresholds (dev tooling) but never the keep-window.
 */
export async function maybeCompactThread(
    db: DbLike | null,
    userId: string,
    threadId: string,
    options: { force?: boolean } = {},
): Promise<'compacted' | 'skipped' | 'failed'> {
    if (!db?.setThreadCompaction) return 'skipped';
    if (!options.force && getPref('contextCompactionEnabled') !== true) return 'skipped';
    if (compactionInFlight.has(threadId)) return 'skipped';
    compactionInFlight.add(threadId);
    try {
        const existing = (await db.threadCompaction?.(userId, threadId)) ?? null;
        const rows = await db.getRunsForThread(threadId);
        const runs = (rows as any[]).filter(
            (run) => run?.status !== 'error' && run?.status !== 'canceled',
        ) as CompactableRun[];

        // The FIRST request of the newest answered run is system prompt +
        // summary + history + context — the exact weight compaction removes.
        // The last request would also count in-run tool results, which a heavy
        // reading turn inflates and a summary cannot shrink.
        const last = newestRunWithUsage(rows as any[]);
        const firstTokens = last ? getFirstRequestInputTokens(last.total_usage) : null;

        const storedThreshold = Number(getPref('contextCompactionThreshold'));
        const threshold = compactionThreshold(
            Number.isFinite(storedThreshold) && storedThreshold > 0 ? storedThreshold : undefined,
            currentModelContextWindow(),
        );
        const storedAfter = Number(getPref('contextCompactionAfterRuns'));
        const afterRuns = Number.isFinite(storedAfter) && storedAfter >= 4
            ? storedAfter
            : undefined;
        let plan = planCompaction(runs, existing, firstTokens, threshold, afterRuns);
        if (!plan && options.force) {
            // Dev path: cover everything outside the keep-window, bypassing
            // both the count threshold and the batch floor, so a live test
            // does not need a 12-run thread.
            const cutIndex = existing ? runs.findIndex((r) => r.id === existing.throughRunId) : -1;
            const uncompacted = runs.slice(cutIndex + 1);
            const cover = uncompacted.slice(0, Math.max(0, uncompacted.length - KEEP_RECENT_RUNS));
            if (cover.length > 0) {
                plan = {
                    cover,
                    throughRunId: cover[cover.length - 1].id,
                    runCount: (existing?.runCount ?? 0) + cover.length,
                };
            }
        }
        if (!plan) return 'skipped';

        const config = buildAgentFromPrefs();
        if (!config.ok) return 'skipped';

        const input = buildCompactionInput(plan.cover, existing?.summary ?? null);
        const summary = await generateThreadSummary(config.provider, input);
        if (!summary) return 'failed';

        /*
         * The summary call took seconds; re-read before writing. A user who
         * clicked Discard in that window said "no summary" — resurrecting one
         * over their click would make the escape hatch unreliable.
         */
        const current = (await db.threadCompaction?.(userId, threadId)) ?? null;
        if ((current?.createdAt ?? null) !== (existing?.createdAt ?? null)) {
            logger('threadCompaction: record changed mid-pass — dropping this summary', 3);
            return 'skipped';
        }

        const record: ThreadCompaction = {
            summary,
            throughRunId: plan.throughRunId,
            createdAt: new Date().toISOString(),
            runCount: plan.runCount,
        };
        await db.setThreadCompaction(userId, threadId, record);

        // Only the open thread's atom is updated — a background thread's
        // record is picked up when it is next loaded.
        if (store.get(currentThreadIdAtom) === threadId) {
            store.set(threadCompactionAtom, record);
        }

        void getConversationBackend()?.writeThread(db as any, userId, threadId, new Date().toISOString());

        store.set(addPopupMessageAtom, {
            type: 'info',
            title: tn(plan.cover.length, 'Compacted {count} earlier exchange', 'Compacted {count} earlier exchanges'),
            text: t('The model now reads a summary of them instead. Click the marker in the chat to read or discard it.'),
            expire: true,
            duration: 5000,
        });
        return 'compacted';
    } catch (error) {
        logger(`threadCompaction: ${error}`, 1);
        return 'failed';
    } finally {
        compactionInFlight.delete(threadId);
    }
}
