/**
 * The settings panel renders, and offers only models the stored keys unlock.
 *
 * A panel that throws during render would leave the preferences window blank
 * with the failure buried in Zotero's in-memory log, so the check that it
 * mounts at all is worth having. Rendered to static markup: the assertions are
 * about which controls exist and what they are filled with, which needs no DOM.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

beforeEach(() => {
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => {
        prefs[key] = value;
    });
    vi.resetModules();
});

const setPrefs = (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
        prefs[`${PREFIX}.${key}`] = value;
    }
};

/** Import fresh so module-scope preference reads see `prefs`. */
async function render(): Promise<string> {
    const { default: ModelSettingsSection } = await import(
        '../../../react/components/preferences/ModelSettingsSection'
    );
    return renderToStaticMarkup(React.createElement(ModelSettingsSection));
}

describe('ModelSettingsSection', () => {
    it('lists only the providers that have a key, and offers to add the rest', async () => {
        setPrefs({ llmKeyDeepseek: 'k' });
        const html = await render();
        expect(html).toContain('data-provider="deepseek"');
        expect(html).not.toContain('data-provider="openrouter"');
        expect(html).toContain('aria-label="Add provider"');
        expect(html).toContain('aria-label="Add custom provider"');
    });

    it('shows one card per vendor, not per preset', async () => {
        // DeepSeek's text and vision presets share a key and a card.
        setPrefs({ llmKeyDeepseek: 'k' });
        const html = await render();
        expect(html.split('data-provider="deepseek"').length - 1).toBe(1);
        expect(html).not.toContain('data-provider="deepseek-vision"');
    });

    it('never prints a stored key', async () => {
        setPrefs({ llmKeyDeepseek: 'sk-very-secret' });
        const html = await render();
        expect(html).not.toContain('sk-very-secret');
    });

    it('says there is nothing to add until a provider is configured', async () => {
        const html = await render();
        expect(html).toContain('No providers yet');
        expect(html).toContain('No models are listed because no provider is configured yet');
    });

    it('lists a configured provider\'s catalogue as choices for the model in use', async () => {
        setPrefs({ llmKeyDeepseek: 'k' });
        const html = await render();
        expect(html).toContain('value="deepseek::deepseek-flash"');
        expect(html).not.toContain('deepseek-v4');
        expect(html).not.toContain('value="openrouter::');
    });

    it('lists an edited catalogue instead of the preset\'s', async () => {
        setPrefs({
            llmKeyDeepseek: 'k',
            providerOverrides: JSON.stringify({ deepseek: { models: [{ id: 'deepseek-v4.1-flash', label: 'V4.1 Flash' }] } }),
        });
        const html = await render();
        expect(html).toContain('value="deepseek::deepseek-v4.1-flash"');
        expect(html).toContain('DeepSeek · V4.1 Flash');
        expect(html).not.toContain('value="deepseek::deepseek-flash"');
    });

    it('lists a hand-added provider as its own card and its models as choices', async () => {
        setPrefs({
            customEndpoints: JSON.stringify([{
                id: 'ep-1', name: 'My proxy', baseUrl: 'https://proxy.example.com/v1', apiKey: 'secret', authStyle: 'x-api-key',
                models: [{ id: 'big-model', label: 'Big', supportsVision: true, reasoningEffort: true }],
            }]),
        });
        const html = await render();
        expect(html).toContain('data-provider="custom:ep-1"');
        expect(html).toContain('My proxy');
        expect(html).toContain('value="custom:ep-1::big-model"');
        // Collapsed, the card shows no key and no form.
        expect(html).not.toContain('secret');
        expect(html).not.toContain('aria-label="Provider API key"');
    });

    it('keeps offering a stored model that is no longer listed', async () => {
        setPrefs({ llmKeyDeepseek: 'k', llmProvider: 'deepseek', llmModel: 'deepseek-v9-future' });
        const html = await render();
        expect(html).toContain('deepseek · deepseek-v9-future (stored)');
    });

    it('offers no separate model for highlight questions', async () => {
        const html = await render();
        expect(html).not.toContain('alphain-selection-model');
        expect(html).toContain('use the model the sidebar is');
    });

    it('defaults topic search to off, and says what that costs', async () => {
        const html = await render();
        expect(html).toContain('Off — keyword search only');
        expect(html).toContain('instead of reading an empty result as proof');
    });
});

