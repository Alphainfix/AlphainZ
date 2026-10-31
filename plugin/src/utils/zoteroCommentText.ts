/**
 * Text the model wrote, in the form a Zotero annotation comment can show.
 *
 * Every comment this plugin writes into Zotero — a selection answer saved into
 * its highlight, the note on a proposed highlight, a sticky note, an edited
 * comment — passes through here, so all of them read the same way in the
 * reader: formulas as real sub- and superscripts, emphasis as Zotero's own
 * bold and italic, and none of the markdown or citation markup that only the
 * sidebar knows what to do with.
 *
 * Idempotent: a comment converted at proposal time and again at execution
 * time comes out the same, since nothing this produces is something it would
 * convert further.
 */

import { convertMathInText } from './latexToRichText';

export function toZoteroCommentText(text: string): string {
    return (
        convertMathInText(
            text
                // Citation tags become clickable numbers in the sidebar; a
                // comment has nothing to turn them into.
                .replace(/\s*<citation\b[^>]*\/>/g, '')
                .replace(/\s*<citation\b[^>]*>[\s\S]*?<\/citation>/g, ''),
        )
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
            .trim()
    );
}

/** The plain text of a converted comment, for a tooltip or a pill that cannot render tags. */
export function stripCommentTags(text: string): string {
    return text.replace(/<\/?(sub|sup|i|b)>/g, '');
}

/** The same conversion for a value that may be absent. */
export function toZoteroCommentTextOrNull(text: unknown): string | null {
    return typeof text === 'string' ? toZoteroCommentText(text) : null;
}
