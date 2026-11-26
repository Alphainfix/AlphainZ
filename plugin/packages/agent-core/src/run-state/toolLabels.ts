import { ToolCallStatus } from './atoms';
import { ToolCallPart } from '../agents/types';
import { parseArgs, toolBaseLabel } from './toolCallRequest';
import { isItemRow, type ToolResultView } from './toolResultViews';
import { msg, t, tn } from '../i18n/translate';

// The request-side reference extraction lives in `toolCallRequest`; re-exported
// here so label consumers can take it from this module.
export { extractZoteroReferencesFromToolCall } from './toolCallRequest';

/**
 * Host-resolved display data folded into a tool-call header label for calls that
 * have no view model yet (pending / failed). Resolved by the caller via the
 * `itemData` host slice; absent on clients without that capability.
 */
export interface ToolCallLabelEnrich {
    /** Bibliographic name for a content/note/annotation reference ("Smith 2005"). */
    itemDisplayName?: string;
    /** Library scope name for list_* tools. */
    libraryName?: string;
    /** Collection scope name for list_* tools. */
    collectionName?: string;
}

export interface ToolCallLabelOptions {
    /** Hydrated tool-result view model — present once the call has returned. */
    view?: ToolResultView | null;
    /** Host-resolved request-side display data (used when there is no `view`). */
    enrich?: ToolCallLabelEnrich | null;
}

const CAPABILITY_LABELS: Record<string, string> = {
    zotero_library_management: msg('Library Management'),
    zotero_metadata_editing: msg('Metadata Editing'),
    zotero_note_editing: msg('Note Editing'),
    zotero_annotations: msg('Annotations'),
    external_literature: msg('External Literature'),
    beaver_help: msg('AlphainZ Help'),
};

function humanizeCapabilityId(id: string): string {
    const spaced = id.replace(/[_-]+/g, ' ').trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : t('capability');
}

