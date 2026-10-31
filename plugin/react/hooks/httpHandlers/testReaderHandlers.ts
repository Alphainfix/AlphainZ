/**
 * Dev-only HTTP handlers for reader-state and EPUB citation-navigation
 * verification. Wired to their paths in `useHttpEndpoints.ts`.
 *
 * `/alphainz/test/reader-state` opens (or reuses) a reader tab and reports the
 * same position fields `getReaderState` derives for `application_state`:
 * `current_page` (PDF page, or EPUB page coordinate) and `content_kind` from
 * `reader.type`.
 *
 * `/alphainz/test/epub-citation-navigate` drives the EPUB citation-click path
 * against the live reader: either the full `navigateToEpubCitation` flow
 * (temporary-annotation highlight included) or a resolve-only probe that
 * reports the precise range `resolveEpubCitationRange` anchors.
 */

import {
    getCurrentPage,
    getCurrentReader,
    getCurrentReaderAndWaitForView,
    getEpubReaderPage,
    waitForReaderForItem,
} from '../../utils/readerUtils';
import { store } from '../../store';
import { readerTextSelectionAtom } from '../../atoms/messageComposition';
import { navigateToEpubCitation } from '../../utils/epubVisualizer/epubCitationNavigation';
import { resolveEpubCitationRange } from '../../utils/epubVisualizer/epubRangeResolver';
import {
    getSectionCount,
    type EpubPrimaryView,
} from '../../utils/epubVisualizer/epubReaderView';
import { BeaverTemporaryAnnotations } from '../../utils/annotationUtils';
import type { SymbolicLocation } from '@beaver/agent-core/types/citations';
import { UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';

const ELEMENT_NODE = 1;

/**
 * Copy a plain object into another window's realm.
 *
 * Code running in the reader's windows cannot read a plain object created
 * here — a chrome object reaches a less-privileged realm as an opaque wrapper
 * — so an event-init dictionary passed to that window's constructors arrives
 * with every member missing. `Cu.cloneInto` makes a structured copy that
 * belongs to the target realm; a JSON round trip through the target's own
 * `JSON` does the same when `Components` is not on hand.
 */
/** A JSON copy of a value that lives in another window, or null. */
function plainCopy(value: unknown): unknown {
    if (value == null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function cloneIntoWindow<T extends object>(win: any, value: T): T {
    const Cu = (globalThis as any).Components?.utils;
    if (Cu?.cloneInto) return Cu.cloneInto(value, win) as T;
    return win.JSON.parse(JSON.stringify(value)) as T;
}

/** Open the attachment's reader (or reuse the current tab) and wait for its view. */
async function openReaderForAttachment(item: Zotero.Item): Promise<any | undefined> {
    const current = await getCurrentReaderAndWaitForView(undefined, false);
    if (current?.itemID === item.id) return current;
    const opened = await Zotero.Reader.open(item.id);
    return waitForReaderForItem(item.id, opened);
}

/** A freshly opened EPUB reader can report a view before spine renderers exist. */
async function waitForSectionRenderers(
    primaryView: EpubPrimaryView,
    timeoutMs = 2000,
): Promise<void> {
    const start = Date.now();
    while (getSectionCount(primaryView) === 0 && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

export async function handleTestReaderStateHttpRequest(request: any): Promise<any> {
    const { library_id, zotero_key } = request || {};

    let reader: any | undefined;
    if (library_id != null && zotero_key != null) {
        if (library_id === UNRESOLVED_LIBRARY_ID) return { ok: false, error: 'library_unavailable' };
        const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
        if (!item) return { ok: false, error: 'not_found' };
        if (!item.isAttachment()) return { ok: false, error: 'not_an_attachment' };
        reader = await openReaderForAttachment(item);
    } else {
        reader = await getCurrentReaderAndWaitForView(undefined, false);
    }
    if (!reader) return { ok: false, error: 'no_reader' };

    // Mirrors the `content_kind` derivation in `getReaderState`.
    const contentKind = reader.type === 'pdf' || reader.type === 'epub'
        ? reader.type
        : null;
    let sectionCount: number | null = null;
    let primaryView: EpubPrimaryView | undefined;
    if (reader.type === 'epub') {
        // A cold-opened EPUB reader can report its view before the spine
        // renderers exist, which would yield section_count 0 / null position.
        primaryView = reader._internalReader?._primaryView as EpubPrimaryView | undefined;
        if (primaryView) await waitForSectionRenderers(primaryView);
        sectionCount = primaryView ? getSectionCount(primaryView) : null;
    }

    // Keep this endpoint aligned with `getReaderState`.
    const currentPage = reader.type === 'epub'
        ? getEpubReaderPage(reader)
        : (getCurrentPage(reader) || null);

    return {
        ok: true,
        reader_type: reader.type ?? null,
        current_page: currentPage,
        content_kind: contentKind,
        section_count: sectionCount,
    };
}

export async function handleTestEpubCitationNavigateHttpRequest(request: any): Promise<any> {
    const {
        library_id,
        zotero_key,
        section_href,
        section_ordinal,
        anchor_id,
        text,
        preview_text,
        mode,
        use_temporary_annotations,
        cleanup,
    } = request || {};
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { ok: false, error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: false, error: 'not_found' };

    if (mode === 'navigate') {
        // Full citation-click flow, including the temporary-annotation flash.
        const symbolicLocation: SymbolicLocation | undefined =
            typeof section_href === 'string'
                ? { content_kind: 'epub', section_href, anchor_id, text }
                : undefined;
        const outcome = await navigateToEpubCitation({
            item,
            symbolicLocation,
            sectionOrdinal: typeof section_ordinal === 'number' ? section_ordinal : undefined,
            searchText: typeof text === 'string' ? text : undefined,
            previewText: typeof preview_text === 'string' ? preview_text : undefined,
            useTemporaryAnnotations: use_temporary_annotations !== false,
        });

        const reader = await getCurrentReaderAndWaitForView(undefined, false);
        const annotations: any[] =
            reader?._internalReader?._state?.annotations ?? [];
        const temporaryCount = annotations.filter((annotation) =>
            String(annotation?.id ?? '').startsWith('epub_citation'),
        ).length;

        if (cleanup !== false) {
            await BeaverTemporaryAnnotations.cleanupAll().catch(() => undefined);
        }
        return { ok: true, outcome, temporary_annotation_count: temporaryCount };
    }

    // Resolve-only probe: report the section + precise range the citation
    // locator anchors, without flashing anything.
    const reader = await openReaderForAttachment(item);
    if (!reader) return { ok: false, error: 'no_reader' };
    if (reader.type !== 'epub') return { ok: false, error: 'not_an_epub_reader' };
    const primaryView = reader._internalReader?._primaryView as EpubPrimaryView | undefined;
    if (!primaryView) return { ok: false, error: 'no_primary_view' };
    await waitForSectionRenderers(primaryView);

    const resolved = resolveEpubCitationRange(primaryView, {
        sectionHref: typeof section_href === 'string' ? section_href : undefined,
        sectionOrdinal: typeof section_ordinal === 'number' ? section_ordinal : undefined,
        anchorId: typeof anchor_id === 'string' ? anchor_id : undefined,
        text: typeof text === 'string' ? text : undefined,
    });
    if (!resolved) {
        return { ok: true, resolved: false, section_count: getSectionCount(primaryView) };
    }

    let rangeText: string | null = null;
    let rangeAnchorId: string | null = null;
    if (resolved.range) {
        rangeText = resolved.range.toString().replace(/\s+/g, ' ').trim();
        const startNode = resolved.range.startContainer;
        let element: Element | null = startNode.nodeType === ELEMENT_NODE
            ? (startNode as Element)
            : (startNode.parentElement ?? null);
        while (element && !element.getAttribute('id')) {
            element = element.parentElement;
        }
        rangeAnchorId = element?.getAttribute('id') ?? null;
    }

    return {
        ok: true,
        resolved: true,
        section_index: resolved.sectionIndex,
        has_range: Boolean(resolved.range),
        range_text: rangeText,
        range_anchor_id: rangeAnchorId,
        section_count: getSectionCount(primaryView),
    };
}

/**
 * Both answers to "is text selected right now", side by side.
 *
 * The chip stayed on the message after the user clicked *on* the selected text
 * — the highlight went away, the chip did not. Two sources could disagree:
 * `_selectionRanges` is the reader's own model, and the iframe document's DOM
 * selection is what the browser thinks. This reports both, and can drive the
 * gesture, so the disagreement is observable without a mouse.
 *
 * `action`: `report` (default) | `select` | `collapse`.
 */
export async function handleTestReaderSelectionProbeHttpRequest(request: any): Promise<any> {
    const reader: any = getCurrentReader();
    if (!reader) return { ok: false, error: 'no reader open' };
    const primaryView = reader._internalReader?._primaryView;
    if (!primaryView) return { ok: false, error: 'reader has no primary view' };

    const win = primaryView._iframeWindow;
    const doc = win?.document;
    const action = request?.action ?? 'report';

    if (action === 'select') {
        // Pick a text node out of the rendered text layer and select part of it.
        const node = doc?.querySelector('.textLayer span, .text-layer span, span[role="presentation"]');
        if (!node) return { ok: false, error: 'no text layer node found' };
        const range = doc.createRange();
        range.selectNodeContents(node);
        const selection = win.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    } else if (action === 'collapse') {
        // What clicking on the selected text does: collapse it, keep focus.
        win?.getSelection?.()?.removeAllRanges?.();
    } else if (action === 'select-word') {
        /*
         * Make the reader itself select a word, the way a double-click does.
         *
         * The PDF view keeps its own selection model, driven by pointer events
         * over its character boxes; a DOM range set from outside (`select`
         * above) never reaches it, so no selection popup follows. A synthetic
         * double-click mousedown at a text position runs the view's
         * word-selection branch, which opens the popup — and with it this
         * plugin's field, which `popup-key` then needs.
         */
        // The view's character boxes arrive after the page text is processed;
        // until then no pointer position maps to text and the click selects
        // nothing. Wait for the first page's characters.
        const deadline = Date.now() + Number(request?.chars_timeout_ms ?? 8000);
        while (Date.now() < deadline && !(primaryView._pdfPages?.[0]?.chars?.length > 0)) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const pageDiv = doc?.querySelector('#viewerContainer .page[data-page-number="1"], #viewerContainer .page') as HTMLElement | null;
        if (!pageDiv || !win) return { ok: false, error: 'no rendered page found' };
        // Events are built with the reader window's own constructors: an object
        // made on this side is opaque to code in that window (its properties
        // read as undefined there), so a plain `{ clientX, clientY }` stand-in
        // cannot even be used to ask the view where a point lands.
        const MouseEventCtor = (win as any).MouseEvent as typeof MouseEvent;
        const PointerEventCtor = (win as any).PointerEvent as typeof PointerEvent;
        // An event-init dictionary written here is opaque to the reader window's
        // constructor (every member reads as missing, so clientX becomes 0);
        // it has to be cloned into that window's realm first.
        const inRealm = <T extends object>(dict: T): T => cloneIntoWindow(win, dict);
        const positionAt = (x: number, y: number) => {
            try {
                const probeEvent = new MouseEventCtor('mousemove', inRealm({ clientX: x, clientY: y, bubbles: false }));
                return primaryView.pointerEventToPosition?.(probeEvent) ?? null;
            } catch (error) {
                return { error: String(error) };
            }
        };
        // Three places a word might be, tried in order until the view maps one
        // to a character: the first character box the view knows, the first
        // text-layer span, the middle of the page.
        const candidates: Array<{ name: string; x: number; y: number }> = [];
        const firstChar = primaryView._pdfPages?.[0]?.chars?.[0];
        const pageView = win.PDFViewerApplication?.pdfViewer?.getPageView?.(0);
        const pageRect = pageDiv.getBoundingClientRect();
        if (firstChar?.rect && pageView?.viewport) {
            const [vx, vy] = pageView.viewport.convertToViewportPoint(
                (firstChar.rect[0] + firstChar.rect[2]) / 2,
                (firstChar.rect[1] + firstChar.rect[3]) / 2,
            );
            candidates.push({ name: 'first-char', x: pageRect.left + vx, y: pageRect.top + vy });
        }
        const span = Array.from(pageDiv.querySelectorAll('.textLayer span, span[role="presentation"]'))
            .find((el) => ((el as Element).textContent ?? '').trim().length > 3) as Element | undefined;
        if (span) {
            const r = span.getBoundingClientRect();
            candidates.push({ name: 'text-span', x: r.left + Math.min(10, r.width / 2), y: r.top + r.height / 2 });
        }
        candidates.push({ name: 'page-centre', x: pageRect.left + pageRect.width / 2, y: pageRect.top + pageRect.height / 2 });
        const tried: any[] = [];
        let chosen: { name: string; x: number; y: number } | null = null;
        for (const c of candidates) {
            const pos = positionAt(c.x, c.y);
            tried.push({ name: c.name, point: [Math.round(c.x), Math.round(c.y)], position: pos ? (pos.error ?? { page: pos.pageIndex }) : null });
            if (pos && !pos.error && !chosen) chosen = c;
        }
        const chain = (start: Element | null) => {
            const out: string[] = [];
            let e: Element | null = start;
            while (e && out.length < 7) {
                const el: Element = e;
                out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`);
                e = el.parentElement;
            }
            return out;
        };
        const point = chosen ?? candidates[0];
        const target = doc.elementFromPoint(point.x, point.y) ?? pageDiv;
        const mouseDown = new MouseEventCtor('mousedown', inRealm({
            clientX: point.x, clientY: point.y, button: 0, detail: 2, bubbles: true, cancelable: true,
        }));
        const toolBefore = primaryView._tool?.type ?? null;
        target.dispatchEvent(mouseDown);
        const actionAfterDown = primaryView.action?.type ?? null;
        const modeAfterDown = primaryView.action?.mode ?? null;
        const rangesAfterDown = primaryView._selectionRanges?.length ?? null;
        target.dispatchEvent(new PointerEventCtor('pointerup', inRealm({
            clientX: point.x, clientY: point.y, button: 0, pointerType: 'mouse', bubbles: true, cancelable: true,
        })));
        (request as any).__diag = {
            chars_loaded: primaryView._pdfPages?.[0]?.chars?.length ?? 0,
            pages: win.PDFViewerApplication?.pdfViewer?._pages?.length ?? null,
            page_rect: [Math.round(pageRect.left), Math.round(pageRect.top), Math.round(pageRect.width), Math.round(pageRect.height)],
            tried,
            chosen: chosen?.name ?? null,
            target_chain: chain(target),
            elements_from_point: Array.from(doc.elementsFromPoint(point.x, point.y)).slice(0, 6).map((e: any) => `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).split(' ')[0] : ''}`),
            tool: toolBefore,
            action_after_down: actionAfterDown,
            mode_after_down: modeAfterDown,
            ranges_after_down: rangesAfterDown,
            pointer_down_flag: primaryView._pointerDownTriggered ?? null,
        };
    } else if (action === 'popup-key') {
        /*
         * Press a key in the selection popup's own field and report what is
         * left standing. The reader's keyboard manager listens on its window in
         * the capture phase, so it sees the key before the field does and no
         * handler on the field can stop it; whether the popup survives depends
         * entirely on the manager's own guards recognising the field. This is
         * the only way to check that from outside the reader.
         *
         * `simulate_textarea` swaps in a textarea for the dispatch — the element
         * the field used to be — so the difference can be measured on the live
         * reader rather than argued from its source.
         */
        const outerDoc: Document | undefined = reader._iframeWindow?.document;
        let field = outerDoc?.querySelector('.alphain-selection-input') as HTMLInputElement | HTMLTextAreaElement | null;
        if (!field || !outerDoc) {
            return { ok: false, error: 'selection popup field not present — run action "select" first' };
        }
        let stand_in: HTMLTextAreaElement | null = null;
        if (request?.simulate_textarea) {
            stand_in = outerDoc.createElement('textarea');
            stand_in.className = 'alphain-selection-input-stand-in';
            field.parentElement?.appendChild(stand_in);
            field = stand_in;
        }
        field.focus();
        field.value = String(request?.text ?? 'ab');
        const key = String(request?.key ?? 'Backspace');
        const KeyboardEventCtor = (reader._iframeWindow as any).KeyboardEvent as typeof KeyboardEvent;
        const event = new KeyboardEventCtor('keydown', cloneIntoWindow(reader._iframeWindow, {
            key,
            code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
            bubbles: true,
            cancelable: true,
            metaKey: request?.meta === true,
            ctrlKey: request?.ctrl === true,
        }));
        field.dispatchEvent(event);
        const defaultPrevented = event.defaultPrevented;
        await new Promise((resolve) => setTimeout(resolve, Number(request?.settle_ms ?? 300)));
        const internal = reader._internalReader;
        const attached = outerDoc.contains(field);
        const value = attached ? field.value : null;
        stand_in?.remove();
        return {
            ok: true,
            action,
            key,
            field: field.nodeName.toLowerCase(),
            // The two guards the reader's keyboard manager applies.
            guard_matches: !!field.closest('input, .label-popup'),
            text_box: field.nodeName === 'INPUT' && (field as HTMLInputElement).type === 'text',
            default_prevented: defaultPrevented,
            field_attached: attached,
            field_value: value,
            popup_present: !!outerDoc.querySelector('.selection-popup'),
            selected_annotation_ids: internal?._state?.selectedAnnotationIDs ?? null,
            selection_ranges: primaryView._selectionRanges?.length ?? null,
        };
    }

    // Let the reader's own selectionchange handler run before reporting.
    await new Promise((resolve) => setTimeout(resolve, Number(request?.settle_ms ?? 250)));

    const domSelection = win?.getSelection?.();
    return {
        ok: true,
        action,
        reader_type: reader.type,
        selection_ranges: primaryView._selectionRanges?.length ?? null,
        selection_ranges_text: (primaryView._selectionRanges ?? [])
            .map((r: any) => r.text).join(' ').slice(0, 80),
        dom_range_count: domSelection?.rangeCount ?? null,
        dom_is_collapsed: domSelection?.isCollapsed ?? null,
        dom_text_length: (domSelection?.toString?.() ?? '').length,
        atom_selection: store.get(readerTextSelectionAtom),
        popup_field_present: !!reader._iframeWindow?.document?.querySelector('.alphain-selection-input'),
        // The reader's own position for the selection, as `selection-chat`
        // wants it, so a probe can ask a real anchored question.
        selection_position: plainCopy(primaryView._selectionRanges?.[0]?.position),
        ...((request as any)?.__diag ? { diag: (request as any).__diag } : {}),
    };
}

/**
 * Open the library item context menu repeatedly and report what breaks.
 *
 * Right-clicking an item worked once and then stopped opening at all — with
 * the plugin disabled, or with Beaver in its place, it kept working. A popup
 * that refuses to reopen is almost always one whose previous cycle never
 * finished, so this drives the cycle itself: open, hide, open again, and
 * report the popup's state and any error at each step.
 */
export async function handleTestItemMenuProbeHttpRequest(request: any): Promise<any> {
    const win: any = Zotero.getMainWindow();
    const doc = win?.document;
    const popup = doc?.getElementById('zotero-itemmenu');
    if (!popup) return { ok: false, error: 'zotero-itemmenu not found' };

    const rounds = Math.max(1, Math.min(5, Number(request?.rounds ?? 3)));
    const settle = (ms: number) => new Promise((r) => win.setTimeout(r, ms));
    const report: any[] = [];

    // Anything thrown out of the async build path lands here rather than in a
    // log nobody is reading.
    const errors: string[] = [];
    const onError = (event: any) => errors.push(`error: ${event?.message ?? event}`);
    const onRejection = (event: any) => errors.push(`unhandled rejection: ${event?.reason}`);
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);

    try {
        for (let round = 1; round <= rounds; round += 1) {
            const entry: any = { round, stateBefore: popup.state, errors: [] };
            const before = errors.length;
            try {
                /*
                 * Go through Zotero's own builder, not just `openPopup`.
                 *
                 * A synthetic open fires `popupshowing`, but the plugin rows are
                 * added at the end of `ZoteroPane.buildItemContextMenu`, which is
                 * async — awaiting the locate menu before it calls
                 * `MenuManager.updateMenuPopup`. Calling it directly is the only
                 * way to see the rows a real right-click would produce.
                 */
                const pane = (win as any).ZoteroPane;
                if (typeof pane?.buildItemContextMenu === 'function') {
                    await pane.buildItemContextMenu({ target: popup, currentTarget: popup });
                }
                popup.openPopup(doc.documentElement, 'overlap', 40, 40, true, false, null);
            } catch (error) {
                entry.openError = String(error);
            }
            await settle(Number(request?.settle_ms ?? 700));
            entry.stateAfterOpen = popup.state;
            entry.totalRows = popup.children.length;
            entry.customRows = popup.querySelectorAll('.zotero-custom-menu').length;
            entry.ourMenus = Array.from(
                popup.querySelectorAll('menu, menuitem'),
            ).filter((el: any) => String(el.dataset?.l10nId ?? '').includes('alphainz'))
                .map((el: any) => ({
                    l10nId: el.dataset.l10nId,
                    label: el.getAttribute('label'),
                    children: el.querySelector('menupopup')?.children.length ?? 0,
                }));
            // Rows Zotero's grouping made, and rows with no label at all.
            entry.unlabelled = Array.from(popup.querySelectorAll('menu, menuitem'))
                .filter((el: any) => !el.getAttribute('label') && el.getAttribute('hidden') !== 'true')
                .map((el: any) => el.dataset?.l10nId ?? el.id ?? '(anonymous)');
            try {
                popup.hidePopup();
            } catch (error) {
                entry.hideError = String(error);
            }
            await settle(300);
            entry.stateAfterHide = popup.state;
            entry.errors = errors.slice(before);
            report.push(entry);
        }
    } finally {
        win.removeEventListener('error', onError);
        win.removeEventListener('unhandledrejection', onRejection);
    }

    // Every l10n id the context menu asks for, and whether it resolves.
    //
    // An id the FTL does not define is not a cosmetic problem here: the
    // locale bundle failing to resolve a menu row's label is what breaks
    // Zotero's right-click menu outright, which is why this is checked.
    const l10nIDs = [
        'alphainz-context-menu-submenu',
        'alphainz-context-menu-context-header',
        'alphainz-context-menu-action',
        'alphainz-context-menu-add-action',
    ];
    const l10n: Record<string, string | null> = {};
    for (const id of l10nIDs) {
        try {
            const messages = await doc.l10n.formatMessages([
                { id, args: { context: 'x', title: 'x' } },
            ]);
            l10n[id] = messages?.[0]?.attributes?.find((a: any) => a.name === 'label')?.value
                ?? messages?.[0]?.value
                ?? null;
        } catch (error) {
            l10n[id] = `THREW: ${error}`;
        }
    }

    return { ok: true, rounds: report, allErrors: errors, l10n };
}
