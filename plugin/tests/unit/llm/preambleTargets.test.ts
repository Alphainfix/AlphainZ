/**
 * The message preamble says what the question is about.
 *
 * - Explain or Ask on one highlight: that highlight is named as the subject,
 *   not quoted as one of the paper's many.
 * - A selected passage: the model is given the page the passage is on, not
 *   the page mostly in view.
 * - An attached picture: a boxed region says where it sits, and an image file
 *   from the library is recognised as one.
 */
import { describe, expect, it } from 'vitest';

import { buildRunMessages, composeUserContent, describePromptContext } from '@beaver/agent-llm/runRequestToMessages';

const highlight = (key: string, text: string, page: string) => ({
    type: 'annotation', annotation_type: 'highlight', library_id: 1, library_ref: 'u', zotero_key: key, text, page_label: page,
});

/** The clicked highlight, first, then the paper's staged ones — as sending assembles them. */
const explainPrompt = (origin?: Record<string, unknown>) => ({
    content: 'Explain the selected annotation(s) from this paper in plain language.',
    attachments: [
        highlight('CLICKED1', 'the waggle run encodes distance', '5'),
        highlight('OTHER001', 'tunnel patterns inflate distance', '3'),
        highlight('OTHER002', 'the honeybee stands out', '1'),
    ],
    ...(origin ? { origin } : {}),
});

describe('a question about one annotation', () => {
    it('names that annotation as the subject, apart from the others', () => {
        const text = describePromptContext(explainPrompt({ kind: 'annotation_question', annotation_key: 'CLICKED1', library_id: 1 }))!;
        const lines = text.split('\n');
        expect(lines[0]).toBe('The user is asking about this highlight:');
        expect(lines[1]).toContain('the waggle run encodes distance');
        expect(lines[1]).toContain('[u-CLICKED1]');
        expect(lines[2]).toBe('Also attached to this message:');
        expect(text.indexOf('tunnel patterns')).toBeGreaterThan(text.indexOf('Also attached'));
        // Quoted once, where it is named.
        expect(text.split('the waggle run encodes distance').length - 1).toBe(1);
    });

    it('names several when several were chosen', () => {
        const text = describePromptContext(explainPrompt({ annotation_keys: ['CLICKED1', 'OTHER002'] }))!;
        expect(text.startsWith('The user is asking about these annotations:')).toBe(true);
        expect(text.indexOf('the honeybee stands out')).toBeLessThan(text.indexOf('Also attached'));
    });

    it('ignores a key from another library', () => {
        const text = describePromptContext(explainPrompt({ annotation_key: 'CLICKED1', library_id: 7 }))!;
        expect(text.startsWith('Items attached to this message:')).toBe(true);
    });

    it('reads exactly as before when the origin names none', () => {
        const text = describePromptContext(explainPrompt())!;
        expect(text.split('\n')[0]).toBe('Items attached to this message:');
        expect(text).not.toContain('asking about');
    });

    it('replays the turn as it was sent', () => {
        const prompt = explainPrompt({ kind: 'annotation_question', annotation_key: 'CLICKED1' });
        const sent = buildRunMessages({ prompt, systemPrompt: 'sys' });
        const replayed = buildRunMessages({
            priorRuns: [{ id: 'r1', status: 'completed', user_prompt: prompt, model_messages: [] }],
            prompt: { content: 'and the next one?' },
            systemPrompt: 'sys',
        });
        expect(replayed[1].content).toBe(sent[1].content);
    });
});

describe('a selected passage near a page boundary', () => {
    const readerPrompt = (selection: Record<string, unknown> = {}) => ({
        content: 'What does this mean?',
        origin: { kind: 'selection_chat' },
        application_state: {
            reader_state: {
                library_ref: 'u',
                zotero_key: 'UH6CTDV5',
                current_page: 5,
                text_selection: { text: 'the first sentence on page six', ...selection },
            },
        },
    });

    it('is placed on its own page, not on the page mostly in view', () => {
        // page_index is the 0-based index of the page the selection is on.
        const text = composeUserContent(readerPrompt({ page_index: 5 }));
        expect(text).toContain('The user has selected this passage on page 6');
        expect(text).toContain('Currently open in the reader: a document [u-UH6CTDV5], page 6.');
        expect(text).not.toContain('page 5');
    });

    it('falls back to the page in view when the passage carries none', () => {
        const text = composeUserContent(readerPrompt());
        expect(text).toContain('Currently open in the reader: a document [u-UH6CTDV5], page 5.');
        expect(text).toContain('The user has selected this passage, which is what "this" refers to:');
    });

    it.each([
        ['the selection popup', 1],
        ['a question about a highlight, which stages its printed label', 1234],
        ['the page in view', 5],
    ])('does not take the page staged by %s for the passage\'s own', (_source, page) => {
        const text = composeUserContent(readerPrompt({ page }));
        expect(text).toContain('Currently open in the reader: a document [u-UH6CTDV5], page 5.');
        expect(text).toContain('The user has selected this passage, which is what "this" refers to:');
        expect(text).not.toContain(`page ${page},`);
        if (page !== 5) expect(text).not.toContain(`page ${page}.`);
    });

    it('replays a stored selection question exactly as it was sent', () => {
        // A stored selection carries only the page it was staged with, and its
        // replay has to match the request that went out, byte for byte.
        const stored = readerPrompt({ page: 1 });
        const sent = 'Currently open in the reader: a document [u-UH6CTDV5], page 5.\n'
            + 'The user has selected this passage, which is what "this" refers to:\n'
            + '"""\nthe first sentence on page six\n"""';
        expect(describePromptContext(stored)).toBe(sent);
        const replayed = buildRunMessages({
            priorRuns: [{ id: 'r1', status: 'completed', user_prompt: stored, model_messages: [] }],
            prompt: { content: 'and the next one?' },
            systemPrompt: 'sys',
        });
        expect(String(replayed[1].content).startsWith(`${sent}\n\n`)).toBe(true);
    });

    it('ignores a page index that is not a page', () => {
        for (const page_index of [-1, 2.5, '5', null]) {
            expect(composeUserContent(readerPrompt({ page_index }))).toContain('The user has selected this passage, which');
        }
    });
});

describe('an attached picture', () => {
    it('says where an area boxed in the reader sits, so its page can be looked at', () => {
        const text = describePromptContext({
            content: 'What does this show?',
            attachments: [{
                type: 'annotation', annotation_type: 'image', library_id: 1, library_ref: 'u',
                zotero_key: 'FIG12345', parent_key: 'PDF12345', page_label: '7', position: { page_index: 6, rects: [] },
            }],
        } as any)!;
        expect(text).toContain('- Image region, p.7 [u-FIG12345] — an image, boxed on page 7 of [u-PDF12345]');
        expect(text).toContain('view_attachment_image');
        expect(text).toContain('`view_page_images` on the page');
    });

    it('recognises an image file from the library by its attachment stub', () => {
        const text = describePromptContext({
            content: 'What does this show?',
            attachments: [{
                type: 'source', library_id: 1, library_ref: 'u', zotero_key: 'IMG12345',
                attachment: { attachment_id: 'u-IMG12345', content_kind: 'image', filename: 'setup.png' },
            }],
        } as any)!;
        expect(text).toContain('[u-IMG12345] — an image');
        expect(text).toContain('Call `view_attachment_image`');
        // Only a boxed region gets the page fallback.
        expect(text).not.toContain('view_page_images');
    });
});
