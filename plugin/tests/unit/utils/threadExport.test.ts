/**
 * Saving a conversation as a Zotero note.
 *
 * Three menu items write into the user's library — copy the chat, save it as a
 * note, save it as a child note — and none of them had ever been run. The menu
 * is the only way in and a synthetic click on it is not something to rely on,
 * so the pipeline was lifted out where it can be. Which is how the note turned
 * out to still be signing itself "Created by Beaver".
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/utils/citationRenderers', () => ({
    preprocessNoteContent: (s: string) => s,
    renderToHTML: (s: string) => `<h1>Chat</h1><p>${s}</p>`,
}));

import { buildThreadNoteHTML } from '../../../react/utils/threadExport';

describe('buildThreadNoteHTML', () => {
    it('signs the note with the plugin\'s own name', () => {
        // It is written into the user's library, so the name in it is not a
        // detail: it long outlives the conversation.
        const html = buildThreadNoteHTML({ content: 'body', renderContext: {}, threadId: 't1' });
        expect(html).toContain('Created by AlphainZ');
        expect(html).not.toContain('Created by Beaver');
    });

    it('links back to the conversation it came from', () => {
        const html = buildThreadNoteHTML({ content: 'body', renderContext: {}, threadId: 't1' });
        expect(html).toContain('zotero://alphainz/thread/t1');
    });

    it('puts the provenance line under the title and again at the end', () => {
        // Top so it says what this is before you read it; bottom so it survives
        // the note being appended to.
        const html = buildThreadNoteHTML({ content: 'body', renderContext: {}, threadId: 't1' });
        const first = html.indexOf('Created by AlphainZ');
        const last = html.lastIndexOf('Created by AlphainZ');
        expect(first).toBeGreaterThan(html.indexOf('</h1>'));
        expect(last).toBeGreaterThan(first);
        expect(html.indexOf('body')).toBeGreaterThan(first);
    });

    it('adds nothing when there is no conversation to link to', () => {
        const html = buildThreadNoteHTML({ content: 'body', renderContext: {}, threadId: null });
        expect(html).toBe('<h1>Chat</h1><p>body</p>');
    });

    it('still produces a note when the render has no heading', () => {
        // A transcript with no title must not lose its footer to a missing
        // </h1>.
        vi.resetModules();
        const html = buildThreadNoteHTML({ content: 'body', renderContext: {}, threadId: 't1' });
        expect(html).toContain('Created by AlphainZ');
    });
});
