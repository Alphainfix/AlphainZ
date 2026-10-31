/**
 * The backend mode and its migration off the legacy boolean.
 *
 * `conversationSyncBackend` starts life as `""` on every profile that predates
 * it. The startup migration writes the real value; the read-time fallback here
 * is what makes any read that races that write land on the same answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));

import { conversationSyncMode, getConversationBackend } from '../../../src/services/conversationSync';

beforeEach(() => {
    for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('conversationSyncMode', () => {
    it('derives from the legacy boolean while unmigrated', () => {
        prefs.conversationSyncBackend = '';
        prefs.syncThreadsToZotero = true;
        expect(conversationSyncMode()).toBe('zotero');
        prefs.syncThreadsToZotero = false;
        expect(conversationSyncMode()).toBe('off');
    });

    it('lets an explicit value win over the legacy boolean', () => {
        prefs.conversationSyncBackend = 'folder';
        prefs.syncThreadsToZotero = true;   // stale leftover
        expect(conversationSyncMode()).toBe('folder');
        prefs.conversationSyncBackend = 'off';
        expect(conversationSyncMode()).toBe('off');
    });

    it('treats garbage as unmigrated rather than crashing or writing', () => {
        prefs.conversationSyncBackend = 'both';
        prefs.syncThreadsToZotero = true;
        expect(conversationSyncMode()).toBe('zotero');
        // Read-only: the migration is the startup hook's job.
        expect(prefs.conversationSyncBackend).toBe('both');
    });
});

describe('getConversationBackend', () => {
    it('is null when off', () => {
        prefs.conversationSyncBackend = 'off';
        expect(getConversationBackend()).toBeNull();
    });

    it('is null for folder mode without a folder', () => {
        // "Folder mode with no folder" is off with extra steps — a backend
        // that throws on every call helps nobody.
        prefs.conversationSyncBackend = 'folder';
        prefs.conversationSyncFolderPath = '   ';
        expect(getConversationBackend()).toBeNull();
    });

    it('builds the folder backend once a path exists', () => {
        prefs.conversationSyncBackend = 'folder';
        prefs.conversationSyncFolderPath = '/tmp/sync';
        expect(getConversationBackend()?.kind).toBe('folder');
    });
});
