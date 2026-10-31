/**
 * Dev-only HTTP handlers for driving the chat/run lifecycle headlessly.
 *
 * The chat input is a Lexical contenteditable that cannot be reliably driven by
 * synthetic events, so there is no robust UI path for an automated agent to send
 * a message. These handlers instead trigger the *real* send/approval/undo path by
 * writing the same Jotai action atoms the UI writes — nothing is mocked. A send
 * runs the full WebSocket pipeline against the real backend and model (and bills
 * real credits), exactly as if a user had typed the message.
 *
 * Endpoints (wired in `useHttpEndpoints.ts` → `registerEndpoints()`):
 *
 *   /beaver/test/new-thread     start a fresh thread (no confirm modal)
 *   /beaver/test/chat-send      stage attachments + send a message (+ optional pills),
 *                               optionally wait until the run settles
 *   /beaver/test/current-ids    read thread id / active run id / pending state
 *   /beaver/test/load-thread    reopen an existing thread by id (for history re-validation)
 *   /beaver/test/list-threads   the conversation history as the two list views read it
 *   /beaver/test/list-actions   enumerate pending approvals + applied/rejected actions
 *   /beaver/test/approve-action approve or reject a pending write approval
 *   /beaver/test/confirm-credits continue or skip a pending credit confirmation
 *   /beaver/test/undo-action    undo an applied action
 *
 * All are gated behind the same authenticated-only registration as the rest of
 * the dev endpoints, and only registered in development builds.
 */

import { store } from '../../store';
import { runWarningsForDisplayAtom, type RunWarning } from '../../atoms/warnings';
import { autoRetryErroredRunAtom } from '../../atoms/agentRunAtoms';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import {
    localRecentThreads,
    localSearchThreads,
    localThreadsForItem,
} from '../../atoms/loadLocalThreads';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { sendComposedMessageAtom } from '../../atoms/actions';
import {
    newThreadAtom,
    loadThreadAtom,
    currentThreadIdAtom,
    currentThreadNameAtom,
} from '../../atoms/threads';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    isWSChatPendingAtom,
    sendApprovalResponseAtom,
    sendCreditConfirmationResponseAtom,
} from '../../atoms/agentRunAtoms';
import {
    pendingCreditConfirmationsAtom,
    type PendingCreditConfirmation,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    pendingApprovalsAtom,
    threadAgentActionsAtom,
    undoAgentActionAtom,
    type AgentAction,
} from '../../agents/agentActions';
import type { PendingApproval } from '@beaver/agent-ui/host';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { sendAskUserQuestionResponseAtom } from '../../atoms/agentRunAtoms';
import {
    currentMessageItemsAtom,
    currentMessageCollectionsAtom,
} from '../../atoms/messageComposition';
import { userIdAtom, isAuthenticatedAtom, LOCAL_USER_ID } from '../../atoms/auth';
import { type CollectionReference } from '@beaver/agent-core/types/zotero';
import { collectionToReference } from '../../utils/zoteroReferences';
import { resolveItemReference } from '../../../src/utils/libraryIdentity';
import { undoEditMetadataAction } from '../../utils/editMetadataActions';
import { undoCreateCollectionAction } from '../../utils/createCollectionActions';
import { undoOrganizeItemsAction } from '../../utils/organizeItemsActions';
import { undoManageTagsAction } from '../../utils/manageTagsActions';
import { undoManageCollectionsAction } from '../../utils/manageCollectionsActions';
import { undoCreateNoteAction } from '../../utils/createNoteActions';
import { undoEditNoteAction, undoEditNoteBatchAction } from '../../utils/editNoteActions';
import { undoCreateAnnotationsAction } from '../../utils/createAnnotationsActions';
import { undoCreateItemActions } from '../../utils/createItemActions';
import { undoEditAnnotationsAction } from '../../utils/editAnnotationsActions';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** setTimeout via the main window (globals aren't guaranteed in this context). */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const win = Zotero.getMainWindow();
        (win?.setTimeout ?? setTimeout)(resolve, ms);
    });
}

/** Typed accessors — jotai's `store.get` widens these atoms' element types. */
function pendingApprovalList(): PendingApproval[] {
    const map: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);
    return Array.from(map.values());
}
function threadActions(): AgentAction[] {
    return store.get(threadAgentActionsAtom) as AgentAction[];
}

