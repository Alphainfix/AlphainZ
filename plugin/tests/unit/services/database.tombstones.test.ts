/**
 * Deletion tombstones: the durable "this conversation was deleted at T" claim.
 *
 * A bare row delete does not stick — the detached post-run tails recreate the
 * row via INSERT OR IGNORE, and sync re-imports it from any surviving copy.
 * These pin the two halves that make deletion final: the write guards, and
 * the last-write-wins comparison a newer copy can still win.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const USER = 'local-user';
const T1 = 'thread-tombstoned';

describe('thread tombstones', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('round-trips add / read / remove', async () => {
        expect(await db.threadTombstone(USER, T1)).toBeNull();
        await db.addThreadTombstone(USER, T1, '2026-08-29T01:00:00.000Z');
        expect(await db.threadTombstone(USER, T1)).toBe('2026-08-29T01:00:00.000Z');
        expect(await db.threadTombstones(USER)).toEqual([
            { thread_id: T1, deleted_at: '2026-08-29T01:00:00.000Z' },
        ]);
        await db.removeThreadTombstone(USER, T1);
        expect(await db.threadTombstone(USER, T1)).toBeNull();
    });

    it('a second add keeps the later deletion time, whichever order they arrive', async () => {
        await db.addThreadTombstone(USER, T1, '2026-08-29T02:00:00.000Z');
        await db.addThreadTombstone(USER, T1, '2026-08-29T01:00:00.000Z');
        expect(await db.threadTombstone(USER, T1)).toBe('2026-08-29T02:00:00.000Z');
        await db.addThreadTombstone(USER, T1, '2026-08-29T03:00:00.000Z');
        expect(await db.threadTombstone(USER, T1)).toBe('2026-08-29T03:00:00.000Z');
    });

    it('saveRun refuses to resurrect a tombstoned thread', async () => {
        await db.addThreadTombstone(USER, T1, '2026-08-29T01:00:00.000Z');
        await db.saveRun({
            id: 'run-late',
            thread_id: T1,
            user_id: USER,
            payload: { id: 'run-late' },
        } as any);
        expect(await db.getThread(USER, T1)).toBeNull();
        expect(await db.getRunsForThread(T1)).toEqual([]);
    });

    it('setThreadName and ensureThread refuse too', async () => {
        await db.addThreadTombstone(USER, T1, '2026-08-29T01:00:00.000Z');
        await db.setThreadName(T1, USER, 'a name from a stale title call');
        await db.ensureThread(T1, USER, 'sent into a deleted thread', '2026-08-29T02:00:00.000Z');
        expect(await db.getThread(USER, T1)).toBeNull();
    });

    it('removing the tombstone lets writes through again — the revive path', async () => {
        await db.addThreadTombstone(USER, T1, '2026-08-29T01:00:00.000Z');
        await db.removeThreadTombstone(USER, T1);
        await db.saveRun({
            id: 'run-revived',
            thread_id: T1,
            user_id: USER,
            payload: { id: 'run-revived' },
        } as any);
        expect(await db.getThread(USER, T1)).not.toBeNull();
    });

    it('initDatabase is idempotent over the tombstone table', async () => {
        await db.addThreadTombstone(USER, T1, '2026-08-29T01:00:00.000Z');
        await db.initDatabase('0.99.1');
        expect(await db.threadTombstone(USER, T1)).toBe('2026-08-29T01:00:00.000Z');
    });
});
