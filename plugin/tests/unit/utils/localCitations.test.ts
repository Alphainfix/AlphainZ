/**
 * Resolving the citation tags a model emits.
 *
 * The rule worth pinning: a tag that cannot be resolved comes back marked
 * invalid, never dropped. A silently discarded citation reads to the user as an
 * unsupported claim; an invalid one shows the model asserted a source that is
 * not in the library.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { getCitationBoundingBoxes } from '@beaver/agent-core/types/citations';

import {
    evidenceKey,
    extractCitationTags,
    resolveCitationTag,
    resolveCitationsInText,
} from '../../../react/utils/localCitations';

const paper = {
    itemType: 'journalArticle',
    isAttachment: () => false,
    isNote: () => false,
    getCreators: () => [{ lastName: 'Wexley' }, { lastName: 'Arneberg' }, { lastName: 'Okafor-Lind' }],
    getField: (name: string) => (name === 'date' ? '2022-02-03' : 'Optic-flow odometry in foraging bees'),
} as any;

beforeEach(() => {
    (Zotero as any).Libraries = { userLibraryID: 1 };
    (Zotero as any).Items = { getByLibraryAndKey: vi.fn(() => paper) };
});

describe('extractCitationTags', () => {
    it('finds a self-closing tag', () => {
        const tags = extractCitationTags('A claim. <citation id="u-ABCD1234" page="3"/> More.');
        expect(tags).toHaveLength(1);
        expect(tags[0].attrs).toMatchObject({ id: 'u-ABCD1234', page: '3' });
    });

    it('finds a tag written without the slash', () => {
        // Models are inconsistent about self-closing; both forms have to work.
        expect(extractCitationTags('<citation id="u-ABCD1234">')).toHaveLength(1);
    });

    it('finds several tags in order', () => {
        const tags = extractCitationTags(
            'One. <citation id="u-AAAA1111"/> Two. <citation id="u-BBBB2222"/>',
        );
        expect(tags.map((t) => t.attrs.id)).toEqual(['u-AAAA1111', 'u-BBBB2222']);
    });

    it('finds nothing in ordinary prose', () => {
        expect(extractCitationTags('No citations here at all.')).toEqual([]);
    });
});

describe('resolveCitationTag', () => {
    it('resolves a library item to an author-year label', () => {
        const citation = resolveCitationTag(
            { raw: '<citation id="u-ABCD1234"/>', attrs: { id: 'u-ABCD1234' } },
            0,
        );
        // Three creators, so "et al." — the form a reader expects inline.
        expect(citation.display_name).toBe('Wexley et al., 2022');
        expect(citation.invalid).toBeUndefined();
        expect(citation.item_type).toBe('journalArticle');
    });

    it('carries the cited page through as a number', () => {
        const citation = resolveCitationTag(
            { raw: '<citation id="u-ABCD1234" page="3"/>', attrs: { id: 'u-ABCD1234', page: '3' } },
            0,
        );
        expect(citation.pages).toEqual([3]);
    });

    it('expands a small page range', () => {
        const citation = resolveCitationTag(
            { raw: '', attrs: { id: 'u-ABCD1234', page: '4-6' } },
            0,
        );
        expect(citation.pages).toEqual([4, 5, 6]);
    });

    it('refuses to expand an absurd range', () => {
        // A model that writes "1-9999" means "somewhere in here", and enumerating
        // it would flood the sources list.
        const citation = resolveCitationTag(
            { raw: '', attrs: { id: 'u-ABCD1234', page: '1-9999' } },
            0,
        );
        expect(citation.pages).toEqual([1]);
    });

    it('marks a citation invalid when the item is not in the library', () => {
        (Zotero as any).Items.getByLibraryAndKey = vi.fn(() => false);
        const citation = resolveCitationTag(
            { raw: '<citation id="u-MISSING1"/>', attrs: { id: 'u-MISSING1' } },
            0,
        );
        expect(citation.invalid).toBe(true);
        expect(citation.invalid_reason).toBe('not_found');
        // The raw tag survives, so the renderer can show what was claimed.
        expect(citation.raw_tag).toContain('u-MISSING1');
    });

    it('marks an unparseable tag invalid rather than throwing', () => {
        const citation = resolveCitationTag({ raw: '<citation/>', attrs: {} }, 0);
        expect(citation.invalid).toBe(true);
    });

    it('resolves an external result without touching the library', () => {
        const citation = resolveCitationTag(
            { raw: '', attrs: { external_id: 'W2741809807', title: 'Some paper' } },
            0,
        );
        expect(citation.invalid).toBeUndefined();
        expect(citation.display_name).toBe('Some paper');
    });

    it('survives a formatter that throws', () => {
        // A CSL failure costs the bibliographic line, not the citation.
        const citation = resolveCitationTag(
            { raw: '', attrs: { id: 'u-ABCD1234' } },
            0,
            () => {
                throw new Error('no style');
            },
        );
        expect(citation.invalid).toBeUndefined();
        expect(citation.formatted_citation).toBeUndefined();
    });

    it('uses the formatter when it works', () => {
        const citation = resolveCitationTag(
            { raw: '', attrs: { id: 'u-ABCD1234' } },
            0,
            () => 'Wexley, J. et al. (2022). Science.',
        );
        expect(citation.formatted_citation).toBe('Wexley, J. et al. (2022). Science.');
    });
});

describe('resolveCitationsInText', () => {
    it('collapses the same source cited twice into one entry', () => {
        // Both inline markers point at one source; two entries would double it in
        // the sources list.
        const citations = resolveCitationsInText(
            'A. <citation id="u-ABCD1234"/> B. <citation id="u-ABCD1234"/>',
        );
        expect(citations).toHaveLength(1);
    });

    it('keeps the same item cited at different pages apart', () => {
        const citations = resolveCitationsInText(
            'A. <citation id="u-ABCD1234" page="1"/> B. <citation id="u-ABCD1234" page="7"/>',
        );
        expect(citations).toHaveLength(2);
        expect(citations.map((c) => c.pages)).toEqual([[1], [7]]);
    });

    it('returns nothing for prose with no tags', () => {
        expect(resolveCitationsInText('Just an answer.')).toEqual([]);
    });
});

/**
 * A citation to a paper the user does not own.
 *
 * The tag carries only the OpenAlex id, so with nothing to look it up against
 * the source row came out blank — a number and empty space. The search that
 * produced the id cached the metadata; this is the join.
 */
