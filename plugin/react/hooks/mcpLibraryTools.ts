/**
 * Eight of the assistant's library tools, served over MCP beside the MCP
 * server's own search, read and list tools: searching the papers' text and
 * figures by meaning, finding a phrase inside one PDF, looking at pages and
 * image files, the user's highlights and comments, and the list of libraries.
 *
 * Each call goes through the assistant's own dispatcher, so arguments, library
 * exclusions and result shaping are exactly the sidebar's. This module points
 * the tool descriptions at the tools an MCP client has, adds Zotero links and
 * packs each result into MCP content.
 */

import { TOOL_SPECS_BY_NAME } from '../../src/services/llm/toolSchemas';
import { FIGURE_TOOL_SCHEMA, FULLTEXT_TOOL_SCHEMA } from '../../src/services/llm/writeTools';
import { dataProviderToolDispatcher } from '../../src/services/llm/zoteroToolDispatch';
import {
    isToolImagesResult,
    serializeToolResult,
    toolResultCharBudget,
    type ToolDispatcher,
} from '@beaver/agent-llm/agentLoop';
import type { ToolSchema } from '@beaver/agent-llm/types';
import { refreshSemanticSearchAvailability, semanticSearchState } from '../../src/services/llm/agentConfig';
import { EMBEDDING_PRESETS } from '@beaver/agent-llm/embeddings';
import { createZoteroDataProvider } from '../../src/services/zoteroDataProvider';
import { getPref } from '../../src/utils/prefs';
import { figuresTool, fulltextTool } from '../atoms/librarySearchTools';

/** The tools this module serves, in the order clients list them. */
export const MCP_LIBRARY_TOOL_NAMES = [
    'search_library_fulltext',
    'search_library_figures',
    'search_in_document',
    'view_page_images',
    'view_attachment_image',
    'find_annotations',
    'get_annotations',
    'list_libraries',
] as const;

export type McpLibraryToolName = (typeof MCP_LIBRARY_TOOL_NAMES)[number];

/*
 * The assistant's names for the tools MCP serves under other names.
 *
 * The assistant's tool descriptions point at its tools by name ("then
 * read_document those pages"). An MCP client has no tool by those names, so in
 * the descriptions each one becomes the MCP tool that does the same job. Both
 * number pages from 1, counted from the first page of the file. Results are
 * left as they are: they hold the library's own text, which may contain these
 * words.
 */
const MCP_NAME_FOR: Readonly<Record<string, string>> = {
    item_search_by_topic: 'search_by_topic',
    item_search_by_metadata: 'search_by_metadata',
    get_metadata: 'get_item_details',
    read_document: 'read_attachment',
};

const ASSISTANT_TOOL_NAME = /\b(?:item_search_by_topic|item_search_by_metadata|get_metadata|read_document)\b/g;

/** Rewrite the assistant's tool names in a tool description to the MCP tools that do the same job. */
export function withMcpToolNames(text: string): string {
    return text.replace(ASSISTANT_TOOL_NAME, (name) => MCP_NAME_FOR[name] ?? name);
}

/*
 * Written for MCP rather than taken from the assistant. The assistant's version
 * is about a picture attached to the user's message, which an MCP client never
 * has; what the executor serves a client is an image file in the library.
 */
const VIEW_ATTACHMENT_IMAGE_SCHEMA: ToolSchema = {
    name: 'view_attachment_image',
    description:
        "Look at an image file stored in the user's library — a PNG, JPEG, GIF, WebP or similar "
        + 'attachment — by its attachment id from a search or metadata result. For a page of a PDF, '
        + 'use view_page_images.',
    parameters: {
        type: 'object',
        properties: {
            attachment_id: {
                type: 'string',
                description: 'The image attachment id, e.g. "u-ABCD1234".',
            },
        },
        required: ['attachment_id'],
    },
};

function assistantSchema(name: McpLibraryToolName): ToolSchema {
    if (name === 'search_library_fulltext') return FULLTEXT_TOOL_SCHEMA;
    if (name === 'search_library_figures') return FIGURE_TOOL_SCHEMA;
    if (name === 'view_attachment_image') return VIEW_ATTACHMENT_IMAGE_SCHEMA;
    const spec = TOOL_SPECS_BY_NAME.get(name);
    if (!spec) throw new Error(`No tool spec for ${name}`);
    return spec.schema;
}

