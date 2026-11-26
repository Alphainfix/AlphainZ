/**
 * Letting the agent write to the library.
 *
 * The executors have been here all along — `createHighlightAnnotations` and
 * `createNoteAnnotations` are the same code Beaver's server drove. What the
 * server also supplied was the geometry: it held the extraction and sent back
 * page rects. Locally that lookup is `locateTextInDocument`, so these tools are
 * the two halves joined.
 *
 * The set started additive-only, on the reasoning that a highlight can be
 * deleted while an overwritten field cannot be recovered. That held until the
 * editing tools were wired back up, and it stopped being the right line: every
 * destructive action here goes through validate → approve → execute and has an
 * undo executor behind it, so "can this be taken back" is answered by the undo
 * path rather than by refusing to offer the tool. What has not changed is the
 * preference: the whole set is off by default, because an agent that can edit a
 * research library should do so because the user decided it should.
 */

import type { ToolSchema } from './types';

/** Colour the agent's own highlights, so they are distinguishable at a glance. */
export const AGENT_HIGHLIGHT_COLOR = 'blue';

/**
 * Colours a highlight may be given, as the model is allowed to name them.
 *
 * Zotero's own eight-colour annotation palette, so an agent highlight is
 * indistinguishable from one the user made by hand and lands under the same
 * swatch in the reader's colour filter. Kept as an enum on the schema rather
 * than free text: an unknown name would silently fall back to the default, and
 * a colour-coded pass would come back one flat colour with no error.
 */
export const HIGHLIGHT_COLOR_NAMES = [
    'yellow', 'red', 'green', 'blue', 'purple', 'magenta', 'orange', 'gray',
] as const;

export type HighlightColorName = (typeof HIGHLIGHT_COLOR_NAMES)[number];

/** Whether `value` is a colour the palette knows. */
export function isHighlightColorName(value: unknown): value is HighlightColorName {
    return typeof value === 'string' && (HIGHLIGHT_COLOR_NAMES as readonly string[]).includes(value);
}

/** In the order the schemas are declared below, which is the order the model sees. */
export const WRITE_TOOL_NAMES = [
    'create_highlight',
    'create_sticky_note',
    'edit_note',
    'edit_metadata',
    'edit_annotations',
    'delete_annotations',
    'create_note',
    'add_papers_to_library',
    'organize_items',
    'create_collection',
] as const;

/** Annotations one `edit_annotations` or `delete_annotations` call may touch. */
export const MAX_ANNOTATION_EDITS = 100;

/** Items one `organize_items` call may touch, matching the executor's own cap. */
export const MAX_ORGANIZE_ITEMS = 100;

