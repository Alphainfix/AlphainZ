import { TextSelection } from '@beaver/agent-core/types/attachments/apiTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import { ZoteroReader } from './annotationUtils';
import { waitForPDFDocument } from './pdfUtils';
import { readReaderSelection, type ReaderSelectionSnapshot } from '../../src/modules/readerIntegration';

/**
 * A passage staged from the reader, with what this client needs to find it
 * again. The extra fields stay here: only `TextSelection`'s own fields are
 * sent with a message (see `getReaderState`).
 */
export interface ReaderTextSelection extends TextSelection {
    /**
     * Where the passage is, as the reader describes it — what
     * `reader.navigate({ position })` scrolls back to. For a PDF this is the
     * page and rectangles; for an EPUB or snapshot a selector, the only
     * location those views understand.
     */
    position?: Record<string, any>;
    /**
     * Set when the passage is an existing highlight the user chose to chat
     * about, rather than text selected in the reader. No selection stands
     * behind it, so the reader's selection coming and going says nothing about
     * whether it is still wanted.
     */
    highlight?: { libraryID: number; key: string; attachmentID: number };
}

/** The highlight a staged passage is, when it is one (see `ReaderTextSelection.highlight`). */
function highlightOfSelection(
    selection: TextSelection | null | undefined,
): ReaderTextSelection['highlight'] | null {
    return (selection as ReaderTextSelection | null | undefined)?.highlight ?? null;
}

/** Whether a staged passage is a highlight on this attachment. */
function isHighlightSelectionOn(selection: TextSelection | null | undefined, attachmentID: number): boolean {
    return highlightOfSelection(selection)?.attachmentID === attachmentID;
}

function isPageIndex(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}


/**
 * Retrieves the current reader instance.
 * 
 * @returns The current reader instance or undefined if no reader is found.
 */
function getCurrentReader(window?: Window): any | undefined {
    window = window || Zotero.getMainWindow();
    const reader = Zotero.Reader.getByTabID(window.Zotero_Tabs.selectedID);
    return reader;
}

/**
 * Retrieves the current reader instance and waits for the view to be initialized.
 * 
 * @param window - The window to get the reader from.
 * @param waitForPDF - If true, also waits for the PDF document to be loaded (default: false for backwards compatibility)
 * @returns The current reader instance or undefined if no reader is found.
 */
async function getCurrentReaderAndWaitForView(window?: Window, waitForPDF: boolean = false): Promise<any | undefined> {
    // Get reader
    const reader = getCurrentReader(window)
    if (!reader) return undefined;

    await waitForReaderView(reader, waitForPDF);
    return reader;
}

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a reader instance and its primary view to be ready for navigation.
 */
async function waitForReaderView(reader: any, waitForPDF: boolean = false): Promise<void> {
    await reader?._initPromise;
    await reader?._internalReader?._primaryView?.initializedPromise;

    if (waitForPDF && reader?.type === 'pdf') {
        const pdfLoaded = await waitForPDFDocument(reader, 3000);
        if (!pdfLoaded) {
            logger(`waitForReaderView: PDF document failed to load within timeout`, 1);
        }
    }
}

/**
 * Waits for Zotero.Reader.open() to produce or select a reader for an item.
 */
async function waitForReaderForItem(itemID: number, openedReader?: any, timeoutMs: number = 5000): Promise<any | undefined> {
    if (openedReader?.itemID === itemID) {
        await waitForReaderView(openedReader, true);
        return openedReader;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const reader = getCurrentReader();
        if (reader?.itemID === itemID) {
            await waitForReaderView(reader, true);
            return reader;
        }
        await delay(100);
    }

    return undefined;
}

/**
 * Navigates to a page in the reader.
 * 
 * @param itemID - The item ID.
 * @param page - The page number to navigate to.
 */
async function navigateToPage(itemID: number, page: number): Promise<void | _ZoteroTypes.ReaderInstance> {
    const pageIndex = page - 1;
    const openedReader = await Zotero.Reader.open(itemID, {pageIndex})
    const reader = await waitForReaderForItem(itemID, openedReader);
    if (reader) {
        await reader.navigate?.({ pageIndex });
    }
    return reader;
}

async function navigateToPageInCurrentReader(page: number) {
    const reader = getCurrentReader();
    if (!reader) return;
    reader.navigate({pageIndex: page - 1})
}

