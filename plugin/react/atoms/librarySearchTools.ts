/**
 * The two library-wide searches that run over AlphainZ's own index: passages by
 * meaning (`search_library_fulltext`) and pages by what their figures show
 * (`search_library_figures`).
 *
 * Shared by the assistant's runs and by the MCP server, so a client outside
 * Zotero gets the same results, coverage notes and library exclusions as the
 * sidebar.
 */

import { store } from '../store';
import { searchableLibraryIdsAtom } from './profile';
import { listAllCandidates } from './fulltextIndex';
import { figureCoverageNoteFor, pageImageProvider } from './pageImageIndex';
import { recordShownLocators, recordShownPassage, sentenceRangeNumbers } from '../utils/highlightCitations';
import { candidateKey, coverageNote, type FulltextCandidate } from '../../src/services/llm/fulltextIndexer';
import { searchChunks } from '../../src/services/llm/fulltextIndex';
import { searchPageImages } from '../../src/services/llm/pageImageIndex';
import {
    buildEmbeddingProviderFromPrefs,
    currentEmbeddingModelId,
    isSemanticSearchAvailable,
} from '../../src/services/llm/agentConfig';
import { clampLimit } from '../../src/services/llm/toolSchemas';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { getPref } from '../../src/utils/prefs';
import { isLibraryAccessReady } from '../../src/services/agentDataProvider/utils';

/**
 * One sentence on how much of the library the index covers, or none when it
 * covers all of it.
 *
 * Counting PDFs is cheap next to an embedding round trip, and the alternative is
 * a search that quietly speaks for a quarter of the library as if it spoke for
 * all of it.
 */
async function fulltextCoverageNote(db: any, modelId: string, listed?: FulltextCandidate[]): Promise<string | null> {
    try {
        // Counted over the searchable libraries' PDFs on both sides: passages of
        // a PDF since deleted, or of an excluded library, cover nothing searched.
        const [indexed, candidates] = await Promise.all([
            db.getChunkedAttachmentKeys(modelId) as Promise<Set<string>>,
            listed ?? listAllCandidates({ titles: false }),
        ]);
        const covered = candidates.filter((candidate) => indexed.has(candidateKey(candidate))).length;
        return coverageNote(covered, candidates.length);
    } catch {
        return null;
    }
}

/** What a library search says when every library is excluded in the settings. */
const NO_SEARCHABLE_LIBRARY = 'No library can be searched: every library is excluded in AlphainZ\'s settings.';

/**
 * The libraries a search may cover, or a refusal when that cannot be known yet.
 *
 * Until the library list has loaded, the searchable set is empty to fail
 * closed — which would read as "every library is excluded" when nothing is.
 */
function searchableLibraries(): number[] {
    if (!isLibraryAccessReady()) {
        throw new Error('The library list is still loading. Try again in a moment.');
    }
    return store.get(searchableLibraryIdsAtom);
}

/** The query a search was called with; a search for nothing is refused rather than run. */
function requiredQuery(tool: string, args: Record<string, unknown>): string {
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error(`${tool} requires: query.`);
    return query;
}

interface Hit {
    libraryId: number;
    attachmentKey: string;
    parentKey: string | null;
}

/**
 * The items behind some hits, with their field data loaded.
 *
 * Zotero loads field data lazily — for a group library, not yet a moment after
 * startup — and reading a title before it is loaded throws. One batch load
 * covers every hit.
 */
async function itemsForHits(hits: Hit[]): Promise<Map<string, Zotero.Item>> {
    const items = new Map<string, Zotero.Item>();
    for (const hit of hits) {
        for (const key of [hit.parentKey, hit.attachmentKey]) {
            if (!key || items.has(`${hit.libraryId}/${key}`)) continue;
            const item = Zotero.Items.getByLibraryAndKey(hit.libraryId, key) as Zotero.Item | false;
            if (item) items.set(`${hit.libraryId}/${key}`, item);
        }
    }
    if (items.size > 0) {
        try {
            await Zotero.Items.loadDataTypes([...items.values()], ['itemData']);
        } catch {
            // A title that still cannot be read is left out below; the hit is not.
        }
    }
    return items;
}

