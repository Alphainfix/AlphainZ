/**
 * Conversations carried by Zotero's own sync.
 *
 * The pure half — what a thread turns into, what comes back, and which of two
 * copies wins. The Zotero half (items, attachments, sync state) is exercised
 * against the live client instead; there is no useful fake for it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    THREAD_EXPORT_VERSION,
    attachmentFilename,
    attachmentTitle,
    importParsedThread,
    parseThreadExport,
    parseThreadTimestamp,
    serializeThread,
    shouldImport,
} from '../../../src/services/threadZoteroSync';

const thread = {
    id: 'th-1', name: 'CO2 夜间通量', createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-20T10:00:00Z', zoteroUserId: 'u1', zoteroLocalId: 'l1',
};
const fakeDb = (over: any = {}) => ({
    async getThread() { return thread; },
    async getRunsForThread() { return [{ id: 'run-1', model_messages: [] }]; },
    ...over,
} as any);

describe('serializing a thread', () => {
    it('carries the thread, its runs, and where it came from', async () => {
        (Zotero as any).Users = { getLocalUserKey: () => 'machine-A' };
        const out = await serializeThread(fakeDb(), 'user-1', 'th-1', '2026-08-24T00:00:00Z');
        expect(out?.version).toBe(THREAD_EXPORT_VERSION);
        expect(out?.thread.name).toBe('CO2 夜间通量');
        expect(out?.thread.updatedAt).toBe('2026-08-20T10:00:00Z');
        expect(out?.runs).toHaveLength(1);
        expect(out?.exportedBy).toBe('machine-A');
    });

    it('is null for a thread that is not there', async () => {
        const db = fakeDb({ async getThread() { return null; } });
        expect(await serializeThread(db, 'user-1', 'nope', 'now')).toBeNull();
    });

    it('round-trips through the parser', async () => {
        const out = await serializeThread(fakeDb(), 'user-1', 'th-1', 'now');
        expect(parseThreadExport(JSON.stringify(out))?.thread.id).toBe('th-1');
    });

    it('carries the archive state, still as version 1', async () => {
        // The folder backend has no trash of its own; the field is the file's
        // archive. Additive, so older parsers keep accepting these files.
        const archived = fakeDb({
            async threadArchivedAt() { return '2026-08-22T00:00:00Z'; },
        });
        const out = await serializeThread(archived, 'user-1', 'th-1', 'now');
        expect(out?.thread.archivedAt).toBe('2026-08-22T00:00:00Z');
        expect(out?.version).toBe(THREAD_EXPORT_VERSION);
        expect(parseThreadExport(JSON.stringify(out))?.thread.archivedAt)
            .toBe('2026-08-22T00:00:00Z');
    });

    it('carries the compaction record, still as version 1', async () => {
        // Same additive doctrine as archivedAt: the other machine should
        // replay the same window this one does.
        const record = {
            summary: 'the story so far', throughRunId: 'run-1',
            createdAt: '2026-08-27T00:00:00Z', runCount: 8,
        };
        const db = fakeDb({ async threadCompaction() { return record; } });
        const out = await serializeThread(db, 'user-1', 'th-1', 'now');
        expect(out?.thread.compaction).toEqual(record);
        expect(out?.version).toBe(THREAD_EXPORT_VERSION);
        expect(parseThreadExport(JSON.stringify(out))?.thread.compaction?.summary)
            .toBe('the story so far');
    });

    it('omits nothing and breaks nothing on a db without threadArchivedAt', async () => {
        // The structural fakes elsewhere in the suite predate the field.
        const out = await serializeThread(fakeDb(), 'user-1', 'th-1', 'now');
        expect(out?.thread.archivedAt ?? null).toBeNull();
    });
});

describe('reading a file back', () => {
    it('refuses anything that is not a thread export', () => {
        // A truncated download, someone else's JSON, a note saved by hand.
        for (const text of ['', 'not json', '{}', '[]', '{"thread":{}}',
                            '{"thread":{"id":"x"}}', 'null']) {
            expect(parseThreadExport(text), text).toBeNull();
        }
    });

    it('refuses a version written by a newer plugin', () => {
        // Its fields may mean something else; guessing overwrites a good thread.
        const future = JSON.stringify({
            version: THREAD_EXPORT_VERSION + 1,
            thread: { id: 'th-1', updatedAt: 'x' }, runs: [],
        });
        expect(parseThreadExport(future)).toBeNull();
    });

    it('accepts an export with no runs yet', () => {
        const empty = JSON.stringify({
            version: 1, thread: { id: 'th-1', updatedAt: 'x' }, runs: [],
        });
        expect(parseThreadExport(empty)?.runs).toEqual([]);
    });
});

describe('choosing between two copies', () => {
    it('takes the incoming one when there is nothing local', () => {
        expect(shouldImport({ updatedAt: '2026-08-01T00:00:00Z' }, null)).toBe(true);
    });

    it('takes the newer one', () => {
        expect(shouldImport(
            { updatedAt: '2026-08-20T00:00:00Z' },
            { updatedAt: '2026-08-01T00:00:00Z' },
        )).toBe(true);
    });

    it('leaves a newer local copy alone', () => {
        expect(shouldImport(
            { updatedAt: '2026-08-01T00:00:00Z' },
            { updatedAt: '2026-08-20T00:00:00Z' },
        )).toBe(false);
    });

    it('does nothing on a tie', () => {
        // Re-importing an identical thread would rewrite every run for nothing.
        const t = '2026-08-20T00:00:00Z';
        expect(shouldImport({ updatedAt: t }, { updatedAt: t })).toBe(false);
    });
});

describe('what the file is called', () => {
    it('is named by thread id, so the same thread finds the same file', () => {
        expect(attachmentFilename('th-1')).toBe('th-1.json');
    });

    it('titles an unnamed thread by its id rather than showing a blank row', () => {
        expect(attachmentTitle('', 'th-abcdef123')).toBe('Conversation th-abcde');
        expect(attachmentTitle('   ', 'th-abcdef123')).toContain('Conversation');
    });

    it('keeps a real name, clipped', () => {
        expect(attachmentTitle('CO2 夜间通量', 'th-1')).toBe('CO2 夜间通量');
        expect(attachmentTitle('x'.repeat(400), 'th-1')).toHaveLength(120);
    });
});

/**
 * The file has to be worth something away from this plugin.
 *
 * `messages` is OpenAI chat-completions — the shape every coding agent already
 * ingests, so the file can be handed to Codex or a script directly. `runs` is
 * the native payload, kept because chat-completions cannot express citation
 * tags, approval records or reasoning parts, and restoring from `messages`
 * alone would quietly return a lesser conversation.
 */
