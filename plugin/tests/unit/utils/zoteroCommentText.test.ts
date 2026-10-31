/**
 * Every comment the plugin writes into Zotero goes through one conversion.
 *
 * The field renders four tags and nothing else, so formulas become sub- and
 * superscripts, emphasis becomes Zotero's tags, and sidebar-only markup goes.
 */
import { describe, expect, it } from 'vitest';

import { stripCommentTags, toZoteroCommentText, toZoteroCommentTextOrNull } from '../../../src/utils/zoteroCommentText';

describe('toZoteroCommentText', () => {
    it('converts formulas, emphasis and bullets, and drops citation tags', () => {
        expect(
            toZoteroCommentText('**Key**: $t_2^*$ limits it <citation id="u-A" page="3"/>.\n- one\n- `two`'),
        ).toBe('<b>Key</b>: t<sub>2</sub><sup>*</sup> limits it.\n• one\n• two');
    });

    it('is idempotent, so converting at proposal and again at execution is harmless', () => {
        const once = toZoteroCommentText('the $\\gamma_w N$ term, *roughly* $10^{-6}$ m');
        expect(toZoteroCommentText(once)).toBe(once);
        expect(once).toBe('the γ<sub>w</sub> N term, <i>roughly</i> 10<sup>-6</sup> m');
    });

    it('leaves prose, prices and identifiers alone', () => {
        const text = 'costs $5 and $10; see read_document';
        expect(toZoteroCommentText(text)).toBe(text);
    });

    it('leaves an unpaired dollar sign alone', () => {
        expect(toZoteroCommentText('so $E = mc^2 holds')).toBe('so $E = mc^2 holds');
    });

    it('strips the tags again for a surface that cannot render them', () => {
        expect(stripCommentTags('t<sub>2</sub><sup>*</sup> and <b>x</b>')).toBe('t2* and x');
    });

    it('passes null and non-strings through as null', () => {
        expect(toZoteroCommentTextOrNull(null)).toBeNull();
        expect(toZoteroCommentTextOrNull(undefined)).toBeNull();
        expect(toZoteroCommentTextOrNull('$t_d$')).toBe('t<sub>d</sub>');
    });
});
