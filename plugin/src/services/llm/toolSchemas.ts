/**
 * Tool schemas and request construction.
 *
 * Beaver's tool executors take a fully-formed `WS<Tool>Request`: an envelope
 * (`event`, `request_id`) plus fields that are *required* in the type but that
 * no model should have to supply — paging bounds, sort keys, include flags. The
 * server used to fill those in. This module is that missing half, so
 * `toolRegistry` can stay a thin adapter over the untouched handlers.
 *
 * Pure: no Zotero globals, so the defaulting rules are unit tested directly.
 */

import { resolveObjectIdReference, UNRESOLVED_LIBRARY_ID } from '@beaver/agent-core/identity/libraryRef';
import type { ToolSchema } from './types';

/** A model-facing tool bound to one wire event. */
export interface ToolSpec {
    name: string;
    /** The `event` value the handler dispatches on. */
    event: string;
    schema: ToolSchema;
    /**
     * Fields required by the request type but not exposed to the model.
     * Merged under the model's arguments, so an explicit value still wins.
     */
    defaults: Record<string, unknown>;
    /**
     * Reshape the model's arguments into the wire shape.
     *
     * For tools whose natural argument for a model is not the shape the wire
     * type wants — an attachment is `"u-UH6CTDV5"` everywhere the model sees
     * one, but the request wants `{library_id, zotero_key}`. Doing the split
     * here beats asking the model to do it and checking that it did.
     */
    transformArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Split the composite item id the library surfaces everywhere.
 *
 * Search results and metadata rows identify an attachment as
 * `"<library_ref>-<zotero_key>"` (`"u-UH6CTDV5"`, `"g12345-ABCD1234"`), so that
 * string is what a model has to work with. `library_ref` "u" is the personal
 * library, id 1 on every computer.
 *
 * A group's `library_ref` carries its Zotero group id, which is not its
 * library id here: that is a local row id, resolved through the host's
 * library-identity seam, and `UNRESOLVED_LIBRARY_ID` (0) when this computer
 * has no such group. Resolution by `library_ref` works either way, but
 * anything keyed on the numeric id, such as a run's grant to edit a note it
 * created, needs the local one.
 */
export function parseCompositeItemId(
    composite: string,
): { zotero_key: string; library_id: number; library_ref: string } | null {
    const match = /^(u|g[1-9]\d*)-([A-Z0-9]+)$/.exec(String(composite).trim());
    if (!match) return null;
    const [, ref, key] = match;
    if (ref === 'u') return { zotero_key: key, library_id: 1, library_ref: ref };
    const resolved = resolveObjectIdReference(`${ref}-${key}`);
    return {
        zotero_key: key,
        library_id: resolved?.library_id || UNRESOLVED_LIBRARY_ID,
        library_ref: ref,
    };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const pagingProperties = {
    limit: {
        type: 'integer',
        description: `Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
    },
    offset: { type: 'integer', description: 'Rows to skip, for paging.', minimum: 0 },
} as const;

export const TOOL_SPECS: ToolSpec[] = [
    {
        name: 'item_search_by_topic',
        event: 'item_search_by_topic_request',
        defaults: { limit: DEFAULT_LIMIT, offset: 0 },
        schema: {
            name: 'item_search_by_topic',
            description:
                'Semantic search over the library by topic. Use this when looking for papers about a subject rather than by a known title or author. Searches titles and abstracts.',
            parameters: {
                type: 'object',
                properties: {
                    topic_query: {
                        type: 'string',
                        description: 'A concise topic phrase, 2-8 words.',
                    },
                    author_filter: {
                        type: 'array',
                        items: { type: 'string' },
                        description: "Author last names; results match any of them.",
                    },
                    year_min: { type: 'integer', description: 'Earliest publication year.' },
                    year_max: { type: 'integer', description: 'Latest publication year.' },
                    tags_filter: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Tag names; results match any of them.',
                    },
                    ...pagingProperties,
                },
                required: ['topic_query'],
            },
        },
    },
    {
        name: 'item_search_by_metadata',
        event: 'item_search_by_metadata_request',
        defaults: { limit: DEFAULT_LIMIT, offset: 0 },
        schema: {
            name: 'item_search_by_metadata',
            description:
                'Search the library by bibliographic fields — title, author, publication, year. Use this when the user names a specific paper or author. Supplying several fields narrows the result (AND).',
            parameters: {
                type: 'object',
                properties: {
                    title_query: {
                        type: 'string',
                        description: 'Keyword or phrase from the title (substring match).',
                    },
                    author_query: {
                        type: 'string',
                        description: 'Author name (substring match).',
                    },
                    publication_query: {
                        type: 'string',
                        description: 'Journal or publication name (substring match).',
                    },
                    item_type_filter: {
                        type: 'string',
                        description: 'Restrict to an item type, e.g. "journalArticle".',
                    },
                    year_min: { type: 'integer', description: 'Earliest publication year.' },
                    year_max: { type: 'integer', description: 'Latest publication year.' },
                    ...pagingProperties,
                },
                required: [],
            },
        },
    },
    {
        name: 'get_metadata',
        event: 'get_metadata_request',
        // Both include flags are required by the type; attachments and notes
        // are the common need when the model is inspecting specific items.
        defaults: { include_attachments: true, include_notes: false, detail: 'full' },
        schema: {
            name: 'get_metadata',
            description:
                'Full bibliographic metadata for specific library items, by item id. Use after a search to inspect candidates.',
            parameters: {
                type: 'object',
                properties: {
                    item_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Item ids from a previous search result.',
                    },
                    include_notes: {
                        type: 'boolean',
                        description: 'Include child notes. Off by default; they can be long.',
                    },
                },
                required: ['item_ids'],
            },
        },
    },
    {
        name: 'list_collections',
        event: 'list_collections_request',
        defaults: {
            include_item_counts: true,
            recursive: true,
            limit: DEFAULT_LIMIT,
            offset: 0,
        },
        schema: {
            name: 'list_collections',
            description:
                "List collections in a library, with item counts, flattened — every row carries `parent_key` so you can rebuild the tree. Use this to understand how the user organizes their work before searching. `item_count` counts only a collection's own items, so a parent with subcollections often reads 0 while holding hundreds; that is not an empty collection.",
            parameters: {
                type: 'object',
                properties: {
                    library_id: {
                        type: 'integer',
                        description: 'Library to list. Omit for the default library.',
                    },
                    parent_collection_key: {
                        type: 'string',
                        description: 'List within this collection only.',
                    },
                    ...pagingProperties,
                },
                required: [],
            },
        },
    },
    {
        name: 'list_libraries',
        event: 'list_libraries_request',
        defaults: {},
        schema: {
            name: 'list_libraries',
            description:
                'List every library available, personal and group. Takes no arguments.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        name: 'list_tags',
        event: 'list_tags_request',
        // `min_item_count` is non-optional on the wire. 1 keeps the list to tags
        // actually applied to something, which is what "the tags I use" means.
        defaults: { min_item_count: 1, limit: MAX_LIMIT, offset: 0 },
        schema: {
            name: 'list_tags',
            description:
                'List tags in use, most frequent first. Useful for learning the vocabulary the user organizes their library with.',
            parameters: {
                type: 'object',
                properties: {
                    library_id: { type: 'integer', description: 'Library to list tags for.' },
                    name_query: {
                        type: 'string',
                        description: 'Keep only tags whose name contains this substring.',
                    },
                    ...pagingProperties,
                },
                required: [],
            },
        },
    },
    {
        name: 'find_annotations',
        event: 'find_annotations_request',
        // sort_by / sort_order / recursive are required by the type but are
        // presentation choices, not something a model should reason about.
        defaults: {
            recursive: true,
            sort_by: 'date_modified',
            sort_order: 'desc',
            limit: DEFAULT_LIMIT,
            offset: 0,
        },
        schema: {
            name: 'find_annotations',
            description:
                "Search the user's highlights and notes across the whole library. Filter by highlighted text, comment text, tag, colour, or type. This is how you find what the user has already marked as important.",
            parameters: {
                type: 'object',
                properties: {
                    text_contains: {
                        type: 'string',
                        description: 'Substring of the highlighted text.',
                    },
                    comment_contains: {
                        type: 'string',
                        description: "Substring of the user's comment on the annotation.",
                    },
                    tag: { type: 'string', description: 'Annotation tag.' },
                    color: {
                        type: 'string',
                        description: 'Highlight colour name, e.g. yellow, blue, green.',
                    },
                    annotation_type: {
                        type: 'string',
                        enum: ['highlight', 'note', 'underline', 'image', 'ink'],
                        description: 'Restrict to one annotation type.',
                    },
                    attachment_id: {
                        type: 'string',
                        description: 'Restrict to annotations on one attachment.',
                    },
                    modified_in_last: {
                        type: 'string',
                        description: 'Relative window, e.g. "7d", "2w", "3m".',
                    },
                    ...pagingProperties,
                },
                required: [],
            },
        },
    },
    {
        name: 'get_annotations',
        event: 'get_annotations_request',
        defaults: { limit: MAX_LIMIT, offset: 0 },
        schema: {
            name: 'get_annotations',
            description:
                'Every annotation on one attachment, in reading order. Use when discussing a specific document the user has marked up.',
            parameters: {
                type: 'object',
                properties: {
                    attachment_id: { type: 'string', description: 'The attachment id.' },
                    ...pagingProperties,
                },
                required: ['attachment_id'],
            },
        },
    },
    {
        name: 'view_page_images',
        event: 'zotero_attachment_page_images_request',
        // The wire type wants a scale or dpi; 150 DPI is the sweet spot for a
        // journal page — figure axes and subscripts stay legible without the
        // payload ballooning. JPEG over PNG for the same reason.
        //
        // Page numbers count from the first page of the file, as they do in
        // `read_document`, `search_in_document`, a citation's `page` and the
        // message preamble. Read as printed labels first, a thesis's page 12
        // would render whichever page is printed "12" — ten pages on, past the
        // roman-numbered front matter — and the result would call it page 12.
        defaults: { dpi: 150, format: 'jpeg', jpeg_quality: 85, prefer_page_labels: false },
        transformArgs: (args) => {
            const { attachment_id, ...rest } = args;
            const reference = parseCompositeItemId(String(attachment_id ?? ''));
            if (!reference) {
                throw new Error(
                    `attachment_id "${attachment_id}" is not a valid id — expected the form "u-ABCD1234" from a search result.`,
                );
            }
            return { ...rest, attachment: reference };
        },
        schema: {
            name: 'view_page_images',
            description:
                'Render pages of a PDF as images and look at them. Use this to read figures, plots, diagrams, equations, tables — anything whose meaning is visual and therefore missing from the extracted text. Request only the pages you need; each one costs context.',
            parameters: {
                type: 'object',
                properties: {
                    attachment_id: {
                        type: 'string',
                        description:
                            'Attachment id exactly as a search or metadata result gave it, e.g. "u-UH6CTDV5".',
                    },
                    pages: {
                        type: 'array',
                        items: { type: 'integer' },
                        description:
                            '1-based page numbers to render, counted from the first page of the file — the numbers '
                            + '`read_document` and `search_in_document` give, not the printed page labels. Keep this '
                            + 'to a handful — three or four at most.',
                    },
                },
                required: ['attachment_id', 'pages'],
            },
        },
    },
    {
        /*
         * Looking at a figure the user attached.
         *
         * `view_page_images` renders a whole page; this renders one image
         * *item* — an area annotation the user drew a box around, or a
         * standalone image attachment. Beaver's backend fetched these on its
         * own when the user attached one, which is why nothing here called the
         * handler even though it has been in the tree the whole time: attaching
         * a figure and asking "what does this show?" got an answer about the
         * paper in general.
         */
        name: 'view_attachment_image',
        event: 'zotero_attachment_image_request',
        defaults: { timeout_seconds: 60 },
        transformArgs: (args) => {
            const { attachment_id, ...rest } = args;
            const reference = parseCompositeItemId(String(attachment_id ?? ''));
            if (!reference) {
                throw new Error(
                    `attachment_id "${attachment_id}" is not a valid id — expected the form "u-ABCD1234".`,
                );
            }
            return { ...rest, attachment: reference };
        },
        schema: {
            name: 'view_attachment_image',
            description:
                'Look at an image the user attached to their message — a figure, table or '
                + 'equation they drew a box around in the reader, or an image file in their '
                + 'library. When the message names an attached image, call this before answering '
                + 'about it: without it you are guessing at what the picture shows.',
            parameters: {
                type: 'object',
                properties: {
                    attachment_id: {
                        type: 'string',
                        description: 'The image or annotation id, exactly as the message named it.',
                    },
                },
                required: ['attachment_id'],
            },
        },
    },
    {
        name: 'read_document',
        event: 'zotero_document_request',
        /*
         * `structured`, not `markdown`.
         *
         * The comment here used to say the opposite — that sentence-level
         * extraction is what citation anchoring needs and the opposite of what
         * a reader needs. The first half was right and the second was wrong,
         * and believing it cost us every misquoted highlight: the model read
         * one extraction and the geometry lived in another, so placing a
         * highlight meant searching for the model's words in a text it had
         * never seen.
         *
         * Structured mode carries the same prose — measured word-for-word
         * against markdown mode on two papers, 100% and 100% — plus an id on
         * every sentence. Showing those ids is what turns placement from a
         * search into a lookup. It is also one extraction instead of two.
         */
        defaults: { mode: 'structured', timeout_seconds: 90 },
        transformArgs: (args) => {
            const { attachment_id, pages, ...rest } = args;
            const reference = parseCompositeItemId(String(attachment_id ?? ''));
            if (!reference) {
                throw new Error(
                    `attachment_id "${attachment_id}" is not a valid id — expected the form "u-ABCD1234" from a search result.`,
                );
            }
            // `pages` is not a wire field: the extractor always processes the
            // whole document (and caches it), so a page selection is applied when
            // the result is shaped. Dropping it here keeps the request valid.
            return { ...rest, attachment: reference };
        },
        schema: {
            name: 'read_document',
            description:
                "Read the text of a PDF in the user's library. This is how you read a paper — prefer it over looking at page images, which cost far more context and only pay off for figures. Long documents come back truncated, and the result says exactly which pages it contains; ask again with `pages` to read further. To find where something is discussed in a long paper, use search_in_document first.",
            parameters: {
                type: 'object',
                properties: {
                    attachment_id: {
                        type: 'string',
                        description:
                            'Attachment id exactly as a search or metadata result gave it, e.g. "u-UH6CTDV5".',
                    },
                    pages: {
                        type: 'array',
                        items: { type: 'integer' },
                        description:
                            'Optional 1-based page numbers to return. Omit to read from the beginning.',
                    },
                },
                required: ['attachment_id'],
            },
        },
    },
    {
        name: 'search_in_document',
        event: 'zotero_attachment_search_request',
        defaults: { max_hits_per_page: 5, timeout_seconds: 60 },
        transformArgs: (args) => {
            const { attachment_id, ...rest } = args;
            const reference = parseCompositeItemId(String(attachment_id ?? ''));
            if (!reference) {
                throw new Error(
                    `attachment_id "${attachment_id}" is not a valid id — expected the form "u-ABCD1234" from a search result.`,
                );
            }
            return { ...rest, attachment: reference };
        },
        schema: {
            name: 'search_in_document',
            description:
                'Find where a phrase appears inside one PDF, and get the page numbers back ranked by relevance. Matching is a literal, case-insensitive phrase match, not semantic — search for a term the paper would actually use. Use this to locate a topic in a long document, then read_document those pages.',
            parameters: {
                type: 'object',
                properties: {
                    attachment_id: {
                        type: 'string',
                        description: 'Attachment id from a search or metadata result, e.g. "u-UH6CTDV5".',
                    },
                    query: {
                        type: 'string',
                        description:
                            'Literal phrase to find. Short and distinctive works best; a long sentence will usually match nothing.',
                    },
                },
                required: ['attachment_id', 'query'],
            },
        },
    },
    {
        name: 'list_items',
        event: 'list_items_request',
        defaults: {
            item_category: 'regular',
            recursive: true,
            sort_by: 'dateAdded',
            sort_order: 'desc',
            limit: DEFAULT_LIMIT,
            offset: 0,
        },
        transformArgs: (args) => ({ ...args, limit: clampLimit(args.limit) }),
        schema: {
            name: 'list_items',
            description:
                "List what is actually in a collection or under a tag, newest first. list_collections and list_tags tell you a container exists; this tells you what is inside it. Use it when the user names a collection or tag rather than describing a topic. A collection includes everything in its subcollections, so ask for the parent once rather than querying each child.",
            parameters: {
                type: 'object',
                properties: {
                    collection_key: {
                        type: 'string',
                        description: 'Collection key from list_collections.',
                    },
                    tag: { type: 'string', description: 'Tag name from list_tags.' },
                    limit: {
                        type: 'integer',
                        description: `Maximum items to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
                    },
                },
                required: [],
            },
        },
    },
    {
        name: 'read_note',
        event: 'read_note_request',
        defaults: { limit: MAX_LIMIT, offset: 0 },
        schema: {
            name: 'read_note',
            description: 'Read the content of a Zotero note by its note id.',
            parameters: {
                type: 'object',
                properties: { note_id: { type: 'string', description: 'The note item id.' } },
                required: ['note_id'],
            },
        },
    },
];

