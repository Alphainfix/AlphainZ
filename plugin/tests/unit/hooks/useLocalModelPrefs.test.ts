// @vitest-environment jsdom

/**
 * The composer's model list follows the preferences it is built from.
 *
 * A fresh install has no key when the bundle loads, so the list computed then
 * is empty. The first key can arrive from the wizard, the settings window, or
 * settings sync; whichever wrote it, the list has to pick up the new provider
 * without a restart, and the choice has to reach the preferences the runner
 * reads — otherwise the first message has no model to run on.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

const PREFIX = pkg.config.prefsPrefix;

let prefs: Record<string, unknown> = {};
const observers = new Map<string, () => void>();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
    prefs = {};
    observers.clear();
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => {
        prefs[key] = value;
    });
    (Zotero.Prefs as any).registerObserver = vi.fn((name: string, callback: () => void, global?: boolean) => {
        // Zotero prefixes `extensions.zotero.` onto non-global names; a
        // registration for this plugin's preferences has to pass the full
        // name with `global` set, or it watches a name nothing writes.
        expect(global).toBe(true);
        expect(name.startsWith(`${PREFIX}.`)).toBe(true);
        observers.set(name, callback);
        return Symbol(name);
    });
    (Zotero.Prefs as any).unregisterObserver = vi.fn();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

/** Import fresh so module-scope preference reads see this test's `prefs`. */
async function load() {
    const hooks = await import('../../../react/hooks/useLocalModelPrefs');
    const models = await import('../../../react/atoms/models');
    return { ...hooks, ...models };
}

function mount(store: ReturnType<typeof createStore>, hook: () => void) {
    const Harness: React.FC = () => {
        hook();
        return null;
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(React.createElement(Provider, { store }, React.createElement(Harness)));
    });
}

/** Writes a preference the way the settings window does and notifies observers. */
async function write(key: string, value: unknown) {
    prefs[`${PREFIX}.${key}`] = value;
    await act(async () => {
        observers.get(`${PREFIX}.${key}`)?.();
        await Promise.resolve();
    });
}

describe('useLocalModelPrefs', () => {
    it('offers and persists a model as soon as the first key is written', async () => {
        const { useLocalModelPrefs, selectedModelAtom } = await load();
        const store = createStore();
        mount(store, useLocalModelPrefs);

        await write('llmKeyDeepseek', 'k');

        expect(store.get(selectedModelAtom)?.id.startsWith('local-deepseek')).toBe(true);
        // The runner reads these, not the atom.
        expect(prefs[`${PREFIX}.llmProvider`]).toBe('deepseek');
        expect(typeof prefs[`${PREFIX}.llmModel`]).toBe('string');
    });

    it('watches every key preference, not just the selected provider', async () => {
        const { useLocalModelPrefs } = await load();
        mount(createStore(), useLocalModelPrefs);

        const watched = [...observers.keys()];
        for (const key of ['llmProvider', 'llmModel', 'ollamaModels', 'llmKeyDeepseek', 'llmKeyOpenrouter', 'llmKeyZhipu', 'llmKeyOpenai', 'llmKeyGoogle']) {
            expect(watched).toContain(`${PREFIX}.${key}`);
        }
    });

    it('coalesces a burst of writes into one refresh and unregisters on unmount', async () => {
        const { useLocalModelPrefs } = await load();
        const store = createStore();
        mount(store, useLocalModelPrefs);
        const setCalls = () => (Zotero.Prefs.set as any).mock.calls.filter(([key]: [string]) => key.endsWith('.lastUsedModel')).length;

        prefs[`${PREFIX}.llmKeyOpenrouter`] = 'k';
        const before = setCalls();
        await act(async () => {
            // Provider and model land as two writes; both observers fire before the tick ends.
            prefs[`${PREFIX}.llmProvider`] = 'openrouter';
            observers.get(`${PREFIX}.llmProvider`)?.();
            prefs[`${PREFIX}.llmModel`] = 'gpt-5.6-luna';
            observers.get(`${PREFIX}.llmModel`)?.();
            await Promise.resolve();
        });
        expect(setCalls() - before).toBe(1);

        const registered = (Zotero.Prefs.registerObserver as any).mock.calls.length;
        act(() => root?.unmount());
        root = null;
        expect((Zotero.Prefs.unregisterObserver as any).mock.calls.length).toBe(registered);
    });
});