describe('external citations', () => {
    const catalogue: Record<string, { display_name?: string; formatted_citation?: string }> = {
        W2741809807: {
            display_name: 'Valcourt et al., 2017',
            formatted_citation: 'Valcourt, I. et al. 2017. Honeybee navigation. Annu. Rev. Entomol.',
        },
    };
    const lookup = (id: string) => catalogue[id];

    it('names an external citation from the search that found it', () => {
        const [citation] = resolveCitationsInText(
            '<citation external_id="W2741809807"/>',
            undefined,
            lookup,
        );
        expect(citation.display_name).toBe('Valcourt et al., 2017');
        expect(citation.formatted_citation).toContain('Honeybee navigation');
        expect(citation.invalid).toBeUndefined();
    });

    it('still renders an id the search never returned, rather than dropping it', () => {
        // Better a row with a bare id than a claim that looks unsupported.
        const [citation] = resolveCitationsInText(
            '<citation external_id="W999999999"/>',
            undefined,
            lookup,
        );
        expect(citation.display_name).toBeUndefined();
        expect((citation.resolved_ref as any)?.external_id).toBe('W999999999');
    });

    it('prefers a title written into the tag over the cache', () => {
        const [citation] = resolveCitationsInText(
            '<citation external_id="W2741809807" title="A better name"/>',
            undefined,
            lookup,
        );
        expect(citation.display_name).toBe('A better name');
    });
});

