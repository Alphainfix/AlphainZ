/**
 * Load a thread's history from the local database.
 *
 * `loadThreadRuns` in agent-core fetches over REST — Beaver kept run history on
 * its server. With the model running here, this install is the only place the
 * transcript exists, so reopening a thread has to read it back off disk.
 *
 * The shape returned matches the shared loader's exactly, including the
 * `onToolReturn` walk, so the caller cannot tell the two apart.
 *
 * Agent actions — what a run proposed and what became of it (applied,
 * rejected, undone, waiting for review) — are stored inside the run they
 * belong to, under `agent_actions`, and come back as the loader's
 * `agentActions`. Without them a reopened thread would show each write as a
 * bare tool row: no Applied mark, no Undo, and a Retry that knows of nothing
 * to undo.
 */

import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import type { LoadedThreadRuns, ToolReturnHandler } from '@beaver/agent-core/run-state/loadThreadRuns';
import type { Citation } from '@beaver/agent-core/types/citations';
import { logger } from '@beaver/agent-core/platform/logger';

/** The field of a stored run payload that carries the run's agent actions. */
export const STORED_AGENT_ACTIONS_FIELD = 'agent_actions';

/**
 * What the database is known to hold for each run's agent actions, as last
 * read here or written by the run-saving path.
 *
 * Putting a thread's stored actions on screen changes the in-memory list
 * without changing anything worth writing back, so the saving path compares
 * against this before it re-saves a run.
 */
const storedActionSignatures = new Map<string, string>();

/** The ids of the actions the database is known to hold for each run. */
const storedActionIds = new Map<string, Set<string>>();

/**
 * A compact fingerprint of a run's actions: which records exist and the state
 * each is in. Enough to tell a new record or a status change (applied, undone,
 * rejected, failed) from the same list read back.
 */
export function agentActionsSignature(actions: readonly AgentAction[]): string {
    return actions
        .map((action) => `${action.id}\u0000${action.status}\u0000${action.error_message ?? ''}`)
        .join('\u0001');
}

/** Record that the database now holds exactly these actions for `runId`. */
export function noteStoredAgentActions(runId: string, actions: readonly AgentAction[]): void {
    storedActionSignatures.set(runId, agentActionsSignature(actions));
    storedActionIds.set(runId, new Set(actions.map((action) => action.id)));
}

/** Whether these actions differ from what the database is known to hold for `runId`. */
export function differsFromStoredAgentActions(runId: string, actions: readonly AgentAction[]): boolean {
    return storedActionSignatures.get(runId) !== agentActionsSignature(actions);
}

/**
 * Whether any of these actions is a record the database is not known to hold
 * for `runId` — a decision recorded since it was read, rather than the stored
 * copy with its statuses brought up to date.
 */
export function includesUnstoredAgentActions(runId: string, actions: readonly AgentAction[]): boolean {
    const stored = storedActionIds.get(runId);
    return actions.some((action) => !stored?.has(action.id));
}

/**
 * The thread each run is stored under, for runs read or written this session.
 *
 * What the user decides about a proposal can be recorded after they have
 * opened another conversation, and it is stored into its own run, found
 * through its thread.
 */
const storedRunThreads = new Map<string, string>();

/** Record that `runId` is stored under `threadId`. */
export function noteStoredRunThread(runId: string, threadId: string): void {
    storedRunThreads.set(runId, threadId);
}

/** The thread `runId` is stored under, when this session has read or written it. */
export function storedRunThread(runId: string): string | null {
    return storedRunThreads.get(runId) ?? null;
}

/** Forget what is known about a stored run (its row was deleted). */
export function forgetStoredRun(runId: string): void {
    storedActionSignatures.delete(runId);
    storedActionIds.delete(runId);
    storedRunThreads.delete(runId);
}

/** What the run-saving path needs to know about reads. */
export interface LocalRunStorageHooks {
    /**
     * Waited on before a thread is read, so the writes the saving path has
     * queued — an answer that just ended, a decision recorded a moment ago —
     * are in the database by then.
     */
    beforeRead?: () => Promise<void>;
    /**
     * Told each time a thread's stored actions are read, so the saving path
     * follows changes to them from then on.
     */
    afterRead?: () => void;
}

let storageHooks: LocalRunStorageHooks = {};

export function setLocalRunStorageHooks(hooks: LocalRunStorageHooks): void {
    storageHooks = hooks;
}

