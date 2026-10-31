import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');
import { uiManager } from '../../../react/ui/UIManager';

/**
 * Zotero switches to its stacked layout on its own when the window gets too
 * narrow (a half-screen window, or any window at a high zoom) and back when it
 * widens. Stacked, the reader's context pane is a fixed layer over the whole
 * window and only its inner strip shows; an AlphainZ pane left at the context
 * pane's top level then covers all of Zotero.
 */

let layout = 'standard';
let observer: (() => void) | null = null;

function buildWindow() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="zotero-item-pane"><div id="item-details"></div><div id="alphainz-pane-library" style="display: none"></div></div>
        <div id="zotero-context-pane">
            <div id="zotero-context-pane-inner"><div id="ctx-deck"></div><div id="ctx-sidenav"></div></div>
            <div id="alphainz-pane-reader" style="display: none"></div>
        </div>
    </body></html>`);
    const win = dom.window as any;
    win.ZoteroPane = { itemPane: { collapsed: false } };
    win.ZoteroContextPane = { collapsed: false, togglePane: vi.fn() };
    return win;
}

const byId = (win: any, id: string) => win.document.getElementById(id) as HTMLElement;

/** Zotero changes `extensions.zotero.layout`; its own observers run first, ours after a tick. */
function zoteroSwitchesLayout(next: string) {
    layout = next;
    observer?.();
    vi.runAllTimers();
}

describe('the AlphainZ pane follows Zotero when it switches layout', () => {
    let win: any;

    beforeEach(() => {
        vi.useFakeTimers();
        layout = 'standard';
        observer = null;
        win = buildWindow();
        (globalThis as any).Zotero.getMainWindow = vi.fn(() => win);
        (globalThis as any).Zotero.Prefs.get = vi.fn((pref: string) => (pref === 'layout' ? layout : undefined));
        (globalThis as any).Zotero.Prefs.registerObserver = vi.fn((_pref: string, handler: () => void) => {
            observer = handler;
            return Symbol('layout-observer');
        });
        (globalThis as any).Zotero.Prefs.unregisterObserver = vi.fn();
        (globalThis as any).Zotero.Reader = { getSidebarWidth: vi.fn(() => 300), onChangeSidebarWidth: null };
    });

    afterEach(() => {
        uiManager.cleanup();
        vi.useRealTimers();
        delete (globalThis as any).Zotero.Reader;
    });

    it('watches the layout preference once the panes are first placed', () => {
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect((globalThis as any).Zotero.Prefs.registerObserver).toHaveBeenCalledWith('extensions.zotero.layout', expect.any(Function), true);
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect((globalThis as any).Zotero.Prefs.registerObserver).toHaveBeenCalledTimes(1);
    });

    it('moves an open reader pane into the stacked strip instead of covering the window', () => {
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        vi.runAllTimers();
        const pane = byId(win, 'alphainz-pane-reader');
        expect(pane.parentElement?.id).toBe('zotero-context-pane');

        zoteroSwitchesLayout('stacked');

        expect(pane.parentElement?.id).toBe('zotero-context-pane-inner');
        expect(pane.style.display).toBe('');
        expect(byId(win, 'ctx-deck').style.display).toBe('none');
        expect(byId(win, 'ctx-sidenav').style.display).toBe('none');
        // A pixel width would clamp the strip's cross axis.
        expect(pane.style.width).toBe('');
    });

    it('puts the reader pane back beside the paper when the window widens again', () => {
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        zoteroSwitchesLayout('stacked');
        zoteroSwitchesLayout('standard');

        const pane = byId(win, 'alphainz-pane-reader');
        expect(pane.parentElement?.id).toBe('zotero-context-pane');
        expect(pane.style.width).toBe('300px');
        // The strip's own content is visible again under Zotero's control.
        expect(byId(win, 'ctx-deck').style.display).toBe('');
        expect(byId(win, 'zotero-context-pane-inner').style.display).toBe('none');
    });

    it('keeps the library pane at full width in the stacked item pane and restores its width after', () => {
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        vi.runAllTimers();
        const pane = byId(win, 'alphainz-pane-library');
        expect(pane.style.width).toBe('300px');

        zoteroSwitchesLayout('stacked');
        expect(pane.style.width).toBe('');

        zoteroSwitchesLayout('standard');
        expect(pane.style.width).toBe('300px');
    });

    it('leaves the collapse state it remembered when the pane was opened alone', () => {
        win.ZoteroContextPane.collapsed = true;
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(win.ZoteroContextPane.togglePane).toHaveBeenCalledTimes(1);
        win.ZoteroContextPane.collapsed = false;

        zoteroSwitchesLayout('stacked');
        zoteroSwitchesLayout('standard');

        expect(win.ZoteroContextPane.togglePane).toHaveBeenCalledTimes(1);
    });

    it('does nothing while the AlphainZ pane is closed', () => {
        uiManager.updateUI({ isVisible: false, isLibraryTab: false });
        zoteroSwitchesLayout('stacked');

        const pane = byId(win, 'alphainz-pane-reader');
        expect(pane.parentElement?.id).toBe('zotero-context-pane');
        expect(byId(win, 'ctx-deck').style.display).toBe('');
    });

    it('stops watching on cleanup', () => {
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        uiManager.cleanup();
        expect((globalThis as any).Zotero.Prefs.unregisterObserver).toHaveBeenCalledTimes(1);
    });
});
