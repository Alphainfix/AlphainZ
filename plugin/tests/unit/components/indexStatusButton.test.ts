/**
 * The toolbar's index status: what it says, and when it says nothing.
 *
 * These decisions used to live in two components that disagreed — a spinner in
 * the header that only knew about the embedding pass, and a bar under the
 * composer that knew about both. They are one function now, so the cases that
 * matter can be pinned here rather than discovered while a library indexes.
 */
import { describe, expect, it } from 'vitest';

import {
    describeIndexStatus,
    type IndexStatusInput,
} from '../../../react/components/ui/buttons/EmbeddingIndexStatusButton';

const idle = (over: Partial<IndexStatusInput> = {}): IndexStatusInput => ({
    embedding: {
        phase: 'incremental', progress: 0, totalItems: 0,
        indexedItems: 0, failedItems: 0, error: null,
    },
    isEmbeddingIndexing: false,
    hasError: false,
    hasFailedItems: false,
    fulltext: { status: 'idle', done: 0, total: 0 },
    ...over,
});

describe('describeIndexStatus', () => {
    it('reports full-text coverage of the library, not progress of the pass', () => {
        // 207 PDFs in the library, 28 indexed before this pass; the pass has 179
        // to do and has finished 36 → 64 indexed. Shown as "36/179 · 20%" this
        // disagreed with the settings' "64 of 207".
        const s = describeIndexStatus(idle({
            fulltext: { status: 'indexing', done: 36, total: 179, indexed: 28, library: 207 },
        }));
        expect(s.pass).toBe('fulltext');
        expect(s.percent).toBe(31);
        expect(s.detail).toContain('64/207 papers');
    });

    it('falls back to pass progress when the library size is unknown', () => {
        const s = describeIndexStatus(idle({ fulltext: { status: 'indexing', done: 36, total: 179 } }));
        expect(s.percent).toBe(20);
    });

    it('shows nothing at rest', () => {
        expect(describeIndexStatus(idle()).visible).toBe(false);
    });

    it('reports the metadata pass by name', () => {
        const s = describeIndexStatus(idle({
            isEmbeddingIndexing: true,
            embedding: { phase: 'initial', progress: 40, totalItems: 250,
                         indexedItems: 100, failedItems: 0, error: null },
        }));
        expect(s.visible).toBe(true);
        expect(s.pass).toBe('metadata');
        expect(s.percent).toBe(40);
        expect(s.title).toBe('Indexing titles and abstracts');
        expect(s.detail).toBe('40% · 100/250 items');
        expect(s.preferencesTab).toBe('sync');
    });

    it('reports the full-text pass by name, and counts papers', () => {
        const s = describeIndexStatus(idle({
            fulltext: { status: 'indexing', done: 12, total: 48 },
        }));
        expect(s.pass).toBe('fulltext');
        expect(s.percent).toBe(25);
        expect(s.title).toBe('Reading your PDFs');
        expect(s.detail).toBe('25% · 12/48 papers');
        expect(s.preferencesTab).toBe('models');
    });

    it('gives the metadata pass the control when both are running', () => {
        const s = describeIndexStatus(idle({
            isEmbeddingIndexing: true,
            embedding: { phase: 'initial', progress: 10, totalItems: 250,
                         indexedItems: 25, failedItems: 0, error: null },
            fulltext: { status: 'indexing', done: 12, total: 48 },
        }));
        // It is the pass that makes the library searchable at all, and it
        // finishes far sooner.
        expect(s.pass).toBe('metadata');
        expect(s.percent).toBe(10);
    });

    it('shows no percentage against a total of zero', () => {
        // How a pass that has just finished briefly reports itself; dividing
        // by it is how `NaN%` reaches the toolbar.
        const s = describeIndexStatus(idle({
            isEmbeddingIndexing: true,
            embedding: { phase: 'initial', progress: 0, totalItems: 0,
                         indexedItems: 0, failedItems: 0, error: null },
        }));
        expect(s.visible).toBe(true);
        expect(s.percent).toBeNull();
        expect(s.detail).toBeUndefined();
        expect(s.title).toBe('Indexing');
    });

    it('stays visible for an error once indexing has stopped, and offers a retry', () => {
        const s = describeIndexStatus(idle({
            hasError: true,
            embedding: { phase: 'incremental', progress: 0, totalItems: 0,
                         indexedItems: 0, failedItems: 0, error: 'no API key' },
        }));
        expect(s.visible).toBe(true);
        expect(s.isIndexing).toBe(false);
        expect(s.title).toBe('Indexing Error');
        expect(s.detail).toBe('no API key');
        // Null means the click retries rather than opening preferences.
        expect(s.preferencesTab).toBeNull();
    });

    it('counts items left behind by a finished pass', () => {
        const s = describeIndexStatus(idle({
            hasFailedItems: true,
            embedding: { phase: 'incremental', progress: 100, totalItems: 250,
                         indexedItems: 247, failedItems: 3, error: null },
        }));
        expect(s.title).toBe('3 items failed to index');
        expect(s.preferencesTab).toBeNull();
    });

    it('is not fooled by an embedding pass that reports indexing with nothing to do', () => {
        // `phase: 'incremental'` with no items is the steady state after a
        // library is fully indexed; it must not put a spinner in the toolbar
        // with a meaningless number beside it.
        const s = describeIndexStatus(idle({
            isEmbeddingIndexing: true,
            embedding: { phase: 'incremental', progress: 0, totalItems: 0,
                         indexedItems: 0, failedItems: 0, error: null },
        }));
        // Neither pass has a countable total, so it must not claim to be
        // reading PDFs — that was the old wording, and it was a guess.
        expect(s.pass).toBeNull();
        expect(s.title).toBe('Indexing');
        expect(s.percent).toBeNull();
    });
});
