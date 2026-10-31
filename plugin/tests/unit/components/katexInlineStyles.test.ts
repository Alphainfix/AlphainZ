/**
 * The inline-math rule, guarded at the source.
 *
 * `overflow` on an inline-block moves its baseline to the bottom margin edge
 * (CSS 2.1 §10.8.1), so an inline formula sat above the line it belonged to and
 * carried its own scrollbar. Measured in a browser before and after: same-line
 * formulas were 15px apart vertically and one had a scrollbar; afterwards they
 * share a baseline and none does.
 *
 * A CSS regression has no runtime to catch it, so this reads the stylesheet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
    join(__dirname, '../../../addon/content/styles/beaver.css'),
    'utf8',
);

/**
 * The declarations of the first rule whose selector contains `selector`.
 *
 * Comments are stripped: the rules here are documented by explaining what is
 * deliberately absent, so a body read verbatim matches every property this file
 * asserts is not set.
 */
function ruleBody(selector: string): string {
    const at = css.indexOf(selector);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('inline math styling', () => {
    const inline = ruleBody('.markdown .katex {');

    it('sets no overflow on inline math', () => {
        // This is the whole bug: any non-visible overflow here re-breaks the
        // baseline of every inline formula in the panel.
        expect(inline).not.toMatch(/overflow/);
    });

    it('does not make inline math an inline-block', () => {
        // Only needed to make overflow and max-width apply; without those it
        // buys nothing and is half of what shifts the baseline.
        expect(inline).not.toMatch(/display\s*:/);
    });

    it('keeps the typographic choices that are actually wanted', () => {
        expect(inline).toMatch(/margin\s*:\s*0\s+0\.1em/);
        expect(inline).toMatch(/font-size\s*:\s*1\.1em/);
    });

    it('leaves display math its own scroll container', () => {
        // `.katex-display` is a block, so scrolling it costs no baseline — this
        // is where a wide formula is meant to be handled.
        expect(ruleBody('.markdown .katex-display {')).toMatch(/overflow-x\s*:\s*auto/);
    });

    it('cancels the inline side margin inside display math', () => {
        // katex.css centres display math; a side margin would shift it.
        expect(ruleBody('.markdown .katex-display > .katex {')).toMatch(/margin\s*:\s*0/);
    });
});
