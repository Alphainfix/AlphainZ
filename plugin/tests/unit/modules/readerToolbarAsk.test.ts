/**
 * "Ask AlphainZ" in the reader toolbar brings the conversation up where the
 * user works: the separate AlphainZ window when one is open, otherwise the
 * main window's pane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findBeaverWindow = vi.hoisted(() => vi.fn());
vi.mock('../../../src/ui/ui', () => ({ BeaverUIFactory: { findBeaverWindow } }));
vi.mock('../../../src/modules/zoteroContextMenu', () => ({ getMergedActions: vi.fn(() => []) }));
vi.mock('../../../src/ui/openPreferencesWindow', () => ({ openPreferencesWindow: vi.fn() }));

import { askFromReaderToolbar } from '../../../src/modules/readerToolbarMenu';

class FakeEvent {
    constructor(public type: string, public init?: { detail?: unknown }) {}
}

let dispatched: FakeEvent[];
let paneOpen: boolean;

beforeEach(() => {
    vi.useFakeTimers();
    dispatched = [];
    paneOpen = false;
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        getMainWindow: () => ({
            __alphainzEventBus: { dispatchEvent: (event: FakeEvent) => dispatched.push(event) },
            CustomEvent: FakeEvent,
            document: {
                querySelector: (selector: string) => selector === '#zotero-alphainz-tb-chat-toggle'
                    ? { getAttribute: (name: string) => (name === 'aria-pressed' ? String(paneOpen) : null) }
                    : null,
            },
        }),
    };
});

afterEach(() => {
    vi.useRealTimers();
    findBeaverWindow.mockReset();
});

describe('Ask AlphainZ from the reader toolbar', () => {
    it('opens the pane in the main window when there is no separate window', () => {
        findBeaverWindow.mockReturnValue(undefined);
        askFromReaderToolbar();
        vi.advanceTimersByTime(150);
        expect(dispatched.map((event) => event.type)).toEqual(['toggleChat', 'focusInput']);
        expect(dispatched[0].init?.detail).toEqual({ forceOpen: true });
    });

    it('brings up the separate window instead of opening the pane as well', () => {
        const separate = { focus: vi.fn() };
        findBeaverWindow.mockReturnValue(separate);
        askFromReaderToolbar();
        vi.advanceTimersByTime(150);
        expect(separate.focus).toHaveBeenCalled();
        expect(dispatched.map((event) => event.type)).toEqual(['focusInput']);
    });

    it('stays in the pane when the pane is already open, even with a separate window', () => {
        const separate = { focus: vi.fn() };
        findBeaverWindow.mockReturnValue(separate);
        paneOpen = true;
        askFromReaderToolbar();
        vi.advanceTimersByTime(150);
        expect(separate.focus).not.toHaveBeenCalled();
        expect(dispatched.map((event) => event.type)).toEqual(['toggleChat', 'focusInput']);
    });
});
