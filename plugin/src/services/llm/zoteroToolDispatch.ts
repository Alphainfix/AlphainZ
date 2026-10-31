/**
 * Dispatch tool calls to Zotero's tool executors.
 *
 * The executors are the untouched `handle<Tool>Request` functions in
 * `src/services/agentDataProvider/`. Upstream reached them over a WebSocket
 * round-trip through Beaver's cloud; here they are reached directly.
 *
 * Two transports, one mapping:
 *  - `httpToolDispatcher` posts to the plugin's local HTTP surface. Used from
 *    outside Zotero — that is how a live test drives real library data without
 *    a Zotero runtime in-process.
 *  - `directToolDispatcher` calls a handler passed in by the caller. Used inside
 *    the plugin, where the functions are simply in scope.
 *
 * The mapping and the result shaping are shared, so what a live test exercises
 * is what the plugin runs.
 */

import { buildToolRequest, TOOL_SPECS, TOOL_SPECS_BY_NAME } from './toolSchemas';
import type { ToolDispatcher, ToolImagesResult } from './agentLoop';
import { hasLocators, renderPageWithLocators } from './sentenceLocators';

/**
 * Local HTTP path serving each tool.
 *
 * Zotero's server namespaces these under `/alphainz/` — the paths predate the
 * rename and are load-bearing for the existing live-test helpers, so they stay
 * as they are.
 */
export const TOOL_ENDPOINTS: Readonly<Record<string, string>> = {
    item_search_by_topic: '/alphainz/search/topic',
    item_search_by_metadata: '/alphainz/search/metadata',
    get_metadata: '/alphainz/library/metadata',
    list_collections: '/alphainz/library/collections',
    list_libraries: '/alphainz/library/libraries',
    list_tags: '/alphainz/library/tags',
    find_annotations: '/alphainz/library/find-annotations',
    read_note: '/alphainz/note/read',
    view_page_images: '/alphainz/attachment/page-images',
    read_document: '/alphainz/attachment/document',
    search_in_document: '/alphainz/attachment/search',
    list_items: '/alphainz/library/list',
};

/** Tools whose result is images rather than JSON. */
export const IMAGE_TOOLS = new Set(['view_page_images', 'view_attachment_image']);


/** Guard against one call filling the whole context with pixels. */
const MAX_IMAGES_PER_CALL = 6;

/**
 * Convert a page-images response into the loop's image-result shape.
 *
 * `total_pages` is worth passing through: without it a model that asked for
 * page 40 of a 12-page paper gets an empty array and no way to tell that from
 * "the page is blank".
 */
/** One rendered image item, in the same envelope a page render uses. */
export function attachmentImageToToolResult(raw: any): ToolImagesResult {
    const image = raw?.image;
    const base64 = String(image?.image_data ?? '');
    if (!base64) {
        return { kind: 'tool-images', text: 'That attachment could not be rendered as an image.', images: [] };
    }
    const size = image?.width && image?.height ? ` (${image.width}×${image.height})` : '';
    return {
        kind: 'tool-images',
        text: `Rendered the attached image${size}.`,
        images: [{
            mimeType: image?.format === 'png' ? 'image/png' : 'image/jpeg',
            base64,
            label: 'attached image',
        }],
    };
}

export function pageImagesToToolResult(raw: any): ToolImagesResult {
    const pages = Array.isArray(raw?.pages) ? raw.pages : [];
    const kept = pages.slice(0, MAX_IMAGES_PER_CALL);

    const lines: string[] = [];
    if (kept.length === 0) {
        lines.push('No pages were rendered.');
        if (typeof raw?.total_pages === 'number') {
            lines.push(`The document has ${raw.total_pages} pages.`);
        }
    } else {
        // In the numbering the request used — the page of the file, as
        // `read_document` numbers it — with the printed label beside it when
        // the two differ, so page 12 printed "2" does not read as the wrong page.
        const numbers = kept.map((p: any) => {
            const label = typeof p.page_label === 'string' ? p.page_label : '';
            if (p.page_number == null) return label;
            return label && label !== String(p.page_number)
                ? `${p.page_number} (printed ${label})`
                : String(p.page_number);
        }).join(', ');
        lines.push(`Rendered page${kept.length === 1 ? '' : 's'} ${numbers}.`);
        if (typeof raw?.total_pages === 'number') {
            lines.push(`Document has ${raw.total_pages} pages total.`);
        }
        if (pages.length > kept.length) {
            // Silent truncation would read as "that was all of them".
            lines.push(`${pages.length - kept.length} further page(s) omitted to save context.`);
        }
    }

    return {
        kind: 'tool-images',
        text: lines.join(' '),
        images: kept.map((page: any) => ({
            mimeType: page.format === 'png' ? 'image/png' : 'image/jpeg',
            base64: String(page.image_data ?? ''),
            label: `page ${page.page_label ?? page.page_number}`,
        })),
    };
}

