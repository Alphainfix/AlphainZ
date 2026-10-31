import { store } from '../../store';
import { pageLabelsByAttachmentIdAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import {
    isExternalReferenceDetailsDialogVisibleAtom,
    selectedExternalReferenceAtom,
} from '../../atoms/ui';
import {
    getCitationPages,
    getCitationBoundingBoxes,
    getContentKind,
    getSymbolicLocation,
} from '@beaver/agent-core/types/citations';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { revealSource } from '../../utils/sourceUtils';
import { createZoteroURI } from '../../utils/zoteroURI';
import { getCurrentReaderAndWaitForView } from '../../utils/readerUtils';
import {
    BeaverTemporaryAnnotations,
    createBoundingBoxHighlights,
} from '../../utils/annotationUtils';
import {
    flashHighlightBoundingBoxes,
    presentTemporaryAnnotations,
} from '../../utils/citationNavigation';
import { navigateToEpubCitation } from '../../utils/epubVisualizer/epubCitationNavigation';
import { navigateToSnapshotCitation } from '../../utils/snapshotVisualizer/snapshotCitationNavigation';
import { resolvePageLabelFromLabels } from '@beaver/agent-ui/utils/pageLabels';
import { getPageLabelsForItem } from './itemData';
import { parseLoc } from '@beaver/agent-core/citations/citationGrammar';
import { CoordOrigin } from '@beaver/agent-core/types/citations';
import { resolveCitation } from '../../../src/beaver-extract/schema/citationIndex';
import { launchExternalFile, notifyReferenceUnavailable } from './sourceActions';
import { getPref } from '../../../src/utils/prefs';
import { logger } from '@beaver/agent-core/platform/logger';
import { selectItemById } from '../../../src/utils/selectItem';
import {
    getBestPDFAttachmentAsync,
    getBestReadableTextAttachmentAsync,
} from '../../../src/utils/zoteroItemHelpers';
import { BEAVER_CITATION_ANNOTATION_AUTHOR } from '../../../src/constants/annotations';
import { libraryRefForLibraryID, resolveItemReference } from '../../../src/utils/libraryIdentity';
import type { CitationActivation } from '@beaver/agent-ui/host/types';

/** Reveal the cited item in the library view. */
function revealInLibrary(libraryID: number, zoteroKey: string): void {
    revealSource({
        library_id: libraryID,
        zotero_key: zoteroKey,
        library_ref: libraryRefForLibraryID(libraryID) ?? undefined,
    } as ZoteroItemReference);
}

/**
 * Zotero implementation of citation activation: navigate to / open the cited
 * location. Mirrors the citation click behavior across all content kinds (note,
 * annotation, text, EPUB, PDF) and reference types (external, external file).
 */
export async function activateCitation(activation: CitationActivation): Promise<void> {
    const {
        metadata,
        isExternal,
        isExternalFile,
        externalFileKey,
        externalSourceId,
        hasMappedItem,
        effectiveLibraryID,
        effectiveItemKey,
        effectiveLibraryRef,
        previewText,
        ownerDocument,
    } = activation;

    const useTemporaryCitationAnnotations = getPref('useTemporaryCitationAnnotations') === true;
    logger('Citation activation: handle citation click');

    // External citations without Zotero mapping - open details dialog
    if (isExternal && !hasMappedItem) {
        logger('Citation activation: External citation - opening details dialog');
        if (externalSourceId) {
            const externalReference = store.get(externalReferenceMappingAtom)[externalSourceId];
            if (externalReference) {
                store.set(selectedExternalReferenceAtom, externalReference);
                store.set(isExternalReferenceDetailsDialogVisibleAtom, true);
            }
        }
        return;
    }

    // External-file citations: open the locally stored copy. There is no
    // reader navigation for external files, so page/sentence clicks just
    // launch the file; a missing local copy (file attached on another
    // computer) is a quiet no-op.
    if (isExternalFile) {
        logger(`Citation activation: External file citation (ext-${externalFileKey})`);
        if (!externalFileKey) return;
        await launchExternalFile(externalFileKey);
        return;
    }

    // Cleanup any existing temporary annotations
    await BeaverTemporaryAnnotations.cleanupAll();

    if ((!effectiveLibraryID && !effectiveLibraryRef) || !effectiveItemKey) {
        logger('Citation activation: No valid item reference');
        return;
    }

    logger(`Citation activation: Zotero Item (${effectiveLibraryRef || effectiveLibraryID}, ${effectiveItemKey})`);
    const resolved = await resolveItemReference({
        library_ref: effectiveLibraryRef,
        library_id: effectiveLibraryID,
        zotero_key: effectiveItemKey,
    });

    if (resolved.status !== 'found') {
        logger(`Citation activation: Failed to get Zotero item (${effectiveLibraryRef || effectiveLibraryID}, ${effectiveItemKey})`);
        notifyReferenceUnavailable('item', resolved.status === 'library_unavailable' ? 'library_unavailable' : 'missing');
        return;
    }
    const item = resolved.item;

    await item.loadAllData();

    const contentKind = getContentKind(metadata);
    const symbolicLocation = getSymbolicLocation(metadata);

    // Handle note links using Zotero.Notes.open()
    if (item.isNote()) {
        logger(`Citation activation: Note Link (${item.id})`);
        if (typeof Zotero.Notes?.open === 'function') {
            await Zotero.Notes.open(item.id, undefined);
        } else {
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
        }
        return;
    }

    // Handle annotation citations: open the parent attachment in the
    // reader and navigate via annotationID
    if (item.isAnnotation()) {
        const parentAttachment = item.parentItem;
        if (!parentAttachment || !parentAttachment.isAttachment()) {
            logger(`Citation activation: Annotation ${item.id} has no parent attachment`);
            return;
        }
        try {
            let reader = await getCurrentReaderAndWaitForView(undefined, true);
            if (!reader || reader.itemID !== parentAttachment.id) {
                reader = await Zotero.Reader.open(parentAttachment.id);
                await new Promise((resolve) => setTimeout(resolve, 300));
                reader = await getCurrentReaderAndWaitForView(undefined, true);
            }
            if (reader) {
                setTimeout(() => {
                    reader.navigate({ annotationID: item.key });
                }, 100);
            }
        } catch (error) {
            logger('Citation activation: Failed to open annotation: ' + error);
        }
        return;
    }

    if (contentKind === 'text') {
        // Resolved text citations should normally point at the attachment;
        // this keeps older or incomplete regular-item metadata navigable.
        const target = item.isAttachment()
            ? item
            : await getBestReadableTextAttachmentAsync(item);
        if (!target) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }
        const filePath = await target.getFilePathAsync();
        if (filePath) {
            if (symbolicLocation?.content_kind === 'text') {
                const lineEnd = symbolicLocation.line_end ?? symbolicLocation.line;
                logger(
                    `Citation activation: Opening text file at lines ${symbolicLocation.line}-${lineEnd}: ${filePath}`,
                );
            } else {
                logger(`Citation activation: Opening text file: ${filePath}`);
            }
            Zotero.launchFile(filePath);
        } else {
            await selectItemById(target.id);
        }
        return;
    }

    if (contentKind === 'epub') {
        // EPUB locator model: agent-facing "page N" is the 1-based spine
        // section ordinal; the symbolic location (when present) carries the
        // precise section href / anchor / sentence text.
        const epubSymbolicLocation = symbolicLocation?.content_kind === 'epub'
            ? symbolicLocation
            : undefined;
        const sectionOrdinals = getCitationPages(metadata);
        const hasEpubLocator = !!epubSymbolicLocation || sectionOrdinals.length > 0;
        logger(`Citation activation: EPUB citation (symbolic: ${!!epubSymbolicLocation}, sections: ${sectionOrdinals.length})`);

        if (item.isRegularItem() && !hasEpubLocator) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }

        const outcome = await navigateToEpubCitation({
            item,
            symbolicLocation: epubSymbolicLocation,
            sectionOrdinal: sectionOrdinals[0],
            searchText: metadata?.preview || undefined,
            previewText,
            useTemporaryAnnotations: useTemporaryCitationAnnotations,
            ownerDocument,
        });
        logger(`Citation activation: EPUB navigation outcome: ${outcome}`);
        if (outcome === 'failed') {
            revealInLibrary(item.libraryID, item.key);
        }
        return;
    }

    if (contentKind === 'snapshot') {
        // Snapshot locator model: the symbolic location carries the cited
        // selector / anchor / passage text. There is no section/page navigation
        // (the reader is a continuous scroll view), so a regular item with no
        // symbolic locator just reveals in the library.
        const snapshotSymbolicLocation = symbolicLocation?.content_kind === 'snapshot'
            ? symbolicLocation
            : undefined;
        const hasSnapshotLocator = !!snapshotSymbolicLocation || !!(metadata?.preview);
        logger(`Citation activation: snapshot citation (symbolic: ${!!snapshotSymbolicLocation})`);

        if (item.isRegularItem() && !hasSnapshotLocator) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }

        const outcome = await navigateToSnapshotCitation({
            item,
            symbolicLocation: snapshotSymbolicLocation,
            searchText: metadata?.preview || undefined,
            previewText,
            useTemporaryAnnotations: useTemporaryCitationAnnotations,
            ownerDocument,
        });
        logger(`Citation activation: snapshot navigation outcome: ${outcome}`);
        if (outcome === 'failed') {
            revealInLibrary(item.libraryID, item.key);
        }
        return;
    }

    if (contentKind !== 'pdf') {
        logger(`Citation activation: Non-PDF citation (${contentKind})`);
        if (item.isRegularItem()) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }
        if (item.isAttachment()) {
            try {
                await Zotero.Reader.open(item.id);
            } catch (error) {
                logger(`Citation activation: Failed to open non-PDF attachment: ${error}`);
                await selectItemById(item.id);
            }
            return;
        }
        revealInLibrary(item.libraryID, item.key);
        return;
    }

    // Get locator data before regular-item handling. Some citations are
    // resolved to parent items even though the raw tag includes page
    // locators; those should navigate to the item's PDF attachment.
    let boundingBoxData = getCitationBoundingBoxes(metadata);
    let pages = getCitationPages(metadata);
    // A sentence locator counts too: it names a position even when nothing
    // resolved boxes for it yet — the cached extraction below can.
    // Runs published before the resolver carried `loc` still have the raw
    // tag; the locator is recoverable from there.
    const rawLoc = (metadata as any).loc
        ?? (typeof (metadata as any).raw_tag === 'string'
            ? (metadata as any).raw_tag.match(/\b(?:loc|sid)="([^"]+)"/)?.[1]
            : undefined);
    const sentenceRange = parseSentenceRange(rawLoc);
    const hasPdfLocator = boundingBoxData.length > 0 || pages.length > 0 || !!sentenceRange;
    let pdfItem = item;

    // Handle regular items
    if (item.isRegularItem()) {
        if (hasPdfLocator) {
            const attachment = await getBestPDFAttachmentAsync(item);
            const isPdfAttachment = !!attachment && (
                attachment.isPDFAttachment?.() ||
                attachment.attachmentContentType === 'application/pdf'
            );
            if (isPdfAttachment) {
                logger(`Citation activation: Regular item locator resolved to PDF attachment (${attachment.id})`);
                pdfItem = attachment;
            } else {
                logger(`Citation activation: Regular item has locator but no PDF attachment (${item.id})`);
                revealInLibrary(item.libraryID, item.key);
                return;
            }
        } else {
            logger(`Citation activation: Selecting regular item (${item.id})`);
            revealInLibrary(item.libraryID, item.key);
            return;
        }
    }

    // Handle file links (computed lazily: rendering never needs the URI)
    const itemUri = createZoteroURI(item);
    if (itemUri.startsWith('file:///')) {
        const filePath = itemUri.replace('file:///', '');
        logger(`Citation activation: File Link (${filePath})`);
        Zotero.launchFile(filePath);
        return;
    }

    /*
     * A citation carrying only a sentence locator arrives with no boxes and no
     * pages — the publish-time resolver attaches boxes only from highlight
     * evidence. The cached extraction knows exactly where each sentence sits,
     * so look the range up here (cache-only, never a fresh extraction: a click
     * must not start a thirty-second job). Failure just falls through to the
     * reveal below.
     */
    if (sentenceRange && boundingBoxData.length === 0 && pdfItem.isAttachment()) {
        try {
            const resolved = await sentenceRangeBoundingBoxes(pdfItem, sentenceRange);
            if (resolved.boxes.length > 0) {
                boundingBoxData = resolved.boxes;
                logger(`Citation activation: sentence locator resolved to ${resolved.boxes.length} page(s) of boxes`);
            } else if (resolved.pages.length > 0 && pages.length === 0) {
                pages = resolved.pages;
                logger(`Citation activation: sentence locator resolved to page ${resolved.pages[0]} (no boxes)`);
            }
        } catch (error) {
            logger(`Citation activation: sentence locator lookup failed: ${error}`, 1);
        }
    }

    logger(`Citation activation: Citation Location (boundingBoxData.length: ${boundingBoxData.length}, pages.length: ${pages.length})`);

    if (pdfItem.isAttachment() && boundingBoxData.length == 0 && pages.length == 0) {
        logger(`Citation activation: Selecting attachment (${pdfItem.id})`);
        await selectItemById(pdfItem.id);
        return;
    }

    try {
        let reader = await getCurrentReaderAndWaitForView(undefined, true);
        logger(`Citation activation: Current Reader (${reader?.itemID})`);

        // Check if we need to open or switch to the correct PDF
        if (!reader || reader.itemID !== pdfItem.id) {
            logger(`Citation activation: Opening PDF in reader or switching to the correct PDF`);

            // Determine the page to open
            let pageIndex = 1;
            if (boundingBoxData.length > 0) {
                pageIndex = boundingBoxData[0].page;
            } else if (pages.length > 0) {
                pageIndex = pages[0];
            }

            // Open the PDF at page
            logger(`Citation activation: Opening item ${pdfItem.id} at page ${pageIndex}`);
            reader = await Zotero.Reader.open(pdfItem.id, { pageIndex: pageIndex - 1 });

            // Wait for reader to initialize (should already be done by getCurrentReaderAndWaitForView)
            await new Promise(resolve => setTimeout(resolve, 300));
            reader = await getCurrentReaderAndWaitForView(undefined, true);
        }

        // Handle the three scenarios
        if (boundingBoxData.length > 0) {
            const loadedPageLabels = getPageLabelsForItem(pdfItem, store.get(pageLabelsByAttachmentIdAtom));
            const highlightLocations = boundingBoxData.map(({ page, bboxes, pageLabel }) => ({
                pageIndex: page - 1,
                boxes: bboxes,
                pageLabel: pageLabel ?? resolvePageLabelFromLabels(loadedPageLabels, page),
            }));

            if (useTemporaryCitationAnnotations) {
                logger(`Citation activation: Highlighting bounding boxes with temporary annotations`);
                const annotationReferences = await createBoundingBoxHighlights(
                    highlightLocations,
                    previewText,
                    BEAVER_CITATION_ANNOTATION_AUTHOR,
                    { authorName: BEAVER_CITATION_ANNOTATION_AUTHOR },
                );
                if (reader) {
                    presentTemporaryAnnotations(reader, annotationReferences, {
                        ownerDocument,
                        logContext: 'CitationActivation',
                    });
                } else {
                    // Keep created annotations tracked for cleanup even
                    // when the reader handle is unavailable.
                    BeaverTemporaryAnnotations.addToTracking(annotationReferences);
                }
            } else {
                logger(`Citation activation: Flashing highlight for bounding boxes`);
                if (reader) {
                    await flashHighlightBoundingBoxes(reader, highlightLocations);
                }
            }
        } else if (pages.length > 0) {
            logger(`Citation activation: Navigating to page ${pages[0]}`);
            // Scenario 2: With pages only - navigate to page
            if (reader) {
                reader.navigate({ pageIndex: pages[0] - 1 });
            }
        }
        // Scenario 3: No locators - PDF is already open, nothing more needed

    } catch (error) {
        logger('Citation activation: Failed to handle citation click: ' + error);

        // Fallback: try the URI-based approach from the loaded item
        try {
            const fallbackUri = createZoteroURI(item);
            if (fallbackUri.includes('zotero://')) {
                Zotero.getMainWindow().location.href = fallbackUri;
            }
        } catch {
            // No usable fallback URI; nothing else to do.
        }
    }
}