/** The title of the paper a hit belongs to, or of its PDF when it has no paper. */
function hitTitle(items: Map<string, Zotero.Item>, hit: Hit): string | null {
    const parent = hit.parentKey ? items.get(`${hit.libraryId}/${hit.parentKey}`) : undefined;
    const attachment = items.get(`${hit.libraryId}/${hit.attachmentKey}`);
    try {
        if (parent) return parent.getField('title') || null;
        return attachment ? (attachment.getDisplayTitle?.() ?? null) : null;
    } catch {
        return null;
    }
}

/**
 * Full-text passage search over the whole library.
 *
 * Offered when an embedding provider is configured and full-text search is on.
 * Every answer states how much of the library the index covers, so a thin
 * result over a partly built index is not read as "the library has nothing".
 */
export function fulltextTool(runId?: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
    return {
        search_library_fulltext: async (args) => {
            const provider = buildEmbeddingProviderFromPrefs();
            const modelId = currentEmbeddingModelId();
            const db = (Zotero as any).AlphainZ?.db;
            if (!provider || !modelId || !db) {
                throw new Error('Full-text search needs an embedding provider configured.');
            }

            const query = requiredQuery('search_library_fulltext', args);
            const libraryIds = searchableLibraries();
            if (libraryIds.length === 0) return { matches: [], note: NO_SEARCHABLE_LIBRARY };
            // The PDFs in the library now: what is searched, and what coverage
            // is counted against.
            const candidates = await listAllCandidates({ titles: false });
            const hits = await searchChunks({
                store: db,
                provider,
                modelId,
                query,
                libraryIds,
                attachments: new Set(candidates.map(candidateKey)),
                ...(args.limit != null ? { limit: clampLimit(args.limit, 8) } : {}),
            });

            // Every answer states how much of the library was actually
            // searched. Without it the model reads a thin result as evidence
            // the library has nothing on the subject, when the real answer is
            // that most of the library has never been indexed.
            const coverage = await fulltextCoverageNote(db, modelId, candidates);

            if (hits.length === 0) {
                return {
                    matches: [],
                    note: `No indexed passage matched.${coverage ? ` ${coverage}` : ''}`,
                };
            }

            // Resolved to titles here rather than left as keys: a list of item
            // keys is not something the model can report back to the user.
            const items = await itemsForHits(hits);
            return {
                ...(coverage ? { coverage } : {}),
                matches: hits.map((hit) => {
                    const attachmentId = `${libraryRefForLibraryID(hit.libraryId) ?? hit.libraryId}-${hit.attachmentKey}`;
                    /*
                     * The ready-made citation tag, sentence range included when
                     * the index knows it. Handed to the model finished, the way
                     * read_document and search_in_document hand theirs over — a
                     * requirement that has to hold cannot live in the prompt.
                     *
                     * The range spans the whole chunk, so the click highlights
                     * the passage, not one sentence — honest for a semantic
                     * match, which is over the block. `page` stays in the tag
                     * so a document indexed before sentence-aware chunking (or
                     * whose structured cache is gone) degrades to a page jump.
                     *
                     * The passage is remembered too (recordShownPassage), so
                     * a citation carrying this range shows it on its hover
                     * card, clipped at a word boundary, never mid-word.
                     */
                    const loc = hit.sentenceStart != null && hit.sentenceEnd != null
                        ? (hit.sentenceStart === hit.sentenceEnd
                            ? ` loc="s${hit.sentenceStart}"`
                            : ` loc="s${hit.sentenceStart}-s${hit.sentenceEnd}"`)
                        : '';
                    // Handed out, so it counts as shown when the answer is checked.
                    if (runId && hit.sentenceStart != null && hit.sentenceEnd != null) {
                        recordShownLocators(runId, attachmentId, sentenceRangeNumbers(hit.sentenceStart, hit.sentenceEnd));
                        recordShownPassage(runId, attachmentId, {
                            start: hit.sentenceStart,
                            end: hit.sentenceEnd,
                            page: hit.page,
                            text: hit.text,
                        });
                    }
                    return {
                        attachment_id: attachmentId,
                        title: hitTitle(items, hit),
                        page: hit.page,
                        ...(hit.pageLabel ? { page_label: hit.pageLabel } : {}),
                        similarity: Number(hit.similarity.toFixed(3)),
                        cite: `<citation id="${attachmentId}" page="${hit.page}"${loc}/>`,
                        passage: hit.text.length > 700 ? `${hit.text.slice(0, 700)}…` : hit.text,
                    };
                }),
            };
        },
    };
}


