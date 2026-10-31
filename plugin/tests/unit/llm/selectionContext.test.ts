/**
 * Reader context reaching the model.
 *
 * The bug this pins: a question asked from the reader's selection popup used to
 * arrive with no selection attached. The passage was captured, travelled as far
 * as `application_state`, and was then dropped by the prompt builder — so
 * "explain this" was answered about the paper in general, which is exactly what
 * it looked like from the outside.
 */
import { describe, expect, it } from 'vitest';

import { composeUserContent, describePromptContext } from '../../../src/services/llm/runRequestToMessages';
import { buildSystemPrompt } from '../../../src/services/llm/systemPrompt';

const readerPrompt = (readerState: Record<string, any>) => ({
    content: 'What does this mean?',
    application_state: { reader_state: readerState },
});

describe('describePromptContext: reader state', () => {
    it('quotes the selected passage verbatim', () => {
        const note = describePromptContext(
            readerPrompt({
                library_ref: 'u',
                zotero_key: 'UH6CTDV5',
                current_page: 3,
                text_selection: { text: 'the waggle run encodes distance', page: 3 },
            }),
        );
        expect(note).toContain('the waggle run encodes distance');
        // Named as the referent, so "this" in the question resolves.
        expect(note).toContain('"this" refers to');
    });

    it('names the attachment id so the document can actually be read', () => {
        // Without the id the model is told "a document" and has to go hunting
        // for the paper the user already has open.
        const note = describePromptContext(
            readerPrompt({ library_ref: 'u', zotero_key: 'UH6CTDV5', current_page: 3 }),
        );
        expect(note).toContain('[u-UH6CTDV5]');
        expect(note).toContain('page 3');
    });

    it('falls back to the numeric library id when no portable ref is present', () => {
        const note = describePromptContext(
            readerPrompt({ library_id: 1, zotero_key: 'ABCD1234' }),
        );
        expect(note).toContain('[1-ABCD1234]');
    });

    it('omits the id when the reader state carries no key', () => {
        const note = describePromptContext(readerPrompt({ current_page: 2 }));
        expect(note).toContain('page 2');
        expect(note).not.toContain('[');
    });

    it('caps a very long selection but says nothing was truncated silently', () => {
        const note = describePromptContext(
            readerPrompt({
                zotero_key: 'K',
                library_ref: 'u',
                text_selection: { text: 'x'.repeat(9000) },
            }),
        );
        // Ellipsis marks the cut; the rest is reachable through read_document.
        expect(note).toContain('…');
        expect(note!.length).toBeLessThan(6000);
    });

    it('ignores an empty selection rather than quoting nothing', () => {
        const note = describePromptContext(
            readerPrompt({ zotero_key: 'K', library_ref: 'u', text_selection: { text: '   ' } }),
        );
        expect(note).not.toContain('"""');
    });

    it('still lists attached items alongside the reader context', () => {
        const note = describePromptContext({
            content: 'q',
            attachments: [{ attachment_id: 'u-AAAA1111', title: 'A paper' }],
            application_state: { reader_state: { zotero_key: 'K', library_ref: 'u' } },
        });
        expect(note).toContain('A paper [u-AAAA1111]');
        expect(note).toContain('Currently open in the reader');
    });
});

describe('selection questions: what the model is told, and where', () => {
    const selectionPrompt = {
        content: 'What does this mean?',
        origin: { kind: 'selection_chat', annotation_key: 'ANNO1234', library_id: 1 },
        application_state: {
            reader_state: {
                library_ref: 'u',
                zotero_key: 'UH6CTDV5',
                current_page: 3,
                text_selection: { text: 'a passage', page: 3 },
            },
        },
    };

    it('asks for a short answer about the passage', () => {
        const message = composeUserContent(selectionPrompt);
        expect(message).toContain('two or three sentences');
        // The reason for the brevity is stated, so the model does not treat it as
        // an arbitrary style rule.
        expect(message).toContain("highlight's own comment");
    });

    it('says not to answer a passage question from the abstract', () => {
        expect(composeUserContent(selectionPrompt)).toContain('title and abstract');
    });

    it('quotes the passage before the rule, and puts the question last', () => {
        const message = composeUserContent(selectionPrompt);
        expect(message).toContain('a passage');
        expect(message.indexOf('a passage')).toBeLessThan(message.indexOf('two or three sentences'));
        expect(message.endsWith('What does this mean?')).toBe(true);
    });

    it('leaves a sidebar question without the selection rule', () => {
        // Asserted on a phrase unique to the selection note: the base prompt
        // already asks for brevity, so that wording is not a discriminator.
        const sidebarPrompt = { ...selectionPrompt, origin: undefined };
        expect(composeUserContent(sidebarPrompt)).not.toContain("highlight's own comment");
    });

    it('keeps the system prompt free of anything that changes per turn', () => {
        // A page number or a selected passage in the system message makes the
        // first message of every request differ from the last request's, and a
        // provider's prompt cache stops at the first difference.
        const prompt = buildSystemPrompt({});
        expect(prompt).not.toContain('## Right now');
        expect(prompt).not.toContain("highlight's own comment");
        expect(prompt).not.toContain('selected passage');
        expect(buildSystemPrompt()).toBe(prompt);
    });
});
