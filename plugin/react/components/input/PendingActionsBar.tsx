import React, { useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    pendingApprovalsByLocationAtom,
    removePendingApprovalsAtom,
    type ScopedPendingApproval,
} from '../../agents/agentActions';
import { sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import { recentThreadsAtom, type ThreadData } from '../../atoms/threads';
import { getActionToolGroup, isBulkApprovable } from '../../atoms/runApprovalPolicy';
import { eventManager } from '../../events/eventManager';
import { dismissDiffPreview } from '../../utils/noteEditorDiffPreview';
import { diffPreviewNoteKeyAtom } from '../../utils/diffPreviewCoordinator';
import Button from '@beaver/agent-ui/primitives/Button';
import { t, tn } from '../../../src/utils/i18n';

/** What Approve All may carry, and what has to be approved on its own card. */
export interface BulkApprovalPlan {
    approvable: ScopedPendingApproval[];
    heldBack: ScopedPendingApproval[];
}

/**
 * Split this conversation's proposals into what Approve All approves and what
 * it leaves for the user's own click.
 *
 * Deleting annotations and rewriting most of a note are separate approval
 * groups precisely so that approving edits never carries them along; the
 * bar's bulk approval honours that just as the review card's does.
 */
export function planBulkApproval(approvals: ScopedPendingApproval[]): BulkApprovalPlan {
    const plan: BulkApprovalPlan = { approvable: [], heldBack: [] };
    for (const approval of approvals) {
        (isBulkApprovable(approval.actionType, approval.actionData) ? plan.approvable : plan.heldBack)
            .push(approval);
    }
    return plan;
}

/** Why some proposals are not part of Approve All, in a sentence. */
export function heldBackNote(heldBack: ScopedPendingApproval[]): string | null {
    if (heldBack.length === 0) return null;
    const groups = heldBack.map((approval) => getActionToolGroup(approval.actionType, approval.actionData));
    const deletions = groups.filter((group) => group === 'annotation_deletion').length;
    const rewrites = groups.filter((group) => group === 'note_rewrite').length;
    if (deletions > 0 && rewrites > 0) {
        return t('Deleting annotations and rewriting a note each need their own Apply on the card.');
    }
    if (rewrites > 0) {
        return rewrites === 1
            ? t('The note rewrite needs its own Apply on its card.')
            : t('The {count} note rewrites need their own Apply on their cards.', { count: rewrites });
    }
    return deletions === 1
        ? t('The annotation deletion needs its own Apply on its card.')
        : t('The {count} annotation deletions need their own Apply on their cards.', { count: deletions });
}

/** Proposals waiting in one other conversation. */
export interface ElsewhereGroup {
    threadId: string;
    name: string;
    /** The most recent run with a proposal, which the conversation opens at. */
    runId: string | undefined;
    count: number;
}

/**
 * Other conversations' proposals, one entry per conversation, named as the
 * chat history names it (or as it was named when the proposal was made).
 */
export function groupElsewhere(
    approvals: ScopedPendingApproval[],
    threads: ThreadData[],
): ElsewhereGroup[] {
    const groups = new Map<string, ElsewhereGroup>();
    for (const approval of approvals) {
        if (!approval.threadId) continue;
        const group = groups.get(approval.threadId);
        if (group) {
            group.count += 1;
            group.runId = approval.runId ?? group.runId;
            continue;
        }
        const listed = threads.find((thread) => thread.id === approval.threadId)?.name?.trim();
        groups.set(approval.threadId, {
            threadId: approval.threadId,
            name: listed || approval.threadName?.trim() || t('another chat'),
            runId: approval.runId,
            count: 1,
        });
    }
    return [...groups.values()];
}

const changes = (count: number) => tn(count, '{count} proposed change', '{count} proposed changes');

/** How many other conversations are listed before the rest are summed up. */
const MAX_ELSEWHERE_ROWS = 3;

/**
 * The proposals waiting for a decision, above the composer.
 *
 * This conversation's are counted, with a link to their cards and Approve All
 * / Reject All. Other conversations' are only pointed at — "2 proposed changes
 * in ‘…’ · Open" — because their cards are not on screen, and approving
 * changes nobody can see is not a decision. Nothing here blocks the composer.
 */
const PendingActionsBar: React.FC = () => {
    const { here, elsewhere } = useAtomValue(pendingApprovalsByLocationAtom);
    const threads = useAtomValue(recentThreadsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removePendingApprovals = useSetAtom(removePendingApprovalsAtom);
    const setDiffPreviewNoteKey = useSetAtom(diffPreviewNoteKeyAtom);
    const barRef = useRef<HTMLDivElement | null>(null);

    if (here.length === 0 && elsewhere.length === 0) {
        return null;
    }

    const { approvable, heldBack } = planBulkApproval(here);
    const note = approvable.length > 0 ? heldBackNote(heldBack) : null;
    const otherChats = groupElsewhere(elsewhere, threads);

    const decide = async (e: React.FormEvent | React.MouseEvent, approvals: ScopedPendingApproval[], approved: boolean) => {
        e.preventDefault();
        e.stopPropagation();
        if (approvals.length === 0) return;

        // Dismiss the diff preview first to prevent re-showing during removal.
        await dismissDiffPreview();
        setDiffPreviewNoteKey(null);

        for (const approval of approvals) {
            sendApprovalResponse({ actionId: approval.actionId, approved });
        }
        removePendingApprovals(approvals.map((approval) => approval.actionId));
    };

    // The first card still waiting, brought into view.
    const showCards = (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const doc = barRef.current?.ownerDocument;
        if (!doc) return;
        const cards = Array.from(doc.querySelectorAll('[data-approval-toolcall]'))
            .filter((node): node is Element => !!node && typeof (node as Element).getAttribute === 'function');
        for (const approval of here) {
            const card = cards.find((element) =>
                (element.getAttribute('data-approval-toolcall') ?? '').split(' ').includes(approval.toolcallId));
            if (card) {
                card.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }
        }
    };

    const openChat = (e: React.FormEvent | React.MouseEvent, group: ElsewhereGroup) => {
        e.preventDefault();
        e.stopPropagation();
        eventManager.dispatch('loadThread', { threadId: group.threadId, runId: group.runId });
    };

    const shownChats = otherChats.slice(0, MAX_ELSEWHERE_ROWS);
    const moreChats = otherChats.slice(MAX_ELSEWHERE_ROWS);
    const approveLabel = heldBack.length > 0 ? `Approve ${approvable.length}` : t('Approve All');

    return (
        <div
            ref={barRef}
            className="pending-actions-bar display-flex flex-col px-3 py-2 bg-senary border-bottom-quinary gap-1"
            role="region"
            aria-label={t('Proposed changes')}
        >
            {here.length > 0 && (
                <>
                    <div className="display-flex flex-row items-center gap-2">
                        <span className="font-color-primary text-sm">{changes(here.length)}</span>
                        <Button
                            variant="ghost-secondary"
                            onClick={showCards}
                            style={{ padding: '2px 4px', fontSize: '0.875rem' }}
                            ariaLabel={here.length === 1 ? t('Show the proposed change') : t('Show the proposed changes')}
                        >
                            {t('Show')}
                        </Button>

                        <div className="flex-1" />

                        <div className="display-flex flex-row items-center gap-2">
                            <Button
                                variant="ghost-secondary"
                                onClick={(e) => { void decide(e, here, false); }}
                                style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                            >
                                {t('Reject All')}
                            </Button>
                            {approvable.length > 0 && (
                                <Button
                                    variant="outline"
                                    onClick={(e) => { void decide(e, approvable, true); }}
                                    style={{ padding: '2px 8px', fontSize: '0.875rem' }}
                                >
                                    {approveLabel}
                                </Button>
                            )}
                        </div>
                    </div>
                    {note && <div className="font-color-secondary text-sm">{note}</div>}
                    {approvable.length === 0 && (
                        <div className="font-color-secondary text-sm">
                            {here.length === 1
                                ? t('This one needs its own Apply on its card.')
                                : t('These need their own Apply on their cards.')}
                        </div>
                    )}
                </>
            )}

            {shownChats.map((group) => (
                <div key={group.threadId} className="display-flex flex-row items-center gap-2 min-w-0">
                    <span className="font-color-secondary text-sm truncate min-w-0">
                        {tn(group.count, '{count} proposed change in ‘{name}’', '{count} proposed changes in ‘{name}’', { name: group.name })}
                    </span>
                    <Button
                        variant="ghost-secondary"
                        onClick={(e) => openChat(e, group)}
                        style={{ padding: '2px 4px', fontSize: '0.875rem', flexShrink: 0 }}
                        ariaLabel={t('Open ‘{name}’ to decide its proposed changes', { name: group.name })}
                    >
                        {t('Open')}
                    </Button>
                </div>
            ))}
            {moreChats.length > 0 && (
                <div className="font-color-secondary text-sm">
                    {t('{changes} in {chats}', {
                        changes: changes(moreChats.reduce((sum, group) => sum + group.count, 0)),
                        chats: tn(moreChats.length, '{count} more chat', '{count} more chats'),
                    })}
                </div>
            )}
        </div>
    );
};

export default PendingActionsBar;