export const WRITE_TOOL_SCHEMAS: ToolSchema[] = [
    {
        name: 'create_highlight',
        description:
            "Propose a highlight on a passage in a PDF in the user's library. "
            + '**Pass `locator`** — the `[s12]` label `read_document` prints before each '
            + 'sentence. That places the highlight by index: it cannot be misquoted, cannot '
            + 'land on the wrong page, and cannot fail because you reworded something. `text` '
            + 'is the fallback for a passage you did not get from `read_document`, and it has '
            + 'to be quoted character for character. Highlight the specific sentence that '
            + 'matters, not a whole paragraph. ' +
            "Nothing is written when you call this. Each call returns as soon as the proposal is registered, and the user approves or rejects them together once your answer is finished. So propose every highlight you intend to make, one call each, without waiting on the user between them — and write your summary as what you are proposing, not as what has been added. "
            + 'The result hands back a `citation` tag for the passage, on the page it was actually '
            + 'found on. Place it in your answer right after the sentence describing that '
            + 'passage: it is what lets the reader jump straight to it.',
        parameters: {
            type: 'object',
            properties: {
                attachment_id: {
                    type: 'string',
                    description: 'Attachment id from a search or metadata result, e.g. "u-UH6CTDV5".',
                },
                locator: {
                    type: 'string',
                    description:
                        'The label `read_document` printed before the sentence — `s12` for a '
                        + 'sentence, `p4` for a whole paragraph, `heading2` for a heading. Use a '
                        + 'range like `s12-s13` when one sentence was split across two labels. '
                        + 'This is the reliable way; prefer it whenever you have read the page.',
                },
                text: {
                    type: 'string',
                    description:
                        'Fallback when you have no locator: the passage quoted exactly from the '
                        + 'document, character for character. One sentence is usually right.',
                },
                page: {
                    type: 'integer',
                    description:
                        'Only used with `text`: a 1-based page to prefer when the quote is '
                        + 'ambiguous. A locator carries its own page.',
                },
                comment: {
                    type: 'string',
                    description: 'Optional note attached to the highlight explaining why it matters.',
                },
                color: {
                    type: 'string',
                    enum: [...HIGHLIGHT_COLOR_NAMES],
                    description:
                        'Optional highlight colour, from Zotero\'s own palette. Use it when the user asks for a colour scheme — a colour-coded pass over a paper needs a different one per category. Defaults to blue.',
                },
            },
            required: ['attachment_id'],
        },
    },
    {
        name: 'create_sticky_note',
        description:
            "Propose a sticky note in the margin of a PDF in the user's library — Zotero's "
            + 'note annotation, the yellow square you can click open in the reader. Use it for a '
            + 'remark about a passage that is not itself worth highlighting: a caveat, a '
            + 'connection to another paper, a question. When the point IS the passage, use '
            + '`create_highlight` with a comment instead — one mark beats two. '
            + 'Nothing is written when you call this; the user decides after your answer.',
        parameters: {
            type: 'object',
            properties: {
                attachment_id: {
                    type: 'string',
                    description: 'Attachment id from a search or metadata result, e.g. "u-UH6CTDV5".',
                },
                page: {
                    type: 'integer',
                    description: '1-based page the note belongs on.',
                },
                comment: {
                    type: 'string',
                    description: 'What the note says. This is the whole point of the note; write it for the user, not for yourself.',
                },
                anchor_text: {
                    type: 'string',
                    description:
                        'Optional passage on that page the note is about, quoted exactly. The note '
                        + 'is placed level with it in the margin; without it the note goes to the '
                        + 'top of the page.',
                },
                color: {
                    type: 'string',
                    enum: [...HIGHLIGHT_COLOR_NAMES],
                    description: "Optional colour from Zotero's palette. Defaults to yellow.",
                },
            },
            required: ['attachment_id', 'page', 'comment'],
        },
    },
    {
        name: 'edit_note',
        description:
            'Propose an edit to an existing Zotero note. Read the note first with `read_note` — '
            + '`old_string` has to match the note exactly and uniquely, and you cannot know that '
            + 'without having read it. Prefer the smallest edit that does the job: a targeted '
            + 'replacement is reviewable, a rewrite is not. '
            + 'Nothing is written when you call this; the user sees the change as a diff and '
            + 'approves it after your answer, and can undo it afterwards.',
        parameters: {
            type: 'object',
            properties: {
                note_id: {
                    type: 'string',
                    description: 'Note id, e.g. "u-23PWVCK3", from `read_note` or a search result.',
                },
                operation: {
                    type: 'string',
                    enum: ['str_replace', 'str_replace_all', 'insert_after', 'insert_before', 'append', 'rewrite'],
                    description:
                        'What kind of edit. `str_replace` (the default) replaces one unique match; '
                        + '`insert_after`/`insert_before` leave `old_string` in place and add around '
                        + 'it; `append` adds to the end; `rewrite` replaces the whole body and '
                        + 'should be a last resort.',
                },
                old_string: {
                    type: 'string',
                    description:
                        'The exact text to find, copied from `read_note`. Required for every '
                        + 'operation except `append` and `rewrite`. It must appear exactly once '
                        + 'unless you use `str_replace_all`.',
                },
                new_string: {
                    type: 'string',
                    description: 'The replacement, insertion, or new body.',
                },
            },
            required: ['note_id', 'new_string'],
        },
    },
    {
        name: 'edit_metadata',
        description:
            "Propose corrections to an item's bibliographic fields. Use it for metadata that is "
            + 'demonstrably wrong or missing — a truncated title, a missing year or DOI, an author '
            + 'list mangled by an import. Check the current values with `get_metadata` first and '
            + 'change only the fields you have a reason to change. '
            + 'Nothing is written when you call this; the user sees the old and new value side by '
            + 'side and approves after your answer.',
        parameters: {
            type: 'object',
            properties: {
                item_id: {
                    type: 'string',
                    description: 'Item id, e.g. "u-23PWVCK3".',
                },
                fields: {
                    type: 'object',
                    description:
                        'Field names to new values, using Zotero\'s own field names — '
                        + '`title`, `date`, `DOI`, `publicationTitle`, `volume`, `issue`, `pages`, '
                        + '`abstractNote`, `url`. Only the fields you name are touched.',
                    additionalProperties: { type: 'string' },
                },
                creators: {
                    type: 'array',
                    description:
                        'Optional replacement author list. Give the whole list, not a patch — it '
                        + 'replaces the existing creators. Omit it to leave them alone.',
                    items: {
                        type: 'object',
                        properties: {
                            firstName: { type: 'string' },
                            lastName: { type: 'string' },
                            name: { type: 'string', description: 'For an organisation, instead of first/last.' },
                            creatorType: { type: 'string', description: 'e.g. "author", "editor".' },
                        },
                        required: ['creatorType'],
                    },
                },
            },
            required: ['item_id', 'fields'],
        },
    },
    {
        name: 'edit_annotations',
        description:
            'Propose changes to annotations that already exist — recolour them, add or change a '
            + 'comment, add or remove tags. Get the ids from `find_annotations` or '
            + '`get_annotations`. Every annotation in one call receives the same change, so make '
            + 'one call per group: "the methods ones blue, the results ones yellow" is two calls. '
            + 'Tags are additive: name what to add and what to remove rather than replacing the '
            + 'set. Nothing is written when you call this; the user approves after your answer.',
        parameters: {
            type: 'object',
            properties: {
                annotation_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Annotation ids, e.g. ["u-P4SYGK2Y"]. All of them get the same change.',
                },
                color: {
                    type: 'string',
                    enum: [...HIGHLIGHT_COLOR_NAMES],
                    description: 'New colour, from Zotero\'s palette.',
                },
                comment: {
                    type: 'string',
                    description: "New comment. Replaces the annotation's existing comment; pass an empty string to clear it.",
                },
                add_tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tags to add.',
                },
                remove_tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tags to remove.',
                },
            },
            required: ['annotation_ids'],
        },
    },
    {
        name: 'delete_annotations',
        description:
            'Propose deleting annotations. This one destroys work, so it is only for what the '
            + 'user has actually asked to remove — never as tidying you decided on, and never on '
            + 'an annotation you are not certain they meant. Say which ones and why in your '
            + 'answer. Nothing is deleted when you call this; the user approves after your answer.',
        parameters: {
            type: 'object',
            properties: {
                annotation_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Annotation ids to delete, e.g. ["u-P4SYGK2Y"].',
                },
            },
            required: ['annotation_ids'],
        },
    },
    {
        name: 'create_note',
        description:
            "Propose a note on an item in the user's library. It is saved as a child note under that item, where the user will look for it. Use this for a summary or a synthesis the user asked to keep; do not use it to reply to the user, which is what your answer is for. " +
            "Nothing is written when you call this — the user approves it after your answer is finished, so describe it as proposed rather than saved.",
        parameters: {
            type: 'object',
            properties: {
                item_id: {
                    type: 'string',
                    description:
                        'The item the note is about, e.g. "u-23PWVCK3"; the note is filed under it. '
                        + 'An attachment id files it under that attachment\'s paper.',
                },
                title: {
                    type: 'string',
                    description:
                        'Short heading for the note. If omitted and the content opens with a heading, '
                        + 'that heading becomes the title; otherwise the note is titled "Note".',
                },
                content: {
                    type: 'string',
                    description: 'The note body. Plain text or simple HTML.',
                },
            },
            required: ['item_id', 'content'],
        },
    },
    {
        name: 'add_papers_to_library',
        description:
            "Propose adding papers to the user's Zotero library. The papers must have come back "
            + 'from `search_web_literature` in this conversation — pass the OpenAlex ids it '
            + 'returned (the `W…` values), not retyped metadata, and never an id you did not '
            + 'receive from a search. An open-access PDF is fetched where one exists. '
            + 'Nothing is written when you call this: the user is shown each paper and '
            + 'approves it after your answer is finished, and no setting skips that step — only '
            + 'a grant the user gives on a card during this run, which the result reports as '
            + 'APPLIED. Describe what you are proposing and why — never that anything was '
            + 'added, not even in the sentence before the call. The run ends at that approval — you '
            + 'cannot file the paper into a collection afterwards, so if it belongs in one, '
            + 'pass `collection_key` now; the card shows that destination and the user can '
            + 'change it before approving.',
        parameters: {
            type: 'object',
            properties: {
                openalex_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'OpenAlex ids from a search result in this conversation, e.g. ["W2741809807"].',
                },
                collection_key: {
                    type: 'string',
                    description:
                        'Where to file the papers: a collection `key` as returned by `list_collections` '
                        + '(never its name). Pass it whenever the user named a folder, or the papers '
                        + 'belong with the one they are reading — get_metadata reports that paper\'s '
                        + 'collections. Omit to let the user pick on the card.',
                },
                reason: {
                    type: 'string',
                    description:
                        'One sentence on why these are worth adding, shown to the user on the approval card.',
                },
            },
            required: ['openalex_ids'],
        },
    },
    {
        name: 'organize_items',
        description:
            "Propose filing items in the user's library: adding or removing tags, and adding or "
            + 'removing collection membership. Nothing is moved out of the library and nothing is '
            + 'deleted — removing an item from a collection leaves the item itself untouched. '
            + 'Collections are named by the key `list_collections` returns, never by their title. '
            + 'To file items into a collection that does not exist yet, use `create_collection` '
            + 'with `item_ids` instead: it makes the collection and files them in one step, which '
            + 'this tool cannot do because the new key does not exist until the user approves it. '
            + `Up to ${MAX_ORGANIZE_ITEMS} items per call — batch them rather than calling once per item. `
            + 'Nothing is written when you call this: the user is shown what would change and '
            + 'approves it after your answer is finished, so describe it as proposed.',
        parameters: {
            type: 'object',
            properties: {
                item_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Item ids from a search or metadata result, e.g. ["u-23PWVCK3"].',
                },
                add_tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Tags to add to every listed item. Reuse the user\'s existing tags where '
                        + 'they fit — `list_tags` shows them — and keep new ones lowercase and short.',
                },
                remove_tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tags to remove from every listed item.',
                },
                add_to_collections: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Collection keys from `list_collections`, e.g. ["ABCD1234"].',
                },
                remove_from_collections: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Collection keys to remove these items from.',
                },
            },
            required: ['item_ids'],
        },
    },
    {
        name: 'create_collection',
        description:
            "Propose a new collection in the user's library, optionally with items filed into it. "
            + 'Pass `item_ids` whenever you know what belongs in it: the collection and its '
            + 'contents are then one proposal the user accepts or rejects together, and it is the '
            + 'only way to file items into a collection that does not exist yet. '
            + 'The collection is created in the library its items and parent are in (My Library '
            + 'when there are neither); items from different libraries need a collection each. '
            + 'Nothing is written when you call this — describe it as proposed.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Collection name.' },
                parent_key: {
                    type: 'string',
                    description:
                        'Key of an existing collection to nest this one under, from '
                        + '`list_collections`. Omit for a top-level collection.',
                },
                item_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Items to file into the new collection, e.g. ["u-23PWVCK3"].',
                },
            },
            required: ['name'],
        },
    },
];

