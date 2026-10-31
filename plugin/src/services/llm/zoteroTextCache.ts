/**
 * Zotero's own extracted text, as a fallback when the PDF itself is absent.
 *
 * With Zotero set to download files as needed, a synced library keeps the
 * metadata and the extracted-text cache locally but not the PDF. Those papers
 * are invisible to full-text search for a reason that has nothing to do with
 * them: the text exists, right there in `storage/<KEY>/.zotero-ft-cache`, and
 * Zotero wrote it.
 *
 * What is lost is the page structure. The cache is one flat run of text, so a
 * passage found this way can name the paper but not the page — the citation
 * opens the paper rather than a page in it. That is a real downgrade and the
 * caller is told about it, but it is a far smaller one than the paper being
 * unsearchable.
 *
 * The proper fix is still to download the file; this is what makes the library
 * searchable in the meantime.
 */

import { logger } from '@beaver/agent-core/platform/logger';

/** Zotero's filename for the cache it writes beside an attachment. */
const CACHE_FILE = '.zotero-ft-cache';

/** Below this there is nothing worth embedding — a cover page, or a stub. */
const MIN_USEFUL_CHARS = 400;

export interface CachedText {
    text: string;
    /** Always true here; kept explicit so callers cannot forget what they got. */
    pagesUnknown: true;
}

/**
 * Read the extracted text Zotero cached for an attachment, if any.
 *
 * Returns null when there is no cache, when it is too short to be a paper, or
 * when it cannot be read — all of which are ordinary, so none of them throw.
 */
export async function readZoteroTextCache(
    attachment: Zotero.Item,
): Promise<CachedText | null> {
    try {
        const dir = Zotero.Attachments.getStorageDirectory(attachment)?.path;
        if (!dir) return null;

        const path = PathUtils.join(dir, CACHE_FILE);
        if (!(await IOUtils.exists(path))) return null;

        const text = await IOUtils.readUTF8(path);
        const trimmed = (text ?? '').trim();
        if (trimmed.length < MIN_USEFUL_CHARS) return null;

        return { text: trimmed, pagesUnknown: true };
    } catch (error) {
        logger(`readZoteroTextCache: ${attachment.key}: ${error}`, 1);
        return null;
    }
}

/**
 * Shape cached text as a one-page document.
 *
 * Page index 0 with no label, so nothing downstream invents a page number it
 * cannot stand behind: a chunk from here carries no page, and the citation
 * renderer already omits the locator when there is none.
 */
export function cachedTextAsDocument(cached: CachedText): {
    pages: Array<{ index: number; label?: string; markdown?: string }>;
} {
    return { pages: [{ index: 0, markdown: cached.text }] };
}
