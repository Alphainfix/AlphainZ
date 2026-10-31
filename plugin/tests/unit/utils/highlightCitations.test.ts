/**
 * Linking the answer to the passage it just proposed highlighting.
 *
 * The tool hands the model a ready `<citation>` tag and the model leaves it
 * out — told plainly to place it, DeepSeek flash quoted the passage, named the
 * page, and wrote no tag, so the reader had nothing to click and had to go find
 * the sentence again. Same lesson as the search cap: a requirement that has to
 * hold cannot live in the prompt.
 */
import { describe, expect, it } from 'vitest';

import {
    attachHighlightCitations,
    attachPageCitations,
    findQuoteEnd,
    recordProposedHighlight,
    takeProposedHighlights,
    withRewrittenAnswer,
    promoteBareSentenceLocators,
    stripStrayLocators,
} from '../../../react/utils/highlightCitations';

const HL = {
    attachmentId: 'u-RBJE2JYL',
    page: 4,
    text: 'In order to optimize the flavour, γ should be large and the proofing time must be as long as possible.',
};

describe('attachHighlightCitations', () => {
    it('puts the marker straight after the quoted passage', () => {
        const answer = `I propose one highlight.\n\n> ${HL.text}\n\nThat is the design principle.`;
        const out = attachHighlightCitations(answer, [HL]);
        expect(out).toContain(`possible.<citation id="u-RBJE2JYL" page="4"/>`);
    });

    it('matches a quote the model retyped with different punctuation', () => {
        // Straightened quotes, a dropped full stop, collapsed whitespace — none
        // of which change the words.
        const answer = `The paper says: "In order to optimize the flavour, γ should be\nlarge and the proofing time must be as long as possible" — that is the core.`;
        const out = attachHighlightCitations(answer, [HL]);
        expect(out).toMatch(/possible"<citation id="u-RBJE2JYL" page="4"\/>/);
    });

    it('leaves the answer alone when the passage is not quoted', () => {
        // Nothing is guessed about where a passage is being discussed.
        const answer = 'I proposed a highlight on the flavour scaling in section II.B.';
        expect(attachHighlightCitations(answer, [HL])).toBe(answer);
    });

    it('does not add a second marker when the model did place one', () => {
        const answer = `> ${HL.text}<citation id="u-RBJE2JYL" page="4"/>`;
        expect(attachHighlightCitations(answer, [HL])).toBe(answer);
    });

    it('is a no-op with no proposals', () => {
        expect(attachHighlightCitations('anything', [])).toBe('anything');
    });

    it('refuses to match on a fragment too short to be unambiguous', () => {
        expect(findQuoteEnd('the cat sat', 'the cat')).toBe(-1);
    });
});

describe('the per-run record', () => {
    it('is read once and then forgotten', () => {
        recordProposedHighlight('run-1', HL);
        recordProposedHighlight('run-1', { ...HL, page: 5 });
        expect(takeProposedHighlights('run-1')).toHaveLength(2);
        // A reopened thread must not re-link an answer that already carries its
        // markers.
        expect(takeProposedHighlights('run-1')).toHaveLength(0);
    });

    it('ignores a proposal with no run to attach it to', () => {
        recordProposedHighlight('', HL);
        expect(takeProposedHighlights('')).toHaveLength(0);
    });
});

describe('withRewrittenAnswer', () => {
    it('rewrites every response that has text', () => {
        /*
         * It used to rewrite only the last one. That was right until a tool
         * could be called after the answer — `return_suggestions` — after which
         * the model often adds a one-line sign-off, and the sign-off became the
         * only text considered. The quotes in the answer above it were never
         * linked.
         */
        const run = {
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'text', content: 'the answer' }] },
                { kind: 'request', parts: [{ part_kind: 'tool-return', content: 'ok' }] },
                { kind: 'response', parts: [{ part_kind: 'text', content: 'sign-off' }] },
            ],
        };
        const out = withRewrittenAnswer(run, (t) => `${t}!`);
        expect(out.model_messages![0].parts[0].content).toBe('the answer!');
        expect(out.model_messages![2].parts[0].content).toBe('sign-off!');
    });

    it('leaves a response the rewrite does not touch exactly as it was', () => {
        const run = {
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'text', content: 'quote here' }] },
                { kind: 'response', parts: [{ part_kind: 'text', content: 'nothing to match' }] },
            ],
        };
        const out = withRewrittenAnswer(run, (t) => (t.includes('quote') ? `${t}!` : t));
        expect(out.model_messages![0].parts[0].content).toBe('quote here!');
        expect(out.model_messages![1]).toBe(run.model_messages[1]);
    });

    it('collapses split text parts so they still join to the rewritten answer', () => {
        const run = {
            model_messages: [
                {
                    kind: 'response',
                    parts: [
                        { part_kind: 'text', content: 'one ' },
                        { part_kind: 'text', content: 'two' },
                    ],
                },
            ],
        };
        const out = withRewrittenAnswer(run, (t) => t.toUpperCase());
        const joined = out.model_messages![0].parts
            .filter((p) => p.part_kind === 'text')
            .map((p) => p.content)
            .join('');
        expect(joined).toBe('ONE TWO');
    });

    it('returns the same run when nothing changed', () => {
        const run = {
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'text', content: 'x' }] },
            ],
        };
        expect(withRewrittenAnswer(run, (t) => t)).toBe(run);
    });
});

