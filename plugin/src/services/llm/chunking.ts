/**
 * Splitting a document into passages that can be embedded and searched.
 *
 * This is the piece that makes "which of my papers discusses X" answerable.
 * One vector per item — which is what the existing index stores — can only
 * match a title and abstract; a claim made in section 4 is invisible to it.
 *
 * Pure: documents in, chunks out. No Zotero, no network.
 */

export interface Chunk {
    /** 0-based page the chunk starts on. */
    pageIndex: number;
    /** Printed label for that page, when the document has one. */
    pageLabel?: string;
    text: string;
    /**
     * First and last extraction sentence number covered by this chunk (the
     * numeric part of "s223"), when the chunk was built from a structured
     * page. What turns a search hit into a clickable sentence-range citation;
     * absent for markdown-built chunks, where a hit falls back to its page.
     */
    sentenceStart?: number;
    sentenceEnd?: number;
}

export interface ChunkOptions {
    /** Characters per chunk. */
    size?: number;
    /** Characters repeated from the previous chunk. */
    overlap?: number;
}

/**
 * Roughly 1200 characters — about 300 tokens.
 *
 * Small enough that a match points at a specific passage rather than a whole
 * page, large enough to carry an argument. The overlap exists because a claim
 * that straddles a boundary would otherwise be split across two chunks and
 * match neither well.
 */
/**
 * Floor for a chunk worth embedding.
 *
 * Set to catch a page number or a stray running head, not a short paragraph: a
 * single sentence is a legitimate passage and an aggressive floor silently drops
 * real content from the index.
 */
const MIN_CHUNK_CHARS = 24;

const DEFAULT_SIZE = 1200;
const DEFAULT_OVERLAP = 200;

interface MarkdownPageLike {
    index: number;
    label?: string;
    markdown?: string;
}

/** The slice of a structured page this module needs; kinds it skips are named. */
interface StructuredItemLike {
    kind?: string;
    text?: string;
    sentences?: Array<{ id: string; text: string }>;
}

interface StructuredPageLike extends MarkdownPageLike {
    items?: StructuredItemLike[];
}

interface TextSpan {
    text: string;
    /** Offsets into the cleaned page text the span was cut from. */
    start: number;
    end: number;
}

/**
 * Split one page's text into overlapping chunks, keeping each piece's offsets
 * so a caller that knows where the sentences sit can say which ones a chunk
 * covers.
 *
 * Breaks are placed at a paragraph boundary where one is available near the
 * target size, and at a sentence boundary otherwise — a chunk that starts
 * mid-sentence reads as noise to an embedding model and matches poorly.
 *
 * Offsets refer to the CLEANED text (CRLF normalized, outer whitespace
 * trimmed), which is also what the returned pieces are sliced from.
 */
export function chunkTextSpans(text: string, options: ChunkOptions = {}): TextSpan[] {
    const size = Math.max(options.size ?? DEFAULT_SIZE, MIN_CHUNK_CHARS);
    // Clamped below the chunk size: an overlap at or above it would step the
    // cursor backwards, and the loop would emit near-duplicate chunks for ever.
    const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP, Math.floor(size / 2));
    const cleaned = text.replace(/\r\n/g, '\n').trim();
    if (cleaned.length < MIN_CHUNK_CHARS) return [];
    if (cleaned.length <= size) return [{ text: cleaned, start: 0, end: cleaned.length }];

    const spans: TextSpan[] = [];
    let start = 0;

    while (start < cleaned.length) {
        let end = Math.min(start + size, cleaned.length);

        if (end < cleaned.length) {
            // Look for a break in the last quarter of the window, preferring a
            // paragraph break over a sentence one.
            const windowStart = start + Math.floor(size * 0.75);
            const paragraph = cleaned.lastIndexOf('\n\n', end);
            const sentence = cleaned.lastIndexOf('. ', end);
            if (paragraph > windowStart) end = paragraph;
            else if (sentence > windowStart) end = sentence + 1;
        }

        const raw = cleaned.slice(start, end);
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;
        if (raw.trim().length >= MIN_CHUNK_CHARS) {
            spans.push({
                text: cleaned.slice(start + lead, end - trail),
                start: start + lead,
                end: end - trail,
            });
        }

        if (end >= cleaned.length) break;
        // Step forward by at least one character even if the overlap would
        // otherwise leave the cursor where it was.
        start = Math.max(end - overlap, start + 1);
    }

    return spans;
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
    return chunkTextSpans(text, options).map((span) => span.text);
}

