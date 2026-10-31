/**
 * The thread's compaction record: one JSON column, tolerant on the way out.
 *
 * The wire path reads this on every message, so a corrupt blob must read as
 * "not compacted" rather than fail the request.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

describe('BeaverDB thread compaction', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
        await db.saveRun({
            id: 'run-1',
            thread_id: 'th-1',
            user_id: 'local-user',
            created_at: '2026-08-27T00:00:00.000Z',
            payload: { id: 'run-1' },
        } as any);
    });

    it('migrates idempotently — a second init does not throw', async () => {
        await db.initDatabase('0.99.1');
        expect(await db.threadCompaction('local-user', 'th-1')).toBeNull();
    });

    it('round-trips a record and clears it', async () => {
        const record = {
            summary: 'the story so far',
            throughRunId: 'run-1',
            createdAt: '2026-08-27T01:00:00Z',
            runCount: 8,
        };
        await db.setThreadCompaction('local-user', 'th-1', record);
        expect(await db.threadCompaction('local-user', 'th-1')).toEqual(record);

        await db.setThreadCompaction('local-user', 'th-1', null);
        expect(await db.threadCompaction('local-user', 'th-1')).toBeNull();
    });

    it('tells a missing thread from an uncompacted one', async () => {
        expect(await db.threadCompaction('local-user', 'ghost')).toBeUndefined();
        expect(await db.threadCompaction('local-user', 'th-1')).toBeNull();
    });

    it('clips an oversized summary and repairs a bad runCount on the way out', async () => {
        // The blob can arrive through the sync envelope — another machine's
        // claim, not gospel. Unbounded, it would ride every future request.
        await conn.queryAsync(
            `UPDATE threads SET compaction = ? WHERE id = ?`,
            [JSON.stringify({ summary: 'S'.repeat(9000), throughRunId: 'run-1', createdAt: 'x', runCount: 'lots' }), 'th-1'],
        );
        const record = await db.threadCompaction('local-user', 'th-1');
        expect(record!.summary.length).toBeLessThanOrEqual(4001);
        expect(record!.runCount).toBe(1);
    });

    it('reads a corrupt blob as not compacted', async () => {
        await conn.queryAsync(
            `UPDATE threads SET compaction = ? WHERE id = ?`,
            ['{not json', 'th-1'],
        );
        expect(await db.threadCompaction('local-user', 'th-1')).toBeNull();

        await conn.queryAsync(
            `UPDATE threads SET compaction = ? WHERE id = ?`,
            ['{"summary":42}', 'th-1'],
        );
        expect(await db.threadCompaction('local-user', 'th-1')).toBeNull();
    });
});
