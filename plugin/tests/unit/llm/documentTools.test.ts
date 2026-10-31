/**
 * Shaping for the two document tools.
 *
 * Both raw payloads are the largest of any tool and mostly scaffolding — an
 * extracted document carries per-page geometry, a search hit carries a bounding
 * box, a role and a weight. What matters here is that the reduction keeps the
 * page numbers (the model cites them) and never hides that it dropped
 * something: a truncated read that looks complete produces a confident "the
 * paper does not discuss X".
 */
import { describe, expect, it } from 'vitest';

import {
    shapeDocumentResult,
    shapeDocumentSearchResult,
} from '../../../src/services/llm/zoteroToolDispatch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const page = (index: number, markdown: string, label?: string) => ({
    index,
    ...(label ? { label } : {}),
    width: 612,
    height: 792,
    viewBox: { l: 0, t: 0, r: 612, b: 792 },
    rotation: 0,
    markdown,
});

const document = (pages: any[], pageCount = pages.length) => ({
    type: 'zotero_document',
    request_id: 'read_document-1',
    result: { mode: 'markdown', document: { pageCount, pages } },
});

/** A page of roughly journal-article length. */
const bulk = (n: number) => 'x'.repeat(n);

// ---------------------------------------------------------------------------
// shapeDocumentResult
// ---------------------------------------------------------------------------

describe('shapeDocumentResult', () => {
    it('returns page text with 1-based page numbers', () => {
        // The wire is 0-based and the model cites pages; an off-by-one here
        // sends the user to the wrong page of their own paper.
        const shaped: any = shapeDocumentResult(
            document([page(0, 'Abstract...'), page(1, 'Introduction...')]),
        );
        expect(shaped.pages.map((p: any) => p.page)).toEqual([1, 2]);
        expect(shaped.pages[0].text).toBe('Abstract...');
        expect(shaped.total_pages).toBe(2);
        expect(shaped.pages_returned).toBe('1-2');
    });

    it('keeps a page label only when it differs from the page number', () => {
        // Front matter numbered "iv" is worth carrying; a label of "3" on page 3
        // is noise repeated on every page.
        const shaped: any = shapeDocumentResult(
            document([page(0, 'front', 'iv'), page(1, 'body', '2')]),
        );
        expect(shaped.pages[0].label).toBe('iv');
        expect(shaped.pages[1]).not.toHaveProperty('label');
    });

    it('stops at the character budget and says how much it left', () => {
        const pages = Array.from({ length: 20 }, (_, i) => page(i, bulk(4000)));
        const shaped: any = shapeDocumentResult(document(pages));

        expect(shaped.truncated).toBe(true);
        expect(shaped.note).toMatch(/read_document again with pages/);
        expect(shaped.pages.length).toBeLessThan(20);
        expect(shaped.total_pages).toBe(20);
        // The range has to name where it stopped, or the model cannot ask for
        // the next slice.
        expect(shaped.pages_returned).toBe(`1-${shaped.pages.length}`);
    });

    it('marks nothing truncated when the whole document fits', () => {
        const shaped: any = shapeDocumentResult(document([page(0, 'short')]));
        expect(shaped).not.toHaveProperty('truncated');
        expect(shaped).not.toHaveProperty('note');
        expect(shaped.pages_returned).toBe('1');
    });

    it('always returns the first requested page, however long it is', () => {
        // Budget-first would return zero pages for a single oversized page and
        // read as an empty document.
        const shaped: any = shapeDocumentResult(document([page(0, bulk(90_000))]));
        expect(shaped.pages).toHaveLength(1);
        expect(shaped.pages[0].text).toHaveLength(90_000);
    });

    it('returns only the pages asked for', () => {
        const pages = Array.from({ length: 10 }, (_, i) => page(i, `page ${i + 1}`));
        const shaped: any = shapeDocumentResult(document(pages), { pages: [3, 7] });
        expect(shaped.pages.map((p: any) => p.page)).toEqual([3, 7]);
        expect(shaped.pages[0].text).toBe('page 3');
    });

    it('tolerates page numbers given as strings', () => {
        // Models routinely send "3" where the schema says integer.
        const shaped: any = shapeDocumentResult(
            document([page(0, 'a'), page(1, 'b'), page(2, 'c')]),
            { pages: ['2'] as any },
        );
        expect(shaped.pages.map((p: any) => p.page)).toEqual([2]);
    });

    it('says the document has no text rather than returning an empty read', () => {
        // A scan with no text layer. Returning "" would read as a blank paper.
        expect(() => shapeDocumentResult(document([], 14))).toThrow(/scan with no text layer/);
    });

    it('names the real page count when the requested pages do not exist', () => {
        expect(() => shapeDocumentResult(document([page(0, 'a')]), { pages: [40] })).toThrow(
            /has 1 pages/,
        );
    });
});

