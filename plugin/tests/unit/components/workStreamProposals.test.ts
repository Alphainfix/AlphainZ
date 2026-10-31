/**
 * A proposal is not narration.
 *
 * The work/answer split treats text up to the last tool call as the model
 * talking its way to an answer. That is right for a read and wrong for a write:
 * "Here is the answer — I'll propose a highlight on it" followed by
 * `create_highlight` put the answer inside the fold and left "Proposed." as the
 * only visible line.
 */
import { describe, expect, it } from 'vitest';

import { groupStreamUnits, planRunStream } from '../../../react/components/agentRuns/workStream';

const text = (content: string) => ({ part_kind: 'text', content });
const call = (tool_name: string, id: string) => ({ part_kind: 'tool-call', tool_name, tool_call_id: id, args: {} });
const response = (...parts: any[]) => ({ kind: 'response', parts });
const returned = (tool_name: string, id: string) => ({
    kind: 'request',
    parts: [{ part_kind: 'tool-return', tool_name, tool_call_id: id, content: 'ok' }],
});
const roles = (messages: any[]) =>
    planRunStream(messages as any, () => false, { streaming: false }).map((u) => `${u.messageIndex}:${u.role}`);

describe('planRunStream: write tools', () => {
    it('keeps the text beside a highlight proposal as the answer', () => {
        const messages = [
            response(text('The limit is the tunnel lining.'), call('create_highlight', 'c1')),
            returned('create_highlight', 'c1'),
            response(text('Proposed one highlight.')),
        ];
        expect(roles(messages)).toEqual(['0:answer', '0:work', '2:answer']);
        // The proposal row is still there — one row, so it renders inline
        // rather than behind a disclosure.
        const groups = groupStreamUnits(planRunStream(messages as any, () => false, { streaming: false }));
        expect(groups[1]).toMatchObject({ kind: 'work', rows: 1, toolNames: ['create_highlight'] });
    });

    it('still folds the reads that came before', () => {
        const messages = [
            response(text('Let me read the page.'), call('read_document', 'r1')),
            returned('read_document', 'r1'),
            response(text('The limit is the tunnel lining.'), call('create_highlight', 'c1')),
            returned('create_highlight', 'c1'),
            response(text('Proposed one highlight.')),
        ];
        expect(roles(messages)).toEqual(['0:work', '2:answer', '2:work', '4:answer']);
    });

    it('treats a proposal-only run as answer while it streams', () => {
        // The streaming rule folds trailing text once the run has done work.
        // A run that has only proposed is not doing work, so its text streams
        // as the answer, as a tool-free reply does.
        const messages = [response(text('Marking it now.'), call('create_sticky_note', 'n1'))];
        const units = planRunStream(messages as any, () => false, { streaming: true });
        expect(units.map((u) => u.role)).toEqual(['answer', 'work']);
    });

    it('still folds trailing text after a read while it streams', () => {
        const messages = [response(text('Reading…'), call('read_document', 'r1')), returned('read_document', 'r1'), response(text('so far'))];
        const units = planRunStream(messages as any, () => false, { streaming: true });
        expect(units.map((u) => u.role)).toEqual(['work', 'work']);
    });

    it('puts the answer above the card it explains', () => {
        // The model writes the sentence, then calls the tool; the reader should
        // meet them in that order, not card-then-caption.
        const messages = [response(text('The limit is the tunnel lining.'), call('create_highlight', 'c1'))];
        const keys = planRunStream(messages as any, () => false, { streaming: false }).map((u) => u.key);
        expect(keys).toEqual(['0-answer', '0-rows']);
    });

    it('reads thinking, then the answer, then the rows the answer produced', () => {
        const messages = [
            response({ part_kind: 'thinking', content: 'hmm' }, text('The limit is the tunnel lining.'), call('create_highlight', 'c1')),
        ];
        const units = planRunStream(messages as any, () => false, { streaming: false });
        expect(units.map((u) => `${u.role}:${u.thinking ? 'thinking' : u.tools}`)).toEqual([
            'work:thinking',
            'answer:none',
            'work:settled',
        ]);
    });

    it('keeps a proposal waiting on the user out of the fold, as before', () => {
        const messages = [response(text('The limit is the tunnel lining.'), call('create_highlight', 'c1'))];
        const units = planRunStream(messages as any, (id) => id === 'c1', { streaming: false });
        expect(units.map((u) => u.role)).toEqual(['answer', 'decision']);
    });
});
