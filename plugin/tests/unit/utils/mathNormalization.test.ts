/**
 * The two string transforms that decide whether a formula reaches the renderer.
 */
import { describe, expect, it } from 'vitest';

import {
    escapeCurrencyDollars,
    normalizeMathDelimiters,
    normalizeMathEnvironments,
} from '../../../react/utils/mathNormalization';

describe('normalizeMathEnvironments', () => {
    it('wraps an equation environment in display math', () => {
        expect(normalizeMathEnvironments('\\begin{equation}E = mc^2\\end{equation}')).toContain(
            '$$\nE = mc^2\n$$',
        );
    });

    it('handles the starred form', () => {
        expect(normalizeMathEnvironments('\\begin{equation*}x\\end{equation*}')).toContain('$$');
    });

    it('keeps alignment by mapping align to aligned', () => {
        // Unwrapping instead would collapse a derivation onto one line, because
        // KaTeX has no top-level `align`.
        const out = normalizeMathEnvironments('\\begin{align}a &= b \\\\ c &= d\\end{align}');
        expect(out).toContain('\\begin{aligned}');
        expect(out).toContain('\\end{aligned}');
        expect(out).toContain('$$');
    });

    it('maps gather to gathered', () => {
        expect(normalizeMathEnvironments('\\begin{gather}a\\end{gather}')).toContain(
            '\\begin{gathered}',
        );
    });

    it('leaves an environment the model already put inside display math alone', () => {
        const src = '$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$';
        expect(normalizeMathEnvironments(src)).toBe(src);
    });

    it('leaves text with no environment untouched', () => {
        expect(normalizeMathEnvironments('Just prose about $t_2^*$.')).toBe(
            'Just prose about $t_2^*$.',
        );
    });
});

describe('escapeCurrencyDollars', () => {
    it('leaves inline math alone', () => {
        expect(escapeCurrencyDollars('The value $t_2^*$ matters.')).toBe(
            'The value $t_2^*$ matters.',
        );
    });

    it('escapes two prices so the prose between them stays prose', () => {
        // The whole point: "It costs $5 and then $10" was one typeset formula.
        expect(escapeCurrencyDollars('It costs $5 and then $10.')).toBe(
            'It costs \\$5 and then \\$10.',
        );
    });

    it('escapes a span whose content starts with whitespace', () => {
        expect(escapeCurrencyDollars('a $ x$ b')).toBe('a \\$ x\\$ b');
    });

    it('leaves display math whole', () => {
        const src = 'Result:\n\n$$\n\\frac{1}{t_2} = \\lambda N\n$$\n';
        expect(escapeCurrencyDollars(src)).toBe(src);
    });

    it('leaves an already-escaped dollar as it is', () => {
        expect(escapeCurrencyDollars('costs \\$5 flat')).toBe('costs \\$5 flat');
    });

    it('does not touch dollars inside a fenced code block', () => {
        const src = '```\necho $HOME and $PATH\n```\n';
        expect(escapeCurrencyDollars(src)).toBe(src);
    });

    it('does not touch dollars inside an inline code span', () => {
        expect(escapeCurrencyDollars('run `echo $A and $B` now')).toBe(
            'run `echo $A and $B` now',
        );
    });

    it('leaves a single unpaired dollar alone', () => {
        expect(escapeCurrencyDollars('it costs $5 total')).toBe('it costs $5 total');
    });

    it('does not pair dollars across a blank line', () => {
        // A paragraph break ends inline math, so these two are unpaired rather
        // than one span swallowing the break.
        expect(escapeCurrencyDollars('costs $5\n\nlater $10')).toBe('costs $5\n\nlater $10');
    });

    it('keeps math that legitimately starts with a digit', () => {
        expect(escapeCurrencyDollars('a tolerance of $10^{-6}$ m')).toBe(
            'a tolerance of $10^{-6}$ m',
        );
    });
});

describe('normalizeMathDelimiters', () => {
    it('rewrites the form a model actually reaches for', () => {
        // Asked in Chinese about bread proofing, gpt-5.6 wrote every symbol
        // in the answer this way rather than with dollars.
        expect(normalizeMathDelimiters('导致 \\(t_2^*\\) 变短'))
            .toBe('导致 $t_2^*$ 变短');
    });

    it('trims the body, so the next pass does not read it as currency', () => {
        // `$ t_2 $` has whitespace against both delimiters, which is exactly
        // how escapeCurrencyDollars tells a price from a formula — leaving the
        // spaces in turns the formula back into escaped prose.
        expect(normalizeMathDelimiters('导致 \\( t_2^* \\) 变短'))
            .toBe('导致 $t_2^*$ 变短');
    });

    it('promotes the display pair to its own block', () => {
        expect(normalizeMathDelimiters('\\[ E = mc^2 \\]'))
            .toBe('\n$$\nE = mc^2\n$$\n');
    });

    it('leaves fenced code alone', () => {
        // A fence explaining LaTeX is text about the syntax, not the syntax.
        const src = '```\n用 \\(x\\) 表示\n```';
        expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('leaves an inline code span alone', () => {
        const src = '写成 `\\(x\\)` 这样';
        expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('survives the full pipeline in the order the renderer applies it', () => {
        const out = escapeCurrencyDollars(
            normalizeMathEnvironments(
                normalizeMathDelimiters('导致 \\( t_2^* \\) 变短，而 \\(t_2\\) 不同'),
            ),
        );
        expect(out).toBe('导致 $t_2^*$ 变短，而 $t_2$ 不同');
        expect(out).not.toContain('\\$');
    });
});