/**
 * The reader location of a staged passage, in a form `reader.navigate` takes.
 *
 * Its own position when it has one. Otherwise, for a PDF only, its page: an
 * EPUB view reads `pageIndex` as an index into its own page mapping and a
 * snapshot ignores it, so a page number sent there jumps to the start of the
 * book or does nothing. Null when there is nowhere to go.
 */
function textSelectionLocation(
    selection: TextSelection,
    readerType: string | undefined,
): Record<string, any> | null {
    const position = (selection as ReaderTextSelection).position;
    if (position && typeof position === 'object') return { position };
    if (readerType !== 'pdf') return null;
    if (isPageIndex(selection.page_index)) return { pageIndex: selection.page_index };
    if (typeof selection.page === 'number' && Number.isInteger(selection.page) && selection.page >= 1) {
        return { pageIndex: selection.page - 1 };
    }
    return null;
}

/**
 * Scroll the open reader back to a staged passage. Returns whether it could.
 */
function revealTextSelectionInCurrentReader(selection: TextSelection): boolean {
    const reader = getCurrentReader();
    if (!reader) return false;
    const location = textSelectionLocation(selection, reader.type);
    if (!location) return false;
    const failed = (error: unknown) => logger(`revealTextSelectionInCurrentReader: ${error}`, 1);
    try {
        void Promise.resolve(reader.navigate(location)).catch(failed);
        return true;
    } catch (error) {
        failed(error);
        return false;
    }
}

/**
 * Navigates to an annotation in the current reader.
 * 
 * @param annotation - The annotation to navigate to.
 * @param reader - The reader instance.
 */
async function navigateToAnnotation(annotationItem: Zotero.Item) {
    if (!annotationItem.isAnnotation()) return;
    const parentID = annotationItem.parentID;
    if (!parentID) return;

    // Match the native library double-click (FileHandlers.open → Reader.open
    // with the annotation as the location): one Reader.open call selects the
    // annotation and covers every case — reader closed, on another tab, or
    // already showing the attachment.
    const reader: any = await Zotero.Reader.open(parentID, { annotationID: annotationItem.key } as any);

    // EPUB only: Zotero strips an { annotationID } location and navigates to the
    // annotation *after* the view initializes (Reader.setSelectedAnnotations),
    // bypassing the EPUB view's initial navigation.
    try {
        const resolved = reader ?? await waitForReaderForItem(parentID);
        if (resolved?.type !== 'epub') return;
        await waitForReaderForItem(parentID, resolved);

        let position: any;
        try {
            position = JSON.parse((annotationItem as any).annotationPosition);
        } catch {
            return;
        }
        if (position?.type !== 'FragmentSelector') return;

        // Short settle so this runs after Zotero's post-init by-id navigation
        // and any final layout pass, then land precisely on the cited range.
        await delay(50);
        resolved.navigate({ position });
    } catch (error) {
        logger(`navigateToAnnotation: EPUB position navigation failed: ${error}`, 1);
    }
}

/**
 * Scroll the open reader to one of its annotations without selecting it.
 *
 * `navigateToAnnotation` selects the annotation — the reader treats an
 * external `{ annotationID }` location as "select this one" — and selecting
 * an annotation clears the reader's text selection, taking a passage staged
 * from it off the message. Going to the annotation's position instead scrolls
 * there and flashes it, and leaves the selection alone. An annotation on a
 * file that is not the one in front is opened the usual way.
 */
async function revealAnnotationInCurrentReader(annotationItem: Zotero.Item): Promise<void> {
    if (!annotationItem.isAnnotation()) return;
    const reader = getCurrentReader();
    if (reader && annotationItem.parentID && reader.itemID === annotationItem.parentID) {
        let position: unknown = null;
        try {
            position = JSON.parse((annotationItem as any).annotationPosition);
        } catch {
            position = null;
        }
        if (position && typeof position === 'object') {
            try {
                await reader.navigate({ position });
                return;
            } catch (error) {
                logger(`revealAnnotationInCurrentReader: ${error}`, 1);
            }
        }
    }
    await navigateToAnnotation(annotationItem);
}


/**
 * Retrieves the annotations of the current reader.
 * 
 * @param reader - The reader instance.
 * @returns The annotations.
 */
function getCurrentReaderAnnotations(reader: any) {
    return reader.annotationItemIDs || [];
}

/**
 * Retrieves the current reading position of the reader as a 1-based "page".
 *
 * For PDFs this is the current page number. For EPUBs it is the spine section
 * ordinal (section index + 1) of the section at the top of the viewport — the
 * same coordinate used as "page N" by reading and citation tools.
 *
 * @param reader - The reader instance.
 * @returns The 1-based position, or null for unsupported reader types.
 */
