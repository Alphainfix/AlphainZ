/**
 * Removing runs from a thread — the local half of a retry.
 *
 * Retrying a failed run deletes it and everything after it first. Upstream that
 * is a POST the caller refuses to proceed without, so locally, where the POST
 * cannot succeed, Retry threw instead of retrying.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

describe('BeaverDB.deleteRuns', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    const run = (id: string, createdAt: string) =>
        db.saveRun({
            id,
            thread_id: 'th1',
            user_id: 'local-user',
            created_at: createdAt,
            payload: { id, thread_id: 'th1' },
        } as any);

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
        await run('r1', '2026-08-23T10:00:00.000Z');
        await run('r2', '2026-08-23T11:00:00.000Z');
        await run('r3', '2026-08-23T12:00:00.000Z');
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('removes the named runs and leaves the rest', async () => {
        const report = await db.deleteRuns('th1', ['r2', 'r3'], 'r1');
        expect(report.deleted_run_ids.sort()).toEqual(['r2', 'r3']);
        expect(report.reason).toBeUndefined();

        const left = await db.getRunsForThread('th1');
        expect(left.map((r: any) => r.id)).toEqual(['r1']);
    });

    it('removes the whole thread when nothing is meant to survive', async () => {
        const report = await db.deleteRuns('th1', ['r1', 'r2', 'r3'], null);
        expect(report.deleted_run_ids).toHaveLength(3);
        expect(await db.getRunsForThread('th1')).toEqual([]);
    });

    it('refuses when the surviving tail is not the one the caller expected', async () => {
        // Two Zotero windows share this database. The check is the difference
        // between deleting the runs the caller looked at and deleting whatever
        // happens to be there now.
        const report = await db.deleteRuns('th1', ['r3'], 'r1');
        expect(report.reason).toBe('tail_mismatch');
        expect(report.deleted_run_ids).toEqual([]);
        expect(report.refused_run_ids).toEqual(['r3']);
        // Nothing was touched.
        expect((await db.getRunsForThread('th1')).map((r: any) => r.id)).toEqual([
            'r1',
            'r2',
            'r3',
        ]);
    });

    it('treats an already-absent run as done, not as a refusal', async () => {
        // The caller's intent is that the run not be in the thread. It is not.
        const report = await db.deleteRuns('th1', ['r3', 'never-existed'], 'r2');
        expect(report.reason).toBeUndefined();
        expect(report.deleted_run_ids).toEqual(['r3']);
        expect(report.refused_run_ids).toEqual([]);
    });

    it('does nothing when asked to remove nothing', async () => {
        const report = await db.deleteRuns('th1', [], 'r3');
        expect(report).toEqual({ deleted_run_ids: [], refused_run_ids: [] });
        expect(await db.getRunsForThread('th1')).toHaveLength(3);
    });

    it('leaves another thread alone', async () => {
        await db.saveRun({
            id: 'other',
            thread_id: 'th2',
            user_id: 'local-user',
            created_at: '2026-08-23T13:00:00.000Z',
            payload: { id: 'other', thread_id: 'th2' },
        } as any);
        await db.deleteRuns('th1', ['r1', 'r2', 'r3'], null);
        expect((await db.getRunsForThread('th2')).map((r: any) => r.id)).toEqual(['other']);
    });
});
