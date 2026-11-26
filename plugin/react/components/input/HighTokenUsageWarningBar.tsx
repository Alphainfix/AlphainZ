import React from 'react';
import { useAtomValue } from 'jotai';
import { AlertIcon, CancelIcon, Icon } from '../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { RunUsage } from '@beaver/agent-core/agents/types';
import { backendHighTokenUsageRunsAtom } from '../../atoms/messageUIState';
import { getFirstRequestInputTokens } from '../../utils/runUsage';
import { getPref } from '../../../src/utils/prefs';
import { formatTokens } from './RunUsageChip';
import { t } from '../../../src/utils/i18n';
import { tr } from '../../utils/i18nNodes';

interface HighTokenUsageWarningBarProps {
    onNewThread: (e: React.MouseEvent) => void;
    onDismiss: (e: React.MouseEvent) => void;
    isUsingBeaverCredits: boolean;
}

/** Input tokens a chat must resend with every message before it counts as long. */
export const LONG_CHAT_INPUT_TOKENS = 100_000;

/**
 * What the chat resends with every message, when that makes it long; null otherwise.
 *
 * Read from the first request of the newest answer: the instructions, the
 * summary and history, and the new question — what the next message will send
 * again. Its later requests also carry what that answer read along the way, so
 * a first question that reads a long paper crosses the line without the chat
 * being long, and a new chat would only have the paper read again.
 */
export function longChatInputTokens(usage: RunUsage | null | undefined): number | null {
    if (!usage) return null;
    const tokens = getFirstRequestInputTokens(usage);
    return tokens !== null && tokens > LONG_CHAT_INPUT_TOKENS ? tokens : null;
}

/**
 * Subtle warning shown above the input when the chat itself has grown heavy:
 * every message resends so much of it that a new chat for a new topic would be
 * faster and cheaper. Renders nothing while the chat is not long by that
 * measure, whatever its caller decided.
 */
const HighTokenUsageWarningBar: React.FC<HighTokenUsageWarningBarProps> = ({
    onNewThread,
    onDismiss,
}) => {
    const [isNewThreadLinkHovered, setIsNewThreadLinkHovered] = React.useState(false);
    const runs = useAtomValue(allRunsAtom);
    const backendFlags = useAtomValue(backendHighTokenUsageRunsAtom);

    const chatTokens = longChatInputTokens(runs[runs.length - 1]?.total_usage);
    const flaggedByBackend = runs.some((run) => backendFlags[run.id]);
    if (chatTokens === null && !flaggedByBackend) return null;

    const compactionOn = getPref('contextCompactionEnabled') === true;
    const tokens = chatTokens !== null ? formatTokens(chatTokens) : null;
    let sizeSentence: string;
    if (tokens !== null) {
        sizeSentence = compactionOn
            ? t('This chat is long — each message sends about {tokens} tokens to the model, though older exchanges are summarized automatically.', { tokens })
            : t('This chat is long — each message sends about {tokens} tokens to the model.', { tokens });
    } else {
        sizeSentence = compactionOn
            ? t('This chat is long — each message resends much of it to the model, though older exchanges are summarized automatically.')
            : t('This chat is long — each message resends much of it to the model.');
    }

    return (
        <div className="high-token-usage-warning-bar display-flex flex-row items-start px-3 py-15 gap-2">
            <Icon icon={AlertIcon} className="font-color-orange scale-10 mt-010" />
            <span className="font-color-secondary text-sm">
                {sizeSentence}
                {' '}
                {tr('{link} for a new topic: replies get faster and cheaper.', { link: (
                <a
                    href="#"
                    className={`${isNewThreadLinkHovered ? 'font-color-primary' : 'font-color-secondary'} transition text-sm text-underline`}
                    onMouseEnter={() => setIsNewThreadLinkHovered(true)}
                    onMouseLeave={() => setIsNewThreadLinkHovered(false)}
                    onFocus={() => setIsNewThreadLinkHovered(true)}
                    onBlur={() => setIsNewThreadLinkHovered(false)}
                    onClick={(e) => {
                        e.preventDefault();
                        onNewThread(e);
                    }}
                >
                    {t('Start a new chat')}
                </a>
                ) })}
            </span>
            <div className="flex-1" />
            <IconButton
                variant="ghost-secondary"
                icon={CancelIcon}
                ariaLabel={t('Dismiss long chat warning')}
                onClick={onDismiss}
                className="scale-85 mt-010"
            />
        </div>
    );
};

export default HighTokenUsageWarningBar;