function getCurrentPage(reader?: any): number | null {
    if (!reader) reader = getCurrentReader();
    if (!reader) return null;
    if (reader.type === 'epub') {
        try {
            // The EPUB view's flow tracks the spine section at the top of the
            // viewport. Reader spine indexes count every spine itemref, while
            // extraction skips non-XHTML spine items — for such EPUBs this
            // ordinal can run ahead of the extraction section numbering.
            const sectionIndex = reader._internalReader?._primaryView?.flow?.startSection?.index;
            return typeof sectionIndex === 'number' ? sectionIndex + 1 : null;
        }
        catch (e) {
            console.error('Error getting current EPUB section:', e);
            return null;
        }
    }
    if (reader.type !== 'pdf') {
        return null;
    }

    try {
        // Access the PDF.js viewer instance
        const pdfViewer = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer;
        
        // Get the current page index (0-based)
        const currentPageIndex = pdfViewer.currentPageNumber - 1;
        
        // Return the 1-based page number (more user-friendly)
        return pdfViewer.currentPageNumber || null;
    }
    catch (e) {
        console.error('Error getting current page:', e);
        return null;
    }
}

/**
 * Return the open EPUB reader's current 1-based page, or null when unavailable.
 *
 * @param reader - The reader instance.
 */
function getEpubReaderPage(reader?: any): number | null {
    if (!reader) reader = getCurrentReader();
    if (!reader || reader.type !== 'epub') return null;
    try {
        const primaryView = reader._internalReader?._primaryView;
        const pageMapping = primaryView?.pageMapping;
        const startRange = primaryView?.flow?.startRange;
        if (!pageMapping || !startRange) return null;
        // Zotero's EPUB view stores page indexes as 0-based values.
        const pageIndex = pageMapping.getPageIndex(startRange);
        return typeof pageIndex === 'number' ? pageIndex + 1 : null;
    } catch (e) {
        logger(`getEpubReaderPage failed: ${e}`, 1);
        return null;
    }
}

/**
 * Retrieves the selected text from the reader.
 *
 * What the user sees selected: the view they are working in — the Reading
 * Mode overlay, or the second pane of a split view — and failing that, a
 * selection still showing in the other pane (see `readReaderSelection`).
 * Clicking into one pane does not take the selection in the other away.
 *
 * @param reader - The reader instance.
 * @returns The selected text, or null when nothing is selected.
 */
function getSelectedText(reader?: _ZoteroTypes.Reader): string | null {
    reader = reader || getCurrentReader();
    if (!reader) return null;
    return readReaderSelection(reader, { anyPane: true })?.text ?? null;
}

/**
 * The reader's selection as a passage to stage: its text, the page it starts
 * on and where it is. `page` keeps its old meaning, the page in view. Read
 * the way `getSelectedText` reads it.
 */
function getSelectedTextAsTextSelection(reader: any): ReaderTextSelection | null {
    const selection = readReaderSelection(reader, { locate: true, anyPane: true });
    if (!selection) return null;
    return toReaderTextSelection(selection, getCurrentPage(reader));
}

function toReaderTextSelection(
    selection: ReaderSelectionSnapshot,
    page: number | null | undefined,
): ReaderTextSelection {
    return {
        text: selection.text,
        page: page as number,
        ...(isPageIndex(selection.pageIndex) ? { page_index: selection.pageIndex } : {}),
        ...(selection.position ? { position: selection.position } : {}),
    };
}

/**
 * Retrieves the item of the current reader.
 * 
 * @returns The item.
 */
function getCurrentItem(reader: any): Zotero.Item {
    return Zotero.Items.get(reader.itemID);
}

/**
 * Retrieves the item of the current reader.
 * 
 * @returns The item.
 */
async function getCurrentReaderItemAsync(win?: Window): Promise<Zotero.Item | null> {
    win = win || Zotero.getMainWindow();
    const selectedTabType = win.Zotero_Tabs.selectedType;
    if (selectedTabType !== 'reader') return null;
    const reader = getCurrentReader(win);
    if (!reader || !reader.itemID) return null;
    return await Zotero.Items.getAsync(reader.itemID);
}


/**
 * Context for the reader.
 */
export type ReaderContext = {
    libraryID: number;
    itemKey: string;
    page: number | null;
    identifier: string;
    itemType: string;
    formatted_citation: string | null;
    selection: string | null;
}

