/**
 * Turning a conversation into something that stays: a Zotero note, or markdown
 * on the clipboard.
 *
 * Lifted out of the chat menu's click handlers so the pipeline can be run
 * without a menu to click. The handlers had never been exercised — the menu is
 * the only way in, and a synthetic click on it is not something a test can
 * rely on — which for this fork means nobody had checked that the note it
 * writes says AlphainZ, or that it lands anywhere sensible.
 */

import { renderToHTML, preprocessNoteContent } from './citationRenderers';
import { getBeaverNoteFooterHTML } from './noteActions';

export interface ThreadNoteOptions {
    /** Chat transcript, already extracted from the runs. */
    content: string;
    /** Citation/reference maps, as `prepareCitationRenderContext` returns them. */
    renderContext: unknown;
    /** Links the note back to the conversation it came from. */
    threadId?: string | null;
}

/**
 * The note body, with the provenance line under the title and again at the end.
 *
 * Two placements on purpose: the top line says what this is before you read it,
 * and the bottom one survives being appended to.
 */
export function buildThreadNoteHTML({ content, renderContext, threadId }: ThreadNoteOptions): string {
    const rendered = renderToHTML(preprocessNoteContent(content), 'markdown', renderContext as any);
    const branding = threadId ? getBeaverNoteFooterHTML(threadId) : '';
    if (!branding) return rendered;

    const h1End = rendered.indexOf('</h1>');
    const withHeader = h1End === -1
        ? rendered
        : `${rendered.slice(0, h1End + '</h1>'.length)}${branding}<hr>${rendered.slice(h1End + '</h1>'.length)}`;
    return `${withHeader}<hr>${branding}`;
}
