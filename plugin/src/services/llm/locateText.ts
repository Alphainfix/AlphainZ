/**
 * Finding where a phrase sits on a page, so a highlight can be placed on it.
 *
 * Beaver's server did this: it held the extraction and sent back page indices
 * plus boxes, and the client only placed them. Running locally the same
 * extraction is already here — and already cached — so the lookup moves to this
 * side.
 *
 * Matching is over the structured extraction's sentences rather than raw page
 * text, because sentences are the unit that carries geometry. A phrase spanning
 * two sentences yields both, which is what a highlight over a line break needs.
 *
 * Pure apart from the injected document loader.
 */

export interface LocatedBox {
    /** In the extraction's public bbox frame. */
    l: number;
    t: number;
    r: number;
    b: number;
}

export interface TextLocation {
    pageIndex: number;
    pageLabel?: string;
    boxes: LocatedBox[];
    /** The sentence text the match landed in, for reporting back. */
    matchedText: string;
}

/**
 * Normalize for comparison.
 *
 * Whitespace, case, and the three things that differ between how a passage
 * reads in the extraction and how a model quotes it back:
 *
 * - markdown emphasis, because the model quotes from `read_document`, which
 *   returns markdown, while the geometry lives on the raw structured text;
 * - soft and hard hyphens at a line break, which the extraction keeps and a
 *   quoting model drops;
 * - the several dash and quote characters typography substitutes, which a model
 *   reliably normalizes to ASCII;
 * - the typographic ligatures a PDF carries and a model spells out, plus the
 *   superscripts and other compatibility forms NFKC folds with them.
 *
 * The ligature case is not an edge case. In one test paper, 27% of the extracted
 * sentences contain one — `deﬁne`, `ﬁeld`, `ﬁt` — and a model quoting the
 * same sentence writes `fi`. Exact substring matching then fails on more than a
 * quarter of the document, and the failure surfaces as "that text was not found",
 * which reads as the model having misquoted.
 *
 * U+FFFD is dropped rather than matched. It marks a character the extraction
 * could not decode, so it stands for something neither side can reproduce; 37%
 * of that paper's sentences carry at least one. Dropping it on both sides lets
 * the surrounding words match instead of the whole quote failing on a glyph
 * that was already lost.
 *
 * Notation is otherwise left alone: stripping punctuation would let a quote
 * match the wrong formula.
 */