/**
 * Whether figure search can be offered to the assistant: the embedding model
 * takes pictures, its page-image index has something in it, and the chat model
 * can look at what it finds.
 */
export async function figureSearchAvailable(readsImages: boolean): Promise<boolean> {
    if (!readsImages || !isSemanticSearchAvailable() || getPref('fulltextSearchEnabled') === false) return false;
    const modelId = currentEmbeddingModelId();
    const db = (Zotero as any).AlphainZ?.db;
    if (!modelId || !db?.getPageImagedAttachmentKeys || !pageImageProvider()) return false;
    try {
        // Page images of a PDF in a searchable library, not just any row: an
        // excluded library's, or a deleted PDF's, would offer a search that
        // can only come back empty.
        const [done, candidates] = await Promise.all([
            db.getPageImagedAttachmentKeys(modelId) as Promise<Set<string>>,
            listAllCandidates({ titles: false }),
        ]);
        return candidates.some((candidate) => done.has(candidateKey(candidate)));
    } catch {
        return false;
    }
}

export function figuresTool(): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
    return {
        search_library_figures: async (args) => {
            const provider = pageImageProvider();
            const modelId = currentEmbeddingModelId();
            const db = (Zotero as any).AlphainZ?.db;
            if (!provider || !modelId || !db) {
                throw new Error('Figure search needs an embedding model that takes pictures (Google Gemini or Ollama EmbeddingGemma 2).');
            }
            const query = requiredQuery('search_library_figures', args);
            const libraryIds = searchableLibraries();
            if (libraryIds.length === 0) return { pages: [], note: NO_SEARCHABLE_LIBRARY };
            const candidates = await listAllCandidates({ titles: false });
            // As with passages, every answer says how much of the library was
            // searched: while page images are still being built, a figure that
            // is not found may only be in a PDF that has none yet.
            const [hits, coverage] = await Promise.all([
                searchPageImages({
                    store: db,
                    provider,
                    modelId,
                    query,
                    libraryIds,
                    attachments: new Set(candidates.map(candidateKey)),
                    ...(args.limit != null ? { limit: clampLimit(args.limit, 6) } : {}),
                }),
                figureCoverageNoteFor(modelId, candidates),
            ]);
            if (hits.length === 0) {
                return { pages: [], note: `No indexed page image matched.${coverage ? ` ${coverage}` : ''}` };
            }
            const items = await itemsForHits(hits);
            return {
                note: 'Pages, ranked by how closely they look like the description. Look at one with view_page_images '
                    + 'before saying what it shows.',
                ...(coverage ? { coverage } : {}),
                pages: hits.map((hit) => {
                    const attachmentId = `${libraryRefForLibraryID(hit.libraryId) ?? hit.libraryId}-${hit.attachmentKey}`;
                    return {
                        attachment_id: attachmentId,
                        title: hitTitle(items, hit),
                        page: hit.page,
                        ...(hit.pageLabel ? { page_label: hit.pageLabel } : {}),
                        similarity: Number(hit.similarity.toFixed(3)),
                        cite: `<citation id="${attachmentId}" page="${hit.page}"/>`,
                    };
                }),
            };
        },
    };
}
