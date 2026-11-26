/**
 * Citing an anchor instead of quoting the text back.
 *
 * Placing a highlight was a search: the model wrote a passage, and the passage
 * was matched against the extraction. Verbatim that works 96–100%, but a model
 * does not quote verbatim — it shortens, it reworders, and every drift is a
 * search that finds nothing.
 *
 * Beaver never searches: its extractor numbers each sentence and the model
 * cites the number. Ours numbers them too — it is the same extractor, and every
 * `Sentence` has carried an `id` all along. The ids were simply never shown.
 */
import { describe, expect, it } from 'vitest';

import {
    buildLocatorIndex,
    hasLocators,
    MAX_LOCATOR_SPAN,
    nearbyLocators,
    renderPageWithLocators,
    resolveLocator,
} from '../../../src/services/llm/sentenceLocators';

const page = (index: number, items: any[]) => ({ index, label: String(index + 1), items });
const sentence = (id: string, text: string, boxes: number[][] = [[1, 2, 3, 4]]) =>
    ({ id, order: 0, text, bboxes: boxes });

const DOC = {
    pages: [
        page(0, [
            { id: 'heading1', kind: 'section_header', text: '## Introduction' },
            {
                id: 'p1',
                kind: 'text',
                text: 'The first sentence. The second sentence.',
                sentences: [
                    sentence('s1', 'The first sentence.', [[10, 20, 200, 32]]),
                    sentence('s2', 'The second sentence.', [[10, 34, 180, 46]]),
                ],
            },
            { id: 'margin1', kind: 'margin', text: 'ECOLOGY LETTERS 23, 1342 (2020)' },
        ]),
        page(1, [
            {
                id: 'p2',
                kind: 'text',
                text: 'A sentence on page two.',
                sentences: [sentence('s3', 'A sentence on page two.', [[5, 5, 90, 15]])],
            },
        ]),
    ],
};

describe('the index', () => {
    it('carries every sentence, with its page and its rects', () => {
        const index = buildLocatorIndex(DOC);
        expect(index.get('s1')).toMatchObject({
            pageIndex: 0,
            pageLabel: '1',
            text: 'The first sentence.',
            boxes: [[10, 20, 200, 32]],
        });
        expect(index.get('s3')?.pageIndex).toBe(1);
    });

    it('carries paragraphs and headings too', () => {
        // The honest answer when the model means the whole paragraph, and the
        // only answer for a heading, which the splitter gives no sentences.
        const index = buildLocatorIndex(DOC);
        expect(index.get('p1')?.text).toBe('The first sentence. The second sentence.');
        expect(index.get('heading1')?.text).toBe('## Introduction');
    });

    it('gives a paragraph its sentences\' boxes, not its own rect', () => {
        // A rect spanning a paragraph covers the whitespace after its last
        // line, and the highlight would visibly overshoot.
        expect(buildLocatorIndex(DOC).get('p1')?.boxes).toEqual([
            [10, 20, 200, 32],
            [10, 34, 180, 46],
        ]);
    });

    it('leaves out running heads', () => {
        expect(buildLocatorIndex(DOC).has('margin1')).toBe(false);
    });
});

describe('rendering a page', () => {
    it('labels each sentence where it starts', () => {
        const text = renderPageWithLocators(DOC.pages[0]);
        expect(text).toContain('[s1] The first sentence. [s2] The second sentence.');
    });

    it('labels an item the splitter gave no sentences', () => {
        // Otherwise a heading would be readable and uncitable.
        expect(renderPageWithLocators(DOC.pages[0])).toContain('[heading1] ## Introduction');
    });

    it('drops the running head', () => {
        expect(renderPageWithLocators(DOC.pages[0])).not.toContain('ECOLOGY LETTERS');
    });

    it('knows when a document has no locators at all', () => {
        // An EPUB, a snapshot, or a PDF whose structured pass degraded: the
        // caller falls back to markdown rather than rendering nothing.
        expect(hasLocators({ pages: [{ index: 0, markdown: 'plain' }] })).toBe(false);
        expect(hasLocators(DOC)).toBe(true);
    });
});

describe('resolving a locator', () => {
    const index = buildLocatorIndex(DOC);

    it('finds a sentence by its label', () => {
        const found = resolveLocator('s2', index);
        expect(found).toHaveLength(1);
        expect(found[0].text).toBe('The second sentence.');
    });

    it('joins a range, for a sentence the splitter cut in two', () => {
        const found = resolveLocator('s1-s2', index);
        expect(found.map((f) => f.text)).toEqual(['The first sentence.', 'The second sentence.']);
    });

    it('accepts a range written without the second prefix', () => {
        expect(resolveLocator('s1-2', index)).toHaveLength(2);
    });

    it('refuses a range that crosses a page', () => {
        // A highlight is one run of boxes on one page. Returning the first
        // page's half would place a mark that silently omits the rest.
        expect(resolveLocator('s2-s3', index)).toEqual([]);
    });

    it('refuses a range long enough to be a paragraph', () => {
        const long = { pages: [page(0, [{
            id: 'p9', kind: 'text', text: 'x',
            sentences: Array.from({ length: 20 }, (_, i) => sentence(`s${i + 1}`, `Sentence ${i + 1}.`)),
        }])] };
        const wide = buildLocatorIndex(long);
        expect(resolveLocator(`s1-s${MAX_LOCATOR_SPAN + 1}`, wide)).toEqual([]);
        expect(resolveLocator(`s1-s${MAX_LOCATOR_SPAN}`, wide)).toHaveLength(MAX_LOCATOR_SPAN);
    });

    it('returns nothing for a label that does not exist', () => {
        expect(resolveLocator('s99', index)).toEqual([]);
        expect(resolveLocator('', index)).toEqual([]);
        expect(resolveLocator('page 3', index)).toEqual([]);
    });

    it('suggests the neighbours of a label that missed', () => {
        // A model that is one off should be told so, not made to read the page
        // again.
        expect(nearbyLocators('s2', index)).toContain('s1');
        expect(nearbyLocators('s2', index)).toContain('s3');
    });
});
