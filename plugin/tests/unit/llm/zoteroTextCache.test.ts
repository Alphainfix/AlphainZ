/**
 * Zotero's extracted-text cache, used when the PDF itself is not on the machine.
 *
 * With "download files as needed", a synced library keeps the metadata and this
 * cache but purges the file — so a paper Zotero has already read becomes
 * invisible to full-text search for a reason that has nothing to do with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    cachedTextAsDocument,
    readZoteroTextCache,
} from '../../../src/services/llm/zoteroTextCache';

const PAPER = 'Warm doughs rise faster but give a milder and flatter bread. '.repeat(20);

const attachment = { key: 'KFQV5FLB' } as any;

beforeEach(() => {
    (Zotero as any).Attachments = {
        getStorageDirectory: vi.fn(() => ({ path: '/Zotero/storage/KFQV5FLB' })),
    };
    (globalThis as any).PathUtils.join.mockImplementation((...p: string[]) => p.join('/'));
    (globalThis as any).IOUtils.exists.mockResolvedValue(true);
    (globalThis as any).IOUtils.readUTF8.mockResolvedValue(PAPER);
});

describe('readZoteroTextCache', () => {
    it('reads the cache Zotero wrote beside the attachment', async () => {
        const cached = await readZoteroTextCache(attachment);
        expect(cached?.text).toContain('milder and flatter');
        expect(cached?.pagesUnknown).toBe(true);
        expect((globalThis as any).IOUtils.readUTF8).toHaveBeenCalledWith(
            '/Zotero/storage/KFQV5FLB/.zotero-ft-cache',
        );
    });

    it('returns nothing when there is no cache', async () => {
        (globalThis as any).IOUtils.exists.mockResolvedValue(false);
        expect(await readZoteroTextCache(attachment)).toBeNull();
    });

    it('ignores a cache too short to be a paper', async () => {
        // A cover page or a stub is not worth embedding, and indexing it would
        // put a paper in the index that cannot answer anything.
        (globalThis as any).IOUtils.readUTF8.mockResolvedValue('Title page only');
        expect(await readZoteroTextCache(attachment)).toBeNull();
    });

    it('treats an unreadable cache as absent rather than throwing', async () => {
        // This runs inside a library-wide pass; one unreadable file must not
        // end the run.
        (globalThis as any).IOUtils.readUTF8.mockRejectedValue(new Error('EACCES'));
        expect(await readZoteroTextCache(attachment)).toBeNull();
    });

    it('survives an attachment with no storage directory', async () => {
        (Zotero as any).Attachments.getStorageDirectory = vi.fn(() => null);
        expect(await readZoteroTextCache(attachment)).toBeNull();
    });
});

describe('cachedTextAsDocument', () => {
    it('presents the text as a single unlabelled page', async () => {
        // No page label on purpose: the cache is one flat run of text, and a
        // page number invented here would send the reader to the wrong place.
        const doc = cachedTextAsDocument({ text: PAPER, pagesUnknown: true });
        expect(doc.pages).toHaveLength(1);
        expect(doc.pages[0].index).toBe(0);
        expect(doc.pages[0].label).toBeUndefined();
        expect(doc.pages[0].markdown).toBe(PAPER);
    });
});