/** A parsed sentence-locator range, inclusive. */
interface SentenceRange { start: number; end: number }

/** Parse a citation's raw `loc` token into a sentence range, if it is one. */
function parseSentenceRange(loc: unknown): SentenceRange | null {
    if (typeof loc !== 'string' || !loc) return null;
    const parsed = parseLoc(loc);
    if (!parsed || parsed.kind !== 'sentence') return null;
    const [left, right] = String(parsed.value).split('-');
    const start = Number.parseInt(left, 10);
    const end = right ? Number.parseInt(right, 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** Never expand a range into more sentences than a passage can plausibly be. */
const MAX_SENTENCES_PER_RANGE = 100;

/**
 * Where a sentence range sits in the PDF, from the cached extraction only.
 *
 * Returns per-page bounding boxes in the extraction's top-left frame (the
 * same frame highlight evidence uses), plus the pages alone as a coarser
 * fallback. An attachment with no cached extraction returns empty — the
 * caller degrades to a reveal rather than kicking off an extraction.
 */
async function sentenceRangeBoundingBoxes(
    attachment: Zotero.Item,
    range: SentenceRange,
): Promise<{ boxes: ReturnType<typeof getCitationBoundingBoxes>; pages: number[] }> {
    const empty = { boxes: [] as ReturnType<typeof getCitationBoundingBoxes>, pages: [] as number[] };
    const cache = (Zotero as any).AlphainZ?.documentCache;
    if (!cache?.getResult) {
        logger('Citation activation: sentence locator skipped — no document cache handle', 1);
        return empty;
    }
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        logger(`Citation activation: sentence locator skipped — no local file for ${attachment.key}`, 1);
        return empty;
    }
    const result = await cache.getResult(
        { libraryId: attachment.libraryID, zoteroKey: attachment.key },
        'structured',
        filePath,
    );
    if (!result || result.mode !== 'structured' || !result.document) {
        logger(`Citation activation: sentence locator skipped — no cached structured extraction for ${attachment.key}`, 1);
        return empty;
    }

    const byPage = new Map<number, { bboxes: Array<{ l: number; t: number; r: number; b: number; coord_origin: CoordOrigin }>; label: string | null }>();
    const pagesSeen = new Set<number>();
    const end = Math.min(range.end, range.start + MAX_SENTENCES_PER_RANGE - 1);
    for (let n = range.start; n <= end; n += 1) {
        const hit = resolveCitation(result.document, `s${n}`);
        if (!hit) continue;
        const page = hit.pageIndex + 1;
        pagesSeen.add(page);
        const rects = hit.sentence?.bboxes ?? [];
        if (rects.length === 0) continue;
        const bucket = byPage.get(page) ?? { bboxes: [], label: hit.pageLabel ?? null };
        for (const [l, t, r, b] of rects) {
            // Extraction rects live in the top-left page frame, like highlight
            // evidence; getCitationBoundingBoxes treats missing 'b' origins as
            // top-left, so this stays consistent end to end.
            bucket.bboxes.push({ l, t, r, b, coord_origin: CoordOrigin.TOPLEFT });
        }
        byPage.set(page, bucket);
    }

    const boxes = [...byPage.entries()]
        .sort(([a], [b]) => a - b)
        .map(([page, bucket]) => ({ page, bboxes: bucket.bboxes as any, pageLabel: bucket.label }));
    return { boxes: boxes as any, pages: [...pagesSeen].sort((a, b) => a - b) };
}
