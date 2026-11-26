/**
 * The display name typed in a provider's catalogue is what the sidebar shows.
 *
 * The picker's rows and the composer button both name a model by its own
 * display name when the catalogue has one, else by its id; and a stored choice
 * that names a retired provider or model is written back as its successor, so
 * the settings page, the picker and the synced document all agree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { createStore } from 'jotai';
import { writeProviderOverrides } from '@beaver/agent-llm/providerOverrides';
import { writeCustomEndpoints } from '@beaver/agent-llm/customEndpoints';
import { localModelFromPrefs, localModelsFromPrefs, refreshLocalModelAtom, selectedModelAtom } from '../../../react/atoms/models';
import { displayNameFor, rowLabel } from '../../../react/components/ui/buttons/ModelSelectionButton';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('display names in the sidebar', () => {
    it('shows the catalogue\'s display name on the row and the button, and the id when there is none', () => {
        prefs.llmKeyDeepseek = 'k';
        writeProviderOverrides({ deepseek: { models: [{ id: 'deepseek-flash', label: 'V4.1 Flash' }, { id: 'deepseek-legacy' }] } });
        const rows = localModelsFromPrefs().filter((m) => String(m.provider) === 'deepseek');
        expect(rows[0].label).toBe('V4.1 Flash');
        expect(displayNameFor(rows[0])).toBe('V4.1 Flash');
        expect(rowLabel(rows[0])).toBe('V4.1 Flash · reads figures');
        expect(rows[1].label).toBeUndefined();
        expect(rowLabel(rows[1])).toBe('deepseek-legacy · reads figures');
    });

    it('carries the display name on the preferences-derived entry too', () => {
        prefs.llmKeyDeepseek = 'k';
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        writeProviderOverrides({ deepseek: { models: [{ id: 'deepseek-flash', label: 'V4.1 Flash' }] } });
        const chosen = localModelFromPrefs();
        expect(chosen?.label).toBe('V4.1 Flash');
        expect(chosen?.name).toBe('DeepSeek · V4.1 Flash');
        expect(displayNameFor(chosen!)).toBe('V4.1 Flash');
    });

    it('names a hand-added model by its display name as well', () => {
        writeCustomEndpoints([{ id: 'ep-1', name: 'My proxy', baseUrl: 'https://proxy.example.com/v1', apiKey: '', authStyle: 'bearer',
            models: [{ id: 'big-model', label: 'Big', supportsVision: false, reasoningEffort: false }] }]);
        prefs.llmProvider = 'custom:ep-1';
        prefs.llmModel = 'big-model';
        expect(localModelFromPrefs()?.label).toBe('Big');
        expect(rowLabel(localModelsFromPrefs().find((m) => m.snapshot === 'big-model')!)).toBe('Big');
    });
});

describe('a retired stored choice', () => {
    it('is written back as its successor when the list is validated, so every surface names the same model', () => {
        prefs.llmKeyDeepseek = 'k';
        prefs.llmProvider = 'deepseek-vision';
        prefs.llmModel = 'deepseek-v4-flash-vision-exp';
        const store = createStore();
        store.set(refreshLocalModelAtom);
        expect(prefs.llmProvider).toBe('deepseek');
        expect(prefs.llmModel).toBe('deepseek-flash');
        expect(store.get(selectedModelAtom)?.id).toBe('local-deepseek::deepseek-flash');
    });
});