/** A table entry for `key`, ignoring names the object inherits. */
function lookup(table: Record<string, string>, key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function capabilityLabel(id: string): string {
    const label = lookup(CAPABILITY_LABELS, id);
    return label !== undefined ? t(label) : humanizeCapabilityId(id);
}

/** The label for a tool with no entry in the base-label table. */
const FALLBACK_TOOL_LABEL = msg('Calling function');

/*
 * The shapes a tool-call label is built from. Each is one translatable
 * template, so a language can reorder the parts or use its own punctuation.
 */

/** "<label>: <detail>". */
function withDetail(label: string, detail: string): string {
    return t('{label}: {detail}', { label, detail });
}

/** "<label>: "<text>"" — the detail is something the agent typed, quoted. */
function withQuote(label: string, text: string): string {
    return t('{label}: "{text}"', { label, text });
}

/** "<label>: <name>, <locator>", or "<label>: <name>" without a locator. */
function withNameAndLocator(label: string, name: string, locator: string): string {
    return locator ? t('{label}: {name}, {locator}', { label, name, locator }) : withDetail(label, name);
}

/** A page locator: "p. 5" or "p. 5-10". */
function pageLocator(pages: string | number): string {
    return t('p. {pages}', { pages });
}

/** Highlight colours a label names, as the agent passes them. Other values are shown as given. */
const HIGHLIGHT_COLOUR_LABELS: Record<string, string> = {
    yellow: msg('yellow'),
    red: msg('red'),
    green: msg('green'),
    blue: msg('blue'),
    purple: msg('purple'),
    magenta: msg('magenta'),
    orange: msg('orange'),
    gray: msg('gray'),
};

function colourLabel(colour: string): string {
    const label = lookup(HIGHLIGHT_COLOUR_LABELS, colour);
    return label !== undefined ? t(label) : colour;
}

/** Annotation types in the plural, as a find_annotations label names them. */
const ANNOTATION_TYPE_PLURALS: Record<string, string> = {
    highlight: msg('highlights'),
    note: msg('notes'),
    underline: msg('underlines'),
    image: msg('images'),
    ink: msg('inks'),
};

/** Tools whose label headlines a single item's bibliographic name. */
const SINGLE_ITEM_NAME_TOOLS = new Set([
    'read', 'read_pages', 'read_attachment', 'view', 'read_note',
]);

/** Annotation tools whose label headlines the annotation source name. */
const ANNOTATION_NAME_TOOLS = new Set(['get_annotations', 'find_annotations']);

/** List tools whose label shows a host-resolved library/collection scope name. */
const LIST_SCOPE_TOOLS = new Set(['list_items', 'list_collections', 'list_tags']);

/**
 * What host-resolved display data a tool-call label needs *beyond* its view
 * model. The caller (e.g. `ToolCallPartView`) uses this to decide whether to run
 * the `itemData` host resolution effect, and skips it otherwise.
 *
 * - `itemName` — a content/note/annotation reference whose name the view does not
 *   already supply (pending/failed, or an empty annotation view).
 * - `scope` — a `list_*` library/collection scope name (never carried by the view).
 */
export function getLabelEnrichmentNeeds(
    part: ToolCallPart,
    view: ToolResultView | null | undefined,
): { itemName: boolean; scope: boolean } {
    const toolName = part.tool_name;
    const itemName =
        (SINGLE_ITEM_NAME_TOOLS.has(toolName) || ANNOTATION_NAME_TOOLS.has(toolName)) &&
        getViewDisplayName(view, toolName) === null;
    return { itemName, scope: LIST_SCOPE_TOOLS.has(toolName) };
}

/**
 * The headline display name a completed view supplies for a tool-call label, or
 * null when the view carries none (the label then falls back to the host-resolved
 * request-side name, or the base label). Pure — derived from the view model only.
 */
export function getViewDisplayName(
    view: ToolResultView | null | undefined,
    toolName: string,
): string | null {
    if (!view) return null;
    if (SINGLE_ITEM_NAME_TOOLS.has(toolName) && view.view_type === 'item_list') {
        const row = view.items[0];
        return row && isItemRow(row) ? (row.display_name ?? null) : null;
    }
    if (ANNOTATION_NAME_TOOLS.has(toolName) && view.view_type === 'annotation_list') {
        // Scoped (single distinct source) → that source name; unscoped
        // multi-source → null (label falls back to base + count suffix).
        const sources = new Set(
            view.annotations
                .map(a => a.source_display_name)
                .filter((s): s is string => !!s),
        );
        return sources.size === 1 ? [...sources][0] : null;
    }
    return null;
}

/** The completed view's locator badge for a single-item tool ("Page 1-3" / "Lines 10-20"). */
function getViewLocationLabel(view: ToolResultView | null | undefined, toolName: string): string | null {
    if (!view || view.view_type !== 'item_list' || !SINGLE_ITEM_NAME_TOOLS.has(toolName)) return null;
    const row = view.items[0];
    if (!row || !isItemRow(row)) return null;
    // Snapshot attachments have no meaningful location label.
    if (row.content_kind === 'snapshot') return null;
    return row.location_label ?? null;
}

/**
 * What a completed tool-call label adds in parentheses, derived from the view
 * model. Per-tool wording (not a single number): read/view/read_note carry
 * their locator inline and get nothing; search/list say "N results/collections/
 * tags"; attachment_search gives the match count; lookup_work says "N found";
 * batch_operation carries the batch's population line, or how it stopped.
 * Returns null when there is nothing to add.
 */
function getToolResultLabelDetail(
    view: ToolResultView | null | undefined,
    toolName: string,
): string | null {
    if (!view) return null;
    // Single-item read/view/read_note carry the locator inline — no count suffix.
    if (SINGLE_ITEM_NAME_TOOLS.has(toolName)) return null;
    switch (view.view_type) {
        case 'item_list': {
            const n = view.items.length;
            return n ? tn(n, '{count} result', '{count} results') : null;
        }
        case 'collection_list': {
            const n = view.total_count;
            return n ? tn(n, '{count} collection', '{count} collections') : null;
        }
        case 'tag_list': {
            const n = view.total_count;
            return n ? tn(n, '{count} tag', '{count} tags') : null;
        }
        case 'attachment_search': {
            const n = view.total_matches;
            return n ? tn(n, '{count} match', '{count} matches') : null;
        }
        case 'annotation_list': {
            const n = view.annotations.length;
            return n ? tn(n, '{count} annotation', '{count} annotations') : null;
        }
        case 'external_reference_list': {
            if (toolName === 'lookup_work') {
                const n = view.found_count ?? view.references.length;
                return n != null ? t('{count} found', { count: n }) : null;
            }
            const n = view.references.length;
            return n ? tn(n, '{count} result', '{count} results') : null;
        }
        case 'batch_operation': {
            // A batch that has ended says how; one still running says how big
            // it is. Both strings are backend copy, shown verbatim.
            if (view.status && view.status !== 'active' && view.status_label) {
                return view.status_label;
            }
            return view.scope_primary || null;
        }
        case 'user_question': {
            // The backend omits the default status — treat absent as answered.
            const status = view.status ?? 'answered';
            if (status === 'cancelled') return t('skipped');
            if (status === 'no_response') return t('no response');
            return t('answered');
        }
        default:
            return null;
    }
}

/**
 * Parenthetical suffix for a completed tool-call label — " (3 results)" — or
 * null when there is nothing to append. See {@link getToolResultLabelDetail}.
 */
export function getToolResultLabelSuffix(
    view: ToolResultView | null | undefined,
    toolName: string,
): string | null {
    const detail = getToolResultLabelDetail(view, toolName);
    return detail ? ` (${detail})` : null;
}

/**
 * Labels for skill names.
 */
const SKILL_NAME_LABELS: Record<string, string> = {
    'library-management': msg('Library management'),
};

/**
 * Detect the type of file being read by the read_file tool.
 * 
 * Categorizes files according to:
 * - Tool results: Storage ref paths (agent_runs/.../tool_results/...) or .json.gz files (legacy)
 * - Agent Skills: Files in /skills/{skill-name}/ directory
 * - Skill resources: Bundled resources in /skills/{skill-name}/{scripts|references|assets}/
 * - Documentation: Files in /docs/ directory
 * 
 * Agent Skills specification: https://agentskills.io/specification
 */
function detectReadFileType(path: string): 'tool_result' | 'skill' | 'skill_resource' | 'documentation' | 'unknown' {
    const trimmedPath = path.trim();
    const pathLower = trimmedPath.toLowerCase();

    // Tool results: storage_ref format (new) or .json.gz files (legacy)
    if (/^agent_runs\/[^/]+\/tool_results\//.test(trimmedPath)) {
        return 'tool_result';
    }
    if (pathLower.endsWith('.json.gz')) {
        return 'tool_result';
    }
    
    // Agent Skills: files in /skills/ directory
    if (pathLower.includes('/skills/')) {
        // Agent Skills main file: SKILL.md (case-insensitive per spec)
        const fileName = trimmedPath.split('/').pop()?.toUpperCase();
        if (fileName === 'SKILL.MD') {
            return 'skill';
        }
        
        // Agent Skills bundled resources (per agentskills.io specification)
        const parts = pathLower.split('/skills/');
        if (parts.length > 1) {
            const skillPath = parts[1];
            const pathSegments = skillPath.split('/');
            // Check for standard skill resource directories (scripts/, references/, assets/)
            if (pathSegments.length > 1 && ['scripts', 'references', 'assets'].includes(pathSegments[1])) {
                return 'skill_resource';
            }
        }
        
        // Other files in skills directory default to skill
        return 'skill';
    }
    
    // Documentation: files in /docs/ directory
    if (pathLower.includes('/docs/')) {
        return 'documentation';
    }
    
    return 'unknown';
}

/**
 * Display name for a skill file path (`/skills/{skill-name}/...`): the mapped
 * label, else the directory name title-cased.
 */
function skillNameFromPath(path: string): string {
    const skillKey = path.match(/\/skills\/([^/]+)/i)?.[1];
    if (!skillKey) return t('skill');
    const label = lookup(SKILL_NAME_LABELS, skillKey);
    if (label !== undefined) return t(label);
    return skillKey
        .replace(/-/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '...';
}

/**
 * Build year filter label from year_filter object.
 */
function formatYearFilter(yearFilter: unknown): string | null {
    if (!yearFilter || typeof yearFilter !== 'object') return null;
    const filter = yearFilter as { exact?: number; min?: number; max?: number };

    if (filter.exact !== undefined) {
        return `(${filter.exact})`;
    }
    if (filter.min !== undefined && filter.max !== undefined) {
        return `(${filter.min}-${filter.max})`;
    }
    if (filter.min !== undefined) {
        return `(>=${filter.min})`;
    }
    if (filter.max !== undefined) {
        return `(<=${filter.max})`;
    }
    return null;
}

/**
 * Normalize a list parameter that might be passed as a JSON string.
 * 
 * Handles cases where the LLM passes a JSON string instead of a proper list.
 * This matches the backend validator behavior.
 * 
 * @param value Either a list, a JSON string representation of a list, or null/undefined
 * @returns A list of strings, or null if value is invalid
 */
function normalizeListParam(value: unknown): string[] | null {
    if (value === null || value === undefined) {
        return null;
    }
    
    // If it's already a list, validate items are strings
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item !== 'string') {
                return null; // Invalid: non-string item in array
            }
        }
        return value;
    }
    
    // If it's a string, try to parse as JSON
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            
            // Parsed successfully - validate the result
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    if (typeof item !== 'string') {
                        return null; // Invalid: non-string item in parsed array
                    }
                }
                return parsed;
            } else if (typeof parsed === 'string') {
                // JSON string that decoded to a string (e.g., '"hello"')
                return [parsed];
            } else {
                // Parsed to something else (dict, number, etc.) - invalid
                return null;
            }
        } catch {
            // Not valid JSON - treat as a single item
            // This handles cases like passing "Attention Is All You Need" as a single title
            return [value];
        }
    }
    
    // Any other type is invalid
    return null;
}