describe('linking a shortened quote', () => {
    /*
     * Requiring the whole passage was too strict for the ordinary case: the
     * model quotes the half of the sentence that makes its point, and the link
     * was dropped for a "paraphrase" that was really just shorter.
     */
    const highlight = {
        attachmentId: 'u-AAA',
        page: 4,
        text: 'The proofing time scales inversely with the starter concentration across four orders of magnitude.',
    };

    it('links a quote that stops early', () => {
        const answer = 'They report that the proofing time scales inversely with the starter concentration.';
        const out = attachHighlightCitations(answer, [highlight]);
        expect(out).toContain('<citation id="u-AAA" page="4"/>');
    });

    it('links a quote that starts late', () => {
        const answer = 'The paper says it scales inversely with the starter concentration across four orders of magnitude.';
        expect(attachHighlightCitations(answer, [highlight])).toContain('page="4"');
    });

    it('leaves an answer that shares only a stock phrase alone', () => {
        // Seven words of boilerplate is not a quotation, and a marker on the
        // wrong sentence is worse than none.
        const answer = 'This happens across four orders of magnitude in other systems too.';
        expect(attachHighlightCitations(answer, [highlight])).toBe(answer);
    });
});

describe('linking the pages an answer names', () => {
    it('links "p. 7" when the run highlighted page 7 of one document', () => {
        const out = attachPageCitations('The definition is given on p. 7 of the review.', ['u-BBB'], [7]);
        expect(out).toContain('p. 7<citation id="u-BBB" page="7"/>');
    });

    it('links the Chinese form too', () => {
        // The answer follows the language of the question, and this user asks
        // in both.
        const out = attachPageCitations('这个定义在第 12 页。', ['u-BBB'], [12]);
        expect(out).toContain('<citation id="u-BBB" page="12"/>');
    });

    it('puts the marker outside a parenthetical', () => {
        const out = attachPageCitations('It is defined there (p. 7).', ['u-BBB'], [7]);
        expect(out).toContain('(p. 7)<citation');
    });

    it('links each page once', () => {
        const out = attachPageCitations('See p. 7, and again on p. 7, then p. 9.', ['u-BBB'], [7, 9]);
        expect(out.match(/<citation/g)).toHaveLength(2);
    });

    it('does nothing when two documents were read', () => {
        // "p. 7" of which paper? A link to the wrong one is worse than text.
        const answer = 'Both discuss it on p. 7.';
        expect(attachPageCitations(answer, ['u-BBB', 'u-CCC'], [7])).toBe(answer);
    });

    it('leaves a marker the model placed itself alone', () => {
        const answer = 'It is on p. 7 <citation id="u-BBB" page="7"/> of the review.';
        expect(attachPageCitations(answer, ['u-BBB'], [7])).toBe(answer);
    });

    it('does not link a page the answer is ruling out', () => {
        /*
         * The live answer this rule comes from: "Both highlights are on page 7
         * — not page 8." Page 7 already carried the model's own marker, so the
         * only link the first version added was to page 8: a confident pointer
         * to the page the sentence exists to deny. No highlight was placed on
         * page 8, so it is not linkable.
         */
        const answer = 'Both highlights are on page 7 <citation id="u-BBB" page="7"/> — not page 8.';
        expect(attachPageCitations(answer, ['u-BBB'], [7])).toBe(answer);
    });

    it('does nothing when the run highlighted nothing', () => {
        const answer = 'Most reviews cover this by page 3.';
        expect(attachPageCitations(answer, ['u-BBB'], [])).toBe(answer);
    });
});