describe('the portable half', () => {
    const runWithTools = {
        id: 'run-1',
        user_prompt: { content: '第 6 页讲了什么？' },
        model_messages: [
            {
                kind: 'response',
                parts: [
                    { part_kind: 'thinking', content: 'internal' },
                    { part_kind: 'text', content: 'Let me read it.' },
                    { part_kind: 'tool-call', tool_name: 'read_document', tool_call_id: 'c1', args: { page: 6 } },
                ],
            },
            {
                kind: 'request',
                parts: [{ part_kind: 'tool-return', tool_call_id: 'c1', content: '{"page":6}' }],
            },
            { kind: 'response', parts: [{ part_kind: 'text', content: '三点总结…' }] },
        ],
    };

    const exportOf = async (runs: any[]) => {
        (Zotero as any).Users = { getLocalUserKey: () => 'machine-A' };
        return serializeThread(fakeDb({ async getRunsForThread() { return runs; } }),
            'user-1', 'th-1', 'now');
    };

    it('is chat-completions: roles, and tool calls under tool_calls', async () => {
        const out: any = await exportOf([runWithTools]);
        expect(out.messages.map((m: any) => m.role))
            .toEqual(['user', 'assistant', 'tool', 'assistant']);
        const assistant = out.messages[1];
        expect(assistant.tool_calls[0].type).toBe('function');
        expect(assistant.tool_calls[0].function.name).toBe('read_document');
        // Arguments are a JSON string, as the API defines them.
        expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ page: 6 });
        expect(out.messages[2].tool_call_id).toBe('c1');
    });

    it('names itself, so a reader can tell what the file is', async () => {
        const out: any = await exportOf([runWithTools]);
        expect(out.format).toBe('alphainz.conversation');
        expect(out.generator?.name).toBeTruthy();
        expect(out.generator?.version).toBeTruthy();
    });

    it('keeps the native runs alongside, not instead', async () => {
        const out: any = await exportOf([runWithTools]);
        expect(out.runs).toHaveLength(1);
        expect(out.runs[0].model_messages).toHaveLength(3);
        // Thinking survives in `runs` though chat-completions has nowhere for it.
        const parts = out.runs[0].model_messages[0].parts;
        expect(parts.some((p: any) => p.part_kind === 'thinking')).toBe(true);
    });

    it('drops a run it cannot convert without losing the rest', async () => {
        const out: any = await exportOf([runWithTools, null, { id: 'run-2' }]);
        expect(out.messages.length).toBeGreaterThan(0);
        // All three are still there verbatim.
        expect(out.runs).toHaveLength(3);
    });

    it('still reads a file written before the portable half existed', async () => {
        const old = JSON.stringify({
            version: 1, thread: { id: 'th-1', updatedAt: 'x' }, runs: [],
        });
        expect(parseThreadExport(old)?.thread.id).toBe('th-1');
    });
});

