/**
 * Settings → Search says what the titles-and-abstracts index is waiting for.
 *
 * "No embedding provider configured" beside a Model tab that shows OpenAI
 * selected sends the user looking for a choice they already made. The
 * tab now tells off from chosen-but-unusable, and says the index starts once
 * the problem is fixed.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

// Only the Search tab is rendered; the other tabs' sections stay out of the way.
vi.mock('../../../react/components/preferences/PermissionsSection', () => ({ default: () => null }));
vi.mock('../../../react/components/preferences/AdvancedSection', () => ({ default: () => null }));
vi.mock('../../../react/components/preferences/ExcludedLibrariesList', () => ({ default: () => null }));
vi.mock('../../../react/components/preferences/ModelSettingsSection', () => ({ default: () => null }));
vi.mock('../../../react/components/preferences/ActionsPreferenceSection', () => ({ default: () => null }));
vi.mock('../../../react/components/preferences/AppearanceSection', () => ({ default: () => null }));
vi.mock('../../../react/utils/noteEditorDiffPreview', () => ({ isDiffPreviewSupported: () => false }));

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

beforeEach(() => {
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => { prefs[key] = value; });
    vi.resetModules();
});

async function searchTab(values: Record<string, unknown>): Promise<string> {
    for (const [key, value] of Object.entries(values)) prefs[`${PREFIX}.${key}`] = value;
    const { default: PreferencePage } = await import('../../../react/components/preferences/PreferencePage');
    const { activePreferencePageTabAtom } = await import('../../../react/atoms/ui');
    const store = createStore();
    store.set(activePreferencePageTabAtom, 'sync');
    return renderToStaticMarkup(React.createElement(Provider, { store }, React.createElement(PreferencePage)));
}

describe('the Search tab', () => {
    it('says the provider chosen has no key on this computer, not that none is configured', async () => {
        const html = await searchTab({ embeddingProvider: 'openai' });
        expect(html).toContain('Embeddings are set to OpenAI, but this computer has no OpenAI API key.');
        expect(html).toContain('This index is built by itself once that is fixed');
        expect(html).toContain('Fix it under Model');
        expect(html).not.toContain('configured');
    });

    it('says it is off when no provider is chosen', async () => {
        const html = await searchTab({});
        expect(html).toContain('Off: no embedding provider is chosen');
        expect(html).toContain('Choose a provider');
    });

    it('claims the index keeps itself up to date only when it can', async () => {
        const html = await searchTab({ embeddingProvider: 'openai', llmKeyOpenai: 'k' });
        expect(html).toContain('It is built and kept');
        expect(html).not.toContain('data-testid="search-index-state"');
    });
});
