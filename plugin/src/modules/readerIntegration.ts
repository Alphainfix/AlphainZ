/**
 * Reader integration: text selection popup, view context menu, and annotation context menu.
 *
 * Registers three Zotero.Reader event listeners:
 * 1. renderTextSelectionPopup — adds the selection-chat input ("Ask about this…")
 * 2. createViewContextMenu — adds "Explain with AlphainZ" and "Ask AlphainZ..." items
 * 3. createAnnotationContextMenu — adds "Chat about this highlight", "Explain with
 *    AlphainZ" and "Ask AlphainZ..." items for annotations
 *
 * All dispatch events via __alphainzEventBus so the webpack bundle can orchestrate the UI flow.
 *
 * Lives in the esbuild bundle — must NOT import from react/store or Jotai. It
 * imports nothing, so the webpack bundle may import its selection reader.
 */

// Module-level references for cleanup
let popupHandler: ((event: any) => void) | null = null;
let contextMenuHandler: ((event: any) => void) | null = null;
let annotationMenuHandler: ((event: any) => void) | null = null;

// Reader view types Beaver integrates with: PDF, EPUB, and web snapshots.
// EPUB and snapshot are DOM-based views with section/continuous layout and no
// PDF-style page numbers (the reader position is captured downstream).
function isSupportedReaderType(type: unknown): boolean {
    return type === 'pdf' || type === 'epub' || type === 'snapshot';
}

// Annotation actions serialize Zotero annotation positions as PDF page/rect data.
function isSupportedAnnotationReaderType(type: unknown): boolean {
    return type === 'pdf';
}

/** Text the user has selected in a reader, and where it is. */
export interface ReaderSelectionSnapshot {
    text: string;
    /**
     * 0-based index of the page the passage starts on. Known for a PDF,
     * including Reading Mode over a PDF, whose positions are the PDF's own.
     */
    pageIndex?: number;
    /**
     * Where the passage is, as the reader describes it (the `position` of an
     * annotation made from it), copied to a plain object. What
     * `reader.navigate({ position })` takes to scroll back to the passage.
     */
    position?: Record<string, any>;
}

/**
 * The view the user is working in.
 *
 * Not always the primary base view: in Reading Mode the base view is hidden
 * behind an overlay with its own document, and in a split view the selection
 * can be in the second pane. The reader tracks which one was used last.
 */
function activeReaderView(reader: any): any {
    const internal = reader?._internalReader;
    if (!internal) return null;
    let view: any = null;
    try {
        view = internal._lastView;
    } catch {
        view = null;
    }
    return view ?? internal._primaryView ?? null;
}

/**
 * Every view whose selection is on screen, the one the user is working in
 * first: each pane's active view — its Reading Mode overlay when one is up,
 * its base view otherwise. A base view hidden behind an overlay is left out;
 * whatever it still holds is not on screen.
 *
 * Focusing the other pane of a split view makes it the view in use, but the
 * selection left in the first pane stays selected there.
 */
function visibleReaderViews(reader: any): any[] {
    const internal = reader?._internalReader;
    if (!internal) return [];
    const views: any[] = [];
    const add = (view: any) => {
        if (view && !views.includes(view)) views.push(view);
    };
    add(activeReaderView(reader));
    for (const primary of [true, false]) {
        try {
            add(typeof internal._getActiveView === 'function'
                ? internal._getActiveView(primary)
                : primary ? internal._primaryView : internal._secondaryView);
        } catch {
            // A view being torn down has nothing selected.
        }
    }
    return views;
}

function plainCopy(value: any): Record<string, any> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