export const FULLTEXT_TOOL_SCHEMA: ToolSchema = {
    name: 'search_library_fulltext',
    description:
        "Search the full text of the user's papers, not just their titles and abstracts. This is the tool for \"which of my papers discusses X\" or \"where have I read about Y\" — it matches passages by meaning and returns the paper, the page, and the passage itself. item_search_by_topic only sees what a paper is *about*; this sees what it says. Follow up with read_document on a hit to read around it.",
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description:
                    'What to look for, phrased as the idea rather than as keywords — matching is by meaning.',
            },
            limit: {
                type: 'integer',
                description: 'Maximum passages to return (default 8).',
            },
        },
        required: ['query'],
    },
};

/**
 * Finding a figure by describing it. Offered when the embedding model indexed
 * the PDFs' pages as pictures (Gemini Embedding 2, EmbeddingGemma 2) and the
 * chat model can look at a page.
 */
export const FIGURE_TOOL_SCHEMA: ToolSchema = {
    name: 'search_library_figures',
    description:
        "Find pages in the user's PDFs by what their figures show — a microscope image, a kind of plot, a schematic, a flow diagram — described in words. Every page was indexed as a picture, so this matches what is drawn on it, not only what the text says. Results are pages, not figures, ranked by how closely the page looks like the description: look at a hit with view_page_images before saying what it shows, and cite it by its page. For what a paper says, use search_library_fulltext.",
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description:
                    'The figure described as you would to a person: what it shows, what kind of image or plot it is, labels or parts you would expect. English works best; any language is matched.',
            },
            limit: {
                type: 'integer',
                description: 'Maximum pages to return (default 6).',
            },
        },
        required: ['query'],
    },
};