const TITLES: Readonly<Record<McpLibraryToolName, string>> = {
    search_library_fulltext: 'Search Paper Text by Meaning',
    search_library_figures: 'Search Figures by Description',
    search_in_document: 'Find a Phrase in One PDF',
    view_page_images: 'View PDF Pages',
    view_attachment_image: 'View an Image Attachment',
    find_annotations: 'Find Highlights and Comments',
    get_annotations: 'List Annotations on One PDF',
    list_libraries: 'List Libraries',
};

// ---------------------------------------------------------------------------
// Zotero links
// ---------------------------------------------------------------------------

/** A portable object id: "u-KEY" for the personal library, "g<groupID>-KEY" for a group. */
const PORTABLE_ID = /^(u|g([1-9]\d*))-([A-Z0-9]+)$/;

function parsePortableId(id: unknown): { path: string; key: string } | null {
    const match = typeof id === 'string' ? PORTABLE_ID.exec(id.trim()) : null;
    if (!match) return null;
    const [, ref, groupID, key] = match;
    return { path: ref === 'u' ? 'library' : `groups/${groupID}`, key };
}

/** `zotero://select/…`: shows the item in the user's library. */
export function zoteroSelectUri(itemId: unknown): string | null {
    const id = parsePortableId(itemId);
    return id ? `zotero://select/${id.path}/items/${id.key}` : null;
}

/**
 * `zotero://open-pdf/…`: opens the attachment in Zotero's reader, at a 1-based
 * page and, for one of the user's annotations, at that annotation.
 */
export function zoteroOpenUri(attachmentId: unknown, page?: unknown, annotationId?: unknown): string | null {
    const attachment = parsePortableId(attachmentId);
    if (!attachment) return null;
    const query: string[] = [];
    if (typeof page === 'number' && Number.isInteger(page) && page >= 1) query.push(`page=${page}`);
    const annotation = parsePortableId(annotationId);
    // An annotation key only means something in the attachment's own library.
    if (annotation && annotation.path === attachment.path) query.push(`annotation=${annotation.key}`);
    return `zotero://open-pdf/${attachment.path}/items/${attachment.key}${query.length ? `?${query.join('&')}` : ''}`;
}

/** `<citation id="u-KEY" page="5" …/>`: the assistant's citation marker. */
const CITATION_MARKER = /^<citation\s+id="([^"]+)"(?:\s+page="(\d+)")?[^>]*\/>$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add Zotero links to a shaped tool result.
 *
 * An item gets `zotero_uri`, as the older MCP tools give one; a hit on a page
 * of an attachment gets `open_uri`, which opens the PDF at that page. The
 * assistant's `cite` marker is AlphainZ's own citation format and means
 * nothing to another client, so it is replaced by the link it stands for.
 */
export function withZoteroLinks(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withZoteroLinks);
    if (!isPlainObject(value)) return value;

    const out: Record<string, unknown> = {};
    let cited: { id: string; page?: number } | null = null;
    for (const [key, field] of Object.entries(value)) {
        if (key === 'cite' && typeof field === 'string') {
            const match = CITATION_MARKER.exec(field.trim());
            if (match) {
                cited = { id: match[1], ...(match[2] ? { page: Number(match[2]) } : {}) };
                continue;
            }
        }
        out[key] = withZoteroLinks(field);
    }

    const page = typeof value.page === 'number' ? value.page : cited?.page;
    const attachmentId = typeof value.attachment_id === 'string' ? value.attachment_id : cited?.id;
    if (attachmentId && out.open_uri === undefined) {
        const uri = zoteroOpenUri(attachmentId, page, value.annotation_id);
        if (uri) out.open_uri = uri;
    }
    if (typeof value.item_id === 'string' && out.zotero_uri === undefined) {
        const uri = zoteroSelectUri(value.item_id);
        if (uri) out.zotero_uri = uri;
    }
    return out;
}

// ---------------------------------------------------------------------------
// MCP content
// ---------------------------------------------------------------------------

export type McpContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
    content: McpContent[];
    isError?: boolean;
}

