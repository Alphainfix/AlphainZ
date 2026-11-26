import { v4 as uuidv4 } from 'uuid';
import { ThreadData } from '../../react/atoms/threads';
import { getPref } from '../utils/prefs';
import type { ThreadCompaction } from '@beaver/agent-llm/threadCompaction';
import { SyncMethod, SyncType } from '../../react/atoms/sync';
import {
    isExtractContentKind,
    parseCachedDocumentMetadata,
} from '@beaver/agent-core/extract/document/shared/contentKinds';
import {
    parseBackgroundJobPayload,
    type BackgroundJobPayload,
} from './documentExtraction/shared/backgroundJobPayloads';
import { anchorLinkForRun, itemLinksForRun, runSearchText } from './conversationSync/runIndex';
import type {
    CachedDocumentMetadata,
    DocumentCachePageLabels,
    ExtractContentKind,
} from '@beaver/agent-core/extract/document/shared/contentKinds';

export type { DocumentCachePageLabels } from '@beaver/agent-core/extract/document/shared/contentKinds';

type PdfCachedDocumentMetadata = Extract<CachedDocumentMetadata, { content_kind: 'pdf' }>;


/* 
 * Interface for the 'embeddings' table row
 * 
 * Table stores paper embeddings for semantic search.
 * Embeddings are generated from title + abstract text.
 */
export interface EmbeddingRecord {
    item_id: number;                    // Zotero item ID
    library_id: number;                 // Zotero library ID
    zotero_key: string;                 // Zotero item key
    version: number;                    // Zotero item version at embedding time
    client_date_modified: string;       // Item's clientDateModified at embedding time
    content_hash: string;               // Hash of title+abstract for change detection
    embedding: Uint8Array;              // Int8 embedding stored as BLOB
    dimensions: number;                 // Embedding dimensions (256 or 512)
    model_id: string;                   // Model identifier (e.g., "voyage-3-int8-512")
    indexed_at: string;                 // When the embedding was created
}

/**
 * Interface for the 'embedding_index_state' table row
 * 
 * Tracks the state of the embedding index for each library.
 * Used to optimize startup by skipping full diff when nothing changed.
 */
export interface EmbeddingIndexStateRecord {
    library_id: number;                  // Zotero library ID
    model_id: string;                    // Embedding model the scan was for
    last_scan_timestamp: string;         // When we last ran a full scan (ISO string)
    max_client_date_modified: string;    // MAX(clientDateModified) from Zotero at last scan
    item_count: number;                  // Count of regular items in Zotero at last scan
    embedding_count: number;             // Count of embeddings at last scan
}

/**
 * Interface for the 'failed_embeddings' table row
 * 
 * Tracks items that failed to embed, with retry backoff logic.
 * Items are retried with exponential backoff based on failure_count.
 */
export interface FailedEmbeddingRecord {
    item_id: number;                     // Zotero item ID
    library_id: number;                  // Zotero library ID
    failure_count: number;               // Number of consecutive failures
    last_error: string;                  // Last error message
    last_attempt: string;                // When the last attempt was made (ISO string)
    next_retry_after: string;            // Don't retry before this time (ISO string)
}

export type DocumentCacheExtractionMode = 'structured' | 'markdown';
export type DocumentCachePayloadKind = 'structured' | 'markdown';

/** Authoritative error reason for a cached document; `null` marks a successful extraction. */
export type DocumentCacheErrorCode = 'encrypted' | 'invalid_pdf' | 'no_text_layer';

export interface DocumentCacheFileSignature {
    mtime_ms: number;
    size_bytes: number;
}

export interface DocumentCacheMetadataRecord {
    id: number;
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    contentKind: ExtractContentKind;
    filePath: string;
    fileSignature: DocumentCacheFileSignature;
    sourceSizeBytes: number;
    contentType: string;
    documentMetadata: CachedDocumentMetadata | null;
    pageCount: number | null;
    pageLabels: DocumentCachePageLabels | null;
    pages: PdfCachedDocumentMetadata['pages'];
    errorCode: DocumentCacheErrorCode | null;
    extractionSchemaVersion: string;
    metadataFormatVersion: number;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt: string | null;
}

export interface DocumentCachePayloadRecord {
    id: number;
    metadataId: number;
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    payloadKind: DocumentCachePayloadKind;
    contentKind: ExtractContentKind;
    sourceFilePath: string;
    sourceFileSignature: DocumentCacheFileSignature;
    sourceSizeBytes: number;
    payloadPath: string;
    payloadSizeBytes: number;
    payloadSha256: string | null;
    extractionSchemaVersion: string;
    cacheFormatVersion: number;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt: string | null;
}

export type DocumentCacheMetadataInput = Omit<
    DocumentCacheMetadataRecord,
    | 'id'
    | 'createdAt'
    | 'updatedAt'
    | 'lastAccessedAt'
    | 'documentMetadata'
    | 'pageCount'
    | 'pageLabels'
    | 'pages'
> & {
    documentMetadata: CachedDocumentMetadata;
};

export type DocumentCachePayloadInput = Omit<
    DocumentCachePayloadRecord,
    'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt'
>;

export type { BackgroundJobPayload } from './documentExtraction/shared/backgroundJobPayloads';

/** Content kinds supported for user-attached external files. */
export type ExternalFileContentKind = 'pdf' | 'epub' | 'text' | 'image';

/**
 * One row in `external_files`: a user-attached file from disk, copied into the
 * Beaver-managed external-files folder at attach time. `extKey` is the
 * 8-character key behind the model-facing `ext-<KEY>` id. `originalPath` is
 * informational and local-only — it is never sent off-device.
 */
export interface ExternalFileRecord {
    extKey: string;
    filename: string;
    originalPath: string | null;
    storedPath: string;
    contentKind: ExternalFileContentKind;
    mimeType: string;
    fileSize: number;
    mtimeMs: number;
    pageCount: number | null;
    /** SHA-256 of the file content (hex). Null when hashing failed at attach time. */
    sha256: string | null;
    createdAt: string;
}

export type ExternalFileInput = Omit<ExternalFileRecord, 'createdAt'>;

const EXTERNAL_FILE_CONTENT_KINDS: ReadonlySet<string> = new Set(['pdf', 'epub', 'text', 'image']);

export function isExternalFileContentKind(value: string): value is ExternalFileContentKind {
    return EXTERNAL_FILE_CONTENT_KINDS.has(value);
}

/** Background extraction job kinds. */
export type BackgroundJobType = 'document_timeout_retry';

/**
 * Single row in `background_jobs`. Timestamps are epoch milliseconds so
 * `MIN(available_at, ?)` UPSERTs compare arithmetically.
 */
export interface BackgroundJobRecord {
    id: number;
    jobType: BackgroundJobType;
    libraryId: number;
    itemId: number | null;
    zoteroKey: string;
    contentKind: ExtractContentKind;
    payloadKind: DocumentCachePayloadKind;
    priority: number;
    payload: BackgroundJobPayload | null;
    enqueuedAt: number;
    availableAt: number;
    attemptCount: number;
    lastError: string | null;
}

export interface BackgroundJobInput {
    jobType: BackgroundJobType;
    libraryId: number;
    itemId?: number | null;
    zoteroKey: string;
    contentKind: ExtractContentKind;
    payloadKind: DocumentCachePayloadKind;
    priority?: number;
    payload?: BackgroundJobPayload | null;
    /** Epoch ms. Used for both `enqueued_at` and `available_at`. */
    now: number;
}

export interface BackgroundJobEnqueueResult {
    enqueued: boolean;
    id: number;
}

export interface BackgroundQueueStats {
    pending: number;
    available: number;
    deferred: number;
    dead: number;
    byJobType: Record<string, number>;
}

const BACKGROUND_JOB_COLUMNS = `
    id, job_type, library_id, item_id, zotero_key,
    content_kind, payload_kind, priority, payload_json,
    enqueued_at, available_at, attempt_count, last_error
`;

/**
 * Maximum number of failures before an item is considered permanently failed.
 * After this many failures, the item won't be retried automatically.
 */
export const MAX_EMBEDDING_FAILURES = 5;

/**
 * Base delay for retry backoff in milliseconds.
 * Actual delay = BASE_DELAY * 2^(failure_count - 1)
 * So delays are: 1h, 2h, 4h, 8h, 16h
 */
export const EMBEDDING_RETRY_BASE_DELAY_MS = 60 * 60 * 1000; // 1 hour


/* 
 * Interface for the 'threads' table row
 * 
 * Table stores chat threads, mirroring the backend postgres structure.
 * Corresponds to the ThreadModel and threads table in the backend.
 * 
 */
export interface ThreadRecord {
    id: string;
    user_id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
}

/** A thread as the history lists get it: with when it was archived, or null while active. */
export type ListedThread = ThreadData & { archivedAt: string | null };

/** Which half of the history a list query reads. */
export interface ThreadListScope {
    /** True for the archive; false or absent for the active conversations. */
    archived?: boolean;
}

/**
 * The rolling summary standing in for a thread's oldest runs.
 *
 * `throughRunId` names the newest run the summary covers: on the wire, runs up
 * to and including it are replaced by the summary text, and everything after
 * replays as usual. `runCount` is only for the UI label.
 */
// A thread's stored summary; defined by the model layer that writes it.
export type { ThreadCompaction };

/* 
 * Interface for the 'sync_logs' table row
 *
 * Table stores the sync logs for each sync session.
 */
export interface SyncLogsRecord {
    id: string; // Primary key
    session_id: string;
    user_id: string;
    sync_type: SyncType;
    method: SyncMethod;
    zotero_local_id: string;
    zotero_user_id?: string | null;
    library_id: number;
    total_upserts: number;
    total_deletions: number;
    library_version: number;
    library_date_modified: string;
    timestamp: string;
}

/**
 * Manages the beaver SQLite database using Zotero's DBConnection.
 */
export class BeaverDB {
    private conn: any; // Instance of Zotero.DBConnection

    /**
     * @param dbConnection An initialized Zotero.DBConnection instance for 'beaver'.
     */
    constructor(dbConnection: any) {
        if (!dbConnection) {
            throw new Error("BeaverDB requires a valid Zotero.DBConnection instance.");
        }
        this.conn = dbConnection;
    }

    /**
     * Initialize the database by creating tables if they don't exist.
     * Should be called once after constructing the class.
     */
    public async initDatabase(_pluginVersion: string): Promise<void> {
        await this.conn.queryAsync(`PRAGMA foreign_keys = ON`);

        /*
         * There is no version-triggered table drop here, and there must not be.
         *
         * Upstream opened this method with a block that dropped `threads`,
         * `messages` and five other tables whenever the previously installed
         * version began with `0.1` — a reset for Beaver's own alpha, written
         * when nobody could have had data worth keeping.
         *
         * This fork's versions *are* 0.1.x. So the condition was true on every
         * launch after the first, and `initDatabase` runs long before
         * `installedVersion` is rewritten: every restart destroyed every
         * conversation. Reported from Windows as history disappearing after an
         * update; it was in fact disappearing after every start.
         *
         * Schema changes are handled the way the rest of this method handles
         * them — `CREATE TABLE IF NOT EXISTS`, `PRAGMA table_info` checks and
         * `ALTER TABLE ADD COLUMN`. The drops further down are guarded by real
         * staleness checks and only touch caches and the job queue, which cost
         * time to rebuild rather than being irreplaceable.
         */

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS threads (
                id                       TEXT(36) PRIMARY KEY,
                user_id                  TEXT(36) NOT NULL,
                name                     TEXT,
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        /*
         * When a conversation was archived, or null while it is active.
         *
         * Added rather than a boolean so the archive can be listed in the
         * order things were put there, which is the order anyone looking for
         * something they just deleted expects.
         */
        const threadColumns: string[] = [];
        await this.conn.queryAsync(`PRAGMA table_info(threads)`, [], {
            onRow: (row: any) => threadColumns.push(row.getResultByIndex(1)),
        });
        if (!threadColumns.includes('archived_at')) {
            await this.conn.queryAsync(`ALTER TABLE threads ADD COLUMN archived_at TEXT`);
        }

        /*
         * The rolling summary standing in for this thread's oldest runs, as a
         * JSON blob ({summary, throughRunId, createdAt, runCount}) or NULL.
         *
         * One column rather than four: nothing queries inside it, and the
         * shape can grow without another migration. The runs it summarises
         * stay in agent_runs untouched — compaction changes what is SENT to
         * the model, never what is stored or shown.
         */
        if (!threadColumns.includes('compaction')) {
            await this.conn.queryAsync(`ALTER TABLE threads ADD COLUMN compaction TEXT`);
        }

        /*
         * Deletion tombstones for permanently deleted conversations.
         *
         * Deleting a thread's row alone does not stick: sync re-imports it
         * from any surviving copy (the folder JSON, or another machine), and
         * saveRun/setThreadName/ensureThread recreate rows via INSERT OR
         * IGNORE. The tombstone is the durable "this id was deleted at T"
         * claim those paths consult. Deletion wins only while it is the
         * newest fact — a thread copy edited after deleted_at revives.
         */
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS thread_tombstones (
                thread_id                TEXT(36) PRIMARY KEY,
                user_id                  TEXT(36) NOT NULL,
                deleted_at               TEXT NOT NULL
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS messages (
                id                       TEXT(36) PRIMARY KEY,
                user_id                  TEXT(36) NOT NULL,
                thread_id                TEXT(36) NOT NULL,
                role                     TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                content                  TEXT,
                reasoning_content        TEXT,
                tool_calls               TEXT,
                reader_state             TEXT,
                attachments              TEXT,
                tool_request             TEXT,
                status                   TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('in_progress', 'completed', 'canceled', 'error')),
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                metadata                 TEXT,
                error                    TEXT,
                FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS sync_logs (
                id                       TEXT(36) PRIMARY KEY,
                session_id               TEXT(36) NOT NULL,
                user_id                  TEXT(36) NOT NULL,
                sync_type                TEXT NOT NULL,
                method                   TEXT NOT NULL,
                zotero_local_id          TEXT NOT NULL,
                zotero_user_id           TEXT,
                library_id               INTEGER NOT NULL,
                total_upserts            INTEGER NOT NULL DEFAULT 0,
                total_deletions          INTEGER NOT NULL DEFAULT 0,
                library_version          INTEGER NOT NULL,
                library_date_modified    TEXT NOT NULL,
                timestamp                TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS embeddings (
                item_id                  INTEGER NOT NULL,
                library_id               INTEGER NOT NULL,
                zotero_key               TEXT NOT NULL,
                version                  INTEGER NOT NULL,
                client_date_modified     TEXT NOT NULL,
                content_hash             TEXT NOT NULL,
                embedding                BLOB NOT NULL,
                dimensions               INTEGER NOT NULL,
                model_id                 TEXT NOT NULL,
                indexed_at               TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (item_id, model_id)
            );
        `);
        // One vector per item *per model*: vectors from different models are
        // not comparable, and keeping each model's set lets the user switch
        // embedding providers back and forth without rebuilding either index.
        await this.migrateEmbeddingsToPerModelKeys();

        // Table for tracking embedding index state per library
        // Used to optimize startup by skipping full diff when nothing changed
        const INDEX_STATE_TABLE = `
            CREATE TABLE IF NOT EXISTS embedding_index_state (
                library_id               INTEGER NOT NULL,
                model_id                 TEXT NOT NULL,
                last_scan_timestamp      TEXT NOT NULL,
                max_client_date_modified TEXT NOT NULL,
                item_count               INTEGER NOT NULL,
                embedding_count          INTEGER NOT NULL,
                PRIMARY KEY (library_id, model_id)
            );
        `;
        await this.conn.queryAsync(INDEX_STATE_TABLE);
        // Per library *and model* now. A cache of the last scan, not data, so an
        // old-shape table is dropped rather than migrated: the next start runs
        // one baseline diff, finds the existing vectors by content hash, and
        // re-embeds nothing.
        const stateColumns: string[] = [];
        await this.conn.queryAsync(`PRAGMA table_info(embedding_index_state)`, [], {
            onRow: (row: any) => stateColumns.push(row.getResultByIndex(1)),
        });
        if (stateColumns.length > 0 && !stateColumns.includes('model_id')) {
            await this.conn.queryAsync(`DROP TABLE embedding_index_state`);
            await this.conn.queryAsync(INDEX_STATE_TABLE);
        }

        // Table for tracking failed embedding attempts
        // Items are retried with exponential backoff
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS failed_embeddings (
                item_id                  INTEGER PRIMARY KEY,
                library_id               INTEGER NOT NULL,
                failure_count            INTEGER NOT NULL DEFAULT 1,
                last_error               TEXT NOT NULL,
                last_attempt             TEXT NOT NULL DEFAULT (datetime('now')),
                next_retry_after         TEXT NOT NULL
            );
        `);

        // DB indexes
        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_messages_user_thread
            ON messages(user_id, thread_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_threads_user_updated
            ON threads(user_id, updated_at DESC);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_messages_user_thread_created
            ON messages(user_id, thread_id, created_at);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_user_library
            ON sync_logs(user_id, library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_user_library_version
            ON sync_logs(user_id, library_id, library_version DESC);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_user_library_date
            ON sync_logs(user_id, library_id, library_date_modified DESC);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_sync_logs_session
            ON sync_logs(session_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_embeddings_library
            ON embeddings(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash
            ON embeddings(content_hash);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_embeddings_zotero_key
            ON embeddings(zotero_key);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_failed_embeddings_library
            ON failed_embeddings(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_failed_embeddings_retry
            ON failed_embeddings(next_retry_after);
        `);

        await this.conn.queryAsync(`DROP TABLE IF EXISTS attachment_file_cache`);

        // Drop and recreate the document cache tables if the schema is stale
        if (await this.documentCacheSchemaIsStale()) {
            await this.conn.queryAsync(`DROP TABLE IF EXISTS document_cache_payloads`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS document_cache_metadata`);
        }

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS document_cache_metadata (
                id                         INTEGER PRIMARY KEY,
                item_id                    INTEGER NOT NULL,
                library_id                 INTEGER NOT NULL,
                zotero_key                 TEXT NOT NULL,
                content_kind               TEXT NOT NULL,
                file_path                  TEXT NOT NULL,
                file_mtime_ms              INTEGER NOT NULL,
                file_size_bytes            INTEGER NOT NULL,
                source_size_bytes          INTEGER NOT NULL,
                content_type               TEXT NOT NULL,
                document_metadata_json     TEXT NOT NULL,
                error_code                 TEXT,
                extraction_schema_version  TEXT NOT NULL,
                metadata_format_version    INTEGER NOT NULL,
                created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                last_accessed_at           TEXT,
                UNIQUE(library_id, zotero_key)
            );
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcm_item_id
            ON document_cache_metadata(item_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcm_library
            ON document_cache_metadata(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS document_cache_payloads (
                id                         INTEGER PRIMARY KEY,
                metadata_id                INTEGER NOT NULL,
                item_id                    INTEGER NOT NULL,
                library_id                 INTEGER NOT NULL,
                zotero_key                 TEXT NOT NULL,
                payload_kind               TEXT NOT NULL,
                content_kind               TEXT NOT NULL,
                source_file_path           TEXT NOT NULL,
                source_file_mtime_ms       INTEGER NOT NULL,
                source_file_size_bytes     INTEGER NOT NULL,
                source_size_bytes          INTEGER NOT NULL,
                payload_path               TEXT NOT NULL,
                payload_size_bytes         INTEGER NOT NULL,
                payload_sha256             TEXT,
                extraction_schema_version  TEXT NOT NULL,
                cache_format_version       INTEGER NOT NULL,
                created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
                last_accessed_at           TEXT,
                FOREIGN KEY (metadata_id)
                    REFERENCES document_cache_metadata(id)
                    ON DELETE CASCADE,
                UNIQUE(metadata_id, payload_kind)
            );
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_metadata_id
            ON document_cache_payloads(metadata_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_item_id
            ON document_cache_payloads(item_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_library
            ON document_cache_payloads(library_id);
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_dcp_library_key_payload_kind
            ON document_cache_payloads(library_id, zotero_key, payload_kind);
        `);

        // User-attached external files (registry behind the `ext-<KEY>` ids).
        // One row per attached file; the copy lives in the Beaver-managed
        // external-files folder at stored_path.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS external_files (
                ext_key        TEXT PRIMARY KEY,
                filename       TEXT NOT NULL,
                original_path  TEXT,
                stored_path    TEXT NOT NULL,
                content_kind   TEXT NOT NULL CHECK (content_kind IN ('pdf','epub','text','image')),
                mime_type      TEXT NOT NULL,
                file_size      INTEGER NOT NULL,
                mtime_ms       INTEGER NOT NULL,
                page_count     INTEGER,
                sha256         TEXT,
                created_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        // Pre-release tables were created without the sha256 column; add it
        // in place rather than dropping the registry.
        const externalFileColumns: string[] = [];
        await this.conn.queryAsync(`PRAGMA table_info(external_files)`, [], {
            onRow: (row: any) => externalFileColumns.push(row.getResultByIndex(1)),
        });
        if (!externalFileColumns.includes('sha256')) {
            await this.conn.queryAsync(`ALTER TABLE external_files ADD COLUMN sha256 TEXT`);
        }

        // Content-hash lookup for attach-time deduplication (non-unique:
        // dedup is best-effort and concurrent attaches may race).
        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_external_files_sha256
            ON external_files(sha256);
        `);

        // Drop and recreate the ephemeral queue if the schema or unique key is stale.
        if (await this.backgroundJobsSchemaIsStale()) {
            await this.conn.queryAsync(`DROP TABLE IF EXISTS background_jobs_dead`);
            await this.conn.queryAsync(`DROP TABLE IF EXISTS background_jobs`);
        }

        // Background job queue: one row per logical document extraction request.
        // Uses epoch-ms timestamps throughout so visibility-bump UPSERTs can
        // compare via MIN(available_at, ?) without string-vs-number drift.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS background_jobs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type        TEXT NOT NULL,
                library_id      INTEGER NOT NULL,
                item_id         INTEGER,
                zotero_key      TEXT NOT NULL,
                content_kind    TEXT NOT NULL,
                payload_kind    TEXT NOT NULL,
                priority        INTEGER NOT NULL DEFAULT 100,
                payload_json    TEXT,
                enqueued_at     INTEGER NOT NULL,
                available_at    INTEGER NOT NULL,
                attempt_count   INTEGER NOT NULL DEFAULT 0,
                last_error      TEXT,
                UNIQUE(job_type, library_id, zotero_key, payload_kind)
            );
        `);

        await this.conn.queryAsync(`
            CREATE INDEX IF NOT EXISTS idx_background_jobs_visible
            ON background_jobs (available_at, priority);
        `);

        // Dead-letter table for jobs that exceeded MAX_ATTEMPTS. Surfaced
        // through the dev queue-stats endpoint; no automatic retry.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS background_jobs_dead (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type        TEXT NOT NULL,
                library_id      INTEGER NOT NULL,
                zotero_key      TEXT NOT NULL,
                content_kind    TEXT NOT NULL,
                payload_kind    TEXT NOT NULL,
                payload_json    TEXT,
                enqueued_at     INTEGER NOT NULL,
                died_at         INTEGER NOT NULL,
                attempt_count   INTEGER NOT NULL,
                last_error      TEXT
            );
        `);

        // A run's transcript, stored whole.
        //
        // Beaver kept run history on its server and rebuilt it over REST, so
        // nothing local ever held it. Running the model here means this install
        // is the only place the transcript exists — without this table a thread
        // lives only in memory and every restart is a clean slate.
        //
        // The payload is the `AgentRun` as JSON rather than a normalized set of
        // message and part tables: the shape is the transport's, it changes with
        // the upstream protocol, and nothing queries inside it. `created_at` is
        // stored separately only because the ordering has to survive a payload
        // shape change.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS agent_runs (
                id                       TEXT(36) PRIMARY KEY,
                thread_id                TEXT(36) NOT NULL,
                user_id                  TEXT(36) NOT NULL,
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                payload                  TEXT NOT NULL,
                FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
            );
        `);
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS agent_runs_thread_idx ON agent_runs (thread_id, created_at)`,
        );

        /*
         * The words a history search matches: the question and the model's
         * text replies, extracted when the run is stored (`runSearchText`).
         * NULL on rows stored before the column existed; `ensureRunIndex`
         * fills those in once, the first time a search or a paper lookup
         * needs them.
         */
        const runColumns: string[] = [];
        await this.conn.queryAsync(`PRAGMA table_info(agent_runs)`, [], {
            onRow: (row: any) => runColumns.push(row.getResultByIndex(1)),
        });
        if (!runColumns.includes('search_text')) {
            await this.conn.queryAsync(`ALTER TABLE agent_runs ADD COLUMN search_text TEXT`);
        }
        /*
         * The rows `ensureRunIndex` still has to fill in. Partial, so it is
         * empty once they are done, and the check each session makes before
         * the first search or paper lookup is one lookup in it — not a read
         * of every stored transcript to find there is nothing left.
         */
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS agent_runs_unindexed_idx ON agent_runs (id) WHERE search_text IS NULL`,
        );

        /*
         * Runs removed from a thread on purpose — the ones a retry, a
         * regenerate or an edit-and-resend replaced.
         *
         * Deleting the rows is not enough once the thread syncs: another
         * computer still holds them, and the next copy it writes would bring
         * them back into the middle of the conversation. The marker travels in
         * the thread's file (`removedRuns`), and `saveRun` refuses an id that
         * carries one. Run ids are never reused — a retry starts a new run —
         * so a marker can never block a legitimate write.
         */
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS run_tombstones (
                run_id                   TEXT(36) PRIMARY KEY,
                thread_id                TEXT(36) NOT NULL,
                deleted_at               TEXT NOT NULL
            );
        `);
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS run_tombstones_thread_idx ON run_tombstones (thread_id)`,
        );

        // Which conversation belongs to which highlight.
        //
        // The annotation is the durable half — Zotero stores and syncs it — so
        // the link is keyed by annotation rather than the reverse. `attachment_key`
        // is denormalized so "every conversation in this paper" is one query
        // without touching Zotero's own database.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS thread_anchors (
                library_id               INTEGER NOT NULL,
                annotation_key           TEXT NOT NULL,
                thread_id                TEXT(36) NOT NULL,
                attachment_key           TEXT,
                selected_text            TEXT,
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (library_id, annotation_key)
            );
        `);
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS thread_anchors_attachment_idx
             ON thread_anchors (library_id, attachment_key)`,
        );
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS thread_anchors_thread_idx ON thread_anchors (thread_id)`,
        );

        // Which items a conversation drew on.
        //
        // Two questions need this, and neither can be answered from the run
        // payload without reading every row: "which conversations touched this
        // paper" (the reader's own history) and "what did this conversation
        // reference" (shown next to the thread in the list).
        //
        // Recorded per thread rather than per run: a thread is what the user
        // reopens, and a paper referenced in its third turn belongs to the whole
        // conversation.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS thread_items (
                thread_id                TEXT(36) NOT NULL,
                library_id               INTEGER NOT NULL,
                item_key                 TEXT NOT NULL,
                /** 'attachment' when staged by the user, 'reader' when it was simply open. */
                source                   TEXT,
                created_at               TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (thread_id, library_id, item_key)
            );
        `);
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS thread_items_item_idx ON thread_items (library_id, item_key)`,
        );