/** How often the reader's own selection is re-read (see `addSelectionChangeListener`). */
const SELECTION_POLL_MS = 400;

/** What makes two reads of the selection the same selection. */
function selectionSignature(selection: ReaderSelectionSnapshot | null): string {
    return selection ? `${selection.pageIndex ?? ''}\u0000${selection.text}` : '';
}

/**
 * Report the reader's text selection to `callback` as it changes.
 *
 * Two sources, because no single one covers every view. The base view's
 * document fires `selectionchange`, which is instant for EPUB and snapshot.
 * The PDF view never does — it keeps its own selection model, driven by
 * pointer events — and neither does a Reading Mode overlay or the second pane
 * of a split view, whose documents are their own; those are re-read every
 * `SELECTION_POLL_MS`. Either way the callback hears only of a change: a
 * selection the user took off the message stays off while it is still
 * selected, and comes back if they select again. Moving to the other pane of a
 * split view is no change while the first pane's selection is still showing.
 *
 * `canRead` is consulted before every read of the reader's content. Callers use
 * it to enforce access rules that can change while the listener is installed
 * (e.g. the user excluding the library from Beaver), so the text is never read
 * out of the document once access is gone — not merely dropped afterwards.
 */
function addSelectionChangeListener(
    reader: any,
    callback: (selection: ReaderTextSelection | null) => void,
    canRead: () => boolean = () => true,
) {
    if (reader.type !== "pdf" && reader.type !== "epub" && reader.type !== "snapshot") {
        return null;
    }
    try {
        // Handle initial selection
        if (!canRead()) return null;
        let lastSignature = selectionSignature(readReaderSelection(reader, { anyPane: true }));
        const initial = lastSignature ? getSelectedTextAsTextSelection(reader) : null;
        if (initial) callback(initial);

        const check = () => {
            if (!canRead()) return;
            const current = readReaderSelection(reader, { anyPane: true });
            const signature = selectionSignature(current);
            if (signature === lastSignature) return;
            lastSignature = signature;
            callback(current ? getSelectedTextAsTextSelection(reader) : null);
        };

        const baseDocument = reader._internalReader?._primaryView?._iframeWindow?.document;
        baseDocument?.addEventListener("selectionchange", check);
        const win = Zotero.getMainWindow();
        const timer = win?.setInterval?.(check, SELECTION_POLL_MS);

        // Return a function to remove the listener and the poll when no longer needed
        return () => {
            baseDocument?.removeEventListener("selectionchange", check);
            if (timer !== undefined) win?.clearInterval?.(timer);
        };
    } catch (e) {
        console.error("Error setting up selection listener:", e);
        return null;
    }
}

/**
 * Whether the given item is open as the *currently selected* tab in the main
 * window. Works for both reader tabs (attachments) and note tabs, since both
 * store the item ID on their tab data.
 *
 * Used to disable an "Open Attachment"/"Open Note" action only when the user is
 * already looking at that item. An item open in a background tab returns false
 * (re-opening it just switches to that tab).
 */
function isItemActiveTab(itemId: number): boolean {
    try {
        const tabs = Zotero.getMainWindow()?.Zotero_Tabs;
        if (!tabs) return false;
        const tabID = tabs.getTabIDByItemID?.(itemId);
        return !!tabID && tabID === tabs.selectedID;
    } catch {
        return false;
    }
}

/**
 * Ensures the reader is initialized.
 *
 * @param reader - The reader instance.
 */
async function ensureReaderInitialized(reader: ZoteroReader, waitForView: boolean = true): Promise<void> {
    try {
        if (reader && (reader as any)._initPromise) {
            await (reader as any)._initPromise;
            if (waitForView) {
                await (reader as any)._internalReader?._primaryView?.initializedPromise;
            }
        }
    } catch (error) {
        logger(`ensureReaderInitialized failed: ${error}`, 1);
    }
}

export {
    getCurrentReaderItemAsync,
    getCurrentReader,
    getCurrentReaderAndWaitForView,
    waitForReaderForItem,
    getCurrentPage,
    getEpubReaderPage,
    navigateToPage,
    getSelectedText,
    ensureReaderInitialized,
    getCurrentItem,
    addSelectionChangeListener,
    getSelectedTextAsTextSelection,
    navigateToPageInCurrentReader,
    textSelectionLocation,
    revealTextSelectionInCurrentReader,
    highlightOfSelection,
    isHighlightSelectionOn,
    navigateToAnnotation,
    revealAnnotationInCurrentReader,
    isItemActiveTab
};
