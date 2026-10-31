/**
 * Deleting a conversation, and everything that pointed at it.
 *
 * The two tables this plugin added carry no foreign key, so the delete used to
 * leave them behind — found by clearing a real history and counting what
 * survived: five anchors and twenty item links with no thread.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

describe('BeaverDB.deleteThread', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');

        for (const id of ['keep', 'doomed']) {
            await db.saveRun({
                id: `run-${id}`,
                thread_id: id,
                user_id: 'local-user',
                created_at: '2026-08-23T10:00:00.000Z',
                payload: { id: `run-${id}` },
            } as any);
            await db.setThreadName(id, 'local-user', `thread ${id}`);
            await db.saveThreadAnchor({
                libraryId: 1,
                annotationKey: `ANN${id}`,
                threadId: id,
                attachmentKey: 'ATT1',
                selectedText: 'a passage',
            });
            await db.recordThreadItems(id, [{ libraryId: 1, itemKey: `IT${id}`, source: 'reader' }]);
        }
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('removes the thread and its runs', async () => {
        await db.deleteThread('local-user', 'doomed');
        expect(await db.getRunsForThread('doomed')).toEqual([]);
    });

    it('removes the anchors that pointed at it', async () => {
        // An anchor outliving its thread means a highlight still claims to hold
        // a conversation, and clicking it tries to open one that is gone.
        await db.deleteThread('local-user', 'doomed');
        expect(await db.getThreadAnchor(1, 'ANNdoomed')).toBeNull();
    });

    it('removes the item links that named it', async () => {
        // Otherwise a deleted thread keeps showing under "conversations about
        // this paper".
        await db.deleteThread('local-user', 'doomed');
        const threads = await db.getThreadsForItems(1, ['ITdoomed'], 10);
        expect(threads).toEqual([]);
    });

    it("leaves another thread's anchors and items alone", async () => {
        await db.deleteThread('local-user', 'doomed');
        expect(await db.getThreadAnchor(1, 'ANNkeep')).not.toBeNull();
        expect(await db.getThreadItems('keep')).toHaveLength(1);
        expect(await db.getRunsForThread('keep')).toHaveLength(1);
    });

    it("refuses to delete another owner's thread", async () => {
        await db.deleteThread('someone-else', 'doomed');
        expect(await db.getRunsForThread('doomed')).toHaveLength(1);
    });
});
