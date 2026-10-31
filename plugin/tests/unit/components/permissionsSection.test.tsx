// @vitest-environment jsdom
 

/**
 * Settings → Permissions: adding papers is not a choice, and the two switches
 * that controlled nothing are gone.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => (key === 'deferredToolPreferences' ? '' : true)),
    setPref: vi.fn(),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import PermissionsSection from '../../../react/components/preferences/PermissionsSection';

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
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('PermissionsSection', () => {
    it('shows item imports as always asking, with nothing to change', async () => {
        const el = await mount();
        const text = el.textContent ?? '';
        expect(text).toContain('Item Imports');
        expect(text).toContain('Always asks');
        expect(el.querySelector('[aria-label="Select preference for Item Imports"]')).toBeNull();
        // The editable rows are still editable.
        expect(el.querySelector('[aria-label="Select preference for PDF Annotations"]')).not.toBeNull();
        expect(el.querySelector('[aria-label="Select preference for Note Creation"]')).not.toBeNull();
    });

    it('no longer offers the auto-apply switches that controlled nothing', async () => {
        const el = await mount();
        const text = el.textContent ?? '';
        expect(text).not.toContain('Auto-Apply Annotations');
        expect(text).not.toContain('Auto-Create Zotero Notes');
        // The notification and file-access switches stay.
        expect(text).toContain('Approval Notifications');
        expect(text).toContain('Access Remote Files');
    });

    it('does not claim that notes apply on their own', async () => {
        const el = await mount();
        expect(el.textContent ?? '').not.toContain('the one exception is a new note');
    });
});
