/**
 * Sentence locators: citing an anchor instead of quoting the text back.
 *
 * Placing a highlight used to be a search. The model read the paper, wrote a
 * passage back, and the passage was matched against the extraction to find its
 * rects. Quoted verbatim that works 96–100% (measured over 200+ sentences on
 * two papers) — but a model does not quote verbatim. It shortens, it
 * straightens a quote mark, it writes "We observe that" where the paper says
 * "we see that". Each of those is a search that finds nothing, and the user
 * watches it reword the same sentence four times before giving up.
 *
 * Beaver never had this problem because Beaver never searches. Its extractor
 * numbers every sentence as it parses — `s1`, `s2`, … — the model cites the
 * number, and placement is an index lookup.
 *
 * The remarkable part is that *our* extractor already does this. It is the same
 * extractor: every `Sentence` carries an `id`, every item carries an `id`, and
 * the document ships a `citationIndex` mapping each id to its page. On one
 * 9-page paper that is 887 entries. Nothing had to be built — the ids were
 * simply never shown to the model, and the highlight tool never accepted one.
 *
 * So this module does two small things: write the page out with each sentence
 * labelled, and turn a label back into a page and a set of boxes.
 */

import type { Rect } from '@beaver/agent-core/extract/schema';

export interface LocatedText {
    /** The anchor as the model writes it, e.g. `s9`. */
    id: string;
    /** 0-based page index. */
    pageIndex: number;
    pageLabel?: string;
    text: string;
    /** `[l, t, r, b]` quads in the extraction's top-left page frame. */
    boxes: number[][];
}

interface SentenceLike { id?: string; text?: string; bboxes?: Rect[] }
interface ItemLike { id?: string; kind?: string; text?: string; sentences?: SentenceLike[] }
interface PageLike { index?: number; label?: string; markdown?: string; items?: ItemLike[] }
interface CitationEntryLike { id: string; kind: string; pageIndex: number; pageLabel?: string; itemId: string; sentenceId?: string }
interface DocumentLike { pages?: PageLike[]; citationIndex?: Record<string, CitationEntryLike> }

/**
 * Item kinds that are page furniture rather than content.
 *
 * Running heads and folios repeat on every page, are never what a reader means
 * by "that sentence", and at one or two per page they are pure context cost.
 */
const FURNITURE = new Set(['margin']);

/** Sentences one locator range may span — see `resolveLocator`. */
export const MAX_LOCATOR_SPAN = 6;

/**
 * Every citable anchor in the document, by id.
 *
 * Built from the items rather than from `citationIndex`, because the index
 * carries the *location* of an id but not its text or its rects, and both are
 * needed to place a highlight. The index's page numbers are used to fill in
 * anything the walk could not reach.
 */
export function buildLocatorIndex(
    document: DocumentLike | null | undefined,
): Map<string, LocatedText> {
    const index = new Map<string, LocatedText>();

    for (const page of document?.pages ?? []) {
        const pageIndex = page.index ?? 0;
        const pageLabel = page.label;
        for (const item of page.items ?? []) {
            if (FURNITURE.has(item.kind ?? '')) continue;
            const sentences = item.sentences ?? [];

            for (const sentence of sentences) {
                const id = String(sentence.id ?? '');
                const text = String(sentence.text ?? '').trim();
                if (!id || !text) continue;
                index.set(id, {
                    id,
                    pageIndex,
                    ...(pageLabel ? { pageLabel } : {}),
                    text,
                    boxes: (sentence.bboxes ?? []).map((b) => [b[0], b[1], b[2], b[3]]),
                });
            }

            /*
             * The item itself is citable too — `p12`, `heading3`.
             *
             * A paragraph anchor is the honest answer when the model means the
             * whole paragraph, and the only answer for a heading, which the
             * splitter gives no sentences. Its boxes are the union of its
             * sentences' boxes rather than the item's own rect: a rect spanning
             * a paragraph covers the whitespace at the end of its last line,
             * and the highlight would visibly overshoot.
             */
            const itemId = String(item.id ?? '');
            const itemText = String(item.text ?? '').trim();
            if (!itemId || !itemText || index.has(itemId)) continue;
            const boxes = sentences.flatMap((s) => (s.bboxes ?? []).map((b) => [b[0], b[1], b[2], b[3]]));
            index.set(itemId, {
                id: itemId,
                pageIndex,
                ...(pageLabel ? { pageLabel } : {}),
                text: itemText,
                boxes,
            });
        }
    }

    return index;
}