describe('promoteBareSentenceLocators', () => {
    const DOC = 'u-GPQ4HIAG';

    it('promotes a bare range into a clickable citation, dash regardless', () => {
        for (const dash of ['-', '\u2013', '\u2014']) {
            expect(promoteBareSentenceLocators(`evidence at s223${dash}s225 here`, DOC))
                .toBe(`evidence at <citation id="${DOC}" loc="s223-s225"/> here`);
        }
    });

    it('normalises a right side written without its prefix', () => {
        // The grammar range parser requires the prefix on both ends.
        expect(promoteBareSentenceLocators('s223-225', DOC))
            .toBe(`<citation id="${DOC}" loc="s223-s225"/>`);
    });

    it('promotes bracketed and single forms too', () => {
        expect(promoteBareSentenceLocators('see [s307] and s12.', DOC))
            .toBe(`see <citation id="${DOC}" loc="s307"/> and <citation id="${DOC}" loc="s12"/>.`);
    });

    it('does nothing without a single known document', () => {
        // A link that can jump into the wrong paper is worse than no link —
        // the residue sweep removes these instead.
        expect(promoteBareSentenceLocators('s223-s225', null)).toBe('s223-s225');
    });

    it('leaves locators already inside a tag alone', () => {
        const tagged = `<citation id="${DOC}" loc="s86-s88"/>`;
        expect(promoteBareSentenceLocators(tagged, DOC)).toBe(tagged);
    });

    it('does not bite ordinary words and symbols', () => {
        for (const text of ['the 1980s were', 'file s223b', 'S11 parameter', "'s223'", 'means223']) {
            expect(promoteBareSentenceLocators(text, DOC)).toBe(text);
        }
    });

    it('a promoted locator survives the residue sweep', () => {
        // Order in the publisher: promote first, strip what could not be.
        const out = stripStrayLocators(promoteBareSentenceLocators('see [s307]', DOC));
        expect(out).toContain('loc="s307"');
    });

    it('the residue sweep still removes what ambiguity left behind', () => {
        const out = stripStrayLocators(promoteBareSentenceLocators('see [s307].', null));
        expect(out).toBe('see.');
    });
});

describe('the resolver keeps the locator', () => {
    it('a citation tag with loc carries it into metadata', async () => {
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            Libraries: { userLibraryID: 1 },
            Items: { getByLibraryAndKey: () => false },
        };
        const { resolveCitationTag } = await import('../../../react/utils/localCitations');
        const tag = {
            raw: '<citation id="u-ABCDEFGH" loc="s223-s225"/>',
            attrs: { id: 'u-ABCDEFGH', loc: 's223-s225' },
        } as any;
        const citation = resolveCitationTag(tag, 0);
        // Activation resolves this to sentence boxes from the cached
        // extraction — without the field the click could only reveal.
        expect((citation as any).loc).toBe('s223-s225');
    });
});