export const TOOL_SPECS_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
    TOOL_SPECS.map((spec) => [spec.name, spec]),
);

/** Schemas to advertise to the model. */
export function toolSchemas(names?: readonly string[]): ToolSchema[] {
    if (!names) return TOOL_SPECS.map((spec) => spec.schema);
    return names
        .map((name) => TOOL_SPECS_BY_NAME.get(name)?.schema)
        .filter((schema): schema is ToolSchema => schema !== undefined);
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export class UnknownToolError extends Error {
    constructor(name: string) {
        super(
            `Unknown tool "${name}". Available tools: ${[...TOOL_SPECS_BY_NAME.keys()].join(', ')}.`,
        );
        this.name = 'UnknownToolError';
    }
}

export class MissingArgumentError extends Error {
    constructor(toolName: string, missing: string[]) {
        super(`Tool "${toolName}" requires: ${missing.join(', ')}.`);
        this.name = 'MissingArgumentError';
    }
}

/**
 * Clamp a model-supplied limit into range.
 *
 * Models routinely ask for 1000 rows. Forwarding that either errors or returns
 * a payload that crowds the whole context window out, so it is capped here
 * rather than trusted.
 */
export function clampLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
    // `Number(null)` and `Number('')` are both 0 — finite, so they would slip
    // past the guard below and clamp to 1, turning "no preference" into a
    // single-row answer that reads as a real result. Absent means absent.
    if (value === null || value === undefined || value === '') return fallback;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(Math.floor(numeric), 1), MAX_LIMIT);
}