describe('sentence-level citations', () => {
    /*
     * Beaver's citations are sentence-level: hovering shows the passage and
     * clicking opens the PDF with it highlighted. Ours were page-level, so the
     * hover card repeated a bibliographic line the reader already had and the
     * click turned to a page they then had to search — and the "Keep Cited
     * Passages Highlighted" setting controlled nothing at all, because nothing
     * ever carried the boxes it needed.
     *
     * Where the run placed a highlight it knows both halves, so those citations
     * can carry them.
     */
    const PASSAGE = 'Among all foraging insects, honeybees have received the most attention.';

    it('puts the passage and its rects on the matching citation', () => {
        const evidence = new Map([
            [evidenceKey('u-AAA', 7), { text: PASSAGE, boxes: [[10, 20, 300, 34]] }],
        ]);
        const [citation] = resolveCitationsInText(
            `A claim.<citation id="u-AAA" page="7"/>`,
            undefined,
            undefined,
            evidence,
        );
        expect(citation.preview).toBe(PASSAGE);
        expect(citation.locations?.[0].page_idx).toBe(6);
        expect(citation.locations?.[0].boxes).toEqual([[10, 20, 300, 34]]);
        expect(getCitationBoundingBoxes(citation)).toHaveLength(1);
    });

    it('shows the sentence a locator names, without inventing rectangles', () => {
        const bySentence = (id: string, loc: string) =>
            id === 'u-AAA' && loc === 's12' ? { text: PASSAGE } : undefined;
        const [citation] = resolveCitationsInText(
            `A claim.<citation id="u-AAA" page="7" loc="s12"/>`,
            undefined,
            undefined,
            undefined,
            bySentence,
        );
        expect(citation.preview).toBe(PASSAGE);
        expect(citation.pages).toEqual([7]);
        // The click resolves the boxes from the cached extraction; none are
        // made up here.
        expect(citation.locations).toBeUndefined();
    });

    it('prefers the named sentence over a highlight merely on the same page', () => {
        const evidence = new Map([
            [evidenceKey('u-AAA', 7), { text: 'The highlighted sentence.', boxes: [[10, 20, 300, 34]] }],
        ]);
        const [citation] = resolveCitationsInText(
            `A claim.<citation id="u-AAA" page="7" loc="s30"/>`,
            undefined,
            undefined,
            evidence,
            () => ({ text: 'The sentence s30 names.' }),
        );
        expect(citation.preview).toBe('The sentence s30 names.');
    });

    it('still uses the highlight when the locator lookup knows nothing', () => {
        const evidence = new Map([
            [evidenceKey('u-AAA', 7), { text: PASSAGE, boxes: [[10, 20, 300, 34]] }],
        ]);
        const [citation] = resolveCitationsInText(
            `A claim.<citation id="u-AAA" page="7" loc="s30"/>`,
            undefined,
            undefined,
            evidence,
            () => undefined,
        );
        expect(citation.preview).toBe(PASSAGE);
    });

    it('takes the page from the evidence when the tag left it out', () => {
        const [citation] = resolveCitationsInText(
            `A claim.<citation id="u-AAA" loc="s12"/>`,
            undefined,
            undefined,
            undefined,
            () => ({ text: PASSAGE, page: 7 }),
        );
        expect(citation.pages).toEqual([7]);
        expect(citation.preview).toBe(PASSAGE);
    });

    it('leaves a citation on another page alone', () => {
        // The evidence is about page 7; page 3 of the same paper is a different
        // passage, and inventing one would put the highlight in the wrong place.
        const evidence = new Map([
            [evidenceKey('u-AAA', 7), { text: PASSAGE, boxes: [[10, 20, 300, 34]] }],
        ]);
        const [citation] = resolveCitationsInText(
            `A claim.<citation id="u-AAA" page="3"/>`,
            undefined,
            undefined,
            evidence,
        );
        expect(citation.preview).toBeUndefined();
        expect(citation.locations).toBeUndefined();
    });

    it('still resolves normally when nothing is known about the passage', () => {
        const [citation] = resolveCitationsInText(`A claim.<citation id="u-AAA" page="7"/>`);
        expect(citation.pages).toEqual([7]);
        expect(citation.preview).toBeUndefined();
    });
});
