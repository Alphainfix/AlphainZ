/**
 * Locating a phrase so a highlight can be placed on it.
 *
 * The failure that matters is a highlight landing in the wrong paragraph: the
 * user sees it and has no way to tell why. So an ambiguous phrase must come
 * back as several locations for the caller to refuse, never as a confident
 * first guess.
 */
import { describe, expect, it } from 'vitest';

import {
    locateTextInDocument,
    locateWithPageHint,
    normalizeForMatch,
    sentencesByLength,
    suggestNearbyPassages,
} from '../../../src/services/llm/locateText';

const sentence = (text: string, box: [number, number, number, number]) => ({
    text,
    bboxes: [box],
});

const doc = (pages: any[]) => ({ pages });

const page = (index: number, sentences: any[], label?: string) => ({
    index,
    ...(label ? { label } : {}),
    items: [{ sentences }],
});

describe('normalizeForMatch', () => {
    it('collapses whitespace and case but not characters', () => {
        expect(normalizeForMatch('  The  Waggle\nDance ')).toBe('the waggle dance');
    });

    it('leaves notation intact', () => {
        // A matcher that stripped punctuation would match the wrong formula, and
        // `K2*` is a starred rate constant rather than an unclosed italic.
        expect(normalizeForMatch('K2* = 1/(2π Δf)')).toBe('k2* = 1/(2π δf)');
    });

    it('strips markdown emphasis, since the model quotes from the markdown view', () => {
        expect(normalizeForMatch('the **waggle dance** encodes')).toBe('the waggle dance encodes');
        expect(normalizeForMatch('a *slow* dance')).toBe('a slow dance');
    });

    it('rejoins a word broken across a line', () => {
        // The extraction keeps the hyphen; a quoting model drops it.
        expect(normalizeForMatch('navi- gation')).toBe('navigation');
    });

    it('folds typographic dashes and quotes to ASCII', () => {
        expect(normalizeForMatch('two\u2013three "x"')).toBe('two-three "x"');
        expect(normalizeForMatch('\u201cquoted\u201d')).toBe('"quoted"');
    });

    it('expands the ligatures a PDF carries and a model spells out', () => {
        // Measured on one paper: 27% of extracted sentences contain one.
        // Without this the quote fails to match on more than a quarter of the
        // document, reported to the user as "that text was not found".
        expect(normalizeForMatch('bene\uFB01cial \uFB01ndings')).toBe('beneficial findings');
        expect(normalizeForMatch('re\uFB02ect the di\uFB00erence')).toBe('reflect the difference');
        expect(normalizeForMatch('e\uFB03cient')).toBe('efficient');
    });

    it('folds a superscript to its digit, so a reference marker matches', () => {
        expect(normalizeForMatch('voracity\u2075')).toBe('voracity5');
    });

    it('drops the character the extraction could not decode', () => {
        // U+FFFD stands for a glyph neither side can reproduce — 37% of that
        // paper's sentences carry one. Dropping it on both sides lets the words
        // around it match instead of failing the whole quote.
        expect(normalizeForMatch('along \uFFFD110\uFFFD')).toBe('along 110');
    });

    it('keeps an accented letter whole', () => {
        // NFKC rather than NFKD: decomposing into base plus combining mark
        // would make the two sides differ by how the accent is encoded.
        expect(normalizeForMatch('Cafe\u0301 culture')).toBe('café culture');
    });
});

