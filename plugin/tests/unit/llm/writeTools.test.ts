/**
 * Placing a highlight the agent asked for.
 *
 * The rule that matters: an ambiguous passage is refused, not guessed. A
 * highlight in the wrong paragraph is visible in the user's own library and
 * there is nothing in the answer to explain it, so a wrong placement is worse
 * than no placement.
 */
import { describe, expect, it } from 'vitest';

import {
    AGENT_HIGHLIGHT_COLOR,
    buildHighlightAction,
    WRITE_TOOL_NAMES,
    WRITE_TOOL_SCHEMAS,
} from '../../../src/services/llm/writeTools';

const location = (pageIndex: number, pageLabel?: string) => ({
    pageIndex,
    ...(pageLabel ? { pageLabel } : {}),
    boxes: [{ l: 10, t: 20, r: 200, b: 32 }],
    matchedText: 'the waggle run encodes distance',
});

describe('buildHighlightAction', () => {
    it('builds an action for a single match', () => {
        const result = buildHighlightAction([location(2, '3')], { text: 'waggle run' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.item.page_locations[0].page_idx).toBe(2);
        expect(result.item.page_locations[0].boxes).toHaveLength(1);
        expect(result.item.text).toBe('waggle run');
        // Its own colour, so the agent's highlights are distinguishable from the
        // user's at a glance.
        expect(result.item.color).toBe(AGENT_HIGHLIGHT_COLOR);
    });

    it('refuses a passage that appears on several pages, and says which', () => {
        const result = buildHighlightAction([location(0), location(4)], { text: 'covariance' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // The page numbers are the actionable part: the model can retry with one.
        expect(result.error).toContain('1, 5');
        expect(result.error).toContain('`page`');
    });

    it('explains a miss in terms the model can act on', () => {
        const result = buildHighlightAction([], { text: 'a paraphrase' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain('exactly as it appears');
    });

    it('uses the printed page label for the locator when there is one', () => {
        // A paper numbered "iv" must not be cited as page 1.
        const result = buildHighlightAction([location(0, 'iv')], { text: 'x' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.item.loc.value).toBe('iv');
        expect(result.item.loc_raw).toBe('p. iv');
    });

    it('falls back to the page number when the page has no label', () => {
        const result = buildHighlightAction([location(6)], { text: 'x' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.item.loc.value).toBe('7');
    });

    it('carries a comment when one was given, and omits it otherwise', () => {
        const withComment = buildHighlightAction([location(0)], { text: 'x', comment: 'why' });
        expect(withComment.ok && withComment.item.comment).toBe('why');
        const without = buildHighlightAction([location(0)], { text: 'x' });
        expect(without.ok && 'comment' in without.item).toBe(false);
    });

    it('truncates a very long passage for the title but not for the text', () => {
        const long = 'x'.repeat(200);
        const result = buildHighlightAction([location(0)], { text: long });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.item.title.length).toBe(80);
        expect(result.item.text.length).toBe(200);
    });
});

describe('write tool schemas', () => {
    it('points the model at the locator, and keeps the quoting rule for the fallback', () => {
        /*
         * The single most common failure used to be the model paraphrasing and
         * the lookup finding nothing. The fix is not a firmer instruction: it
         * is an anchor the model can cite instead of a passage it has to
         * reproduce. The quoting rule survives, because `text` is still there
         * for a passage that did not come from `read_document`.
         */
        const highlight = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'create_highlight')!;
        expect(highlight.parameters.properties).toHaveProperty('locator');
        expect(highlight.description).toMatch(/Pass `locator`/);
        expect(highlight.description).toMatch(/character for character/);
        // Neither is required on its own — the tool refuses only when both are
        // missing, which it can say far better than a schema error can.
        expect(highlight.parameters.required).toEqual(['attachment_id']);
    });

    it('offers exactly the tools the executor and undo paths can back', () => {
        /*
         * The line moved twice, and this is where it now sits.
         *
         * It started as "additive only" — nothing but create — on the reasoning
         * that a highlight can be deleted while an overwritten field cannot be
         * recovered. Filing broke that literally (taking a tag off an item is a
         * removal), so it became "destroys nothing".
         *
         * That second line was really a proxy for "can this be taken back", and
         * it answered the question in the wrong place. Every tool here goes
         * through validate → approve → execute, and every action type below has
         * an undo executor in `react/host/zotero/agentActionExecution.ts` —
         * `edit_metadata` and `edit_annotations` through the
         * overwrite-confirmation branch, the rest through `UNDO_EXECUTORS`. So
         * the question is answered by the undo path, and what this test guards
         * is that the two lists stay in step: a tool offered here whose action
         * type has no undo is the failure mode to catch.
         */
        expect(WRITE_TOOL_SCHEMAS.map((t) => t.name)).toEqual([...WRITE_TOOL_NAMES]);

        const UNDOABLE_ACTION_FOR_TOOL: Record<string, string> = {
            create_highlight: 'create_highlight_annotations',
            create_sticky_note: 'create_note_annotations',
            create_note: 'create_note',
            edit_note: 'edit_note',
            edit_metadata: 'edit_metadata',
            edit_annotations: 'edit_annotations',
            delete_annotations: 'edit_annotations',
            add_papers_to_library: 'create_item',
            organize_items: 'organize_items',
            create_collection: 'create_collection',
        };
        for (const name of WRITE_TOOL_NAMES) {
            expect(UNDOABLE_ACTION_FOR_TOOL[name]).toBeTruthy();
        }
    });

    it('tells the model that deletion is the user\'s call, not its own', () => {
        // The one tool here that cannot be softened by an undo the user has to
        // find: they have to be told what is going, in the answer, before they
        // approve.
        const del = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'delete_annotations')!;
        expect(del.description).toMatch(/user has actually asked to remove/);
        expect(del.description).toMatch(/never as tidying you decided on/);
    });

    it('makes the model read a note before editing it', () => {
        // `old_string` has to match the live note exactly and uniquely, and a
        // model that has not read the note is guessing at both.
        const edit = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'edit_note')!;
        expect(edit.description).toMatch(/Read the note first/);
        expect(edit.parameters.required).toEqual(['note_id', 'new_string']);
    });

    it('files by collection key, and says so', () => {
        // A collection name looks like a key to a model and is rejected deep in
        // the executor, by which point the user has been shown a card for a
        // change that cannot happen.
        const organize = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'organize_items')!;
        expect(organize.parameters.required).toEqual(['item_ids']);
        expect(organize.description).toMatch(/key `list_collections` returns, never by their title/);
    });

    it('points a new collection at create_collection, not at organize_items', () => {
        // The key does not exist until the user approves it, so the two-step
        // "make it, then fill it" cannot complete. One call does both.
        const organize = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'organize_items')!;
        expect(organize.description).toMatch(/use `create_collection`\s+with `item_ids` instead/);
        const create = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'create_collection')!;
        expect(Object.keys(create.parameters.properties)).toContain('item_ids');
    });

    it('takes search ids for an import, never metadata', () => {
        // Metadata from the model is metadata that can be invented. An id has
        // to have come back from a search, so an imagined paper has nothing to
        // resolve against.
        const add = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'add_papers_to_library')!;
        expect(Object.keys(add.parameters.properties)).toEqual(['openalex_ids', 'collection_key', 'reason']);
        expect(add.parameters.required).toEqual(['openalex_ids']);
        expect(add.description).toMatch(/never an id you did not\s+receive from a search/);
    });

    it('tells the model an import is a proposal, not a write', () => {
        const add = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'add_papers_to_library')!;
        expect(add.description).toMatch(/Nothing is written when you call this/);
        expect(add.description).toMatch(/never that anything was added, not even in the sentence before the call/);
        // No standing "always apply" for imports; a grant given on a card during
        // the run is the one way the result can say APPLIED.
        expect(add.description).toMatch(/no setting skips that step/);
        expect(add.description).toMatch(/grant the user gives on a card during this run/);
    });

    it('requires an id and content for a note', () => {
        const note = WRITE_TOOL_SCHEMAS.find((t) => t.name === 'create_note')!;
        expect(note.parameters.required).toEqual(['item_id', 'content']);
    });
});
