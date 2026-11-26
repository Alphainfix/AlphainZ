/**
 * What the transcript says a tool call did.
 *
 * It said `ok`. Every successful call, the same word — and the transcript
 * renders it, so approving a highlight replaced a card that named the passage,
 * the page and the colour with "ok". The user had just agreed to something and
 * the record of what they agreed to said nothing.
 *
 * Everything needed was already in the result the tool returned.
 */
import { describe, expect, it } from 'vitest';

import { summarizeToolResult } from '@beaver/agent-llm/agentLoop';

describe('summarizing a highlight', () => {
    it('names the page and the passage', () => {
        const s = summarizeToolResult('create_highlight', {
            page: 7,
            text: 'Among all foraging insects, honeybees in meadows have received the most attention.',
            citation: '<citation id="u-A" page="7"/>',
            status: 'APPLIED — this change is already in the library',
        });
        expect(s).toContain('p.7');
        expect(s).toContain('Among all foraging insects');
        // The citation tag is for the model, not for a person reading a row.
        expect(s).not.toContain('<citation');
    });

    it('names the locator when one placed it', () => {
        const s = summarizeToolResult('create_highlight', {
            page: 12, text: 'A sentence.', placed_by: 's84',
        });
        expect(s).toContain('s84');
        expect(s).toContain('p.12');
    });

    it('stays one line', () => {
        const s = summarizeToolResult('create_highlight', {
            page: 3, text: 'x '.repeat(400),
        });
        expect(s.length).toBeLessThanOrEqual(120);
        expect(s).not.toContain('\n');
    });

    it('names the comment on a sticky note', () => {
        const s = summarizeToolResult('create_sticky_note', {
            page: 7, comment: 'This is the platform I work on.',
        });
        expect(s).toContain('p.7');
        expect(s).toContain('platform I work on');
    });
});

describe('summarizing the rest', () => {
    it('lists imported paper titles', () => {
        expect(summarizeToolResult('add_papers_to_library', {
            papers: [{ title: 'Honeybee navigation' }, { title: 'Odometry' }],
        })).toBe('Honeybee navigation; Odometry');
    });

    it('names the metadata fields that changed', () => {
        expect(summarizeToolResult('edit_metadata', { item: 'u-A', fields: ['title', 'DOI'] }))
            .toContain('title, DOI');
    });

    it('counts annotations and says what changed', () => {
        const s = summarizeToolResult('edit_annotations', {
            annotations: 3, changes: { color: 'green', add_tags: ['x'] },
        });
        expect(s).toContain('3 annotation(s)');
        expect(s).toContain('color');
    });

    it('reports which pages a read returned', () => {
        expect(summarizeToolResult('read_document', { pages_returned: '1-8', total_pages: 45 }))
            .toBe('pages 1-8 of 45');
    });

    it('counts search results', () => {
        expect(summarizeToolResult('search_library_fulltext', { matches: [1, 2, 3] })).toBe('3 match(es)');
    });

    it('falls back to naming fields rather than to "ok"', () => {
        const s = summarizeToolResult('some_tool', { thing: 'a value', count: 2, note: 'for the model' });
        expect(s).toContain('thing');
        expect(s).toContain('count');
        // `note` is guidance addressed to the model; it is not what happened.
        expect(s).not.toContain('for the model');
    });

    it('says something for an empty result', () => {
        expect(summarizeToolResult('x', {})).toBe('done');
        expect(summarizeToolResult('x', null)).toBe('done');
    });
});