/** A located highlight, in the shape the executor's action data expects. */
export interface HighlightActionItem {
    index: number;
    client_item_id: string;
    title: string;
    loc_raw: string;
    loc: { kind: 'page'; value: string; raw: string };
    text: string;
    color: string;
    comment?: string | null;
    page_locations: Array<{
        page_idx: number;
        boxes: Array<{ l: number; t: number; r: number; b: number }>;
        page_label?: string | null;
    }>;
    page_label?: string | null;
}

/**
 * Build the action data for a highlight from a located passage.
 *
 * Split out so the ambiguity rule is testable without a PDF: more than one
 * match means the tool refuses rather than guessing, because a highlight in the
 * wrong paragraph is visible to the user and unexplainable.
 */
export function buildHighlightAction(
    locations: Array<{
        pageIndex: number;
        pageLabel?: string;
        boxes: Array<{ l: number; t: number; r: number; b: number }>;
        matchedText: string;
    }>,
    options: { text: string; comment?: string; color?: string },
): { ok: true; item: HighlightActionItem } | { ok: false; error: string } {
    if (locations.length === 0) {
        return {
            ok: false,
            error:
                'That text was not found in the document. Quote the passage exactly as it appears, '
                + 'including punctuation — a paraphrase cannot be placed. Two things trip this up most '
                + 'often, both from how the PDF was extracted: a superscript reference marker welded to '
                + 'the last word (`temperatures.15`), and a markdown heading marker (`## Title`). Drop '
                + 'either and quote the sentence itself. If it still fails, quote a shorter run of words '
                + 'from the middle of the sentence rather than the whole of it.',
        };
    }
    if (locations.length > 1) {
        const pages = locations.map((l) => l.pageIndex + 1).join(', ');
        return {
            ok: false,
            error: `That text appears on more than one page (${pages}). Pass \`page\` to say which one, or quote a longer, unique passage.`,
        };
    }

    const location = locations[0];
    const pageLabel = location.pageLabel ?? String(location.pageIndex + 1);
    return {
        ok: true,
        item: {
            index: 0,
            client_item_id: `local-highlight-${location.pageIndex}`,
            title: options.text.slice(0, 80),
            loc_raw: `p. ${pageLabel}`,
            loc: { kind: 'page', value: pageLabel, raw: `p. ${pageLabel}` },
            text: options.text,
            color: options.color ?? AGENT_HIGHLIGHT_COLOR,
            ...(options.comment ? { comment: options.comment } : {}),
            page_locations: [
                {
                    page_idx: location.pageIndex,
                    boxes: location.boxes,
                    page_label: location.pageLabel ?? null,
                },
            ],
            page_label: location.pageLabel ?? null,
        },
    };
}


