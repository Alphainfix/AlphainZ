/**
 * A hole in `parts` must cost a row, never the panel.
 *
 * Parts arrive by index off the stream, and `parts[event.part_index] = part`
 * makes the array sparse whenever an index skips. Every consumer walks it with
 * `part.part_kind`, so one gap threw during render and took the whole sidebar
 * with it — the user was left looking at a blank panel with no way back but a
 * restart. Watched it happen mid-evaluation.
 */
import { describe, expect, it } from 'vitest';

import { planRunStream, groupStreamUnits } from '../../../react/components/agentRuns/workStream';

const never = () => false;

/** A message whose parts array has a hole at index 1, as the stream leaves it. */
function messageWithHole(): any {
    const parts: any[] = [];
    parts[0] = { part_kind: 'thinking', content: 'thinking out loud' };
    parts[2] = { part_kind: 'tool-call', tool_name: 'read_document', tool_call_id: 'c1' };
    return { kind: 'response', parts };
}

describe('planning a run whose parts are sparse', () => {
    it('does not throw', () => {
        expect(() => planRunStream([messageWithHole()], never)).not.toThrow();
    });

    it('still finds the parts that are there', () => {
        const units = planRunStream([messageWithHole()], never);
        expect(units).toHaveLength(1);
        expect(units[0].thinking).toBe(true);
        expect(units[0].toolNames).toEqual(['read_document']);
    });

    it('survives a parts array that is entirely holes', () => {
        const parts: any[] = [];
        parts[3] = undefined;
        const units = planRunStream([{ kind: 'response', parts }] as any, never);
        expect(() => groupStreamUnits(units)).not.toThrow();
    });

    it('survives a missing parts array', () => {
        expect(() => planRunStream([{ kind: 'response' }] as any, never)).not.toThrow();
    });

    it('still splits work from answer across a hole', () => {
        const withHole: any = { kind: 'response', parts: [] };
        withHole.parts[0] = { part_kind: 'tool-call', tool_name: 'read_document', tool_call_id: 'c1' };
        withHole.parts[2] = { part_kind: 'text', content: 'partway' };
        const answer = { kind: 'response', parts: [{ part_kind: 'text', content: 'the answer' }] };
        const units = planRunStream([withHole, answer] as any, never);
        expect(units.map((u) => u.role)).toEqual(['work', 'answer']);
    });
});