export function normalizeForMatch(text: string): string {
    return text
        // Compatibility-fold first, so a ligature is two letters by the time the
        // rules below run. NFKC rather than NFKD: it expands `ﬁ` and `²` without
        // splitting accented letters into base plus combining mark.
        .normalize('NFKC')
        .replace(/\uFFFD/g, '')
        // Paired emphasis only. A bare trailing asterisk is notation — `x2*` is
        // a different quantity, not an unclosed italic — and stripping it would make
        // the quote match the wrong quantity.
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/`/g, '')
        .replace(/\u00ad/g, '')
        .replace(/-\s+/g, '')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * A second, coarser reading of the same text, tried only when the exact one
 * finds nothing.
 *
 * The model quotes from `read_document`, which returns markdown, while the
 * geometry lives on a separately extracted structured text. The two disagree in
 * ways neither side is wrong about: markdown carries `##` on a heading the
 * structured text stores as plain words, and a superscript reference marker
 * lands as `temperatures.15` in one and `temperatures.` in the other.
 *
 * Keeping only letters, digits and single spaces makes those differences
 * invisible. It is deliberately a fallback rather than the default: dropping
 * punctuation lets `x2` match `x2*`, which is a different quantity, so it may
 * only run once the precise comparison has already come back empty — and only
 * ever on a whole quoted passage, where an accidental match is implausible.
 */
export function looseNormalizeForMatch(text: string): string {
    return normalizeForMatch(text)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

interface SentenceLike {
    text: string;
    bboxes: Array<[number, number, number, number]>;
}

interface PageLike {
    index: number;
    label?: string;
    items?: Array<{ sentences?: SentenceLike[] }>;
}

/**
 * Locate a phrase in a structured document.
 *
 * Returns every place it occurs, in reading order, so a caller can refuse to act
 * on an ambiguous match rather than silently highlighting the wrong one — the
 * failure mode that matters most here, since the user sees a highlight land in
 * the wrong paragraph and cannot tell why.
 */
export function locateTextInDocument(
    document: { pages?: PageLike[] } | null | undefined,
    needle: string,
    options: { pageIndex?: number } = {},
): TextLocation[] {
    const exact = locateWith(document, needle, options, normalizeForMatch);
    if (exact.length > 0) return exact;

    const loose = locateWith(document, needle, options, looseNormalizeForMatch);
    if (loose.length > 0) return loose;

    /*
     * Last resort: drop the first and last word.
     *
     * A superscript reference marker is where the two extractions disagree
     * most. Markdown keeps it welded to the word — `temperatures.15`, `rate15` —
     * and the structured text puts it in the neighbouring sentence or loses it,
     * so the quote carries one word the page does not and containment fails on
     * a passage that is otherwise identical.
     *
     * Only for a quote long enough that the remainder is still unmistakable.
     * Trimming the ends of a short phrase is how a highlight lands on the wrong
     * sentence, which is the failure the user cannot diagnose.
     */
    const words = looseNormalizeForMatch(needle).split(' ').filter(Boolean);
    if (words.length < 10) return [];
    const trimmed = words.slice(1, -1).join(' ');
    const ends = locateWith(document, trimmed, options, looseNormalizeForMatch);
    if (ends.length > 0) return ends;

    /*
     * The same words, in a different order.
     *
     * The two extractions do not always agree on reading order. A line with a
     * radical sign in it came out of the structured pass as "in the range √ of
     * 100 km/ limit of < 10 km/ yr (Wexley et al., 2010) and approach a model √
     * yr, placing them on par" — every word of the passage is there, threaded
     * from two lines in the order the glyph runs were positioned rather than
     * the order they are read in. The model quoted the markdown, which reads
     * correctly, so no amount of normalising the characters could make the two
     * strings contain one another.
     *
     * The block it belongs to is still the right block, and its boxes still
     * cover the right lines, so matching on the words alone places the
     * highlight correctly. Guarded hard, because word-order-free matching is
     * exactly how a highlight lands somewhere plausible and wrong: a long
     * passage only, and only against a window not much bigger than itself.
     */
    return locateByWords(document, words, options);
}

/** Widest window, relative to the needle, that a bag-of-words match may span. */
const WORD_MATCH_MAX_SPREAD = 2.5;

function locateByWords(
    document: { pages?: PageLike[] } | null | undefined,
    words: string[],
    options: { pageIndex?: number },
): TextLocation[] {
    const needed = new Map<string, number>();
    for (const word of words) needed.set(word, (needed.get(word) ?? 0) + 1);

    const contains = (haystack: string[]): boolean => {
        const have = new Map<string, number>();
        for (const word of haystack) have.set(word, (have.get(word) ?? 0) + 1);
        for (const [word, count] of needed) {
            if ((have.get(word) ?? 0) < count) return false;
        }
        return true;
    };

    type Candidate = TextLocation & { start: number; span: number; itemIndex: number; pageIdx: number };
    const candidates: Candidate[] = [];
    for (const page of document?.pages ?? []) {
        if (options.pageIndex !== undefined && page.index !== options.pageIndex) continue;
        (page.items ?? []).forEach((item, itemIndex) => {
            const sentences = item.sentences ?? [];
            for (let i = 0; i < sentences.length; i += 1) {
                for (let span = 1; span <= 3 && i + span <= sentences.length; span += 1) {
                    const window = sentences.slice(i, i + span);
                    const text = window.map((sentence) => sentence.text).join(' ');
                    const windowWords = looseNormalizeForMatch(text).split(' ').filter(Boolean);
                    if (windowWords.length > words.length * WORD_MATCH_MAX_SPREAD) break;
                    if (!contains(windowWords)) continue;
                    candidates.push({
                        pageIndex: page.index,
                        ...(page.label ? { pageLabel: page.label } : {}),
                        boxes: window.flatMap((sentence) =>
                            (sentence.bboxes ?? []).map(([l, t, r, b]) => ({ l, t, r, b })),
                        ),
                        matchedText: text,
                        start: i,
                        span,
                        itemIndex,
                        pageIdx: page.index,
                    });
                    break;
                }
            }
        });
    }

    /*
     * One occurrence, not one per window that covers it.
     *
     * If a single sentence holds every word, so does the two-sentence window
     * that starts before it — the same place, reported twice, which the caller
     * reads as an ambiguous match and refuses. Keep only the windows that do
     * not strictly contain a tighter one from the same block.
     */
    return candidates
        .filter((candidate) => !candidates.some((other) => (
            other !== candidate
            && other.pageIdx === candidate.pageIdx
            && other.itemIndex === candidate.itemIndex
            && other.start >= candidate.start
            && other.start + other.span <= candidate.start + candidate.span
            && other.span < candidate.span
        )))
        .map(({ start, span, itemIndex, pageIdx, ...location }) => location);
}

function locateWith(
    document: { pages?: PageLike[] } | null | undefined,
    needle: string,
    options: { pageIndex?: number },
    normalize: (text: string) => string,
): TextLocation[] {
    const target = normalize(needle);
    if (!target || !document?.pages) return [];

    const candidates: Array<TextLocation & { start: number; span: number; itemIndex: number }> = [];
    for (const page of document.pages) {
        if (options.pageIndex !== undefined && page.index !== options.pageIndex) continue;

        (page.items ?? []).forEach((item, itemIndex) => {
            const sentences = item.sentences ?? [];
            for (let i = 0; i < sentences.length; i += 1) {
                // A phrase can run across sentence boundaries, so windows of up
                // to three consecutive sentences are tried. The first span that
                // matches is the tightest one from this start.
                for (let span = 1; span <= 3 && i + span <= sentences.length; span += 1) {
                    const window = sentences.slice(i, i + span);
                    const text = normalize(window.map((s) => s.text).join(' '));
                    if (!text.includes(target)) continue;

                    candidates.push({
                        pageIndex: page.index,
                        ...(page.label ? { pageLabel: page.label } : {}),
                        boxes: window.flatMap((sentence) =>
                            (sentence.bboxes ?? []).map(([l, t, r, b]) => ({ l, t, r, b })),
                        ),
                        matchedText: window.map((s) => s.text).join(' '),
                        start: i,
                        span,
                        itemIndex,
                    });
                    break;
                }
            }
        });
    }

    /*
     * Drop a window that merely contains a tighter match.
     *
     * A phrase inside the second sentence also matches the two-sentence window
     * that starts at the first, so the same occurrence would be reported twice —
     * once precisely and once spilling into the previous line. Keeping only the
     * windows that contain no other match leaves one location per occurrence.
     */
    return candidates
        .filter(
            (candidate) =>
                !candidates.some(
                    (other) =>
                        other !== candidate &&
                        other.pageIndex === candidate.pageIndex &&
                        other.itemIndex === candidate.itemIndex &&
                        other.start >= candidate.start &&
                        other.start + other.span <= candidate.start + candidate.span &&
                        other.span < candidate.span,
                ),
        )
        .map(({ start, span, itemIndex, ...location }) => location);
}


/**
 * Split a quoted passage into sentences, longest-first.
 *
 * A passage that spans a column break, a page break, or more than three
 * sentences cannot be located as one run — the extraction keeps sentences
 * inside the block they were laid out in, and a window only ever reaches across
 * three of them within one block. Measured on a real skim of one review, six of
 * thirteen quotes failed this way.
 *
 * Falling back to the longest single sentence in the passage is not a
 * compromise: "highlight the specific sentence that matters, not a whole
 * paragraph" is what the tool asks for in the first place. The caller narrows
 * the highlight to whatever this returns and says so, rather than placing a
 * box over text it did not match.
 */
export function sentencesByLength(passage: string): string[] {
    // Not every full stop ends a sentence. "described in Sec. II.B" and
    // "Fig. 3 shows" both look like boundaries and splitting there yields two
    // fragments that place nowhere. A short capitalised token before the stop
    // is the reliable tell.
    const ABBREVIATION = /(?:^|[\s(])(?:[A-Za-z]{1,4}|Prof|approx|Suppl)\.$/;

    const parts: string[] = [];
    let start = 0;
    for (let i = 0; i < passage.length - 1; i += 1) {
        if (!'.!?'.includes(passage[i])) continue;
        if (!/\s/.test(passage[i + 1])) continue;
        const rest = passage.slice(i + 1).replace(/^\s+/, '');
        if (!/^[A-Z(\u201c"]/.test(rest)) continue;
        const head = passage.slice(start, i + 1);
        if (passage[i] === '.' && ABBREVIATION.test(head)) continue;
        parts.push(head);
        start = i + 1;
    }
    parts.push(passage.slice(start));

    return parts
        .map((part) => part.trim())
        // A fragment this short identifies nothing — "See Fig. 2." would match
        // half the paper, and a highlight has to land on one place.
        .filter((part) => part.split(/\s+/).length >= 6)
        .sort((a, b) => b.length - a.length);
}

/**
 * Locate a passage, using a page number as a tiebreaker rather than a filter.
 *
 * The model is asked which page a quote is on and it answers, but its answer is
 * a guess against whatever it last read — a page ordinal when the paper is
 * numbered from a cover, a remembered number when the quote came from a search
 * hit two calls ago. Passing that guess in as a filter meant a passage that
 * sits unambiguously on page 7 could not be found at all if the model said 8.
 *
 * Measured on the review the user was colour-coding: four consecutive quotes,
 * every one of them a unique exact match in the document, every one of them
 * returning nothing because the search was confined to the page the model
 * named. The model then spent three more turns rewording the quote — the
 * behaviour the user reported as "it thinks a lot when it fails" — against a
 * lookup that was never going to succeed.
 *
 * So the hint only breaks ties. A passage that occurs once is placed wherever
 * it is; a passage that occurs several times is placed on the hinted page if
 * one of them is there; otherwise the caller still sees the ambiguity.
 */
export function locateWithPageHint(
    document: { pages?: PageLike[] } | null | undefined,
    needle: string,
    hintPageIndex?: number,
): TextLocation[] {
    const all = locateTextInDocument(document, needle, {});
    if (all.length <= 1 || hintPageIndex === undefined || !Number.isFinite(hintPageIndex)) {
        return all;
    }
    const onHint = all.filter((location) => location.pageIndex === hintPageIndex);
    return onHint.length === 1 ? onHint : all;
}

/**
 * When a quote cannot be placed, hand back the closest real sentences.
 *
 * A failed placement used to be a bare "not found", and the model's response to
 * that was to guess: reword the quote, split it, try a shorter run, try another
 * page. Four or five tool calls, all of them working from the same wrong text,
 * and the user watching a wall of retries — the thing they reported as "when it
 * fails it thinks a lot".
 *
 * The document is already loaded and the sentences are right there, so the
 * failure can answer its own question. Ranked by how much of the quote's
 * vocabulary a sentence actually contains, which finds a paraphrase's source
 * without pretending to have located it: these are candidates for the model to
 * quote back verbatim, not a placement.
 */
export function suggestNearbyPassages(
    document: { pages?: PageLike[] } | null | undefined,
    needle: string,
    limit = 3,
): Array<{ page: number; text: string }> {
    const wanted = new Set(looseNormalizeForMatch(needle).split(' ').filter((w) => w.length > 2));
    if (wanted.size === 0) return [];

    const scored: Array<{ page: number; text: string; score: number }> = [];
    for (const page of document?.pages ?? []) {
        for (const item of page.items ?? []) {
            for (const sentence of item.sentences ?? []) {
                const words = looseNormalizeForMatch(sentence.text).split(' ').filter(Boolean);
                if (words.length < 4) continue;
                let hits = 0;
                for (const word of new Set(words)) if (wanted.has(word)) hits += 1;
                if (hits === 0) continue;
                // Overlap as a fraction of the quote, so a long paragraph that
                // happens to contain a few of the words does not outrank the
                // sentence the quote was actually taken from.
                scored.push({
                    page: page.index + 1,
                    text: sentence.text,
                    score: hits / wanted.size,
                });
            }
        }
    }

    return scored
        .filter((candidate) => candidate.score >= 0.4)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ page, text }) => ({ page, text }));
}