/** The library tools an HTTP dispatcher can reach: those with a local route. */
export const ZOTERO_TOOL_NAMES = Object.keys(TOOL_ENDPOINTS);

/**
 * Every library tool the in-plugin dispatcher can run, and so the set a run
 * offers before agentConfig drops what the current setup cannot use.
 *
 * Wider than `ZOTERO_TOOL_NAMES`: `get_annotations` and
 * `view_attachment_image` have executors but no local HTTP route. The message
 * preamble names both — the rest of a paper's highlights, an attached
 * picture — so leaving them out of a run leaves the model told to call tools
 * it was never given.
 */
export const LIBRARY_TOOL_NAMES: readonly string[] = TOOL_SPECS.map((spec) => spec.name);

/** Pixels of an image attached to the message, as `attachedImagesFromPrompt` collects them. */
export interface AttachedImage {
    mimeType: string;
    base64: string;
}

/**
 * What the in-plugin dispatcher needs to know about the run it serves.
 *
 * Both fields are optional and leave today's behaviour when absent.
 */
export interface DataProviderDispatcherOptions {
    /**
     * Whether the chosen model reads images. `false` refuses the image tools —
     * a text-only endpoint handed their pixels either rejects the next request
     * outright or drops them, and the model then describes a page it never
     * saw — and leaves the page-image hint out of an unreadable scan's error.
     */
    readsImages?: boolean;
    /**
     * Images attached to this message, by the id the message names them with.
     *
     * An area the user boxed in the reader is an annotation, not a file, so
     * the attachment-image executor cannot open it; its pixels travel with the
     * message instead, and `view_attachment_image` serves them from here.
     */
    attachedImages?: ReadonlyMap<string, AttachedImage>;
}