/** The actions stored with one run, or an empty list for a run saved without any. */
function storedActionsOf(run: AgentRun): AgentAction[] {
    const stored = (run as unknown as Record<string, unknown>)[STORED_AGENT_ACTIONS_FIELD];
    if (!Array.isArray(stored)) return [];
    // Stamped with the run it is stored under: a record written before every
    // action carried its run id would otherwise belong to no run on screen.
    return stored
        .filter((action): action is AgentAction => !!action && typeof action === 'object' && typeof action.id === 'string')
        .map((action) => ({ ...action, run_id: action.run_id || run.id }));
}

/**
 * A run as history keeps it: without the live previews of tool-call arguments.
 *
 * While a call's arguments stream in, its part carries a preview parsed from
 * the partial text (`streaming_args`), and the note views prefer that preview
 * to the call's real arguments. A run stored with one — saved while a call was
 * still arriving, or with the preview left on a call that had finished — would
 * show the half-written preview for good instead of what the call did.
 */
function withoutArgumentPreviews(run: AgentRun): AgentRun {
    let changed = false;
    const model_messages = (run.model_messages ?? []).map((message) => {
        if (message.kind !== 'response') return message;
        let partsChanged = false;
        const parts = message.parts.map((part) => {
            if (part.part_kind !== 'tool-call' || !('streaming_args' in part)) return part;
            partsChanged = true;
            const { streaming_args: _preview, ...rest } = part;
            return rest;
        });
        if (!partsChanged) return message;
        changed = true;
        return { ...message, parts };
    });
    return changed ? { ...run, model_messages } : run;
}

export async function loadLocalThreadRuns(
    threadId: string,
    options?: { onToolReturn?: ToolReturnHandler },
): Promise<LoadedThreadRuns> {
    const db = (Zotero as any).AlphainZ?.db;
    if (!db?.getRunsForThread) {
        logger('loadLocalThreadRuns: no local database available', 1);
        return { runs: [], citations: [], agentActions: null };
    }

    await storageHooks.beforeRead?.();
    const stored: AgentRun[] = await db.getRunsForThread(threadId);

    // The actions travel beside the runs rather than inside them: the store
    // keeps them in their own list, and a run object left carrying a stale
    // copy would write that copy back the next time the run is saved.
    const agentActions: AgentAction[] = [];
    const withoutActions = stored.map((run) => {
        const actions = storedActionsOf(run);
        noteStoredAgentActions(run.id, actions);
        noteStoredRunThread(run.id, threadId);
        agentActions.push(...actions);
        if (!(STORED_AGENT_ACTIONS_FIELD in (run as object))) return run;
        const { [STORED_AGENT_ACTIONS_FIELD]: _stored, ...rest } = run as unknown as Record<string, unknown>;
        return rest as unknown as AgentRun;
    });
    storageHooks.afterRead?.();

    // A run left `in_progress` was interrupted by whatever ended the last
    // session; presenting it as still running would show a spinner that can
    // never resolve.
    const runs = withoutActions.map(withoutArgumentPreviews).map((run) =>
        run.status === 'in_progress'
            ? {
                  ...run,
                  status: 'canceled' as const,
                  completed_at: run.completed_at || new Date().toISOString(),
              }
            : run,
    );

    const citations: Citation[] = runs.flatMap((run) =>
        (run.metadata?.citations || []).map((citation: Citation) => ({
            ...citation,
            run_id: run.id,
        })),
    );

    const onToolReturn = options?.onToolReturn;
    if (onToolReturn) {
        // Tool returns are hydrated from the originating call's arguments, so
        // the args have to be indexed before the walk.
        const argsByCallId = new Map<string, ToolCallPart['args']>();
        for (const run of runs) {
            for (const message of run.model_messages ?? []) {
                if (message.kind !== 'response') continue;
                for (const part of message.parts) {
                    if (part.part_kind === 'tool-call' && part.tool_call_id) {
                        argsByCallId.set(part.tool_call_id, part.args);
                    }
                }
            }
        }

        // Sequential, matching the shared loader: a handler may load host data
        // the next one reuses.
        for (const run of runs) {
            for (const message of run.model_messages ?? []) {
                if (message.kind !== 'request') continue;
                for (const part of message.parts) {
                    if (part.part_kind !== 'tool-return') continue;
                    await onToolReturn(part, argsByCallId.get(part.tool_call_id));
                }
            }
        }
    }

    // `null` rather than an empty list when nothing was stored, matching what
    // the shared loader reports for a thread with no actions to reconcile.
    return { runs, citations, agentActions: agentActions.length > 0 ? agentActions : null };
}
