/**
 * Opening the database must never destroy a conversation.
 *
 * Upstream opened `initDatabase` with a block that dropped `threads`,
 * `messages` and five other tables whenever the previously installed version
 * began with `0.1` — a reset written for Beaver's own alpha, when nobody could
 * have had data worth keeping.
 *
 * This fork's versions *are* 0.1.x, and `initDatabase` runs long before
 * `installedVersion` is rewritten. So the condition held on every launch after
 * the first, and every restart destroyed every conversation. It was reported
 * as history vanishing after an update; it had in fact been vanishing after
 * every start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { BeaverDB } from '../../../src/services/database';

/** Records every statement, and answers PRAGMA probes like an empty schema. */
function recordingConnection() {
    const statements: string[] = [];
    return {
        statements,
        async queryAsync(sql: string, _params?: any, opts?: any) {
            statements.push(sql.replace(/\s+/g, ' ').trim());
            // `PRAGMA table_info(...)` callers read columns through onRow.
            if (opts?.onRow) return [];
            return [];
        },
        async valueQueryAsync() { return null; },
    } as any;
}

const PREFS: Record<string, any> = {};

beforeEach(() => {
    for (const k of Object.keys(PREFS)) delete PREFS[k];
    (Zotero.Prefs as any).get = (key: string) => PREFS[key.split('.').pop() as string];
    (Zotero.Prefs as any).set = (key: string, v: any) => {
        PREFS[key.split('.').pop() as string] = v;
    };
});

/** Tables holding something a user made and cannot get back. */
const IRREPLACEABLE = ['threads', 'messages', 'agent_runs', 'thread_items', 'thread_anchors'];

async function dropsDuringInit(installedVersion: string | undefined): Promise<string[]> {
    if (installedVersion !== undefined) PREFS.installedVersion = installedVersion;
    const conn = recordingConnection();
    await new BeaverDB(conn).initDatabase('0.1.6');
    return conn.statements.filter((s) => /^DROP TABLE/i.test(s));
}

describe('opening the database', () => {
    // The exact values that triggered it, plus the ones we will ship next.
    it.each(['0.1', '0.1.0', '0.1.5', '0.1.6', '0.2.4', '0.23.3', '1.0.0'])(
        'drops no conversation table when upgrading from %s',
        async (from) => {
            const dropped = await dropsDuringInit(from);
            for (const table of IRREPLACEABLE) {
                expect(
                    dropped.some((s) => s.toLowerCase().includes(` ${table}`)),
                    `initDatabase dropped "${table}" coming from ${from}`,
                ).toBe(false);
            }
        },
    );

    it('drops nothing irreplaceable on a first install either', async () => {
        const dropped = await dropsDuringInit(undefined);
        for (const table of IRREPLACEABLE) {
            expect(dropped.some((s) => s.toLowerCase().includes(` ${table}`))).toBe(false);
        }
    });

    it('still drops the rebuildable caches it is allowed to', async () => {
        // A guard on the guard: if `initDatabase` stopped issuing any DROP at
        // all, the checks above would pass while testing nothing.
        const dropped = await dropsDuringInit('0.1.5');
        expect(dropped.length).toBeGreaterThan(0);
        expect(dropped.join(' ')).toContain('attachment_file_cache');
    });
});