describe('locateTextInDocument', () => {
    const document = doc([
        page(0, [
            sentence('We measure tunnel odometry.', [10, 20, 200, 32]),
            sentence('The waggle dance encodes distance.', [10, 34, 180, 46]),
        ]),
        page(1, [sentence('Tunnel odometry again.', [12, 22, 210, 34])], 'ii'),
    ]);

    it('finds a phrase and returns its boxes', () => {
        const found = locateTextInDocument(document, 'waggle dance encodes');
        expect(found).toHaveLength(1);
        expect(found[0].pageIndex).toBe(0);
        expect(found[0].boxes).toEqual([{ l: 10, t: 34, r: 180, b: 46 }]);
    });

    it('reports every occurrence so an ambiguous phrase can be refused', () => {
        const found = locateTextInDocument(document, 'tunnel odometry');
        expect(found.map((f) => f.pageIndex)).toEqual([0, 1]);
    });

    it('carries the printed page label when the page has one', () => {
        const found = locateTextInDocument(document, 'again');
        expect(found[0].pageLabel).toBe('ii');
    });

    it('can be restricted to one page', () => {
        const found = locateTextInDocument(document, 'tunnel odometry', { pageIndex: 1 });
        expect(found).toHaveLength(1);
        expect(found[0].pageIndex).toBe(1);
    });

    it('matches across a sentence boundary and returns both sets of boxes', () => {
        // A selection over a line break spans two sentences; one box would
        // highlight half of it.
        const found = locateTextInDocument(document, 'odometry. The waggle dance');
        expect(found).toHaveLength(1);
        expect(found[0].boxes).toHaveLength(2);
    });

    it('ignores differences in whitespace and case', () => {
        expect(locateTextInDocument(document, 'WAGGLE   DANCE')).toHaveLength(1);
    });

    it('returns nothing for a phrase that is not there', () => {
        expect(locateTextInDocument(document, 'unobtainium')).toEqual([]);
    });

    it('returns nothing for an empty needle rather than matching everything', () => {
        expect(locateTextInDocument(document, '   ')).toEqual([]);
    });

    it('survives a document with no pages', () => {
        expect(locateTextInDocument(null, 'x')).toEqual([]);
        expect(locateTextInDocument({}, 'x')).toEqual([]);
    });

    it('survives a sentence with no geometry', () => {
        const bare = doc([page(0, [{ text: 'No boxes here.', bboxes: undefined as any }])]);
        const found = locateTextInDocument(bare, 'no boxes');
        expect(found).toHaveLength(1);
        expect(found[0].boxes).toEqual([]);
    });

    it('prefers the tightest window that contains the phrase', () => {
        // Matching the single sentence rather than a two-sentence window keeps
        // the highlight from spilling into the next line.
        const found = locateTextInDocument(document, 'waggle dance');
        expect(found[0].boxes).toHaveLength(1);
    });
});

describe('locateTextInDocument: quoting an extracted sentence back', () => {
    it('places a highlight when the model spells out the ligatures', () => {
        // The exact shape that failed in a real run: the extraction holds
        // `proﬁle`, the model quotes `profile`, and the highlight was
        // refused as not found.
        const extracted =
            'The previously published parameters for the delta sediment pro\uFB01le '
            + 'do not produce a satisfactory \uFB01t to the experimental data.';
        const asQuoted = extracted.replace(/\uFB01/g, 'fi');

        const document = doc([page(0, [sentence(extracted, [10, 20, 300, 32])], '3')]);

        expect(locateTextInDocument(document, extracted)).toHaveLength(1);
        const found = locateTextInDocument(document, asQuoted);
        expect(found).toHaveLength(1);
        expect(found[0].pageIndex).toBe(0);
        expect(found[0].pageLabel).toBe('3');
    });

    it('matches around a glyph the extraction lost', () => {
        const extracted = 'the test \uFB01eld B lies along \uFFFD110\uFFFD.';
        const document = doc([page(0, [sentence(extracted, [10, 20, 300, 32])])]);
        expect(locateTextInDocument(document, 'the test field B lies along 110.')).toHaveLength(1);
    });
});

describe('locateTextInDocument: where the two extractions disagree', () => {
    // The model quotes from the markdown view; the geometry lives on a
    // separately extracted structured text. Measured across one paper, quoting
    // markdown sentences back located 86.4% of them exactly; the fallbacks
    // below take it to 89.4%.
    const structured = (text: string) =>
        doc([page(0, [sentence(text, [10, 20, 300, 32])], '1')]);

    it('places a quote carrying a superscript marker the page does not', () => {
        // Markdown welds the reference number to the word; the structured text
        // puts it in the next sentence or loses it.
        const document = structured(
            'Leaf litter is an effective trap for sediment, which is mobile above these flow rates.',
        );
        expect(locateTextInDocument(
            document,
            'Leaf litter is an effective trap for sediment, which is mobile above these flow rates.15',
        )).toHaveLength(1);
    });

    it('places a quote whose first word is a superscript the page split off', () => {
        const document = structured(
            'C labelled CO2 was added to the chamber air and the carbon-fed seedlings grew.',
        );
        expect(locateTextInDocument(
            document,
            '13C labelled CO2 was added to the chamber air and the carbon-fed seedlings grew.',
        )).toHaveLength(1);
    });

    it('will not trim the ends of a short phrase to force a match', () => {
        // Trimming a short quote is how a highlight lands on the wrong
        // sentence — the failure the user cannot diagnose.
        const document = structured('The dough is slow.');
        expect(locateTextInDocument(document, 'x The dough is slow. y')).toHaveLength(0);
    });

    it('still refuses a passage that is simply not there', () => {
        const document = structured(
            'The waggle dance tells nestmates how far away the food source lies in the meadow.',
        );
        expect(locateTextInDocument(
            document,
            'Sourdough starters are kept at room temperature in a loosely covered glass jar.',
        )).toHaveLength(0);
    });
});

