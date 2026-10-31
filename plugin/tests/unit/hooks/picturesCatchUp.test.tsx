// @vitest-environment jsdom
 

/**
 * A sweep that finds a picture run going asks again when it ends.
 *
 * - The sweep indexes passages, then pages. When pages are already being
 *   embedded, it cannot start another run; once that run has ended, the
 *   sweep runs again, so a PDF added in the meantime gets its pages without
 *   waiting for the next start of Zotero.
 * - With no picture run going, the sweep starts one at once, and nothing asks
 *   for another afterwards.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ store: null as any, passageRun: { stopped: false as boolean }, unrenderable: 0 }));
const calls = vi.hoisted(() => ({ passages: 0, pictures: 0, sweeps: 0, pictureOptions: [] as any[] }));
const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../src/utils/prefs', () => ({ getPref: (key: string) => prefs.get(key) }));

vi.mock('../../../react/store', () => ({ get store() { return state.store; } }));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom: makeAtom } = await import('jotai');
    return { searchableLibraryIdsAtom: makeAtom([1]) };
});
vi.mock('../../../react/atoms/fulltextIndex', async () => {
    const { atom: makeAtom } = await import('jotai');
    const fulltextIndexStateAtom = makeAtom<any>({ status: 'idle', indexed: 3, library: 3 });
    return {
        fulltextIndexStateAtom,
        refreshFulltextCoverageAtom: makeAtom(null, (_get: any, set: any) => {
            calls.sweeps += 1;
            // With `passageRun.stopped`, one PDF is left for a passage run that the user then stops.
            if (state.passageRun.stopped) set(fulltextIndexStateAtom, { status: 'idle', indexed: 2, library: 3 });
        }),
        startFulltextIndexAtom: makeAtom(null, (_get: any, set: any) => {
            calls.passages += 1;
            if (state.passageRun.stopped) set(fulltextIndexStateAtom, { status: 'idle', indexed: 2, library: 3, stopped: true });
        }),
    };
});
vi.mock('../../../react/atoms/pageImageIndex', async () => {
    const { atom: makeAtom } = await import('jotai');
    const pageImageIndexStateAtom = makeAtom({ status: 'idle', counted: false, indexed: 0, library: 0, skipped: 0 });
    return {
        pageImageIndexStateAtom,
        pageImageProvider: () => ({ embedsImages: true }),
        refreshPageImageCoverageAtom: makeAtom(null, (get: any, set: any) => {
            // With `unrenderable`, the PDF left is one that could not be rendered this session.
            set(pageImageIndexStateAtom, { ...get(pageImageIndexStateAtom), counted: true, indexed: 2, library: 3, skipped: state.unrenderable });
        }),
        startPageImageIndexAtom: makeAtom(null, (_get: any, _set: any, options: any) => {
            calls.pictures += 1;
            calls.pictureOptions.push(options);
        }),
    };
});
vi.mock('../../../src/services/llm/agentConfig', () => ({
    isSemanticSearchAvailable: () => true,
    refreshSemanticSearchAvailability: async () => true,
}));
vi.mock('../../../react/hooks/useEmbeddingIndex', () => ({
    noteSemanticSearchUnusable: () => undefined,
    subscribeSemanticSearchChanges: () => () => undefined,
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { useFulltextIndex } from '../../../react/hooks/useFulltextIndex';
import { pageImageIndexStateAtom } from '../../../react/atoms/pageImageIndex';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
    const Probe = () => { useFulltextIndex(); return null; };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(Provider, { store: state.store }, React.createElement(Probe)));
    });
}

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const pictureRun = (status: 'idle' | 'indexing') =>
    act(async () => { state.store.set(pageImageIndexStateAtom, (prev: any) => ({ ...prev, status })); });

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    state.store = createStore();
    calls.passages = 0;
    calls.pictures = 0;
    calls.sweeps = 0;
    calls.pictureOptions = [];
    prefs.clear();
    state.passageRun.stopped = false;
    state.unrenderable = 0;
    (Zotero as any).AlphainZ = { db: {} };
    (Zotero.Notifier as any).registerObserver = vi.fn(() => 'observer');
    (Zotero.Notifier as any).unregisterObserver = vi.fn();
});
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
    delete (Zotero as any).AlphainZ;
});

describe('pages for PDFs added during a picture run', () => {
    it('are picked up by a sweep run again once that run ends', async () => {
        await mount();
        await pictureRun('indexing');
        await wait(20_000);
        expect(calls.pictures).toBe(0);

        await pictureRun('idle');
        await wait(15_000);
        expect(calls.pictures).toBe(1);
    });

    it('are not started again on their own after the user stopped the run, nor swept for', async () => {
        await mount();
        await pictureRun('indexing');
        await wait(20_000);
        const sweepsBefore = calls.sweeps;
        await act(async () => {
            state.store.set(pageImageIndexStateAtom, (prev: any) => ({ ...prev, status: 'idle', stopped: true }));
        });
        await wait(30_000);
        expect(calls.pictures).toBe(0);
        expect(calls.sweeps).toBe(sweepsBefore);
    });

    it('start as an automatic run, which a Stop holds back', async () => {
        await mount();
        await wait(20_000);
        expect(calls.pictureOptions).toEqual([{ automatic: true }]);
    });

    it('are not started after passages the user stopped', async () => {
        state.passageRun.stopped = true;
        await mount();
        await wait(20_000);
        expect(calls.passages).toBe(1);
        expect(calls.pictures).toBe(0);
    });

    it('and passages stop being swept as soon as keeping them up to date is turned off', async () => {
        await mount();
        prefs.set('fulltextIndexAuto', false);
        await wait(20_000);
        expect(calls.passages).toBe(0);
        expect(calls.pictures).toBe(0);
    });

    it('are not started for PDFs that could not be rendered this session', async () => {
        state.unrenderable = 1;
        await mount();
        await wait(20_000);
        expect(calls.passages).toBe(0);
        expect(calls.sweeps).toBe(1);
        expect(calls.pictures).toBe(0);
    });

    it('start at once when no picture run is going, with nothing asked for afterwards', async () => {
        await mount();
        await wait(20_000);
        expect(calls.pictures).toBe(1);
        await pictureRun('indexing');
        await pictureRun('idle');
        await wait(15_000);
        expect(calls.pictures).toBe(1);
    });
});
