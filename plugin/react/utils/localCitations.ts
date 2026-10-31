/**
 * Resolving the citation tags a model emits, locally.
 *
 * Beaver's server parsed `<citation …>` out of the answer, looked each one up
 * and sent back resolved `Citation` objects; the client only rendered them. With
 * no server, that middle step happens here — the grammar, the reference types
 * and the renderer are all already in the tree, so this is the one missing link
 * rather than a reimplementation.
 *
 * A tag that cannot be resolved is returned as `invalid` rather than dropped: a
 * silently discarded citation looks to the reader like an unsupported claim,
 * while an invalid one shows the model asserted a source that is not there.
 */

import { normalizeCitationTag, parseRawCitationAttributes } from '@beaver/agent-core/citations/citationGrammar';
import type { CitationRef } from '@beaver/agent-core/citations/citationGrammar';
import type { Citation } from '@beaver/agent-core/types/citations';
import { logger } from '@beaver/agent-core/platform/logger';

/** Matches one whole citation tag, self-closing or not. */
const TAG_PATTERN = /<citation\b([^>]*?)\/?>/gi;

export interface RawTag {
    raw: string;
    attrs: Record<string, string>;
}

/** Every citation tag in a block of model output, in order. */
export function extractCitationTags(text: string): RawTag[] {
    const found: RawTag[] = [];
    for (const match of text.matchAll(TAG_PATTERN)) {
        found.push({ raw: match[0], attrs: parseRawCitationAttributes(match[1] ?? '') });
    }
    return found;
}

/** The Zotero item a reference points at, if it is in this library. */
function resolveItem(ref: CitationRef): Zotero.Item | null {
    if (ref.kind !== 'zotero') return null;
    const libraryId =
        typeof ref.library_id === 'number'
            ? ref.library_id
            : Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryId, ref.zotero_key) as
        | Zotero.Item
        | false;
    return item || null;
}

/**
 * The item a citation is really about.
 *
 * A citation almost always resolves to an attachment, because that is what the
 * agent reads — but the attachment is called "Full Text PDF", and citing a paper
 * as "Full Text PDF" tells the reader nothing. The paper's identity lives on the
 * parent, so that is what gets described. A standalone attachment with no parent
 * keeps its own title, which is then the only name it has.
 */
function citedItem(item: Zotero.Item): Zotero.Item {
    try {
        if (!item.isAttachment() && !item.isNote()) return item;
        const parent = item.parentItem;
        return parent && parent.isRegularItem() ? parent : item;
    } catch {
        return item;
    }
}

/** Author-year for a regular item, title for anything else. */
function displayName(item: Zotero.Item): string {
    try {
        if (item.isAttachment() || item.isNote()) {
            return item.getDisplayTitle?.() || item.getField('title') || '(untitled)';
        }
        const creators = item.getCreators();
        const year = String(item.getField('date') || '').match(/\d{4}/)?.[0];
        const first = creators[0]?.lastName;
        if (first) {
            const etAl = creators.length > 2 ? ' et al.' : creators.length === 2 ? ` & ${creators[1]?.lastName ?? ''}` : '';
            return `${first}${etAl}${year ? `, ${year}` : ''}`;
        }
        return item.getField('title') || '(untitled)';
    } catch {
        return '(untitled)';
    }
}

/**
 * What kind of document the citation points at.
 *
 * The renderer keys a lot off this — whether a page locator is meaningful,
 * whether clicking opens a reader, which icon the hover card shows. Left unset,
 * every citation fell to the generic branch and the card offered to reveal the
 * item in the library while the click actually opened the PDF.
 */
function contentKindOf(item: Zotero.Item): 'pdf' | 'epub' | 'snapshot' | undefined {
    try {
        if (!item.isAttachment()) return undefined;
        const type = item.attachmentContentType;
        if (type === 'application/pdf') return 'pdf';
        if (type === 'application/epub+zip') return 'epub';
        if (type === 'text/html') return 'snapshot';
        return undefined;
    } catch {
        return undefined;
    }
}

/** Pages named by a locator, as the renderer wants them. */
function pagesFromRef(ref: CitationRef): number[] | undefined {
    if (ref.loc?.kind !== 'page') return undefined;
    return parsePages(String(ref.loc.value));
}