/**
 * Splitting a passage that will not place as one run.
 *
 * Extraction keeps sentences inside the block they were laid out in, and a
 * match window reaches across at most three of them — so a quote spanning a
 * column break, a page break, or four sentences cannot be found whole. On one
 * skim of a review that was six quotes out of thirteen.
 */
describe('sentencesByLength', () => {
    it('returns the sentences of a passage, longest first', () => {
        const passage =
            'Honeybee navigation describes how a forager finds its way between the hive and a flower patch. '
            + 'The forager must judge distance and direction on every trip.';
        const out = sentencesByLength(passage);
        expect(out).toHaveLength(2);
        expect(out[0].length).toBeGreaterThan(out[1].length);
        expect(out[0]).toMatch(/^Honeybee navigation describes/);
    });

    it('drops fragments too short to identify a passage', () => {
        // "See Fig. 2." would match half the paper.
        const out = sentencesByLength('See Fig. 2. The proofing time must be made as long as possible here.');
        expect(out).toEqual(['The proofing time must be made as long as possible here.']);
    });

    it('leaves a single sentence as one entry, so nothing is narrowed needlessly', () => {
        const one = 'The proofing time must be made as long as is practically possible.';
        expect(sentencesByLength(one)).toEqual([one]);
    });

    it('does not split on an abbreviation mid-sentence', () => {
        // A split here would hand back two fragments that place nowhere.
        const passage = 'The effect size scales as described in Sec. II.B of this review article.';
        expect(sentencesByLength(passage)).toEqual([passage]);
    });
});

/**
 * The same words, threaded in a different order.
 *
 * The two extractions do not always agree on reading order. A line carrying a
 * radical sign came out of the structured pass as "in the range √ of 100 km/
 * limit of < 10 km/ yr (Wexley et al., 2010) and approach a theory √ yr, placing
 * them on par" — every word present, interleaved from two lines in the order
 * the glyph runs were positioned. The model quotes the markdown, which reads
 * correctly, so no amount of normalising characters can make either string
 * contain the other.
 *
 * Measured over 200 sentences of a real review: matching on words alone took
 * reordered passages from 107 placed to 196, with none landing on a wrong page
 * and none of 100 needles spliced from two different sentences matching at all.
 */
describe('word-order-free fallback', () => {
    const doc = (text: string) => ({
        pages: [
            {
                index: 3,
                label: '4',
                items: [{ sentences: [{ text, bboxes: [[10, 20, 300, 32] as [number, number, number, number]] }] }],
            },
        ],
    });

    const SCRAMBLED =
        'Despite their superficial simplicity, these trackers achieve accuracies in the range '
        + '√ of 100 km/ limit of < 10 km/ yr (Wexley et al., 2010) and approach a theory √ yr, '
        + 'placing them on par with other loggers.';
    const AS_READ =
        'these trackers achieve accuracies in the range of 100 km/ √ yr (Wexley et al., 2010) '
        + 'and approach a theory limit of < 10 km/ √ yr, placing them on par';

    it('places a passage the layout scrambled', () => {
        const hits = locateTextInDocument(doc(SCRAMBLED), AS_READ);
        expect(hits).toHaveLength(1);
        expect(hits[0].pageIndex).toBe(3);
    });

    it('does not fire on a short phrase, where a coincidence is plausible', () => {
        // Nine words in a different order could be almost anything.
        expect(locateTextInDocument(doc(SCRAMBLED), 'trackers range the in achieve these accuracies theory limit')).toHaveLength(0);
    });

    it('refuses a passage whose words are only partly present', () => {
        // A paraphrase is a model error, and placing it would hide that.
        expect(
            locateTextInDocument(
                doc(SCRAMBLED),
                'these detectors achieve accuracies in the range of 100 km and approach a theoretical limit',
            ),
        ).toHaveLength(0);
    });

    it('will not match a window far larger than the passage', () => {
        // Otherwise a long block containing the words anywhere in it would
        // "match", and the highlight would cover most of a column.
        const long = `${SCRAMBLED} ${'Filler sentence with unrelated words here. '.repeat(12)}`;
        expect(locateTextInDocument(doc(long), AS_READ)).toHaveLength(0);
    });

    it('reports one hit, not one per window that covers it', () => {
        // A single sentence holding every word is also inside the two-sentence
        // window before it; reported twice, the caller reads that as ambiguous
        // and refuses to place anything.
        const twoSentences = {
            pages: [
                {
                    index: 0,
                    items: [
                        {
                            sentences: [
                                { text: 'An unrelated opening sentence sits here.', bboxes: [[0, 0, 1, 1] as [number, number, number, number]] },
                                { text: SCRAMBLED, bboxes: [[0, 2, 1, 3] as [number, number, number, number]] },
                            ],
                        },
                    ],
                },
            ],
        };
        expect(locateTextInDocument(twoSentences, AS_READ)).toHaveLength(1);
    });
});

