/**
 * A Zotero comment's rich text, rendered the way Zotero renders it.
 *
 * The comment field understands four tags — <i>, <b>, <sub>, <sup> — as
 * literal text that its editor turns into formatting: the earliest opening
 * tag in a run of text, closed by the first matching closing tag after it,
 * then the same again on what is left. This mirrors that walk exactly, so an
 * offer card shows the answer as the highlight will show it, angle brackets
 * and all where Zotero would leave them.
 */

import React from 'react';

const FORMATS = ['sub', 'sup', 'i', 'b'] as const;
type Format = (typeof FORMATS)[number];

export function renderRichComment(text: string, keyPrefix = 'r'): React.ReactNode[] {
    const lower = text.toLowerCase();
    const openings = FORMATS
        .map((format) => ({ format, offset: lower.indexOf(`<${format}>`) }))
        .filter((candidate) => candidate.offset >= 0)
        .sort((a, b) => a.offset - b.offset);

    for (const { format, offset } of openings) {
        const close = lower.indexOf(`</${format}>`, offset);
        if (close < 0) continue;
        const head = text.slice(0, offset);
        const middle = text.slice(offset + format.length + 2, close);
        const tail = text.slice(close + format.length + 3);
        return [
            head,
            React.createElement(
                format as Format,
                { key: `${keyPrefix}-${offset}` },
                ...renderRichComment(middle, `${keyPrefix}m`),
            ),
            ...renderRichComment(tail, `${keyPrefix}t`),
        ];
    }
    return [text];
}

export const RichCommentText: React.FC<{ text: string }> = ({ text }) => (
    <>{renderRichComment(text)}</>
);

export default RichCommentText;