/**
 * Generate a display label for a tool call.
 *
 * Creates human-readable labels like:
 * - "Fulltext search: social capital"
 * - "Metadata search: Smith (2020)"
 * - "Reading: Smith 2020, p. 5-10"
 * - "Retrieving previous results" (for read_file with .json.gz files)
 * - "Reading skill: pdf-processing" (for any Agent Skills file)
 * - "Reading documentation" (for any file in /docs/)
 * 
 * If the tool has a progress message, it takes precedence over the default label.
 */
export function getToolCallLabel(
    part: ToolCallPart,
    status: ToolCallStatus,
    opts?: ToolCallLabelOptions,
): string {
    const main = computeMainLabel(part, status, opts);
    const detail = getToolResultLabelDetail(opts?.view ?? null, part.tool_name);
    return detail ? t('{label} ({detail})', { label: main, detail }) : main;
}

/**
 * Build the inline part of the label (base + arg-derived qualifier + headline
 * name + locator), without the view-derived count suffix. Pure: any Zotero
 * resolved names/locators arrive via `opts.enrich` / `opts.view`.
 */
function computeMainLabel(
    part: ToolCallPart,
    status: ToolCallStatus,
    opts?: ToolCallLabelOptions,
): string {
    const toolName = part.tool_name;
    const baseLabel = toolBaseLabel(toolName) ?? t(FALLBACK_TOOL_LABEL);

    // Progress messages take precedence when present
    if (status === 'in_progress' && part.progress) {
        return withDetail(baseLabel, part.progress);
    }

    const args = parseArgs(part);
    const view = opts?.view ?? null;

    // Headline name (item/note/annotation tools): prefer the hydrated view, else
    // the host-resolved request-side name. Not length-capped here — the label
    // renders on a single line and the whole string ellipsis-truncates responsively
    // to the available width (see ToolCallPartView).
    const resolvedName = getViewDisplayName(view, toolName) ?? opts?.enrich?.itemDisplayName ?? null;
    // Actual locator from the completed view (overrides the requested range).
    const viewLocator = getViewLocationLabel(view, toolName);

    switch (toolName) {
        // === Fulltext search tools ===
        case 'fulltext_search': {
            const query = args.query_semantic as string | undefined;
            if (query) {
                return withQuote(baseLabel, truncate(query, 40));
            }
            return baseLabel;
        }

        case 'fulltext_search_keywords': {
            const queries = args.query_primary as string[] | undefined;
            if (queries && queries.length > 0) {
                return withQuote(baseLabel, truncate(queries[0], 40));
            }
            return baseLabel;
        }

        // === Item search tools ===
        case 'item_search':
        case 'item_search_by_topic': {
            const topic = args.topic_query as string | undefined;
            if (topic) {
                return withQuote(baseLabel, truncate(topic, 40));
            }
            return baseLabel;
        }

        case 'item_search_by_metadata': {
            const parts: string[] = [];
            if (args.author_query) parts.push(args.author_query as string);
            if (args.title_query) parts.push(args.title_query as string);
            if (args.publication_query) {
                parts.push(t('in {publication}', { publication: args.publication_query as string }));
            }
            const yearLabel = formatYearFilter(args.year_filter);
            if (yearLabel) parts.push(yearLabel);

            if (parts.length > 0) {
                return withDetail(baseLabel, truncate(parts.join(' '), 50));
            }
            return baseLabel;
        }

        // === List tools ===
        case 'list_items': {
            // Library/collection scope names are host-resolved into opts.enrich.
            const parts: string[] = [];
            const libraryParam = args.library as string | number | undefined;

            // Collection scope (host-resolved name)
            if (opts?.enrich?.collectionName) {
                parts.push(`"${opts.enrich.collectionName}"`);
            }

            // Tag parameter (pure, arg-derived)
            const tag = args.tag as string | undefined;
            if (tag) {
                parts.push(t('tag "{tag}"', { tag: truncate(tag, 20) }));
            }

            // Show library name only when no collection/tag filter and library is specified
            if (parts.length === 0 && libraryParam != null) {
                parts.push(opts?.enrich?.libraryName
                    ? `"${opts.enrich.libraryName}"`
                    : `"${libraryParam}"`);
            }

            if (parts.length > 0) {
                return withDetail(baseLabel, truncate(parts.join(' '), 50));
            }
            return baseLabel;
        }

        // === Reading tools ===
        case 'search_in_documents': {
            const description = args.description as string | undefined;
            const query = args.query as string | undefined;
            const label = description || (query ? truncate(query, 50) : null);
            if (label) {
                return withDetail(baseLabel, label);
            }
            return baseLabel;
        }

        case 'search_in_attachment':
        case 'find_in_attachments': {
            const query = args.query as string | undefined;
            if (query) {
                return withQuote(baseLabel, truncate(query, 40));
            }
            return baseLabel;
        }
        
        case 'read_file': {
            const path = args.path as string | undefined;
            if (path) {
                const fileType = detectReadFileType(path);
                switch (fileType) {
                    case 'tool_result':
                        return t('Retrieving previous results');
                    case 'skill':
                    case 'skill_resource':
                        return t('Loading skill: {skill}', { skill: truncate(skillNameFromPath(path), 30) });
                    case 'documentation':
                        return t('Reading documentation');
                    case 'unknown':
                    default:
                        return withDetail(baseLabel, truncate(path, 40));
                }
            }
            return baseLabel;
        }

        // The documentation reader also serves the skill files that markers in
        // older threads ask to re-read, so those calls read as a skill load
        // rather than as documentation. A documentation path wins: the skill
        // test matches "/skills/" anywhere, which a docs page is allowed to
        // contain.
        case 'read_documentation': {
            const path = args.path as string | undefined;
            if (path && !/^\/?docs\//i.test(path.trim())) {
                const fileType = detectReadFileType(path);
                if (fileType === 'skill' || fileType === 'skill_resource') {
                    return t('Loading skill: {skill}', { skill: truncate(skillNameFromPath(path), 30) });
                }
            }
            return baseLabel;
        }

        case 'read_attachment':
        case 'read_pages': {
            const startPage = args.start_page as number | undefined;
            const endPage = args.end_page as number | undefined;

            // Requested page range from args (fallback when no completed view)
            let argRange = '';
            if (startPage !== undefined && endPage !== undefined) {
                argRange = startPage === endPage ? pageLocator(startPage) : pageLocator(`${startPage}-${endPage}`);
            } else if (startPage !== undefined) {
                argRange = t('p. {page}+', { page: startPage });
            } else if (endPage !== undefined) {
                argRange = pageLocator(`1-${endPage}`);
            }

            // Prefer the completed view's actual locator; the locator is shown only
            // alongside a resolved item name (never a bare page range).
            const locator = viewLocator ?? argRange;
            if (resolvedName) {
                return withNameAndLocator(baseLabel, resolvedName, locator);
            }
            return baseLabel;
        }

        /*
         * The locally-run tools.
         *
         * Each says what it is about to touch, because the label is the only
         * account the user gets of what the agent is doing while it does it —
         * and a write is worth naming in full before it is proposed.
         */
        case 'read_document': {
            const pages = args.pages as string | number | undefined;
            const range = pages != null && String(pages).trim() ? pageLocator(String(pages).trim()) : '';
            const locator = viewLocator ?? range;
            if (resolvedName) {
                return withNameAndLocator(baseLabel, resolvedName, locator);
            }
            return locator ? withDetail(baseLabel, locator) : baseLabel;
        }

        case 'search_in_document': {
            const query = args.query as string | undefined;
            if (query && resolvedName) {
                return t('{label}: "{query}" in {name}', {
                    label: baseLabel,
                    query: truncate(query, 32),
                    name: resolvedName,
                });
            }
            if (query) return withQuote(baseLabel, truncate(query, 40));
            return baseLabel;
        }

        case 'search_library_fulltext':
        case 'search_web_literature': {
            const query = args.query as string | undefined;
            if (query) return withQuote(baseLabel, truncate(query, 48));
            return baseLabel;
        }

        case 'create_highlight': {
            // Names the colour and quotes the passage, so the proposal is
            // legible before the approval card is opened.
            const colour = args.color as string | undefined;
            const text = args.text as string | undefined;
            const page = args.page as number | undefined;
            const head = colour ? t('Proposing a {color} highlight', { color: colourLabel(colour) }) : baseLabel;
            const placed = resolvedName
                ? page != null
                    ? t('{label} in {name}, {locator}', { label: head, name: resolvedName, locator: pageLocator(page) })
                    : t('{label} in {name}', { label: head, name: resolvedName })
                : page != null
                    ? t('{label}, {locator}', { label: head, locator: pageLocator(page) })
                    : head;
            if (text) return withQuote(placed, truncate(text, 60));
            return placed;
        }

        case 'add_papers_to_library': {
            const papers = Array.isArray(args.papers) ? args.papers : [];
            const first = papers[0] as Record<string, unknown> | undefined;
            const title = typeof first?.title === 'string' ? first.title : null;
            if (papers.length === 1 && title) return withDetail(baseLabel, truncate(title, 56));
            if (papers.length > 1 && title) {
                return withDetail(
                    baseLabel,
                    t('{title} and {count} more', { title: truncate(title, 40), count: papers.length - 1 }),
                );
            }
            if (papers.length) return withDetail(baseLabel, t('{count} papers', { count: papers.length }));
            return baseLabel;
        }

        /*
         * Filing, said in the terms the change is in.
         *
         * "Filing items" alone is the same line whether one paper gains a tag
         * or forty move collection, and the user is being asked to approve the
         * difference.
         */
        case 'organize_items': {
            const count = Array.isArray(args.item_ids) ? args.item_ids.length : 0;
            const subject = tn(count, '{count} item', '{count} items');
            const list = (value: unknown) =>
                Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
            const addTags = list(args.add_tags);
            const removeTags = list(args.remove_tags);
            const addCollections = list(args.add_to_collections);
            const removeCollections = list(args.remove_from_collections);

            const parts: string[] = [];
            if (addTags.length) parts.push(`+${addTags.map((tag) => `#${tag}`).join(' ')}`);
            if (removeTags.length) parts.push(`−${removeTags.map((tag) => `#${tag}`).join(' ')}`);
            if (addCollections.length) {
                parts.push(tn(addCollections.length, 'into {count} collection', 'into {count} collections'));
            }
            if (removeCollections.length) {
                parts.push(tn(removeCollections.length, 'out of {count} collection', 'out of {count} collections'));
            }
            if (!count) return baseLabel;
            return parts.length
                ? t('{label}: {items} {changes}', {
                    label: baseLabel,
                    items: subject,
                    changes: truncate(parts.join(', '), 60),
                })
                : withDetail(baseLabel, subject);
        }

        case 'create_collection': {
            const name = typeof args.name === 'string' ? args.name : '';
            const count = Array.isArray(args.item_ids) ? args.item_ids.length : 0;
            if (name && count) {
                return tn(count, '{label} "{name}" with {count} item', '{label} "{name}" with {count} items', {
                    label: baseLabel,
                    name: truncate(name, 40),
                });
            }
            if (name) return t('{label} "{name}"', { label: baseLabel, name: truncate(name, 48) });
            return baseLabel;
        }

        case 'read': {
            const pagesArg = args.pages as string | undefined;
            const linesArg = args.lines as string | undefined;

            // Range args are contiguous 1-indexed range strings like "3" or "1-10"
            const normalizeRange = (value: string | undefined): string | null => {
                if (typeof value !== 'string') return null;
                const trimmed = value.trim();
                return /^\d+(-\d+)?$/.test(trimmed) ? trimmed : null;
            };

            const pageRangeValue = normalizeRange(pagesArg);
            const lineRangeValue = normalizeRange(linesArg);

            // Requested locator from args (fallback when no completed view).
            let argRange = '';
            if (pageRangeValue) {
                argRange = pageLocator(pageRangeValue);
            } else if (lineRangeValue) {
                argRange = lineRangeValue.includes('-')
                    ? t('lines {lines}', { lines: lineRangeValue })
                    : t('line {line}', { line: lineRangeValue });
            }

            // The completed view's actual locator wins over the requested range;
            // the locator is shown only alongside a resolved item name.
            const locator = viewLocator ?? argRange;
            if (resolvedName) {
                return withNameAndLocator(baseLabel, resolvedName, locator);
            }
            return baseLabel;
        }

        case 'view': {
            const pagesArg = args.pages as string | undefined;

            // `pages` is a contiguous 1-indexed range string like "3" or "1-5";
            // absent for image attachments.
            const pageRangeValue =
                typeof pagesArg === 'string' && /^\d+(-\d+)?$/.test(pagesArg.trim())
                    ? pagesArg.trim()
                    : null;
            const argRange = pageRangeValue ? pageLocator(pageRangeValue) : '';

            const locator = viewLocator ?? argRange;
            if (resolvedName) {
                return withNameAndLocator(baseLabel, resolvedName, locator);
            }
            return baseLabel;
        }

        // === Annotation tools ===
        case 'get_annotations': {
            if (resolvedName) {
                return withDetail(baseLabel, resolvedName);
            }
            return baseLabel;
        }

        case 'find_annotations': {
            // Scoped (single-source) calls headline the source name.
            if (resolvedName) {
                return withDetail(baseLabel, resolvedName);
            }

            const color = args.color as string | undefined;
            const annotationType = args.annotation_type as string | undefined;
            if (color || annotationType) {
                const typePlural = annotationType ? lookup(ANNOTATION_TYPE_PLURALS, annotationType) : undefined;
                const kinds = annotationType
                    ? typePlural !== undefined ? t(typePlural) : `${annotationType}s`
                    : t('annotations');
                const label = color
                    ? t('{color} {annotations}', { color: colourLabel(color), annotations: kinds })
                    : kinds;
                return withDetail(baseLabel, truncate(label, 40));
            }

            const tag = args.tag as string | undefined;
            if (tag) {
                return withDetail(baseLabel, t('tagged "{tag}"', { tag: truncate(tag, 30) }));
            }

            const text = args.text_contains as string | undefined;
            if (text) {
                return withQuote(baseLabel, truncate(text, 40));
            }

            const collection = args.collection as string | undefined;
            if (collection) {
                return withDetail(baseLabel, truncate(collection, 40));
            }

            return baseLabel;
        }

        // === Extract tool ===
        case 'extract': {
            const attachmentIds = args.attachment_ids as string[] | undefined;
            const count = Array.isArray(attachmentIds) ? attachmentIds.length : 0;
            const label = args.label as string | undefined;
            if (label) {
                return withDetail(baseLabel, truncate(label, 60));
            }
            if (count > 0) {
                return withDetail(baseLabel, tn(count, '{count} paper', '{count} papers'));
            }
            return baseLabel;
        }

        // === External search tools ===
        case 'external_search': {
            const searchLabel = args.search_label as string | undefined;
            const query = args.query as string | undefined;
            const label = searchLabel || (query ? truncate(query, 60) : null);
            if (label) {
                return withDetail(baseLabel, label);
            }
            return baseLabel;
        }

        case 'lookup_work': {
            // Normalize list parameters (handles JSON strings like "['title']")
            const identifiers = normalizeListParam(args.identifiers);
            const titles = normalizeListParam(args.titles);
            
            // Handle old singular parameter formats
            const identifier = args.identifier as string | undefined;
            const title = args.title as string | undefined;
            
            // Check for invalid parameters
            const hasInvalidIdentifiers = args.identifiers !== undefined && identifiers === null;
            const hasInvalidTitles = args.titles !== undefined && titles === null;
            if (hasInvalidIdentifiers || hasInvalidTitles) {
                return withDetail(baseLabel, t('Invalid query'));
            }
            
            // Count total queries
            const idCount = identifiers?.length ?? (identifier ? 1 : 0);
            const titleCount = titles?.length ?? (title ? 1 : 0);
            const totalCount = idCount + titleCount;
            
            // Single item lookup: show the identifier or title
            if (totalCount === 1) {
                const singleLabel = identifier || title || identifiers?.[0] || titles?.[0];
                if (singleLabel) {
                    return withDetail(baseLabel, truncate(singleLabel, 40));
                }
            }
            
            // Multiple items: show query count while the lookup is running
            if (totalCount > 1) {
                return status === 'completed'
                    ? baseLabel
                    : withDetail(baseLabel, t('{count} queries', { count: totalCount }));
            }
            
            return baseLabel;
        }

        // === Library management tools ===
        case 'zotero_search': {
            const conditions = args.conditions as Array<{ 
                field?: string; 
                value?: string | null; 
                operator?: string 
            }> | undefined;
            
            if (conditions && conditions.length > 0) {
                // Show first condition as summary
                const firstCond = conditions[0];
                const field = firstCond.field || 'any';
                const operator = firstCond.operator || 'is';
                const value = firstCond.value ?? '';
                
                // Operators shown as a symbol, and operators shown in words.
                const operatorSymbols: Record<string, string> = {
                    'is': '=',
                    'isNot': '≠',
                    'isLessThan': '<',
                    'isGreaterThan': '>',
                };
                const operatorWords: Record<string, string> = {
                    'contains': msg('contains'),
                    'doesNotContain': msg('does not contain'),
                    'beginsWith': msg('begins with'),
                    'isBefore': msg('before'),
                    'isAfter': msg('after'),
                    'isInTheLast': msg('in the last'),
                };
                // An operator the tables do not know is shown as given.
                const symbol = lookup(operatorSymbols, operator)
                    ?? (['<', '>', '=', '≠'].includes(operator) ? operator : undefined);
                const words = lookup(operatorWords, operator);
                
                // Format the condition based on operator type
                if (value === '' && (operator === 'doesNotContain' || operator === 'is')) {
                    // Special case: empty field search
                    return withDetail(baseLabel, t('{field} is empty', { field }));
                } else if (symbol !== undefined) {
                    // Symbolic operators
                    return withDetail(baseLabel, `${field} ${symbol} "${truncate(value, 25)}"`);
                } else {
                    // Text operators
                    return withDetail(baseLabel, t('"{field}" {operator} "{value}"', {
                        field,
                        operator: words !== undefined ? t(words) : operator,
                        value: truncate(value, 20),
                    }));
                }
            }
            return baseLabel;
        }

        case 'list_collections': {
            const libraryParam = args.library as string | number | undefined;

            const parentKey = args.parent_collection as string | undefined;
            if (parentKey) {
                if (opts?.enrich?.collectionName) {
                    return t('{label} in "{name}"', { label: baseLabel, name: opts.enrich.collectionName });
                }
                return withDetail(baseLabel, t('subcollections'));
            }

            // Show library name when listing top-level collections
            if (libraryParam != null) {
                return withQuote(baseLabel, opts?.enrich?.libraryName || String(libraryParam));
            }
            return baseLabel;
        }

        case 'list_tags': {
            const libraryParam = args.library as string | number | undefined;

            const collectionKey = args.collection_key as string | undefined;
            if (collectionKey) {
                if (opts?.enrich?.collectionName) {
                    return t('{label} in "{name}"', { label: baseLabel, name: opts.enrich.collectionName });
                }
                return t('{label} in collection', { label: baseLabel });
            }

            // Show library name when listing all tags in a library
            if (libraryParam != null) {
                return withQuote(baseLabel, opts?.enrich?.libraryName || String(libraryParam));
            }
            return baseLabel;
        }

        case 'manage_tags': {
            const tag = args.tag as string | undefined;
            if (tag) {
                return withQuote(baseLabel, truncate(tag, 20));
            }
            return baseLabel;
        }

        case 'manage_collections': {
            const collection = args.collection as string | undefined;
            if (collection) {
                return withQuote(baseLabel, truncate(collection, 20));
            }
            return baseLabel;
        }

        // === Note tools ===
        case 'read_note': {
            // resolvedName is the note title (from the view, or host-resolved).
            if (resolvedName) {
                return withQuote(baseLabel, truncate(resolvedName, 30));
            }
            return baseLabel;
        }

        // === Tool results ===
        case 'load_tool_results': {
            return baseLabel;
        }

        // Progressive disclosure tools
        case 'load_capability': {
            // args.id is the stable, persisted capability id (e.g. "zotero_annotations").
            const id = args.id as string | undefined;
            if (id) {
                return t('Loading tools: {capability}', { capability: truncate(capabilityLabel(id), 30) });
            }
            return t('Loading tools');
        }

        case 'search_tools': {
            // args.queries is a list of strings (older builds used args.keywords).
            const queries = normalizeListParam(args.queries)
                ?? (typeof args.keywords === 'string' ? [args.keywords] : null);
            if (queries && queries[0]) {
                return withQuote(baseLabel, truncate(queries[0], 40));
            }
            return baseLabel;
        }

        // === Tools without dynamic labels ===
        case 'view_page_images':
        case 'add_highlight_annotations':
        case 'add_note_annotations':
        case 'create_zotero_item':
        case 'list_libraries':
        default:
            return baseLabel;
    }
}
