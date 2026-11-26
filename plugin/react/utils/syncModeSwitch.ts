/**
 * Switching the conversation-sync backend, with its one destructive
 * consequence in a single place, and joining the new one.
 *
 * Leaving a live backend asks whether to keep ITS remote copies or delete
 * them (twice, for deleting), and never touches the local database. Both
 * surfaces that can switch (the settings page and the welcome wizard's sync
 * step) run the same confirm-then-clean sequence, and the same join
 * afterwards (`joinSyncBackend`), so the two cannot drift.
 */
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref, setPref } from '../../src/utils/prefs';
import {
    conversationSyncMode,
    getConversationBackend,
    type ConversationSyncMode,
} from '../../src/services/conversationSync';
import type { ExportAllOutcome } from '../../src/services/conversationSync/exportAll';
import { flushSettingsExportNow, forgetSettingsExchange } from '../../src/services/conversationSync/settingsSync';
import { resetSyncHealth } from '../../src/services/conversationSync/syncHealth';
import { CONVERSATIONS_TITLE } from '../../src/services/threadZoteroSync';
import { joinSentences, t, tn } from '../../src/utils/i18n';

export type SwitchOutcome = 'switched' | 'cancelled' | 'unchanged';

/**
 * The sync location changed — another backend, or another folder. What was
 * known about the old one describes a place this computer no longer uses:
 * the footer's findings, and the stamp of its last settings exchange.
 */
export function forgetSyncLocation(): void {
    resetSyncHealth();
    forgetSettingsExchange();
}

/**
 * The second, explicit question before any remote copy is deleted, saying how
 * many. Cancel is button1, where Esc and closing the dialog land.
 */
async function confirmDeletion(current: Exclude<ConversationSyncMode, 'off'>): Promise<boolean> {
    let count: number | null = null;
    try {
        count = (await getConversationBackend()?.countRemoteCopies?.()) ?? null;
    } catch {
        count = null;
    }
    const what = count === null
        ? t('every conversation file')
        : tn(count, '{count} conversation file', '{count} conversation files');
    const text = current === 'folder'
        ? t('This permanently deletes {what} and the settings file from the sync folder. '
            + 'Your cloud service then removes them from your other computers\' copies of the folder too, '
            + 'and a chat archived on another computer that this one never opened exists only there. '
            + 'Conversations on this computer are kept.', { what })
        : t('This moves {what} and the settings file under "{title}" to Zotero\'s trash — '
            + 'on your other computers too, once Zotero syncs. Conversations on this computer are kept.',
            { what, title: CONVERSATIONS_TITLE });
    const answer = Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title: t('Delete the synced copies?'),
        text,
        button0: t('Delete'),
        button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
        defaultButton: 1,
    });
    return answer === 0;
}

/**
 * Confirm (when leaving a live backend), pick the destination folder, clean
 * the old backend's remote copies, then write the new mode.
 *
 * The keep/delete question is asked FIRST and the folder picker second — the
 * question is about the mode being left, so it belongs before the new mode's
 * details — but the deletion itself runs last: cancelling the picker aborts
 * the whole switch with the old copies untouched.
 */
