import React from 'react';
import { useAtomValue } from 'jotai';
import { createElement } from 'react';

import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import Button from '@beaver/agent-ui/primitives/Button';

import { Icon, PuzzleIcon } from '../icons/icons';
import { store } from '../../store';
import { getPref } from '../../../src/utils/prefs';
import { LOCAL_USER_ID, userAtom } from '../../atoms/auth';
import { discardThreadCompaction, threadCompactionAtom } from '../../atoms/threadCompaction';
import { addPopupMessageAtom, removePopupMessageAtom } from '../../utils/popupMessageUtils';
import { t, tn } from '../../../src/utils/i18n';

/**
 * The marker where the conversation was compacted.
 *
 * Everything above it is still shown in full — only the model reads a summary
 * in place of those runs. The marker is the honest trace of an automatic,
 * paid-for action, and the way back: its card shows the summary verbatim and
 * offers to discard it.
 *
 * A request carries the summary only while automatic compaction is on, so
 * with the setting off the marker says the summary is not in use.
 */
export const CompactionMarker: React.FC = () => {
    const compaction = useAtomValue(threadCompactionAtom);
    if (!compaction) return null;
    const inUse = getPref('contextCompactionEnabled') === true;

    const openCard = () => {
        const popupId = 'compaction-summary';
        store.set(addPopupMessageAtom, {
            id: popupId,
            type: 'info',
            title: tn(compaction.runCount, 'Summary of {count} earlier exchange', 'Summary of {count} earlier exchanges'),
            expire: false,
            customContent: createElement(CompactionSummaryCard, {
                summary: compaction.summary,
                runCount: compaction.runCount,
                inUse: getPref('contextCompactionEnabled') === true,
                onDismiss: () => store.set(removePopupMessageAtom, popupId),
                onDiscard: async () => {
                    const threadId = store.get(currentThreadIdAtom);
                    if (!threadId) return;
                    // The same owner-id rule every thread call uses — a thread
                    // from the cloud era carries its own user id, and a
                    // hardcoded local id would make this a silent no-op there.
                    const ownerId = store.get(userAtom)?.id ?? LOCAL_USER_ID;
                    await discardThreadCompaction(
                        (Zotero as any).AlphainZ?.db ?? null,
                        ownerId,
                        threadId,
                    );
                    store.set(removePopupMessageAtom, popupId);
                },
            }),
        });
    };

    return (
        <div className="display-flex flex-row items-center px-4" aria-label={t('Earlier exchanges summarized here')}>
            <Button
                variant="ghost-secondary"
                onClick={openCard}
                className="text-sm min-w-0"
                style={{ padding: '2px 6px', maxHeight: 'none' }}
            >
                <div className="display-flex flex-row gap-2 items-center">
                    <Icon icon={PuzzleIcon} className="scale-90" />
                    <span className="font-color-tertiary">
                        {inUse
                            ? tn(
                                compaction.runCount,
                                '{count} earlier exchange compacted — the model reads a summary of it instead',
                                '{count} earlier exchanges compacted — the model reads a summary of them instead',
                            )
                            : tn(
                                compaction.runCount,
                                '{count} earlier exchange compacted — the summary is not used while automatic compaction is off',
                                '{count} earlier exchanges compacted — the summary is not used while automatic compaction is off',
                            )}
                    </span>
                </div>
            </Button>
        </div>
    );
};

/**
 * The summary itself, and what keeping or discarding it does — said in terms
 * of what the user will get, for readers who may be working in a second
 * language.
 *
 * Without a summary a request carries only the thread's last 10 exchanges
 * (the replay cap in buildRunMessages), which is why the text names that
 * number.
 */
export const CompactionSummaryCard: React.FC<{
    summary: string;
    runCount: number;
    /** Whether requests carry the summary, which they do while automatic compaction is on. */
    inUse?: boolean;
    onDismiss: () => void;
    onDiscard: () => Promise<void>;
}> = ({ summary, runCount, inUse = true, onDismiss, onDiscard }) => {
    const [busy, setBusy] = React.useState(false);
    return (
        <div className="display-flex flex-col gap-2 px-1">
            <div
                className="text-sm font-color-secondary rounded-md bg-quinary p-2"
                style={{ maxHeight: '180px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}
            >
                {summary}
            </div>
            {inUse ? (
                <div className="text-sm font-color-tertiary">
                    {tn(
                        runCount,
                        'The model reads this summary instead of that earlier exchange. It stays here in full, '
                            + 'and nothing on this computer changes.',
                        'The model reads this summary instead of those {count} earlier exchanges. They stay here '
                            + 'in full, and nothing on this computer changes.',
                    )}{' '}
                    {t('If the summary gets something wrong, discard it. From your next message the model is sent '
                        + 'your last 10 exchanges instead of the summary (older ones are left out), which costs more. '
                        + 'A new summary is written from the originals later.')}
                </div>
            ) : (
                <div className="text-sm font-color-tertiary">
                    {t('Automatic compaction is off in Settings → Advanced, so the model is not sent this summary: it is sent your last 10 exchanges, and older ones are left out. If you turn compaction back on, the summary is used again unless you discard it.')}
                </div>
            )}
            <div className="display-flex flex-row gap-2">
                <div className="flex-1" />
                <Button variant="outline" onClick={onDismiss}>{t('Keep')}</Button>
                <Button
                    variant="outline"
                    loading={busy}
                    disabled={busy}
                    onClick={() => {
                        setBusy(true);
                        void onDiscard().finally(() => setBusy(false));
                    }}
                >
                    {t('Discard summary')}
                </Button>
            </div>
        </div>
    );
};

export default CompactionMarker;
