/**
 * Every theme declares the same tokens, light and dark, and every theme the
 * stylesheet knows is one the settings offer and the class list can apply.
 *
 * A palette is a block of custom properties; a token a theme forgets is not a
 * visible error, it is a component that quietly keeps the previous theme's
 * colour. Parity with the first palette is the check that catches that.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../addon/content/styles/alphainz-appearance.css', import.meta.url), 'utf8');
const appearance = readFileSync(new URL('../../../src/utils/appearance.ts', import.meta.url), 'utf8');
const section = readFileSync(new URL('../../../react/components/preferences/AppearanceSection.tsx', import.meta.url), 'utf8');

const THEMES = ['fresh', 'warm', 'quiet', 'sky'];

function tokensOf(theme: string): Set<string> {
    const start = css.indexOf(`.alphainz-root.alphainz-theme-${theme} {`);
    expect(start, `no palette block for ${theme}`).toBeGreaterThan(-1);
    const end = css.indexOf('\n}', start);
    const block = css.slice(start, end);
    return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
}

describe('appearance themes', () => {
    const reference = tokensOf('quiet');

    it.each(THEMES)('%s declares the same tokens as Quiet, light and dark', (theme) => {
        const tokens = tokensOf(theme);
        const missing = [...reference].filter((t) => !tokens.has(t));
        const extra = [...tokens].filter((t) => !reference.has(t));
        expect(missing, `${theme} is missing`).toEqual([]);
        expect(extra, `${theme} adds tokens no other theme has`).toEqual([]);
        // Every light token has its dark twin, so the media-query block finds one.
        for (const token of tokens) {
            if (token.startsWith('--d-')) continue;
            if (token === '--color-scrollbar-background') continue; // transparent in both
            expect(tokens.has(`--d-${token.slice(2)}`), `${theme}: ${token} has no dark value`).toBe(true);
        }
    });

    it('is applied by the class list and offered by the settings, under the same ids', () => {
        for (const theme of THEMES) {
            expect(appearance).toContain(`'alphainz-theme-${theme}'`);
            expect(appearance).toMatch(new RegExp(`UiTheme = [^;]*'${theme}'`));
            expect(section).toContain(`id: '${theme}'`);
        }
    });

    it('Sky carries the DeepSeek Harness palette it was copied from', () => {
        const sky = css.slice(css.indexOf('.alphainz-root.alphainz-theme-sky {'));
        const block = sky.slice(0, sky.indexOf('\n}'));
        expect(block).toContain('--alphainz-paper: #f2f6fd');
        expect(block).toContain('--color-background: #ffffff');
        expect(block).toContain('--accent-blue: #4478bc');
        expect(block).toContain('--accent-azure: #376aad');
        expect(block).toContain('--d-alphainz-paper: #12151a');
        expect(block).toContain('--d-accent-blue: #78a9eb');
    });
});
