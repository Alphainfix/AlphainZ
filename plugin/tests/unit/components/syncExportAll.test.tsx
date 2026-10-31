// @vitest-environment jsdom
/**
 * Settings → Advanced → "Export all conversations now": a catch-up pass runs
 * before anything is written, so a chat archived on another computer since
 * the last pass is archived here first instead of being written back out as
 * active, and a newer copy from elsewhere is left alone.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

const order: string[] = [];
const syncConversationsNow = vi.fn(async () => { order.push('catch up'); });
const exportAllThreads = vi.fn(async (..._args: any[]) => {
    order.push('export');
    return { written: 3, failed: 0, skipped: 1 };
});
vi.mock('../../../react/atoms/loadLocalThreads', async (importOriginal) => {
    const real = await importOriginal<any>();
    return { ...real, syncConversationsNow: () => syncConversationsNow() };
});
vi.mock('../../../src/services/conversationSync/exportAll', () => ({
    exportAllThreads: (...args: any[]) => exportAllThreads(...args),
}));

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    (Zotero as any).AlphainZ = { data: { env: 'test' }, db: { name: 'db' } };
    order.length = 0;
    syncConversationsNow.mockClear();
    exportAllThreads.mockClear();
    vi.resetModules();
});

describe('"Export all conversations now"', () => {
    it('catches up with the sync location before writing, and leaves newer copies alone', async () => {
        prefs[`${PREFIX}.conversationSyncBackend`] = 'zotero';
        const { default: AdvancedSection } = await import('../../../react/components/preferences/AdvancedSection');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => { root.render(React.createElement(AdvancedSection)); });

        const exportButton = [...host.querySelectorAll('button')]
            .find((b) => b.textContent === 'Export') as HTMLButtonElement;
        expect(exportButton).toBeTruthy();
        await act(async () => {
            exportButton.click();
            await vi.waitFor(() => expect(exportAllThreads).toHaveBeenCalled(), { timeout: 5000 });
        });
        await act(async () => { await Promise.resolve(); });

        expect(order).toEqual(['catch up', 'export']);
        expect(exportAllThreads.mock.calls[0][3]).toEqual({ skipNewerRemote: true });
        expect(host.textContent).toContain('Exported 3 conversations; 1 left alone');
    });
});
