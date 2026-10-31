/**
 * Turning a citation's locator into the words a reader sees.
 *
 * Extracted from `useCitationViewModel` so the sources list can state the same
 * location the inline marker does. It had the paper's name and not the place in
 * it, which is the half a reader actually needs to go and check the claim.
 *
 * Pure, and deliberately not a hook: the sources list renders one of these per
 * row, and a hook cannot be called in a loop. The one piece of host data it
 * needs — page labels a PDF carries in its own metadata — is passed in by the
 * caller, which subscribes to it once.
 */

import {
    getCitationPages,
    getContentKind,
    isExternalFileCitation,
    type Citation,
} from '@beaver/agent-core/types/citations';
import { getResolvedRef } from '@beaver/agent-core/citations/citationGrammar';

import { getHost } from '../host';
import { explicitPageLabel } from './locationDisplay';
import { resolvePageLabelFromLabels } from './pageLabels';
import { formatNumberRanges, formatPageRangesWithLabels } from './pageRanges';

export interface CitationLocationOptions {
    /**
     * Page labels preloaded per attachment, from `pageLabelsByAttachmentIdAtom`.
     * Only consulted when the citation itself carries none.
     */
    pageLabelsByAttachmentId?: Record<string, Record<number, string>> | null;
    /**
     * Whether to show the labels a document prints on its own pages (`iv`, `S3`)
     * rather than the sequential index. Follows the same preference the inline
     * marker reads.
     */
    usePageLabels?: boolean;
}

/**
 * The cited location, as a bare display string — `"3"`, `"2–4"`, `"iv, S3"`.
 *
 * Empty when there is nothing truthful to say: a citation with no locator, or a
 * snapshot, whose synthetic page numbers are a logical coordinate in a
 * continuously scrolling view and would read as a page that does not exist.
 */
export function citationLocationDisplay(
    citation: Citation,
    options: CitationLocationOptions = {},
): string {
    const { pageLabelsByAttachmentId = null, usePageLabels = true } = options;

    const pages = isExternalFileCitation(citation) ? [] : getCitationPages(citation);
    if (pages.length === 0) return '';

    const contentKind = getContentKind(citation);
    if (contentKind === 'snapshot') return '';

    if (contentKind === 'epub') {
        // An EPUB has no page numbers of its own, so a citation is only
        // locatable where the backend supplied a label for it.
        const labels = (citation as any).page_labels;
        const labelled = pages.filter((page) => explicitPageLabel(labels, page));
        if (labelled.length === 0) return '';
        return formatPageRangesWithLabels(
            labelled,
            labelled.map((page) => explicitPageLabel(labels, page)),
        );
    }

    if (!usePageLabels) return formatNumberRanges(pages);

    let labels = pages.map((page) => String(page));
    const backendLabels = (citation as any).page_labels;
    if (backendLabels && Object.keys(backendLabels).length > 0) {
        labels = pages.map((page) => resolvePageLabelFromLabels(backendLabels, page));
    } else {
        const resolvedRef = getResolvedRef(citation);
        if (resolvedRef) {
            const hostLabels =
                getHost().itemData?.resolvePageLabels(
                    resolvedRef as any,
                    pageLabelsByAttachmentId as any,
                ) ?? null;
            if (hostLabels) {
                labels = pages.map((page) => resolvePageLabelFromLabels(hostLabels, page));
            }
        }
    }

    return formatPageRangesWithLabels(pages, labels);
}
