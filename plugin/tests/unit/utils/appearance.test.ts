// @vitest-environment jsdom

/**
 * Every pane wears one of the plugin's themes, Fresh unless another is chosen.
 *
 * "zotero" — Beaver's unthemed look, the default before 0.1.78 — may still be
 * stored here or arrive from a computer that has not updated; it reads as Fresh,
 * and the settings no longer offer it.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import pkg from '../../../package.json';
import { applyAppearance, normalizeTheme, readAppearance } from '../../../src/utils/appearance';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};
let root: HTMLDivElement;

beforeEach(() => {
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero as any).getMainWindows = () => [window];
    root = document.createElement('div');
    root.className = 'alphainz-root';
    document.body.appendChild(root);
});
afterEach(() => {
    root.remove();
});

const setTheme = (value: unknown) => { prefs[`${PREFIX}.uiTheme`] = value; };

describe('the theme', () => {
    it('reads the old unthemed choice, nothing at all, and anything unknown as Fresh', () => {
        expect(normalizeTheme('zotero')).toBe('fresh');
        expect(normalizeTheme(undefined)).toBe('fresh');
        expect(normalizeTheme('neon')).toBe('fresh');
        expect(normalizeTheme('quiet')).toBe('quiet');
        setTheme('zotero');
        expect(readAppearance().theme).toBe('fresh');
    });

    it('puts Fresh on a pane whose stored theme is the old unthemed one', () => {
        setTheme('zotero');
        applyAppearance();
        expect([...root.classList]).toEqual(expect.arrayContaining(['alphainz-theme-fresh', 'alphainz-styled']));
    });

    it('swaps one theme for another without leaving the old one behind', () => {
        setTheme('quiet');
        applyAppearance();
        setTheme('sky');
        applyAppearance();
        expect(root.classList.contains('alphainz-theme-sky')).toBe(true);
        expect(root.classList.contains('alphainz-theme-quiet')).toBe(false);
        expect(root.classList.contains('alphainz-styled')).toBe(true);
    });

    it('is offered in Settings as the four palettes, with Fresh chosen by default', async () => {
        setTheme('zotero');
        const { default: AppearanceSection } = await import('../../../react/components/preferences/AppearanceSection');
        const html = renderToStaticMarkup(React.createElement(AppearanceSection));
        expect(html).not.toContain('value="zotero"');
        expect(html).not.toContain('Choose Zotero');
        for (const theme of ['fresh', 'warm', 'quiet', 'sky']) expect(html).toContain(`value="${theme}"`);
        expect(html).toMatch(/<option value="fresh" selected="">Fresh<\/option>/);
    });
});
