/**
 * Helpers derived from a tool-call's request side (`ToolCallPart.args`): arg
 * parsing, the base per-tool labels, and the item references an in-flight call
 * names before any result exists.
 *
 * Kept apart from `toolLabels`, which composes a finished header out of a
 * result view model and host-resolved display data, so a caller that only needs
 * the request side (e.g. the generic agent-action fallback) does not pull that
 * machinery in.
 */

import { ToolCallPart } from '../agents/types';
import { ZoteroItemReference } from '../types/zotero';
import { resolveObjectIdReference } from '../identity/libraryRef';
import { msg, t } from '../i18n/translate';

/**
 * Parse args from a {@link ToolCallPart} — handles both string and object formats.
 */
export function parseArgs(part: ToolCallPart): Record<string, unknown> {
    if (!part.args) return {};
    if (typeof part.args === 'string') {
        try {
            return JSON.parse(part.args);
        } catch {
            return {};
        }
    }
    return part.args as Record<string, unknown>;
}

function zoteroReferenceFromCompoundId(id: string): ZoteroItemReference | null {
    // Portable ("u-KEY" / "g<groupID>-KEY") or legacy numeric compound id.
    return resolveObjectIdReference(id);
}

/**
 * Extract Zotero item references from a tool call part.
 * Looks for attachment_id parameters in tool call arguments.
 * Returns an array of ZoteroItemReference, or empty array if none found.
 */
export function extractZoteroReferencesFromToolCall(part: ToolCallPart): ZoteroItemReference[] {
    const args = parseArgs(part);
    const references: ZoteroItemReference[] = [];

    // Extract attachment_id if present (used by read_pages, add_highlight_annotations,
    // add_note_annotations, search_in_attachment, view_pages, view_page_images, etc.)
    const attachmentId = args.attachment_id as string | undefined;
    if (attachmentId) {
        const ref = zoteroReferenceFromCompoundId(attachmentId);
        if (ref) references.push(ref);
    }

    // Extract file id if present (used by read). Zotero attachment ids use the
    // portable or legacy compound form; external file ids ('ext-1') carry no
    // Zotero reference and parse to null.
    const file = args.file as string | undefined;
    if (file) {
        const ref = zoteroReferenceFromCompoundId(file);
        if (ref) references.push(ref);
    }

    // Extract note_id if present (used by read_note, edit_note)
    const noteId = args.note_id as string | undefined;
    if (noteId) {
        const ref = zoteroReferenceFromCompoundId(noteId);
        if (ref) references.push(ref);
    }

    // Extract attachment_ids array if present (for tools that accept multiple attachments)
    const attachmentIds = args.attachment_ids as string[] | undefined;
    if (Array.isArray(attachmentIds)) {
        for (const id of attachmentIds) {
            const ref = zoteroReferenceFromCompoundId(id);
            if (ref) references.push(ref);
        }
    }

    return references;
}

/**
 * Base labels for tool calls (display names).
 * Maps tool_name to a human-readable base label, in English; show one through
 * {@link toolBaseLabel}, which translates it.
 */
export const TOOL_BASE_LABELS: Record<string, string> = {
    // Search tools
    item_search: msg('Item search'),
    item_search_by_topic: msg('Item search'),
    item_search_by_metadata: msg('Item search'),
    fulltext_search: msg('Fulltext search'),
    fulltext_search_keywords: msg('Keyword search'),

    // List tools
    list_items: msg('List items'),
    list_collections: msg('List collections'),
    list_tags: msg('List tags'),
    list_libraries: msg('List libraries'),
    zotero_search: msg('Zotero search'),

    // Metadata tools
    get_metadata: msg('Get metadata'),
    edit_metadata: msg('Edit metadata'),

    // Annotation tools
    get_annotations: msg('Get annotations'),
    find_annotations: msg('Find annotations'),
    edit_annotations: msg('Edit annotations'),
    delete_annotations: msg('Delete annotations'),

    // Note tools
    read_note: msg('Reading note'),
    edit_note: msg('Edit note'),
    create_note: msg('Create note'),

    // Organization tools
    organize_items: msg('Filing items'),
    create_collection: msg('Proposing a collection'),

    // Tag tools
    manage_tags: msg('Manage tags'),
    manage_collections: msg('Manage collections'),

    // Reading tools
    read: msg('Reading'),
    read_pages: msg('Reading'),
    read_attachment: msg('Reading'),
    search_in_documents: msg('Search in documents'),
    search_in_attachment: msg('Search in attachment'),
    search_in_attachments: msg('Search in attachments'),
    find_in_attachments: msg('Find in attachments'),
    read_file: msg('Retrieving data'),
    read_documentation: msg('Reading documentation'),
    load_tool_results: msg('Loading tool results'),
    view_pages: msg('Viewing pages'),
    view_page_images: msg('Viewing pages'),
    view: msg('Viewing'),

    // Word document tools (served by the Word add-in)
    read_word_document: msg('Reading document'),

    // Extract tool
    extract: msg('Extracting'),

    // Annotations
    add_highlight_annotations: msg('Highlight annotations'),
    add_note_annotations: msg('Note annotations'),
    create_highlight_annotations: msg('Creating highlight annotations'),
    create_note_annotations: msg('Creating sticky notes'),

    // Suggestions
    return_suggestions: msg('Suggestions'),

    // User interaction
    ask_user_question: msg('Asking a question'),

    // External search
    search_external_references: msg('Web search'),
    create_zotero_item: msg('Add item'),
    external_search: msg('Web search'),
    lookup_work: msg('Lookup work'),

    // Batch operations
    batch_start: msg('Batch operations'),
    batch_resolve: msg('Skipping items'),
    batch_digest: msg('Recording findings'),

    // Framework tools
    load_capability: msg('Loading tools'),
    search_tools: msg('Finding tools'),

    /*
     * The locally-run tool set.
     *
     * These names are this client's own, so none of them matched the table
     * above and every one of them rendered as the fallback, "Calling
     * function" — on the five most frequent calls in a run, which is most of
     * what the user watches happen.
     */
    read_document: msg('Reading'),
    search_in_document: msg('Searching in document'),
    search_library_fulltext: msg('Searching your library'),
    search_web_literature: msg('Searching the literature'),
    create_highlight: msg('Proposing a highlight'),
    add_papers_to_library: msg('Adding papers to your library'),
};

/** The base label for a tool, in the reader's language, or undefined for a tool the table does not name. */
export function toolBaseLabel(toolName: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(TOOL_BASE_LABELS, toolName)
        ? t(TOOL_BASE_LABELS[toolName])
        : undefined;
}
