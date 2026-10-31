// @vitest-environment jsdom
 
/**
 * Settings → Permissions: the switch for changes to the library comes first,
 * and every row says what its setting really covers.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => (key in prefs.values ? prefs.values[key] : (key === 'deferredToolPreferences' ? '' : true))),
    setPref: vi.fn((key: string, value: unknown) => { prefs.values[key] = value; }),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { setPref } from '../../../src/utils/prefs';
import PermissionsSection from '../../../react/components/preferences/PermissionsSection';
import { LIBRARY_WRITES_SETTING } from '../../../src/services/llm/systemPrompt';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(PermissionsSection));
    });
    return container;
}

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs.values = { allowAgentWrites: false };
    vi.mocked(setPref).mockClear();
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('the switch for changes to the library', () => {
    it('opens the Permissions tab, under the section the model points to', async () => {
        const el = await mount();
        const headings = Array.from(el.querySelectorAll('[role="heading"]')).map((heading) => heading.textContent);
        const section = LIBRARY_WRITES_SETTING.split(' → ')[2];
        expect(headings[0]).toBe(section);
        expect(LIBRARY_WRITES_SETTING).toBe(`Settings → Permissions → ${section}`);
    });

    it('lists what can really change, rewriting and deleting included', async () => {
        const text = (await mount()).textContent ?? '';
        for (const phrase of [
            'highlights and sticky notes',
            'including rewriting one whole',
            "correct a paper's title",
            'and delete them',
            'add papers',
            'collections',
        ]) {
            expect(text).toContain(phrase);
        }
    });

    it('greys the per-kind rules and says writing is off while it is off', async () => {
        const el = await mount();
        expect(el.textContent).toContain('Writing to your library is off');
        expect(el.querySelector('[data-writes-off="true"]')).not.toBeNull();
    });

    it('turns writing on from its checkbox', async () => {
        const el = await mount();
        const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        await act(async () => { checkbox.click(); });
        expect(setPref).toHaveBeenCalledWith('allowAgentWrites', true);
        expect(el.textContent).not.toContain('Writing to your library is off');
        expect(el.querySelector('[data-writes-off="true"]')).toBeNull();
    });
});

describe('the per-kind rows', () => {
    it('say what Always apply still asks about, and what review later does', async () => {
        const text = (await mount()).textContent ?? '';
        // Note Edits: a destructive rewrite asks even under Always apply.
        expect(text).toContain('a rewrite that would drop or replace much of a longer note still asks');
        // PDF Annotations: covers edits to existing annotations, with the exceptions.
        expect(text).toContain('edits to annotations already there');
        expect(text).toContain('replacing a comment an annotation already has, or removing all of its tags, still asks');
        // Always review later queues instead of rejecting.
        expect(text).toContain('each with its own Apply and Reject');
    });
});