describe('with an embedding provider configured', () => {
    // The configuration the user actually runs. The full-text block only exists
    // in this branch, so nothing above this reaches it.
    const configured = () =>
        setPrefs({
            llmKeyOpenai: 'k',
            llmProvider: 'openai',
            llmModel: 'gpt-6-luna',
            embeddingProvider: 'openai',
        });

    it('renders the full-text section without throwing', async () => {
        configured();
        const html = await render();
        expect(html).toContain('Full text of your PDFs');
    });

    it('says nothing misleading before the count is known', async () => {
        // Coverage is counted in an effect, which has not run at this point.
        // "0 of 0 indexed" would be a claim; the empty-library sentence is not.
        configured();
        const html = await render();
        expect(html).not.toContain('0 of 0');
    });

    it('leaves the switch for changes to the library to the Permissions tab', async () => {
        // One switch, where the rules it governs are: two would disagree.
        configured();
        const html = await render();
        expect(html).not.toContain('Writing to your library');
        expect(html).not.toContain('destroys content');
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL('../../../react/components/preferences/ModelSettingsSection.tsx', import.meta.url), 'utf8');
        expect(source).not.toContain("setPref('allowAgentWrites'");
    });
});

describe('figures that could not be rendered', () => {
    // Google embeds pictures, so the figures block shows its counts and buttons.
    async function renderFigures(state: Record<string, unknown>): Promise<string> {
        setPrefs({ embeddingProvider: 'google', llmKeyGoogle: 'k' });
        const { getDefaultStore } = await import('jotai');
        const { pageImageIndexStateAtom } = await import('../../../react/atoms/pageImageIndex');
        getDefaultStore().set(pageImageIndexStateAtom, (prev: any) => ({ ...prev, counted: true, ...state }));
        const html = await render();
        // The block on its own, without the text index's buttons above it.
        return html.slice(html.indexOf('data-testid="page-image-index"'));
    }

    const missing = 'The PDF file is not on this computer, and Zotero never uploaded it, so it cannot be downloaded either.';

    it('says why, names the papers, and offers a retry instead of an Index that would fail again', async () => {
        const html = await renderFigures({
            indexed: 212,
            library: 223,
            skipped: 11,
            failures: Array.from({ length: 11 }, (_, i) => ({ title: `Paper ${i + 1}`, message: missing })),
        });
        expect(html).toContain('212 of 223 PDFs indexed as pictures');
        expect(html).toContain(`11 could not be rendered on this computer — ${missing}`);
        expect(html).toContain('Which 11 PDFs');
        expect(html).toContain('Paper 11');
        expect(html).toContain('Retry the 11 that could not be rendered');
        expect(html).not.toMatch(/Index \d+ PDF/);
        expect(html).not.toContain('Every PDF is indexed');
    });

    it('offers Index for the PDFs still to come, and lists each reason with its count', async () => {
        const html = await renderFigures({
            indexed: 200,
            library: 214,
            skipped: 3,
            failures: [
                { title: 'A', message: missing },
                { title: 'B', message: missing },
                { title: 'C', message: 'the PDF has no pages to index' },
            ],
        });
        expect(html).toContain('Index 11 PDFs');
        expect(html).toContain('Retry the 3 that could not be rendered');
        expect(html).toContain('3 could not be rendered on this computer:');
        expect(html).toContain(`2 — ${missing}`);
        expect(html).toContain('1 — The PDF has no pages to index.');
    });

    it('says nothing about failures when there are none', async () => {
        const html = await renderFigures({ indexed: 5, library: 5, skipped: 0, failures: [] });
        expect(html).toContain('Every PDF is indexed');
        expect(html).not.toContain('could not be rendered');
    });
});