/** The refusal a text-only model gets for an image tool. */
function imageToolUnavailable(name: string): Error {
    return new Error(
        `${name} is not available: the current model reads text only, so it cannot look at images. `
        + 'Tell the user the current model cannot see images; a model marked "reads figures" in the '
        + 'model picker can.',
    );
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:23119';

let requestCounter = 0;
/**
 * Request ids only need to be unique within a run and correlate a response to
 * its call, so a counter beats a random id: it keeps a transcript readable and
 * stays deterministic under test.
 */
function nextRequestId(toolName: string): string {
    requestCounter += 1;
    return `${toolName}-${requestCounter}`;
}

/**
 * Character budget for one `read_document` call.
 *
 * A journal page is roughly 3–4k characters of markdown, so this is about eight
 * pages — enough to read an introduction and method, or a whole short paper,
 * without one call claiming the entire context window. The model is told what
 * was left out and can ask for specific pages, which is cheap: extraction runs
 * once and the payload is cached.
 */
const DOCUMENT_CHARS_PER_CALL = 30_000;

/** Hit pages to report per `search_in_document` call. */
const MAX_SEARCH_PAGES = 12;

/**
 * Turn an extracted document into bounded, page-labelled text.
 *
 * Page selection happens here rather than on the wire because the extractor has
 * no page parameter — it always processes the whole file. Truncation is stated
 * rather than silent: a model that cannot tell "the paper stops here" from "the
 * excerpt stops here" will confidently answer that something is absent.
 */
export function shapeDocumentResult(
    raw: any,
    args: Record<string, unknown> = {},
    options: { pageImages?: boolean } = {},
): unknown {
    const document = raw?.result?.document;
    const pages: any[] = Array.isArray(document?.pages) ? document.pages : [];
    const totalPages = document?.pageCount ?? raw?.total_pages ?? pages.length;

    if (pages.length === 0) {
        // A PDF of scanned images extracts to nothing. Saying so beats returning
        // an empty string, which reads as a blank paper. The way out is named
        // for a model that can take it: pointing a text-only model at page
        // images sends it into a tool whose pixels its endpoint cannot read.
        throw new Error(
            `No text could be extracted from this attachment${
                totalPages ? ` (${totalPages} pages)` : ''
            }. It is probably a scan with no text layer — ${
                options.pageImages === false
                    ? 'the current model reads text only, so it cannot read this file; tell the user so.'
                    : 'view_page_images can still read it, if the current model reads images.'
            }`,
        );
    }

    const attachmentId = typeof args.attachment_id === 'string' ? args.attachment_id : '';
    const requested = Array.isArray(args.pages)
        ? new Set(args.pages.map((n) => Number(n)).filter((n) => Number.isFinite(n)))
        : null;
    // `index` is 0-based on the wire; the model speaks in 1-based page numbers.
    const candidates = requested
        ? pages.filter((page) => requested.has((page?.index ?? 0) + 1))
        : pages;

    if (requested && candidates.length === 0) {
        throw new Error(
            `None of the requested pages exist. This document has ${totalPages} pages.`,
        );
    }

    /*
     * Structured pages render with a locator on every sentence; anything else
     * (EPUB, a snapshot, plain text, or a PDF whose structured pass degraded)
     * still has its markdown, and falls back to it.
     */
    const locatable = hasLocators(document);

    const included: any[] = [];
    let used = 0;
    for (const page of candidates) {
        const text = locatable
            ? renderPageWithLocators(page)
            : (typeof page?.markdown === 'string' ? page.markdown : '');
        if (included.length > 0 && used + text.length > DOCUMENT_CHARS_PER_CALL) break;
        const pageNumber = (page?.index ?? 0) + 1;
        included.push({
            page: pageNumber,
            ...(page?.label && page.label !== String(pageNumber)
                ? { label: page.label }
                : {}),
            /*
             * The marker for this page, written out.
             *
             * The model is told the citation syntax in the system prompt and
             * writes the page number in prose anyway. `create_highlight` does
             * not have that problem — it returns a finished tag, and the model
             * pastes it. So the tools that hand back page text do the same.
             */
            ...(attachmentId
                ? { cite: `<citation id="${attachmentId}" page="${pageNumber}"/>` }
                : {}),
            text,
        });
        used += text.length;
    }

    const omitted = candidates.length - included.length;
    const first = included[0]?.page;
    const last = included[included.length - 1]?.page;

    return {
        total_pages: totalPages,
        pages_returned: first === last ? `${first}` : `${first}-${last}`,
        ...(locatable
            ? {
                locators:
                    'Every sentence is labelled `[s12]`, every paragraph `[p4]`, every heading '
                    + '`[heading2]`. To highlight or quote something, pass that label to '
                    + '`create_highlight` as `locator` — it places the mark exactly, with no '
                    + 'text matching and nothing to misquote. Use a range like `s12-s13` when one '
                    + 'sentence was split across two labels. Do not copy the labels into your '
                    + 'answer as text; they belong in tool arguments and in the `loc` of a '
                    + 'citation tag.',
            }
            : {}),
        ...(attachmentId
            ? {
                citing:
                    'Each page carries a `cite` string. Put the one for the page you used '
                    + 'immediately after the sentence that uses it, instead of writing the page '
                    + 'number in prose.'
                    + (locatable
                        ? ` To point the reader at the exact sentence(s), add their labels as loc: `
                            + `<citation id="${attachmentId}" page="${first ?? 1}" loc="s12"/> or `
                            + `loc="s12-s13" for two sentences. Do this whenever a statement rests on `
                            + `specific sentences; the click then lands on them and flashes them. `
                            + `Use only labels printed above, on the page you cite.`
                        : ''),
            }
            : {}),
        ...(omitted > 0
            ? {
                  truncated: true,
                  note: `${omitted} more page(s) were not included. Call read_document again with pages: [...] to read them.`,
              }
            : {}),
        pages: included,
    };
}

/**
 * Reduce in-PDF search hits to pages and matched text.
 *
 * The wire response carries a bounding box, a text role and a weight per hit.
 * None of that means anything to a model reading page numbers, and it is most of
 * the payload, so only the page, its label, the match count and the matched
 * strings survive.
 */
export function shapeDocumentSearchResult(
    raw: any,
    args: Record<string, unknown> = {},
): unknown {
    const pages: any[] = Array.isArray(raw?.pages) ? raw.pages : [];
    const kept = pages.slice(0, MAX_SEARCH_PAGES);
    const attachmentId = typeof args.attachment_id === 'string' ? args.attachment_id : '';

    /*
     * The bounding boxes stay stripped.
     *
     * They were briefly forwarded so a citation could point at the matched
     * phrase rather than the page — the same trick that makes a highlight's
     * citation sentence-level. Measured on real runs, it was worse: a hit here
     * is a line fragment, not a sentence ("and dough rise time t2] and
     * yeast cell population (with"), and a page usually has several, so the
     * click would land on whichever matched first rather than on the passage
     * the claim rests on. A citation that highlights the wrong phrase is worse
     * than one that only turns to the page.
     */

    return {
        query: raw?.query,
        total_matches: raw?.total_matches ?? 0,
        pages_with_matches: raw?.pages_with_matches ?? pages.length,
        total_pages: raw?.total_pages ?? null,
        ...(pages.length > kept.length
            ? { note: `Showing the ${kept.length} best-matching pages of ${pages.length}.` }
            : {}),
        matches: kept.map((page) => ({
            page: (page?.page_index ?? 0) + 1,
            ...(page?.label ? { label: page.label } : {}),
            // Same reason as read_document: a finished marker gets pasted, a
            // rule about markers gets ignored.
            ...(attachmentId
                ? {
                    cite: `<citation id="${attachmentId}" page="${(page?.page_index ?? 0) + 1}"/>`,
                }
                : {}),
            match_count: page?.match_count ?? 0,
            excerpts: (Array.isArray(page?.hits) ? page.hits : [])
                .map((hit: any) => hit?.matched_text)
                .filter((text: unknown): text is string => typeof text === 'string' && !!text),
        })),
    };
}

/**
 * Trim a handler response down to what the model can use.
 *
 * The executors answer with the full wire response — envelope fields, per-row
 * attachment trees, base64 image payloads. Forwarding all of it wastes most of
 * the context window on scaffolding, so the envelope is dropped and an `error`
 * is surfaced as a failure rather than buried in a field the model may skip.
 */
export function shapeToolResult(toolName: string, raw: any): unknown {
    if (raw && typeof raw === 'object') {
        // A handler reports failure in-band, with HTTP 200 and an `error` field.
        // Left as data, a "library excluded" or "not found" reads as an empty
        // result — that is, as a real answer.
        if (typeof raw.error === 'string' && raw.error) {
            throw new Error(raw.error_code ? `${raw.error} (${raw.error_code})` : raw.error);
        }
        const { event, request_id, error, error_code, ...rest } = raw;
        return Object.keys(rest).length > 0 ? rest : raw;
    }
    return raw;
}

export interface HttpDispatcherOptions {
    /** Defaults to Zotero's local server. */
    baseUrl?: string;
    fetchImpl?: (url: string, init: Record<string, any>) => Promise<any>;
    signal?: AbortSignal;
    /** Extra tools handled in-process rather than over HTTP (e.g. web search). */
    extraTools?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
}

/**
 * A dispatcher that reaches the tool executors over the plugin's local HTTP
 * surface. Requires a running Zotero with a development build installed.
 */
export function httpToolDispatcher(options: HttpDispatcherOptions = {}): ToolDispatcher {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? (globalThis as any).fetch;
    const extraTools = options.extraTools ?? {};

    return async (name, args) => {
        const extra = extraTools[name];
        if (extra) return extra(args);

        const path = TOOL_ENDPOINTS[name];
        if (!path) {
            throw new Error(
                `Tool "${name}" has no local endpoint. Available: ${[
                    ...ZOTERO_TOOL_NAMES,
                    ...Object.keys(extraTools),
                ].join(', ')}.`,
            );
        }

        // Throws for an unknown tool or a missing required argument; the agent
        // loop turns that into a tool result the model can correct from.
        const body = buildToolRequest(name, args, nextRequestId(name));

        const response = await fetchImpl(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: options.signal,
        });

        if (!response.ok) {
            throw new Error(`${name} failed: HTTP ${response.status} ${response.statusText ?? ''}`);
        }

        const text = await response.text();
        // "No endpoint found" is Zotero's plain-text 404 for an unregistered
        // path — a much more useful message than a JSON parse error.
        if (!text.trim().startsWith('{')) {
            throw new Error(`${name} returned a non-JSON response: ${text.slice(0, 200)}`);
        }
        return shapeAny(name, JSON.parse(text), args);
    };
}