/** Whether this document can be rendered with locators at all. */
export function hasLocators(document: DocumentLike | null | undefined): boolean {
    return (document?.pages ?? []).some((page) =>
        (page.items ?? []).some((item) => (item.sentences?.length ?? 0) > 0),
    );
}

/**
 * Write one page as text the model can read and cite.
 *
 * Each sentence is prefixed with its own anchor, so where one sentence ends is
 * where the next one's label begins — unambiguous without wrapping every
 * sentence in a closing tag, which would double the overhead for nothing.
 *
 * An item the splitter gave no sentences (a heading, a formula) carries its own
 * anchor instead, so nothing readable on the page is uncitable.
 */
export function renderPageWithLocators(page: PageLike): string {
    const blocks: string[] = [];

    for (const item of page.items ?? []) {
        if (FURNITURE.has(item.kind ?? '')) continue;
        const sentences = (item.sentences ?? []).filter((s) => String(s.text ?? '').trim());

        if (sentences.length === 0) {
            const text = String(item.text ?? '').trim();
            if (!text) continue;
            const id = String(item.id ?? '');
            blocks.push(id ? `[${id}] ${text}` : text);
            continue;
        }

        blocks.push(
            sentences
                .map((s) => {
                    const text = String(s.text).trim();
                    const id = String(s.id ?? '');
                    return id ? `[${id}] ${text}` : text;
                })
                .join(' '),
        );
    }

    return blocks.join('\n\n');
}

/**
 * Turn `s9`, or `s9-s11`, into the text it names.
 *
 * A range exists because the extractor's idea of a sentence and a reader's do
 * not always agree: a formula mid-sentence, or a hyphenated word across a
 * column break, can split what a person reads as one sentence into two
 * anchors. Naming both is how the model says "all of it" without going back to
 * quoting.
 *
 * Returns an empty array for anything unparseable, unknown, or spanning a page
 * — the caller reports that and the model can fall back to quoting the text. A
 * highlight is one run of boxes on one page; handing back the first page's half
 * of a cross-page range would place a highlight that silently omits the rest.
 */
export function resolveLocator(
    locator: string,
    index: Map<string, LocatedText>,
): LocatedText[] {
    const raw = String(locator ?? '').trim();
    if (!raw) return [];

    const range = /^([a-z]+)(\d+)\s*[-–—]\s*(?:[a-z]+)?(\d+)$/i.exec(raw);
    if (!range) {
        const found = index.get(raw);
        return found ? [found] : [];
    }

    const prefix = range[1].toLowerCase();
    const start = Number(range[2]);
    const end = Number(range[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    if (end - start >= MAX_LOCATOR_SPAN) return [];

    const found: LocatedText[] = [];
    for (let n = start; n <= end; n += 1) {
        const entry = index.get(`${prefix}${n}`);
        if (!entry) return [];
        found.push(entry);
    }
    if (found.some((entry) => entry.pageIndex !== found[0].pageIndex)) return [];
    return found;
}

/** The anchors nearest to a locator that does not exist, for the error message. */
export function nearbyLocators(locator: string, index: Map<string, LocatedText>): string[] {
    const match = /^([a-z]+)(\d+)/i.exec(String(locator ?? '').trim());
    if (!match) return [];
    const prefix = match[1].toLowerCase();
    const n = Number(match[2]);
    return [n - 1, n + 1, n + 2]
        .filter((candidate) => candidate >= 1 && index.has(`${prefix}${candidate}`))
        .map((candidate) => `${prefix}${candidate}`);
}