/** Pack one shaped tool result into MCP content: text, plus the pixels of an image result. */
export function toMcpResult(name: string, value: unknown): McpToolResult {
    if (isToolImagesResult(value)) {
        const count = value.images.length;
        return {
            content: [
                { type: 'text', text: value.text ?? `${count} image${count === 1 ? '' : 's'} returned.` },
                ...value.images.map((image): McpContent => ({
                    type: 'image',
                    data: image.base64,
                    mimeType: image.mimeType,
                })),
            ],
        };
    }
    return { content: [{ type: 'text', text: serializeToolResult(withZoteroLinks(value), toolResultCharBudget(name)) }] };
}

/** A failure the model can read and correct from, rather than a protocol error. */
export function toMcpError(error: unknown): McpToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
}

export interface McpLibraryTool {
    definition: McpToolDefinition;
    handler: (args: any) => Promise<McpToolResult>;
    /** Whether the settings let the tool run: the two index searches need an embedding model. */
    isAvailable?: () => boolean;
}

type IndexSearch = 'search_library_fulltext' | 'search_library_figures';

function isIndexSearch(name: McpLibraryToolName): name is IndexSearch {
    return name === 'search_library_fulltext' || name === 'search_library_figures';
}

/**
 * Why the settings rule out one of the two index searches, or null when they
 * allow it.
 *
 * Only the settings count. A client lists the tools once, when it connects,
 * and cannot be told the list changed; something that passes — Ollama not yet
 * started, the library list still loading, an index still being built — must
 * not hide a search for the rest of the client's session. The search reports
 * those itself when it is called.
 */
export function indexSearchUnavailable(name: IndexSearch): string | null {
    if (getPref('fulltextSearchEnabled') === false) {
        return "Searching AlphainZ's index is turned off in its settings.";
    }
    const state = semanticSearchState();
    if (state.status === 'off' || state.status === 'needs_key') {
        return 'This search needs an embedding model. Set one up in AlphainZ\'s settings, under Model.';
    }
    if (name === 'search_library_figures' && !('imageWire' in EMBEDDING_PRESETS[state.provider])) {
        return 'Figure search needs an embedding model that takes pictures (Google Gemini or Ollama EmbeddingGemma 2).';
    }
    return null;
}

/**
 * Why an index search cannot run right now, or null when it can: the settings
 * first, then whether the embedding model answers (for Ollama, whether it is
 * running with the model installed).
 */
async function indexSearchBlocked(name: IndexSearch): Promise<string | null> {
    const unavailable = indexSearchUnavailable(name);
    if (unavailable) return unavailable;
    if (await refreshSemanticSearchAvailability()) return null;
    const state = semanticSearchState();
    return state.status === 'unreachable' ? `${state.reason}.` : 'The embedding model cannot be reached right now.';
}

/** The assistant's dispatcher, built per call so each one reads the settings as they are now. */
function assistantDispatcher(): ToolDispatcher {
    return dataProviderToolDispatcher(
        createZoteroDataProvider() as any,
        { ...fulltextTool(), ...figuresTool() },
        { readsImages: true },
    );
}

let callCount = 0;

/** Run one of the assistant's tools for an MCP client. */
export async function callLibraryTool(
    name: McpLibraryToolName,
    args: unknown,
    dispatcher: () => ToolDispatcher = assistantDispatcher,
): Promise<McpToolResult> {
    try {
        // Listed or not, a search the settings rule out does not run: a client
        // can call a tool by name without listing the tools first.
        const blocked = isIndexSearch(name) ? await indexSearchBlocked(name) : null;
        if (blocked) return toMcpError(new Error(blocked));
        const value = await dispatcher()(name, isPlainObject(args) ? args : {}, {
            toolCallId: `mcp-${name}-${++callCount}`,
        });
        return toMcpResult(name, value);
    } catch (error) {
        return toMcpError(error);
    }
}

/** The definitions and handlers the MCP server registers. */
export function mcpLibraryTools(): McpLibraryTool[] {
    return MCP_LIBRARY_TOOL_NAMES.map((name) => {
        const schema = assistantSchema(name);
        return {
            definition: {
                name,
                description: withMcpToolNames(schema.description),
                inputSchema: JSON.parse(withMcpToolNames(JSON.stringify(schema.parameters))),
                annotations: {
                    title: TITLES[name],
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            handler: (args: any) => callLibraryTool(name, args),
            ...(isIndexSearch(name) ? { isAvailable: () => indexSearchUnavailable(name) === null } : {}),
        };
    });
}