/**
 * Shape a handler response, routing image tools to the image path.
 *
 * Shared by both transports so a live test and the plugin agree on what the
 * model ends up seeing.
 */
function shapeAny(
    name: string,
    raw: any,
    args: Record<string, unknown> = {},
    options: { pageImages?: boolean } = {},
): unknown {
    // An in-band error has to surface as a failure for every tool below, or an
    // unrendered page reads as a blank one and a failed extraction as an empty
    // paper.
    if (IMAGE_TOOLS.has(name) || name === 'read_document' || name === 'search_in_document') {
        if (typeof raw?.error === 'string' && raw.error) {
            throw new Error(raw.error_code ? `${raw.error} (${raw.error_code})` : raw.error);
        }
    }
    // One image rather than a page range, and a different response shape, so it
    // is reshaped into the same envelope before the shared image path sees it.
    if (name === 'view_attachment_image') return attachmentImageToToolResult(raw);
    if (IMAGE_TOOLS.has(name)) return pageImagesToToolResult(raw);
    // Shaped rather than passed through: the raw payloads here are the two
    // largest of any tool, and most of both is scaffolding.
    if (name === 'read_document') return shapeDocumentResult(raw, args, options);
    if (name === 'search_in_document') return shapeDocumentSearchResult(raw, args);
    return shapeToolResult(name, raw);
}