/**
 * The question tool.
 *
 * Not a write tool and not behind the write preference: asking is not a change
 * to the library, and a user who has not turned writes on should still be asked
 * before the agent guesses at what they meant. Declared here because this is
 * where the locally-implemented tool schemas live.
 *
 * The bound on question count is Beaver's: past four the card stops being a
 * question and becomes a form, and a run that stops to fill in a form has cost
 * more than the guess would have.
 */
export const ASK_USER_QUESTION_TOOL: ToolSchema = {
    name: 'ask_user_question',
    description:
        'Ask the user a multiple-choice question and wait for the answer. Use it when the '
        + 'request is genuinely ambiguous and the readings lead to materially different work — '
        + 'which colour scheme, which of two papers, whether to include preprints. Do not use it '
        + 'for something you can look up, for a choice with an obvious default, or to confirm '
        + 'work you have already been asked to do: a question the user has to stop and answer '
        + 'costs them more than a sensible default and a sentence saying what you assumed. '
        + 'The run pauses here, so ask everything you need in one call.',
    parameters: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'Optional heading for the card, e.g. "Colour scheme".',
            },
            questions: {
                type: 'array',
                minItems: 1,
                maxItems: 4,
                description: 'One to four questions, each with its own options.',
                items: {
                    type: 'object',
                    properties: {
                        header: {
                            type: 'string',
                            description: 'Very short chip label, at most about 12 characters.',
                        },
                        question: {
                            type: 'string',
                            description: 'The question, written out in full and ending in a question mark.',
                        },
                        options: {
                            type: 'array',
                            minItems: 2,
                            maxItems: 4,
                            description:
                                'Two to four distinct choices. Put the one you would recommend '
                                + 'first. Do not add an "Other" option — set `allow_custom` instead.',
                            items: {
                                type: 'object',
                                properties: {
                                    label: { type: 'string', description: 'The choice, in a few words.' },
                                    description: {
                                        type: 'string',
                                        description: 'What picking it means, or what it costs.',
                                    },
                                },
                                required: ['label'],
                            },
                        },
                        allow_multiple: {
                            type: 'boolean',
                            description: 'Whether several options may be picked at once.',
                        },
                        allow_custom: {
                            type: 'boolean',
                            description: 'Whether the user may type an answer of their own.',
                        },
                    },
                    required: ['question', 'options'],
                },
            },
        },
        required: ['questions'],
    },
};