/**
 * Telling Zotero the file changed.
 *
 * Overwriting an attachment's file is not enough — Zotero decides what to
 * upload from the stored hash, so a changed file still reads as in sync. This
 * once cleared the synced *modification time* too, whose setter throws on
 * anything that is not a number. The throw landed after the file had been
 * written: the new conversation sat on disk while Zotero believed the
 * attachment was in sync, and it was never uploaded. Verified live before and
 * after — an attachment at IN_SYNC with a stored hash now flips to TO_UPLOAD
 * with the hash cleared.
 */
describe('marking an attachment stale', () => {
    /** Enforces the real setters' contracts, which is where this went wrong. */
    function zoteroLikeAttachment() {
        const state: any = { hash: 'a'.repeat(32), sync: 'in_sync', mtime: 1787613125940 };
        return {
            state,
            get attachmentSyncedHash() { return state.hash; },
            set attachmentSyncedHash(v: any) {
                if (v !== null && String(v).length !== 32) throw new Error(`Invalid attachment hash '${v}'`);
                state.hash = v;
            },
            get attachmentSyncedModificationTime() { return state.mtime; },
            set attachmentSyncedModificationTime(v: any) {
                if (typeof v !== 'number') throw new Error('attachmentSyncedModificationTime must be a number');
                state.mtime = v;
            },
            get attachmentSyncState() { return state.sync; },
            set attachmentSyncState(v: any) { state.sync = v; },
        };
    }

    it('queues an upload', async () => {
        const { markForUpload } = await import('../../../src/services/threadZoteroSync');
        const attachment = zoteroLikeAttachment();
        markForUpload(attachment as any);
        expect(attachment.state.sync).toBe('to_upload');
    });

    it('leaves the synced hash alone', async () => {
        /*
         * That field records what the server already has, and it is how Zotero
         * tells "I changed this" from "we both changed this". Blanking it made
         * every ordinary edit look like a conflict: Zotero put a Conflict
         * Resolution dialog in front of the user for a file only this machine
         * had ever written. Seen once, on a real sync.
         */
        const { markForUpload } = await import('../../../src/services/threadZoteroSync');
        const attachment = zoteroLikeAttachment();
        const before = attachment.state.hash;
        markForUpload(attachment as any);
        expect(attachment.state.hash).toBe(before);
    });

    it('does not touch the synced modification time', async () => {
        // Assigning null there throws, and the throw came after the file was
        // already written — the first shape of this bug.
        const { markForUpload } = await import('../../../src/services/threadZoteroSync');
        const attachment = zoteroLikeAttachment();
        expect(() => markForUpload(attachment as any)).not.toThrow();
        expect(attachment.state.mtime).toBe(1787613125940);
    });
});

describe('importing compaction state', () => {
    const importerDb = (over: any = {}) => {
        const calls: any[] = [];
        return {
            calls,
            async getThread() { return null; },
            async saveRun() { /* recorded elsewhere */ },
            async upsertThread() { /* names the row */ },
            async setThreadCompaction(...args: any[]) { calls.push(args); },
            ...over,
        } as any;
    };
    const payload = (thread: any) => ({
        version: 1,
        thread: { id: 'th-9', name: 'n', createdAt: 'c', updatedAt: 'u', ...thread },
        runs: [],
        exportedBy: 'B',
        exportedAt: 'now',
    } as any);

    it('applies a compaction claim from the file', async () => {
        const db = importerDb();
        const record = { summary: 's'.repeat(50), throughRunId: 'r1', createdAt: 'x', runCount: 3 };
        expect(await importParsedThread(db, 'user-1', payload({ compaction: record }))).toBe('imported');
        expect(db.calls).toEqual([['user-1', 'th-9', record]]);
    });

    it('clears local state only on an explicit null claim', async () => {
        const db = importerDb();
        await importParsedThread(db, 'user-1', payload({ compaction: null }));
        expect(db.calls).toEqual([['user-1', 'th-9', null]]);
    });

    it('leaves local state alone when an older writer made no claim', async () => {
        // Un-compacting the thread on every sync from an old machine would
        // throw the summary away for nothing.
        const db = importerDb();
        await importParsedThread(db, 'user-1', payload({}));
        expect(db.calls).toEqual([]);
    });

    it('survives a db without setThreadCompaction', async () => {
        const db = importerDb({ setThreadCompaction: undefined });
        expect(await importParsedThread(db, 'user-1', payload({ compaction: null }))).toBe('imported');
    });
});

