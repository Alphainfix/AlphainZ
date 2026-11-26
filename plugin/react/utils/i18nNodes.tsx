import React from 'react';
import { t } from '../../src/utils/i18n';

/**
 * A translated sentence with elements in it, such as a link or a bold word:
 * `tr('No key at all? {link}', { link: <a>…</a> })`. The translation decides
 * where each `{name}` goes, so the word order can differ between languages.
 */
export function tr(source: string, parts: Record<string, React.ReactNode>): React.ReactNode {
    const template = t(source);
    const pieces: React.ReactNode[] = [];
    const pattern = /\{(\w+)\}/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(template))) {
        if (match.index > last) pieces.push(template.slice(last, match.index));
        const name = match[1];
        pieces.push(Object.prototype.hasOwnProperty.call(parts, name) ? parts[name] : match[0]);
        last = match.index + match[0].length;
    }
    if (last < template.length) pieces.push(template.slice(last));
    return React.createElement(React.Fragment, null, ...pieces);
}