/** Serialize a pending approval for the wire (no live Zotero objects). */
function serializeApproval(a: PendingApproval) {
    return {
        actionId: a.actionId,
        toolcallId: a.toolcallId,
        actionType: a.actionType,
        // What the card is actually asking about. Without it a headless driver
        // can only count approvals, not check that the right thing is on them —
        // which is the part worth asserting.
        actionData: (a as any).actionData ?? (a as any).action_data ?? null,
    };
}

/** Snapshot of thread/run/approval identity — the return shape of /current-ids. */
function currentIds() {
    const activeRun = store.get(activeRunAtom);
    const runs = store.get(threadRunsAtom);
    const approvals: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);
    const questions: Map<string, unknown> = store.get(pendingQuestionsAtom);
    const creditConfirmations: Map<string, PendingCreditConfirmation> =
        store.get(pendingCreditConfirmationsAtom);
    return {
        threadId: store.get(currentThreadIdAtom),
        threadName: store.get(currentThreadNameAtom),
        activeRunId: activeRun?.id ?? null,
        activeRunStatus: activeRun?.status ?? null,
        isPending: store.get(isWSChatPendingAtom),
        runCount: runs.length,
        lastRunId: runs.length ? runs[runs.length - 1].id : null,
        // What each answer of the open chat shows under it, after the
        // once-per-chat rules: the warnings a reader would see.
        warnings: Object.fromEntries(Object.entries(store.get(runWarningsForDisplayAtom) as Record<string, RunWarning[]>)
            .map(([runId, list]) => [runId, list.map((w) => ({ type: w.type, message: w.message }))])),
        pendingApprovals: Array.from(approvals.values()).map(serializeApproval),
        // The whole question, not just its key: a driver that can only see
        // that *a* question is pending cannot check the model asked a sensible
        // one, which is the part worth asserting.
        pendingQuestions: Array.from(questions.values()).map((q: any) => ({
            questionId: q.questionId,
            toolcallId: q.toolcallId,
            title: q.title ?? null,
            questions: (q.questions ?? []).map((item: any) => ({
                id: item.id,
                header: item.header ?? null,
                question: item.question,
                allowMultiple: item.allow_multiple === true,
                allowCustom: item.allow_custom === true,
                options: (item.options ?? []).map((o: any) => ({
                    id: o.id,
                    label: o.label,
                    description: o.description ?? null,
                })),
            })),
        })),
        pendingQuestionIds: Array.from(questions.keys()),
        pendingCreditConfirmations: Array.from(creditConfirmations.values()).map((c) => ({
            confirmationId: c.confirmationId,
            title: c.title,
            message: c.message,
            footer: c.footer,
            pendingCredits: c.pendingCredits,
            projectedTotalCredits: c.projectedTotalCredits,
        })),
    };
}

type SettleReason = 'done' | 'approval' | 'question' | 'credit-confirmation' | 'timeout';

/**
 * Poll until the run settles: it finished streaming (`done`), paused for a write
 * approval (`approval`), paused for an ask_user_question (`question`), paused for
 * a run-level credit confirmation (`credit-confirmation`), or the timeout
 * elapsed. A paused run keeps `isWSChatPendingAtom` true, so we must break on
 * every blocking state or we would block until timeout.
 */
async function waitForRunSettle(timeoutMs: number, pollMs = 300): Promise<SettleReason> {
    const start = Date.now();
    // The run being waited on: proposals outlive their run and chat, so only
    // this run's own count (and a socket approval, which carries no run).
    const runs = store.get(threadRunsAtom);
    const waitedRunId = store.get(activeRunAtom)?.id ?? runs[runs.length - 1]?.id ?? null;
    while (Date.now() - start < timeoutMs) {
        if (store.get(pendingQuestionsAtom).size > 0) return 'question';
        if (store.get(pendingCreditConfirmationsAtom).size > 0) return 'credit-confirmation';
        // A local run does not pause for its proposals: `approval` means the
        // run has ended with proposals of its own waiting on the user.
        if (!store.get(isWSChatPendingAtom)) {
            const waiting = [...store.get(pendingApprovalsAtom).values()]
                .some((approval: any) => !approval.runId || approval.runId === waitedRunId);
            return waiting ? 'approval' : 'done';
        }
        await sleep(pollMs);
    }
    return 'timeout';
}

/** Resolve `{library_id?, library_ref?, zotero_key}` refs to live Zotero items. */
async function resolveItems(
    refs: Array<{ library_id?: number; library_ref?: string; zotero_key: string }>,
): Promise<{ items: Zotero.Item[]; unresolved: any[] }> {
    const items: Zotero.Item[] = [];
    const unresolved: any[] = [];
    for (const ref of refs) {
        const result = await resolveItemReference({
            library_ref: ref.library_ref,
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
        });
        if (result.status === 'found') items.push(result.item);
        else unresolved.push({ ...ref, status: result.status });
    }
    return { items, unresolved };
}

