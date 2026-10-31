/**
 * Backfill: write every local conversation into the active backend.
 *
 * Turning sync on is not retroactive — each finished answer writes its own
 * thread, so a conversation never touched again would never travel. This walks
 * everything on this machine. Shared by the settings page and the welcome
 * wizard.
 */
import { logger } from '@beaver/agent-core/platform/logger';
import type { BeaverDB } from '../database';
import { parseThreadTimestamp } from '../threadZoteroSync';
import type { ConversationBackend } from './types';

export interface ExportAllOutcome {
    written: number;
    failed: number;
    /** Left alone: the remote copy is newer, or there but not readable yet. */
    skipped: number;
    /** Not written because the remote copy is already this computer's version. */
    upToDate: number;
}

export async function exportAllThreads(
    db: BeaverDB,
    backend: ConversationBackend,
    userId: string,
    options: {
        /**
         * Write only what the remote copy lacks. A thread whose remote copy
         * is newer than this computer's, or is there but cannot be read yet,
         * is another computer's later work, which the import brings in; one
         * whose copy has the same `updatedAt` is already there — what a pass
         * just imported. A copy that was read but is not a conversation file
         * is replaced.
         */
        skipNewerRemote?: boolean;
    } = {},
): Promise<ExportAllOutcome> {
    const now = new Date().toISOString();
    let offset = 0;
    let written = 0;
    let failed = 0;
    let skipped = 0;
    let upToDate = 0;
    for (;;) {
        const page = await (db as any).getThreadsPaginated(userId, 50, offset);
        const threads = page?.threads ?? [];
        if (threads.length === 0) break;
        for (const thread of threads) {
            try {
                if (options.skipNewerRemote && backend.remoteThreadUpdatedAt) {
                    const remote = await backend.remoteThreadUpdatedAt(thread.id);
                    if (remote === 'unreadable') {
                        skipped += 1;
                        continue;
                    }
                    if (remote && remote !== 'damaged') {
                        const remoteAt = parseThreadTimestamp(remote);
                        const localAt = parseThreadTimestamp(thread.updatedAt);
                        if (remoteAt > localAt) {
                            skipped += 1;
                            continue;
                        }
                        if (remoteAt === localAt) {
                            upToDate += 1;
                            continue;
                        }
                    }
                }
                const ok = await backend.writeThread(db, userId, thread.id, now);
                if (ok) written += 1; else failed += 1;
            } catch (error) {
                failed += 1;
                logger(`exportAllThreads: failed for ${thread.id}: ${error}`, 1);
            }
        }
        if (!page?.has_more) break;
        offset += threads.length;
    }
    return { written, failed, skipped, upToDate };
}