/** Questions one call may ask, matching the card's own limit. */
export const MAX_QUESTIONS_PER_CALL = 4;


/**
 * Follow-up suggestions.
 *
 * The chips under a finished answer are rendered from this tool call's
 * arguments — there is no executor and nothing to apply; calling it *is* the
 * output. Another piece of UI that has been in the tree since the fork with
 * nothing able to raise it.
 *
 * Worth having for a reason beyond convenience: the good follow-up to a
 * literature answer is usually one the reader would not have thought to type,
 * and a suggestion that names a specific paper or a specific comparison is a
 * cheaper way to offer it than a paragraph at the end of the answer.
 */
export const RETURN_SUGGESTIONS_TOOL: ToolSchema = {
    name: 'return_suggestions',
    description:
        'Offer two or three follow-up questions as one-click chips under your answer. Call it '
        + 'once, last, after your answer is written — and only when you have a specific next step '
        + 'in mind. A generic "tell me more" is worse than nothing; a suggestion that names a '
        + 'paper, a comparison or a concrete task is what makes this worth the click. '
        + '**Write nothing after this call.** Your answer is already finished; a sign-off after '
        + 'the chips just repeats it.',
    parameters: {
        type: 'object',
        properties: {
            suggestions: {
                type: 'array',
                minItems: 1,
                maxItems: 3,
                items: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'What the chip says. A few words, in the user\'s language.',
                        },
                        query: {
                            type: 'string',
                            description:
                                'The question that is actually sent if the user clicks it. Write it '
                                + 'in full, as the user would.',
                        },
                        goal: {
                            type: 'string',
                            enum: ['understand', 'expand', 'organize', 'capture'],
                            description:
                                'What the follow-up is for: understanding the material, widening '
                                + 'the search, tidying the library, or writing something down.',
                        },
                    },
                    required: ['text', 'query', 'goal'],
                },
            },
        },
        required: ['suggestions'],
    },
};


