/**
 * Saving a selection answer into the highlight's Zotero comment.
 *
 * The comment field is the user's own annotation, which sets the two rules
 * worth testing: never overwrite what is already there, and never leave raw
 * markdown in a field that renders as plain text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    appendToComment,
    finalAnswerText,
    formatCommentEntry,
    saveEntryToAnnotation,
    stripMarkdown,
} from '../../../react/utils/selectionChatComment';

describe('stripMarkdown', () => {
    it('turns bold and italic into the tags a comment can show', () => {
        expect(stripMarkdown('the **waggle dance** is *slow*')).toBe('the <b>waggle dance</b> is <i>slow</i>');
    });

    it('unwraps inline code', () => {
        expect(stripMarkdown('set `R0` to 4')).toBe('set R0 to 4');
    });

    it('turns list markers into bullets', () => {
        expect(stripMarkdown('- one\n- two')).toBe('• one\n• two');
    });

    it('leaves a formula alone', () => {
        // Asterisks and underscores are load-bearing in scientific notation; a
        // general markdown converter would eat them.
        const formula = 'Y = K_mm V_m S_t + gamma * N';
        expect(stripMarkdown(formula)).toBe(formula);
    });

    it('leaves multiplication written with a lone asterisk alone', () => {
        expect(stripMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6');
    });

    it('removes citation tags and the space before them', () => {
        // The sidebar turns these into clickable numbers; a comment has nothing
        // to turn them into, so a saved answer read `…发酵<citation id="u-83RKINTZ"
        // page="2" loc="s62"/>,其面团…`.
        expect(stripMarkdown('the EEG <citation id="u-A" page="3" loc="s12"/>. Next')).toBe('the EEG. Next');
        expect(stripMarkdown('发酵<citation id="u-83RKINTZ" page="2" loc="s62"/>,其面团')).toBe('发酵,其面团');
        expect(stripMarkdown('see <citation external_id="W1622025407"/> and <citation id="u-B">text</citation>.')).toBe('see and.');
    });
});

describe('appendToComment', () => {
    const entry = { question: 'What is this?', answer: 'A technique.' };

    it('keeps a comment the user already wrote', () => {
        // Overwriting would destroy the user's own note on their own highlight.
        const result = appendToComment('my own note', entry);
        expect(result.startsWith('my own note')).toBe(true);
        expect(result).toContain('A technique.');
    });

    it('starts clean when the comment is empty', () => {
        expect(appendToComment('', entry).startsWith('—')).toBe(true);
    });

    it('stacks a second answer after the first', () => {
        const once = appendToComment('', entry);
        const twice = appendToComment(once, { question: 'And why?', answer: 'Because.' });
        expect(twice.indexOf('A technique.')).toBeLessThan(twice.indexOf('Because.'));
        expect(twice.match(/AlphainZ/g)).toHaveLength(2);
    });

    it('writes formulas as the sub- and superscripts the comment can render', () => {
        // Saved as LaTeX these read `x_2^*` and `\\frac{1}{x_2}` in the reader's popup.
        const text = formatCommentEntry({
            question: 'what limits it?',
            answer: 'The limit is $x_2^*$, with $\\frac{1}{x_2} \\approx 2\\alpha_s N$ <citation id="u-A" page="3"/>.',
        });
        expect(text).toBe(
            '— AlphainZ\nQ: what limits it?\nA: The limit is x<sub>2</sub><sup>*</sup>, with 1/x<sub>2</sub> ≈ 2α<sub>s</sub> N.',
        );
    });

    it('labels both halves, so stacked exchanges keep their questions', () => {
        const text = formatCommentEntry(entry);
        expect(text).toBe('— AlphainZ\nQ: What is this?\nA: A technique.');
    });
});

describe('finalAnswerText', () => {
    const response = (text: string) => ({
        kind: 'response',
        parts: [{ part_kind: 'text', content: text }],
    });

    it('takes every text the user can read, not just the last', () => {
        /*
         * It used to stop at the last response with text, on the reasoning that
         * earlier ones are the model narrating before a tool call. That held
         * until a tool could be called *after* the answer: one run wrote 1365
         * characters carrying five citations, called `return_suggestions`, then
         * added a 162-character sign-off — and the sign-off became "the
         * answer", so all five citations were silently dropped.
         */
        const run = {
            model_messages: [
                response('Let me look that up.'),
                { kind: 'request', parts: [{ part_kind: 'tool-return', content: 'ok' }] },
                response('It measures flight distances.'),
            ],
        };
        expect(finalAnswerText(run)).toBe('Let me look that up.\n\nIt measures flight distances.');
    });

    it('keeps an answer that precedes a trailing sign-off', () => {
        const run = {
            model_messages: [
                response('The answer, with <citation id="u-A" page="3"/>.'),
                { kind: 'request', parts: [{ part_kind: 'tool-return', content: 'ok' }] },
                response('Let me know if you want more.'),
            ],
        };
        expect(finalAnswerText(run)).toContain('<citation id="u-A" page="3"/>');
    });

    it('keeps the answer that precedes a highlight proposal', () => {
        // A selection question is often answered and then marked: "The limit
        // is the tunnel lining. I'll propose a highlight." → create_highlight →
        // "Proposed." Treating the proposal like a read tool made the first
        // sentence narration, and the comment saved only "Proposed."
        const run = {
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'text', content: 'The limit is the tunnel lining.' },
                        { part_kind: 'tool-call', tool_name: 'create_highlight', tool_call_id: 'c1', args: {} },
                    ],
                },
                { kind: 'request', parts: [{ part_kind: 'tool-return', tool_name: 'create_highlight', tool_call_id: 'c1', content: 'PROPOSED' }] },
                response('Proposed one highlight.'),
            ],
        };
        expect(finalAnswerText(run)).toBe('The limit is the tunnel lining.\n\nProposed one highlight.');
    });

    it('joins split text parts', () => {
        const run = {
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'text', content: 'It ' },
                        { part_kind: 'text', content: 'measures.' },
                    ],
                },
            ],
        };
        expect(finalAnswerText(run)).toBe('It measures.');
    });

    it('drops narration that precedes the last real tool call', () => {
        // The same line the fold draws: text before the final tool call is the
        // model talking its way there, not the answer. A completed run always
        // closes with text after its last tool, so nothing real is lost.
        const run = {
            model_messages: [
                response('Let me check page 4.'),
                { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'x', tool_call_id: 'c1' }] },
                response('The answer.'),
            ],
        };
        expect(finalAnswerText(run)).toBe('The answer.');
    });

    it('treats return_suggestions as no tool at all', () => {
        // The suggestion chips arrive after the answer; counting them as a tool
        // would reclassify the answer as narration and drop its citations.
        const run = {
            model_messages: [
                response('The cited answer <citation id="u-A" page="3"/>.'),
                { kind: 'response', parts: [{ part_kind: 'tool-call', tool_name: 'return_suggestions', tool_call_id: 'c2' }] },
            ],
        };
        expect(finalAnswerText(run)).toContain('citation id="u-A"');
    });

    it('returns nothing for a run that produced no text', () => {
        expect(finalAnswerText({ model_messages: [] })).toBe('');
    });
});

