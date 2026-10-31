/**
 * Applying the appearance settings to the panes.
 *
 * A theme is a set of custom properties on `.alphainz-root` (see
 * `alphainz-appearance.css`), so switching one is a class swap and switching a
 * font size is one inline property. Nothing re-renders and no component knows
 * a theme exists.
 */

import config from '../../package.json';
import { getPref } from './prefs';

export type UiTheme = 'fresh' | 'warm' | 'quiet' | 'sky';
export const UI_THEMES: readonly UiTheme[] = ['fresh', 'warm', 'quiet', 'sky'];
export const DEFAULT_THEME: UiTheme = 'fresh';
export type UiFont = 'system' | 'serif' | 'sans';
export type UiColorScheme = 'auto' | 'light' | 'dark';

const THEME_CLASSES = [
    'alphainz-theme-warm',
    'alphainz-theme-quiet',
    'alphainz-theme-fresh',
    'alphainz-theme-sky',
    /*
     * Carried by every theme. The shape rules — hairlines instead of fills,
     * the report's markdown devices — are the same in all of them, and hanging
     * those off one class is what keeps adding a palette to a block of custom
     * properties rather than an edit to sixty selectors.
     */
    'alphainz-styled',
];
const FONT_CLASSES = ['alphainz-font-serif', 'alphainz-font-sans'];

/** Font sizes the slider offers, in px. Zotero's own is 13. */
export const FONT_SIZES = [11, 12, 13, 14, 15, 16, 17] as const;
/** Leading, loosest to tightest, keyed by the label the settings show. */
export const LINE_HEIGHTS: Record<string, number> = {
    compact: 1.4,
    normal: 1.55,
    relaxed: 1.75,
};

/**
 * The theme a stored value names. Anything else — "zotero", the unthemed look
 * that was the default before 0.1.78, still stored here or arriving from a
 * computer that has not updated — is the default.
 */
export function normalizeTheme(value: unknown): UiTheme {
    return UI_THEMES.find((theme) => theme === value) ?? DEFAULT_THEME;
}

export function readAppearance() {
    const theme = normalizeTheme(getPref('uiTheme'));
    const font = String(getPref('uiFont') ?? 'system') as UiFont;
    const rawSize = Number(getPref('uiFontSize'));
    const size = FONT_SIZES.includes(rawSize as any) ? rawSize : 13;
    const leadingKey = String(getPref('uiLineHeight') ?? 'normal');
    const leading = LINE_HEIGHTS[leadingKey] ?? LINE_HEIGHTS.normal;
    const scheme = String(getPref('uiColorScheme') ?? 'auto') as UiColorScheme;
    return { theme, font, size, leading, leadingKey, scheme };
}

/** Every pane the plugin owns in a given window. */
function rootsIn(doc: Document): HTMLElement[] {
    return Array.from(doc.querySelectorAll('.alphainz-root')) as HTMLElement[];
}

/**
 * Push the current settings onto every pane, in every open window.
 *
 * Called on startup, whenever a pane is created, and whenever a setting
 * changes. Idempotent: it sets the same classes and properties every time.
 */
