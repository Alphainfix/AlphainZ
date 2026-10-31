/**
 * Mock Zotero.DBConnection backed by better-sqlite3.
 *
 * This gives us real SQLite semantics for testing the SQL in BeaverDB
 * without needing a running Zotero instance.
 *
 * The API surface mimics the subset of Zotero.DBConnection that BeaverDB uses:
 *   - queryAsync(sql, params?, options?)
 *   - executeTransaction(fn)
 *   - test()
 *   - closeDatabase()
 */

import Database from 'better-sqlite3';

export class MockDBConnection {
    private db: Database.Database;

    constructor() {
        // In-memory database — fast and disposable
        this.db = new Database(':memory:');
        // Enable WAL mode to mimic Zotero's default
        this.db.pragma('journal_mode = WAL');
    }

    /**
     * Mimics Zotero.DBConnection.queryAsync.
     *
     * Supports both the direct-return pattern (rows as array of objects)
     * and the onRow callback pattern used in some BeaverDB methods.
     */
    async queryAsync(
        sql: string,
        params: any[] = [],
        options?: { onRow?: (row: any) => void }
    ): Promise<any[]> {
        // Mirror Zotero.DBConnection.queryAsync in both of its behaviours:
        //  - an `onRow` callback receives every row of a row-producing statement
        //    while it executes, whatever the statement looks like;
        //  - the *returned* rows exist only when the first token of the raw SQL
        //    string — leading whitespace included — is SELECT or PRAGMA. A
        //    SELECT written after a newline inside a template literal is not a
        //    SELECT to Zotero and yields nothing, so a lenient mock here let a
        //    statement pass in tests that silently returned nothing in the plugin.
        const stmt = this.db.prepare(sql);
        if (stmt.reader && options?.onRow) {
            for (const row of stmt.all(...params)) {
                const values = Object.values(row);
                options.onRow({
                    getResultByIndex(i: number) {
                        return values[i];
                    },
                });
            }
            return [];
        }
        const op = (sql.match(/^[^a-z]*[^ ]+/i)?.[0] ?? '').toLowerCase();
        if (stmt.reader && (op === 'select' || op === 'pragma')) {
            return stmt.all(...params);
        }
        if (stmt.reader) {
            // Zotero returns undefined here; callers that spread or map the
            // result see the same nothing they would see in the plugin.
            stmt.all(...params);
            return undefined as any;
        }

        // INSERT, UPDATE, DELETE, CREATE, DROP, etc.
        stmt.run(...params);
        return [];
    }

    /**
     * Mimics Zotero.DBConnection.executeTransaction.
     * Wraps fn in a real SQLite transaction.
     */
    async executeTransaction(fn: () => Promise<void>): Promise<void> {
        this.db.exec('BEGIN');
        try {
            await fn();
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Mimics Zotero.DBConnection.test — no-op for in-memory DB. */
    async test(): Promise<void> {
        // No-op
    }

    /** Close the database. */
    async closeDatabase(): Promise<void> {
        this.db.close();
    }

    /** Helper: get the raw better-sqlite3 instance for assertions. */
    getRawDB(): Database.Database {
        return this.db;
    }
}