describe('saveEntryToAnnotation', () => {
    let item: any;

    beforeEach(() => {
        item = {
            annotationComment: '',
            isAnnotation: () => true,
            saveTx: vi.fn(async () => undefined),
        };
        (Zotero as any).Items = { getByLibraryAndKey: vi.fn(() => item) };
    });

    it('writes the entry and saves', async () => {
        expect(await saveEntryToAnnotation(1, 'KEY', { question: 'q', answer: 'a' })).toBe(true);
        expect(item.annotationComment).toContain('Q: q');
        expect(item.annotationComment).toContain('A: a');
        expect(item.saveTx).toHaveBeenCalled();
    });

    it('reports failure when the highlight is gone', async () => {
        // The user can delete the highlight while the answer is still streaming.
        (Zotero as any).Items.getByLibraryAndKey = vi.fn(() => false);
        expect(await saveEntryToAnnotation(1, 'KEY', { question: 'q', answer: 'a' })).toBe(false);
    });

    it('refuses to write to something that is not an annotation', async () => {
        item.isAnnotation = () => false;
        expect(await saveEntryToAnnotation(1, 'KEY', { question: 'q', answer: 'a' })).toBe(false);
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('reports failure rather than throwing when the save fails', async () => {
        item.saveTx.mockRejectedValueOnce(new Error('locked'));
        expect(await saveEntryToAnnotation(1, 'KEY', { question: 'q', answer: 'a' })).toBe(false);
    });
});

describe('stripMarkdown: math in the comment', () => {
    it('writes inline math as sub- and superscripts', () => {
        // The comment field renders <sub> and <sup>; LaTeX source it cannot.
        expect(stripMarkdown('The time is $x_2^*$ here.')).toBe('The time is x<sub>2</sub><sup>*</sup> here.');
    });

    it('converts display math in place', () => {
        expect(stripMarkdown('Result:\n\n$$\\frac{1}{x_2} = \\lambda N$$')).toBe(
            'Result:\n\n1/x<sub>2</sub> = λN',
        );
    });

    it('leaves a lone dollar sign alone', () => {
        expect(stripMarkdown('it costs $5 total')).toBe('it costs $5 total');
    });

    it('leaves a whitespace-bounded pair alone', () => {
        // Same rule the renderer uses to tell math from currency.
        expect(stripMarkdown('costs $5 and then $10 later')).toBe(
            'costs $5 and then $10 later',
        );
    });

    it('still protects a starred quantity from the italics rule', () => {
        // Two `*` in one line must not pair up as emphasis once they sit in
        // superscript tags.
        expect(stripMarkdown('$x_2^*$ and $x_2$ differ')).toBe('x<sub>2</sub><sup>*</sup> and x<sub>2</sub> differ');
    });
});
