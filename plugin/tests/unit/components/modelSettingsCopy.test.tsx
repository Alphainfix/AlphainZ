/**
 * Settings → Model says what a setting does, not how the code got here.
 *
 * Readers working in a second language need the outcome: which model a
 * highlight question uses, where keys are kept and who can read them — not
 * what an option "used to" do or which helper the code inherited.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
    (Zotero.Prefs.get as any).mockImplementation(() => undefined);
    vi.resetModules();
});

async function render(): Promise<string> {
    const { default: ModelSettingsSection } = await import('../../../react/components/preferences/ModelSettingsSection');
    return renderToStaticMarkup(React.createElement(ModelSettingsSection));
}

describe('the Model tab\'s copy', () => {
    it('says which model highlight questions use, without the history', async () => {
        const html = await render();
        expect(html).toContain('changing the model in the sidebar changes it for them too');
        expect(html).not.toContain('used to');
        expect(html).not.toContain('forked');
    });

    it('says where keys are kept and who can read them, in plain terms', async () => {
        const html = await render();
        expect(html).toContain('anyone who can read your Zotero profile folder can read them');
        expect(html).not.toContain('inherited');
        expect(html).not.toContain('obfuscation');
    });
});
