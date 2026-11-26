/**
 * Attached highlights are quoted, not just named.
 *
 * The prompt builder names an attachment and leaves its text to a tool, which
 * is right for a PDF and backwards for a highlight: its whole content is one
 * short quote, so naming it alone made the model spend a `get_annotations`
 * round trip on thirty tokens — and answer "I have nothing" when told not to
 * call tools.
 */
import { describe, expect, it } from 'vitest';
import { describePromptContext } from '@beaver/agent-llm/runRequestToMessages';

const withAttachments = (attachments: any[], reader: any = {}) =>
    describePromptContext({
        content: 'x',
        attachments,
        application_state: { reader_state: { library_ref: 'u', zotero_key: 'ABC', ...reader } },
    } as any) ?? '';

const highlight = (over: any = {}) => ({
    type: 'annotation', annotation_type: 'highlight', library_ref: 'u', zotero_key: 'H1',
    text: 'Among all foraging insects, the honeybee stands out.', page_label: '7', ...over,
});

describe('quoting an attached highlight', () => {
    it('carries the text, the page, and the id', () => {
        const out = withAttachments([highlight()]);
        expect(out).toContain('Among all foraging insects');
        expect(out).toContain('p.7');
        expect(out).toContain('[u-H1]');
    });

    it('carries the user\'s own comment when there is one', () => {
        expect(withAttachments([highlight({ comment: 'check this against Valcourt' })]))
            .toContain("user's comment: check this against Valcourt");
    });

    it('clips a highlight that runs to a whole paragraph', () => {
        const out = withAttachments([highlight({ text: 'x'.repeat(900) })]);
        expect(out).toContain('…');
        expect(out.length).toBeLessThan(700);
    });

    it('collapses the line breaks a PDF selection carries', () => {
        // Text pulled off a two-column PDF arrives with newlines mid-sentence.
        expect(withAttachments([highlight({ text: 'odometry\n  of the\nwaggle dance' })]))
            .toContain('"odometry of the waggle dance"');
    });

    it('leaves an image region to the look-at-it path', () => {
        const out = withAttachments([
            { type: 'annotation', annotation_type: 'image', library_ref: 'u', zotero_key: 'I1', title: 'Figure 2' },
        ]);
        expect(out).toContain('an image');
        expect(out).toContain('view_attachment_image');
    });

    it('leaves an ink scribble alone — it has no text to quote', () => {
        const out = withAttachments([
            { type: 'annotation', annotation_type: 'ink', library_ref: 'u', zotero_key: 'K1', title: 'Ink' },
        ]);
        expect(out).toContain('- Ink [u-K1]');
    });
});

describe('telling the model how much it has', () => {
    it('says all of them when every highlight is attached', () => {
        const out = withAttachments(
            [highlight({ zotero_key: 'H1' }), highlight({ zotero_key: 'H2' })],
            { annotation_count: 2 },
        );
        expect(out).toContain('all of them are quoted above');
        expect(out).not.toContain('returns the rest');
    });

    it('points at the tool for the remainder when it is capped', () => {
        // A paper past the attach limit: the count is what stops the model
        // answering "your two highlights" about a paper carrying fifty.
        const out = withAttachments([highlight()], { annotation_count: 50 });
        expect(out).toContain('50');
        expect(out).toContain('1 quoted above');
        expect(out).toContain('get_annotations');
    });
});