function isPageIndex(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The text selected in one view, with its location.
 *
 * The PDF view keeps its own selection model (`_selectionRanges`, built from
 * pointer events) and never touches the DOM selection. Every other view —
 * EPUB, snapshot, and the Reading Mode overlay — is a DOM view with an
 * ordinary selection in its own iframe.
 */
function readViewSelection(view: any, locate: boolean): ReaderSelectionSnapshot | null {
    if (Array.isArray(view._selectionRanges)) {
        // A plain click leaves one collapsed range behind; the reader itself
        // shows no selection popup for it, and neither is it a selection here.
        const ranges = view._selectionRanges.filter((range: any) => range && !range.collapsed);
        if (ranges.length === 0) return null;
        const text = ranges.map((range: any) => range.text).join('\n\n');
        if (!text.trim()) return null;
        // A selection over two pages has a range per page; the passage
        // starts on the earlier one.
        const first = ranges.reduce((earliest: any, range: any) =>
            (range?.position?.pageIndex ?? Infinity) < (earliest?.position?.pageIndex ?? Infinity)
                ? range
                : earliest);
        const position = plainCopy(first?.position);
        const pageIndex = position?.pageIndex;
        return {
            text,
            ...(isPageIndex(pageIndex) ? { pageIndex } : {}),
            ...(position ? { position } : {}),
        };
    }

    const selection = view._iframeWindow?.getSelection?.();
    const text = selection?.toString();
    if (!text || !text.trim()) return null;
    if (!locate) return { text };
    let position: Record<string, any> | undefined;
    try {
        if (selection.rangeCount > 0 && typeof view.toSelector === 'function') {
            position = plainCopy(view.toSelector(selection.getRangeAt(0)));
        }
    } catch {
        position = undefined;
    }
    const pageIndex = position?.pageIndex;
    return {
        text,
        ...(isPageIndex(pageIndex) ? { pageIndex } : {}),
        ...(position ? { position } : {}),
    };
}

/**
 * The text selected in the reader, with its location.
 *
 * Read from the view the user is working in. With `anyPane`, a selection
 * still showing in the other pane of a split view counts too, when the view
 * in use has none: what the user sees selected, rather than what the view
 * they last clicked in holds. The view menu reads only the view it was opened
 * on.
 *
 * `locate` also works out a DOM view's position, which costs a range-to-
 * selector conversion; a PDF selection carries its position already.
 */
export function readReaderSelection(
    reader: any,
    options: { locate?: boolean; anyPane?: boolean } = {},
): ReaderSelectionSnapshot | null {
    if (!isSupportedReaderType(reader?.type)) return null;
    let views: any[];
    try {
        views = options.anyPane ? visibleReaderViews(reader) : [activeReaderView(reader)];
    } catch {
        return null;
    }
    for (const view of views) {
        if (!view) continue;
        try {
            const selection = readViewSelection(view, !!options.locate);
            if (selection) return selection;
        } catch {
            // A view that cannot be read has no selection to offer.
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Event dispatch helper
// ---------------------------------------------------------------------------

function dispatchReaderAction(
    action: 'explain' | 'ask',
    selection: ReaderSelectionSnapshot,
    page: number | undefined,
    readerItemID: number,
): void {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__alphainzEventBus;
    if (!eventBus) return;

    eventBus.dispatchEvent(new win.CustomEvent('readerSelectionAction', {
        detail: {
            action,
            text: selection.text,
            page,
            ...(selection.pageIndex !== undefined ? { pageIndex: selection.pageIndex } : {}),
            ...(selection.position ? { position: selection.position } : {}),
            readerItemID,
        },
    }));
}

/**
 * Anchored selection chat: the user typed a prompt straight into the selection
 * popup. Hands the prompt plus the prospective annotation to the React bundle,
 * which creates the highlight anchor and opens the anchored conversation.
 */
export interface SelectionChatRequest {
    prompt: string;
    selectedText: string;
    annotation: any;
    page: number | undefined;
    /** 0-based index of the page the selection starts on, when the reader says. */
    pageIndex: number | undefined;
    readerItemID: number;
}

/**
 * What became of a question typed into the selection popup, reported back by
 * the chat panel so the popup can say so.
 *
 * `sending` is not the last word: the panel has the question and is sending
 * it, and answers again with `sent` once its run has started, or `failed` when
 * the send was turned away first (a model not set up on this computer, the
 * libraries still loading, a Stop). `staged` means an answer was still being
 * written: the question waits in the chat's message box instead of being sent.
 */
export type SelectionChatOutcome =
    | { status: 'sending' }
    | { status: 'sent' }
    | { status: 'staged' }
    | { status: 'failed'; reason: string };

/**
 * How long the popup waits for the chat panel to pick a question up before it
 * gives the question back to the user. Picking it up takes a moment when a
 * conversation has to be started first; once picked up (`sending`), the panel
 * always answers.
 */
const SELECTION_CHAT_ACK_TIMEOUT_MS = 20000;

/**
 * `params.annotation` belongs to the reader's document compartment. Handing it
 * across to the main window raw risks tripping over Xray wrappers, and the
 * shape is only loosely documented — so snapshot it as plain JSON and keep the
 * position under whichever key this Zotero build actually uses.
 */
function plainAnnotationSnapshot(annotation: any): Record<string, any> {
    const snapshot: Record<string, any> = {};
    if (!annotation) return snapshot;
    for (const key of ['type', 'text', 'color', 'pageLabel', 'sortIndex', 'pageIndex', 'position']) {
        const value = annotation[key];
        if (value === undefined || value === null) continue;
        try {
            snapshot[key] = typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
        } catch {
            // A non-serializable field is not worth failing the whole send over.
        }
    }
    return snapshot;
}

/**
 * Hand a popup question to the chat panel. Returns false when there is no
 * panel to hand it to, in which case `onOutcome` is never called.
 */
function dispatchSelectionChat(
    request: SelectionChatRequest,
    onOutcome: (outcome: SelectionChatOutcome) => void,
): boolean {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__alphainzEventBus;
    if (!eventBus) {
        ztoolkit.log('readerIntegration: no event bus, dropping selection chat');
        return false;
    }

    const annotation = plainAnnotationSnapshot(request.annotation);
    // One-time shape check: the anchor cannot be placed without position data,
    // and which key carries it is the thing to confirm against a live reader.
    ztoolkit.log(
        `readerIntegration: selection chat, annotation keys = ${Object.keys(annotation).join(',')}`,
    );

    eventBus.dispatchEvent(new win.CustomEvent('alphainSelectionChat', {
        detail: {
            prompt: request.prompt,
            selectedText: request.selectedText,
            annotation,
            page: request.page,
            ...(request.pageIndex !== undefined ? { pageIndex: request.pageIndex } : {}),
            readerItemID: request.readerItemID,
            onOutcome,
        },
    }));
    return true;
}

// ---------------------------------------------------------------------------
// Text selection popup handler
// ---------------------------------------------------------------------------

function onRenderTextSelectionPopup(event: any): void {
    const { reader, doc, params, append } = event;

    if (!isSupportedReaderType(reader?.type)) return;

    const annotationText = params?.annotation?.text;
    if (!annotationText) return;

    // EPUB/snapshot selections have no PDF-style page (the reader position is
    // captured downstream when the message is sent).
    const page = reader.type === 'pdf'
        ? (params.annotation.pageIndex ?? 0) + 1
        : undefined;
    // The page the selection starts on lives in the prospective annotation's
    // position. For a PDF, Reading Mode included, that is the PDF's own page
    // index; EPUB and snapshot positions carry none.
    const positionPageIndex = params.annotation.position?.pageIndex;
    const pageIndex = isPageIndex(positionPageIndex) ? positionPageIndex : undefined;
    const readerItemID = reader?.itemID;
    if (!readerItemID) return;

    const container = doc.createElement('div');
    container.className = 'alphain-selection-popup';
    container.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

    const label = doc.createElement('span');
    label.textContent = 'AlphainZ';
    label.style.cssText = 'font-size: 11px; color: #888; user-select: none; padding-left: 4px;';
    container.appendChild(label);

    // One field, no buttons: whatever the user types is the prompt. Enter
    // sends.
    //
    // It has to be an `<input type="text">`, not a textarea. The reader's
    // keyboard manager listens on its window in the *capture* phase, so it
    // handles every key before this field ever sees it, and nothing done here
    // can stop that. What decides whether a keystroke edits the field or
    // drives the reader is the manager's own guards — and every one of them
    // is written for `input[type="text"]` (or a contenteditable), never for a
    // textarea:
    //   - Backspace / Delete exempt `closest('input, .label-popup')`; in a
    //     textarea they ran the annotation-deletion branch instead, which
    //     deleted the selected highlight and tore the popup down mid-typing.
    //   - Arrow keys exempt `[contenteditable], input[type="text"]`; in a
    //     textarea they moved focus to the next reader item.
    //   - Cmd-A, Cmd-←/→ exempt `isTextBox()` (an INPUT of type text); in a
    //     textarea Cmd-A selected every annotation and Cmd-← navigated back.
    // A long question scrolls sideways in here rather than wrapping. That is
    // the price of a field whose Backspace key deletes a character.
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'alphain-selection-input';
    input.setAttribute('placeholder', 'Ask about this…');
    // Named for itself: a placeholder is not a label, and it changes after
    // the first question.
    input.setAttribute('aria-label', 'Ask AlphainZ about the selected text');
    input.style.cssText =
        'width: 100%; box-sizing: border-box; font: inherit; padding: 3px 6px; line-height: 1.4;';

    // One line under the field saying what became of the last question.
    const status = doc.createElement('div');
    status.className = 'alphain-selection-status';
    status.style.cssText = 'display: none; font-size: 11px; color: #888; padding: 0 4px; line-height: 1.3;';
    const showStatus = (text: string | null) => {
        status.textContent = text ?? '';
        status.style.display = text ? '' : 'none';
    };

    /*
     * The question stays in the field, greyed out, until the chat panel says
     * what it did with it. Cleared first, it was gone for good whenever the
     * panel could not take it — no event bus yet, a file it could not find, a
     * library excluded from AlphainZ — with nothing on screen to say so.
     */
    let awaitingOutcome = false;
    const ask = (prompt: string) => {
        awaitingOutcome = true;
        input.disabled = true;
        showStatus('Opening AlphainZ…');
        let settled = false;
        let pickedUp = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle = (outcome: SelectionChatOutcome) => {
            if (settled) return;
            if (outcome.status === 'sending') {
                // The panel has it and will say how the send went; the
                // popup's own clock no longer applies.
                pickedUp = true;
                if (timer) clearTimeout(timer);
                timer = null;
                showStatus('Sending to AlphainZ…');
                return;
            }
            settled = true;
            if (timer) clearTimeout(timer);
            awaitingOutcome = false;
            input.disabled = false;
            if (outcome.status === 'failed') {
                showStatus(outcome.reason);
                return;
            }
            // Ready for a follow-up about the same passage.
            input.value = '';
            input.setAttribute('placeholder', 'Ask a follow-up…');
            showStatus(outcome.status === 'staged'
                ? 'An answer is still being written; your question is waiting in the AlphainZ message box.'
                : 'Sent to AlphainZ →');
        };
        const dispatched = dispatchSelectionChat({
            prompt,
            selectedText: annotationText,
            annotation: params.annotation,
            page,
            pageIndex,
            readerItemID,
        }, settle);
        if (!dispatched) {
            settle({ status: 'failed', reason: 'AlphainZ is not ready yet. Try again in a moment.' });
            return;
        }
        if (settled || pickedUp) return;
        timer = setTimeout(() => settle({
            status: 'failed',
            reason: 'AlphainZ did not pick this up. Try again.',
        }), SELECTION_CHAT_ACK_TIMEOUT_MS);
    };

    // Bubbling handlers still exist (the popup's own React tree, the view's
    // single-key shortcuts); stopping propagation keeps a keystroke from
    // reaching them once the capture-phase manager has let it through.
    const swallow = (e: any) => e.stopPropagation();
    input.addEventListener('keypress', swallow);
    input.addEventListener('keyup', swallow);
    input.addEventListener('keydown', (e: any) => {
        e.stopPropagation();
        if (e.key !== 'Enter') return;
        // Enter while an IME composition is open commits the candidate, it
        // does not send — treating it as send would fire mid-word.
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        const prompt = input.value.trim();
        if (!prompt || awaitingOutcome) return;
        ask(prompt);
    });

    // Clicks inside the field must not reach the view, or the reader clears the
    // selection and tears this popup down mid-typing.
    container.addEventListener('mousedown', swallow);
    container.addEventListener('click', swallow);

    container.appendChild(input);
    container.appendChild(status);
    append(container);
}

// ---------------------------------------------------------------------------
// Context menu handler
// ---------------------------------------------------------------------------

function onCreateViewContextMenu(event: any): void {
    const { reader, append } = event;

    if (!isSupportedReaderType(reader?.type)) return;

    const readerItemID = reader?.itemID;

    // Read from the view the user right-clicked in: in Reading Mode or the
    // second pane of a split view, the primary base view has no selection.
    // The selection's own page and position travel with it — the page in view
    // below is often not the page the passage is on.
    const selection = readReaderSelection(reader, { locate: true });
    const selectedText = selection?.text ?? null;

    // Current page (1-based) from the PDF viewer. EPUB/snapshot selections have
    // no PDF-style page; their position is captured downstream.
    let page: number | undefined = undefined;
    if (reader?.type === 'pdf') {
        page = 1;
        try {
            const pdfViewer = reader?._internalReader?._primaryView
                ?._iframeWindow?.PDFViewerApplication?.pdfViewer;
            if (pdfViewer?.currentPageNumber) {
                page = pdfViewer.currentPageNumber;
            }
        } catch (_e) {
            // Fallback to page 1
        }
    }

    const hasSelection = !!selectedText && selectedText.length > 0;

    // Flat items — append does not support submenu/groups nesting
    append(
        {
            label: 'Explain with AlphainZ',
            disabled: !hasSelection,
            persistent: true,
            onCommand: () => {
                if (selection && readerItemID) {
                    dispatchReaderAction('explain', selection, page, readerItemID);
                }
            },
        },
        {
            label: 'Ask AlphainZ...',
            disabled: !hasSelection,
            persistent: true,
            onCommand: () => {
                if (selection && readerItemID) {
                    dispatchReaderAction('ask', selection, page, readerItemID);
                }
            },
        },
    );

}

// ---------------------------------------------------------------------------
// Annotation context menu handler
// ---------------------------------------------------------------------------

function dispatchAnnotationAction(
    action: 'explain' | 'ask',
    annotationIds: string[],
    readerItemID: number,
): void {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__alphainzEventBus;
    if (!eventBus) return;

    eventBus.dispatchEvent(new win.CustomEvent('readerAnnotationAction', {
        detail: { action, annotationIds, readerItemID },
    }));
}

function dispatchAnchorEvent(
    name: 'alphainReopenAnchor' | 'alphainChatAboutAnnotation',
    detail: Record<string, unknown>,
): void {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__alphainzEventBus;
    if (!eventBus) return;
    eventBus.dispatchEvent(new win.CustomEvent(name, { detail }));
}

/**
 * The highlight "Chat about this highlight" would open, when the menu is for
 * one.
 *
 * The reader names annotations by their item key, not their item id, and the
 * key is only unique within a library — the library is the open attachment's.
 * Only a highlight or underline with text qualifies: the conversation is about
 * a passage, and an image, ink or note annotation has none to quote.
 */
export function chatTargetForAnnotation(
    reader: any,
    annotationKey: string,
): { libraryID: number; key: string } | null {
    try {
        const fromReader = reader?._item?.libraryID;
        const fromItemID = typeof fromReader === 'number'
            ? false
            : Zotero.Items.getLibraryAndKeyFromID(reader?.itemID);
        const libraryID = typeof fromReader === 'number'
            ? fromReader
            : fromItemID ? fromItemID.libraryID : undefined;
        if (typeof libraryID !== 'number') return null;
        const item = Zotero.Items.getByLibraryAndKey(libraryID, annotationKey) as any;
        if (!item || !item.isAnnotation?.()) return null;
        if (item.annotationType !== 'highlight' && item.annotationType !== 'underline') return null;
        if (!String(item.annotationText ?? '').trim()) return null;
        return { libraryID, key: annotationKey };
    } catch {
        return null;
    }
}

function onCreateAnnotationContextMenu(event: any): void {
    const { reader, params, append } = event;

    if (!isSupportedAnnotationReaderType(reader?.type)) return;

    const readerItemID = reader?.itemID;
    if (!readerItemID) return;

    // Item keys: the reader's annotation ids are the items' keys.
    const annotationKeys: string[] = Array.from((params?.ids ?? []) as ArrayLike<unknown>)
        .map((id) => String(id ?? ''))
        .filter((id) => id.length > 0);
    if (annotationKeys.length === 0) return;

    // Anchoring is per-highlight, so that entry only makes sense for a single
    // selected highlight. Explain and Ask work across a multi-select.
    const single = annotationKeys.length === 1
        ? chatTargetForAnnotation(reader, annotationKeys[0])
        : null;

    if (single) {
        append({
            // One label for both cases. The handler looks the anchor up and
            // either reopens the conversation or starts one; a menu cannot make
            // that distinction without a cache, and a cache to keep warm was
            // more machinery than a label is worth.
            label: 'Chat about this highlight',
            persistent: true,
            onCommand: () => {
                dispatchAnchorEvent('alphainChatAboutAnnotation', {
                    annotationKey: single.key,
                    libraryId: single.libraryID,
                    readerItemID,
                });
            },
        });
    }

    append({
        label: 'Explain with AlphainZ',
        persistent: true,
        onCommand: () => {
            dispatchAnnotationAction('explain', annotationKeys, readerItemID);
        },
    });

    // A question of the user's own about a boxed figure, a note or several
    // annotations at once. A single highlight has "Chat about this highlight"
    // for that, and two entries doing nearly the same thing would only make
    // the user choose between them.
    if (!single) {
        append({
            label: 'Ask AlphainZ...',
            persistent: true,
            onCommand: () => {
                dispatchAnnotationAction('ask', annotationKeys, readerItemID);
            },
        });
    }
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

function removeListenerSafely(type: string, handler: (...args: unknown[]) => unknown): boolean {
    const reader = Zotero?.Reader as any;
    const listeners = reader?._registeredListeners;
    if (!Array.isArray(listeners)) return false;
    reader._registeredListeners = listeners.filter(
        (l: any) => !(l?.type === type && l?.handler === handler),
    );
    return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initReaderIntegration(): void {
    if (typeof Zotero?.Reader?.registerEventListener !== 'function') {
        ztoolkit.log('readerIntegration: Reader API not available, skipping');
        return;
    }

    // Clean up any previous listeners (e.g. plugin reload)
    cleanupReaderIntegration();

    popupHandler = onRenderTextSelectionPopup;
    contextMenuHandler = onCreateViewContextMenu;
    annotationMenuHandler = onCreateAnnotationContextMenu;

    Zotero.Reader.registerEventListener('renderTextSelectionPopup', popupHandler, addon.data.config.addonID);
    Zotero.Reader.registerEventListener('createViewContextMenu', contextMenuHandler, addon.data.config.addonID);
    Zotero.Reader.registerEventListener('createAnnotationContextMenu', annotationMenuHandler, addon.data.config.addonID);

    ztoolkit.log('readerIntegration: Registered reader event listeners');
}

export function cleanupReaderIntegration(): void {
    if (popupHandler) {
        removeListenerSafely('renderTextSelectionPopup', popupHandler);
        popupHandler = null;
    }
    if (contextMenuHandler) {
        removeListenerSafely('createViewContextMenu', contextMenuHandler);
        contextMenuHandler = null;
    }
    if (annotationMenuHandler) {
        removeListenerSafely('createAnnotationContextMenu', annotationMenuHandler);
        annotationMenuHandler = null;
    }
}
