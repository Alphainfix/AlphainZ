// @vitest-environment jsdom
 

/**
 * Settings → Advanced → Conversation View: the question rail's switch.
 *
 * On by default. Turning it off takes the ticks away and brings the thread
 * view's scroll bar back, at once, in a pane that is already open — whether
 * the switch was flipped in Settings or the preference arrived from settings
 * sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import pkg from '../../../package.json';

const RAIL_PREF = `${pkg.config.prefsPrefix}.conversationRail`;

let prefs: Record<string, unknown>;
let observers: Map<symbol, { name: string; handler: () => void }>;
let roots: Root[] = [];

beforeEach(() => {
    prefs = {};
    observers = new Map();
    (Zotero.Prefs.get as any).mockImplementation((name: string) => prefs[name]);
    // Like Zotero: a write reaches every observer of that preference.
    (Zotero.Prefs.set as any).mockImplementation((name: string, value: unknown) => {
        prefs[name] = value;
        for (const observer of [...observers.values()]) if (observer.name === name) observer.handler();
    });
    (Zotero.Prefs.registerObserver as any).mockImplementation((name: string, handler: () => void) => {
        const symbol = Symbol(name);
        observers.set(symbol, { name, handler });
        return symbol;
    });
    (Zotero.Prefs.unregisterObserver as any).mockImplementation((symbol: symbol) => { observers.delete(symbol); });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).__alphainzJotaiStore = undefined;
    document.body.innerHTML = '';
    vi.resetModules();
});

afterEach(() => {
    act(() => roots.forEach((root) => root.unmount()));
    roots = [];
});

const RUN = {
    id: 'q1',
    user_id: 'user-1',
    thread_id: 'thread-1',
    agent_name: 'beaver',
    user_prompt: { content: 'What is the core finding?' },
    status: 'completed',
    model_messages: [],
    created_at: '2026-10-09T14:32:00',
    consent_to_share: false,
    model_name: 'test-model',
} as AgentRun;

async function render(element: React.ReactElement) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(<Provider store={store}>{element}</Provider>); });
    return host;
}

/** An open conversation: the thread view, and the rail beside it while the setting is on. */
async function openConversation() {
    const { store } = await import('../../../react/store');
    const { threadRunsAtom } = await import('@beaver/agent-core/run-state/atoms');
    store.set(threadRunsAtom, [RUN]);
    const { default: ConversationView } = await import('../../../react/components/agentRuns/ConversationView');
    function Pane() {
        const viewRef = useRef<HTMLDivElement>(null);
        return (
            <ConversationView containerRef={viewRef} isWindow={false}>
                <div id="alphainz-thread-view" ref={viewRef}>
                    <div id="run-q1"><div id="user-request-q1">What is the core finding?</div></div>
                </div>
            </ConversationView>
        );
    }
    return render(<Pane />);
}

async function openSettings() {
    const { default: ConversationViewSection } = await import('../../../react/components/preferences/ConversationViewSection');
    return render(<ConversationViewSection />);
}

const checkbox = (host: HTMLElement) =>
    host.querySelector<HTMLInputElement>('input[aria-label="Question ticks instead of a scroll bar"]')!;
const railShown = (pane: HTMLElement) => ({
    ticks: pane.querySelectorAll('.conversation-rail-mark').length,
    scrollBarHidden: pane.querySelector('.conversation-view')!.classList.contains('has-rail'),
});

describe('the setting', () => {
    it('sits under Conversation View, on by default', async () => {
        const settings = await openSettings();
        expect(settings.querySelector('[role="heading"]')?.textContent).toBe('Conversation View');
        expect(checkbox(settings).checked).toBe(true);
        expect(settings.textContent).toContain('Off brings the scroll bar back');
    });

    it('turned off, writes the preference and takes the ticks away in the open pane, scroll bar back', async () => {
        const pane = await openConversation();
        const settings = await openSettings();
        expect(railShown(pane)).toEqual({ ticks: 1, scrollBarHidden: true });

        await act(async () => { checkbox(settings).click(); });
        expect(prefs[RAIL_PREF]).toBe(false);
        expect(checkbox(settings).checked).toBe(false);
        expect(railShown(pane)).toEqual({ ticks: 0, scrollBarHidden: false });

        await act(async () => { checkbox(settings).click(); });
        expect(prefs[RAIL_PREF]).toBe(true);
        expect(railShown(pane)).toEqual({ ticks: 1, scrollBarHidden: true });
    });

    it('starts off when the preference is off', async () => {
        prefs[RAIL_PREF] = false;
        const pane = await openConversation();
        const settings = await openSettings();
        expect(checkbox(settings).checked).toBe(false);
        expect(railShown(pane)).toEqual({ ticks: 0, scrollBarHidden: false });
    });
});