        // Full-text passages, one row per chunk.
        //
        // The `embeddings` table is keyed by item and holds one vector for a
        // title and abstract, which can only ever match what a paper is *about*.
        // A claim made in section 4 needs its own vector, and its own page, or
        // "which of my papers discusses X" cannot be answered at all.
        //
        // `model_id` is stored for the same reason as on `embeddings`: vectors
        // from different models are not comparable, so a change of provider has
        // to invalidate what is here.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS chunk_embeddings (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                library_id               INTEGER NOT NULL,
                attachment_key           TEXT NOT NULL,
                parent_key               TEXT,
                page_index               INTEGER NOT NULL,
                page_label               TEXT,
                chunk_index              INTEGER NOT NULL,
                text                     TEXT NOT NULL,
                embedding                BLOB NOT NULL,
                dimensions               INTEGER NOT NULL,
                model_id                 TEXT NOT NULL,
                indexed_at               TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (library_id, attachment_key, page_index, chunk_index, model_id)
            );
        `);
        await this.migrateChunkEmbeddingsToPerModelKeys();
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS chunk_embeddings_attachment_idx
             ON chunk_embeddings (library_id, attachment_key)`,
        );
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS chunk_embeddings_model_idx ON chunk_embeddings (model_id)`,
        );

        /*
         * The extraction sentence range each chunk covers (numeric part of
         * "s223"), or NULL for chunks indexed before sentence-aware chunking —
         * their hits keep falling back to the page, exactly as before.
         */
        const chunkColumns: string[] = [];
        await this.conn.queryAsync(`PRAGMA table_info(chunk_embeddings)`, [], {
            onRow: (row: any) => chunkColumns.push(row.getResultByIndex(1)),
        });
        if (!chunkColumns.includes('sentence_start')) {
            await this.conn.queryAsync(`ALTER TABLE chunk_embeddings ADD COLUMN sentence_start INTEGER`);
        }
        if (!chunkColumns.includes('sentence_end')) {
            await this.conn.queryAsync(`ALTER TABLE chunk_embeddings ADD COLUMN sentence_end INTEGER`);
        }

        // PDF pages as pictures, one vector each, for finding a figure by what
        // it shows. Only a model that embeds images in the space of its text
        // queries has rows here; like the passages, they are kept per model.
        await this.conn.queryAsync(`
            CREATE TABLE IF NOT EXISTS page_image_embeddings (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                library_id               INTEGER NOT NULL,
                attachment_key           TEXT NOT NULL,
                parent_key               TEXT,
                page_index               INTEGER NOT NULL,
                page_label               TEXT,
                embedding                BLOB NOT NULL,
                dimensions               INTEGER NOT NULL,
                model_id                 TEXT NOT NULL,
                indexed_at               TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE (library_id, attachment_key, page_index, model_id)
            );
        `);
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS page_image_embeddings_attachment_idx
             ON page_image_embeddings (library_id, attachment_key)`,
        );
        await this.conn.queryAsync(
            `CREATE INDEX IF NOT EXISTS page_image_embeddings_model_idx ON page_image_embeddings (model_id)`,
        );
    }

    /**
     * Close the database connection for good. A query arriving afterwards —
     * from an indexing run still in flight while the plugin shuts down — then
     * fails, instead of quietly opening a connection that nothing closes: that
     * one would keep the write-ahead log from being folded in at shutdown, and
     * Zotero would check the whole database at the next start.
     */
    public async closeDatabase(): Promise<void> {
        // A close while the connection is still opening would do nothing, and
        // the open would then finish into a connection no one closes.
        await this.opening?.catch(() => undefined);
        await this.conn.closeDatabase(true);
    }

    /** The open in flight, which a close waits for. */
    private opening: Promise<unknown> | null = null;

    /** Note an open in flight, so that a close coming meanwhile waits for it. */
    public whileOpening<T>(open: Promise<T>): Promise<T> {
        this.opening = open;
        return open.finally(() => {
            if (this.opening === open) this.opening = null;
        });
    }

    /**
     * Helper method to construct ThreadRecord from a database row
     */
    private static rowToThreadRecord(row: any): ThreadRecord {
        return {
            id: row.id,
            user_id: row.user_id,
            name: row.name,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    /**
     * Convert ThreadRecord to ThreadData (application-facing format)
     */
    private static threadRecordToData(record: ThreadRecord): ThreadData {
        return {
            id: record.id,
            name: record.name || '', // Convert null to empty string
            createdAt: record.created_at,
            updatedAt: record.updated_at,
        };
    }

    /**
     * A row for the history lists: the thread plus its archive state, so a
     * list can pick each row's actions (Restore, Delete forever) from the row
     * itself rather than from which list happens to be showing.
     */
    private static rowToListedThread(row: any): ListedThread {
        return {
            ...BeaverDB.threadRecordToData(BeaverDB.rowToThreadRecord(row)),
            archivedAt: row.archived_at ?? null,
        };
    }

    /**
     * A stored timestamp in milliseconds. Two dialects occur: ISO with a zone,
     * and SQLite's `datetime('now')`, which is UTC but carries no zone — and
     * `Date.parse` would read that one as local time.
     */
    private static timestampMs(value: string): number {
        const raw = String(value ?? '').trim();
        return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
            ? Date.parse(`${raw.replace(' ', 'T')}Z`)
            : Date.parse(raw);
    }

    /**
     * Convert ThreadData to ThreadRecord format (for database operations)
     */
    private static threadDataToRecord(data: Partial<ThreadData>): Partial<ThreadRecord> {
        const record: Partial<ThreadRecord> = {};
        
        if (data.id !== undefined) record.id = data.id;
        if (data.name !== undefined) record.name = data.name || null; // Convert empty string to null for database
        if (data.createdAt !== undefined) record.created_at = data.createdAt;
        if (data.updatedAt !== undefined) record.updated_at = data.updatedAt;
        
        return record;
    }

    /**
     * Helper method to construct SyncLogsRecord from a database row
     */
    private static rowToSyncLogsRecord(row: any): SyncLogsRecord {
        return {
            id: row.id,
            session_id: row.session_id,
            user_id: row.user_id,
            sync_type: row.sync_type as SyncType,
            method: row.method as SyncMethod,
            zotero_local_id: row.zotero_local_id,
            zotero_user_id: row.zotero_user_id,
            library_id: row.library_id,
            total_upserts: row.total_upserts,
            total_deletions: row.total_deletions,
            library_version: row.library_version,
            library_date_modified: row.library_date_modified,
            timestamp: row.timestamp,
        };
    }

    // --- Local run history ---

    /**
     * Store a finished run, and make sure its thread row exists first.
     *
     * Called once per completed run. Upserting the thread here rather than at
     * thread-creation time keeps the two writes in one place: a run whose thread
     * row was never written would be lost to the foreign key, and a thread row
     * with no runs is clutter.
     */
    public async saveRun(
        run: {
            id: string;
            thread_id: string;
            user_id: string;
            created_at?: string;
            payload: unknown;
        },
        options: {
            /** A run synced from another computer's copy of the thread. */
            imported?: boolean;
        } = {},
    ): Promise<void> {
        if (await this.threadTombstone(run.user_id, run.thread_id)) {
            // The user permanently deleted this conversation; a detached
            // post-run write must not resurrect it.
            Zotero.debug(`BeaverDB.saveRun: dropping write to tombstoned thread ${run.thread_id}`);
            return;
        }
        if (await this.runTombstone(run.id)) {
            // Replaced by a retry or an edit, here or on another computer; a
            // synced copy written before that computer heard must not put it
            // back into the conversation.
            Zotero.debug(`BeaverDB.saveRun: dropping write to removed run ${run.id}`);
            return;
        }
        const now = new Date().toISOString();
        await this.conn.queryAsync(
            `INSERT OR IGNORE INTO threads (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
            [run.thread_id, run.user_id, now, now],
        );
        await this.conn.queryAsync(`UPDATE threads SET updated_at = ? WHERE id = ?`, [
            now,
            run.thread_id,
        ]);
        /*
         * A run started after the conversation was archived takes it back
         * out, as a new message does (`ensureThread`): a retry, a regenerate,
         * an edited question or a resume in a chat opened from the archive is
         * the chat in use. A run already under way when the user archived
         * leaves it archived. So does an imported run — the archive state
         * travels on its own, through the archive reconcile. The stamp above
         * is what tells that reconcile this restore is the later event.
         */
        if (!options.imported && run.created_at) {
            const archivedAt = await this.threadArchivedAt(run.user_id, run.thread_id);
            if (archivedAt && BeaverDB.timestampMs(run.created_at) > BeaverDB.timestampMs(archivedAt)) {
                await this.conn.queryAsync(
                    `UPDATE threads SET archived_at = NULL WHERE user_id = ? AND id = ?`,
                    [run.user_id, run.thread_id],
                );
            }
        }
        // REPLACE rather than INSERT: the same run can be stored more than
        // once — a newer synced copy arrives with the same id — and the newer
        // transcript is the one worth keeping.
        await this.conn.queryAsync(
            `INSERT OR REPLACE INTO agent_runs (id, thread_id, user_id, created_at, payload, search_text)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                run.id,
                run.thread_id,
                run.user_id,
                run.created_at ?? now,
                JSON.stringify(run.payload),
                runSearchText(run.payload),
            ],
        );
        /*
         * Every stored run keeps "chats about this paper" and "the chat behind
         * this highlight" right, whoever stored it: a run synced from another
         * computer arrives here with nothing else to record those.
         */
        try {
            await this.indexRunLinks(run.thread_id, run.payload);
        } catch (error) {
            Zotero.debug(`BeaverDB.saveRun: could not index the links of run ${run.id}: ${error}`);
        }
    }

    /** Name a thread, creating its row if this is the first time it is named. */
    public async setThreadName(
        threadId: string,
        userId: string,
        name: string,
    ): Promise<void> {
        if (await this.threadTombstone(userId, threadId)) {
            Zotero.debug(`BeaverDB.setThreadName: dropping write to tombstoned thread ${threadId}`);
            return;
        }
        const now = new Date().toISOString();
        await this.conn.queryAsync(
            `INSERT OR IGNORE INTO threads (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
            [threadId, userId, now, now],
        );
        await this.conn.queryAsync(`UPDATE threads SET name = ?, updated_at = ? WHERE id = ?`, [
            name,
            now,
            threadId,
        ]);
    }

    /**
     * The ids of a thread's runs in the order they happened: enough to tell
     * whether its runs changed, without reading their payloads.
     */
    public async getRunIdsForThread(threadId: string): Promise<string[]> {
        const rows = await this.conn.queryAsync(
            `SELECT id FROM agent_runs WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
            [threadId],
        );
        return (rows ?? []).map((row: any) => String(row.id));
    }

    /**
     * A thread's runs in the order they happened.
     *
     * A row whose payload will not parse is skipped rather than thrown on: one
     * corrupt run should cost that run, not the whole conversation.
     */
    public async getRunsForThread(threadId: string): Promise<any[]> {
        const rows = await this.conn.queryAsync(
            `SELECT id, payload FROM agent_runs WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
            [threadId],
        );
        const runs: any[] = [];
        for (const row of rows ?? []) {
            try {
                runs.push(JSON.parse(row.payload));
            } catch (error) {
                Zotero.debug(`BeaverDB.getRunsForThread: unreadable payload for run ${row.id}`);
            }
        }
        return runs;
    }

    /**
     * Remove runs from a thread, the local counterpart of the server's
     * truncation endpoint.
     *
     * Retrying a failed run first deletes it and everything after it. Upstream
     * that is a POST the client refuses to proceed without — so locally, where
     * the POST cannot succeed, Retry threw instead of retrying.
     *
     * The `expectedTailRunId` check is kept rather than dropped as
     * single-install paranoia: two Zotero windows share this database, and it is
     * the difference between deleting the runs the caller looked at and deleting
     * whatever happens to be there now.
     */
    public async deleteRuns(
        threadId: string,
        runIds: string[],
        expectedTailRunId: string | null,
    ): Promise<{ deleted_run_ids: string[]; refused_run_ids: string[]; reason?: string }> {
        if (runIds.length === 0) {
            return { deleted_run_ids: [], refused_run_ids: [] };
        }

        const rows = await this.conn.queryAsync(
            `SELECT id FROM agent_runs WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
            [threadId],
        );
        const present: string[] = (rows ?? []).map((row: any) => String(row.id));
        const doomed = new Set(runIds);
        const survivors = present.filter((id) => !doomed.has(id));
        const actualTail = survivors.length > 0 ? survivors[survivors.length - 1] : null;

        if (actualTail !== expectedTailRunId) {
            return {
                deleted_run_ids: [],
                refused_run_ids: [...runIds],
                reason: 'tail_mismatch',
            };
        }

        const deletable = present.filter((id) => doomed.has(id));
        for (const id of deletable) {
            await this.conn.queryAsync(`DELETE FROM agent_runs WHERE id = ? AND thread_id = ?`, [
                id,
                threadId,
            ]);
        }
        /*
         * Every named run is marked, not only the ones that were here: the
         * intent is that none of them be in the thread, and a copy synced from
         * another computer may still carry any of them.
         */
        const removedAt = new Date().toISOString();
        for (const id of runIds) {
            await this.conn.queryAsync(
                `INSERT OR IGNORE INTO run_tombstones (run_id, thread_id, deleted_at) VALUES (?, ?, ?)`,
                [id, threadId, removedAt],
            );
        }
        // A named run that was already gone is not a refusal: the caller's
        // intent — that it not be in the thread — holds either way.
        return { deleted_run_ids: deletable, refused_run_ids: [] };
    }

    /** When a run was removed from its thread on purpose, or null if it never was. */
    public async runTombstone(runId: string): Promise<string | null> {
        const rows = await this.conn.queryAsync(
            `SELECT deleted_at FROM run_tombstones WHERE run_id = ?`,
            [runId],
        );
        return rows && rows.length > 0 ? String(rows[0].deleted_at) : null;
    }

    /** The runs removed from one thread on purpose, for its synced file. */
    public async runTombstonesForThread(
        threadId: string,
    ): Promise<Array<{ run_id: string; deleted_at: string }>> {
        const rows = await this.conn.queryAsync(
            `SELECT run_id, deleted_at FROM run_tombstones WHERE thread_id = ? ORDER BY deleted_at ASC`,
            [threadId],
        );
        return (rows ?? []).map((row: any) => ({
            run_id: String(row.run_id),
            deleted_at: String(row.deleted_at),
        }));
    }

    /**
     * Apply run removals another computer made: mark each run and delete it
     * here. Returns how many runs this actually took out of the thread.
     */
    public async applyRunRemovals(
        threadId: string,
        removals: Array<{ run_id: string; deleted_at: string }>,
    ): Promise<number> {
        let removed = 0;
        for (const { run_id, deleted_at } of removals) {
            if (!run_id) continue;
            await this.conn.queryAsync(
                `INSERT OR IGNORE INTO run_tombstones (run_id, thread_id, deleted_at) VALUES (?, ?, ?)`,
                [run_id, threadId, deleted_at || new Date().toISOString()],
            );
            const present = await this.conn.queryAsync(
                `SELECT id FROM agent_runs WHERE id = ? AND thread_id = ?`,
                [run_id, threadId],
            );
            if (present && present.length > 0) {
                await this.conn.queryAsync(`DELETE FROM agent_runs WHERE id = ? AND thread_id = ?`, [
                    run_id,
                    threadId,
                ]);
                removed += 1;
            }
        }
        return removed;
    }

    // --- Full-text passages ---

    /**
     * Rebuild `embeddings` so the key is (item_id, model_id).
     *
     * SQLite cannot change a primary key in place, so the table is copied.
     * Nothing is lost: every existing vector keeps its model id, and the
     * index statements that follow recreate the dropped indexes.
     */
    private async migrateEmbeddingsToPerModelKeys(): Promise<void> {
        const columns: Array<{ name: string; pk: number }> = [];
        await this.conn.queryAsync(`PRAGMA table_info(embeddings)`, [], {
            onRow: (row: any) => columns.push({ name: row.getResultByIndex(1), pk: row.getResultByIndex(5) }),
        });
        if (columns.length === 0) return;
        if (columns.some((column) => column.name === 'model_id' && column.pk > 0)) return;

        const list = 'item_id, library_id, zotero_key, version, client_date_modified, content_hash, embedding, dimensions, model_id, indexed_at';
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(`DROP TABLE IF EXISTS embeddings_per_model`);
            await this.conn.queryAsync(`
                CREATE TABLE embeddings_per_model (
                    item_id                  INTEGER NOT NULL,
                    library_id               INTEGER NOT NULL,
                    zotero_key               TEXT NOT NULL,
                    version                  INTEGER NOT NULL,
                    client_date_modified     TEXT NOT NULL,
                    content_hash             TEXT NOT NULL,
                    embedding                BLOB NOT NULL,
                    dimensions               INTEGER NOT NULL,
                    model_id                 TEXT NOT NULL,
                    indexed_at               TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY (item_id, model_id)
                )
            `);
            await this.conn.queryAsync(`INSERT INTO embeddings_per_model (${list}) SELECT ${list} FROM embeddings`);
            await this.conn.queryAsync(`DROP TABLE embeddings`);
            await this.conn.queryAsync(`ALTER TABLE embeddings_per_model RENAME TO embeddings`);
        });
    }

    /**
     * Rebuild `chunk_embeddings` so the unique key includes the model, for the
     * same reason as {@link migrateEmbeddingsToPerModelKeys}. Copies whichever
     * of the current columns the old table already has.
     */
    private async migrateChunkEmbeddingsToPerModelKeys(): Promise<void> {
        const columns: string[] = [];
        await this.conn.queryAsync(`PRAGMA table_info(chunk_embeddings)`, [], {
            onRow: (row: any) => columns.push(row.getResultByIndex(1)),
        });
        if (columns.length === 0) return;

        // index_list: seq, name, unique, origin, partial — index_info: seqno, cid, name.
        const uniqueIndexes: string[] = [];
        await this.conn.queryAsync(`PRAGMA index_list(chunk_embeddings)`, [], {
            onRow: (row: any) => {
                if (row.getResultByIndex(2)) uniqueIndexes.push(row.getResultByIndex(1));
            },
        });
        for (const name of uniqueIndexes) {
            const keyColumns: string[] = [];
            await this.conn.queryAsync(`PRAGMA index_info("${name}")`, [], {
                onRow: (row: any) => keyColumns.push(row.getResultByIndex(2)),
            });
            if (keyColumns.includes('attachment_key') && keyColumns.includes('model_id')) return;
        }

        const wanted = ['id', 'library_id', 'attachment_key', 'parent_key', 'page_index', 'page_label',
            'chunk_index', 'text', 'embedding', 'dimensions', 'model_id', 'indexed_at',
            'sentence_start', 'sentence_end'];
        const list = wanted.filter((column) => columns.includes(column)).join(', ');
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(`DROP TABLE IF EXISTS chunk_embeddings_per_model`);
            await this.conn.queryAsync(`
                CREATE TABLE chunk_embeddings_per_model (
                    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                    library_id               INTEGER NOT NULL,
                    attachment_key           TEXT NOT NULL,
                    parent_key               TEXT,
                    page_index               INTEGER NOT NULL,
                    page_label               TEXT,
                    chunk_index              INTEGER NOT NULL,
                    text                     TEXT NOT NULL,
                    embedding                BLOB NOT NULL,
                    dimensions               INTEGER NOT NULL,
                    model_id                 TEXT NOT NULL,
                    indexed_at               TEXT NOT NULL DEFAULT (datetime('now')),
                    sentence_start           INTEGER,
                    sentence_end             INTEGER,
                    UNIQUE (library_id, attachment_key, page_index, chunk_index, model_id)
                )
            `);
            await this.conn.queryAsync(`INSERT INTO chunk_embeddings_per_model (${list}) SELECT ${list} FROM chunk_embeddings`);
            await this.conn.queryAsync(`DROP TABLE chunk_embeddings`);
            await this.conn.queryAsync(`ALTER TABLE chunk_embeddings_per_model RENAME TO chunk_embeddings`);
        });
    }

    /**
     * Every embedding model with vectors in this database, with what each holds.
     * `bytes` is the stored vector data (int8 values), not the SQLite page total.
     */
    public async listEmbeddingModels(): Promise<Array<{ model_id: string; items: number; chunks: number; images: number; bytes: number }>> {
        // Starts with SELECT on the first character: Zotero's connection decides
        // whether a statement returns rows by looking at how the string begins.
        const rows = await this.conn.queryAsync(
            `SELECT model_id, SUM(items) AS items, SUM(chunks) AS chunks, SUM(images) AS images, SUM(bytes) AS bytes
             FROM (
                 SELECT model_id, COUNT(*) AS items, 0 AS chunks, 0 AS images, COALESCE(SUM(LENGTH(embedding)), 0) AS bytes
                 FROM embeddings GROUP BY model_id
                 UNION ALL
                 SELECT model_id, 0, COUNT(*), 0, COALESCE(SUM(LENGTH(embedding)), 0)
                 FROM chunk_embeddings GROUP BY model_id
                 UNION ALL
                 SELECT model_id, 0, 0, COUNT(*), COALESCE(SUM(LENGTH(embedding)), 0)
                 FROM page_image_embeddings GROUP BY model_id
             )
             GROUP BY model_id
             ORDER BY model_id`,
        );
        return (rows ?? []).map((row: any) => ({
            model_id: String(row.model_id),
            items: Number(row.items) || 0,
            chunks: Number(row.chunks) || 0,
            images: Number(row.images) || 0,
            bytes: Number(row.bytes) || 0,
        }));
    }

    /**
     * Drop one model's index entirely: its item vectors, passage vectors and scan
     * records. Other models' indexes are untouched. If this is the active model,
     * the next scan simply rebuilds it.
     */
    public async deleteEmbeddingsForModel(modelId: string): Promise<{ items: number; chunks: number }> {
        const before = (await this.listEmbeddingModels()).find((m) => m.model_id === modelId);
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(`DELETE FROM embeddings WHERE model_id = ?`, [modelId]);
            await this.conn.queryAsync(`DELETE FROM chunk_embeddings WHERE model_id = ?`, [modelId]);
            await this.conn.queryAsync(`DELETE FROM page_image_embeddings WHERE model_id = ?`, [modelId]);
            await this.conn.queryAsync(`DELETE FROM embedding_index_state WHERE model_id = ?`, [modelId]);
        });
        return { items: before?.items ?? 0, chunks: before?.chunks ?? 0 };
    }

    /** Replace an attachment's chunks with a freshly-indexed set (this model's only). */
    public async replaceChunks(
        libraryId: number,
        attachmentKey: string,
        parentKey: string | null,
        modelId: string,
        dimensions: number,
        chunks: Array<{
            pageIndex: number;
            pageLabel?: string | null;
            chunkIndex: number;
            text: string;
            embedding: Uint8Array;
            sentenceStart?: number | null;
            sentenceEnd?: number | null;
        }>,
    ): Promise<void> {
        // Deleted first so a re-index after an edited PDF cannot leave passages
        // from the old text behind, which would surface as a hit on a page that
        // no longer says that.
        await this.conn.queryAsync(
            `DELETE FROM chunk_embeddings WHERE library_id = ? AND attachment_key = ? AND model_id = ?`,
            [libraryId, attachmentKey, modelId],
        );
        for (const chunk of chunks) {
            await this.conn.queryAsync(
                `INSERT OR REPLACE INTO chunk_embeddings
                    (library_id, attachment_key, parent_key, page_index, page_label,
                     chunk_index, text, embedding, dimensions, model_id, indexed_at,
                     sentence_start, sentence_end)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    libraryId,
                    attachmentKey,
                    parentKey,
                    chunk.pageIndex,
                    chunk.pageLabel ?? null,
                    chunk.chunkIndex,
                    chunk.text,
                    chunk.embedding,
                    dimensions,
                    modelId,
                    new Date().toISOString(),
                    chunk.sentenceStart ?? null,
                    chunk.sentenceEnd ?? null,
                ],
            );
        }
    }

    /** Every chunk that can be compared with vectors from `modelId`. */
    public async getChunksForSearch(
        modelId: string,
        libraryIds?: number[],
    ): Promise<Array<{
        libraryId: number;
        attachmentKey: string;
        parentKey: string | null;
        pageIndex: number;
        pageLabel: string | null;
        text: string;
        embedding: Int8Array;
        sentenceStart: number | null;
        sentenceEnd: number | null;
    }>> {
        // A list of libraries narrows the search; an empty one means none is
        // searchable, which narrows it to nothing — never to every library.
        if (libraryIds && libraryIds.length === 0) return [];
        const params: any[] = [modelId];
        let sql = `SELECT library_id, attachment_key, parent_key, page_index, page_label, text, embedding,
                          sentence_start, sentence_end
                   FROM chunk_embeddings WHERE model_id = ?`;
        if (libraryIds) {
            sql += ` AND library_id IN (${libraryIds.map(() => '?').join(',')})`;
            params.push(...libraryIds);
        }
        const rows = await this.conn.queryAsync(sql, params);
        return (rows ?? []).map((row: any) => ({
            libraryId: row.library_id,
            attachmentKey: row.attachment_key,
            parentKey: row.parent_key ?? null,
            pageIndex: row.page_index,
            pageLabel: row.page_label ?? null,
            text: row.text,
            // Copied into a Uint8Array first, as `rowToEmbeddingRecord` does:
            // the driver hands back a plain array-like, whose `.buffer` is
            // undefined — so viewing it directly yields a zero-length vector and
            // the similarity check fails as a dimension mismatch.
            embedding: BeaverDB.blobToEmbedding(new Uint8Array(row.embedding)),
            sentenceStart: row.sentence_start ?? null,
            sentenceEnd: row.sentence_end ?? null,
        }));
    }

    /** Which attachments already have chunks for this model. */
    public async getChunkedAttachmentKeys(modelId: string): Promise<Set<string>> {
        const rows = await this.conn.queryAsync(
            `SELECT DISTINCT library_id, attachment_key FROM chunk_embeddings WHERE model_id = ?`,
            [modelId],
        );
        return new Set((rows ?? []).map((row: any) => `${row.library_id}-${row.attachment_key}`));
    }

    /** How many passages are indexed, and across how many documents. */
    /**
     * Documents indexed for this model with *no* passage carrying a sentence
     * range — indexed before sentence-aware chunking, so their hits cite a
     * page, not a sentence. Candidates for a re-index once the cached
     * extraction can say where each sentence sits.
     *
     * "No passage" and not "any passage": a sentence-aware index still leaves
     * headings, formulas and table cells without a range, so asking for any
     * unranged passage re-queued every such document on every sweep — 69 of
     * them, rebuilt five times over in one afternoon.
     */
    public async getAttachmentKeysLackingRanges(modelId: string): Promise<Set<string>> {
        const rows = await this.conn.queryAsync(
            `SELECT library_id, attachment_key FROM chunk_embeddings WHERE model_id = ?
             GROUP BY library_id, attachment_key HAVING SUM(sentence_start IS NOT NULL) = 0`,
            [modelId],
        );
        return new Set((rows ?? []).map((row: any) => `${row.library_id}-${row.attachment_key}`));
    }

    /** Replace an attachment's page images with a freshly rendered set (this model's only). */
    public async replacePageImages(
        libraryId: number,
        attachmentKey: string,
        parentKey: string | null,
        modelId: string,
        dimensions: number,
        pages: Array<{ pageIndex: number; pageLabel?: string | null; embedding: Uint8Array }>,
    ): Promise<void> {
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(
                `DELETE FROM page_image_embeddings WHERE library_id = ? AND attachment_key = ? AND model_id = ?`,
                [libraryId, attachmentKey, modelId],
            );
            for (const page of pages) {
                await this.conn.queryAsync(
                    `INSERT OR REPLACE INTO page_image_embeddings
                        (library_id, attachment_key, parent_key, page_index, page_label,
                         embedding, dimensions, model_id, indexed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        libraryId,
                        attachmentKey,
                        parentKey,
                        page.pageIndex,
                        page.pageLabel ?? null,
                        page.embedding,
                        dimensions,
                        modelId,
                        new Date().toISOString(),
                    ],
                );
            }
        });
    }

    /** Every page image that can be compared with a query from `modelId`. */
    public async getPageImagesForSearch(
        modelId: string,
        libraryIds?: number[],
    ): Promise<Array<{
        libraryId: number;
        attachmentKey: string;
        parentKey: string | null;
        pageIndex: number;
        pageLabel: string | null;
        embedding: Int8Array;
    }>> {
        // As for passages: an empty list of libraries finds nothing.
        if (libraryIds && libraryIds.length === 0) return [];
        const params: any[] = [modelId];
        let sql = `SELECT library_id, attachment_key, parent_key, page_index, page_label, embedding
                   FROM page_image_embeddings WHERE model_id = ?`;
        if (libraryIds) {
            sql += ` AND library_id IN (${libraryIds.map(() => '?').join(',')})`;
            params.push(...libraryIds);
        }
        const rows = await this.conn.queryAsync(sql, params);
        return (rows ?? []).map((row: any) => ({
            libraryId: row.library_id,
            attachmentKey: row.attachment_key,
            parentKey: row.parent_key ?? null,
            pageIndex: row.page_index,
            pageLabel: row.page_label ?? null,
            // Copied first, as getChunksForSearch does: the driver's array-like has no buffer.
            embedding: BeaverDB.blobToEmbedding(new Uint8Array(row.embedding)),
        }));
    }

    /** Which attachments already have page images for this model. */
    public async getPageImagedAttachmentKeys(modelId: string): Promise<Set<string>> {
        const rows = await this.conn.queryAsync(
            `SELECT DISTINCT library_id, attachment_key FROM page_image_embeddings WHERE model_id = ?`,
            [modelId],
        );
        return new Set((rows ?? []).map((row: any) => `${row.library_id}-${row.attachment_key}`));
    }

    public async getChunkStats(modelId?: string): Promise<{ chunks: number; attachments: number }> {
        const rows = await this.conn.queryAsync(
            `SELECT COUNT(*) AS chunks, COUNT(DISTINCT attachment_key) AS attachments
             FROM chunk_embeddings${modelId ? ' WHERE model_id = ?' : ''}`,
            modelId ? [modelId] : [],
        );
        return {
            chunks: rows?.[0]?.chunks ?? 0,
            attachments: rows?.[0]?.attachments ?? 0,
        };
    }

    // --- What a conversation referenced ---

    /**
     * Record the items a run drew on.
     *
     * Ignores duplicates rather than counting them: the same paper is referenced
     * by most turns of a conversation about it, and the question this answers is
     * only whether it was referenced at all.
     */
    public async recordThreadItems(
        threadId: string,
        items: Array<{ libraryId: number; itemKey: string; source?: string }>,
    ): Promise<void> {
        for (const item of items) {
            await this.conn.queryAsync(
                `INSERT OR IGNORE INTO thread_items (thread_id, library_id, item_key, source, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [threadId, item.libraryId, item.itemKey, item.source ?? null, new Date().toISOString()],
            );
        }
    }

    /** The items one conversation referenced. */
    public async getThreadItems(
        threadId: string,
    ): Promise<Array<{ libraryId: number; itemKey: string; source: string | null }>> {
        const rows = await this.conn.queryAsync(
            `SELECT library_id, item_key, source FROM thread_items WHERE thread_id = ?
             ORDER BY created_at ASC`,
            [threadId],
        );
        return (rows ?? []).map((row: any) => ({
            libraryId: row.library_id,
            itemKey: row.item_key,
            source: row.source ?? null,
        }));
    }

    /**
     * Conversations that referenced any of these item keys, newest first.
     *
     * Several keys because a paper and its attachments are different items: a
     * conversation may have referenced the PDF while the user is asking from the
     * parent, or the other way round.
     */
    public async getThreadsForItems(
        libraryId: number,
        itemKeys: string[],
        limit = 10,
        scope: ThreadListScope = {},
    ): Promise<ListedThread[]> {
        if (itemKeys.length === 0) return [];
        await this.ensureRunIndex();
        const placeholders = itemKeys.map(() => '?').join(',');
        const rows = await this.conn.queryAsync(
            `SELECT t.* FROM threads t
             JOIN thread_items ti ON ti.thread_id = t.id
             WHERE ti.library_id = ? AND ti.item_key IN (${placeholders})
               AND ${scope.archived ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL'}
             GROUP BY t.id
             ORDER BY ${scope.archived ? 't.archived_at' : 't.updated_at'} DESC
             LIMIT ?`,
            [libraryId, ...itemKeys, limit],
        );
        return (rows ?? []).map((row: any) => BeaverDB.rowToListedThread(row));
    }

    /**
     * Search conversations by name and by what was said in them.
     *
     * Names alone are too thin to search: they are the first 35 characters of
     * the opening message, so "the paper about honeybees" finds nothing unless
     * those words happened to start the conversation. Each run's search text
     * (`runSearchText`: the question and the model's replies) finds a thread
     * by anything discussed in it — which is what someone looking for a past
     * conversation actually remembers. Threads whose name matches come first.
     */
    public async searchThreadsLocal(
        userId: string,
        query: string,
        limit = 25,
        offset = 0,
        scope: ThreadListScope = {},
    ): Promise<ListedThread[]> {
        const trimmed = query.trim();
        if (!trimmed) {
            if (scope.archived) return this.getArchivedThreads(userId, limit, offset);
            const { threads } = await this.getThreadsPaginated(userId, limit, offset);
            return threads as ListedThread[];
        }
        await this.ensureRunIndex();
        // The backslash is escaped too: with ESCAPE '\' an unescaped one
        // swallows the next character, so "\alpha" would match any "alpha".
        const pattern = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const rows = await this.conn.queryAsync(
            `SELECT t.* FROM threads t
             WHERE t.user_id = ?
               AND ${scope.archived ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL'}
               AND (
                 t.name LIKE ? ESCAPE '\\'
                 OR EXISTS (
                   SELECT 1 FROM agent_runs r
                   WHERE r.thread_id = t.id
                     AND (
                       r.search_text LIKE ? ESCAPE '\\'
                       OR (r.search_text IS NULL AND r.payload LIKE ? ESCAPE '\\')
                     )
                 )
               )
             ORDER BY (t.name LIKE ? ESCAPE '\\') DESC,
                      ${scope.archived ? 't.archived_at' : 't.updated_at'} DESC
             LIMIT ? OFFSET ?`,
            [userId, pattern, pattern, pattern, pattern, limit, offset],
        );
        return (rows ?? []).map((row: any) => BeaverDB.rowToListedThread(row));
    }

    /** Set while this session's one-time index backfill runs, and after it finished. */
    private runIndexReady: Promise<void> | null = null;

    /**
     * Index the runs stored before the search column existed: their search
     * text, and the paper links and highlight anchor each one implies (runs
     * that arrived from another computer never had those).
     *
     * Once per session, the first time a search or a paper lookup needs it.
     * A failure leaves the rest for the next attempt; searches still reach
     * those rows through the payload fallback meanwhile.
     */
    public ensureRunIndex(): Promise<void> {
        if (!this.runIndexReady) {
            this.runIndexReady = this.backfillRunIndex().catch((error) => {
                this.runIndexReady = null;
                Zotero.debug(`BeaverDB.ensureRunIndex: ${error}`);
            });
        }
        return this.runIndexReady;
    }

    private async backfillRunIndex(batchSize = 100): Promise<void> {
        for (;;) {
            const rows = await this.conn.queryAsync(
                `SELECT id, thread_id, payload FROM agent_runs WHERE search_text IS NULL LIMIT ?`,
                [batchSize],
            );
            if (!rows || rows.length === 0) return;
            const batch = rows.map((row: any) => ({
                id: String(row.id),
                threadId: String(row.thread_id),
                payload: String(row.payload ?? ''),
            }));
            // One transaction per batch: a statement-at-a-time backfill of a
            // long history pays a commit per row.
            await this.conn.executeTransaction(async () => {
                for (const row of batch) {
                    let payload: unknown = null;
                    try {
                        payload = JSON.parse(row.payload);
                    } catch {
                        payload = null;
                    }
                    // An unreadable payload gets empty text: it matches
                    // nothing, and is not parsed again every session.
                    await this.conn.queryAsync(
                        `UPDATE agent_runs SET search_text = ? WHERE id = ?`,
                        [payload ? runSearchText(payload) : '', row.id],
                    );
                    if (payload) await this.indexRunLinks(row.threadId, payload);
                }
            });
        }
    }

    /**
     * Record the paper links and highlight anchor a stored run implies.
     *
     * Both only ever add: a link that is already there is kept, and an anchor
     * never displaces one this computer made — a highlight that already opens
     * a conversation here keeps opening that one.
     */
    public async indexRunLinks(threadId: string, run: unknown): Promise<void> {
        await this.recordThreadItems(threadId, itemLinksForRun(run));
        const anchor = anchorLinkForRun(run);
        if (anchor) {
            await this.conn.queryAsync(
                `INSERT OR IGNORE INTO thread_anchors
                    (library_id, annotation_key, thread_id, attachment_key, selected_text, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    anchor.libraryId,
                    anchor.annotationKey,
                    threadId,
                    anchor.attachmentKey,
                    anchor.selectedText,
                    new Date().toISOString(),
                ],
            );
        }
    }

    // --- Highlight-anchored conversations ---

    /** Link a highlight to the conversation started from it. */
    public async saveThreadAnchor(anchor: {
        libraryId: number;
        annotationKey: string;
        threadId: string;
        attachmentKey?: string | null;
        selectedText?: string | null;
    }): Promise<void> {
        await this.conn.queryAsync(
            `INSERT OR REPLACE INTO thread_anchors
                (library_id, annotation_key, thread_id, attachment_key, selected_text, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                anchor.libraryId,
                anchor.annotationKey,
                anchor.threadId,
                anchor.attachmentKey ?? null,
                anchor.selectedText ?? null,
                new Date().toISOString(),
            ],
        );
    }

    /** The conversation started from this highlight, if there is one. */
    public async getThreadAnchor(
        libraryId: number,
        annotationKey: string,
    ): Promise<{ threadId: string; selectedText: string | null } | null> {
        const rows = await this.conn.queryAsync(
            `SELECT thread_id, selected_text FROM thread_anchors
             WHERE library_id = ? AND annotation_key = ?`,
            [libraryId, annotationKey],
        );
        const row = rows?.[0];
        return row ? { threadId: row.thread_id, selectedText: row.selected_text ?? null } : null;
    }

    /** Every anchored conversation in one attachment, newest first. */
    public async getThreadAnchorsForAttachment(
        libraryId: number,
        attachmentKey: string,
    ): Promise<Array<{ annotationKey: string; threadId: string; selectedText: string | null }>> {
        const rows = await this.conn.queryAsync(
            `SELECT annotation_key, thread_id, selected_text FROM thread_anchors
             WHERE library_id = ? AND attachment_key = ? ORDER BY created_at DESC`,
            [libraryId, attachmentKey],
        );
        return (rows ?? []).map((row: any) => ({
            annotationKey: row.annotation_key,
            threadId: row.thread_id,
            selectedText: row.selected_text ?? null,
        }));
    }

    /**
     * Drop the link for a highlight the user deleted.
     *
     * The conversation itself is kept: the transcript is the user's, and losing
     * it to a stray deletion of a highlight would be worse than an orphan row.
     */
    public async deleteThreadAnchor(libraryId: number, annotationKey: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM thread_anchors WHERE library_id = ? AND annotation_key = ?`,
            [libraryId, annotationKey],
        );
    }

    // --- Thread Methods ---

    /**
     * Create a new chat thread.
     * @param user_id The user_id of the thread
     * @param name Optional name for the thread
     * @returns The complete ThreadData for the newly created thread
     */
    public async createThread(user_id: string, name: string = ''): Promise<ThreadData> {
        const id = uuidv4();
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const dbName = name || null; // Convert empty string to null for database
        
        await this.conn.queryAsync(
            `INSERT INTO threads (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [id, user_id, dbName, now, now]
        );
        
        return {
            id,
            name,
            createdAt: now,
            updatedAt: now,
        };
    }

    /**
     * Retrieve a thread by its ID.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to retrieve
     * @returns The ThreadData if found, otherwise null
     */
    /**
     * Make sure a thread a message was just sent in has a row, and that the
     * row is in the active history.
     *
     * The row used to appear only when the first answer finished, because
     * `saveRun` was the first thing to write it — so a conversation was absent
     * from history for as long as it took to answer, measured at fourteen
     * seconds on a short question. This is called when the run starts instead.
     *
     * `INSERT OR IGNORE` rather than an upsert: continuing an existing thread
     * must not reset its `created_at`, and its name is already whatever the
     * user renamed it to. Only its archive state changes. Returns whether the
     * thread was just taken out of the archive.
     */
    public async ensureThread(
        id: string,
        user_id: string,
        name: string,
        created_at: string,
    ): Promise<boolean> {
        if (await this.threadTombstone(user_id, id)) {
            Zotero.debug(`BeaverDB.ensureThread: dropping write to tombstoned thread ${id}`);
            return false;
        }
        await this.conn.queryAsync(
            `INSERT OR IGNORE INTO threads (id, user_id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            [id, user_id, name, created_at, created_at],
        );
        /*
         * A message sent in an archived conversation takes it back out of the
         * archive: a conversation in use belongs in the history, the recent
         * chats and search. Stamped as used now, which is what tells the
         * archive reconcile that this restore is later than the archiving —
         * a sync pass running while the answer streams must not put it back —
         * and the next mirror of the thread carries it to the other computers.
         */
        if (await this.threadArchivedAt(user_id, id)) {
            await this.conn.queryAsync(
                `UPDATE threads SET archived_at = NULL, updated_at = ? WHERE user_id = ? AND id = ?`,
                [new Date().toISOString(), user_id, id],
            );
            return true;
        }
        return false;
    }

    /**
     * Write a thread row as given, timestamps included.
     *
     * `createThread` stamps `now`, and `saveRun` upserts a bare row with no
     * name — neither can restore a thread that was written on another machine,
     * where the created and updated times are the whole basis for deciding
     * which copy is newer.
     */
    public async upsertThread(thread: {
        id: string;
        user_id: string;
        name: string;
        created_at: string;
        updated_at: string;
    }): Promise<void> {
        await this.conn.queryAsync(
            `INSERT INTO threads (id, user_id, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at`,
            [thread.id, thread.user_id, thread.name, thread.created_at, thread.updated_at],
        );
    }

    public async getThread(user_id: string, id: string): Promise<ThreadData | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM threads WHERE user_id = ? AND id = ?`,
            [user_id, id]
        );
        if (rows.length === 0) {
            return null;
        }
        const record = BeaverDB.rowToThreadRecord(rows[0]);
        return BeaverDB.threadRecordToData(record);
    }

    /**
     * Get a paginated list of threads.
     * @param user_id The user_id of the threads
     * @param limit Number of threads per page
     * @param offset Number of threads to skip
     * @returns Object containing an array of ThreadData objects and a boolean indicating if there are more items
     */
    public async getThreadsPaginated(
        user_id: string,
        limit: number,
        offset: number
    ): Promise<{ threads: ListedThread[]; has_more: boolean }> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM threads WHERE user_id = ? AND archived_at IS NULL
             ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
            [user_id, limit + 1, offset]
        );

        const threads = rows
            .slice(0, limit)
            .map((row: any) => BeaverDB.rowToListedThread(row));

        return {
            threads,
            has_more: rows.length > limit,
        };
    }

    /**
     * Delete a thread and all its messages.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to delete
     */
    /**
     * Put a conversation in the archive instead of destroying it.
     *
     * What the delete button does now. The rows in `thread_anchors` and
     * `thread_items` stay: an archived conversation is meant to come back
     * whole, and rebuilding which highlights and papers it referred to is not
     * something the transcript can do.
     */
    public async archiveThread(user_id: string, id: string, at: string): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE threads SET archived_at = ? WHERE user_id = ? AND id = ?`,
            [at, user_id, id],
        );
    }

    /** Take it back out of the archive. */
    public async restoreThread(user_id: string, id: string): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE threads SET archived_at = NULL WHERE user_id = ? AND id = ?`,
            [user_id, id],
        );
    }

    /** Is this conversation archived? Null when there is no such conversation. */
    public async threadArchivedAt(user_id: string, id: string): Promise<string | null | undefined> {
        const rows = await this.conn.queryAsync(
            `SELECT archived_at FROM threads WHERE user_id = ? AND id = ?`,
            [user_id, id],
        );
        if (!rows || rows.length === 0) return undefined;
        return rows[0].archived_at ?? null;
    }

    /**
     * Store or clear the thread's compaction record.
     *
     * The record is what stands in for the summarised runs on the wire; the
     * runs themselves are never touched. Passing null discards the summary,
     * which restores the uncompacted behaviour on the next message.
     */
    public async setThreadCompaction(
        user_id: string,
        id: string,
        compaction: ThreadCompaction | null,
    ): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE threads SET compaction = ? WHERE user_id = ? AND id = ?`,
            [compaction ? JSON.stringify(compaction) : null, user_id, id],
        );
    }

    /**
     * The thread's compaction record. Undefined when there is no such thread,
     * null when it has never been compacted (or the summary was discarded).
     * An unparseable blob reads as null: the wire path must degrade to the
     * uncompacted behaviour, never fail the request over a summary.
     */
    public async threadCompaction(
        user_id: string,
        id: string,
    ): Promise<ThreadCompaction | null | undefined> {
        const rows = await this.conn.queryAsync(
            `SELECT compaction FROM threads WHERE user_id = ? AND id = ?`,
            [user_id, id],
        );
        if (!rows || rows.length === 0) return undefined;
        const raw = rows[0].compaction;
        if (typeof raw !== 'string' || !raw) return null;
        try {
            const parsed = JSON.parse(raw);
            if (
                !parsed || typeof parsed !== 'object'
                || typeof parsed.summary !== 'string'
                || !parsed.summary.trim()
                || typeof parsed.throughRunId !== 'string'
            ) {
                return null;
            }
            /*
             * Normalized on the way out, because this blob can arrive through
             * the sync envelope — another machine's claim, not gospel. An
             * oversized summary would otherwise ride every future request, and
             * a non-numeric runCount would render as "NaN exchanges".
             */
            return {
                summary: parsed.summary.length > 4000
                    ? `${parsed.summary.slice(0, 4000)}…`
                    : parsed.summary,
                throughRunId: parsed.throughRunId,
                createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
                runCount: Number.isFinite(parsed.runCount) && parsed.runCount > 0
                    ? Math.floor(parsed.runCount)
                    : 1,
            };
        } catch {
            return null;
        }
    }

    /** The archive, most recently archived first. */
    public async getArchivedThreads(user_id: string, limit = 200, offset = 0): Promise<ListedThread[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM threads WHERE user_id = ? AND archived_at IS NOT NULL
             ORDER BY archived_at DESC LIMIT ? OFFSET ?`,
            [user_id, limit, offset],
        );
        return (rows ?? []).map((row: any) => BeaverDB.rowToListedThread(row));
    }

    public async deleteThread(user_id: string, id: string): Promise<void> {
        // The two tables this plugin added carry no foreign key, so deleting the
        // thread left them behind: an anchor still claiming a highlight belongs
        // to a conversation that no longer exists (clicking it would try to open
        // a dead thread), and item links still naming it under "conversations
        // about this paper". Removed first — if the thread delete then fails,
        // the rows are gone but the thread is intact, which is recoverable;
        // the other order leaves the mess with nothing pointing at it.
        await this.conn.queryAsync(`DELETE FROM thread_anchors WHERE thread_id = ?`, [id]);
        await this.conn.queryAsync(`DELETE FROM thread_items WHERE thread_id = ?`, [id]);
        await this.conn.queryAsync(
            `DELETE FROM threads WHERE user_id = ? AND id = ?`,
            [user_id, id]
        );
    }

    /**
     * Record that a thread was permanently deleted at the given time.
     *
     * Written BEFORE the row delete, so a detached write racing the deletion
     * hits the saveRun/setThreadName/ensureThread guards instead of quietly
     * recreating the thread.
     */
    public async addThreadTombstone(
        user_id: string,
        thread_id: string,
        deleted_at: string,
    ): Promise<void> {
        await this.conn.queryAsync(
            `INSERT INTO thread_tombstones (thread_id, user_id, deleted_at)
             VALUES (?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET
                deleted_at = MAX(deleted_at, excluded.deleted_at),
                user_id = excluded.user_id`,
            [thread_id, user_id, deleted_at],
        );
    }

    /** The deletion time for a tombstoned thread, or null if it has none. */
    public async threadTombstone(user_id: string, thread_id: string): Promise<string | null> {
        const rows = await this.conn.queryAsync(
            `SELECT deleted_at FROM thread_tombstones WHERE user_id = ? AND thread_id = ?`,
            [user_id, thread_id],
        );
        return rows.length > 0 ? String(rows[0].deleted_at) : null;
    }

    /** All tombstones for a user, for merging into the sync ledger. */
    public async threadTombstones(
        user_id: string,
    ): Promise<Array<{ thread_id: string; deleted_at: string }>> {
        const rows = await this.conn.queryAsync(
            `SELECT thread_id, deleted_at FROM thread_tombstones WHERE user_id = ?`,
            [user_id],
        );
        return (rows ?? []).map((row: any) => ({
            thread_id: String(row.thread_id),
            deleted_at: String(row.deleted_at),
        }));
    }

    /**
     * Drop a tombstone. Used when a copy of the thread edited AFTER the
     * deletion arrives — the newer edit wins and the thread revives.
     */
    public async removeThreadTombstone(user_id: string, thread_id: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM thread_tombstones WHERE user_id = ? AND thread_id = ?`,
            [user_id, thread_id],
        );
    }

    /**
     * Rename a thread.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to rename
     * @param name The new name for the thread
     */
    public async renameThread(user_id: string, id: string, name: string): Promise<void> {
        await this.conn.queryAsync(
            // ISO with a zone, like every other thread-timestamp writer: the
            // sync LWW compares these strings across machines, and SQLite's
            // naive `datetime('now')` reads as LOCAL time in Date.parse.
            `UPDATE threads SET name = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
            [name, new Date().toISOString(), user_id, id]
        );
    }

    /**
     * Update a thread. Currently only supports renaming.
     * @param user_id The user_id of the thread
     * @param id The ID of the thread to update
     * @param updates An object containing the fields to update (using ThreadData format)
     */
    public async updateThread(
        user_id: string,
        id: string,
        updates: Partial<Omit<ThreadData, 'id' | 'createdAt'>>
    ): Promise<void> {
        const fieldsToUpdate: string[] = [];
        const values: any[] = [];

        if (updates.name !== undefined) {
            fieldsToUpdate.push('name = ?');
            values.push(updates.name || null); // Convert empty string to null for database
        }

        if (updates.updatedAt !== undefined) {
            fieldsToUpdate.push('updated_at = ?');
            values.push(updates.updatedAt);
        } else if (fieldsToUpdate.length > 0) {
            // Auto-update updated_at if we're making other changes
            fieldsToUpdate.push('updated_at = ?');
            values.push(new Date().toISOString());
        }

        if (fieldsToUpdate.length === 0) {
            return; // Nothing to update
        }

        values.push(user_id, id);
        
        await this.conn.queryAsync(
            `UPDATE threads SET ${fieldsToUpdate.join(', ')} WHERE user_id = ? AND id = ?`,
            values
        );
    }

    // --- Sync Logs Methods ---

    /**
     * Insert a new sync log record.
     * @param syncLog The sync log data to insert (without id, which will be generated)
     * @returns The complete SyncLogsRecord with generated id
     */
    public async insertSyncLog(syncLog: Omit<SyncLogsRecord, 'id' | 'timestamp'>): Promise<SyncLogsRecord> {
        // Validate required fields
        const requiredFields = ['session_id', 'user_id', 'sync_type', 'method', 'zotero_local_id', 'library_id', 'library_version', 'library_date_modified'] as const;
        for (const field of requiredFields) {
            if (syncLog[field] === undefined || syncLog[field] === null) {
                throw new Error(`insertSyncLog: Required field '${field}' is ${syncLog[field]}. Full syncLog: ${JSON.stringify(syncLog)}`);
            }
        }
        
        const id = uuidv4();
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        await this.conn.queryAsync(
            `INSERT INTO sync_logs (id, session_id, user_id, sync_type, method, zotero_local_id, zotero_user_id, library_id, total_upserts, total_deletions, library_version, library_date_modified, timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                syncLog.session_id,
                syncLog.user_id,
                syncLog.sync_type,
                syncLog.method,
                syncLog.zotero_local_id,
                syncLog.zotero_user_id ?? null,
                syncLog.library_id,
                syncLog.total_upserts,
                syncLog.total_deletions,
                syncLog.library_version,
                syncLog.library_date_modified,
                now
            ]
        );
        
        return {
            id,
            ...syncLog,
            timestamp: now,
        };
    }

    /**
     * Get sync log record for library_id and user_id with the highest library_version.
     * @param user_id The user_id to filter by
     * @param library_id The library_id to filter by
     * @returns The SyncLogsRecord with highest library_version, or null if not found
     */
    public async getSyncLogWithHighestVersion(user_id: string, library_id: number): Promise<SyncLogsRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs 
             WHERE user_id = ? AND library_id = ? 
             ORDER BY library_version DESC 
             LIMIT 1`,
            [user_id, library_id]
        );
        
        if (rows.length === 0) {
            return null;
        }
        
        return BeaverDB.rowToSyncLogsRecord(rows[0]);
    }

    /**
     * Get sync log record for library_id and user_id with the most recent library_date_modified.
     * @param user_id The user_id to filter by
     * @param library_id The library_id to filter by
     * @returns The SyncLogsRecord with most recent library_date_modified, or null if not found
     */
    public async getSyncLogWithMostRecentDate(user_id: string, library_id: number): Promise<SyncLogsRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs 
             WHERE user_id = ? AND library_id = ? 
             ORDER BY library_date_modified DESC 
             LIMIT 1`,
            [user_id, library_id]
        );
        
        if (rows.length === 0) {
            return null;
        }
        
        return BeaverDB.rowToSyncLogsRecord(rows[0]);
    }

    /**
     * Get all sync log records for specific library_id and user_id.
     * @param user_id The user_id to filter by
     * @param library_id The library_id to filter by
     * @param orderBy Optional ordering field ('timestamp', 'library_version', 'library_date_modified')
     * @param orderDirection Optional order direction ('ASC' or 'DESC')
     * @returns Array of SyncLogsRecord objects
     */
    public async getAllSyncLogsForLibrary(
        user_id: string, 
        library_id: number,
        orderBy: 'timestamp' | 'library_version' | 'library_date_modified' = 'timestamp',
        orderDirection: 'ASC' | 'DESC' = 'DESC'
    ): Promise<SyncLogsRecord[]> {
        const validOrderBy = ['timestamp', 'library_version', 'library_date_modified'];
        const validDirection = ['ASC', 'DESC'];
        
        if (!validOrderBy.includes(orderBy)) {
            throw new Error(`Invalid orderBy field: ${orderBy}`);
        }
        
        if (!validDirection.includes(orderDirection)) {
            throw new Error(`Invalid order direction: ${orderDirection}`);
        }
        
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs 
             WHERE user_id = ? AND library_id = ? 
             ORDER BY ${orderBy} ${orderDirection}`,
            [user_id, library_id]
        );
        
        return rows.map((row: any) => BeaverDB.rowToSyncLogsRecord(row));
    }

    public async getMostRecentSyncLogForLibraries(user_id: string, library_ids: number[]): Promise<SyncLogsRecord | null> {
        if (!library_ids || library_ids.length === 0) return null;

        const placeholders = library_ids.map(() => '?').join(',');
        const rows = await this.conn.queryAsync(
            `SELECT * FROM sync_logs
             WHERE user_id = ? AND library_id IN (${placeholders})
             ORDER BY timestamp DESC
             LIMIT 1`,
            [user_id, ...library_ids]
        );

        if (rows.length === 0) {
            return null;
        }
        return BeaverDB.rowToSyncLogsRecord(rows[0]);
    }

    /**
     * Deletes all sync log records for a specific library.
     * @param user_id The user_id to filter by
     * @param library_ids The library_ids to delete logs for
     */
    public async deleteSyncLogsForLibraryIds(user_id: string, library_ids: number[]): Promise<void> {
        if (library_ids.length === 0) {
            return;
        }

        const placeholders = library_ids.map(() => '?').join(',');
        await this.conn.queryAsync(
            `DELETE FROM sync_logs WHERE user_id = ? AND library_id IN (${placeholders})`,
            [user_id, ...library_ids]
        );
    }

    /**
     * Deletes all sync log records for a user.
     * Used during onboarding to ensure fresh sync state (e.g., after plan transitions).
     * @param user_id The user_id to delete logs for
     */
    public async deleteAllSyncLogsForUser(user_id: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM sync_logs WHERE user_id = ?`,
            [user_id]
        );
    }

    // --- Embedding Methods ---

    /**
     * Helper method to construct EmbeddingRecord from a database row
     */
    private static rowToEmbeddingRecord(row: any): EmbeddingRecord {
        return {
            item_id: row.item_id,
            library_id: row.library_id,
            zotero_key: row.zotero_key,
            version: row.version,
            client_date_modified: row.client_date_modified,
            content_hash: row.content_hash,
            embedding: new Uint8Array(row.embedding),
            dimensions: row.dimensions,
            model_id: row.model_id,
            indexed_at: row.indexed_at,
        };
    }

    /**
     * Convert Int8Array embedding to Uint8Array for BLOB storage.
     * SQLite stores BLOBs as raw bytes; Int8Array and Uint8Array share the same buffer layout.
     */
    public static embeddingToBlob(embedding: Int8Array): Uint8Array {
        return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    }

    /**
     * Convert BLOB (Uint8Array) back to Int8Array for similarity computation.
     */
    public static blobToEmbedding(blob: Uint8Array): Int8Array {
        return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    }

    /**
     * Compute a hash for content change detection.
     * Uses a simple but fast DJB2-style hash suitable for detecting text changes.
     * @param text The text content to hash (title + abstract)
     * @returns Hash string
     */
    public static computeContentHash(text: string): string {
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            const char = text.charCodeAt(i);
            hash = ((hash << 5) + hash) ^ char;
        }
        // Convert to unsigned 32-bit and then to base36 for compact representation
        return (hash >>> 0).toString(36);
    }

    /**
     * Insert or update an embedding record.
     * @param embedding The embedding data to store
     */
    public async upsertEmbedding(embedding: Omit<EmbeddingRecord, 'indexed_at'> & { indexed_at?: string }): Promise<void> {
        const now = embedding.indexed_at || new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        await this.conn.queryAsync(
            `INSERT OR REPLACE INTO embeddings 
             (item_id, library_id, zotero_key, version, client_date_modified, 
              content_hash, embedding, dimensions, model_id, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                embedding.item_id,
                embedding.library_id,
                embedding.zotero_key,
                embedding.version,
                embedding.client_date_modified,
                embedding.content_hash,
                embedding.embedding,
                embedding.dimensions,
                embedding.model_id,
                now
            ]
        );
    }

    /**
     * Insert or update multiple embedding records in a batch.
     * @param embeddings Array of embedding data to store
     */
    public async upsertEmbeddingsBatch(embeddings: Array<Omit<EmbeddingRecord, 'indexed_at'> & { indexed_at?: string }>): Promise<void> {
        if (embeddings.length === 0) return;

        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

        // Use a transaction for batch insert
        await this.conn.executeTransaction(async () => {
            for (const embedding of embeddings) {
                const indexedAt = embedding.indexed_at || now;
                await this.conn.queryAsync(
                    `INSERT OR REPLACE INTO embeddings 
                     (item_id, library_id, zotero_key, version, client_date_modified, 
                      content_hash, embedding, dimensions, model_id, indexed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        embedding.item_id,
                        embedding.library_id,
                        embedding.zotero_key,
                        embedding.version,
                        embedding.client_date_modified,
                        embedding.content_hash,
                        embedding.embedding,
                        embedding.dimensions,
                        embedding.model_id,
                        indexedAt
                    ]
                );
            }
        });
    }

    /**
     * Get an embedding record by item ID.
     * @param itemId The Zotero item ID
     * @returns The embedding record or null if not found
     */
    public async getEmbedding(itemId: number, modelId?: string): Promise<EmbeddingRecord | null> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings WHERE item_id = ?${modelId ? ' AND model_id = ?' : ''}`,
            modelId ? [itemId, modelId] : [itemId]
        );
        
        if (rows.length === 0) {
            return null;
        }
        
        return BeaverDB.rowToEmbeddingRecord(rows[0]);
    }

    /**
     * Get embedding records for multiple item IDs.
     * @param itemIds Array of Zotero item IDs
     * @returns Map of item ID to embedding record
     */
    public async getEmbeddingsBatch(itemIds: number[], modelId?: string): Promise<Map<number, EmbeddingRecord>> {
        if (itemIds.length === 0) return new Map();

        const result = new Map<number, EmbeddingRecord>();
        const chunkSize = 500;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            
            const rows = await this.conn.queryAsync(
                `SELECT * FROM embeddings WHERE item_id IN (${placeholders})${modelId ? ' AND model_id = ?' : ''}`,
                modelId ? [...chunk, modelId] : chunk
            );
            
            for (const row of rows) {
                result.set(row.item_id, BeaverDB.rowToEmbeddingRecord(row));
            }
        }

        return result;
    }

    /**
     * Get all embeddings for a library.
     * @param libraryId The Zotero library ID
     * @returns Array of embedding records
     */
    public async getEmbeddingsByLibrary(libraryId: number, modelId?: string): Promise<EmbeddingRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings WHERE library_id = ?${modelId ? ' AND model_id = ?' : ''}`,
            modelId ? [libraryId, modelId] : [libraryId]
        );
        
        return rows.map((row: any) => BeaverDB.rowToEmbeddingRecord(row));
    }

    /**
     * Get all embeddings across all libraries.
     * @returns Array of embedding records
     */
    public async getAllEmbeddings(modelId?: string): Promise<EmbeddingRecord[]> {
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings${modelId ? ' WHERE model_id = ?' : ''} ORDER BY library_id, item_id`,
            modelId ? [modelId] : []
        );
        
        return rows.map((row: any) => BeaverDB.rowToEmbeddingRecord(row));
    }

    /**
     * Get embeddings for multiple libraries.
     * @param libraryIds Array of library IDs
     * @returns Array of embedding records
     */
    public async getEmbeddingsByLibraries(libraryIds: number[], modelId?: string): Promise<EmbeddingRecord[]> {
        if (libraryIds.length === 0) return [];
        const placeholders = libraryIds.map(() => '?').join(',');
        const rows = await this.conn.queryAsync(
            `SELECT * FROM embeddings WHERE library_id IN (${placeholders})${modelId ? ' AND model_id = ?' : ''}`,
            modelId ? [...libraryIds, modelId] : libraryIds
        );
        
        return rows.map((row: any) => BeaverDB.rowToEmbeddingRecord(row));
    }

    /**
     * Get embeddings restricted to a set of item IDs, optionally also restricted to libraries.
     * @param itemIds Array of Zotero item IDs; an empty array returns no results
     * @param libraryIds Optional array of library IDs to additionally restrict results;
     *                   an empty array returns no results
     * @returns Array of embedding records
     */
    public async getEmbeddingsByItemIds(itemIds: number[], libraryIds?: number[], modelId?: string): Promise<EmbeddingRecord[]> {
        if (itemIds.length === 0) return [];
        if (libraryIds && libraryIds.length === 0) return [];

        const libraryFilter = libraryIds ?? [];

        // SQLite rejects statements over MAX_BOUND_PARAMS parameters, and the
        // library IDs share that budget with the item IDs. A library filter too
        // large to leave room for a useful item chunk is applied in JS instead.
        const MAX_BOUND_PARAMS = 999;
        const modelParams = modelId ? 1 : 0; // the model shares the budget too
        const filterInSql = libraryFilter.length > 0 && libraryFilter.length * 2 + modelParams <= MAX_BOUND_PARAMS;
        const chunkSize = MAX_BOUND_PARAMS - modelParams - (filterInSql ? libraryFilter.length : 0);
        const libraryPlaceholders = libraryFilter.map(() => '?').join(',');
        const modelClause = modelId ? ' AND model_id = ?' : '';

        const records: EmbeddingRecord[] = [];
        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const itemPlaceholders = chunk.map(() => '?').join(',');
            const sql = filterInSql
                ? `SELECT * FROM embeddings WHERE library_id IN (${libraryPlaceholders}) AND item_id IN (${itemPlaceholders})${modelClause}`
                : `SELECT * FROM embeddings WHERE item_id IN (${itemPlaceholders})${modelClause}`;
            const params: any[] = filterInSql ? [...libraryFilter, ...chunk] : [...chunk];
            if (modelId) params.push(modelId);
            const rows = await this.conn.queryAsync(sql, params);
            records.push(...rows.map((row: any) => BeaverDB.rowToEmbeddingRecord(row)));
        }

        if (!filterInSql && libraryFilter.length > 0) {
            const allowed = new Set(libraryFilter);
            return records.filter(record => allowed.has(record.library_id));
        }

        return records;
    }

    /**
     * Get content hashes for items to check what needs re-indexing.
     * @param itemIds Array of Zotero item IDs
     * @returns Map of item ID to content hash
     */
    public async getContentHashes(
        itemIds: number[],
        modelId?: string,
    ): Promise<Map<number, string>> {
        if (itemIds.length === 0) return new Map();

        const result = new Map<number, string>();
        const chunkSize = 500;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');

            // A vector from a different model is as stale as one from changed
            // text: the two are not comparable, so a query that returned it
            // would report the item as up to date and its old vector would sit
            // in the index for ever. Filtering here rather than at each caller
            // means every path that asks "does this need re-indexing" gets the
            // same answer.
            const rows = await this.conn.queryAsync(
                `SELECT item_id, content_hash FROM embeddings WHERE item_id IN (${placeholders})${
                    modelId ? ' AND model_id = ?' : ''
                }`,
                modelId ? [...chunk, modelId] : chunk
            );
            
            for (const row of rows) {
                result.set(row.item_id, row.content_hash);
            }
        }

        return result;
    }

    /**
     * Delete an embedding by item ID.
     * @param itemId The Zotero item ID
     */
    public async deleteEmbedding(itemId: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM embeddings WHERE item_id = ?`,
            [itemId]
        );
    }

    /**
     * Delete embeddings for multiple item IDs.
     * @param itemIds Array of Zotero item IDs
     */
    public async deleteEmbeddingsBatch(itemIds: number[]): Promise<void> {
        if (itemIds.length === 0) return;

        const chunkSize = 500;
        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            await this.conn.queryAsync(
                `DELETE FROM embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
        }
    }

    /**
     * Delete all embeddings for a library.
     * @param libraryId The Zotero library ID
     */
    public async deleteEmbeddingsByLibrary(libraryId: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM embeddings WHERE library_id = ?`,
            [libraryId]
        );
    }

    /**
     * Get the count of embeddings for a library.
     * @param libraryId The Zotero library ID
     * @returns Number of embeddings
     */
    public async getEmbeddingCount(libraryId?: number, modelId?: string): Promise<number> {
        let sql = 'SELECT COUNT(*) as count FROM embeddings';
        const params: any[] = [];
        const where: string[] = [];
        if (libraryId !== undefined) {
            where.push('library_id = ?');
            params.push(libraryId);
        }
        if (modelId) {
            where.push('model_id = ?');
            params.push(modelId);
        }
        if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;

        const rows = await this.conn.queryAsync(sql, params);
        return rows[0]?.count || 0;
    }

    /**
     * Get item IDs that have embeddings in a library.
     * @param libraryId The Zotero library ID
     * @returns Array of item IDs
     */
    public async getEmbeddedItemIds(libraryId?: number, modelId?: string): Promise<number[]> {
        let sql = 'SELECT DISTINCT item_id FROM embeddings';
        const params: any[] = [];
        const where: string[] = [];
        if (libraryId !== undefined) {
            where.push('library_id = ?');
            params.push(libraryId);
        }
        if (modelId) {
            where.push('model_id = ?');
            params.push(modelId);
        }
        if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;

        const rows = await this.conn.queryAsync(sql, params);
        return rows.map((row: any) => row.item_id);
    }

    /**
     * Get distinct library IDs that have embeddings.
     * Used to find libraries that may need cleanup when sync settings change.
     * @returns Array of library IDs
     */
    public async getEmbeddedLibraryIds(): Promise<number[]> {
        const rows = await this.conn.queryAsync(
            'SELECT DISTINCT library_id FROM embeddings'
        );
        return rows.map((row: any) => row.library_id);
    }

    /**
     * Get all content hashes for embeddings, optionally filtered by library.
     * More efficient than getContentHashes for full-database scans.
     * @param libraryId Optional library ID to filter by
     * @returns Map of item ID to content hash
     */
    public async getEmbeddingContentHashMap(
        libraryId?: number,
        modelId?: string,
    ): Promise<Map<number, string>> {
        let sql = 'SELECT item_id, content_hash FROM embeddings';
        const params: any[] = [];
        const where: string[] = [];

        if (libraryId !== undefined) {
            where.push('library_id = ?');
            params.push(libraryId);
        }
        // See getContentHashes: a vector from another model does not count as
        // an index entry.
        if (modelId) {
            where.push('model_id = ?');
            params.push(modelId);
        }
        if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;

        const rows = await this.conn.queryAsync(sql, params);
        const result = new Map<number, string>();
        
        for (const row of rows) {
            result.set(row.item_id, row.content_hash);
        }

        return result;
    }

    // =============================================
    // Embedding Index State Methods
    // =============================================

    /**
     * Get the embedding index state for a library.
     * @param libraryId The Zotero library ID
     * @returns The state record or null if not found
     */
    public async getEmbeddingIndexState(libraryId: number, modelId: string): Promise<EmbeddingIndexStateRecord | null> {
        const sql = 'SELECT * FROM embedding_index_state WHERE library_id = ? AND model_id = ?';
        const rows = await this.conn.queryAsync(sql, [libraryId, modelId]);
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            library_id: row.library_id,
            model_id: row.model_id,
            last_scan_timestamp: row.last_scan_timestamp,
            max_client_date_modified: row.max_client_date_modified,
            item_count: row.item_count,
            embedding_count: row.embedding_count,
        };
    }

    /**
     * Update the embedding index state for a library.
     * @param state The state to save
     */
    public async upsertEmbeddingIndexState(state: EmbeddingIndexStateRecord): Promise<void> {
        const sql = `
            INSERT INTO embedding_index_state
                (library_id, model_id, last_scan_timestamp, max_client_date_modified, item_count, embedding_count)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(library_id, model_id) DO UPDATE SET
                last_scan_timestamp = excluded.last_scan_timestamp,
                max_client_date_modified = excluded.max_client_date_modified,
                item_count = excluded.item_count,
                embedding_count = excluded.embedding_count
        `;
        
        await this.conn.queryAsync(sql, [
            state.library_id,
            state.model_id,
            state.last_scan_timestamp,
            state.max_client_date_modified,
            state.item_count,
            state.embedding_count,
        ]);
    }

    /**
     * Delete the embedding index state for a library.
     * @param libraryId The Zotero library ID
     */
    public async deleteEmbeddingIndexState(libraryId: number, modelId?: string): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM embedding_index_state WHERE library_id = ?${modelId ? ' AND model_id = ?' : ''}`,
            modelId ? [libraryId, modelId] : [libraryId]
        );
    }

    /**
     * Get MAX(client_date_modified) from embeddings for a library.
     * @param libraryId The Zotero library ID
     * @returns The max date or null if no embeddings exist
     */
    public async getEmbeddingsMaxClientDateModified(libraryId: number, modelId?: string): Promise<string | null> {
        const sql = `SELECT MAX(client_date_modified) as max_date FROM embeddings WHERE library_id = ?${modelId ? ' AND model_id = ?' : ''}`;
        const rows = await this.conn.queryAsync(sql, modelId ? [libraryId, modelId] : [libraryId]);
        return rows[0]?.max_date || null;
    }

    // =============================================
    // Failed Embeddings Methods
    // =============================================

    /**
     * Helper method to construct FailedEmbeddingRecord from a database row
     */
    private static rowToFailedEmbeddingRecord(row: any): FailedEmbeddingRecord {
        return {
            item_id: row.item_id,
            library_id: row.library_id,
            failure_count: row.failure_count,
            last_error: row.last_error,
            last_attempt: row.last_attempt,
            next_retry_after: row.next_retry_after,
        };
    }

    /**
     * Calculate the next retry time based on failure count.
     * Uses exponential backoff: 1h, 2h, 4h, 8h, 16h
     * @param failureCount Number of consecutive failures
     * @returns ISO string of next retry time
     */
    private static calculateNextRetryTime(failureCount: number): string {
        const delayMs = EMBEDDING_RETRY_BASE_DELAY_MS * Math.pow(2, failureCount - 1);
        const nextRetry = new Date(Date.now() + delayMs);
        return nextRetry.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }

    /**
     * Record a failed embedding attempt for an item.
     * If the item already has failures, increments the counter.
     * @param itemId The Zotero item ID
     * @param libraryId The Zotero library ID
     * @param error The error message
     */
    public async recordFailedEmbedding(itemId: number, libraryId: number, error: string): Promise<void> {
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        // Check if already exists
        const existing = await this.getFailedEmbedding(itemId);
        
        if (existing) {
            // Increment failure count
            const newFailureCount = existing.failure_count + 1;
            const nextRetry = BeaverDB.calculateNextRetryTime(newFailureCount);
            
            await this.conn.queryAsync(
                `UPDATE failed_embeddings 
                 SET failure_count = ?, last_error = ?, last_attempt = ?, next_retry_after = ?
                 WHERE item_id = ?`,
                [newFailureCount, error, now, nextRetry, itemId]
            );
        } else {
            // Insert new record
            const nextRetry = BeaverDB.calculateNextRetryTime(1);
            
            await this.conn.queryAsync(
                `INSERT INTO failed_embeddings 
                 (item_id, library_id, failure_count, last_error, last_attempt, next_retry_after)
                 VALUES (?, ?, 1, ?, ?, ?)`,
                [itemId, libraryId, error, now, nextRetry]
            );
        }
    }

    /**
     * Record multiple failed embedding attempts in a batch.
     * @param items Array of {itemId, libraryId} pairs
     * @param error The error message (same for all items in batch)
     * @param options.incrementExisting When true (default), existing rows have
     *   their failure_count bumped and next_retry_after pushed out per the
     *   exponential backoff schedule. Use this for "real" failures from the
     *   API or upsert path. When false, existing rows only refresh last_attempt
     *   and last_error, and new rows are inserted in an immediately retryable
     *   state so transient local failures do not start a backoff window.
     */
    public async recordFailedEmbeddingsBatch(
        items: Array<{ itemId: number; libraryId: number }>,
        error: string,
        options: { incrementExisting?: boolean } = {}
    ): Promise<void> {
        if (items.length === 0) return;

        const { incrementExisting = true } = options;

        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const itemIds = items.map(i => i.itemId);

        // Get existing failed records
        const existing = await this.getFailedEmbeddingsBatch(itemIds);
        const existingMap = new Map(existing.map(r => [r.item_id, r]));

        await this.conn.executeTransaction(async () => {
            for (const item of items) {
                const existingRecord = existingMap.get(item.itemId);

                if (existingRecord) {
                    if (incrementExisting) {
                        const newFailureCount = existingRecord.failure_count + 1;
                        const nextRetry = BeaverDB.calculateNextRetryTime(newFailureCount);

                        await this.conn.queryAsync(
                            `UPDATE failed_embeddings
                             SET failure_count = ?, last_error = ?, last_attempt = ?, next_retry_after = ?
                             WHERE item_id = ?`,
                            [newFailureCount, error, now, nextRetry, item.itemId]
                        );
                    } else {
                        // Transient mode: refresh diagnostics but preserve the
                        // existing failure_count and retry schedule. This keeps
                        // healthy items from being escalated toward permanent
                        // failure on a string of local DB errors.
                        await this.conn.queryAsync(
                            `UPDATE failed_embeddings
                             SET last_error = ?, last_attempt = ?
                             WHERE item_id = ?`,
                            [error, now, item.itemId]
                        );
                    }
                } else {
                    await this.conn.queryAsync(
                        `INSERT INTO failed_embeddings
                         (item_id, library_id, failure_count, last_error, last_attempt, next_retry_after)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            item.itemId,
                            item.libraryId,
                            incrementExisting ? 1 : 0,
                            error,
                            now,
                            incrementExisting ? BeaverDB.calculateNextRetryTime(1) : now,
                        ]
                    );
                }
            }
        });
    }

    /**
     * Get a failed embedding record by item ID.
     * @param itemId The Zotero item ID
     * @returns The failed embedding record or null
     */
    public async getFailedEmbedding(itemId: number): Promise<FailedEmbeddingRecord | null> {
        const rows = await this.conn.queryAsync(
            'SELECT * FROM failed_embeddings WHERE item_id = ?',
            [itemId]
        );
        
        if (rows.length === 0) return null;
        return BeaverDB.rowToFailedEmbeddingRecord(rows[0]);
    }

    /**
     * Get failed embedding records for multiple item IDs.
     * @param itemIds Array of Zotero item IDs
     * @returns Array of failed embedding records
     */
    public async getFailedEmbeddingsBatch(itemIds: number[]): Promise<FailedEmbeddingRecord[]> {
        if (itemIds.length === 0) return [];

        const results: FailedEmbeddingRecord[] = [];
        const chunkSize = 500;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            
            const rows = await this.conn.queryAsync(
                `SELECT * FROM failed_embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
            
            for (const row of rows) {
                results.push(BeaverDB.rowToFailedEmbeddingRecord(row));
            }
        }

        return results;
    }

    /**
     * Get all items that are ready for retry.
     * Returns items where next_retry_after < now AND failure_count < MAX_EMBEDDING_FAILURES.
     * @param libraryId Optional library ID to filter by
     * @returns Array of item IDs ready for retry
     */
    public async getItemsReadyForRetry(libraryId?: number): Promise<number[]> {
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        
        let sql = `SELECT item_id FROM failed_embeddings 
                   WHERE next_retry_after <= ? AND failure_count < ?`;
        const params: any[] = [now, MAX_EMBEDDING_FAILURES];
        
        if (libraryId !== undefined) {
            sql += ' AND library_id = ?';
            params.push(libraryId);
        }
        
        const rows = await this.conn.queryAsync(sql, params);
        return rows.map((row: any) => row.item_id);
    }

    /**
     * Get all permanently failed items (failure_count >= MAX_EMBEDDING_FAILURES).
     * @param libraryId Optional library ID to filter by
     * @returns Array of failed embedding records
     */
    public async getPermanentlyFailedItems(libraryId?: number): Promise<FailedEmbeddingRecord[]> {
        let sql = `SELECT * FROM failed_embeddings WHERE failure_count >= ?`;
        const params: any[] = [MAX_EMBEDDING_FAILURES];
        
        if (libraryId !== undefined) {
            sql += ' AND library_id = ?';
            params.push(libraryId);
        }
        
        const rows = await this.conn.queryAsync(sql, params);
        return rows.map((row: any) => BeaverDB.rowToFailedEmbeddingRecord(row));
    }

    /**
     * Remove a failed embedding record (call after successful indexing).
     * @param itemId The Zotero item ID
     */
    public async removeFailedEmbedding(itemId: number): Promise<void> {
        await this.conn.queryAsync(
            'DELETE FROM failed_embeddings WHERE item_id = ?',
            [itemId]
        );
    }

    /**
     * Remove multiple failed embedding records in a batch.
     * @param itemIds Array of Zotero item IDs
     */
    public async removeFailedEmbeddingsBatch(itemIds: number[]): Promise<void> {
        if (itemIds.length === 0) return;

        const chunkSize = 500;
        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            await this.conn.queryAsync(
                `DELETE FROM failed_embeddings WHERE item_id IN (${placeholders})`,
                chunk
            );
        }
    }

    /**
     * Delete all failed embedding records for a library.
     * @param libraryId The Zotero library ID
     */
    public async deleteFailedEmbeddingsByLibrary(libraryId: number): Promise<void> {
        await this.conn.queryAsync(
            'DELETE FROM failed_embeddings WHERE library_id = ?',
            [libraryId]
        );
    }

    /**
     * Remove failed embedding records for items that no longer exist.
     * @param itemIds Array of item IDs that should be removed
     */
    public async cleanupDeletedFailedEmbeddings(itemIds: number[]): Promise<void> {
        await this.removeFailedEmbeddingsBatch(itemIds);
    }

    /**
     * Get count of failed embeddings.
     * @param libraryId Optional library ID to filter by
     * @returns Number of failed embedding records
     */
    public async getFailedEmbeddingCount(libraryId?: number): Promise<number> {
        let sql = 'SELECT COUNT(*) as count FROM failed_embeddings';
        const params: any[] = [];

        if (libraryId !== undefined) {
            sql += ' WHERE library_id = ?';
            params.push(libraryId);
        }

        const rows = await this.conn.queryAsync(sql, params);
        return rows[0]?.count || 0;
    }

    // =============================================
    // Document Cache Methods
    // =============================================

    private static normalizeDocumentCacheContentKind(value: unknown): ExtractContentKind {
        return typeof value === 'string' && isExtractContentKind(value)
            ? value
            : 'snapshot';
    }

    private static rowToDocumentCacheMetadataRecord(row: any): DocumentCacheMetadataRecord {
        const contentKind = BeaverDB.normalizeDocumentCacheContentKind(row.content_kind);
        const documentMetadata = parseCachedDocumentMetadata(
            row.content_kind,
            row.document_metadata_json,
        );
        const pdfMetadata = documentMetadata?.content_kind === 'pdf'
            ? documentMetadata
            : null;
        return {
            id: row.id,
            itemId: row.item_id,
            libraryId: row.library_id,
            zoteroKey: row.zotero_key,
            contentKind,
            filePath: row.file_path,
            fileSignature: {
                mtime_ms: row.file_mtime_ms,
                size_bytes: row.file_size_bytes,
            },
            sourceSizeBytes: row.source_size_bytes,
            contentType: row.content_type,
            documentMetadata,
            pageCount: pdfMetadata?.pageCount ?? null,
            pageLabels: pdfMetadata?.pageLabels ?? null,
            pages: pdfMetadata?.pages ?? null,
            errorCode: row.error_code ?? null,
            extractionSchemaVersion: row.extraction_schema_version,
            metadataFormatVersion: row.metadata_format_version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastAccessedAt: row.last_accessed_at ?? null,
        };
    }

    private static rowToDocumentCachePayloadRecord(row: any): DocumentCachePayloadRecord {
        return {
            id: row.id,
            metadataId: row.metadata_id,
            itemId: row.item_id,
            libraryId: row.library_id,
            zoteroKey: row.zotero_key,
            payloadKind: row.payload_kind,
            contentKind: BeaverDB.normalizeDocumentCacheContentKind(row.content_kind),
            sourceFilePath: row.source_file_path,
            sourceFileSignature: {
                mtime_ms: row.source_file_mtime_ms,
                size_bytes: row.source_file_size_bytes,
            },
            sourceSizeBytes: row.source_size_bytes,
            payloadPath: row.payload_path,
            payloadSizeBytes: row.payload_size_bytes,
            payloadSha256: row.payload_sha256 ?? null,
            extractionSchemaVersion: row.extraction_schema_version,
            cacheFormatVersion: row.cache_format_version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastAccessedAt: row.last_accessed_at ?? null,
        };
    }

    /** Detect document-cache tables whose schema does not match the current shape. */
    private async documentCacheSchemaIsStale(): Promise<boolean> {
        const metadataColumns = new Set<string>();
        await this.conn.queryAsync(
            `SELECT name FROM pragma_table_info('document_cache_metadata')`,
            [],
            { onRow: (row: any) => metadataColumns.add(row.getResultByIndex(0)) },
        );
        if (metadataColumns.size > 0) {
            if (!metadataColumns.has('content_kind')) return true;
            if (!metadataColumns.has('document_metadata_json')) return true;
            const legacyMetadataColumns = [
                'page_count',
                'page_labels_json',
                'pages_json',
                'status',
                'has_text_layer',
                'needs_ocr',
                'is_encrypted',
                'is_invalid',
            ];
            if (legacyMetadataColumns.some((col) => metadataColumns.has(col))) {
                return true;
            }
        }

        const payloadColumns = new Set<string>();
        await this.conn.queryAsync(
            `SELECT name FROM pragma_table_info('document_cache_payloads')`,
            [],
            { onRow: (row: any) => payloadColumns.add(row.getResultByIndex(0)) },
        );
        if (payloadColumns.size > 0) {
            if (!payloadColumns.has('content_kind')) return true;
            if (!payloadColumns.has('payload_kind')) return true;
            if (payloadColumns.has('mode')) return true;
        }

        return false;
    }

    /** Detect background queue tables whose ephemeral schema should be rebuilt. */
    private async backgroundJobsSchemaIsStale(): Promise<boolean> {
        const liveColumns = new Set<string>();
        await this.conn.queryAsync(
            `SELECT name FROM pragma_table_info('background_jobs')`,
            [],
            { onRow: (row: any) => liveColumns.add(row.getResultByIndex(0)) },
        );
        if (liveColumns.size > 0) {
            if (!liveColumns.has('content_kind')) return true;
            if (!liveColumns.has('payload_kind')) return true;
            if (liveColumns.has('mode')) return true;
            if (!(await this.backgroundJobsUniqueKeyIsCurrent())) return true;
        }

        const deadColumns = new Set<string>();
        await this.conn.queryAsync(
            `SELECT name FROM pragma_table_info('background_jobs_dead')`,
            [],
            { onRow: (row: any) => deadColumns.add(row.getResultByIndex(0)) },
        );
        if (deadColumns.size > 0) {
            if (!deadColumns.has('content_kind')) return true;
            if (!deadColumns.has('payload_kind')) return true;
            if (deadColumns.has('mode')) return true;
        }

        return false;
    }

    /** Verify the live queue has the exact current dedupe key. */
    private async backgroundJobsUniqueKeyIsCurrent(): Promise<boolean> {
        const uniqueIndexNames: string[] = [];
        await this.conn.queryAsync(
            `SELECT name, [unique] FROM pragma_index_list('background_jobs')`,
            [],
            {
                onRow: (row: any) => {
                    if (row.getResultByIndex(1) === 1) {
                        uniqueIndexNames.push(row.getResultByIndex(0));
                    }
                },
            },
        );

        const expected = ['job_type', 'library_id', 'zotero_key', 'payload_kind'];
        for (const indexName of uniqueIndexNames) {
            const escapedName = indexName.replace(/'/g, `''`);
            const columns: string[] = [];
            await this.conn.queryAsync(
                `SELECT name FROM pragma_index_info('${escapedName}') ORDER BY seqno`,
                [],
                { onRow: (row: any) => columns.push(row.getResultByIndex(0)) },
            );
            if (
                columns.length === expected.length
                && columns.every((column, index) => column === expected[index])
            ) {
                return true;
            }
        }

        return false;
    }

    private async selectDocumentCacheMetadata(sql: string, params: any[] = []): Promise<DocumentCacheMetadataRecord[]> {
        const rows: any[] = [];
        await this.conn.queryAsync(sql, params, {
            onRow: (row: any) => {
                // These indices must match the SELECT column order above.
                rows.push({
                    id: row.getResultByIndex(0),
                    item_id: row.getResultByIndex(1),
                    library_id: row.getResultByIndex(2),
                    zotero_key: row.getResultByIndex(3),
                    content_kind: row.getResultByIndex(4),
                    file_path: row.getResultByIndex(5),
                    file_mtime_ms: row.getResultByIndex(6),
                    file_size_bytes: row.getResultByIndex(7),
                    source_size_bytes: row.getResultByIndex(8),
                    content_type: row.getResultByIndex(9),
                    document_metadata_json: row.getResultByIndex(10),
                    error_code: row.getResultByIndex(11),
                    extraction_schema_version: row.getResultByIndex(12),
                    metadata_format_version: row.getResultByIndex(13),
                    created_at: row.getResultByIndex(14),
                    updated_at: row.getResultByIndex(15),
                    last_accessed_at: row.getResultByIndex(16),
                });
            },
        });
        return rows.map((row) => BeaverDB.rowToDocumentCacheMetadataRecord(row));
    }

    private async selectDocumentCachePayloads(sql: string, params: any[] = []): Promise<DocumentCachePayloadRecord[]> {
        const rows: any[] = [];
        await this.conn.queryAsync(sql, params, {
            onRow: (row: any) => {
                // These indices must match the SELECT column order above.
                rows.push({
                    id: row.getResultByIndex(0),
                    metadata_id: row.getResultByIndex(1),
                    item_id: row.getResultByIndex(2),
                    library_id: row.getResultByIndex(3),
                    zotero_key: row.getResultByIndex(4),
                    payload_kind: row.getResultByIndex(5),
                    content_kind: row.getResultByIndex(6),
                    source_file_path: row.getResultByIndex(7),
                    source_file_mtime_ms: row.getResultByIndex(8),
                    source_file_size_bytes: row.getResultByIndex(9),
                    source_size_bytes: row.getResultByIndex(10),
                    payload_path: row.getResultByIndex(11),
                    payload_size_bytes: row.getResultByIndex(12),
                    payload_sha256: row.getResultByIndex(13),
                    extraction_schema_version: row.getResultByIndex(14),
                    cache_format_version: row.getResultByIndex(15),
                    created_at: row.getResultByIndex(16),
                    updated_at: row.getResultByIndex(17),
                    last_accessed_at: row.getResultByIndex(18),
                });
            },
        });
        return rows.map((row) => BeaverDB.rowToDocumentCachePayloadRecord(row));
    }

    private static documentCacheMetadataSelect(): string {
        return `SELECT id, item_id, library_id, zotero_key, content_kind,
                       file_path, file_mtime_ms, file_size_bytes,
                       source_size_bytes, content_type, document_metadata_json, error_code,
                       extraction_schema_version, metadata_format_version,
                       created_at, updated_at, last_accessed_at
                FROM document_cache_metadata`;
    }

    private static documentCachePayloadSelect(): string {
        return `SELECT id, metadata_id, item_id, library_id, zotero_key, payload_kind,
                       content_kind, source_file_path, source_file_mtime_ms, source_file_size_bytes,
                       source_size_bytes, payload_path, payload_size_bytes,
                       payload_sha256, extraction_schema_version, cache_format_version,
                       created_at, updated_at, last_accessed_at
                FROM document_cache_payloads`;
    }

    private static documentMetadataSourceChanged(
        existing: DocumentCacheMetadataRecord,
        incoming: DocumentCacheMetadataInput,
    ): boolean {
        return existing.filePath !== incoming.filePath
            || existing.fileSignature.mtime_ms !== incoming.fileSignature.mtime_ms
            || existing.fileSignature.size_bytes !== incoming.fileSignature.size_bytes
            || existing.sourceSizeBytes !== incoming.sourceSizeBytes
            || existing.extractionSchemaVersion !== incoming.extractionSchemaVersion
            || existing.metadataFormatVersion !== incoming.metadataFormatVersion;
    }

    private static documentCacheMetadataMatches(
        current: DocumentCacheMetadataRecord,
        inspected: DocumentCacheMetadataRecord,
    ): boolean {
        return current.id === inspected.id
            && current.itemId === inspected.itemId
            && current.libraryId === inspected.libraryId
            && current.zoteroKey === inspected.zoteroKey
            && current.filePath === inspected.filePath
            && current.fileSignature.mtime_ms === inspected.fileSignature.mtime_ms
            && current.fileSignature.size_bytes === inspected.fileSignature.size_bytes
            && current.sourceSizeBytes === inspected.sourceSizeBytes
            && current.contentType === inspected.contentType
            && current.contentKind === inspected.contentKind
            && JSON.stringify(current.documentMetadata) === JSON.stringify(inspected.documentMetadata)
            && current.errorCode === inspected.errorCode
            && current.extractionSchemaVersion === inspected.extractionSchemaVersion
            && current.metadataFormatVersion === inspected.metadataFormatVersion;
    }

    /** Insert or update document-cache metadata by library/key. */
    public async upsertDocumentCacheMetadata(
        record: DocumentCacheMetadataInput,
    ): Promise<{ metadata: DocumentCacheMetadataRecord; deletedPayloads: DocumentCachePayloadRecord[] }> {
        let deletedPayloads: DocumentCachePayloadRecord[] = [];
        await this.conn.executeTransaction(async () => {
            const existing = await this.getDocumentCacheMetadataByKey(record.libraryId, record.zoteroKey);
            if (existing && BeaverDB.documentMetadataSourceChanged(existing, record)) {
                deletedPayloads = await this.getDocumentCachePayloadsForMetadata(existing.id);
                await this.deleteDocumentCachePayloadRowsForMetadata(existing.id);
            }
            await this.conn.queryAsync(
                `INSERT INTO document_cache_metadata
                    (item_id, library_id, zotero_key, content_kind, file_path, file_mtime_ms,
                     file_size_bytes, source_size_bytes, content_type, document_metadata_json, error_code,
                     extraction_schema_version, metadata_format_version, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(library_id, zotero_key) DO UPDATE SET
                    item_id = excluded.item_id,
                    content_kind = excluded.content_kind,
                    file_path = excluded.file_path,
                    file_mtime_ms = excluded.file_mtime_ms,
                    file_size_bytes = excluded.file_size_bytes,
                    source_size_bytes = excluded.source_size_bytes,
                    content_type = excluded.content_type,
                    document_metadata_json = excluded.document_metadata_json,
                    error_code = excluded.error_code,
                    extraction_schema_version = excluded.extraction_schema_version,
                    metadata_format_version = excluded.metadata_format_version,
                    updated_at = datetime('now')`,
                [
                    record.itemId,
                    record.libraryId,
                    record.zoteroKey,
                    record.contentKind,
                    record.filePath,
                    record.fileSignature.mtime_ms,
                    record.fileSignature.size_bytes,
                    record.sourceSizeBytes,
                    record.contentType,
                    JSON.stringify(record.documentMetadata),
                    record.errorCode,
                    record.extractionSchemaVersion,
                    record.metadataFormatVersion,
                ],
            );
        });
        const metadata = await this.getDocumentCacheMetadataByKey(record.libraryId, record.zoteroKey);
        if (!metadata) {
            throw new Error('Document cache metadata upsert failed');
        }
        return { metadata, deletedPayloads };
    }

    /** Get document-cache metadata by library/key. */
    public async getDocumentCacheMetadataByKey(
        libraryId: number,
        zoteroKey: string,
    ): Promise<DocumentCacheMetadataRecord | null> {
        const rows = await this.selectDocumentCacheMetadata(
            `${BeaverDB.documentCacheMetadataSelect()} WHERE library_id = ? AND zotero_key = ?`,
            [libraryId, zoteroKey],
        );
        return rows[0] ?? null;
    }

    /** Get document-cache metadata by primary key. */
    public async getDocumentCacheMetadataById(id: number): Promise<DocumentCacheMetadataRecord | null> {
        const rows = await this.selectDocumentCacheMetadata(
            `${BeaverDB.documentCacheMetadataSelect()} WHERE id = ?`,
            [id],
        );
        return rows[0] ?? null;
    }

    /** Get all document-cache metadata rows. */
    public async getAllDocumentCacheMetadata(): Promise<DocumentCacheMetadataRecord[]> {
        return this.selectDocumentCacheMetadata(
            `${BeaverDB.documentCacheMetadataSelect()} ORDER BY library_id, zotero_key`,
        );
    }

    /** Delete one metadata row and return its payload rows for file cleanup. */
    public async deleteDocumentCacheMetadata(
        libraryId: number,
        zoteroKey: string,
    ): Promise<DocumentCachePayloadRecord[]> {
        const metadata = await this.getDocumentCacheMetadataByKey(libraryId, zoteroKey);
        if (!metadata) return [];
        const payloads = await this.getDocumentCachePayloadsForMetadata(metadata.id);
        await this.conn.queryAsync(
            `DELETE FROM document_cache_metadata WHERE library_id = ? AND zotero_key = ?`,
            [libraryId, zoteroKey],
        );
        return payloads;
    }

    /** Delete a metadata row only if it still matches the inspected record. */
    public async deleteDocumentCacheMetadataIfUnchanged(
        metadata: DocumentCacheMetadataRecord,
    ): Promise<DocumentCachePayloadRecord[] | null> {
        let deletedPayloads: DocumentCachePayloadRecord[] | null = null;
        await this.conn.executeTransaction(async () => {
            const current = await this.getDocumentCacheMetadataById(metadata.id);
            if (!current) {
                deletedPayloads = [];
                return;
            }
            if (!BeaverDB.documentCacheMetadataMatches(current, metadata)) {
                deletedPayloads = null;
                return;
            }

            deletedPayloads = await this.getDocumentCachePayloadsForMetadata(metadata.id);
            await this.conn.queryAsync(
                `DELETE FROM document_cache_metadata WHERE id = ?`,
                [metadata.id],
            );
        });
        return deletedPayloads;
    }

    /** Delete metadata rows for a library and return payload rows for file cleanup. */
    public async deleteDocumentCacheMetadataByLibrary(libraryId: number): Promise<DocumentCachePayloadRecord[]> {
        const payloads = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE library_id = ?`,
            [libraryId],
        );
        await this.conn.queryAsync(
            `DELETE FROM document_cache_metadata WHERE library_id = ?`,
            [libraryId],
        );
        return payloads;
    }

    /** Insert or update a document-cache payload by metadata/payload kind. */
    public async upsertDocumentCachePayload(record: DocumentCachePayloadInput): Promise<DocumentCachePayloadRecord> {
        await this.conn.queryAsync(
            `INSERT INTO document_cache_payloads
                (metadata_id, item_id, library_id, zotero_key, payload_kind, content_kind,
                 source_file_path, source_file_mtime_ms, source_file_size_bytes,
                 source_size_bytes, payload_path, payload_size_bytes, payload_sha256,
                 extraction_schema_version, cache_format_version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(metadata_id, payload_kind) DO UPDATE SET
                metadata_id = excluded.metadata_id,
                item_id = excluded.item_id,
                library_id = excluded.library_id,
                zotero_key = excluded.zotero_key,
                content_kind = excluded.content_kind,
                source_file_path = excluded.source_file_path,
                source_file_mtime_ms = excluded.source_file_mtime_ms,
                source_file_size_bytes = excluded.source_file_size_bytes,
                source_size_bytes = excluded.source_size_bytes,
                payload_path = excluded.payload_path,
                payload_size_bytes = excluded.payload_size_bytes,
                payload_sha256 = excluded.payload_sha256,
                extraction_schema_version = excluded.extraction_schema_version,
                cache_format_version = excluded.cache_format_version,
                updated_at = datetime('now')`,
            [
                record.metadataId,
                record.itemId,
                record.libraryId,
                record.zoteroKey,
                record.payloadKind,
                record.contentKind,
                record.sourceFilePath,
                record.sourceFileSignature.mtime_ms,
                record.sourceFileSignature.size_bytes,
                record.sourceSizeBytes,
                record.payloadPath,
                record.payloadSizeBytes,
                record.payloadSha256,
                record.extractionSchemaVersion,
                record.cacheFormatVersion,
            ],
        );
        const payload = await this.getDocumentCachePayload(record.libraryId, record.zoteroKey, record.payloadKind);
        if (!payload) {
            throw new Error('Document cache payload upsert failed');
        }
        return payload;
    }

    /** Get a payload row by library/key/payload kind. */
    public async getDocumentCachePayload(
        libraryId: number,
        zoteroKey: string,
        payloadKind: DocumentCachePayloadKind,
    ): Promise<DocumentCachePayloadRecord | null> {
        const rows = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE library_id = ? AND zotero_key = ? AND payload_kind = ?`,
            [libraryId, zoteroKey, payloadKind],
        );
        return rows[0] ?? null;
    }

    /** Get a payload row by primary key. */
    public async getDocumentCachePayloadById(id: number): Promise<DocumentCachePayloadRecord | null> {
        const rows = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE id = ?`,
            [id],
        );
        return rows[0] ?? null;
    }

    /** Get payload rows for one metadata row. */
    public async getDocumentCachePayloadsForMetadata(metadataId: number): Promise<DocumentCachePayloadRecord[]> {
        return this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE metadata_id = ?`,
            [metadataId],
        );
    }

    /** Get all payload rows. */
    public async getAllDocumentCachePayloads(): Promise<DocumentCachePayloadRecord[]> {
        return this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} ORDER BY library_id, zotero_key, payload_kind`,
        );
    }

    /**
     * Point payload rows at a moved cache directory.
     *
     * Payload paths are stored absolute, so renaming the plugin's profile
     * directory strands every cached extraction: the rows still resolve to the
     * old location, and the startup GC deletes the files at the new one for
     * matching no row. Rewrites only the directory prefix, leaving the
     * per-payload filename — which encodes the content hash — untouched.
     *
     * Returns the number of rows moved.
     */
    public async rebaseDocumentCachePayloadPaths(
        fromPrefix: string,
        toPrefix: string,
    ): Promise<number> {
        if (!fromPrefix || fromPrefix === toPrefix) return 0;
        const like = `${fromPrefix}%`;
        const rows = await this.conn.queryAsync(
            `SELECT COUNT(*) AS n FROM document_cache_payloads WHERE payload_path LIKE ?`,
            [like],
        );
        const count = Number(rows?.[0]?.n ?? 0);
        if (!count) return 0;
        await this.conn.queryAsync(
            `UPDATE document_cache_payloads
                SET payload_path = ? || SUBSTR(payload_path, ?)
              WHERE payload_path LIKE ?`,
            [toPrefix, fromPrefix.length + 1, like],
        );
        return count;
    }

    private async deleteDocumentCachePayloadRowsForMetadata(metadataId: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads WHERE metadata_id = ?`,
            [metadataId],
        );
    }

    /** Delete a payload row and return it for file cleanup. */
    public async deleteDocumentCachePayload(
        libraryId: number,
        zoteroKey: string,
        payloadKind: DocumentCachePayloadKind,
    ): Promise<DocumentCachePayloadRecord | null> {
        const payload = await this.getDocumentCachePayload(libraryId, zoteroKey, payloadKind);
        if (!payload) return null;
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads WHERE id = ?`,
            [payload.id],
        );
        return payload;
    }

    /** Delete a payload row only if it still matches the inspected record. */
    public async deleteDocumentCachePayloadIfUnchanged(
        payload: DocumentCachePayloadRecord,
    ): Promise<DocumentCachePayloadRecord | null> {
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads
             WHERE id = ?
               AND metadata_id = ?
               AND item_id = ?
               AND library_id = ?
               AND zotero_key = ?
               AND payload_kind = ?
               AND content_kind = ?
               AND source_file_path = ?
               AND source_file_mtime_ms = ?
               AND source_file_size_bytes = ?
               AND source_size_bytes = ?
               AND payload_path = ?
               AND payload_size_bytes = ?
               AND COALESCE(payload_sha256, '') = COALESCE(?, '')
               AND extraction_schema_version = ?
               AND cache_format_version = ?`,
            [
                payload.id,
                payload.metadataId,
                payload.itemId,
                payload.libraryId,
                payload.zoteroKey,
                payload.payloadKind,
                payload.contentKind,
                payload.sourceFilePath,
                payload.sourceFileSignature.mtime_ms,
                payload.sourceFileSignature.size_bytes,
                payload.sourceSizeBytes,
                payload.payloadPath,
                payload.payloadSizeBytes,
                payload.payloadSha256,
                payload.extractionSchemaVersion,
                payload.cacheFormatVersion,
            ],
        );

        const current = await this.getDocumentCachePayloadById(payload.id);
        if (current && (
            current.metadataId !== payload.metadataId
            || current.itemId !== payload.itemId
            || current.libraryId !== payload.libraryId
            || current.zoteroKey !== payload.zoteroKey
            || current.payloadKind !== payload.payloadKind
            || current.contentKind !== payload.contentKind
            || current.sourceFilePath !== payload.sourceFilePath
            || current.sourceFileSignature.mtime_ms !== payload.sourceFileSignature.mtime_ms
            || current.sourceFileSignature.size_bytes !== payload.sourceFileSignature.size_bytes
            || current.sourceSizeBytes !== payload.sourceSizeBytes
            || current.payloadPath !== payload.payloadPath
            || current.payloadSizeBytes !== payload.payloadSizeBytes
            || current.payloadSha256 !== payload.payloadSha256
            || current.extractionSchemaVersion !== payload.extractionSchemaVersion
            || current.cacheFormatVersion !== payload.cacheFormatVersion
        )) {
            return null;
        }
        return current ? null : payload;
    }

    /** Delete payload rows for one metadata row and return them for file cleanup. */
    public async deleteDocumentCachePayloadsForMetadata(metadataId: number): Promise<DocumentCachePayloadRecord[]> {
        const payloads = await this.getDocumentCachePayloadsForMetadata(metadataId);
        await this.deleteDocumentCachePayloadRowsForMetadata(metadataId);
        return payloads;
    }

    /** Delete all payload rows for a library and return them for file cleanup. */
    public async deleteDocumentCachePayloadsByLibrary(libraryId: number): Promise<DocumentCachePayloadRecord[]> {
        const payloads = await this.selectDocumentCachePayloads(
            `${BeaverDB.documentCachePayloadSelect()} WHERE library_id = ?`,
            [libraryId],
        );
        await this.conn.queryAsync(
            `DELETE FROM document_cache_payloads WHERE library_id = ?`,
            [libraryId],
        );
        return payloads;
    }

    /** Mark a metadata row as accessed. */
    public async touchDocumentCacheMetadata(id: number): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE document_cache_metadata SET last_accessed_at = datetime('now') WHERE id = ?`,
            [id],
        );
    }

    /** Mark a payload row as accessed. */
    public async touchDocumentCachePayload(id: number): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE document_cache_payloads SET last_accessed_at = datetime('now') WHERE id = ?`,
            [id],
        );
    }

    /** Count document-cache metadata rows. */
    public async getDocumentCacheMetadataCount(libraryId?: number): Promise<number> {
        const rows: Array<{ count: number }> = [];
        const sql = libraryId == null
            ? `SELECT COUNT(*) FROM document_cache_metadata`
            : `SELECT COUNT(*) FROM document_cache_metadata WHERE library_id = ?`;
        await this.conn.queryAsync(sql, libraryId == null ? [] : [libraryId], {
            onRow: (row: any) => rows.push({ count: row.getResultByIndex(0) }),
        });
        return rows[0]?.count ?? 0;
    }

    /** Count document-cache payload rows. */
    public async getDocumentCachePayloadCount(libraryId?: number): Promise<number> {
        const rows: Array<{ count: number }> = [];
        const sql = libraryId == null
            ? `SELECT COUNT(*) FROM document_cache_payloads`
            : `SELECT COUNT(*) FROM document_cache_payloads WHERE library_id = ?`;
        await this.conn.queryAsync(sql, libraryId == null ? [] : [libraryId], {
            onRow: (row: any) => rows.push({ count: row.getResultByIndex(0) }),
        });
        return rows[0]?.count ?? 0;
    }

    /** Delete every document-cache metadata and payload row. */
    public async deleteAllDocumentCache(): Promise<void> {
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(`DELETE FROM document_cache_payloads`);
            await this.conn.queryAsync(`DELETE FROM document_cache_metadata`);
        });
    }

    // =====================================================================
    // External files (user-attached files behind `ext-<KEY>` ids)
    // =====================================================================

    private static externalFileSelect(): string {
        return `SELECT ext_key, filename, original_path, stored_path, content_kind,
                       mime_type, file_size, mtime_ms, page_count, sha256, created_at
                FROM external_files`;
    }

    /**
     * Normalize SQLite's datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC
     * with no timezone marker) to ISO-8601 UTC, so `new Date(createdAt)`
     * never misparses it as local time. Attach-time records already carry
     * ISO strings and pass through unchanged.
     */
    private static sqliteUtcToIso(value: string): string {
        if (!value || value.includes('T')) return value;
        return `${value.replace(' ', 'T')}Z`;
    }

    private async selectExternalFiles(sql: string, params: any[] = []): Promise<ExternalFileRecord[]> {
        const rows: ExternalFileRecord[] = [];
        await this.conn.queryAsync(sql, params, {
            onRow: (row: any) => {
                // These indices must match the SELECT column order above.
                rows.push({
                    extKey: row.getResultByIndex(0),
                    filename: row.getResultByIndex(1),
                    originalPath: row.getResultByIndex(2) ?? null,
                    storedPath: row.getResultByIndex(3),
                    contentKind: row.getResultByIndex(4),
                    mimeType: row.getResultByIndex(5),
                    fileSize: row.getResultByIndex(6),
                    mtimeMs: row.getResultByIndex(7),
                    pageCount: row.getResultByIndex(8) ?? null,
                    sha256: row.getResultByIndex(9) ?? null,
                    createdAt: BeaverDB.sqliteUtcToIso(row.getResultByIndex(10)),
                });
            },
        });
        return rows;
    }

    /** Insert or replace the registry row for an external file. */
    public async upsertExternalFile(input: ExternalFileInput): Promise<void> {
        await this.conn.queryAsync(
            `INSERT INTO external_files (
                ext_key, filename, original_path, stored_path, content_kind,
                mime_type, file_size, mtime_ms, page_count, sha256
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ext_key) DO UPDATE SET
                filename = excluded.filename,
                original_path = excluded.original_path,
                stored_path = excluded.stored_path,
                content_kind = excluded.content_kind,
                mime_type = excluded.mime_type,
                file_size = excluded.file_size,
                mtime_ms = excluded.mtime_ms,
                page_count = excluded.page_count,
                sha256 = excluded.sha256`,
            [
                input.extKey,
                input.filename,
                input.originalPath,
                input.storedPath,
                input.contentKind,
                input.mimeType,
                input.fileSize,
                input.mtimeMs,
                input.pageCount,
                input.sha256,
            ],
        );
    }

    /** Get one external file by its 8-character key. */
    public async getExternalFileByKey(extKey: string): Promise<ExternalFileRecord | null> {
        const rows = await this.selectExternalFiles(
            `${BeaverDB.externalFileSelect()} WHERE ext_key = ?`,
            [extKey],
        );
        return rows[0] ?? null;
    }

    /**
     * Get the newest external file with the given content hash (attach-time
     * deduplication). Returns null when no row carries the hash.
     */
    public async getExternalFileBySha256(sha256: string): Promise<ExternalFileRecord | null> {
        const rows = await this.selectExternalFiles(
            `${BeaverDB.externalFileSelect()} WHERE sha256 = ? ORDER BY created_at DESC, ext_key DESC LIMIT 1`,
            [sha256],
        );
        return rows[0] ?? null;
    }

    /** Set the best-effort page count once it is known (async after attach). */
    public async setExternalFilePageCount(extKey: string, pageCount: number | null): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE external_files SET page_count = ? WHERE ext_key = ?`,
            [pageCount, extKey],
        );
    }

    /** Delete one external file registry row. */
    public async deleteExternalFile(extKey: string): Promise<void> {
        await this.conn.queryAsync(`DELETE FROM external_files WHERE ext_key = ?`, [extKey]);
    }

    /** List all external file registry rows (newest first). */
    public async listExternalFiles(): Promise<ExternalFileRecord[]> {
        return this.selectExternalFiles(
            `${BeaverDB.externalFileSelect()} ORDER BY created_at DESC, ext_key DESC`,
        );
    }

    /** Count and total size of all external file registry rows. */
    public async getExternalFileStats(): Promise<{ count: number; totalBytes: number }> {
        const rows: Array<{ count: number; totalBytes: number }> = [];
        await this.conn.queryAsync(
            `SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM external_files`,
            [],
            {
                onRow: (row: any) => rows.push({
                    count: row.getResultByIndex(0),
                    totalBytes: row.getResultByIndex(1),
                }),
            },
        );
        return rows[0] ?? { count: 0, totalBytes: 0 };
    }

    /** Delete every external file registry row. */
    public async deleteAllExternalFiles(): Promise<void> {
        await this.conn.queryAsync(`DELETE FROM external_files`);
    }

    // =====================================================================
    // Background job queue
    // =====================================================================

    /**
     * Insert a new background job, or merge with the existing row that
     * already covers the queue identity. Returns the job id
     * and whether the row was newly inserted.
     *
     * Merge semantics:
     *  - `priority` lowers to `MIN(existing, input)`.
     *  - `available_at` lowers to `MIN(existing, input.now)` so an urgent
     *    re-enqueue overrides a deferred prior visibility window.
     *  - `content_kind` follows the incoming attachment state.
     *  - `payload_json` overwrites when the content kind changes or the
     *    incoming job has a strictly higher (lower-numbered) priority.
     */
    public async enqueueBackgroundJob(
        input: BackgroundJobInput,
    ): Promise<BackgroundJobEnqueueResult> {
        const [result] = await this.enqueueBackgroundJobs([input]);
        return result;
    }

    /**
     * Enqueue a batch of background jobs in one transaction.
     *
     * Results are returned in input order. Duplicate jobs within the batch
     * or already present in the queue use the same merge semantics as
     * `enqueueBackgroundJob`.
     */
    public async enqueueBackgroundJobs(
        inputs: BackgroundJobInput[],
    ): Promise<BackgroundJobEnqueueResult[]> {
        if (inputs.length === 0) return [];

        const results: BackgroundJobEnqueueResult[] = [];

        await this.conn.executeTransaction(async () => {
            for (const input of inputs) {
                results.push(await this.enqueueBackgroundJobInTransaction(input));
            }
        });

        return results;
    }

    /**
     * Insert or merge one background job. Must be called inside an active
     * transaction so callers can choose single-job or batch atomicity.
     */
    private async enqueueBackgroundJobInTransaction(
        input: BackgroundJobInput,
    ): Promise<BackgroundJobEnqueueResult> {
        const priority = input.priority ?? 100;
        const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
        const itemId = input.itemId ?? null;

        let enqueued = false;
        let id = 0;

        await this.conn.queryAsync(
            `INSERT OR IGNORE INTO background_jobs (
                job_type, library_id, item_id, zotero_key, content_kind,
                payload_kind,
                priority, payload_json, enqueued_at, available_at,
                attempt_count, last_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
            [
                input.jobType,
                input.libraryId,
                itemId,
                input.zoteroKey,
                input.contentKind,
                input.payloadKind,
                priority,
                payloadJson,
                input.now,
                input.now,
            ],
        );

        const changesRows: number[] = [];
        await this.conn.queryAsync(`SELECT changes()`, [], {
            onRow: (row: any) => {
                changesRows.push(row.getResultByIndex(0));
            },
        });
        enqueued = (changesRows[0] ?? 0) === 1;

        if (!enqueued) {
            await this.conn.queryAsync(
                `UPDATE background_jobs SET
                    priority      = MIN(priority, ?),
                    available_at  = MIN(available_at, ?),
                    content_kind  = ?,
                    payload_json  = CASE WHEN content_kind != ? OR ? < priority
                                         THEN ? ELSE payload_json END,
                    attempt_count = CASE WHEN content_kind != ? OR ? < priority
                                         THEN 0 ELSE attempt_count END,
                    last_error    = CASE WHEN content_kind != ? OR ? < priority
                                         THEN NULL ELSE last_error END
                 WHERE job_type = ? AND library_id = ? AND zotero_key = ? AND payload_kind = ?`,
                [
                    priority,
                    input.now,
                    input.contentKind,
                    input.contentKind, priority,
                    payloadJson,
                    input.contentKind, priority,
                    input.contentKind, priority,
                    input.jobType,
                    input.libraryId,
                    input.zoteroKey,
                    input.payloadKind,
                ],
            );
        }

        const idRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT id FROM background_jobs
             WHERE job_type = ? AND library_id = ? AND zotero_key = ? AND payload_kind = ?`,
            [input.jobType, input.libraryId, input.zoteroKey, input.payloadKind],
            {
                onRow: (row: any) => {
                    idRows.push(row.getResultByIndex(0));
                },
            },
        );
        id = idRows[0] ?? 0;

        return { enqueued, id };
    }

    /**
     * Claim the next visible job (pgmq-style): pick lowest-priority, then
     * oldest-available row whose `available_at <= now`, then bump its
     * `available_at` forward by `visibilityTimeoutMs` so a crash/abort
     * leaves the row safe to re-pick later.
     *
     * `maxPriority` is an exclusive upper bound — when provided, only rows
     * with `priority < maxPriority` are eligible. Used by the background
     * extractor to gate library-scale work (priority >= 100) behind user
     * idleness while still letting hot-path retries (priority < 100) run.
     *
     * Returns `null` when no row is visible, or when an optimistic-claim
     * race lost (currently impossible with one consumer; cheap insurance).
     */
    public async claimNextBackgroundJob(
        now: number,
        visibilityTimeoutMs: number,
        maxPriority?: number,
    ): Promise<BackgroundJobRecord | null> {
        const params: unknown[] = [now];
        let priorityClause = '';
        if (maxPriority !== undefined) {
            priorityClause = ' AND priority < ?';
            params.push(maxPriority);
        }
        const candidates = await this.selectBackgroundJobs(
            `SELECT ${BACKGROUND_JOB_COLUMNS}
             FROM background_jobs
             WHERE available_at <= ?${priorityClause}
             ORDER BY priority ASC, available_at ASC
             LIMIT 1`,
            params,
        );
        if (candidates.length === 0) return null;
        const candidate = candidates[0];

        const newAvailableAt = now + visibilityTimeoutMs;
        const changesRows: number[] = [];
        await this.conn.executeTransaction(async () => {
            await this.conn.queryAsync(
                `UPDATE background_jobs
                 SET available_at = ?
                 WHERE id = ? AND available_at <= ?`,
                [newAvailableAt, candidate.id, now],
            );
            await this.conn.queryAsync(`SELECT changes()`, [], {
                onRow: (row: any) => {
                    changesRows.push(row.getResultByIndex(0));
                },
            });
        });

        if ((changesRows[0] ?? 0) !== 1) return null;
        return { ...candidate, availableAt: newAvailableAt };
    }

    /** Read up to `limit` jobs (default 100) without claiming. */
    public async peekBackgroundJobs(limit = 100): Promise<BackgroundJobRecord[]> {
        return this.selectBackgroundJobs(
            `SELECT ${BACKGROUND_JOB_COLUMNS}
             FROM background_jobs
             ORDER BY priority ASC, available_at ASC
             LIMIT ?`,
            [limit],
        );
    }

    /** Mark a claimed job as completed by removing its row. */
    public async completeBackgroundJob(id: number): Promise<void> {
        await this.conn.queryAsync(
            `DELETE FROM background_jobs WHERE id = ?`,
            [id],
        );
    }

    /**
     * Record a failed attempt. After `maxAttempts` total attempts the row
     * moves to `background_jobs_dead`. Otherwise the attempt counter
     * bumps and `available_at` slides forward by `backoffMs(attempt)`.
     */
    public async failBackgroundJob(
        id: number,
        error: string,
        opts: {
            maxAttempts: number;
            backoffMs: (attempt: number) => number;
            now: number;
        },
    ): Promise<{ dead: boolean }> {
        const rows = await this.selectBackgroundJobs(
            `SELECT ${BACKGROUND_JOB_COLUMNS}
             FROM background_jobs
             WHERE id = ?`,
            [id],
        );
        if (rows.length === 0) return { dead: false };
        const current = rows[0];
        const nextAttempt = current.attemptCount + 1;

        if (nextAttempt >= opts.maxAttempts) {
            await this.conn.executeTransaction(async () => {
                await this.conn.queryAsync(
                    `INSERT INTO background_jobs_dead (
                        job_type, library_id, zotero_key, content_kind,
                        payload_kind, payload_json, enqueued_at, died_at,
                        attempt_count, last_error
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        current.jobType,
                        current.libraryId,
                        current.zoteroKey,
                        current.contentKind,
                        current.payloadKind,
                        current.payload ? JSON.stringify(current.payload) : null,
                        current.enqueuedAt,
                        opts.now,
                        nextAttempt,
                        error,
                    ],
                );
                await this.conn.queryAsync(
                    `DELETE FROM background_jobs WHERE id = ?`,
                    [id],
                );
            });
            return { dead: true };
        }

        const nextAvailableAt = opts.now + opts.backoffMs(nextAttempt);
        await this.conn.queryAsync(
            `UPDATE background_jobs
             SET attempt_count = attempt_count + 1,
                 last_error = ?,
                 available_at = ?
             WHERE id = ?`,
            [error, nextAvailableAt, id],
        );
        return { dead: false };
    }

    /**
     * Release a claimed job without counting it as a failed attempt. Used
     * when the processor itself aborts an in-flight job (e.g. shutdown),
     * so the row can be picked again on the next start without burning an
     * attempt or recording a misleading error.
     */
    public async releaseBackgroundJob(id: number, now: number): Promise<void> {
        await this.conn.queryAsync(
            `UPDATE background_jobs SET available_at = ? WHERE id = ?`,
            [now, id],
        );
    }

    /** Counts surfaced through the dev queue-stats endpoint. */
    public async getBackgroundQueueStats(
        now: number,
    ): Promise<BackgroundQueueStats> {
        const totalsRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT COUNT(*) FROM background_jobs`,
            [],
            { onRow: (row: any) => totalsRows.push(row.getResultByIndex(0)) },
        );
        const pending = totalsRows[0] ?? 0;

        const availableRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT COUNT(*) FROM background_jobs WHERE available_at <= ?`,
            [now],
            { onRow: (row: any) => availableRows.push(row.getResultByIndex(0)) },
        );
        const available = availableRows[0] ?? 0;
        const deferred = pending - available;

        const deadRows: number[] = [];
        await this.conn.queryAsync(
            `SELECT COUNT(*) FROM background_jobs_dead`,
            [],
            { onRow: (row: any) => deadRows.push(row.getResultByIndex(0)) },
        );
        const dead = deadRows[0] ?? 0;

        const byJobType: Record<string, number> = {};
        await this.conn.queryAsync(
            `SELECT job_type, COUNT(*) FROM background_jobs GROUP BY job_type`,
            [],
            {
                onRow: (row: any) => {
                    const jobType: string = row.getResultByIndex(0);
                    const count: number = row.getResultByIndex(1);
                    byJobType[jobType] = count;
                },
            },
        );

        return { pending, available, deferred, dead, byJobType };
    }

    private async selectBackgroundJobs(
        sql: string,
        params: any[] = [],
    ): Promise<BackgroundJobRecord[]> {
        const rows: BackgroundJobRecord[] = [];
        await this.conn.queryAsync(sql, params, {
            onRow: (row: any) => {
                const contentKind = row.getResultByIndex(5);
                const payloadJson = row.getResultByIndex(8);
                const payload = parseBackgroundJobPayload(contentKind, payloadJson);
                rows.push({
                    id: row.getResultByIndex(0),
                    jobType: row.getResultByIndex(1) as BackgroundJobType,
                    libraryId: row.getResultByIndex(2),
                    itemId: row.getResultByIndex(3) ?? null,
                    zoteroKey: row.getResultByIndex(4),
                    contentKind: contentKind as ExtractContentKind,
                    payloadKind: row.getResultByIndex(6) as DocumentCachePayloadKind,
                    priority: row.getResultByIndex(7),
                    payload,
                    enqueuedAt: row.getResultByIndex(9),
                    availableAt: row.getResultByIndex(10),
                    attemptCount: row.getResultByIndex(11),
                    lastError: row.getResultByIndex(12) ?? null,
                });
            },
        });
        return rows;
    }
}