/** Resolve `{library_id, collection_key}` refs to CollectionReferences. */
function resolveCollections(
    refs: Array<{ library_id: number; collection_key: string }>,
): { collections: CollectionReference[]; unresolved: any[] } {
    const collections: CollectionReference[] = [];
    const unresolved: any[] = [];
    for (const ref of refs) {
        const collection = Zotero.Collections?.getByLibraryAndKey?.(ref.library_id, ref.collection_key);
        if (collection) collections.push(collectionToReference(collection as Zotero.Collection));
        else unresolved.push({ ...ref, status: 'not_found' });
    }
    return { collections, unresolved };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Start a fresh thread. Passes `skipActiveRunConfirm`/`skipAutoPopulate` so it
 * never pops a `Zotero.Prompt.confirm` modal or auto-attaches the current Zotero
 * selection — a headless new thread is genuinely empty.
 */
export async function handleTestNewThreadHttpRequest(request: any) {
    await store.set(newThreadAtom, {
        skipActiveRunConfirm: true,
        skipAutoPopulate: request?.autoPopulate === true ? false : true,
    });
    return { ok: true, ...currentIds() };
}

/**
 * Stage optional attachments and send a message through the real WS pipeline.
 *
 * Body:
 *   text            required message text
 *   items           optional [{library_id|library_ref, zotero_key}] to attach
 *   collections     optional [{library_id, collection_key}] to attach
 *   pills           optional SlashCommandDescriptor[] (slash-command tokens)
 *   newThread       if true, start a fresh thread before sending
 *   waitForDone     default true — poll until the run settles
 *   timeoutMs       wait budget (default 180000)
 *
 * When `waitForDone` and the run pauses for an approval/question, the response's
 * `settle` is `"approval"`/`"question"` and `pendingApprovals` is populated —
 * call /approve-action, then poll /current-ids (or re-approve) to continue.
 */
export async function handleTestChatSendHttpRequest(request: any) {
    const text = request?.text;
    if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'text (non-empty string) is required' };
    }

    if (request?.newThread === true) {
        await store.set(newThreadAtom, { skipActiveRunConfirm: true, skipAutoPopulate: true });
    } else {
        // Continue a specific existing thread: load it first if it isn't already the
        // current one. Without this, the send targets whatever thread happens to be
        // current in the store (e.g. the last one reopened via load-thread), NOT the
        // requested `threadId`.
        const threadId = request?.threadId ?? request?.thread_id;
        if (typeof threadId === 'string' && threadId && store.get(currentThreadIdAtom) !== threadId) {
            const userId = request?.user_id ?? store.get(userIdAtom);
            if (!userId) {
                return { ok: false, error: 'No user_id to load requested threadId (not logged in?)' };
            }
            await store.set(loadThreadAtom, { user_id: userId, threadId, skipInstanceMismatchConfirm: true });
        }
    }

    if (store.get(isWSChatPendingAtom)) {
        return { ok: false, error: 'A run is already in progress; wait for it to settle', ...currentIds() };
    }

    // Stage attachments directly (deterministic — bypasses the background
    // validation the UI runs; the send path still drops excluded-library items).
    let unresolvedItems: any[] = [];
    let unresolvedCollections: any[] = [];
    if (Array.isArray(request?.items) && request.items.length > 0) {
        const { items, unresolved } = await resolveItems(request.items);
        unresolvedItems = unresolved;
        store.set(currentMessageItemsAtom, items);
    }
    if (Array.isArray(request?.collections) && request.collections.length > 0) {
        const { collections, unresolved } = resolveCollections(request.collections);
        unresolvedCollections = unresolved;
        store.set(currentMessageCollectionsAtom, collections);
    }

    const sent = await store.set(sendComposedMessageAtom, {
        baseText: text,
        pills: Array.isArray(request?.pills) ? request.pills : [],
    });

    if (!sent) {
        return {
            ok: false,
            error: 'Send was aborted (e.g. a staged item was rejected)',
            unresolvedItems,
            unresolvedCollections,
            ...currentIds(),
        };
    }

    let settle: SettleReason | null = null;
    if (request?.waitForDone !== false) {
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }

    return { ok: true, sent, settle, unresolvedItems, unresolvedCollections, ...currentIds() };
}