export type ToolHandler = (request: Record<string, unknown>) => Promise<unknown>;

/**
 * A dispatcher that calls handlers directly. This is the in-plugin transport:
 * the caller supplies `{ [toolName]: handle<Tool>Request }` and no HTTP, no
 * WebSocket and no cloud sits in the path.
 */
export function directToolDispatcher(
    handlers: Record<string, ToolHandler>,
    extraTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {},
): ToolDispatcher {
    return async (name, args) => {
        const extra = extraTools[name];
        if (extra) return extra(args);

        const handler = handlers[name];
        if (!handler) {
            throw new Error(
                `Tool "${name}" has no handler. Available: ${[
                    ...Object.keys(handlers),
                    ...Object.keys(extraTools),
                ].join(', ')}.`,
            );
        }
        const request = buildToolRequest(name, args, nextRequestId(name));
        return shapeAny(name, await handler(request), args);
    };
}

/**
 * A dispatcher backed by the plugin's existing data-provider map.
 *
 * `createZoteroDataProvider()` already assembles every executor keyed by wire
 * event name — the same map the WebSocket path fed. Reusing it means the local
 * loop and the old transport run identical code, so nothing can drift between
 * what a live test exercises and what the sidebar does.
 */
export interface DataProviderEntry {
    handle: (event: any) => Promise<Record<string, any> | unknown>;
}

/** Marker key used by `PreparedJsonMessage` to carry pre-serialized fields. */
const PREPARED_MARKER = 'envelope';

/**
 * Flatten a provider response.
 *
 * An executor may answer with a plain object or with a `PreparedJsonMessage`,
 * which splits the payload into an envelope plus already-stringified fields to
 * avoid re-serializing a large blob for the socket. There is no socket here, so
 * the raw fields are parsed back and merged — dropping them would silently lose
 * exactly the big payloads (document text, page images) worth optimizing.
 */
export function flattenProviderResponse(raw: any): any {
    if (!raw || typeof raw !== 'object' || !(PREPARED_MARKER in raw)) return raw;

    const merged: Record<string, any> = { ...(raw.envelope ?? {}) };
    for (const [key, value] of Object.entries(raw.rawFields ?? {})) {
        try {
            merged[key] = JSON.parse(value as string);
        } catch {
            // A field that will not parse is more useful as its raw text than
            // as a dropped key.
            merged[key] = value;
        }
    }
    return merged;
}

export function dataProviderToolDispatcher(
    provider: Record<string, DataProviderEntry>,
    extraTools: Record<
        string,
        (args: Record<string, unknown>, context: { toolCallId: string }) => Promise<unknown>
    > = {},
    options: DataProviderDispatcherOptions = {},
): ToolDispatcher {
    return async (name, args, context) => {
        const extra = extraTools[name];
        // Forwarded so a tool can address the call it is running under — the
        // write tools attach their approval card to it.
        if (extra) return extra(args, context);

        // The loop runs whatever tool the model names, offered or not, and a
        // tool result can suggest one — so the refusal lives here.
        if (IMAGE_TOOLS.has(name) && options.readsImages === false) {
            throw imageToolUnavailable(name);
        }
        if (name === 'view_attachment_image') {
            const attached = options.attachedImages?.get(String(args?.attachment_id ?? '').trim());
            if (attached) {
                return {
                    kind: 'tool-images',
                    text: 'The image the user attached to their message.',
                    images: [{ ...attached, label: 'attached image' }],
                } satisfies ToolImagesResult;
            }
        }

        const spec = TOOL_SPECS_BY_NAME.get(name);
        if (!spec) {
            throw new Error(
                `Tool "${name}" is not in the registry. Available: ${[
                    ...TOOL_SPECS_BY_NAME.keys(),
                    ...Object.keys(extraTools),
                ].join(', ')}.`,
            );
        }

        const entry = provider[spec.event];
        if (!entry) {
            throw new Error(
                `No executor registered for "${name}" (event ${spec.event}). This build cannot run that tool.`,
            );
        }

        const request = buildToolRequest(name, args, nextRequestId(name));
        return shapeAny(name, flattenProviderResponse(await entry.handle(request)), args, {
            pageImages: options.readsImages !== false,
        });
    };
}