// ---------------------------------------------------------------------------
// shapeDocumentSearchResult
// ---------------------------------------------------------------------------

const hit = (matched_text?: string) => ({
    bbox: { l: 1, t: 2, r: 3, b: 4, origin: 'top-left' },
    role: 'body',
    weight: 1,
    ...(matched_text ? { matched_text } : {}),
});

describe('shapeDocumentSearchResult', () => {
    it('reduces hits to pages and matched text', () => {
        const shaped: any = shapeDocumentSearchResult({
            type: 'zotero_attachment_search',
            query: 'pollen',
            total_matches: 3,
            pages_with_matches: 2,
            total_pages: 12,
            pages: [
                { page_index: 4, match_count: 2, score: 9, text_length: 3000, hits: [hit('pollen loads'), hit('pollen baskets')] },
                { page_index: 8, match_count: 1, score: 3, text_length: 2000, hits: [hit('pollen')] },
            ],
        });

        expect(shaped.matches).toEqual([
            { page: 5, match_count: 2, excerpts: ['pollen loads', 'pollen baskets'] },
            { page: 9, match_count: 1, excerpts: ['pollen'] },
        ]);
        expect(shaped.total_matches).toBe(3);
        expect(shaped.total_pages).toBe(12);
    });

    it('drops the geometry, role and score entirely', () => {
        // These are most of the payload and mean nothing to a model that answers
        // in page numbers.
        const shaped = shapeDocumentSearchResult({
            query: 'q',
            pages: [{ page_index: 0, match_count: 1, score: 5, text_length: 10, hits: [hit('m')] }],
        });
        const serialized = JSON.stringify(shaped);
        for (const noise of ['bbox', 'role', 'weight', 'score', 'text_length']) {
            expect(serialized).not.toContain(noise);
        }
    });

    it('survives hits that carry no matched text', () => {
        const shaped: any = shapeDocumentSearchResult({
            query: 'q',
            pages: [{ page_index: 0, match_count: 2, hits: [hit(), hit('found')] }],
        });
        expect(shaped.matches[0].excerpts).toEqual(['found']);
    });

    it('caps the page list and says it did', () => {
        const pages = Array.from({ length: 30 }, (_, i) => ({
            page_index: i,
            match_count: 1,
            hits: [hit('m')],
        }));
        const shaped: any = shapeDocumentSearchResult({ query: 'q', pages });
        expect(shaped.matches).toHaveLength(12);
        expect(shaped.note).toMatch(/best-matching pages of 30/);
    });

    it('reports a miss as zero matches rather than failing', () => {
        // "Not in this paper" is a real answer and has to come back as one.
        const shaped: any = shapeDocumentSearchResult({
            query: 'unobtainium',
            total_matches: 0,
            pages_with_matches: 0,
            total_pages: 8,
            pages: [],
        });
        expect(shaped.total_matches).toBe(0);
        expect(shaped.matches).toEqual([]);
    });
});