describe('parseThreadTimestamp', () => {
    it("pins SQLite's zone-less datetime to UTC", () => {
        // Date.parse reads an unzoned date-time as LOCAL time, so on any
        // machine west of UTC a locally-written row looked hours newer than
        // it was and outvoted legitimate imports. These are the exact strings
        // from the Windows-thread-refusing-to-appear incident.
        expect(parseThreadTimestamp('2026-08-28 15:44:35'))
            .toBe(Date.parse('2026-08-28T15:44:35Z'));
        expect(parseThreadTimestamp('2026-08-28T19:33:57.041Z'))
            .toBe(Date.parse('2026-08-28T19:33:57.041Z'));
    });

    it('makes the incident import pass', () => {
        // File written by the other machine at 19:33 UTC; local row written by
        // SQLite at 15:44 UTC. The naive-as-local misread made 15:44 read as
        // 19:44 local-east-coast and win.
        expect(shouldImport(
            { updatedAt: '2026-08-28T19:33:57.041Z' },
            { updatedAt: '2026-08-28 15:44:35' },
        )).toBe(true);
    });

    it('still keeps the newer local copy', () => {
        expect(shouldImport(
            { updatedAt: '2026-08-28T10:00:00Z' },
            { updatedAt: '2026-08-28 15:44:35' },
        )).toBe(false);
    });
});

describe('tombstones against the envelope', () => {
    const withTombstone = (deletedAt: string | null, over: any = {}) => {
        const removed: string[] = [];
        return {
            removed,
            async getThread() { return thread; },
            async getRunsForThread() { return [{ id: 'run-1' }]; },
            async threadTombstone() { return deletedAt; },
            async removeThreadTombstone(_u: string, id: string) { removed.push(id); },
            async saveRun() {},
            async upsertThread() {},
            ...over,
        } as any;
    };

    it('serializeThread refuses a thread whose tombstone is the newest fact', async () => {
        // Deleted after the last edit: the detached title/compaction mirrors
        // must not write this file back.
        const db = withTombstone('2026-08-21T00:00:00Z');
        expect(await serializeThread(db, 'user-1', 'th-1', 'now')).toBeNull();
    });

    it('serializeThread exports a thread edited after its deletion', async () => {
        const db = withTombstone('2026-08-19T00:00:00Z'); // edit at 08-20 wins
        const out = await serializeThread(db, 'user-1', 'th-1', 'now');
        expect(out?.thread.id).toBe('th-1');
    });

    it('import skips a copy written before the deletion', async () => {
        const db = withTombstone('2026-08-21T00:00:00Z');
        const payload = {
            version: 1,
            thread: { id: 'th-1', name: 'n', createdAt: 'c', updatedAt: '2026-08-20T10:00:00Z' },
            runs: [],
            exportedBy: 'B',
            exportedAt: 'now',
        } as any;
        expect(await importParsedThread(db, 'user-1', payload)).toBe('skipped');
        expect(db.removed).toEqual([]);
    });

    it('import revives on a copy edited after the deletion, dropping the tombstone first', async () => {
        const db = withTombstone('2026-08-21T00:00:00Z', {
            async getThread() { return null; },
        });
        const payload = {
            version: 1,
            thread: { id: 'th-1', name: 'n', createdAt: 'c', updatedAt: '2026-08-22T00:00:00Z' },
            runs: [],
            exportedBy: 'B',
            exportedAt: 'now',
        } as any;
        expect(await importParsedThread(db, 'user-1', payload)).toBe('imported');
        expect(db.removed).toEqual(['th-1']);
    });

    it('a db without tombstone methods keeps working — the structural fakes', async () => {
        const db = fakeDb();
        const out = await serializeThread(db, 'user-1', 'th-1', 'now');
        expect(out?.thread.id).toBe('th-1');
    });
});