/**
 * One structured page as plain text plus the position of every sentence.
 *
 * Margins (running heads, page numbers) and pictures are skipped as noise;
 * everything text-bearing — paragraphs, headers, captions, footnotes, list
 * items, formulas — contributes a block, so the embedded text stays close to
 * what the markdown extraction used to produce. Sentences are located by a
 * forward-only search inside their item's canonical text; one that cannot be
 * found is dropped rather than guessed at.
 */
function structuredPageText(items: StructuredItemLike[]): {
    text: string;
    sentences: Array<{ start: number; end: number; number: number }>;
} {
    let text = '';
    const sentences: Array<{ start: number; end: number; number: number }> = [];

    for (const item of items) {
        if (item.kind === 'margin' || item.kind === 'picture') continue;
        const body = (item.text ?? '').replace(/\r\n/g, '\n').trim();
        if (!body) continue;

        if (text) text += '\n\n';
        const base = text.length;
        text += body;

        let cursor = 0;
        for (const sentence of item.sentences ?? []) {
            const numbered = /^s(\d+)$/.exec(sentence.id ?? '');
            if (!numbered) continue;
            const needle = (sentence.text ?? '').trim();
            if (!needle) continue;
            const at = body.indexOf(needle, cursor);
            if (at < 0) continue;
            sentences.push({
                start: base + at,
                end: base + at + needle.length,
                number: Number(numbered[1]),
            });
            cursor = at + needle.length;
        }
    }
    return { text, sentences };
}

/**
 * Split a whole extracted document, keeping each chunk's page.
 *
 * The page is the point: a full-text hit is only useful if it can say where to
 * look, and a chunk that has lost its page number cannot.
 */
export function chunkDocument(
    document: { pages?: StructuredPageLike[] } | null | undefined,
    options: ChunkOptions = {},
): Chunk[] {
    const chunks: Chunk[] = [];
    for (const page of document?.pages ?? []) {
        const base = {
            pageIndex: page.index ?? 0,
            ...(page.label ? { pageLabel: page.label } : {}),
        };

        /*
         * A structured page (items with sentence ids) yields chunks that know
         * their sentence range — what makes a search hit clickable down to the
         * passage. A markdown page yields the same chunks as always, located
         * only by page.
         */
        if (Array.isArray(page.items)) {
            const { text, sentences } = structuredPageText(page.items);
            for (const span of chunkTextSpans(text, options)) {
                const covered = sentences.filter(
                    (s) => s.start < span.end && s.end > span.start,
                );
                const range = covered.length > 0
                    ? {
                        sentenceStart: Math.min(...covered.map((s) => s.number)),
                        sentenceEnd: Math.max(...covered.map((s) => s.number)),
                    }
                    : {};
                chunks.push({ ...base, text: span.text, ...range });
            }
            continue;
        }

        const text = typeof page.markdown === 'string' ? page.markdown : '';
        for (const piece of chunkText(text, options)) {
            chunks.push({ ...base, text: piece });
        }
    }
    return chunks;
}

/**
 * Strip markdown scaffolding before embedding.
 *
 * Heading hashes, table pipes and figure markers carry no meaning for a
 * similarity model and dilute what does. Notation survives — this runs over
 * scientific papers.
 */
export function cleanChunkForEmbedding(text: string): string {
    return text
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*\|.*\|\s*$/gm, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