/**
 * Looking one paper up, and walking the citation graph.
 *
 * Read-only, so not behind the write preference; declared here with the other
 * locally-implemented schemas. `search_web_literature` finds papers by topic;
 * these three answer the questions a topic search cannot: *this exact paper*,
 * *who built on it*, *what it built on*. The OpenAlex client has had all three
 * calls since the fork and nothing reached them, which is why a model handed a
 * reference-list entry could only search for it by title — and, in one run the
 * user saw, burn its whole search budget failing to.
 */
export const LITERATURE_GRAPH_TOOLS: ToolSchema[] = [
    {
        name: 'lookup_paper',
        description:
            'Find one specific paper by DOI, or by its exact title. Use this — not '
            + '`search_web_literature` — when you already know which paper you want: a DOI from a '
            + "reference list, a title the user named. It is one lookup rather than a search, so "
            + 'it does not come back with near-misses to sort through.',
        parameters: {
            type: 'object',
            properties: {
                doi: { type: 'string', description: 'DOI, with or without the https://doi.org/ prefix.' },
                title: {
                    type: 'string',
                    description: 'Exact title, if you have no DOI. Less reliable than a DOI.',
                },
            },
        },
    },
    {
        name: 'find_citing_papers',
        description:
            'List papers that cite a given work — the "who built on this" direction. Use it for '
            + '"has anyone followed this up", "is this still the state of the art", or to find '
            + 'newer work on a method the user already has. Takes the OpenAlex id (`W…`) from '
            + '`search_web_literature` or `lookup_paper`. '
            + 'What comes back **is** the citing list, taken from the citation graph — do not '
            + 'check it by reading each result\'s references. One run spent its whole lookup '
            + 'budget doing exactly that and then could not answer.',
        parameters: {
            type: 'object',
            properties: {
                openalex_id: { type: 'string', description: 'OpenAlex work id, e.g. "W2741809807".' },
            },
            required: ['openalex_id'],
        },
    },
    {
        name: 'find_cited_papers',
        description:
            "List the works a given paper cites — its reference list. Use it to find the source of "
            + 'a claim, or the foundational papers behind something the user is reading. Takes the '
            + 'OpenAlex id (`W…`) from `search_web_literature` or `lookup_paper`.',
        parameters: {
            type: 'object',
            properties: {
                openalex_id: { type: 'string', description: 'OpenAlex work id, e.g. "W2741809807".' },
            },
            required: ['openalex_id'],
        },
    },
];