export async function confirmAndSwitchSyncMode(
    next: ConversationSyncMode,
    options: {
        /** Destination folder, when the caller already has one. */
        folderPath?: string;
        /**
         * Asked for the destination folder when switching to `folder` without
         * a `folderPath`. Returning null cancels the whole switch.
         */
        pickFolder?: () => Promise<string | null>;
    } = {},
): Promise<SwitchOutcome> {
    const current = conversationSyncMode();
    const currentFolder = String(getPref('conversationSyncFolderPath') ?? '');
    let folderPath = options.folderPath;
    if (
        next === current
        && !(next === 'folder' && options.pickFolder && folderPath === undefined)
        && (next !== 'folder' || !folderPath || folderPath === currentFolder)
    ) {
        return 'unchanged';
    }

    let deleteOldCopies = false;
    if (current !== 'off' && next !== current) {
        const where = current === 'zotero'
            ? t('the "{title}" item in My Library', { title: CONVERSATIONS_TITLE })
            : t('the sync folder');
        /*
         * Three-way, with "keep" as the safe default: the copies are the
         * user's data sitting in their own storage, and deleting them is a
         * choice, not a toll for switching. Leftovers are inert either way —
         * the old backend is simply never read again.
         *
         * Cancel must be button1. Services.prompt.confirmEx answers 1 when
         * the user presses Esc or closes the dialog, so whatever sits there
         * is what backing out does — and deleting is confirmed separately.
         */
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: t('Switch sync mode?'),
            text: joinSentences([
                t('There are conversation copies stored in {where}.', { where }),
                t('Keep them there, or delete them? Conversations on this computer are kept either way.'),
                current === 'folder' && t('Conflict copies (like "… 2.json") are always left for you to review.'),
            ]),
            button0: t('Keep the copies'),
            button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
            button2: t('Delete them…'),
            defaultButton: 0,
        });
        if (buttonIndex === 2) {
            if (!(await confirmDeletion(current))) return 'cancelled';
            deleteOldCopies = true;
        } else if (buttonIndex !== 0) {
            return 'cancelled';
        }
    }

    if (next === 'folder' && !folderPath && options.pickFolder) {
        const picked = await options.pickFolder();
        if (!picked) return 'cancelled';
        folderPath = picked;
    }

    // Only now, with the destination settled, is anything deleted.
    if (deleteOldCopies) {
        try {
            const old = getConversationBackend();
            if (old) {
                const { removed } = await old.deleteAllRemote();
                logger(`syncModeSwitch: cleared ${removed} remote copies from ${current}`, 3);
            }
        } catch (error) {
            // The switch still proceeds: a cleanup hiccup must not trap
            // the user on a backend they chose to leave.
            logger(`syncModeSwitch: could not clear the old backend: ${error}`, 1);
        }
    }

    if (folderPath !== undefined) setPref('conversationSyncFolderPath', folderPath);
    setPref('conversationSyncBackend', next);
    forgetSyncLocation();
    return 'switched';
}

export interface JoinOutcome {
    /** Another computer's settings changed something here. */
    adoptedSettings: boolean;
    /** What the backfill did, or null when there was no backend or database to do it with. */
    exported: ExportAllOutcome | null;
}

/**
 * Bring a sync location this computer just started using up to date, in the
 * only order that cannot overwrite another computer's work: take what is
 * already there, then add what is only here.
 *
 * Settings first: another computer's document is applied here — on first
 * contact its settings win, except that its install defaults never replace
 * a setting made on this computer — and only then is this computer's own
 * written: merged, after taking one; as the first, where there is none; and
 * never over one that is there but cannot be read yet. Then conversations:
 * the archive reconcile and the import run before the backfill, so a chat
 * archived or continued elsewhere is not overwritten by an older copy from
 * here, and the backfill writes only the threads whose remote copy is older,
 * missing or damaged.
 *
 * Shared by the welcome wizard and the settings page.
 */
export async function joinSyncBackend(): Promise<JoinOutcome> {
    const outcome: JoinOutcome = { adoptedSettings: false, exported: null };
    if (conversationSyncMode() === 'off') return outcome;

    const { importSettingsNow } = await import('./settingsSyncClient');
    const stamp = () => String(getPref('settingsSyncStamp') ?? '');
    const stampBefore = stamp();
    outcome.adoptedSettings = await importSettingsNow();
    /*
     * A moved stamp means the import already exchanged settings: it applied
     * another computer's document, or wrote this one's as the first. When
     * nothing moved, this computer's settings go out now — by the
     * first-document rule if it has not exchanged with this location, as an
     * ordinary write if it has (a wizard shown again after an update has not
     * exported the choices made in it yet).
     */
    if (stamp() === stampBefore) await flushSettingsExportNow();

    const { syncConversationsNow } = await import('../atoms/loadLocalThreads');
    // Twice: a pass already in flight when the location changed was reading
    // the old one, and the first call only waits for it.
    await syncConversationsNow();
    await syncConversationsNow();

    const backend = getConversationBackend();
    const db = (Zotero as any).AlphainZ?.db;
    if (backend && db) {
        const { exportAllThreads } = await import('../../src/services/conversationSync/exportAll');
        // The local database's fixed owner (react/atoms/auth's LOCAL_USER_ID).
        outcome.exported = await exportAllThreads(db, backend, 'local-user', { skipNewerRemote: true });
    }
    return outcome;
}