/**
 * The tag's own `page` attribute, kept alongside a sentence locator.
 *
 * Normalisation keeps one locator per tag, and `loc="s12"` wins over `page`.
 * The page is still true, and the renderer wants it: the hover card's "Page 7",
 * the with-locator styling, and the jump when the cached extraction has
 * nothing to say about the sentence. Dropping it made a sentence citation
 * *less* navigable than a page citation, the opposite of what it is for.
 */
function pagesFromAttr(page: unknown): number[] | undefined {
    if (typeof page !== 'string' && typeof page !== 'number') return undefined;
    return parsePages(String(page));
}

function parsePages(value: string): number[] | undefined {
    const pages = value
        .split(/[,\s]+/)
        .flatMap((part) => {
            const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
            if (range) {
                const from = Number(range[1]);
                const to = Number(range[2]);
                // A reversed or absurd range is a model slip, not a page list.
                if (to < from || to - from > 50) return [from];
                return Array.from({ length: to - from + 1 }, (_, i) => from + i);
            }
            const single = Number(part);
            return Number.isFinite(single) && single > 0 ? [single] : [];
        });
    return pages.length > 0 ? pages : undefined;
}

/**
 * What a searched-up work is called, from what the search returned.
 *
 * An external citation has no local item behind it, so the tag is all the
 * renderer gets — and the model does not write the title into the tag. Left as
 * it was, every citation to a paper found on the web produced a numbered
 * source row with nothing in it: no title, no authors, nothing to click. The
 * search results are already cached by id, so the name is a lookup away.
 */
export interface ExternalCitationSummary {
    display_name?: string;
    formatted_citation?: string;
}

function summarizeExternal(
    ref: { external_id: string },
    lookup?: (externalId: string) => ExternalCitationSummary | undefined,
): ExternalCitationSummary {
    try {
        return lookup?.(ref.external_id) ?? {};
    } catch {
        return {};
    }
}

/**
 * Resolve one tag into a citation.
 *
 * `formatCitation` is the plugin's own CSL formatter, running on Zotero's
 * engine — the bibliographic string matches what Zotero itself would produce
 * for the user's chosen style. `lookupExternal` does the same job for a work
 * that is not in the library, out of the literature-search cache.
 */
export function resolveCitationTag(
    tag: RawTag,
    index: number,
    formatCitation?: (item: Zotero.Item) => string,
    lookupExternal?: (externalId: string) => ExternalCitationSummary | undefined,
): Citation {
    const citation_id = `local-${index}-${tag.attrs.id ?? tag.attrs.item_id ?? 'x'}`;
    const normalized = normalizeCitationTag(tag.attrs);

    if (!normalized.ok) {
        return {
            citation_id,
            raw_tag: tag.raw,
            invalid: true,
            invalid_reason: normalized.reason,
        };
    }

    const ref = normalized.ref;
    const base: Citation = {
        citation_id,
        raw_tag: tag.raw,
        requested_ref: ref,
        ...((() => {
            const pages = pagesFromRef(ref) ?? pagesFromAttr(tag.attrs.page);
            return pages ? { pages } : {};
        })()),
        // The locator rides along: activation resolves a sentence locator to
        // its boxes from the cached extraction when nothing else carried them.
        ...(tag.attrs.loc ? { loc: String(tag.attrs.loc) } : tag.attrs.sid ? { loc: String(tag.attrs.sid) } : {}),
    };

    // An external result (OpenAlex) has no local item to resolve against, so
    // its name comes from the search that found it.
    if (ref.kind === 'external') {
        const summary = summarizeExternal(ref, lookupExternal);
        return {
            ...base,
            resolved_ref: ref,
            citation_type: 'external' as any,
            ...(tag.attrs.title
                ? { display_name: tag.attrs.title }
                : summary.display_name
                  ? { display_name: summary.display_name }
                  : {}),
            ...(summary.formatted_citation
                ? { formatted_citation: summary.formatted_citation }
                : {}),
        };
    }

    if (ref.kind !== 'zotero') {
        return {
            ...base,
            resolved_ref: ref,
            citation_type: 'external' as any,
            ...(tag.attrs.title ? { display_name: tag.attrs.title } : {}),
        };
    }

    const item = resolveItem(ref);
    if (!item) {
        return {
            ...base,
            invalid: true,
            invalid_reason: 'not_found',
        };
    }

    // The bibliographic line describes the paper, not the file inside it.
    const described = citedItem(item);

    let formatted: string | undefined;
    try {
        formatted = formatCitation?.(described);
    } catch (error) {
        // A formatting failure costs the bibliographic line, not the citation.
        logger(`resolveCitationTag: formatting failed: ${error}`, 1);
    }

    const contentKind = contentKindOf(item);
    return {
        ...base,
        resolved_ref: ref,
        citation_type: item.isAttachment() ? ('attachment' as any) : ('item' as any),
        display_name: displayName(described),
        ...(formatted ? { formatted_citation: formatted } : {}),
        ...(contentKind ? { content_kind: contentKind as any } : {}),
        item_type: described.itemType,
    };
}

