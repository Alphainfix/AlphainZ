/**
 * A proposal has to say what it would do.
 *
 * The rich preview — the passage, the page, the colour, per-item Apply — was
 * gated on the tool's name matching Beaver's server-side catalogue. The local
 * tools are named for the model's benefit (`create_highlight`,
 * `add_papers_to_library`), so none of them matched, and a proposed highlight
 * rendered as a bare row with an Apply button and no sign of what it would
 * apply. The preview existed the whole time and was never reached.
 *
 * The fix keys on the action type the approval carries, which is also what the
 * preview dispatches on. This pins the two ends of that together: whatever
 * `proposeWrite` emits must be a kind both the router and the preview know.
 */
import { describe, expect, it } from 'vitest';

import { STANDARD_AGENT_ACTION_KINDS } from '../../../react/components/agentRuns/ToolCallPartView';

/** The action type each local write tool proposes, from `executeLocalRun`. */
const ACTION_TYPE_BY_TOOL: Record<string, string> = {
    create_highlight: 'create_highlight_annotations',
    create_note: 'create_note',
    add_papers_to_library: 'create_item',
    organize_items: 'organize_items',
    create_collection: 'create_collection',
};

describe('approval preview routing', () => {
    it('routes every local write tool to the preview-and-approve view', () => {
        for (const [tool, actionType] of Object.entries(ACTION_TYPE_BY_TOOL)) {
            expect(
                STANDARD_AGENT_ACTION_KINDS.has(actionType),
                `${tool} proposes ${actionType}, which has no preview`,
            ).toBe(true);
        }
    });

    it('covers the two names a proposal to add papers can arrive under', () => {
        // The local tool emits `create_item`; the server-driven path used
        // `create_items`. Both reach the same preview.
        expect(STANDARD_AGENT_ACTION_KINDS.has('create_item')).toBe(true);
        expect(STANDARD_AGENT_ACTION_KINDS.has('create_items')).toBe(true);
    });

    it('does not sweep read-only tools into it', () => {
        // A search has nothing to approve; giving it the action view would put
        // an Apply button on a result.
        for (const tool of ['read_document', 'search_web_literature', 'list_tags']) {
            expect(STANDARD_AGENT_ACTION_KINDS.has(tool)).toBe(false);
        }
    });
});
