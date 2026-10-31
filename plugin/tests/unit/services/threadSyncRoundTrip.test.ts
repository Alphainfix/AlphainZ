/**
 * Two computers' databases exchanging one conversation through its file, on
 * real SQLite: what a retry's removal does on the other side, what the other
 * side learns about papers and highlights, and what the history search and
 * the archive list read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { BeaverDB } from '../../../src/services/database';
import { importParsedThread, serializeThread } from '../../../src/services/threadZoteroSync';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const USER = 'local-user';
const T = '33333333-3333-4333-8333-333333333333';

let conns: MockDBConnection[] = [];

async function openDb(): Promise<BeaverDB> {
    const conn = new MockDBConnection();
    conns.push(conn);
    const db = new BeaverDB(conn as any);
    await db.initDatabase('0.99.0');
    return db;
}

function run(id: string, createdAt: string, over: Record<string, unknown> = {}) {
    return {
        id, thread_id: T, user_id: USER, created_at: createdAt, status: 'completed',
        model_name: 'deepseek-flash', provider_name: 'deepseek',
        user_prompt: { content: `question ${id}` },
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: `answer ${id}` }] }],
        ...over,
    };
}

async function store(db: BeaverDB, record: any, threadId = T) {
    await db.saveRun({ id: record.id, thread_id: threadId, user_id: USER, created_at: record.created_at, payload: record });
}

async function runIds(db: BeaverDB, threadId = T): Promise<string[]> {
    return (await db.getRunsForThread(threadId)).map((r: any) => r.id);
}

beforeEach(() => {
    (Zotero as any).Users = { getLocalUserKey: () => 'machine-A' };
    (Zotero as any).Libraries = { ...(Zotero as any).Libraries, userLibraryID: 1 };
    (Zotero as any).Groups = { getLibraryIDFromGroupID: (groupID: number) => (groupID === 123 ? 5 : false) };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
});

afterEach(async () => {
    vi.useRealTimers();
    for (const conn of conns) await conn.closeDatabase();
    conns = [];
});

describe('a retry on one computer, synced to the other', () => {
    it('takes the replaced answer out of the other computer\'s copy too', async () => {
        const a = await openDb();
        const b = await openDb();
        for (const db of [a, b]) {
            await store(db, run('r1', '2026-09-24T09:00:00Z'));
            await store(db, run('r2', '2026-09-24T09:05:00Z', { status: 'error' }));
        }
        // A retries the failed turn: r2 goes, r3 replaces it.
        vi.setSystemTime(new Date('2026-09-24T11:00:00Z'));
        await a.deleteRuns(T, ['r2'], 'r1');
        await store(a, run('r3', '2026-09-24T11:00:00Z'));

        const file = (await serializeThread(a, USER, T, 'now'))!;
        expect(file.removedRuns?.map((r) => r.id)).toEqual(['r2']);
        expect(await importParsedThread(b, USER, JSON.parse(JSON.stringify(file)))).toBe('imported');
        expect(await runIds(b)).toEqual(['r1', 'r3']);
    });

    it('is not undone by a copy the other computer wrote before it heard', async () => {
        const a = await openDb();
        await store(a, run('r1', '2026-09-24T09:00:00Z'));
        await store(a, run('r2', '2026-09-24T09:05:00Z', { status: 'error' }));
        vi.setSystemTime(new Date('2026-09-24T11:00:00Z'));
        await a.deleteRuns(T, ['r2'], 'r1');
        await store(a, run('r3', '2026-09-24T11:00:00Z'));

        // B still has r2, continued the chat, and wrote the newer file.
        const stale = {
            version: 1,
            thread: { id: T, name: 'n', createdAt: '2026-09-24T09:00:00Z', updatedAt: '2026-09-24T12:00:00Z' },
            runs: [run('r1', '2026-09-24T09:00:00Z'), run('r2', '2026-09-24T09:05:00Z', { status: 'error' }),
                run('r4', '2026-09-24T12:00:00Z')],
            exportedBy: 'machine-B', exportedAt: '2026-09-24T12:00:00Z',
        } as any;
        expect(await importParsedThread(a, USER, stale)).toBe('imported');
        // B's new turn arrives; the replaced one does not come back.
        expect(await runIds(a)).toEqual(['r1', 'r3', 'r4']);
    });

    it('is applied even from a file older than the copy here', async () => {
        // Run ids are never reused, so the marker means the same thing
        // whichever copy is newer.
        const b = await openDb();
        await store(b, run('r1', '2026-09-24T09:00:00Z'));
        await store(b, run('r2', '2026-09-24T09:05:00Z'));
        await store(b, run('r4', '2026-09-24T13:00:00Z'));
        const older = {
            version: 1,
            thread: { id: T, name: 'n', createdAt: 'c', updatedAt: '2026-09-24T09:30:00Z' },
            runs: [run('r1', '2026-09-24T09:00:00Z')],
            removedRuns: [{ id: 'r2', deletedAt: '2026-09-24T09:30:00Z' }],
            exportedBy: 'machine-A', exportedAt: '2026-09-24T09:30:00Z',
        } as any;
        expect(await importParsedThread(b, USER, older)).toBe('imported');
        expect(await runIds(b)).toEqual(['r1', 'r4']);
    });

    it('leaves the markers of the runs it removed for its own next file', async () => {
        const a = await openDb();
        await store(a, run('r1', '2026-09-24T09:00:00Z'));
        await store(a, run('r2', '2026-09-24T09:05:00Z'));
        await a.deleteRuns(T, ['r2'], 'r1');
        expect((await a.runTombstonesForThread(T)).map((t) => t.run_id)).toEqual(['r2']);
        // And the database itself refuses to store a removed run again.
        await store(a, run('r2', '2026-09-24T09:05:00Z'));
        expect(await runIds(a)).toEqual(['r1']);
    });
});

describe('what the other computer learns about papers and highlights', () => {
    const synced = (runs: any[]) => ({
        version: 1,
        thread: { id: T, name: 'n', createdAt: 'c', updatedAt: '2026-09-24T12:00:00Z' },
        runs, exportedBy: 'machine-B', exportedAt: '2026-09-24T12:00:00Z',
    } as any);

    it('lists the synced chat under the paper it was about, in this computer\'s library ids', async () => {
        const b = await openDb();
        await importParsedThread(b, USER, synced([run('r1', '2026-09-24T09:00:00Z', {
            user_prompt: {
                content: 'q',
                // Staged from a group library: 9 is the writer's own id for it.
                attachments: [{ type: 'item', library_id: 9, library_ref: 'g123', zotero_key: 'GATT', parent_key: 'GPAPER' }],
                application_state: {
                    reader_state: { library_id: 1, library_ref: 'u', zotero_key: 'PDF1', parent_key: 'PAPER1' },
                },
            },
        })]));
        expect((await b.getThreadsForItems(5, ['GPAPER'])).map((t) => t.id)).toEqual([T]);
        expect((await b.getThreadsForItems(1, ['PAPER1'])).map((t) => t.id)).toEqual([T]);
        expect(await b.getThreadsForItems(9, ['GPAPER'])).toEqual([]);
    });

    it('reopens the synced chat from the highlight it was asked from', async () => {
        const b = await openDb();
        await importParsedThread(b, USER, synced([run('r1', '2026-09-24T09:00:00Z', {
            user_prompt: {
                content: 'what does this sentence claim?',
                origin: { kind: 'selection_chat', annotation_key: 'ANN1', library_id: 1 },
                application_state: {
                    reader_state: {
                        library_id: 1, library_ref: 'u', zotero_key: 'PDF1',
                        text_selection: { text: 'the sediment gap widens below the dams' },
                    },
                },
            },
        })]));
        expect(await b.getThreadAnchor(1, 'ANN1')).toEqual({
            threadId: T, selectedText: 'the sediment gap widens below the dams',
        });
    });

    it('never displaces a highlight\'s own conversation here', async () => {
        const b = await openDb();
        await b.saveThreadAnchor({ libraryId: 1, annotationKey: 'ANN1', threadId: 'local-thread' });
        await importParsedThread(b, USER, synced([run('r1', '2026-09-24T09:00:00Z', {
            user_prompt: { content: 'q', origin: { kind: 'selection_chat', annotation_key: 'ANN1', library_id: 1 } },
        })]));
        expect((await b.getThreadAnchor(1, 'ANN1'))?.threadId).toBe('local-thread');
    });

    it('links nothing for a group this computer is not in', async () => {
        const b = await openDb();
        await importParsedThread(b, USER, synced([run('r1', '2026-09-24T09:00:00Z', {
            user_prompt: { content: 'q', attachments: [{ library_id: 9, library_ref: 'g999', zotero_key: 'X' }] },
        })]));
        expect(await b.getThreadItems(T)).toEqual([]);
    });

    it('fills in runs stored before this computer indexed them, the first time it is asked', async () => {
        const b = await openDb();
        const raw = (conns[conns.length - 1] as MockDBConnection).getRawDB();
        raw.prepare(`INSERT INTO threads (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(T, USER, 'old thread', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
        raw.prepare(`INSERT INTO agent_runs (id, thread_id, user_id, created_at, payload) VALUES (?, ?, ?, ?, ?)`)
            .run('old', T, USER, '2026-08-01T00:00:00Z', JSON.stringify(run('old', '2026-08-01T00:00:00Z', {
                user_prompt: {
                    content: 'about the logistic growth model',
                    application_state: { reader_state: { library_id: 1, zotero_key: 'PDF9', parent_key: 'PAPER9' } },
                },
            })));
        expect((await b.getThreadsForItems(1, ['PAPER9'])).map((t) => t.id)).toEqual([T]);
        expect((await b.searchThreadsLocal(USER, 'logistic')).map((t) => t.id)).toEqual([T]);
    });
});

describe('searching the history', () => {
    async function twoChats() {
        const db = await openDb();
        await store(db, run('a1', '2026-09-20T09:00:00Z', {
            user_prompt: { content: 'Explain the logistic growth model' },
            model_messages: [{ kind: 'response', parts: [
                { part_kind: 'thinking', content: 'response status search' },
                { part_kind: 'text', content: 'The "carrying capacity" of the colony, with \\alpha = 0.3.' },
            ] }],
        }), 'chat-growth');
        await store(db, run('b1', '2026-09-21T09:00:00Z', {
            user_prompt: { content: 'Summarise this paper on sourdough' },
            model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: 'Sourdough alpha amylase…' }] }],
        }), 'chat-bread');
        await db.setThreadName('chat-growth', USER, 'Growth chat');
        await db.setThreadName('chat-bread', USER, 'Sourdough chat');
        return db;
    }

    it('finds what was said, not the field names of the stored JSON', async () => {
        const db = await twoChats();
        // Every stored run has model_name, status, part_kind, content…
        expect((await db.searchThreadsLocal(USER, 'model')).map((t) => t.id)).toEqual(['chat-growth']);
        for (const word of ['status', 'part_kind', 'deepseek', 'response_']) {
            expect(await db.searchThreadsLocal(USER, word), word).toEqual([]);
        }
        // Thinking is machinery too.
        expect((await db.searchThreadsLocal(USER, 'search')).map((t) => t.id)).toEqual([]);
    });

    it('matches a quoted phrase and a LaTeX backslash as written', async () => {
        const db = await twoChats();
        expect((await db.searchThreadsLocal(USER, '"carrying capacity"')).map((t) => t.id)).toEqual(['chat-growth']);
        // "\alpha" is not "alpha": the sourdough chat says only the latter.
        expect((await db.searchThreadsLocal(USER, '\\alpha')).map((t) => t.id)).toEqual(['chat-growth']);
        expect((await db.searchThreadsLocal(USER, 'alpha')).map((t) => t.id).sort())
            .toEqual(['chat-bread', 'chat-growth']);
    });

    it('puts chats whose name matches first', async () => {
        const db = await twoChats();
        await store(db, run('c1', '2026-09-22T09:00:00Z', {
            user_prompt: { content: 'unrelated' },
            model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: 'mentions Sourdough once' }] }],
        }), 'chat-newest');
        const ids = (await db.searchThreadsLocal(USER, 'sourdough')).map((t) => t.id);
        expect(ids[0]).toBe('chat-bread');
        expect(ids).toContain('chat-newest');
    });
});

describe('the archive, as the lists read it', () => {
    it('searches, filters by paper and pages through archived chats only', async () => {
        const db = await openDb();
        for (let i = 0; i < 3; i++) {
            await store(db, run(`r${i}`, `2026-09-2${i}T09:00:00Z`, {
                user_prompt: {
                    content: `pollen question ${i}`,
                    application_state: { reader_state: { library_id: 1, zotero_key: 'PDF', parent_key: 'PAPER' } },
                },
            }), `chat-${i}`);
        }
        await db.archiveThread(USER, 'chat-0', '2026-09-23T00:00:00Z');
        await db.archiveThread(USER, 'chat-1', '2026-09-24T00:00:00Z');

        const archivedForPaper = await db.getThreadsForItems(1, ['PAPER'], 10, { archived: true });
        expect(archivedForPaper.map((t) => t.id)).toEqual(['chat-1', 'chat-0']);
        expect(archivedForPaper.every((t) => typeof t.archivedAt === 'string')).toBe(true);
        expect((await db.getThreadsForItems(1, ['PAPER'])).map((t) => t.id)).toEqual(['chat-2']);

        expect((await db.searchThreadsLocal(USER, 'pollen', 25, 0, { archived: true })).map((t) => t.id).sort())
            .toEqual(['chat-0', 'chat-1']);
        expect((await db.searchThreadsLocal(USER, 'pollen')).map((t) => t.id)).toEqual(['chat-2']);

        expect((await db.getArchivedThreads(USER, 1, 0)).map((t) => t.id)).toEqual(['chat-1']);
        expect((await db.getArchivedThreads(USER, 1, 1)).map((t) => t.id)).toEqual(['chat-0']);
    });

    it('gives a chat back to the history when a message is sent in it', async () => {
        const db = await openDb();
        await store(db, run('r1', '2026-09-20T09:00:00Z'));
        await db.archiveThread(USER, T, '2026-09-21T00:00:00Z');
        vi.setSystemTime(new Date('2026-09-25T08:00:00Z'));
        expect(await db.ensureThread(T, USER, 'n', '2026-09-20T09:00:00Z')).toBe(true);
        expect(await db.threadArchivedAt(USER, T)).toBeNull();
        // Stamped as used now: later than the archiving, which is what the
        // archive reconcile compares.
        expect((await db.getThread(USER, T))?.updatedAt).toBe('2026-09-25T08:00:00.000Z');
        expect(await db.ensureThread(T, USER, 'n', '2026-09-20T09:00:00Z')).toBe(false);
        expect((await db.getThreadsPaginated(USER, 10, 0)).threads.map((t) => t.id)).toEqual([T]);
    });

    it('gives it back too for a retry, a regenerate or a resume started in it', async () => {
        // None of those goes through a new message: each stores a new run.
        const db = await openDb();
        await store(db, run('r1', '2026-09-20T09:00:00Z'));
        await db.archiveThread(USER, T, '2026-09-21T00:00:00Z');
        vi.setSystemTime(new Date('2026-09-25T08:00:00Z'));
        await store(db, run('r2', '2026-09-25T07:59:00.000Z'));
        expect(await db.threadArchivedAt(USER, T)).toBeNull();
        expect((await db.getThread(USER, T))?.updatedAt).toBe('2026-09-25T08:00:00.000Z');
        expect((await db.getThreadsPaginated(USER, 10, 0)).threads.map((t) => t.id)).toEqual([T]);
    });

    it('leaves it archived for a run that was already under way when it was archived', async () => {
        // The answer lands after the user archived the chat mid-stream.
        const db = await openDb();
        await store(db, run('r1', '2026-09-20T09:00:00Z'));
        await db.archiveThread(USER, T, '2026-09-21T00:00:00.000Z');
        await store(db, run('r2', '2026-09-20T23:59:00.000Z'));
        expect(await db.threadArchivedAt(USER, T)).toBe('2026-09-21T00:00:00.000Z');
        // An archive time in the database's zoneless dialect reads as UTC.
        await db.archiveThread(USER, T, '2026-09-21 00:00:00');
        await store(db, run('r3', '2026-09-20T23:59:30.000Z'));
        expect(await db.threadArchivedAt(USER, T)).toBe('2026-09-21 00:00:00');
    });

    it('leaves it archived for runs that arrive with another computer\'s copy', async () => {
        // The other computer went on in the chat after this one archived it;
        // whether it stays archived is the archive reconcile's to decide.
        const a = await openDb();
        const b = await openDb();
        await store(a, run('r1', '2026-09-20T09:00:00Z'));
        await store(b, run('r1', '2026-09-20T09:00:00Z'));
        await b.archiveThread(USER, T, '2026-09-24T11:00:00.000Z');
        vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
        await store(a, run('r2', '2026-09-25T10:00:00.000Z'));
        const file = (await serializeThread(a, USER, T, 'now'))!;
        expect(await importParsedThread(b, USER, JSON.parse(JSON.stringify(file)))).toBe('imported');
        expect(await runIds(b)).toEqual(['r1', 'r2']);
        expect(await b.threadArchivedAt(USER, T)).toBe('2026-09-24T11:00:00.000Z');
    });
});

describe('the run index a search or paper lookup waits for', () => {
    it('is checked through an index of only the runs left to fill in, not by reading every transcript', async () => {
        const db = await openDb();
        const conn = conns[conns.length - 1];
        await store(db, run('r1', '2026-09-20T09:00:00Z'));
        const statements: string[] = [];
        const query = conn.queryAsync.bind(conn);
        (conn as any).queryAsync = (sql: string, params?: any[], options?: any) => {
            statements.push(sql);
            return query(sql, params, options);
        };
        await db.searchThreadsLocal(USER, 'question');
        const check = statements.find((sql) => /FROM agent_runs WHERE search_text IS NULL/.test(sql));
        expect(check).toBeDefined();
        const plan: string[] = [];
        await query(`EXPLAIN QUERY PLAN ${check}`, [100], {
            onRow: (row: any) => plan.push(String(row.getResultByIndex(3))),
        });
        expect(plan.join(' ')).toContain('agent_runs_unindexed_idx');
    });
});