function requiredFields(spec: ToolSpec): string[] {
    return spec.schema.parameters.required ?? [];
}

/**
 * Build the complete wire request for a tool call.
 *
 * Layering, outermost last: spec defaults, then the model's arguments, then the
 * envelope — so a model can override a default but can never overwrite
 * `event` or `request_id`.
 */
export function buildToolRequest(
    toolName: string,
    args: Record<string, unknown>,
    requestId: string,
): Record<string, unknown> {
    const spec = TOOL_SPECS_BY_NAME.get(toolName);
    if (!spec) throw new UnknownToolError(toolName);

    const missing = requiredFields(spec).filter((field) => {
        const value = args[field];
        return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) throw new MissingArgumentError(toolName, missing);

    const shaped = spec.transformArgs
        ? spec.transformArgs(stripUndefined(args))
        : stripUndefined(args);

    const request: Record<string, unknown> = {
        ...spec.defaults,
        ...shaped,
        event: spec.event,
        request_id: requestId,
    };

    // Paging is the one place a model's number is routinely out of range.
    if ('limit' in request) request.limit = clampLimit(request.limit, DEFAULT_LIMIT);
    if ('offset' in request) {
        const offset = Number(request.offset);
        request.offset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    }

    return request;
}

/**
 * Drop keys whose value is undefined.
 *
 * A model that emits `{"tag": null}` means "no tag filter", but an explicit
 * `undefined` spread over a default would erase it — so undefined is removed
 * while null is passed through as the intentional empty filter it is.
 */
function stripUndefined(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) out[key] = value;
    }
    return out;
}

export const TOOL_LIMITS = { DEFAULT_LIMIT, MAX_LIMIT } as const;