/** Read the current thread/run/approval identity. Poll this to detect completion. */
export async function handleTestCurrentIdsHttpRequest(_request: any) {
    return { ok: true, ...currentIds() };
}

/**
 * Dump the runs in the current thread, for diagnosing a run that produced
 * nothing. Development-only, like every other endpoint in this file.
 */
export async function handleTestDumpRunsHttpRequest(_request: any) {
    const runs = store.get(allRunsAtom) as any[];
    return {
        ok: true,
        count: runs.length,
        runs: runs.map((run) => ({
            id: run.id,
            thread_id: run.thread_id,
            status: run.status,
            error: run.error ?? null,
            prompt: run.user_prompt?.content?.slice(0, 120) ?? null,
            // What the run cost. Comparing models is guesswork without it.
            usage: run.total_usage
                ? {
                    requests: run.total_usage.requests,
                    tool_calls: run.total_usage.tool_calls,
                    input_tokens: run.total_usage.input_tokens,
                    output_tokens: run.total_usage.output_tokens,
                    // Re-sent context is the bulk of a tool-using run's input;
                    // whether the provider served it from cache is the
                    // difference between expensive and nearly free.
                    cache_read_tokens: run.total_usage.cache_read_tokens,
                    cache_write_tokens: run.total_usage.cache_write_tokens,
                }
                : null,
            // The citations as published — what a hover card shows and what a
            // click has to work with. `boxes` counts rectangles carried on the
            // citation itself; a sentence citation without any still resolves
            // them from the cache when clicked.
            citations: Array.isArray(run.metadata?.citations)
                ? run.metadata.citations.map((citation: any) => ({
                    raw_tag: citation.raw_tag ?? null,
                    pages: citation.pages ?? null,
                    loc: citation.loc ?? null,
                    preview: typeof citation.preview === 'string' ? citation.preview.slice(0, 240) : null,
                    boxes: Array.isArray(citation.locations)
                        ? citation.locations.reduce((n: number, l: any) => n + (l?.boxes?.length ?? 0), 0)
                        : 0,
                    invalid: citation.invalid === true,
                }))
                : null,
            messages: (run.model_messages ?? []).map((message: any) => ({
                kind: message.kind,
                parts: (message.parts ?? []).map((part: any) => ({
                    part_kind: part.part_kind,
                    tool_name: part.tool_name,
                    // Text is the thing being judged when comparing models, and
                    // 200 characters cut every answer off before its citations.
                    // Tool payloads stay short; nobody reads those from here.
                    preview:
                        typeof part.content === 'string'
                            ? part.content.slice(0, part.part_kind === 'text' ? 8000 : 200)
                            : part.content
                              ? JSON.stringify(part.content).slice(0, 200)
                              : null,
                })),
            })),
        })),
    };
}

/**
 * Reopen an existing thread by id (the "history re-validation" path). This is the
 * flow N8 exercises: after loading, applied actions must NOT flip to `undone`
 * merely from being viewed. `user_id` defaults to the logged-in Beaver user.
 */
export async function handleTestLoadThreadHttpRequest(request: any) {
    const threadId = request?.threadId ?? request?.thread_id;
    if (typeof threadId !== 'string' || !threadId) {
        return { ok: false, error: 'threadId is required' };
    }
    const userId = request?.user_id ?? store.get(userIdAtom);
    if (!userId) {
        return { ok: false, error: 'No user_id (not logged in?)' };
    }
    const loaded = await store.set(loadThreadAtom, {
        user_id: userId,
        threadId,
        threadName: request?.threadName,
        // Never hang headless drivers on the native other-instance confirm.
        skipInstanceMismatchConfirm: true,
    });
    return {
        ok: true,
        loaded,
        ...currentIds(),
        // Reported because a reopened thread used to come back without its
        // sources: the run text still held the raw citation tags, but the
        // resolved citations were live-only state that died with the panel.
        citations: store.get(citationsAtom).map((citation: any) => ({
            run_id: citation.run_id ?? null,
            display_name: citation.display_name ?? null,
            pages: citation.pages ?? null,
            invalid: citation.invalid ?? false,
        })),
        actions: threadActions().map((a) => ({
            id: a.id,
            action_type: a.action_type,
            status: a.status,
            run_id: a.run_id,
            toolcall_id: a.toolcall_id,
            // What the action actually did. Without it a driver can see that
            // something was applied but not what, or where — which is the half
            // worth asserting.
            result_data: (a as any).result_data ?? null,
            error_message: (a as any).error_message ?? null,
        })),
    };
}