describe('the page number is a hint, not a filter', () => {
    /*
     * The failure this exists for, reproduced from a real run.
     *
     * Four consecutive quotes from a review, each a unique exact match on page
     * 7 of the extraction. The model said page 8 — it had been reading a page
     * whose printed label and index disagree — and every one of them came back
     * "not found", because the search had been confined to the page it named.
     * It then spent three turns rewording quotes that were already verbatim.
     */
    const twoPages = {
        pages: [
            {
                index: 6,
                items: [{ sentences: [
                    { text: 'Among all foraging insects, honeybees have received the most attention.', bboxes: [[1, 1, 2, 2]] },
                ] }],
            },
            {
                index: 7,
                items: [{ sentences: [
                    { text: 'Something else entirely lives on this page.', bboxes: [[1, 1, 2, 2]] },
                ] }],
            },
        ],
    };

    it('finds a unique match on a page the model did not name', () => {
        const found = locateWithPageHint(twoPages, 'honeybees have received the most attention', 7);
        expect(found).toHaveLength(1);
        expect(found[0].pageIndex).toBe(6);
    });

    it('still uses the hint to break a tie', () => {
        const repeated = {
            pages: [6, 7].map((index) => ({
                index,
                items: [{ sentences: [
                    { text: 'The waggle dance encodes the distance.', bboxes: [[1, 1, 2, 2]] },
                ] }],
            })),
        };
        expect(locateWithPageHint(repeated, 'waggle dance encodes', undefined)).toHaveLength(2);
        const hinted = locateWithPageHint(repeated, 'waggle dance encodes', 7);
        expect(hinted).toHaveLength(1);
        expect(hinted[0].pageIndex).toBe(7);
    });

    it('reports the ambiguity when the hint does not resolve it', () => {
        const repeated = {
            pages: [6, 7].map((index) => ({
                index,
                items: [{ sentences: [
                    { text: 'The waggle dance encodes the distance.', bboxes: [[1, 1, 2, 2]] },
                ] }],
            })),
        };
        // Page 3 holds neither. Hiding both would be worse than saying so.
        expect(locateWithPageHint(repeated, 'waggle dance encodes', 2)).toHaveLength(2);
    });
});

describe('suggesting passages when a quote cannot be placed', () => {
    const document = {
        pages: [
            {
                index: 0,
                items: [{ sentences: [
                    { text: 'We observe that the proofing time scales inversely with starter concentration.', bboxes: [[1, 1, 2, 2]] },
                    { text: 'The doughs were mixed by hand in a home kitchen.', bboxes: [[1, 3, 2, 4]] },
                ] }],
            },
        ],
    };

    it('finds the sentence a paraphrase came from', () => {
        const suggested = suggestNearbyPassages(
            document,
            'The authors note the proofing time scales inversely with the starter concentration',
        );
        expect(suggested[0].text).toContain('proofing time scales inversely');
        expect(suggested[0].page).toBe(1);
    });

    it('offers nothing for a quote from another paper', () => {
        // Silence beats a confident wrong suggestion: the model is being asked
        // to copy one of these verbatim.
        expect(suggestNearbyPassages(document, 'Honeybees judge distance from optic flow')).toEqual([]);
    });
});