/**
 * What is known about the passage behind a citation, keyed `id:page`.
 *
 * A citation tag names an attachment and a page and nothing more, which is all
 * a page-level citation needs — but it makes the hover card show a
 * bibliographic line the reader already knows, and the click open the paper at
 * a page they then have to search. Where the run *does* know the passage — it
 * placed a highlight on it, so it has both the sentence and its rects — that
 * turns into a sentence-level citation: the sentence in the card, and the
 * passage highlighted when the marker is clicked.
 */
export interface CitationEvidence {
    text: string;
    /** `[l, t, r, b]` quads in the extraction's top-left page frame. */
    boxes?: number[][];
    /** 1-based page the passage is on, for a tag that left its page out. */
    page?: number;
}

/**
 * Evidence for a citation that names its sentence: `loc="s12"` on attachment
 * `id`. Answered from what the run was shown (see `passageForLocator`), so the
 * hover card shows the sentence the model read rather than the page number.
 */
export type LocatorEvidence = (attachmentId: string, loc: string) => CitationEvidence | undefined;

export const evidenceKey = (id: string, page: number | undefined) =>
    `${id}:${page ?? ''}`;

/** Attach the passage and its rects to a citation that has them. */
function withEvidence(citation: Citation, evidence: CitationEvidence | undefined): Citation {
    if (!evidence || citation.invalid) return citation;
    const pages = citation.pages ?? (evidence.page ? [evidence.page] : undefined);
    const pageIndex = (pages?.[0] ?? 0) - 1;
    return {
        ...citation,
        ...(pages && !citation.pages ? { pages } : {}),
        preview: evidence.text,
        ...(evidence.boxes && evidence.boxes.length > 0 && pageIndex >= 0
            ? {
                locations: [{
                    // No part ids locally — the passage is identified by where
                    // it is, which is all the reader needs to draw it.
                    part_id: `local-${pageIndex}`,
                    page_idx: pageIndex,
                    boxes: evidence.boxes,
                    text: evidence.text,
                }],
            }
            : {}),
    };
}

/** Resolve every citation tag in an answer. */
export function resolveCitationsInText(
    text: string,
    formatCitation?: (item: Zotero.Item) => string,
    lookupExternal?: (externalId: string) => ExternalCitationSummary | undefined,
    evidence?: Map<string, CitationEvidence>,
    locatorEvidence?: LocatorEvidence,
): Citation[] {
    const tags = extractCitationTags(text);
    const seen = new Set<string>();
    const citations: Citation[] = [];
    tags.forEach((tag, index) => {
        // The same source cited twice is one entry in the sources list; the
        // inline markers both point at it.
        const dedupeKey = tag.raw;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        const resolved = resolveCitationTag(tag, index, formatCitation, lookupExternal);
        const id = String(tag.attrs.id ?? tag.attrs.item_id ?? '');
        /*
         * The sentence a `loc` names comes first. A highlight on page 7 knows
         * one passage of page 7; a second citation to that page with its own
         * `loc` means a different sentence, and showing the highlight's text
         * under it would put the wrong words on the card.
         */
        const loc = String(tag.attrs.loc ?? tag.attrs.sid ?? '').trim();
        const fromLocator = loc && locatorEvidence ? locatorEvidence(id, loc) : undefined;
        const fromPage = evidence?.get(evidenceKey(id, resolved.pages?.[0]));
        citations.push(withEvidence(resolved, fromLocator ?? fromPage));
    });
    return citations;
}