export function applyAppearance(): void {
    const { theme, font, size, leading, scheme } = readAppearance();
    const windows: Window[] = [];
    const add = (win: any) => {
        if (win && !windows.includes(win)) windows.push(win as Window);
    };
    try {
        for (const win of (Zotero.getMainWindows?.() ?? []) as any[]) add(win);
    } catch { /* no windows yet */ }
    try {
        add(Zotero.getMainWindow?.());
    } catch { /* ignore */ }
    /*
     * The standalone chat window is not a main window, so neither call above
     * returns it. Enumerating every window and letting `rootsIn` decide is
     * both simpler and safe: a window with no pane contributes nothing.
     */
    try {
        const en = (Services as any)?.wm?.getEnumerator?.(null);
        while (en?.hasMoreElements?.()) add(en.getNext());
    } catch { /* enumerator unavailable */ }

    for (const win of windows) {
        if (!win || (win as any).closed || !win.document) continue;
        for (const root of rootsIn(win.document)) {
            root.classList.remove(...THEME_CLASSES, ...FONT_CLASSES);
            root.classList.add(`alphainz-theme-${theme}`, 'alphainz-styled');
            if (font !== 'system') root.classList.add(`alphainz-font-${font}`);
            root.style.setProperty('--alphainz-font-size', `${size}px`);
            root.style.setProperty('--alphainz-line-height', String(leading));
            /*
             * Which of a theme's two palettes to use — but only when the
             * choice is explicit.
             *
             * Following the system is the stylesheet's job, not this one's: it
             * is a media query, so Zotero's own light/dark switch reaches the
             * panes the instant it is thrown. Reading `matchMedia` here and
             * stamping the answer looked equivalent and was not — nothing was
             * listening for the system to change, so the panes stayed in the
             * old palette until some unrelated call happened to re-run this.
             *
             * So: no attribute means follow. The attribute exists only to
             * override, and the stylesheet gives it the specificity to win in
             * both directions.
             */
            if (scheme === 'light' || scheme === 'dark') {
                root.setAttribute('data-alphainz-dark', String(scheme === 'dark'));
            } else {
                root.removeAttribute('data-alphainz-dark');
            }
        }
    }
}

/**
 * Keep every pane in step with the preferences.
 *
 * The settings page calls `applyAppearance` itself, so this is not what makes
 * the controls work. It is what makes them work *everywhere*: a second window
 * has its own settings page, Zotero syncs preferences between machines, and
 * the test surface writes them over HTTP. All of those change the pref without
 * going through the control that was clicked.
 */
const APPEARANCE_PREFS = ['uiTheme', 'uiFont', 'uiFontSize', 'uiLineHeight', 'uiColorScheme'] as const;
let observerSymbols: any[] = [];

/**
 * Theme windows as they open.
 *
 * The settings window and the standalone chat window each hold a pane, and
 * both are created by `openDialog`, which returns before the window exists to
 * be found — so hooking them at their call sites themed nothing, silently:
 * the settings window came up in Zotero's colours while the sidebar behind it
 * was in the chosen theme. Watching for the window instead is one hook that
 * cannot be forgotten by whoever adds the next window, and `load` is late
 * enough that the pane — which is static markup, not React — already exists.
 */
const windowObserver = {
    observe(subject: any, topic: string) {
        if (topic !== 'domwindowopened') return;
        try {
            subject?.addEventListener?.('load', () => applyAppearance(), { once: true });
        } catch { /* not a DOM window */ }
    },
};
let windowObserverRegistered = false;

export function startAppearanceObserver(): void {
    if (!windowObserverRegistered) {
        try {
            (Services as any).ww.registerNotification(windowObserver);
            windowObserverRegistered = true;
        } catch (e) {
            Zotero.debug(`AlphainZ: could not watch for new windows: ${e}`);
        }
    }
    if (observerSymbols.length) return;
    for (const key of APPEARANCE_PREFS) {
        try {
            observerSymbols.push(
                Zotero.Prefs.registerObserver(
                    `${config.config.prefsPrefix}.${key}`,
                    () => applyAppearance(),
                    true, // global pref name
                ),
            );
        } catch (e) {
            Zotero.debug(`AlphainZ: could not observe ${key}: ${e}`);
        }
    }
}

export function stopAppearanceObserver(): void {
    if (windowObserverRegistered) {
        try { (Services as any).ww.unregisterNotification(windowObserver); } catch { /* already gone */ }
        windowObserverRegistered = false;
    }
    for (const sym of observerSymbols) {
        try { Zotero.Prefs.unregisterObserver(sym); } catch { /* already gone */ }
    }
    observerSymbols = [];
}
