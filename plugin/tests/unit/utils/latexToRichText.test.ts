/**
 * LaTeX in a selection answer becomes the rich text a Zotero comment can show.
 *
 * The comment field renders four tags and nothing else, so the target is not
 * "typeset" but "legible in the reader's popup": real sub- and superscripts,
 * Unicode letters and operators, one-line fractions. Cases are the fragments
 * that saved comments typically carry, plus the ways they can go wrong.
 */
import { describe, expect, it } from 'vitest';

import { convertMathInText, mathToPlainText, mathToRichText, replaceMath } from '../../../src/utils/latexToRichText';

describe('mathToRichText', () => {
    it.each([
        ['t_d=64 h', 't<sub>d</sub>=64 h'],
        ['x_2^*', 'x<sub>2</sub><sup>*</sup>'],
        ['\\alpha_s', 'α<sub>s</sub>'],
        ['p\\approx0.16', 'p ≈ 0.16'],
        ['10^{-6}\\,\\mathrm{m}', '10<sup>-6</sup> m'],
        ['N_{t2}<N<N_{t3}', 'N<sub>t2</sub><N<N<sub>t3</sub>'],
        ['\\frac{1}{x_2}', '1/x<sub>2</sub>'],
        ['\\frac{\\ell\\omega}{r_0 N}', 'ℓω/(r<sub>0</sub> N)'],
        ['r_KN_{\\text{max}}\\sim \\pi/2\\, \\rho_s', 'r<sub>K</sub>N<sub>max</sub> ∼ π/2 ρ<sub>s</sub>'],
        ['\\Lambda=2\\mu^2/t', 'Λ=2μ<sup>2</sup>/t'],
        ['CaCO_3', 'CaCO<sub>3</sub>'],
        ['\\theta_1+\\dots+\\theta_M', 'θ<sub>1</sub>+…+θ<sub>M</sub>'],
        ['1/\\sqrt{M}', '1/√M'],
        ['\\sqrt{a+b}', '√(a+b)'],
        ['D=\\langle X\\rangle-Y', 'D=⟨X⟩-Y'],
        ["\\phi'", 'φ′'],
        ['t_\\mathrm{D}', 't<sub>D</sub>'],
        ['e^{-t/x_2}', 'e<sup>-t/x<sub>2</sub></sup>'],
        ['\\sum_{k=1}^{N} S_k', 'Σ<sub>k=1</sub><sup>N</sup> S<sub>k</sub>'],
        ['\\int_0^\\infty e^{-x} dx', '∫<sub>0</sub><sup>∞</sup> e<sup>-x</sup> dx'],
        ['\\mathbf{v} \\cdot \\vec{n}', '<b>v</b> · n\u20D7'],
        ['\\hat{p}', 'p\u0302'],
        ['90^\\circ', '90°'],
        ["f''", 'f″'],
        ['\\left( \\frac{a}{b} \\right)', '(a/b)'],
        ['\\exp\\left(-\\frac{t}{x_2}\\right)', 'exp(-t/x<sub>2</sub>)'],
        ['\\ln x', 'ln x'],
        ['\\Delta N \\approx 3\\,r_0 t', 'ΔN ≈ 3 r<sub>0</sub> t'],
        ['\\mathbb{R}^3', 'ℝ<sup>3</sup>'],
        ['a \\times 10^{-3}', 'a × 10<sup>-3</sup>'],
    ])('%s → %s', (latex, expected) => {
        expect(mathToRichText(latex)).toBe(expected);
    });

    it('keeps a nested script of the same kind flat, since the comment cannot nest a tag in itself', () => {
        expect(mathToRichText('x_{y_z}')).toBe('x<sub>y_z</sub>');
    });

    it('drops the backslash of a command it does not know rather than leaving it', () => {
        expect(mathToRichText('\\foo x')).toBe('foo x');
    });

    it('writes ± as a sign where an operand starts, and as an operation between two', () => {
        expect(mathToRichText('|n_k=\\pm 1|')).toBe('|n<sub>k</sub>=±1|');
        expect(mathToRichText('|\\pm 1|')).toBe('|±1|');
        expect(mathToRichText('\\pm 2')).toBe('±2');
        expect(mathToRichText('\\{\\pm 1, \\mp 2\\}')).toBe('{±1, ∓2}');
        expect(mathToRichText('x \\approx \\pm 3')).toBe('x ≈ ±3');
        expect(mathToRichText('e^{\\pm i\\theta}')).toBe('e<sup>±iθ</sup>');
        expect(mathToRichText('a \\pm b')).toBe('a ± b');
        expect(mathToRichText('x_1 \\pm y')).toBe('x<sub>1</sub> ± y');
        expect(mathToRichText('|a| \\pm 1')).toBe('|a| ± 1');
    });

    it('keeps escaped characters and text as written', () => {
        expect(mathToRichText('\\text{50\\% eff.}')).toBe('50% eff.');
    });
});

describe('convertMathInText', () => {
    it('converts inline and display segments and leaves the prose alone', () => {
        expect(convertMathInText('该面团 $T_D=24.5$ °C，见 $$E = mc^2$$。')).toBe(
            '该面团 T<sub>D</sub>=24.5 °C，见 E = mc<sup>2</sup>。',
        );
    });

    it('does not mistake prices for math', () => {
        expect(convertMathInText('costs $5 and $10 more')).toBe('costs $5 and $10 more');
    });

    it('leaves an underscore outside math alone', () => {
        expect(convertMathInText('called read_document twice')).toBe('called read_document twice');
    });

    it('handles the backslash delimiters too', () => {
        expect(convertMathInText('so \\(x_2^*\\) and \\[\\alpha_s\\]')).toBe('so x<sub>2</sub><sup>*</sup> and α<sub>s</sub>');
    });

    it('is a no-op on text without math', () => {
        const text = 'The limit is the tunnel lining.';
        expect(convertMathInText(text)).toBe(text);
    });
});

describe('mathToPlainText', () => {
    it('writes scripts as Unicode script characters when they all have one', () => {
        expect(mathToPlainText('{}^{14}\\mathrm{C}^0')).toBe('¹⁴C⁰');
        expect(mathToPlainText('10^{-3}')).toBe('10⁻³');
        expect(mathToPlainText('x_2^*')).toBe('x₂*');
        expect(mathToPlainText('g_{ij}')).toBe('gᵢⱼ');
        expect(mathToPlainText('Q = \\ell\\omega_0 + M^\\dagger')).toBe('Q = ℓω₀ + M†');
    });

    it('keeps the caret or underscore for a script that has no Unicode form', () => {
        expect(mathToPlainText('N_{\\mathrm{eff}}')).toBe('N_eff');
        expect(mathToPlainText('K_M')).toBe('K_M');
        expect(mathToPlainText('x^{a+b}')).toBe('x^(a+b)');
        expect(mathToPlainText('x_{a<b}')).toBe('x_(a<b)');
    });

    it('converts symbols and leaves no tags or line breaks', () => {
        expect(mathToPlainText('\\langle x\\rangle\\leftrightarrow\\langle y\\rangle')).toBe('⟨x⟩ ↔ ⟨y⟩');
        expect(mathToPlainText('\\mathbf{v} = \\frac{1}{x_2}')).toBe('v = 1/x₂');
        expect(mathToPlainText('\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}')).toBe('1 0 0 1');
    });
});

describe('replaceMath', () => {
    it('hands each segment\'s source to the renderer and leaves prices alone', () => {
        expect(replaceMath('see $a_1$ and \\(b\\), for $5 or $10', (source) => `[${source}]`))
            .toBe('see [a_1] and [b], for $5 or $10');
    });
});
