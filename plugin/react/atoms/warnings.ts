/**
 * Warning atoms for managing transient, dismissable warnings.
 * 
 * Warnings are different from errors:
 * - They don't block the response
 * - They can be dismissed by the user
 * - They are not persisted in the DB
 */

import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';

// =============================================================================
// Types
// =============================================================================

/** Data for low_credits warning */
export interface LowCreditsWarningData {
    remaining_credits: number;
    limit: number;
    remaining_percentage: number;
    purchased_credits: number;
}

/** Union of all warning data types */
export type WarningData = LowCreditsWarningData | Record<string, unknown>;

/** A warning associated with a run */
export interface RunWarning {
    /** Unique ID for this warning instance */
    id: string;
    /** The run this warning is associated with */
    run_id: string;
    /** Warning type identifier (e.g., 'low_credits') */
    type: string;
    /** User-friendly message from the backend */
    message: string;
    /** Additional data specific to the warning type */
    data?: WarningData;
    /** Timestamp when the warning was received */
    created_at: string;
    /**
     * Closed by the user. Only a once-per-chat warning is kept after that, so
     * that a later answer in the same chat does not bring it back.
     */
    dismissed?: boolean;
}

/**
 * How much a warning asks of the user, which decides how it looks.
 *
 * - `notice`: a standing condition worth knowing, not a fault in this answer —
 *   topic search being unavailable. A quiet line under the answer, once per chat.
 * - `warning`: something about this answer the user may want to act on — it was
 *   cut off, hit the step limit, came back empty or was filtered.
 * - `error`: something the user approved did not happen — a change that could
 *   not be applied.
 */
export type WarningTone = 'notice' | 'warning' | 'error';

const NOTICE_TYPES = new Set(['semantic_search_unavailable']);
const ERROR_TYPES = new Set(['write_failed']);

/**
 * Warnings shown once per chat, whatever their text: topic search failing
 * says the same thing to the user on every answer that searched, even when the
 * provider's reason changes between them, and the user asked to be told once.
 */
const ONCE_PER_CHAT_TYPES = new Set(['semantic_search_failed']);

export function warningTone(type: string): WarningTone {
    if (NOTICE_TYPES.has(type)) return 'notice';
    if (ERROR_TYPES.has(type)) return 'error';
    return 'warning';
}

/** Two copies of a notice are the same notice when type and text agree; a changed reason is a new one. */
function noticeKey(warning: Pick<RunWarning, 'type' | 'message'>): string {
    return `${warning.type}\u0000${warning.message}`;
}

/**
 * The warnings each run shows, by run id, for runs listed oldest first.
 *
 * A notice comes with every answer for as long as its condition lasts, so only
 * the earliest of these runs that carries it shows it, and one the user
 * dismissed stays hidden. A once-per-chat warning shows on the first answer
 * that carries it and on no later one, dismissed or not. Warnings of the other
 * tones belong to their own answer and always show there. Credit info has its
 * own bar above the composer.
 */
export function selectRunWarnings(
    runIds: readonly string[],
    warnings: readonly RunWarning[],
    dismissedNotices: ReadonlySet<string>,
): Record<string, RunWarning[]> {
    const byRun = new Map<string, RunWarning[]>();
    for (const warning of warnings) {
        if (warning.type === 'credit_info') continue;
        const own = byRun.get(warning.run_id);
        if (own) own.push(warning);
        else byRun.set(warning.run_id, [warning]);
    }

    const shownNotices = new Set<string>();
    const shownOnce = new Set<string>();
    const result: Record<string, RunWarning[]> = {};
    for (const runId of runIds) {
        const own = byRun.get(runId);
        if (!own) continue;
        const visible = own.filter((warning) => {
            if (ONCE_PER_CHAT_TYPES.has(warning.type)) {
                if (shownOnce.has(warning.type)) return false;
                shownOnce.add(warning.type);
                return !warning.dismissed;
            }
            if (warningTone(warning.type) !== 'notice') return true;
            const key = noticeKey(warning);
            if (dismissedNotices.has(key) || shownNotices.has(key)) return false;
            shownNotices.add(key);
            return true;
        });
        if (visible.length > 0) result[runId] = visible;
    }
    return result;
}

// =============================================================================
// Atoms
// =============================================================================

/** All warnings for the current session (keyed by warning id) */
export const threadWarningsAtom = atom<RunWarning[]>([]);

/** Add a warning to the session */
export const addWarningAtom = atom(
    null,
    (_get, set, params: { run_id: string; type: string; message: string; data?: Record<string, unknown> }) => {
        const warning: RunWarning = {
            id: uuidv4(),
            run_id: params.run_id,
            type: params.type,
            message: params.message,
            data: params.data,
            created_at: new Date().toISOString(),
        };
        set(threadWarningsAtom, (prev) => [...prev, warning]);
    }
);

/**
 * Notices the user dismissed this session, by type and text. The same notice
 * arriving with a later answer, in this chat or another, stays hidden.
 */
export const dismissedNoticesAtom = atom<ReadonlySet<string>>(new Set<string>());

/** Dismiss (remove) a warning by its ID; a dismissed notice is also remembered. */
export const dismissWarningAtom = atom(
    null,
    (get, set, warningId: string) => {
        const warning = get(threadWarningsAtom).find((w) => w.id === warningId);
        if (warning && ONCE_PER_CHAT_TYPES.has(warning.type)) {
            set(threadWarningsAtom, (prev) => prev.map((w) => (w.id === warningId ? { ...w, dismissed: true } : w)));
            return;
        }
        if (warning && warningTone(warning.type) === 'notice') {
            set(dismissedNoticesAtom, (prev) => new Set(prev).add(noticeKey(warning)));
        }
        set(threadWarningsAtom, (prev) => prev.filter((w) => w.id !== warningId));
    }
);

/**
 * The open chat's run ids, oldest first, as one string: it changes when a run
 * is added or removed, not with every streamed token of the active run.
 */
const chatRunIdsAtom = atom((get) => get(allRunsAtom).map((run) => run.id).join('\n'));

/** The warnings each run of the open chat shows, by run id (see `selectRunWarnings`). */
export const runWarningsForDisplayAtom = atom((get) => {
    const runIds = get(chatRunIdsAtom);
    return selectRunWarnings(
        runIds ? runIds.split('\n') : [],
        get(threadWarningsAtom),
        get(dismissedNoticesAtom),
    );
});

/** Clear all warnings (e.g., when starting a new thread) */
export const clearWarningsAtom = atom(
    null,
    (_get, set) => {
        set(threadWarningsAtom, []);
    }
);

/** Get warnings for a specific run */
export const warningsForRunAtom = atom((get) => {
    const warnings = get(threadWarningsAtom);
    return (runId: string) => warnings.filter((w) => w.run_id === runId);
});

