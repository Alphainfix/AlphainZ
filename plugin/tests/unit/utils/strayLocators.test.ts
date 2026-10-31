/**
 * Locator labels come back out of the answer.
 *
 * The prompt says twice that `[s307]` belongs in tool arguments and never in
 * prose, and models write it anyway — measured across eighteen runs, at every
 * reasoning setting, a few answers each pass. To a reader it is worse than
 * nothing: it looks like a reference, points at nothing, and cannot be
 * clicked. A rule the model keeps breaking is a rule the code should enforce.
 */
import { describe, expect, it } from 'vitest';

import { stripStrayLocators } from '../../../react/utils/highlightCitations';

describe('taking locator labels out of an answer', () => {
    it('removes a sentence label and the space before it', () => {
        expect(stripStrayLocators('The forager count drops [s307].'))
            .toBe('The forager count drops.');
    });

    it('removes a range', () => {
        expect(stripStrayLocators('It is quantitative [s307-s308] and weather-independent.'))
            .toBe('It is quantitative and weather-independent.');
        expect(stripStrayLocators('Also [s12–s14] here.')).toBe('Also here.');
    });

    it('removes paragraph and heading labels too', () => {
        expect(stripStrayLocators('See the intro [p4] and the method [heading2].'))
            .toBe('See the intro and the method.');
    });

    it('keeps the line break when a label opens a line', () => {
        expect(stripStrayLocators('First.\n[s9] Second.')).toBe('First.\nSecond.');
    });

    it('leaves a real citation tag alone', () => {
        const answer = 'Quantitative <citation id="u-74G6DHUV" page="6"/> and clean.';
        expect(stripStrayLocators(answer)).toBe(answer);
    });

    it('leaves ordinary bracketed text alone', () => {
        // A paper's own reference marks, a matrix index, an array subscript.
        for (const text of ['As shown in [42].', 'the term [s] is', 'x[step] grows', '[see below]']) {
            expect(stripStrayLocators(text)).toBe(text);
        }
    });

    it('handles an answer with nothing to strip, and an empty one', () => {
        expect(stripStrayLocators('Plain answer.')).toBe('Plain answer.');
        expect(stripStrayLocators('')).toBe('');
    });

    it('removes several in one answer', () => {
        expect(stripStrayLocators('A [s1]. B [s2]. C [s3].')).toBe('A. B. C.');
    });
});

/**
 * A bare attachment id becomes a citation instead of being deleted.
 *
 * The opposite treatment from a locator, and for a reason: `[s307]` names a
 * sentence inside a document nobody downstream can resolve, but
 * `[u-GPQ4HIAG]` names the attachment itself — the model got the id right and
 * the syntax wrong, so the tag can be rebuilt exactly. Seen filling a real
 * answer, six in one bullet, every one unclickable.
 */
describe('promoting a bare reference', () => {
    it('turns a user-library id into a citation', async () => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        expect(promoteBareReferences('the foraging range widens [u-GPQ4HIAG]'))
            .toBe('the foraging range widens <citation id="u-GPQ4HIAG"/>');
    });

    it('handles a group-library id too', async () => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        expect(promoteBareReferences('[g6413557-ABC12345]'))
            .toBe('<citation id="g6413557-ABC12345"/>');
    });

    it('converts several in one line', async () => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        const out = promoteBareReferences('a [u-TWIA2954][u-EDCSGIIA][u-6DXQZTKJ]');
        expect((out.match(/<citation/g) ?? [])).toHaveLength(3);
        expect(out).not.toContain('[u-');
    });

    it('leaves an existing citation tag alone', async () => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        const tagged = 'quantitative <citation id="u-74G6DHUV" page="6"/> and clean';
        expect(promoteBareReferences(tagged)).toBe(tagged);
    });

    it('leaves ordinary brackets alone', async () => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        // A paper's own reference marks, and anything not shaped like an id.
        for (const text of ['As shown in [42].', '[see below]', '[u-lowercase]', '[x-ABCD1234]']) {
            expect(promoteBareReferences(text), text).toBe(text);
        }
    });

    it('composes with the locator stripper the way the run does', async () => {
        const { promoteBareReferences, stripStrayLocators } = await import(
            '../../../react/utils/highlightCitations'
        );
        const answer = 'χ² rises [u-ZHF8GQSF] near noon [s307].';
        expect(stripStrayLocators(promoteBareReferences(answer)))
            .toBe('χ² rises <citation id="u-ZHF8GQSF"/> near noon.');
    });
});

/**
 * The wrappings models actually use.
 *
 * Measured across fifty-two evaluation answers: square brackets forty times,
 * round parentheses five, bold four, fullwidth parentheses three, backticks
 * twice, and several with no wrapper at all. A pattern that only knew square
 * brackets left most of them on screen.
 */
describe('promoting the shapes seen in the wild', () => {
    const cases: Array<[string, string]> = [
        ['[u-DF26KGAI]', '<citation id="u-DF26KGAI"/>'],
        ['(u-52IAYNTH)', '<citation id="u-52IAYNTH"/>'],
        ['（u-52IAYNTH）', '<citation id="u-52IAYNTH"/>'],
        ['`u-52IAYNTH`', '<citation id="u-52IAYNTH"/>'],
        ['*u-52IAYNTH*', '<citation id="u-52IAYNTH"/>'],
        ['u-DF26KGAI', '<citation id="u-DF26KGAI"/>'],
    ];
    it.each(cases)('promotes %s', async (input, expected) => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        expect(promoteBareReferences(input)).toBe(expected);
    });

    it('still leaves a real tag untouched', async () => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        const tagged = 'see <citation id="u-74G6DHUV" page="6"/> for this';
        expect(promoteBareReferences(tagged)).toBe(tagged);
    });

    it('handles a sentence shaped like the one it was found in', async () => {
        const { promoteBareReferences } = await import('../../../react/utils/highlightCitations');
        const real = '上限受限于 30 °C 发酵的持续时间。[u-DF26KGAI][u-5XAJDUPZ]';
        const out = promoteBareReferences(real);
        expect((out.match(/<citation/g) ?? [])).toHaveLength(2);
        expect(out).not.toMatch(/\[u-/);
    });
});
