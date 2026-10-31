/**
 * Which sync backend is active, and a constructed instance of it.
 *
 * Every call site asks this module instead of reading prefs, so the mode
 * semantics (including the legacy migration) live in exactly one place.
 */
import { getPref } from '../../utils/prefs';
import type { ConversationBackend, ConversationSyncMode } from './types';
import { ZoteroConversationBackend } from './zoteroBackend';
import { FolderConversationBackend } from './folderBackend';

export type {
    ConversationBackend,
    ConversationSyncMode,
    ImportCounts,
    SettingsDocumentPresence,
} from './types';

export function conversationSyncMode(): ConversationSyncMode {
    const raw = String(getPref('conversationSyncBackend') ?? '');
    if (raw === 'off' || raw === 'zotero' || raw === 'folder') return raw;
    /*
     * Unmigrated or garbage: derive from the legacy boolean without writing.
     * The startup migration writes the real value; this read-time fallback is
     * what makes a read that races that write harmless.
     */
    return getPref('syncThreadsToZotero') ? 'zotero' : 'off';
}

/** The active backend, or null when sync is off (or misconfigured). */
export function getConversationBackend(): ConversationBackend | null {
    const mode = conversationSyncMode();
    if (mode === 'zotero') return new ZoteroConversationBackend();
    if (mode === 'folder') {
        const path = String(getPref('conversationSyncFolderPath') ?? '').trim();
        // A folder mode without a folder is "off with extra steps" — return
        // null rather than a backend that throws on every call.
        return path ? new FolderConversationBackend(path) : null;
    }
    return null;
}

/**
 * Which machine wrote a file — the same identity `serializeThread` stamps into
 * `exportedBy`. Exists without a Zotero account.
 */
export function machineId(): string {
    return String(Zotero.Users?.getLocalUserKey?.() ?? 'unknown');
}
