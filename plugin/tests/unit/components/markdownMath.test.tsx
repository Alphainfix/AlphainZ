/**
 * LaTeX in an answer, through the real render pipeline.
 *
 * The delimiters a model actually emits vary by model and by prompt, so this
 * pins down which forms survive. `.katex` in the output means KaTeX typeset it;
 * its absence means the reader sees backslashes.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import MarkdownRenderer from '../../../react/components/messages/MarkdownRenderer';

const typeset = (content: string): boolean =>
    renderToStaticMarkup(React.createElement(MarkdownRenderer, { content })).includes('katex');

const html = (content: string): string =>
    renderToStaticMarkup(React.createElement(MarkdownRenderer, { content }));

describe('math in answers', () => {
    it('typesets dollar-delimited inline math', () => {
        expect(typeset('The doubling time is $x_2^*$ here.')).toBe(true);
    });

    it('typesets dollar-delimited display math', () => {
        expect(typeset('Result:\n\n$$\\frac{1}{x_2^*} = \\lambda N$$\n')).toBe(true);
    });

    it('typesets the paren form models often emit instead', () => {
        // Normalised to `$...$` before parsing; remark-math does not accept it.
        expect(typeset('The doubling time is \\(x_2^*\\) here.')).toBe(true);
    });

    it('typesets the bracket display form', () => {
        expect(typeset('Result:\n\n\\[ \\frac{1}{x_2} = \\lambda N \\]\n')).toBe(true);
    });

    it('typesets a LaTeX equation environment', () => {
        // Models trained on papers reach for this by habit, and it arrives as
        // literal backslashes unless it is normalised like the other forms.
        expect(typeset('Result:\n\n\\begin{equation}\nE = mc^2\n\\end{equation}\n')).toBe(true);
    });

    it('typesets an aligned multi-line derivation', () => {
        expect(
            typeset('\\begin{align}\na &= b + c \\\\\nd &= e\n\\end{align}\n'),
        ).toBe(true);
    });

    it('leaves a bare dollar amount alone', () => {
        // "$5 and $10" must not become math, or every price in a paper turns
        // into a formula.
        expect(typeset('It costs $5 and then $10 later.')).toBe(false);
    });

    it('does not typeset math inside a code fence', () => {
        const out = html('```\n$x^2$\n```\n');
        expect(out).toContain('<code');
        expect(out).not.toContain('katex');
    });

    it('keeps subscripts and superscripts distinct', () => {
        // Papers are full of quantities like `x_2^*`; a renderer that
        // drops the star or the subscript is worse than one that shows source.
        const out = html('The value $x_2^*$ matters.');
        expect(out).toContain('katex');
        expect(out).toContain('∗');
    });
});
