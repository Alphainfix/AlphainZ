/**
 * Full-text passage search across the whole library.
 *
 * `item_search_by_topic` matches a title and abstract, so it answers "which of
 * my papers is about X". This answers the different question — "which of my
 * papers *says* X" — by embedding each document's passages and searching those.
 *
 * Indexing is explicit rather than a background crawl. Embedding every page of
 * every paper costs real money and real minutes, and a crawl that starts itself
 * spends both without being asked.
 */

import { quantizeToInt8, int8Cosine, type EmbeddingProvider } from './embeddings';
import { chunkDocument, cleanChunkForEmbedding, type Chunk } from './chunking';

/** Chunks embedded per request. Large enough to be cheap, small enough to retry. */
const EMBED_BATCH = 32;

export interface FulltextHit {
    libraryId: number;
    attachmentKey: string;
    parentKey: string | null;
    page: number;
    pageLabel: string | null;
    text: string;
    similarity: number;
    /** Extraction sentence range the chunk covers, when the index knows it. */
    sentenceStart: number | null;
    sentenceEnd: number | null;
}

export interface IndexDocumentResult {
    chunks: number;
    skipped: boolean;
    reason?: string;
}

/** The store this module needs; narrowed so it can be faked in tests. */
export interface ChunkStore {
    replaceChunks(
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
    ): Promise<void>;
    getChunksForSearch(
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
        sentenceStart?: number | null;
        sentenceEnd?: number | null;
    }>>;
}

/**
 * Embed and store one document's passages.
 *
 * Replaces whatever was stored for the attachment rather than adding to it, so
 * re-indexing an edited PDF cannot leave a hit pointing at text the page no
 * longer contains.
 */
export async function indexDocumentChunks(options: {
    store: ChunkStore;
    provider: EmbeddingProvider;
    modelId: string;
    libraryId: number;
    attachmentKey: string;
    parentKey?: string | null;
    document: {
        pages?: Array<{
            index: number;
            label?: string;
            markdown?: string;
            items?: Array<{ kind?: string; text?: string; sentences?: Array<{ id: string; text: string }> }>;
        }>;
    } | null;
}): Promise<IndexDocumentResult> {
    const chunks: Chunk[] = chunkDocument(options.document);
    if (chunks.length === 0) {
        // A scan with no text layer. Recorded as skipped rather than failed:
        // there is nothing wrong, there is simply nothing to index.
        return { chunks: 0, skipped: true, reason: 'no extractable text' };
    }

    const rows: Array<{
        pageIndex: number;
        pageLabel?: string | null;
        chunkIndex: number;
        text: string;
        embedding: Uint8Array;
        sentenceStart?: number | null;
        sentenceEnd?: number | null;
    }> = [];

    let dimensions = 0;
    for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
        const batch = chunks.slice(start, start + EMBED_BATCH);
        const response = await options.provider.generateEmbeddings(
            batch.map((chunk, i) => ({
                item_id: start + i,
                text: cleanChunkForEmbedding(chunk.text),
            })),
        );

        for (const result of response.embeddings) {
            const chunk = chunks[result.item_id];
            if (!chunk) continue;
            dimensions = result.dimensions;
            rows.push({
                pageIndex: chunk.pageIndex,
                pageLabel: chunk.pageLabel ?? null,
                chunkIndex: result.item_id,
                text: chunk.text,
                embedding: new Uint8Array(new Int8Array(result.embedding).buffer),
                sentenceStart: chunk.sentenceStart ?? null,
                sentenceEnd: chunk.sentenceEnd ?? null,
            });
        }
    }

    if (rows.length === 0) {
        return { chunks: 0, skipped: true, reason: 'provider returned no vectors' };
    }

    await options.store.replaceChunks(
        options.libraryId,
        options.attachmentKey,
        options.parentKey ?? null,
        options.modelId,
        dimensions,
        rows,
    );
    return { chunks: rows.length, skipped: false };
}

/**
 * Search the indexed passages.
 *
 * At most one hit per document by default: ten chunks from the same paper is a
 * worse answer to "which of my papers says X" than one chunk from each of ten
 * papers, and the model can read further with `read_document`.
 */
export async function searchChunks(options: {
    store: ChunkStore;
    provider: EmbeddingProvider;
    modelId: string;
    query: string;
    limit?: number;
    minSimilarity?: number;
    libraryIds?: number[];
    /**
     * The documents that may be returned, as `<library>-<attachment>`: the PDFs
     * in the library now. Passages of a PDF since trashed or deleted, or of a
     * library that is gone, are passed over.
     */
    attachments?: ReadonlySet<string>;
    perDocument?: number;
}): Promise<FulltextHit[]> {
    const limit = options.limit ?? 8;
    const minSimilarity = options.minSimilarity ?? 0.25;
    const perDocument = options.perDocument ?? 1;

    const [queryResult, chunks] = await Promise.all([
        options.provider.generateQueryEmbedding(options.query),
        options.store.getChunksForSearch(options.modelId, options.libraryIds),
    ]);
    if (chunks.length === 0) return [];

    const queryVector = quantizeToInt8(queryResult.embedding);
    const scored: FulltextHit[] = [];
    for (const chunk of chunks) {
        if (options.attachments && !options.attachments.has(`${chunk.libraryId}-${chunk.attachmentKey}`)) continue;
        const similarity = int8Cosine(queryVector, chunk.embedding);
        if (similarity < minSimilarity) continue;
        scored.push({
            libraryId: chunk.libraryId,
            attachmentKey: chunk.attachmentKey,
            parentKey: chunk.parentKey,
            page: chunk.pageIndex + 1,
            pageLabel: chunk.pageLabel,
            text: chunk.text,
            similarity,
            sentenceStart: chunk.sentenceStart ?? null,
            sentenceEnd: chunk.sentenceEnd ?? null,
        });
    }

    scored.sort((a, b) => b.similarity - a.similarity);

    const perDocumentCount = new Map<string, number>();
    const kept: FulltextHit[] = [];
    for (const hit of scored) {
        const key = `${hit.libraryId}-${hit.attachmentKey}`;
        const seen = perDocumentCount.get(key) ?? 0;
        if (seen >= perDocument) continue;
        perDocumentCount.set(key, seen + 1);
        kept.push(hit);
        if (kept.length >= limit) break;
    }
    return kept;
}