describe('the open pane', () => {
    it('follows the preference when it changes from elsewhere, such as settings sync', async () => {
        const pane = await openConversation();
        expect(Zotero.Prefs.registerObserver).toHaveBeenCalledWith(RAIL_PREF, expect.any(Function), true);

        await act(async () => { Zotero.Prefs.set(RAIL_PREF, false, true); });
        expect(railShown(pane)).toEqual({ ticks: 0, scrollBarHidden: false });

        await act(async () => { Zotero.Prefs.set(RAIL_PREF, true, true); });
        expect(railShown(pane)).toEqual({ ticks: 1, scrollBarHidden: true });
    });

    it('stops observing the preference once nothing shows the rail', async () => {
        await openConversation();
        expect([...observers.values()].filter((observer) => observer.name === RAIL_PREF)).toHaveLength(1);
        act(() => roots.forEach((root) => root.unmount()));
        roots = [];
        expect([...observers.values()].filter((observer) => observer.name === RAIL_PREF)).toHaveLength(0);
    });

    it('reads a change made while it was closed when it opens again', async () => {
        await openConversation();
        act(() => roots.forEach((root) => root.unmount()));
        roots = [];
        prefs[RAIL_PREF] = false;
        const pane = await openConversation();
        expect(railShown(pane)).toEqual({ ticks: 0, scrollBarHidden: false });
    });
});

describe('the stylesheet', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../../addon/content/styles/beaver.css'), 'utf8');
    /** The declarations of the first rule whose selector is exactly `selector`. */
    const rule = (selector: string) => {
        const at = css.indexOf(`${selector} {`);
        expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
        return css.slice(at, css.indexOf('}', at));
    };

    it('hides the scroll bar of the thread view alone, and only while the rail is on', () => {
        const declarations = rule('.alphainz-root .conversation-view.has-rail > #alphainz-thread-view');
        expect(declarations).toContain('scrollbar-width: none;');
        expect(css.match(/scrollbar-width:\s*none/g)).toHaveLength(1);
    });

    it('keeps the text clear of the rail with 12–14px more padding', () => {
        const padding = Number(rule('.alphainz-root .conversation-view.has-rail > #alphainz-thread-view')
            .match(/padding-right:\s*(\d+)px/)?.[1]);
        expect(padding).toBeGreaterThanOrEqual(12);
        expect(padding).toBeLessThanOrEqual(14);
    });

    it('takes the pointer in a strip a little wider than the longest tick, without pushing the text over', () => {
        const px = (declarations: string, property: string) =>
            Number(declarations.match(new RegExp(`(?:^|[\\s;{])${property}:\\s*(\\d+)px`))?.[1]);
        const strip = rule('.alphainz-root .conversation-rail');
        const tick = rule('.alphainz-root .conversation-rail-mark::after');
        const longestTick = px(tick, 'right') + px(tick, 'width');
        expect(px(strip, 'width')).toBeGreaterThanOrEqual(longestTick);
        expect(px(strip, 'width')).toBeLessThanOrEqual(longestTick + 6);
        expect(px(rule('.alphainz-root .conversation-rail-marks'), 'width')).toBe(px(strip, 'width'));
        expect(px(rule('.alphainz-root .conversation-rail-mark'), 'width')).toBe(px(strip, 'width'));
        // The strip itself lets the pointer through; only the ticks' boxes take it.
        expect(strip).toContain('pointer-events: none;');
        expect(rule('.alphainz-root .conversation-rail-marks')).toContain('pointer-events: auto;');
        expect(tick).toContain('pointer-events: none;');
    });

    it('lengthens a tick by scaling it, so the compositor does it without a layout', () => {
        const tick = rule('.alphainz-root .conversation-rail-mark::after');
        expect(tick).toMatch(/transform-origin:\s*right center;/);
        expect(tick).toMatch(/transform: translateY\(-50%\) scale\(0\.5,/);
        expect(tick).toMatch(/transition: transform 0\.15s/);
        expect(tick).not.toMatch(/transition:[^;]*\bwidth\b/);
        expect(rule('.alphainz-root .conversation-rail-mark.is-active::after')).toMatch(/scale\(1,/);
        expect(rule('.alphainz-root .conversation-rail-mark.is-current::after')).toMatch(/transform: translateY\(-50%\);/);
    });

    it('lets the hit boxes touch, so the pointer is always over some question', () => {
        const marks = rule('.alphainz-root .conversation-rail-marks');
        expect(marks).not.toMatch(/\bgap:/);
        expect(rule('.alphainz-root .conversation-rail-mark')).toMatch(/margin:\s*0;/);
    });

    it('moves the card with a transform in about 120ms, and not at all with reduced motion', () => {
        const card = rule('.alphainz-root .conversation-peek');
        expect(card).toMatch(/transform 0\.12s/);
        expect(card).toMatch(/transform: translate\(6px, var\(--conversation-peek-y, 0px\)\);/);
        expect(card).not.toMatch(/transition:[^;]*\btop\b/);
        const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
        expect(reduced).toMatch(/\.conversation-peek,[\s\S]*?transition: none;/);
    });
});
