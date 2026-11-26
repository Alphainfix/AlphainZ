import React from 'react';
import { msg, t } from '../../../../../src/utils/i18n';

/**
 * Step ⑤: the two-minute tour of what this fork adds. Static on purpose —
 * a reader skims this once; anything interactive belongs in the app itself.
 */
const FEATURES: Array<{ title: string; body: string }> = [
    {
        title: msg('Your highlights ride along'),
        body: msg('Open a PDF and the paper plus every highlight on it attaches to the chat '
            + 'automatically — ask "what did I mark?" with no setup. Leave the paper and they leave too.'),
    },
    {
        title: msg('Highlights, notes and filing, once you allow them'),
        body: msg('The agent can propose highlights, notes, edits to papers and notes, and how items are filed. '
            + 'This is off until you turn it on under Settings → Permissions, where you also choose which '
            + 'kinds of change wait for your approval.'),
    },
    {
        title: msg('Answers cite sentences, not pages'),
        body: msg('Citation markers hover to show the exact sentence and click to jump to it in the PDF, '
            + 'highlighted. Verified across 840 sentences at 100%.'),
    },
    {
        title: msg('Watch the work, or just the answer'),
        body: msg('The eye icon at the top of the panel picks how much of the run you see: every step, one collapsible line '
            + '(tool calls show their arguments, thoughts show a preview), or the answer alone.'),
    },
    {
        title: msg('Delete is an archive'),
        body: msg('Deleted chats move to the Archive at the top of the history and restore in one click. '
            + 'Titles are AI-written after the first answer; rename them freely.'),
    },
    {
        title: msg('Your library, from other apps'),
        body: msg('An MCP server (Settings → Advanced) lets Claude Desktop or Claude Code search and read '
            + 'this Zotero library directly.'),
    },
];

const FeatureTourStep: React.FC = () => (
    <div className="display-flex flex-col gap-3">
        {FEATURES.map((f) => (
            <div key={f.title}>
                <div className="text-base font-color-primary font-semibold">{t(f.title)}</div>
                <div className="text-sm font-color-secondary">{t(f.body)}</div>
            </div>
        ))}
    </div>
);

export default FeatureTourStep;