/**
 * The conversation history, read through the same functions the UI reads.
 *
 * Worth its own endpoint because a list that renders empty and a list that has
 * nothing to render look identical from outside, and the difference is where
 * every bug in this area lives. Calls the real helpers rather than querying the
 * database, so a break in the query, the row mapping or the owner id shows up
 * here.
 *
 * Body: { query?, limit?, itemKey?, libraryId? }
 */
export async function handleTestListThreadsHttpRequest(request: any) {
    const limit = typeof request?.limit === 'number' ? request.limit : 20;
    const query = typeof request?.query === 'string' ? request.query.trim() : '';
    const summarize = (threads: any[]) =>
        threads.map((thread) => ({
            id: thread.id,
            name: thread.name ?? null,
            updated_at: thread.updatedAt ?? null,
        }));

    try {
        const recent = await localRecentThreads(limit);
        const searched = query ? await localSearchThreads(query, limit) : null;
        const forItem =
            request?.itemKey && request?.libraryId != null
                ? await localThreadsForItem(
                      Number(request.libraryId),
                      [String(request.itemKey)],
                      limit,
                  )
                : null;

        return {
            ok: true,
            recent: summarize(recent),
            recent_count: recent.length,
            ...(searched ? { search: summarize(searched), search_count: searched.length } : {}),
            ...(forItem ? { for_item: summarize(forItem), for_item_count: forItem.length } : {}),
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Retry a failed run, the same path the error card's Retry button takes.
 *
 * Worth an endpoint: retrying first removes the failed run and everything after
 * it, and locally that removal has no server to confirm it — the client used to
 * treat the missing confirmation as fatal and throw instead of retrying. That
 * is a button on every failed run, so it should be checkable without a click.
 *
 * Body: { runId?, waitForDone? }  — runId defaults to the thread's last errored run.
 */
export async function handleTestRetryRunHttpRequest(request: any) {
    const runs: AgentRun[] = store.get(threadRunsAtom);
    const runId =
        request?.runId ??
        [...runs].reverse().find((r) => r.status === 'error')?.id ??
        null;
    if (!runId) return { ok: false, error: 'No errored run to retry', ...currentIds() };

    const before = runs.length;
    await store.set(autoRetryErroredRunAtom, runId);

    const settle =
        request?.waitForDone === false
            ? 'not-awaited'
            : await waitForRunSettle(Number(request?.timeoutMs ?? 300_000));

    const after: AgentRun[] = store.get(threadRunsAtom);
    return {
        ok: true,
        retried: runId,
        settle,
        runs_before: before,
        runs_after: after.length,
        statuses: after.map((r) => r.status),
        ...currentIds(),
    };
}

/**
 * Delete conversations through the same call the list's delete button makes.
 *
 * Body: { threadId } for one, or { all: true } to clear the local history.
 * Only ever touches this plugin's database — Beaver's own file is a separate
 * store and is not opened here.
 */
export async function handleTestDeleteThreadsHttpRequest(request: any) {
    const { localDeleteThread, localRecentThreads } = await import('../../atoms/loadLocalThreads');
    const { LOCAL_USER_ID } = await import('../../atoms/auth');
    const owner = request?.userId ?? LOCAL_USER_ID;

    const ids: string[] = [];
    if (request?.all === true) {
        // Paged rather than one call: the pager caps a page, and a partial
        // "cleared everything" is worse than saying how many were found.
        for (;;) {
            const page = await localRecentThreads(100, owner, 0);
            const fresh = page.map((t) => t.id).filter((id) => !ids.includes(id));
            if (fresh.length === 0) break;
            ids.push(...fresh);
            for (const id of fresh) await localDeleteThread(id, owner);
        }
        return { ok: true, deleted: ids.length, remaining: (await localRecentThreads(5, owner)).length };
    }

    if (typeof request?.threadId !== 'string') {
        return { ok: false, error: 'Provide threadId, or all:true' };
    }
    await localDeleteThread(request.threadId, owner);
    const still = (await localRecentThreads(200, owner)).some((t) => t.id === request.threadId);
    return { ok: !still, deleted: still ? 0 : 1, still_present: still };
}

/** Enumerate pending approvals and the thread's applied/rejected/undone actions. */
export async function handleTestListActionsHttpRequest(_request: any) {
    return {
        ok: true,
        pendingApprovals: pendingApprovalList().map(serializeApproval),
        actions: threadActions().map((a) => ({
            id: a.id,
            action_type: a.action_type,
            status: a.status,
            error_message: a.error_message ?? null,
            // What it actually did, and where. A driver that can see only
            // "applied" cannot tell a write that landed where the user asked
            // from one that landed somewhere else.
            result_data: (a as any).result_data ?? null,
        })),
    };
}

/**
 * Approve or reject a pending write approval, unblocking the deferred tool.
 *
 * Body: { actionId?, approved (default true), all?, userInstructions?, waitForDone?, timeoutMs? }
 * With `all:true` (and no `actionId`) every currently-pending approval gets the
 * same verdict. When `waitForDone`, polls until the resumed run settles again.
 */
export async function handleTestApproveActionHttpRequest(request: any) {
    const approved = request?.approved !== false; // default true
    const pending: Map<string, PendingApproval> = store.get(pendingApprovalsAtom);

    let targetIds: string[];
    if (request?.all === true && !request?.actionId) {
        targetIds = Array.from(pending.keys());
    } else if (request?.actionId) {
        targetIds = [request.actionId];
    } else {
        // Default: the single pending approval, if unambiguous.
        if (pending.size === 0) return { ok: false, error: 'No pending approvals', ...currentIds() };
        if (pending.size > 1) {
            return {
                ok: false,
                error: 'Multiple pending approvals; pass actionId or all:true',
                pendingApprovals: Array.from(pending.values()).map(serializeApproval),
            };
        }
        targetIds = [Array.from(pending.keys())[0]];
    }

    for (const actionId of targetIds) {
        store.set(sendApprovalResponseAtom, {
            actionId,
            approved,
            userInstructions: request?.userInstructions ?? null,
        });
    }

    let settle: SettleReason | null = null;
    if (request?.waitForDone === true) {
        // Give the WS a moment to resume before polling settle state.
        await sleep(400);
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }

    return { ok: true, approved, actedOn: targetIds, settle, ...currentIds() };
}

/**
 * Answer the run-level credit confirmation so a headless run can continue.
 *
 * Body: { confirmationId?, approved (default true), waitForDone?, timeoutMs? }
 * The run pauses on this the same way it pauses on an approval, so a driver
 * that does not answer it waits out the backend's confirmation timeout and
 * then gets a run that wrapped up without its priced steps.
 */
export async function handleTestConfirmCreditsHttpRequest(request: any) {
    const approved = request?.approved !== false; // default true
    const pending: Map<string, PendingCreditConfirmation> = store.get(
        pendingCreditConfirmationsAtom,
    );

    if (pending.size === 0) {
        return { ok: false, error: 'No pending credit confirmation', ...currentIds() };
    }

    const confirmationId: string = request?.confirmationId ?? Array.from(pending.keys())[0];
    if (!pending.has(confirmationId)) {
        return { ok: false, error: `Unknown confirmationId: ${confirmationId}`, ...currentIds() };
    }

    store.set(sendCreditConfirmationResponseAtom, { confirmationId, approved });

    let settle: SettleReason | null = null;
    if (request?.waitForDone === true) {
        // Give the WS a moment to resume before polling settle state.
        await sleep(400);
        settle = await waitForRunSettle(
            typeof request?.timeoutMs === 'number' ? request.timeoutMs : 180000,
        );
    }

    return { ok: true, approved, actedOn: [confirmationId], settle, ...currentIds() };
}

/**
 * Undo an applied action. Mirrors the UI undo path (`AgentActionView.handleUndo`
 * / `useEditNoteActions.handleUndo`): first perform the Zotero-side revert via the
 * per-action-type undo helper, THEN flip UI + backend status via
 * `undoAgentActionAtom`. The state atom alone only changes status — it does NOT
 * revert the Zotero change — so dispatching by `action_type` here is required for
 * the revert to actually land in the library.
 */
export async function handleTestUndoActionHttpRequest(request: any) {
    const actionId = request?.actionId;
    if (typeof actionId !== 'string' || !actionId) {
        return { ok: false, error: 'actionId is required' };
    }
    const action = threadActions().find((a) => a.id === actionId);
    if (!action) {
        return { ok: false, error: `action ${actionId} not found in current thread (load the thread first)` };
    }
    let reverted: string | Record<string, unknown> = action.action_type;
    try {
        switch (action.action_type) {
            case 'edit_metadata': {
                const result = await undoEditMetadataAction(action, true); // force-revert manual edits
                reverted = { fieldsReverted: result.fieldsReverted };
                break;
            }
            case 'create_collection':
                await undoCreateCollectionAction(action);
                break;
            case 'organize_items':
                await undoOrganizeItemsAction(action);
                break;
            case 'manage_tags':
                await undoManageTagsAction(action);
                break;
            case 'manage_collections':
                await undoManageCollectionsAction(action);
                break;
            case 'zotero_note':
            case 'create_note':
                await undoCreateNoteAction(action);
                break;
            case 'edit_note':
                await undoEditNoteAction(action);
                break;
            case 'edit_note_batch':
                await undoEditNoteBatchAction(action);
                break;
            // Both edit_annotations and delete_annotations share this action type.
            case 'edit_annotations':
                await undoEditAnnotationsAction(action);
                break;
            case 'create_highlight_annotations':
            case 'create_note_annotations':
            case 'highlight_annotation':
            case 'note_annotation':
                await undoCreateAnnotationsAction(action);
                break;
            case 'create_item': {
                const batch = await undoCreateItemActions([action]);
                if (batch.failures.length > 0) {
                    return { ok: false, actionId, error: batch.failures[0].error };
                }
                break;
            }
            default:
                return { ok: false, actionId, error: `undo not supported for action_type ${action.action_type}` };
        }
    } catch (error: any) {
        return { ok: false, actionId, error: error?.message || 'undo failed' };
    }
    // Zotero revert succeeded — now flip UI + backend status.
    store.set(undoAgentActionAtom, actionId);
    const updated = threadActions().find((a) => a.id === actionId);
    return {
        ok: true,
        actionId,
        status: updated?.status ?? null,
        reverted,
    };
}


/**
 * Dev-only: answer (or skip) a pending ask_user_question, the way the card does.
 *
 * The question tool is the one that deliberately blocks the run, so a headless
 * driver that can raise a question but not answer one can only ever check that
 * the card appeared — never that the answer reaches the model and the run
 * carries on, which is the half that can break.
 *
 * `pick` selects option labels or ids per question; `custom` supplies the
 * free-text answer. Omit both and pass `skip: true` to test the skip path.
 */
export async function handleTestAnswerQuestionHttpRequest(request: any) {
    const questions: Map<string, any> = store.get(pendingQuestionsAtom);
    const pending = [...questions.values()];
    if (pending.length === 0) return { ok: false, error: 'No pending question' };

    const target = request?.toolcallId
        ? pending.find((q) => q.toolcallId === request.toolcallId)
        : pending[0];
    if (!target) return { ok: false, error: `No pending question for ${request.toolcallId}` };

    if (request?.skip === true) {
        store.set(sendAskUserQuestionResponseAtom, {
            questionId: target.questionId,
            toolcallId: target.toolcallId,
            answers: [],
            cancelled: true,
        });
        return { ok: true, skipped: true, ...currentIds() };
    }

    const wanted: string[] = Array.isArray(request?.pick) ? request.pick.map(String) : [];
    const answers = (target.questions ?? []).map((item: any) => {
        const matched = (item.options ?? [])
            .filter((option: any) => wanted.includes(option.id) || wanted.includes(option.label))
            .map((option: any) => option.id);
        // Default to the first option, which the tool tells the model to make
        // its recommendation — so a driver that does not care which answer it
        // gives still exercises a realistic one.
        const selected = matched.length > 0
            ? (item.allow_multiple ? matched : [matched[0]])
            : (item.options?.[0] ? [item.options[0].id] : []);
        return {
            item_id: item.id,
            selected_option_ids: selected,
            ...(request?.custom ? { custom_text: String(request.custom) } : {}),
        };
    });

    store.set(sendAskUserQuestionResponseAtom, {
        questionId: target.questionId,
        toolcallId: target.toolcallId,
        answers,
        cancelled: false,
    });
    return { ok: true, answers, ...currentIds() };
}

/**
 * Dev-only: import a local PDF as a standalone attachment, for benchmarking.
 *
 * Measuring placement across many papers needs many papers, and the only way
 * into the extractor is a Zotero attachment. Everything imported here is tagged
 * so one query can find and remove the lot again — a benchmark that leaves
 * residue in a real library is a benchmark you only get to run once.
 */
export async function handleTestImportPdfHttpRequest(request: any) {
    const path = String(request?.path ?? '');
    const tag = String(request?.tag ?? 'alphainz-bench');
    if (!path) return { ok: false, error: 'path is required' };
    if (!(await IOUtils.exists(path))) return { ok: false, error: `no such file: ${path}` };

    const libraryID = Zotero.Libraries.userLibraryID;
    const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        libraryID,
        title: String(request?.title ?? PathUtils.filename(path)),
    });
    attachment.addTag(tag);
    await attachment.saveTx();

    return {
        ok: true,
        attachment_id: `u-${attachment.key}`,
        library_id: libraryID,
        zotero_key: attachment.key,
        tag,
    };
}

/** Dev-only: trash everything a benchmark import left behind. */
export async function handleTestRemoveTaggedHttpRequest(request: any) {
    const tag = String(request?.tag ?? 'alphainz-bench');
    const search = new Zotero.Search();
    (search as any).libraryID = Zotero.Libraries.userLibraryID;
    search.addCondition('tag', 'is', tag);
    const ids: number[] = await search.search();
    const items = await Zotero.Items.getAsync(ids);
    for (const item of items) {
        item.deleted = true;
        await item.saveTx();
    }
    return { ok: true, trashed: items.length, tag };
}

/**
 * Dev-only: permanently erase test artifacts that are already in the trash.
 *
 * Trash-only on purpose: an item still in the library is never touched, so a
 * bad tag or key can at worst re-erase something the caller already trashed.
 * Goes through `eraseTx()` rather than SQL so Zotero writes its sync delete
 * log — a raw row delete on a zotero.org-synced profile resurrects on the
 * next sync.
 */
export async function handleTestEraseTrashedHttpRequest(request: any) {
    const libraryID = Number(request?.library_id ?? Zotero.Libraries.userLibraryID);
    const tags: string[] = Array.isArray(request?.tags) ? request.tags.map(String) : [];
    const keys: string[] = Array.isArray(request?.keys) ? request.keys.map(String) : [];
    if (tags.length === 0 && keys.length === 0) {
        return { ok: false, error: 'provide tags and/or keys' };
    }

    const candidates = new Map<number, Zotero.Item>();
    for (const tag of tags) {
        const search = new Zotero.Search();
        (search as any).libraryID = libraryID;
        search.addCondition('tag', 'is', tag);
        search.addCondition('includeDeleted', 'true');
        const ids: number[] = await search.search();
        for (const item of await Zotero.Items.getAsync(ids)) candidates.set(item.id, item);
    }
    for (const key of keys) {
        const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (item) candidates.set((item as Zotero.Item).id, item as Zotero.Item);
    }

    const erased: string[] = [];
    const skippedNotTrashed: string[] = [];
    for (const item of candidates.values()) {
        if (!item.deleted) {
            skippedNotTrashed.push(item.key);
            continue;
        }
        await item.eraseTx();
        erased.push(item.key);
    }
    return { ok: true, erased: erased.length, erased_keys: erased, skipped_not_trashed: skippedNotTrashed };
}

/**
 * Drive the chat-history list: open it, switch to the archive, archive or
 * restore a conversation.
 *
 * The archive is a list mode and a couple of row buttons, and neither can be
 * reached from a script — so without this the only way to know whether the
 * feature works was to ask the user to click it, which is how it shipped
 * broken.
 */
export async function handleTestThreadListHttpRequest(request: any) {
    const { isThreadListViewAtom } = await import('../../atoms/ui');
    const { showArchiveAtom, threadsChangedAtom } = await import('../../atoms/threads');
    const {
        localArchivedThreads, localDeleteThread, localRecentThreads, localRestoreThread,
    } = await import('../../atoms/loadLocalThreads');

    const owner = request?.userId ?? LOCAL_USER_ID;

    if (request?.open !== undefined) store.set(isThreadListViewAtom, !!request.open);
    if (request?.archive !== undefined) store.set(showArchiveAtom, !!request.archive);

    if (typeof request?.archiveThreadId === 'string') {
        await localDeleteThread(request.archiveThreadId, owner);
        store.set(threadsChangedAtom, (n: number) => n + 1);
    }
    if (typeof request?.restoreThreadId === 'string') {
        await localRestoreThread(request.restoreThreadId, owner);
        store.set(threadsChangedAtom, (n: number) => n + 1);
    }
    if (typeof request?.purgeThreadId === 'string') {
        const { localPurgeThread } = await import('../../atoms/loadLocalThreads');
        await localPurgeThread(request.purgeThreadId, owner);
        store.set(threadsChangedAtom, (n: number) => n + 1);
    }

    await sleep(400);
    const active = await localRecentThreads(50, owner);
    const archived = await localArchivedThreads(owner);
    return {
        ok: true,
        listOpen: store.get(isThreadListViewAtom),
        archiveMode: store.get(showArchiveAtom),
        active: active.map((t) => ({ id: t.id, name: t.name })),
        archived: archived.map((t) => ({ id: t.id, name: t.name })),
    };
}
