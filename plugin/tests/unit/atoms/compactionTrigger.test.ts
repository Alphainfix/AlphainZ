/**
 * Which run the compaction token trigger measures.
 *
 * The trigger reads the first request of the newest run that reports its
 * usage. The newest stored row is often not that run: a question is stored the
 * moment it is sent, and a stopped turn is kept, and neither has usage.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({ store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() } }));

import { newestRunWithUsage } from '../../../react/atoms/threadCompaction';

const answered = (id: string, input: number) => ({ id, status: 'completed', total_usage: { input_tokens: input } });

describe('newestRunWithUsage', () => {
    it('takes the newest run when it reports usage', () => {
        expect(newestRunWithUsage([answered('a', 10), answered('b', 20)])?.total_usage).toEqual({ input_tokens: 20 });
    });

    it('looks past a question still being answered', () => {
        const rows = [answered('a', 10), answered('b', 90_000), { id: 'c', status: 'canceled' }];
        expect(newestRunWithUsage(rows)?.total_usage).toEqual({ input_tokens: 90_000 });
    });

    it('looks past a stopped turn with nothing to report', () => {
        const rows = [answered('a', 85_000), { id: 'b', status: 'canceled', total_usage: null }];
        expect(newestRunWithUsage(rows)?.total_usage).toEqual({ input_tokens: 85_000 });
    });

    it('finds nothing in a thread with no usage at all', () => {
        expect(newestRunWithUsage([{ id: 'a', status: 'canceled' }])).toBeNull();
        expect(newestRunWithUsage([])).toBeNull();
    });
});
