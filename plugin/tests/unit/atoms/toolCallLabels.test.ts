/**
 * What the user is told while the agent works.
 *
 * The label is the whole account of a tool call as it happens. Five of the
 * most frequent tools in a run — reading, three kinds of search, and
 * proposing a highlight — were not in the table, so each rendered as the
 * fallback, "Calling function", which says nothing about what is being
 * touched.
 */
import { describe, expect, it } from 'vitest';

import { getToolCallLabel } from '@beaver/agent-core/run-state/toolLabels';

const call = (tool_name: string, args: Record<string, unknown>) => ({
    part_kind: 'tool-call' as const,
    tool_name,
    tool_call_id: 'c1',
    args: JSON.stringify(args),
});

const label = (tool: string, args: Record<string, unknown>, opts?: any) =>
    getToolCallLabel(call(tool, args) as any, 'completed' as any, opts);

describe('tool call labels', () => {
    it('no longer falls back to "Calling function" for the local tools', () => {
        for (const tool of [
            'read_document',
            'search_in_document',
            'search_library_fulltext',
            'search_web_literature',
            'create_highlight',
            'add_papers_to_library',
        ]) {
            expect(label(tool, {})).not.toBe('Calling function');
        }
    });

    it('names the phrase being searched for', () => {
        expect(label('search_web_literature', { query: 'honeybee odometry review' }))
            .toBe('Searching the literature: "honeybee odometry review"');
        expect(label('search_library_fulltext', { query: 'waggle dance' }))
            .toBe('Searching your library: "waggle dance"');
    });

    it('names the colour, the page and the passage of a proposed highlight', () => {
        // The write is legible before the approval card is opened.
        const out = label(
            'create_highlight',
            { color: 'yellow', page: 3, text: 'The tunnel lining limits the dance.' },
            { enrich: { itemDisplayName: 'Arneberg et al. 2009' } },
        );
        expect(out).toBe(
            'Proposing a yellow highlight in Arneberg et al. 2009, p. 3: '
            + '"The tunnel lining limits the dance."',
        );
    });

    it('names the paper being added, and how many others', () => {
        expect(label('add_papers_to_library', { papers: [{ title: 'Honeybee navigation' }] }))
            .toBe('Adding papers to your library: Honeybee navigation');
        expect(label('add_papers_to_library', {
            papers: [{ title: 'Honeybee navigation' }, { title: 'B' }, { title: 'C' }],
        })).toBe('Adding papers to your library: Honeybee navigation and 2 more');
    });

    it('names the document and page being read', () => {
        expect(label('read_document', { pages: '1-8' }, { enrich: { itemDisplayName: 'Arneberg et al. 2009' } }))
            .toBe('Reading: Arneberg et al. 2009, p. 1-8');
    });

    it('falls back to the bare label rather than inventing detail', () => {
        expect(label('create_highlight', {})).toBe('Proposing a highlight');
        expect(label('search_web_literature', {})).toBe('Searching the literature');
    });
});
