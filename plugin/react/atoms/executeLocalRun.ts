/**
 * Run one agent turn in this client, driving the chat UI's existing callbacks.
 *
 * The counterpart to `executeWSRequest`: same inputs (`AgentRun`,
 * `AgentRunRequest`, the Jotai getter/setter), same effect on the store — but
 * the model is called from here with the user's own key instead of over a
 * WebSocket to a backend.
 *
 * Lives on the React side because it needs the store and `createWSCallbacks`.
 * Everything it composes is pure and tested separately; this file is the seam.
 */

import { activeRunAtom, allRunsAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { isRunActive, type AgentRun } from '@beaver/agent-core/agents/types';
import type { AgentRunRequest } from '@beaver/agent-core/protocol/agentProtocol';
import type { Getter, Setter } from 'jotai';

import {
    buildAgentFromPrefs,
    buildAgentSystemPrompt,
    refreshSemanticSearchAvailability,
} from '../../src/services/llm/agentConfig';
import { threadCompactionAtom } from './threadCompaction';
import { runLocalAgent } from '../../src/services/llm/localRunner';
import { candidateKey, coverageNote, type FulltextCandidate } from '../../src/services/llm/fulltextIndexer';
import {
    attachedImagesFromPrompt,
    buildRunMessages,
    type RunLike,
} from '../../src/services/llm/runRequestToMessages';
import { dataProviderToolDispatcher } from '../../src/services/llm/zoteroToolDispatch';
import type { ToolDispatcher } from '../../src/services/llm/agentLoop';
import {
    addAgentActionsAtom,
    addPendingApprovalAtom,
    beginProposalOutcomeAtom,
    endProposalOutcomeAtom,
    removePendingApprovalAtom,
    upsertAgentActionsAtom,
} from '../agents/agentActions';
import { addWarningAtom } from './warnings';
import {
    recordProposedHighlight,
    recordReadAttachment,
    recordShownLocators,
    recordShownPassage,
    recordShownSentences,
    sentenceLabelsIn,
    sentenceRangeNumbers,
    sentenceTextsIn,
} from '../utils/highlightCitations';
import { addExternalReferencesToMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { checkExternalReferencesAtom } from './externalReferences';
import {
    chosenImportDestination,
    currentDestination,
    destinationChoices,
    importDestinationAtom,
    resolveImportDestination,
} from './importDestination';
import { indexItemAttachmentsAtom, listAllCandidates } from './fulltextIndex';
import { awaitApproval, nextApprovalId } from '../utils/localApprovals';
import { awaitAnswer, nextQuestionId, resolveLocalQuestion, type QuestionOutcome } from '../utils/localQuestions';
import { addPendingQuestionAtom, removePendingQuestionAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { notifyUserQuestion } from '../../src/services/systemNotifications';
import { searchableLibraryIdsAtom } from './profile';
import { store } from '../store';
import { OpenAlexClient, formatWorksForModel, type OpenAlexWork } from '../../src/services/literature/openalex';
import { createZoteroDataProvider } from '../../src/services/zoteroDataProvider';
import { getDeferredToolPreference } from '../../src/services/agentDataProvider/utils';
import type { ToolSchema } from '../../src/services/llm/types';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../src/utils/prefs';
import { locateWithPageHint, sentencesByLength, suggestNearbyPassages } from '../../src/services/llm/locateText';
import {
    buildLocatorIndex,
    MAX_LOCATOR_SPAN,
    nearbyLocators,
    resolveLocator,
} from '../../src/services/llm/sentenceLocators';
import {
    buildEmbeddingProviderFromPrefs,
    currentEmbeddingModelId,
    isSemanticSearchAvailable,
} from '../../src/services/llm/agentConfig';
import { embeddingFailureSince } from '../../src/services/llm/embeddingHealth';
import { searchPageImages } from '../../src/services/llm/pageImageIndex';
import { figureCoverageNoteFor, pageImageProvider } from './pageImageIndex';
import {
    ASK_USER_QUESTION_TOOL,
    buildHighlightAction,
    FIGURE_TOOL_SCHEMA,
    FULLTEXT_TOOL_SCHEMA,
    LITERATURE_GRAPH_TOOLS,
    MAX_QUESTIONS_PER_CALL,
    RETURN_SUGGESTIONS_TOOL,
    HIGHLIGHT_COLOR_NAMES,
    isHighlightColorName,
    MAX_ANNOTATION_EDITS,
    MAX_ORGANIZE_ITEMS,
    WRITE_TOOL_SCHEMAS,
} from '../../src/services/llm/writeTools';
import { searchChunks } from '../../src/services/llm/fulltextIndex';
import {
    libraryRefForLibraryID,
    parseItemReference,
    resolveItemReference,
    resolveObjectId,
} from '../../src/utils/libraryIdentity';
import { getBestAttachmentByKind } from '../../src/utils/zoteroItemHelpers';
import { clampLimit, parseCompositeItemId } from '../../src/services/llm/toolSchemas';
import { flattenProviderResponse } from '../../src/services/llm/zoteroToolDispatch';
import {
    DEFAULT_MAX_LIBRARY_SEARCHES,
    DEFAULT_MAX_LITERATURE_LOOKUPS,
    readRunLimits,
} from '../../src/services/llm/runLimits';
import { createWSCallbacks } from './agentRunAtoms';

/**
 * `fetch` bound to its global.
 *
 * Zotero's privileged context makes `fetch` a Window method, so passing the
 * bare reference loses its receiver and every call fails with "'fetch' called
 * on an object that does not implement interface Window". Unit tests inject a
 * fake and never see it, which is exactly why it survived to a live run.
 */
const boundFetch = ((url: string, init?: any) => fetch(url, init)) as typeof fetch;

/**
 * What a tool reports when its run was stopped while it worked.
 *
 * Thrown, never returned as a result: the loop settles as cancelled as soon as
 * the tool comes back, and an error cannot be read as something to carry on
 * from — which is what a skipped question or a "proposed" write would tell the
 * model otherwise.
 */
const RUN_STOPPED = 'The user stopped this run, so nothing more was done.';

/**
 * Whether a run has been stopped: its signal aborted, or it no longer holds the
 * active slot as a live run.
 *
 * The slot is checked as well as the signal because Stop, New chat and Switch
 * chat all give it up, and a loop that outlives its run must not act for the
 * user on any path where the signal did not reach it.
 */
function runStopped(get: Getter, runId: string, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    const active = get(activeRunAtom);
    return !active || active.id !== runId || !isRunActive(active);
}

/**
 * Web literature search, run in-process.
 *
 * OpenAlex needs no key, so this tool works even before a model is configured —
 * and it is the one tool whose data does not come from Zotero, which is why it
 * is declared here rather than in the Zotero registry.
 */
const WEB_SEARCH_TOOL: ToolSchema = {
    name: 'search_web_literature',
    description:
        'Search the global scholarly literature (OpenAlex, ~250M works) for papers not necessarily in the library. Use for recent work, papers the user does not have, or checking whether something exists.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Topic or title keywords.' },
            from_year: { type: 'integer', description: 'Earliest publication year.' },
            open_access_only: {
                type: 'boolean',
                description: 'Only works with a freely readable full text.',
            },
        },
        required: ['query'],
    },
};

/**
 * Searches of the wider literature one question may make.
 *
 * Verifying a claim takes one search, or two if the first was badly phrased.
 * Beyond that the model is not checking, it is rephrasing: asked for a current
 * record, one run made thirty-nine searches, ran out of steps and never wrote
 * an answer. Asking for restraint in the prompt did not hold — the same
 * question came back with thirty-three — so the limit is enforced here, where
 * it cannot be reasoned around.
 *
 * The cap refuses further searches rather than failing the run: the results
 * already in hand are usually enough, and the refusal says so. The number is
 * the user's to change (Settings → Advanced, `runLimits.ts`) and is shared
 * with the other three OpenAlex tools — see `LiteratureBudget`.
 */

/**
 * Transport failures before the tool stops accepting calls for this run.
 *
 * OpenAlex went down mid-question and returned 503 four times running. Each
 * failure reached the model as a thrown tool error, which reads as "you called
 * it wrong" — so it rephrased and called again, burned the whole search budget
 * on a service that was not answering, and then wrote the user a long paragraph
 * about OpenAlex's cluster load. None of that was information the user wanted.
 *
 * Two is enough to tell a blip from an outage. After that the tool answers
 * without going near the network, so a retry is not something the model can
 * choose.
 */
const MAX_WEB_SEARCH_OUTAGES = 2;

/**
 * How many library searches one question may make, across all three tools.
 *
 * The web search has had a budget since a run spent thirty-nine of them; the
 * library searches had none, and behave the same way. Measured over
 * fifty-two questions: one asked for papers by two different groups and made
 * sixteen `item_search_by_metadata` calls — "sleep", then "sleep spindles",
 * then "sleep spindle density memory consolidation older adults", each a rephrasing
 * of the last — 652k input tokens and three minutes for one answer.
 *
 * The cap began at six, with a refusal that says to use what came back rather
 * than try again differently. Six stopped real questions short, so the default
 * is now twenty and the number is the user's to change (Settings → Advanced,
 * `runLimits.ts`); the runs above are why there is a number at all.
 */

/** The three tools that search the library, sharing one budget. */
const LIBRARY_SEARCH_TOOLS = [
    'item_search_by_topic',
    'item_search_by_metadata',
    'search_library_fulltext',
    'search_library_figures',
] as const;

/**
 * Wrap the library searches in a shared budget.
 *
 * A cap in the tool, not a line in the prompt: the prompt already says to stop
 * after one or two searches, and the runs above are what that instruction is
 * worth once a model has decided it has not found the paper yet.
 */
/** Exported for the budget's own test; the runner uses it directly. */
export const withLibrarySearchBudgetForTest = (
    d: ToolDispatcher,
    limit: number | null = DEFAULT_MAX_LIBRARY_SEARCHES,
) => withLibrarySearchBudget(d, limit);

function withLibrarySearchBudget(dispatch: ToolDispatcher, limit: number | null): ToolDispatcher {
    // No limit: the request limit still bounds the run.
    if (limit === null) return dispatch;
    const budget = { used: 0 };
    const searches = new Set<string>(LIBRARY_SEARCH_TOOLS);
    return async (name, args, context) => {
        if (!searches.has(name)) return dispatch(name, args, context);
        budget.used += 1;
        if (budget.used > limit) {
            return {
                refused: true,
                note:
                    `Library searches are capped at ${limit} per question `
                    + 'and this one has used them all. Answer from what the earlier searches '
                    + 'returned, and say plainly which part you could not confirm. Rephrasing '
                    + 'the query again will not be run. If the user needs more, the limit is '
                    + '"Library searches per question" in Settings → Advanced.',
            };
        }
        return dispatch(name, args, context);
    };
}

/**
 * One question's literature budget, shared by all four OpenAlex tools.
 *
 * The web search used to keep its own counter beside the other three's, so a
 * question could make eight lookups while the prompt told the model it had
 * four. One object, handed to both factories, is the one budget the prompt
 * describes.
 */
interface LiteratureBudget {
    used: number;
    outages: number;
    /** Lookups allowed; null is no limit. */
    limit: number | null;
    /**
     * Set once OpenAlex has refused the key: every later call answers with it
     * without going near the network, since the next call would be refused
     * the same way.
     */
    refusal: string | null;
}

function literatureBudget(limit: number | null = DEFAULT_MAX_LITERATURE_LOOKUPS): LiteratureBudget {
    return { used: 0, outages: 0, limit, refusal: null };
}

/** The refusal once the shared budget is spent, or null while calls remain. */
function spendLiteratureLookup(budget: LiteratureBudget): string | null {
    budget.used += 1;
    if (budget.limit === null || budget.used <= budget.limit) return null;
    return (
        `Literature lookups are capped at ${budget.limit} per question, and that is reached. `
        + 'Answer from what the earlier calls returned. If none of it settles the point, say so '
        + 'plainly and name what is unconfirmed — that is a better answer than another lookup. '
        + 'If the user needs more, the limit is "Literature lookups per question" in Settings → Advanced.'
    );
}

export function webSearchToolForTest(
    set: Setter = (() => {}) as unknown as Setter,
    budget: LiteratureBudget = literatureBudget(),
    signal?: AbortSignal,
) {
    return webSearchTool(new Map(), set, budget, signal);
}

export function literatureToolsForTest(
    set: Setter = (() => {}) as unknown as Setter,
    budget: LiteratureBudget = literatureBudget(),
    signal?: AbortSignal,
) {
    return literatureTools(new Map(), set, budget, signal);
}

/** A fresh shared budget, for tests that hand one to both factories. */
export const literatureBudgetForTest = (limit?: number | null) => literatureBudget(limit);

type LiteratureCache = Map<string, OpenAlexWork>;

/**
 * Ask the user a question and wait for the answer.
 *
 * Every part of this — the card, the chips, the "Other" field, the system
 * notification when the panel is not on screen — has been in the tree since the
 * fork and could never appear, because the tool that raises it was one Beaver's
 * backend offered. The model found the gap on its own: asked to colour-code a
 * paper under a constraint it could not satisfy, it spent a turn deliberating
 * and then wrote its question into the answer, where answering meant starting
 * the run again.
 *
 * This is the one tool that deliberately blocks. `resolveAllLocalQuestions`
 * covers every way a run can end without an answer, and a run that is stopped
 * while the card is up releases it itself.
 */
/** A chip label that fits, cut between words rather than through one. */
function shortHeader(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= 12) return trimmed;
    const cut = trimmed.slice(0, 12);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace >= 4 ? cut.slice(0, lastSpace) : cut).trim();
}

/** The question tool, for tests that drive it without a run. */
export function askUserQuestionToolForTest(
    set: Setter,
    signal?: AbortSignal,
    isStopped: () => boolean = () => signal?.aborted === true,
) {
    return askUserQuestionTool(set, signal, isStopped);
}

function askUserQuestionTool(
    set: Setter,
    signal: AbortSignal | undefined,
    isStopped: () => boolean,
) {
    return async (args: Record<string, unknown>, context: { toolCallId: string }) => {
        if (isStopped()) throw new Error(RUN_STOPPED);
        const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
        if (rawQuestions.length === 0) throw new Error('questions is required.');
        if (rawQuestions.length > MAX_QUESTIONS_PER_CALL) {
            throw new Error(
                `That is ${rawQuestions.length} questions; ${MAX_QUESTIONS_PER_CALL} is the most `
                + 'one card can hold. Ask the ones that change what you would do.',
            );
        }

        const questions = rawQuestions.map((raw: any, index: number) => {
            const text = String(raw?.question ?? '').trim();
            if (!text) throw new Error(`questions[${index}] has no question text.`);
            const options = (Array.isArray(raw?.options) ? raw.options : [])
                .map((option: any, optionIndex: number) => ({
                    id: `q${index}o${optionIndex}`,
                    label: String(option?.label ?? '').trim(),
                    ...(option?.description ? { description: String(option.description) } : {}),
                }))
                .filter((option: any) => option.label);
            if (options.length < 2) {
                throw new Error(
                    `questions[${index}] needs at least two options. A question with one answer is `
                    + 'not a question — state the assumption in your answer instead.',
                );
            }
            return {
                id: `q${index}`,
                // Trimmed at a word boundary: the card's chip is ~12 characters
                // and a hard slice produced "Colour schem", which reads as a
                // rendering bug rather than a label.
                ...(raw?.header ? { header: shortHeader(String(raw.header)) } : {}),
                question: text,
                options,
                allow_multiple: raw?.allow_multiple === true,
                allow_custom: raw?.allow_custom === true,
            };
        });

        const questionId = nextQuestionId();
        const answer = awaitAnswer(questionId);
        const event = {
            event: 'ask_user_question_request' as const,
            question_id: questionId,
            toolcall_id: context.toolCallId,
            ...(args.title ? { title: String(args.title) } : {}),
            questions,
        };
        // Stopping the run answers its question: nobody is left to read the
        // answer, and a card still waiting would hold the composer.
        const releaseOnStop = () => { resolveLocalQuestion(questionId, [], true); };
        signal?.addEventListener('abort', releaseOnStop, { once: true });
        set(addPendingQuestionAtom, event as any);
        notifyUserQuestion(event as any);

        let outcome: QuestionOutcome;
        try {
            outcome = await answer;
        } finally {
            signal?.removeEventListener('abort', releaseOnStop);
            set(removePendingQuestionAtom, context.toolCallId);
        }

        /*
         * A stop is not a skip.
         *
         * Stopping clears the card the same way the Skip button does, and a
         * skip tells the model to decide for itself and carry on — which after
         * a stop would have it keep working on an answer nobody wants. The
         * run's own state says which one happened.
         */
        if (isStopped()) throw new Error(RUN_STOPPED);

        if (outcome.cancelled) {
            return (
                'The user skipped the question. Do not ask again — decide for yourself, say in '
                + 'one sentence what you assumed, and carry on.'
            );
        }

        const byId = new Map(questions.map((q) => [q.id, q]));
        const lines = outcome.answers.map((given) => {
            const question = byId.get(given.item_id);
            const labels = (given.selected_option_ids ?? [])
                .map((id) => question?.options.find((o: any) => o.id === id)?.label)
                .filter(Boolean);
            if (given.custom_text) labels.push(given.custom_text);
            return `${question?.question ?? given.item_id} → ${labels.join('; ') || '(no answer)'}`;
        });
        return `The user answered:\n${lines.join('\n')}\n\nCarry on with those answers; do not ask again.`;
    };
}


/**
 * The attachment a highlight actually lands on.
 *
 * An annotation hangs off a file, not off a paper. The model is given whatever
 * id a search returned, which for an attached paper is the *item* — and the
 * geometry lookup accepts that happily, because document extraction resolves an
 * item to its PDF on its own. So a highlight would be located correctly and
 * proposed against the parent, and the write then failed at the far end with
 * "Resolved item is not a local PDF or EPUB attachment" — after the user had
 * clicked Apply, on a card that looked exactly like one that would work.
 *
 * Resolving here means the id is either an attachment before the card is built
 * or the call fails immediately, where the model can still do something about
 * it.
 */
async function resolveHighlightTarget(
    reference: { library_id?: number; library_ref?: string; zotero_key: string },
    modelFacingId: string,
): Promise<{ library_id: number; library_ref?: string; zotero_key: string }> {
    const resolved = await resolveItemReference(reference as any);
    if (resolved.status !== 'found') {
        throw new Error(
            `Could not find "${modelFacingId}" in the library. Use an id a search returned.`,
        );
    }
    const item: any = resolved.item;
    if (item.isAttachment?.()) {
        return {
            library_id: item.libraryID,
            zotero_key: item.key,
            ...(libraryRefForLibraryID(item.libraryID)
                ? { library_ref: libraryRefForLibraryID(item.libraryID) as string }
                : {}),
        };
    }
    const attachment = await getBestAttachmentByKind(item, 'pdf');
    if (!attachment) {
        throw new Error(
            `"${modelFacingId}" has no PDF attachment to highlight. Highlights go on a file; `
            + 'use the attachment id from a search result.',
        );
    }
    return {
        library_id: attachment.libraryID,
        zotero_key: attachment.key,
        ...(libraryRefForLibraryID(attachment.libraryID)
            ? { library_ref: libraryRefForLibraryID(attachment.libraryID) as string }
            : {}),
    };
}

/**
 * A collection key, with the item-id prefix removed if the model added one.
 *
 * Item ids are `u-KEY` and collection keys are bare, and a model reads both as
 * "an id in this library". Asked to nest three sub-collections it passed
 * `u-8YEHB3J9` for all three, was told the rule, and got it right on the next
 * turn — three tool calls and a round trip to learn something the tool can
 * simply accept. The prefix carries no information here: a collection key is
 * already scoped to its library.
 */
/** A list of trimmed strings from whatever the model passed. */
function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((v) => String(v).trim()).filter(Boolean)
        : [];
}

/**
 * Annotation ids as item references.
 *
 * Capped, and the cap is here rather than in the prompt: a model told to
 * "recolour the blue ones" against a heavily annotated paper will happily pass
 * every id it can see, and an approval card listing four hundred annotations is
 * not a decision anyone can take.
 */
function annotationRefs(value: unknown): Array<Record<string, unknown>> {
    const ids = stringList(value);
    if (ids.length === 0) throw new Error('annotation_ids is required.');
    if (ids.length > MAX_ANNOTATION_EDITS) {
        throw new Error(
            `That is ${ids.length} annotations; ${MAX_ANNOTATION_EDITS} is the most one call may `
            + 'change. Narrow the selection — the user has to be able to read the card.',
        );
    }
    return ids.map((id) => {
        const reference = parseCompositeItemId(id);
        if (!reference) {
            throw new Error(
                `annotation_id "${id}" is not a valid id. Use the ids `
                + '`find_annotations` or `get_annotations` returned.',
            );
        }
        return reference as unknown as Record<string, unknown>;
    });
}

function collectionKey(value: string): string {
    const trimmed = value.trim();
    const parsed = parseItemReference(trimmed);
    return parsed ? parsed.zotero_key : trimmed;
}

/**
 * A note's title and body, when the model may not have given a title.
 *
 * The title is optional for the model but required to save a note, and the
 * executor writes it as the note's heading. So a body that opens with its own
 * heading gives up that heading as the title rather than carrying it twice;
 * with no heading to use, the note is called "Note".
 */
function noteTitleAndBody(rawTitle: unknown, content: string): { title: string; content: string } {
    const given = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (given) return { title: given, content };

    const markdown = /^#{1,6}[ \t]+([^\n]*?)[ \t#]*(?:\n|$)/.exec(content);
    const html = /^<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(content);
    const heading = markdown
        ? markdown[1].trim()
        : html
            ? html[2].replace(/<[^>]*>/g, '').trim()
            : '';
    if (!heading) return { title: 'Note', content };

    const rest = content.slice((markdown ?? html)![0].length).trim();
    // A body that is nothing but its heading keeps it: an empty note is refused.
    return { title: heading, content: rest || content };
}

/** A library as a write payload names it: its portable ref when it has one. */
type LibraryTarget = { library_ref: string } | { library_id: number };

/**
 * The library a new collection has to be created in.
 *
 * A collection lives in one library, and so must everything filed into it and
 * the collection it nests under. Item ids, and a parent key the model wrote
 * with its prefix, say which library they are in; a bare parent key is looked
 * up among the libraries the agent may use. With nothing to go on, the
 * collection goes in My Library. Items or a parent from different libraries
 * cannot share one collection, and saying so beats a card that fails on Apply.
 */
function newCollectionLibrary(itemIds: string[], rawParentKey: string, parentKey: string): LibraryTarget {
    const found = new Map<string, LibraryTarget>();
    const keyOf = (reference: { library_id: number; library_ref?: string }) =>
        reference.library_ref ?? String(reference.library_id);
    const remember = (reference: { library_id: number; library_ref?: string } | null) => {
        if (!reference) return;
        found.set(
            keyOf(reference),
            reference.library_ref ? { library_ref: reference.library_ref } : { library_id: reference.library_id },
        );
    };

    for (const id of itemIds) remember(resolveObjectId(id));
    if (parentKey) {
        const prefixed = rawParentKey.trim();
        if (parseItemReference(prefixed)) {
            remember(resolveObjectId(prefixed));
        } else {
            const holders = librariesHoldingCollection(parentKey);
            const alreadyNamed = holders.some((reference) => found.has(keyOf(reference)));
            if (!alreadyNamed && holders.length === 1) remember(holders[0]);
        }
    }

    if (found.size > 1) {
        throw new Error(
            'These items (and the parent collection, if you gave one) are in different libraries, '
            + 'and a collection lives in exactly one. Make one collection per library — a '
            + 'create_collection call each, with only that library\'s items.',
        );
    }
    return found.values().next().value ?? { library_ref: 'u' };
}

/** The libraries the agent may use that hold a collection with this key. */
function librariesHoldingCollection(key: string): Array<{ library_id: number; library_ref?: string }> {
    const holders: Array<{ library_id: number; library_ref?: string }> = [];
    try {
        for (const libraryId of store.get(searchableLibraryIdsAtom)) {
            if (!Zotero.Collections.getByLibraryAndKey(libraryId, key)) continue;
            const libraryRef = libraryRefForLibraryID(libraryId);
            holders.push({ library_id: libraryId, ...(libraryRef ? { library_ref: libraryRef } : {}) });
        }
    } catch (error) {
        logger(`librariesHoldingCollection: ${error}`, 1);
    }
    return holders;
}

/**
 * Where a newly created item actually landed.
 *
 * "Applied" on its own does not answer the question the user is left with —
 * which library, and which collection, so they can go and look at it. The
 * executor returns only the key it wrote, so the path is resolved here, once,
 * and stored with the record.
 */
async function describeLocation(
    result: { library_id?: number; zotero_key?: string } | undefined,
): Promise<{ location?: string }> {
    try {
        if (!result?.library_id || !result?.zotero_key) return {};
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
            result.library_id,
            result.zotero_key,
        );
        if (!item) return {};
        const library = Zotero.Libraries.get(result.library_id);
        const libraryName = (library as any)?.name ?? 'My Library';

        const collectionIds: number[] = (item as any).getCollections?.() ?? [];
        if (collectionIds.length === 0) return { location: `${libraryName} · Unfiled` };

        // The full path, because a bare "Principles" is not enough to find in a
        // library with nested collections.
        const pathFor = (id: number): string => {
            const parts: string[] = [];
            let current: any = Zotero.Collections.get(id);
            while (current) {
                parts.unshift(current.name);
                current = current.parentID ? Zotero.Collections.get(current.parentID) : null;
            }
            return parts.join(' › ');
        };
        const paths = collectionIds.map(pathFor).filter(Boolean);
        return { location: `${libraryName} › ${paths.join(', ')}` };
    } catch (error) {
        logger(`describeLocation: ${error}`, 1);
        return {};
    }
}

/** What to call each write when telling the user one failed. */
const WRITE_FAILURE_LABELS: Record<string, string> = {
    create_highlight_annotations: 'the highlight',
    create_note: 'the note',
    create_item: 'the paper',
    organize_items: 'the tags and collections',
    create_collection: 'the collection',
};

/**
 * @param set  Used to register what came back as external references.
 *
 * Registering is not bookkeeping: it is what makes a citation to a searched-up
 * paper render as anything. `<citation external_id="W…"/>` resolves against
 * this mapping, and with the mapping empty the source row came out blank — a
 * numbered card with no title, no authors and no way to reach the paper. It
 * also answers "do I already have this?", which decides whether the row offers
 * to reveal the item or to import it.
 */
/**
 * The literature tools, sharing one budget.
 *
 * Searching, looking one paper up by DOI, and walking the citation graph are
 * one activity as far as restraint goes: they all hit OpenAlex, and a model
 * that has spent four calls without settling a question will not settle it on
 * the fifth. So the cap and the outage counter are shared rather than one each,
 * which is also why they are built together.
 *
 * `search_web_literature` keeps its own factory for the tests that predate the
 * others.
 */

/**
 * The OpenAlex identity the user configured, if any.
 *
 * The free key matters more than politeness: OpenAlex requires one from
 * February 2026, and until then anonymous search is rate-limited whenever
 * their search cluster is busy — which reads as an outage.
 */
function openAlexIdentity(): { apiKey?: string } {
    const key = getPref('openalexApiKey');
    const trimmed = typeof key === 'string' ? key.trim() : '';
    return trimmed ? { apiKey: trimmed } : {};
}

/** Where the OpenAlex key is set, as the model should name it to the user. */
const OPENALEX_KEY_SETTING = 'Settings → Model → Literature search';

/**
 * The HTTP status of a failed OpenAlex call, or null when it never got one.
 *
 * Taken from the status the client reports, never from digits anywhere in the
 * message: the error carries OpenAlex's own response body, and a DOI or a count
 * in it would otherwise read as a 429 or a 401.
 */
function openAlexStatus(error: unknown): number | null {
    const status = (error as { status?: unknown } | null | undefined)?.status;
    if (typeof status === 'number') return status;
    const text = error instanceof Error ? error.message : String(error);
    const match = /^OpenAlex request failed: (\d{3})\b/.exec(text);
    return match ? Number(match[1]) : null;
}

/**
 * What to tell the model when OpenAlex turned a call away — a rate limit, or a
 * key it will not accept — or null for a failure that reads as an outage.
 *
 * Worded for whether the user has a key: telling someone who already has one
 * to go and add one sends them looking for a setting they have already made.
 * A refused key is sticky for the rest of the question, because every later
 * call would be refused too — and no longer than that: the result is replayed
 * with the thread's later turns, by when the key may have been fixed, so it
 * must not read as a ban on the tools for the whole conversation.
 */
function openAlexRefusal(
    error: unknown,
    what: string,
): { message: string; sticky: boolean } | null {
    const status = openAlexStatus(error);
    const hasKey = Boolean(openAlexIdentity().apiKey);
    if (status === 429) {
        return {
            sticky: false,
            message: hasKey
                ? 'OpenAlex is rate-limiting requests right now. Do not retry. Tell the user in one '
                  + `sentence that the ${what} was rate-limited and to try again in a minute.`
                : 'OpenAlex is rate-limiting anonymous requests right now (their search cluster is '
                  + `busy). Do not retry. Tell the user in one sentence that the ${what} was `
                  + `rate-limited, and that adding a free OpenAlex API key under ${OPENALEX_KEY_SETTING} `
                  + 'lifts the limit.',
        };
    }
    if (status === 401 || status === 403) {
        return {
            sticky: true,
            message: hasKey
                ? 'OpenAlex did not accept the API key. Do not call the literature tools again for '
                  + 'this question; once the key is fixed, a later question can use them. Tell the '
                  + `user in one sentence that the OpenAlex key under ${OPENALEX_KEY_SETTING} was `
                  + 'rejected and needs checking.'
                : 'OpenAlex refused the request because it needs an API key. Do not call the '
                  + 'literature tools again for this question; once a key is added, a later question '
                  + 'can use them. Tell the user in one sentence to add a free OpenAlex API key under '
                  + `${OPENALEX_KEY_SETTING}.`,
        };
    }
    return null;
}

/**
 * @param signal  The run's stop signal, handed to every OpenAlex request so
 *   Stop cancels one in flight. A lookup cut short that way ends as a stop,
 *   not as OpenAlex failing to answer: counted as an outage, it would tell the
 *   model the service is down.
 */
function literatureTools(
    found: LiteratureCache,
    set: Setter,
    budget: LiteratureBudget,
    signal?: AbortSignal,
) {
    const client = new OpenAlexClient(boundFetch as any, openAlexIdentity());

    /** Register results so citations resolve and `add_papers_to_library` can import them. */
    const register = (works: OpenAlexWork[]) => {
        for (const work of works) found.set(work.id, work);
        const references = works.map(
            (work) => workToExternalReference(work) as unknown as ExternalReference,
        );
        if (references.length === 0) return;
        set(addExternalReferencesToMappingAtom, references);
        void set(checkExternalReferencesAtom, references);
    };

    /** The shared gate: stop, budget, then outage state, then the call itself. */
    const guarded = async <T>(
        run: () => Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
        if (signal?.aborted) throw new Error(RUN_STOPPED);
        if (budget.refusal) return { ok: false, message: budget.refusal };
        if (budget.outages >= MAX_WEB_SEARCH_OUTAGES) {
            return {
                ok: false,
                message:
                    'Literature search is unavailable — OpenAlex is not responding. Do not call '
                    + 'this tool again for this question. Tell the user in one sentence that '
                    + 'the literature search is down, then stop. Do not explain the outage.',
            };
        }
        const capped = spendLiteratureLookup(budget);
        if (capped) return { ok: false, message: capped };
        try {
            return { ok: true, value: await run() };
        } catch (error) {
            if (signal?.aborted) throw new Error(RUN_STOPPED);
            logger(`literatureTools: ${error}`, 2);
            const refused = openAlexRefusal(error, 'literature lookup');
            if (refused?.sticky) {
                budget.refusal = refused.message;
                return { ok: false, message: refused.message };
            }
            budget.outages += 1;
            if (refused) return { ok: false, message: refused.message };
            return {
                ok: false,
                message: budget.outages >= MAX_WEB_SEARCH_OUTAGES
                    ? 'Literature search is unavailable — OpenAlex is not responding. Do not try '
                      + 'again. Tell the user in one sentence that you could not look this up.'
                    : 'That lookup did not go through — OpenAlex did not respond. You may try once '
                      + 'more with the same arguments; do not reword them, they were not the problem.',
            };
        }
    };

    /*
     * Checked before `guarded` runs, not inside it.
     *
     * Inside, a missing argument is caught by the same handler that catches a
     * 503 and counted as an outage — so two malformed calls would take the
     * literature tools offline for the rest of the question. A bad argument is
     * the model's mistake and it should hear about it as one.
     */
    const workId = (args: Record<string, unknown>): string => {
        const id = String(args.openalex_id ?? '').trim();
        if (!id) throw new Error('openalex_id is required — pass a `W…` id a literature tool returned.');
        return id;
    };

    return {
        lookup_paper: async (args: Record<string, unknown>) => {
            const doi = String(args.doi ?? '').trim();
            const title = String(args.title ?? '').trim();
            if (!doi && !title) throw new Error('Give a doi or a title.');

            const result = await guarded(async () => (
                doi
                    ? await client.byDoi(doi, { signal })
                    : (await client.search(title, { perPage: 3, signal })).works[0] ?? null
            ));
            if (!result.ok) return result.message;
            const work = result.value;
            if (!work) {
                return (
                    `Not found${doi ? ` for DOI ${doi}` : ''}. Say you could not look it up and move `
                    + 'on — do not guess at the paper.'
                );
            }
            register([work]);
            return `${formatWorksForModel([work], 600)}

To add it, call \`add_papers_to_library\` with its OpenAlex id.`;
        },

        find_citing_papers: async (args: Record<string, unknown>) => {
            const id = workId(args);
            const result = await guarded(() => client.citedBy(id, { perPage: 10, signal }));
            if (!result.ok) return result.message;
            register(result.value.works);
            if (result.value.works.length === 0) return 'Nothing cites it in OpenAlex. Say so and move on.';
            return `${result.value.total} works cite it. The most relevant:

${formatWorksForModel(result.value.works, 300)}`;
        },

        find_cited_papers: async (args: Record<string, unknown>) => {
            const id = workId(args);
            const result = await guarded(() => client.references(id, { perPage: 10, signal }));
            if (!result.ok) return result.message;
            register(result.value.works);
            if (result.value.works.length === 0) {
                return 'OpenAlex has no reference list for it. Say so and move on.';
            }
            return `It cites ${result.value.total} works. The most relevant:

${formatWorksForModel(result.value.works, 300)}`;
        },
    };
}

/** @param signal  As for `literatureTools`: Stop cancels the search in flight. */
function webSearchTool(
    found: LiteratureCache,
    set: Setter,
    budget: LiteratureBudget,
    signal?: AbortSignal,
) {
    const client = new OpenAlexClient(boundFetch as any, openAlexIdentity());
    return async (args: Record<string, unknown>) => {
        if (signal?.aborted) throw new Error(RUN_STOPPED);
        if (budget.refusal) return budget.refusal;
        if (budget.outages >= MAX_WEB_SEARCH_OUTAGES) {
            return (
                'Literature search is unavailable — OpenAlex is not responding. Do not call this '
                + 'tool again for this question. Tell the user in one sentence that the '
                + 'literature search is down and that you could not look the paper up, then stop. '
                + 'Do not explain the outage.'
            );
        }
        const capped = spendLiteratureLookup(budget);
        if (capped) return capped;

        let result;
        try {
            result = await client.search(String(args.query ?? ''), {
                perPage: 8,
                fromYear: typeof args.from_year === 'number' ? args.from_year : undefined,
                openAccessOnly: args.open_access_only === true,
                signal,
            });
        } catch (error) {
            // A stop, not a failure: the run ends as soon as this returns.
            if (signal?.aborted) throw new Error(RUN_STOPPED);
            /*
             * Returned, not thrown. A thrown tool error reads as "you called it
             * wrong" and the model's answer to that is to rephrase; a returned
             * result reads as an answer, and this one says what to do next.
             */
            logger(`search_web_literature: ${error}`, 2);
            const refused = openAlexRefusal(error, 'literature search');
            if (refused?.sticky) {
                budget.refusal = refused.message;
                return refused.message;
            }
            budget.outages += 1;
            if (refused) return refused.message;
            return budget.outages >= MAX_WEB_SEARCH_OUTAGES
                ? 'Literature search is unavailable — OpenAlex is not responding. Do not try '
                  + 'again. Tell the user in one sentence that you could not look this up, then '
                  + 'stop.'
                : 'That search did not go through — OpenAlex did not respond. You may try once '
                  + 'more with the same query; do not reword it, the query was not the problem.';
        }
        budget.outages = 0;

        if (result.works.length === 0) {
            // "Nothing matched" is a complete answer. Left to itself the model
            // treats it as a prompt to rephrase, and the user gets a paragraph
            // of speculation instead of two words.
            return (
                'Nothing matched. Tell the user you could not find it and move on — do not '
                + 'speculate about what the paper might be, and do not reword this query more '
                + 'than once.'
            );
        }

        for (const work of result.works) found.set(work.id, work);

        const references = result.works.map(
            (work) => workToExternalReference(work) as unknown as ExternalReference,
        );
        set(addExternalReferencesToMappingAtom, references);
        // Detached: whether each paper is already in the library is answered by
        // searching it, and the model should not wait on that to keep reading.
        void set(checkExternalReferencesAtom, references);

        return (
            `${result.total} works matched.\n\n${formatWorksForModel(result.works, 400)}\n\n`
            + 'When you mention one of these papers in your answer, paste its "Cite as" tag '
            + 'right after the mention — that is what gives the reader a clickable reference. '
            + 'To add any of these to the library, call `add_papers_to_library` with their '
            + 'OpenAlex ids (the `W…` above). Do not retype the metadata.'
        );
    };
}

/**
 * Prior turns in this run's thread, oldest first.
 *
 * The run request carries only the current prompt — the backend owned
 * conversation state — so without this every turn would arrive with no memory
 * of the last one.
 */
function priorRunsForThread(get: Getter, run: AgentRun): RunLike[] {
    const all = get(allRunsAtom) as AgentRun[];
    return all
        .filter(
            (candidate) =>
                candidate.id !== run.id &&
                candidate.thread_id != null &&
                candidate.thread_id === run.thread_id,
        )
        .map((candidate) => ({
            id: candidate.id,
            thread_id: candidate.thread_id,
            status: candidate.status,
            // The history keeps a failed run's steps, except after a context-window
            // failure, where replaying its tool results would overflow again.
            error: candidate.error ? { type: candidate.error.type } : null,
            user_prompt: candidate.user_prompt as any,
            model_messages: candidate.model_messages as any,
        }));
}

/** True when the plugin is configured to run the model locally. */
export { isAgentConfigured } from '../../src/services/llm/agentConfig';

/**
 * Execute a run locally.
 *
 * Resolves when the run is finished either way: a failure is reported to the
 * store through the same `onError` the socket path used, so the panel shows a
 * message rather than a stuck spinner.
 */
/**
 * Tools that write to the library, executed through the provider's action path.
 *
 * The two-step validate/execute protocol upstream exists so a server can propose
 * an action and wait for the user's approval. Orchestrating locally, the decision
 * has already been made — by the preference that offers these tools at all — so
 * the action goes straight to the executor that would have run it anyway.
 *
 * Placement is the part the server used to supply: it held the extraction and
 * returned page rects. Here the passage is located in the cached structured
 * extraction, and an ambiguous match is refused rather than guessed.
 */
/**
 * Full-text passage search over the whole library.
 *
 * Offered only when an embedding provider is configured *and* something has been
 * indexed: a tool that always returns nothing teaches the model the library is
 * empty, which is the same trap the topic tool avoids by being withheld.
 */
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

function fulltextTool(runId?: string): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
    return {
        search_library_fulltext: async (args) => {
            const provider = buildEmbeddingProviderFromPrefs();
            const modelId = currentEmbeddingModelId();
            const db = (Zotero as any).AlphainZ?.db;
            if (!provider || !modelId || !db) {
                throw new Error('Full-text search needs an embedding provider configured.');
            }

            const libraryIds: number[] = store.get(searchableLibraryIdsAtom);
            if (libraryIds.length === 0) return { matches: [], note: NO_SEARCHABLE_LIBRARY };
            // The PDFs in the library now: what is searched, and what coverage
            // is counted against.
            const candidates = await listAllCandidates({ titles: false });
            const hits = await searchChunks({
                store: db,
                provider,
                modelId,
                query: String(args.query ?? ''),
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
            return {
                ...(coverage ? { coverage } : {}),
                matches: hits.map((hit) => {
                    const parent = hit.parentKey
                        ? (Zotero.Items.getByLibraryAndKey(hit.libraryId, hit.parentKey) as Zotero.Item | false)
                        : false;
                    const attachment = Zotero.Items.getByLibraryAndKey(
                        hit.libraryId,
                        hit.attachmentKey,
                    ) as Zotero.Item | false;
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
                     * card — clipped at a word boundary, never mid-word, which
                     * is what an earlier attempt got wrong.
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
                        title: parent ? parent.getField('title') : attachment ? attachment.getDisplayTitle?.() : null,
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
 * Whether figure search can be offered for this run: the embedding model takes
 * pictures, its page-image index has something in it, and the chat model can
 * look at what it finds.
 */
async function figureSearchAvailable(readsImages: boolean): Promise<boolean> {
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

function figuresTool(): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
    return {
        search_library_figures: async (args) => {
            const provider = pageImageProvider();
            const modelId = currentEmbeddingModelId();
            const db = (Zotero as any).AlphainZ?.db;
            if (!provider || !modelId || !db) {
                throw new Error('Figure search needs an embedding model that takes pictures (Google Gemini or Ollama EmbeddingGemma 2).');
            }
            const libraryIds: number[] = store.get(searchableLibraryIdsAtom);
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
                    query: String(args.query ?? ''),
                    libraryIds,
                    attachments: new Set(candidates.map(candidateKey)),
                    ...(args.limit != null ? { limit: clampLimit(args.limit, 6) } : {}),
                }),
                figureCoverageNoteFor(modelId, candidates),
            ]);
            if (hits.length === 0) {
                return { pages: [], note: `No indexed page image matched.${coverage ? ` ${coverage}` : ''}` };
            }
            return {
                note: 'Pages, ranked by how closely they look like the description. Look at one with view_page_images '
                    + 'before saying what it shows.',
                ...(coverage ? { coverage } : {}),
                pages: hits.map((hit) => {
                    const parent = hit.parentKey
                        ? (Zotero.Items.getByLibraryAndKey(hit.libraryId, hit.parentKey) as Zotero.Item | false)
                        : false;
                    const attachment = Zotero.Items.getByLibraryAndKey(hit.libraryId, hit.attachmentKey) as Zotero.Item | false;
                    const attachmentId = `${libraryRefForLibraryID(hit.libraryId) ?? hit.libraryId}-${hit.attachmentKey}`;
                    return {
                        attachment_id: attachmentId,
                        title: parent ? parent.getField('title') : attachment ? attachment.getDisplayTitle?.() : null,
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

/** What `proposeWrite` did with a change, which is what the model is told. */
type WriteOutcome =
    | { actionId: string }
    /** Recorded for the user to review after the answer; nobody is asked now. */
    | { queued: true }
    | { applied: true }
    /** The user's setting said apply, and the write failed. */
    | { failed: string };

/** Makes each recorded action's id unique, even for decisions made in the same instant. */
let recordedActionCount = 0;

/**
 * @param isStopped  True once the run was stopped. Checked before any change is
 *   proposed, queued or applied, so a loop that outlives its run writes nothing
 *   and asks nothing. A card already on screen stays the user's to decide.
 * @param threadId  The conversation the run belongs to. A run with no thread is
 *   its own thread, as the local runner has it.
 */
export function writeTools(
    provider: Record<string, any>,
    set: Setter,
    found: LiteratureCache = new Map(),
    runId = '',
    isStopped: () => boolean = () => false,
    threadId: string = runId,
): Record<
    string,
    (args: Record<string, unknown>, context: { toolCallId: string }) => Promise<unknown>
> {
    /**
     * Put a proposed write in front of the user, and carry on.
     *
     * The card is Beaver's own — a `deferred_approval_request` matched to the
     * tool call by id, which is what makes the existing preview and its
     * Reject/Apply footer appear.
     *
     * What is different is that the model is not held here. Waiting for the
     * answer inside the tool call made every write a barrier: colour-coding a
     * paper wants 4-8 highlights, and pausing on each one turned one request
     * into eight round trips, each needing a click before the model could even
     * think about the next passage. Worse, the model could see it — it spent a
     * whole turn reasoning about whether "propose one at a time" meant it had
     * to serialise, and after two rejections it gave up and asked what to do.
     *
     * So the proposal is registered and the call returns immediately. The cards
     * accumulate while the answer streams, and the user decides once the answer
     * is there to judge them against. Approval is honoured by the detached task
     * below, which is the only thing still waiting.
     *
     * The cost is that the model never learns the verdict, so a rejection can
     * no longer steer the same run — "not that sentence, the one on page 4"
     * has to become the next message instead of a note on the card. Worth it:
     * the alternative made the model wait on a click before it could think
     * about the next passage, and a paper wants several.
     */
    const reportWriteFailure = (actionType: string, message: string) => {
        const what = WRITE_FAILURE_LABELS[actionType] ?? 'that change';
        set(addWarningAtom, {
            run_id: runId,
            type: 'write_failed',
            message: `Could not apply ${what}: ${message}`,
        });
    };

    /**
     * Leave a record of what happened, so the answer is not the only trace.
     *
     * Once a card is answered it disappears, and locally nothing replaced it —
     * a run that added six highlights left a conversation with no sign of it
     * beyond the model's own prose. An agent action is kept with the thread and
     * renders the same preview the card did, labelled applied, rejected or
     * failed — or, for a change queued for review, with its own Apply and
     * Reject, which is also what the review card at the end of the run lists.
     *
     * Each record carries what reopening the thread needs: the run and tool
     * call it belongs to, what was proposed, and for an applied change the
     * result its Undo works from. The id is unique per record, so two
     * decisions on one call (a batch of papers, say) never collapse into one.
     *
     * A proposal the user is asked about is recorded as pending when its card
     * appears, so it is stored with its run and comes back, still undecided,
     * after a restart. The decision then `supersedes` that record — same id,
     * new status — rather than adding a second one beside it.
     */
    const recordAction = (
        actionType: string,
        actionData: Record<string, unknown>,
        toolcallId: string,
        status: 'pending' | 'applied' | 'rejected' | 'error',
        extra: { resultData?: Record<string, unknown>; errorMessage?: string } = {},
        supersedes?: { id: string; created_at: string },
    ): { id: string; created_at: string } => {
        const now = new Date().toISOString();
        recordedActionCount += 1;
        const record = {
            id: supersedes?.id ?? `local-action-${toolcallId}-${status}-${now}-${recordedActionCount}`,
            // The run's id is what the review cards and the action card
            // look actions up by; without it a recorded write belonged to
            // no run, and the card that replaced the approval could not
            // find the change it was standing on.
            run_id: runId,
            message_id: runId,
            toolcall_id: toolcallId,
            user_id: '',
            action_type: actionType as any,
            status,
            proposed_data: actionData,
            ...(extra.resultData ? { result_data: extra.resultData } : {}),
            ...(extra.errorMessage ? { error_message: extra.errorMessage } : {}),
            created_at: supersedes?.created_at ?? now,
            updated_at: now,
        } as any;
        // Upserted, not appended, when it supersedes: the pending record may
        // be on screen, or — when the decision lands while another
        // conversation is open — only in its run's stored copy, which the
        // saving path merges this into by id.
        set(supersedes ? upsertAgentActionsAtom : addAgentActionsAtom, [record]);
        return { id: record.id, created_at: record.created_at };
    };

    /**
     * Execute an approved write, record the outcome and say whether it landed. Never throws.
     *
     * @param supersedes  The pending record of the proposal being applied, which
     *   the outcome replaces.
     */
    const applyWrite = async (
        actionType: string,
        actionData: Record<string, unknown>,
        toolcallId: string,
        supersedes?: { id: string; created_at: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
        const entry = provider['agent_action_execute'];
        if (!entry) return { ok: false, error: 'This build cannot execute library actions.' };
        try {
            /*
             * Where a paper goes, read at apply time rather than at propose
             * time — so the destination picked on the card, once, for this
             * run, files all of its papers there. Resolved against the same
             * choices the card lists, so what it showed is what is written.
             */
            const chosen = actionType === 'create_item'
                ? resolveImportDestination(
                    chosenImportDestination(store.get(importDestinationAtom), runId),
                    actionData,
                    currentDestination,
                    destinationChoices(store.get(searchableLibraryIdsAtom)),
                )
                : null;
            const payload = chosen
                ? {
                    ...actionData,
                    library_id: chosen.libraryId,
                    library_ref: libraryRefForLibraryID(chosen.libraryId) ?? undefined,
                    collection_keys: chosen.collectionKey ? [chosen.collectionKey] : [],
                }
                : actionData;

            const response: any = await entry.handle({
                event: 'agent_action_execute',
                request_id: `write-${actionType}-${toolcallId}`,
                action_type: actionType,
                action_data: payload,
            });
            if (response?.success === false) {
                const error = String(response.error ?? 'unknown error');
                logger(`proposeWrite: ${actionType} failed: ${response.error}`, 2);
                reportWriteFailure(actionType, error);
                recordAction(actionType, actionData, toolcallId, 'error', { errorMessage: error }, supersedes);
                return { ok: false, error };
            }
            recordAction(actionType, actionData, toolcallId, 'applied', {
                resultData: {
                    ...(response?.result_data ?? {}),
                    ...(await describeLocation(response?.result_data)),
                },
            }, supersedes);
            /*
             * A paper just added is not yet searchable.
             *
             * Indexing only ever ran from the settings panel, so a paper the
             * user had just asked for came back missing from every full-text
             * search until they went and ran it by hand, with nothing to say
             * why. Scoped to this item, and detached: the paper is in the
             * library whether or not the embeddings land.
             */
            if (actionType === 'create_item') {
                const created = response?.result_data;
                if (created?.library_id && created?.zotero_key) {
                    void set(indexItemAttachmentsAtom, {
                        libraryId: created.library_id,
                        zoteroKey: created.zotero_key,
                    });
                }
            }
            return { ok: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger(`proposeWrite: ${actionType} threw: ${error}`, 2);
            reportWriteFailure(actionType, message);
            recordAction(actionType, actionData, toolcallId, 'error', { errorMessage: message }, supersedes);
            return { ok: false, error: message };
        }
    };

    /**
     * Say what actually happened, not what usually happens.
     *
     * The outcome is known by the time the tool answers — `proposeWrite`
     * returns it — so the wording follows it: applied only once the write has
     * landed, failed with the reason when it did not, and proposed (asked now,
     * or queued for review after the answer) while it is still the user's
     * decision. "Proposed" for a change already in the library, or "done" for
     * one that failed, would put a false sentence in the answer.
     */
    const outcomeFields = (
        outcome: WriteOutcome | void,
        notes: { proposed: string; applied: string },
    ): Record<string, unknown> => {
        /*
         * A sentence, not a flag.
         *
         * The first version returned `proposed: true` with the explanation in a
         * separate `note`, and the model read straight past both: asked for a
         * sticky note and a metadata fix, it proposed each correctly and then
         * opened its answer with "both are done". A boolean beside a dozen
         * other result fields is easy to skim; a status field whose *value*
         * says "nothing has been written yet" is not.
         */
        if (outcome && 'applied' in outcome) {
            return { status: 'APPLIED — this change is already in the library', note: notes.applied };
        }
        if (outcome && 'failed' in outcome) {
            return {
                status: `FAILED — nothing was written: ${outcome.failed}`,
                note:
                    'Tell the user this change could not be made, and why. Do not describe it as '
                    + 'done or as proposed.',
            };
        }
        if (outcome && 'queued' in outcome) {
            return {
                status:
                    'PROPOSED — nothing has been written yet; it is queued for the user to review '
                    + 'after your answer',
                note: notes.proposed,
            };
        }
        return {
            status: 'PROPOSED — nothing has been written yet; the user has not approved it',
            note: notes.proposed,
        };
    };

    /**
     * Check a proposed change before anyone is asked about it.
     *
     * Upstream runs validate → approve → execute; this fork went straight to
     * execute, and lost three things by doing so. A change that could never
     * work — a field Zotero will not let an agent set, a note fragment that
     * matches twice — reached the user as a card that failed on Apply, when the
     * validator would have told the model in time to fix it. The card also
     * renders a *diff*, and the "before" side comes from validation's
     * `current_value`, so without it every card showed only the new value. And
     * some actions cannot be executed from what the model writes at all:
     * `edit_note` needs the surrounding raw-HTML context resolved against the
     * live note, which is exactly what validation adds.
     *
     * Returns the data to actually apply — normalized where the validator
     * normalized it, unchanged where it did not — and the preference the
     * validator judged this change to need. That verdict can be stricter than
     * the user's setting for the group, because only validation holds both the
     * live item and the payload: a rewrite that discards most of a note, or a
     * comment that replaces one the user wrote, has to ask even under "always
     * apply".
     */
    const validateWrite = async (
        actionType: string,
        actionData: Record<string, unknown>,
    ): Promise<{
        data: Record<string, unknown>;
        currentValue?: Record<string, unknown>;
        preference?: string;
    }> => {
        const entry = provider['agent_action_validate'];
        if (!entry) return { data: actionData };

        let response: any;
        try {
            response = flattenProviderResponse(
                await entry.handle({
                    event: 'agent_action_validate',
                    request_id: `validate-${actionType}-${nextApprovalId()}`,
                    action_type: actionType,
                    action_data: actionData,
                }),
            );
        } catch (error) {
            // A validator that throws is a bug in the validator, not a verdict
            // on the change. Fall through and let execution be the judge.
            logger(`validateWrite: ${actionType} validator threw: ${error}`, 2);
            return { data: actionData };
        }

        if (response?.valid === false) {
            throw new Error(
                String(response.error ?? `This ${actionType} cannot be applied.`),
            );
        }
        return {
            data: (response?.normalized_action_data as Record<string, unknown>) ?? actionData,
            ...(response?.current_value
                ? { currentValue: response.current_value as Record<string, unknown> }
                : {}),
            ...(typeof response?.preference === 'string' ? { preference: response.preference } : {}),
        };
    };

    const proposeWrite = async (
        actionType: string,
        rawActionData: Record<string, unknown>,
        toolcallId: string,
        callerCurrentValue?: Record<string, unknown>,
        /*
         * Which permission group answers for this change, when the action type
         * is not specific enough to say.
         *
         * Deleting annotations and recolouring them are the same action type —
         * one validate/execute/undo path, distinguished by `operation` — but
         * they are emphatically not the same decision. Keyed on the action type
         * alone, a user who set annotations to "always apply" so highlights
         * would stop interrupting them would have silently authorised
         * deletions too.
         */
        permissionKey?: string,
    ): Promise<WriteOutcome> => {
        const entry = provider['agent_action_execute'];
        if (!entry) throw new Error('This build cannot execute library actions.');
        if (isStopped()) throw new Error(RUN_STOPPED);

        const validated = await validateWrite(actionType, rawActionData);
        // Validation reads the library and can take a while. A run stopped in
        // the meantime proposes nothing and writes nothing.
        if (isStopped()) throw new Error(RUN_STOPPED);
        const actionData = validated.data;
        const currentValue = callerCurrentValue ?? validated.currentValue;

        /*
         * The user's standing answer for this kind of change.
         *
         * Settings → Permissions offers "Always ask" / "Always apply" /
         * "Always review later" per group. Keyed on the action type, which is
         * what the preference groups are keyed on, unless the caller named a
         * narrower group.
         *
         * Validation's verdict can only make a change ask, never let one
         * through: it overrides "always apply" and nothing else, so a setting
         * the user chose is never loosened by it.
         */
        let preference = getDeferredToolPreference(permissionKey ?? actionType, actionData);
        if (preference === 'always_apply' && validated.preference === 'always_ask') {
            logger(`proposeWrite: ${actionType} asks despite "always apply" — validation requires approval`);
            preference = 'always_ask';
        }
        if (preference === 'continue_without_applying') {
            /*
             * "Always review later": queued, neither asked about now nor
             * dropped. A pending action is what the review card at the end of
             * the run lists, and it carries its own Apply and Reject on the
             * call's card. No live approval stands behind it, so nothing waits
             * on it and the composer stays free.
             */
            recordAction(actionType, actionData, toolcallId, 'pending');
            logger(`proposeWrite: ${actionType} queued for review — the user's setting is review later`);
            return { queued: true };
        }
        if (preference === 'always_apply') {
            logger(`proposeWrite: ${actionType} applied without asking — the user's setting is always apply`);
            // Awaited, so the model hears APPLIED only once the change is in the
            // library, and FAILED with the reason when it is not.
            const result = await applyWrite(actionType, actionData, toolcallId);
            return result.ok ? { applied: true } : { failed: result.error };
        }

        /*
         * Asked now: a card, and a pending record behind it.
         *
         * The record is what the run is stored with, so a proposal nobody has
         * decided yet comes back after a restart — as the record's own Apply
         * and Reject, since the card's waiter does not survive one. Both carry
         * the same id, which is how the surfaces tell them apart: while the
         * card is up, the call's card and the approval bar own the decision,
         * and the review card leaves the record alone (see `buildReviewRows`).
         */
        const pending = recordAction(actionType, actionData, toolcallId, 'pending');
        const actionId = pending.id;
        const decision = awaitApproval(actionId, toolcallId, actionType, {
            // Claimed the moment the answer arrives, before any surface
            // redraws: the record stays pending until the outcome is written,
            // and another surface must not offer to apply it meanwhile, nor
            // list it for review.
            onAnswer: () => { set(beginProposalOutcomeAtom, actionId); },
        });
        set(addPendingApprovalAtom, {
            event: 'deferred_approval_request',
            action_id: actionId,
            toolcall_id: toolcallId,
            action_type: actionType,
            action_data: actionData,
            ...(currentValue ? { current_value: currentValue } : {}),
        } as any, {
            runId,
            threadId,
            threadName: store.get(currentThreadNameAtom),
        });

        logger(`proposeWrite: ${actionType} proposed as ${actionId} (toolcall ${toolcallId})`);

        // Detached on purpose: this outlives the tool call and usually the run.
        // It acts only on the user's own decision, which stays theirs to make
        // after the run has finished or been stopped — an Apply clicked on the
        // card later still applies. Every path removes the card, so a decision
        // cannot leave one stranded.
        void (async () => {
            try {
                const outcome = await decision;
                set(removePendingApprovalAtom, actionId);
                // Applied some other way; its record already says so.
                if (outcome.settled) return;
                if (!outcome.approved) {
                    logger(`proposeWrite: ${actionType} declined by user`);
                    // Recorded too: "I decided against this" is worth keeping,
                    // and a card that simply vanishes reads the same as one
                    // that was never there.
                    recordAction(actionType, actionData, toolcallId, 'rejected', {}, pending);
                    return;
                }
                await applyWrite(actionType, actionData, toolcallId, pending);
            } catch (error) {
                set(removePendingApprovalAtom, actionId);
                logger(`proposeWrite: ${actionType} threw: ${error}`, 2);
                reportWriteFailure(
                    actionType,
                    error instanceof Error ? error.message : String(error),
                );
            } finally {
                set(endProposalOutcomeAtom, actionId);
            }
        })();

        return { actionId };
    };

    /**
     * Build the action, propose it, and answer the model — the half both routes
     * share.
     *
     * `via` records how the passage was found. A locator resolved it exactly; a
     * quote had to be matched, and may have been narrowed to a sentence inside
     * what was asked for. The model needs to know which, because only the
     * second case changes what its answer should claim.
     */
    const placeHighlight = async (opts: {
        attachmentId: string;
        reference: { library_id?: number; library_ref?: string; zotero_key: string };
        located: Array<{ pageIndex: number; pageLabel?: string; boxes: Array<{ l: number; t: number; r: number; b: number }>; matchedText: string }>;
        needle: string;
        quoted: string;
        args: Record<string, unknown>;
        toolCallId: string;
        via: string | null;
    }) => {
        const { attachmentId, reference, located, needle, quoted, args, toolCallId, via } = opts;
        if (args.color != null && !isHighlightColorName(args.color)) {
            throw new Error(
                `color "${String(args.color)}" is not a Zotero palette colour. Use one of: ${HIGHLIGHT_COLOR_NAMES.join(', ')}.`,
            );
        }
        const built = buildHighlightAction(located, {
            text: needle,
            ...(args.comment ? { comment: String(args.comment) } : {}),
            ...(args.color ? { color: String(args.color) } : {}),
        });
        if (!built.ok) throw new Error(built.error);

        const target = await resolveHighlightTarget(reference, attachmentId);
        const locatedPage = built.item.page_locations[0].page_idx + 1;
        /*
         * Remembered so the finished answer can be linked to the passage even
         * when the model leaves the tag out — which it does. See
         * `highlightCitations.ts`.
         */
        recordProposedHighlight(runId, {
            attachmentId,
            page: locatedPage,
            text: built.item.text,
            boxes: built.item.page_locations[0].boxes.map((box) => [box.l, box.t, box.r, box.b]),
        });
        const outcome = await proposeWrite(
            'create_highlight_annotations',
            { requested_ref: target, resolved_ref: target, items: [built.item] },
            toolCallId,
        );
        return {
            page: locatedPage,
            text: built.item.text,
            ...(via ? { placed_by: via } : {}),
            ...(args.color ? { color: String(args.color) } : {}),
            ...(quoted && needle !== quoted
                ? {
                    narrowed_to: needle,
                    note_on_narrowing:
                        'The passage you quoted could not be placed as one run — it crosses a '
                        + 'column, page or block break in the extracted text. The highlight is '
                        + 'on this sentence from within it. Describe that sentence, not the '
                        + 'whole passage. Next time pass the `[s…]` locator instead and this '
                        + 'cannot happen.',
                }
                : {}),
            citation: `<citation id="${attachmentId}" page="${locatedPage}"/>`,
            ...outcomeFields(outcome, {
                proposed:
                    'Shown to the user for approval once your answer is finished. Carry on '
                    + 'proposing the rest. When your answer mentions this passage, put the '
                    + '`citation` string above straight after the sentence that describes it — '
                    + 'that is what makes it one click away.',
                applied:
                    'This highlight is already in the document — the user set PDF annotations '
                    + 'to apply without asking. Say it is done, not that it is proposed. When '
                    + 'your answer mentions this passage, put the `citation` string above '
                    + 'straight after the sentence that describes it.',
            }),
        };
    };


    return {
        create_highlight: async (args, context) => {
            const attachmentId = String(args.attachment_id ?? '');
            const reference = parseCompositeItemId(attachmentId);
            if (!reference) throw new Error(`attachment_id "${attachmentId}" is not a valid id.`);
            const locator = String(args.locator ?? '').trim();
            const text = String(args.text ?? '').trim();
            if (!locator && !text) {
                throw new Error(
                    'Give a `locator` — the `[s12]` label `read_document` printed before the '
                    + 'sentence. Falling back to `text` means the passage has to be found by '
                    + 'matching, which fails whenever your wording drifts from the page.',
                );
            }

            // The structured extraction, from cache after the first call.
            const documentEntry = provider['zotero_document_request'];
            if (!documentEntry) throw new Error('This build cannot read documents.');
            const raw: any = flattenProviderResponse(
                await documentEntry.handle({
                    event: 'zotero_document_request',
                    request_id: `write-locate-${Date.now()}`,
                    attachment: reference,
                    mode: 'structured',
                    timeout_seconds: 90,
                }),
            );
            if (raw?.error) throw new Error(String(raw.error));

            /*
             * A locator is an index lookup, and that is the whole point.
             *
             * The extractor numbered these sentences on the way past and
             * `read_document` printed the numbers; resolving one cannot fail
             * for any of the reasons matching fails — no paraphrase, no
             * ligature, no reordered column, no wrong page. Everything below
             * this block is the fallback for a model that quoted instead.
             */
            if (locator) {
                const index = buildLocatorIndex(raw?.result?.document);
                const resolved = resolveLocator(locator, index);
                logger(
                    `create_highlight: locator "${locator}" -> ${resolved.length ? 'resolved' : 'MISS'}`,
                    3,
                );
                if (resolved.length === 0) {
                    const nearby = nearbyLocators(locator, index);
                    throw new Error(
                        `No such locator "${locator}" in this document.`
                        + (nearby.length ? ` Nearby: ${nearby.join(', ')}.` : '')
                        + ' Read the page again and copy the label exactly as it was printed'
                        + ' — a range must stay on one page and span at most'
                        + ` ${MAX_LOCATOR_SPAN} labels.`,
                    );
                }
                const located = [{
                    pageIndex: resolved[0].pageIndex,
                    ...(resolved[0].pageLabel ? { pageLabel: resolved[0].pageLabel } : {}),
                    boxes: resolved.flatMap((entry) =>
                        entry.boxes.map(([l, t, r, b]) => ({ l, t, r, b }))),
                    matchedText: resolved.map((entry) => entry.text).join(' '),
                }];
                return await placeHighlight({
                    attachmentId,
                    reference,
                    located,
                    needle: located[0].matchedText,
                    quoted: located[0].matchedText,
                    args,
                    toolCallId: context.toolCallId,
                    via: locator,
                });
            }

            /*
             * The page is a hint, not a filter.
             *
             * It used to confine the search, and a model that named the wrong
             * page could not place a quote that sits unambiguously somewhere
             * else — which is most of what the user saw fail. See
             * `locateWithPageHint`.
             */
            logger('create_highlight: no locator given, falling back to text matching', 3);
            const page = args.page != null ? Number(args.page) - 1 : undefined;
            const hint = page !== undefined && Number.isFinite(page) ? page : undefined;
            let needle = text;
            let located = locateWithPageHint(raw?.result?.document, needle, hint);
            /*
             * A passage that will not place as one run.
             *
             * Extraction keeps sentences inside the block they were laid out
             * in, and a match window reaches across at most three of them, so a
             * quote spanning a column break, a page break, or four sentences
             * cannot be found whole. On one skim of a review that was six
             * quotes out of thirteen.
             *
             * Narrowing to the longest sentence in the passage is not a
             * consolation prize — one sentence is what this tool asks for. The
             * card then shows the sentence that will actually be highlighted,
             * not the paragraph that was asked for.
             */
            if (located.length === 0) {
                for (const sentence of sentencesByLength(text)) {
                    if (sentence === text) continue;
                    const narrowed = locateWithPageHint(raw?.result?.document, sentence, hint);
                    if (narrowed.length === 1) {
                        needle = sentence;
                        located = narrowed;
                        break;
                    }
                }
            }
            if (located.length === 0) {
                logger(
                    `create_highlight: could not place ${JSON.stringify(needle.slice(0, 160))}`,
                    2,
                );
                /*
                 * Answer the question the failure raises.
                 *
                 * Told only "not found", the model rewords the quote and tries
                 * again, four or five times, from the same wrong text. The
                 * document is in hand, so the nearest real sentences go back
                 * with the error — and now so does the advice that ends this
                 * class of failure for good.
                 */
                const nearby = suggestNearbyPassages(raw?.result?.document, needle);
                throw new Error(
                    'That text was not found in the document.'
                    + (nearby.length
                        ? '\n\nThe closest text is below.\n'
                          + nearby.map((c) => `- (p. ${c.page}) ${JSON.stringify(c.text)}`).join('\n')
                        : '')
                    + '\n\nBetter: read the page with `read_document` and pass the `[s…]` label '
                    + 'printed before the sentence as `locator`. That places the highlight by '
                    + 'index and cannot miss, however you word your answer.',
                );
            }

            return await placeHighlight({
                attachmentId,
                reference,
                located,
                needle,
                quoted: text,
                args,
                toolCallId: context.toolCallId,
                via: null,
            });
        },

        /*
         * A sticky note in the margin.
         *
         * The executor for these has been here since the fork — it is what
         * Beaver's server drove for `create_note_annotations` — and nothing
         * called it, so the plugin could highlight a passage but not remark on
         * one. The only part the server used to supply is the position, and
         * that is the same lookup a highlight uses: locate the passage, take
         * the top of its first box.
         */
        create_sticky_note: async (args, context) => {
            const attachmentId = String(args.attachment_id ?? '');
            const reference = parseCompositeItemId(attachmentId);
            if (!reference) throw new Error(`attachment_id "${attachmentId}" is not a valid id.`);
            const comment = String(args.comment ?? '').trim();
            if (!comment) throw new Error('comment is required — a sticky note with nothing in it says nothing.');
            const pageNumber = Number(args.page);
            if (!Number.isFinite(pageNumber) || pageNumber < 1) {
                throw new Error('page is required and must be a 1-based page number.');
            }
            if (args.color != null && !isHighlightColorName(args.color)) {
                throw new Error(
                    `color "${String(args.color)}" is not a Zotero palette colour. Use one of: ${HIGHLIGHT_COLOR_NAMES.join(', ')}.`,
                );
            }

            const pageIndex = pageNumber - 1;
            let y = 72;
            const anchorText = String(args.anchor_text ?? '').trim();
            if (anchorText) {
                const documentEntry = provider['zotero_document_request'];
                if (documentEntry) {
                    const raw: any = flattenProviderResponse(
                        await documentEntry.handle({
                            event: 'zotero_document_request',
                            request_id: `sticky-locate-${attachmentId}`,
                            attachment: reference,
                            mode: 'structured',
                            timeout_seconds: 90,
                        }),
                    );
                    const located = locateWithPageHint(raw?.result?.document, anchorText, pageIndex);
                    // A miss is not a failure: the note still belongs on the
                    // page, just at the top of it rather than level with a
                    // sentence. Failing here would lose the user's remark over
                    // a placement detail.
                    if (located.length === 1 && located[0].boxes.length > 0) {
                        y = located[0].boxes[0].t;
                    } else {
                        logger(`create_sticky_note: anchor_text not placed; using top of page ${pageNumber}`, 3);
                    }
                }
            }

            const target = await resolveHighlightTarget(reference, attachmentId);
            const outcome = await proposeWrite(
                'create_note_annotations',
                {
                    requested_ref: target,
                    resolved_ref: target,
                    items: [{
                        index: 0,
                        client_item_id: `local-sticky-${pageIndex}-${nextApprovalId()}`,
                        title: comment.slice(0, 80),
                        loc_raw: `p. ${pageNumber}`,
                        loc: { kind: 'page', value: String(pageNumber), raw: `p. ${pageNumber}` },
                        comment,
                        color: args.color ? String(args.color) : 'yellow',
                        note_position: {
                            page_index: pageIndex,
                            side: 'right',
                            x: 0,
                            // Top-left origin, which is the frame the extraction
                            // reports boxes in — so a located sentence's `t` is
                            // usable without conversion.
                            y,
                            coord_origin: 't',
                        },
                        page_label: String(pageNumber),
                    }],
                },
                context.toolCallId,
            );
            return {
                page: pageNumber,
                comment,
                citation: `<citation id="${attachmentId}" page="${pageNumber}"/>`,
                ...outcomeFields(outcome, {
                    proposed: 'Shown to the user for approval once your answer is finished. Carry on.',
                    applied: 'The note is in the PDF — annotations are set to apply without asking.',
                }),
            };
        },

        /*
         * Editing an existing note.
         *
         * Passed through almost unchanged: the validator resolves `old_string`
         * against the live note and adds the surrounding raw-HTML context the
         * executor needs, which is exactly why `proposeWrite` validates first.
         * A non-unique match comes back as a validation error the model can act
         * on, instead of a card that fails on Apply.
         */
        edit_note: async (args, context) => {
            const noteId = String(args.note_id ?? '');
            const reference = parseCompositeItemId(noteId);
            if (!reference) throw new Error(`note_id "${noteId}" is not a valid id.`);
            const newString = String(args.new_string ?? '');
            const operation = String(args.operation ?? 'str_replace');
            const oldString = args.old_string != null ? String(args.old_string) : '';
            if (operation !== 'rewrite' && operation !== 'append' && !oldString) {
                throw new Error(
                    `old_string is required for ${operation}. Read the note first and copy the exact text you mean to change.`,
                );
            }

            const outcome = await proposeWrite(
                'edit_note',
                {
                    library_id: reference.library_id,
                    zotero_key: reference.zotero_key,
                    ...(reference.library_ref ? { library_ref: reference.library_ref } : {}),
                    operation,
                    ...(oldString ? { old_string: oldString } : {}),
                    new_string: newString,
                },
                context.toolCallId,
            );
            return {
                note: noteId,
                operation,
                ...outcomeFields(outcome, {
                    proposed: 'The user sees the change as a diff and approves it after your answer.',
                    applied: 'The note is edited — note edits are set to apply without asking.',
                }),
            };
        },

        /*
         * Correcting bibliographic metadata.
         *
         * The model names fields and new values; the old values are read here.
         * That is not a convenience — the approval card renders a diff, and a
         * model-supplied "old value" would let it show the user a change that
         * never existed.
         */
        edit_metadata: async (args, context) => {
            const itemId = String(args.item_id ?? '');
            const reference = parseCompositeItemId(itemId);
            if (!reference) throw new Error(`item_id "${itemId}" is not a valid id.`);
            const fields = (args.fields ?? {}) as Record<string, unknown>;
            const creators = Array.isArray(args.creators) ? args.creators : null;
            if (Object.keys(fields).length === 0 && !creators) {
                throw new Error('Nothing to change. Give at least one field, or a creators list.');
            }

            const resolved = await resolveItemReference(reference as any);
            if (resolved.status !== 'found') {
                throw new Error(`Could not find "${itemId}" in the library.`);
            }
            const item: any = resolved.item;

            const edits = Object.entries(fields).map(([field, value]) => ({
                field,
                old_value: (() => {
                    try {
                        return item.getField?.(field) ?? '';
                    } catch {
                        // An unknown field reads as empty here and is refused by
                        // the validator, which words it better than this could.
                        return '';
                    }
                })(),
                new_value: value == null ? '' : String(value),
            }));

            const unchanged = edits.filter((edit) => String(edit.old_value) === edit.new_value);
            if (unchanged.length === edits.length && !creators) {
                throw new Error(
                    `Nothing would change: ${unchanged.map((e) => e.field).join(', ')} already `
                    + 'hold those values. Check `get_metadata` before proposing an edit.',
                );
            }

            const outcome = await proposeWrite(
                'edit_metadata',
                {
                    library_id: item.libraryID,
                    zotero_key: item.key,
                    ...(libraryRefForLibraryID(item.libraryID)
                        ? { library_ref: libraryRefForLibraryID(item.libraryID) as string }
                        : {}),
                    edits: edits.filter((edit) => String(edit.old_value) !== edit.new_value),
                    ...(creators
                        ? { creators, old_creators: item.getCreatorsJSON?.() ?? null }
                        : {}),
                },
                context.toolCallId,
            );
            return {
                item: itemId,
                fields: edits.map((edit) => edit.field),
                ...outcomeFields(outcome, {
                    proposed: 'The user sees each field before and after, and approves after your answer.',
                    applied: 'Applied — metadata edits are set to apply without asking.',
                }),
            };
        },

        edit_annotations: async (args, context) => {
            const refs = annotationRefs(args.annotation_ids);
            const changes: Record<string, unknown> = {};
            if (args.color != null) {
                if (!isHighlightColorName(args.color)) {
                    throw new Error(
                        `color "${String(args.color)}" is not a Zotero palette colour. Use one of: ${HIGHLIGHT_COLOR_NAMES.join(', ')}.`,
                    );
                }
                changes.color = String(args.color);
            }
            if (args.comment != null) changes.comment = String(args.comment);
            const addTags = stringList(args.add_tags);
            const removeTags = stringList(args.remove_tags);
            if (addTags.length) changes.add_tags = addTags;
            if (removeTags.length) changes.remove_tags = removeTags;
            if (Object.keys(changes).length === 0) {
                throw new Error(
                    'Nothing to change. Give at least one of color, comment, add_tags or remove_tags.',
                );
            }

            const outcome = await proposeWrite(
                'edit_annotations',
                { operation: 'edit', edits: [{ annotation_refs: refs, changes }] },
                context.toolCallId,
            );
            return {
                annotations: refs.length,
                changes,
                ...outcomeFields(outcome, {
                    proposed: 'The user sees each annotation as it is now and approves after your answer.',
                    applied: 'Applied — annotations are set to apply without asking.',
                }),
            };
        },

        delete_annotations: async (args, context) => {
            const refs = annotationRefs(args.annotation_ids);
            const outcome = await proposeWrite(
                'edit_annotations',
                { operation: 'delete', annotation_refs: refs },
                context.toolCallId,
                undefined,
                'delete_annotations',
            );
            return {
                annotations: refs.length,
                ...outcomeFields(outcome, {
                    proposed:
                        'Deletion proposed. Name in your answer exactly which annotations, so the '
                        + 'user can check before approving.',
                    applied: 'Deleted — the user allowed annotation deletion without asking.',
                }),
            };
        },

        /*
         * A note on a paper, filed under it.
         *
         * `parent_item_id` and `library_ref` are what the validator and both
         * executors read to place a note: the validator resolves the id to the
         * regular item (an attachment or annotation id walks up to its paper)
         * and the note becomes that item's child, in that item's library.
         * Without them a note lands at the root of My Library, whatever paper
         * it was written for.
         */
        create_note: async (args, context) => {
            const itemId = String(args.item_id ?? '').trim();
            const reference = parseCompositeItemId(itemId);
            if (!reference) throw new Error(`item_id "${itemId}" is not a valid id.`);
            const rawContent = String(args.content ?? '').trim();
            if (!rawContent) throw new Error('content is required.');
            const { title, content } = noteTitleAndBody(args.title, rawContent);

            const outcome = await proposeWrite(
                'create_note',
                {
                    parent_item_id: itemId,
                    library_ref: reference.library_ref,
                    title,
                    content,
                },
                context.toolCallId,
            );
            return outcomeFields(outcome, {
                proposed: 'Shown to the user for approval once your answer is finished.',
                applied:
                    'The note is saved — note creation is set to apply without asking. Say it is '
                    + 'saved, not that it is proposed.',
            });
        },

        /*
         * Adding a paper found in the literature.
         *
         * Takes ids from the search rather than metadata from the model. That
         * keeps a long bibliographic record out of the context and, more to the
         * point, makes an invented paper impossible to add — a hallucinated DOI
         * has nothing here to resolve against.
         *
         * One approval per paper, all sharing this call's id so they read as
         * one decision: Beaver's own create-item card, listing each title,
         * authors and journal with a link out to the source.
         */
        add_papers_to_library: async (args, context) => {
            const ids = Array.isArray(args.openalex_ids)
                ? args.openalex_ids.map((id) => String(id).trim()).filter(Boolean)
                : [];
            if (ids.length === 0) {
                throw new Error('openalex_ids is required — pass ids from a search result.');
            }

            const missing = ids.filter((id) => !found.has(id));
            if (missing.length) {
                throw new Error(
                    `Not found in this conversation's search results: ${missing.join(', ')}. `
                    + 'Only papers returned by `search_web_literature` in this run can be added. '
                    + 'Search for the paper first, then pass the id it came back with.',
                );
            }

            const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
            /*
             * The destination rides on the proposal: the run ends when the
             * user approves, so a "file it afterwards" step never runs. A key
             * is required, not a name — a name would pass validation as a
             * nonexistent key and the card would promise a folder the item
             * could not land in.
             */
            const rawCollection = typeof args.collection_key === 'string'
                ? collectionKey(args.collection_key)
                : '';
            if (rawCollection && !/^[A-Z0-9]{8}$/.test(rawCollection)) {
                throw new Error(
                    `Not a collection key: ${rawCollection}. `
                    + 'Call `list_collections` and pass the `key` it returns, not the name.',
                );
            }
            const proposed: Array<Record<string, unknown>> = [];
            let lastOutcome: WriteOutcome | void = undefined;
            let added = 0;
            for (const id of ids) {
                const work = found.get(id)!;
                const outcome = await proposeWrite(
                    'create_item',
                    {
                        item: workToExternalReference(work),
                        file_available: Boolean(work.openAccessUrl),
                        ...(work.openAccessUrl ? { downloaded_url: work.openAccessUrl } : {}),
                        ...(reason ? { reason } : {}),
                        ...(rawCollection ? { collection_keys: [rawCollection] } : {}),
                    },
                    context.toolCallId,
                );
                if ('applied' in outcome) added += 1;
                // Once one paper is in, the status speaks for the ones that went
                // in; a paper that failed says so on its own entry.
                if (!(lastOutcome && 'applied' in lastOutcome)) lastOutcome = outcome;
                proposed.push({
                    title: work.title,
                    ...(work.year != null ? { year: work.year } : {}),
                    pdf: Boolean(work.openAccessUrl),
                    ...('failed' in outcome ? { not_added: outcome.failed } : {}),
                });
            }

            return {
                papers: proposed,
                ...(rawCollection ? { collection_key: rawCollection } : {}),
                ...outcomeFields(lastOutcome, {
                    proposed:
                        `${proposed.length} paper(s) put to the user for approval; an open-access PDF is `
                        + 'fetched for those that have one. Nothing is in the library until they approve, '
                        + 'so say what you are proposing and why — not that it was added.'
                        + (rawCollection
                            ? ' The card proposes filing them into the collection you named; the user can change that before approving.'
                            : ' The card lets the user pick the collection; do not promise to file them yourself afterwards.'),
                    applied:
                        `${added} paper(s) added — the user allowed library additions without asking `
                        + 'for this run. Say they are in the library, not that they are proposed, and '
                        + 'name any paper marked `not_added` as not imported.',
                }),
            };
        },

        /*
         * Filing: tags and collection membership.
         *
         * The executor and its approval card have been in the tree since
         * Beaver — what was missing was any way for a local model to reach
         * them, so the whole Organize category of built-in actions had nothing
         * to call. The model would describe the tidy-up it would do and then
         * do nothing, which reads exactly like success.
         */
        organize_items: async (args, context) => {
            const itemIds = Array.isArray(args.item_ids)
                ? args.item_ids.map((id) => String(id).trim()).filter(Boolean)
                : [];
            if (itemIds.length === 0) throw new Error('item_ids is required.');
            if (itemIds.length > MAX_ORGANIZE_ITEMS) {
                throw new Error(
                    `${itemIds.length} items is more than one call can organize. `
                    + `Split it into batches of ${MAX_ORGANIZE_ITEMS} or fewer.`,
                );
            }
            const malformed = itemIds.filter((id) => !parseItemReference(id));
            if (malformed.length) {
                throw new Error(
                    `Not valid item ids: ${malformed.join(', ')}. Use the ids a search or `
                    + 'metadata result returned, e.g. "u-23PWVCK3".',
                );
            }

            const list = (value: unknown) =>
                Array.isArray(value)
                    ? value.map((v) => collectionKey(String(v))).filter(Boolean)
                    : [];
            const addTags = list(args.add_tags);
            const removeTags = list(args.remove_tags);
            const addCollections = list(args.add_to_collections);
            const removeCollections = list(args.remove_from_collections);

            if (
                !addTags.length && !removeTags.length
                && !addCollections.length && !removeCollections.length
            ) {
                throw new Error(
                    'Nothing to change. Give at least one of add_tags, remove_tags, '
                    + 'add_to_collections or remove_from_collections.',
                );
            }
            // Collection *keys*, not names. The executor rejects a name, but by
            // then the user has already been shown a card describing a change
            // that cannot happen — better to catch it here and let the model
            // go and read `list_collections`.
            const notKeys = [...addCollections, ...removeCollections].filter(
                (key) => !/^[A-Z0-9]{8}$/.test(key),
            );
            if (notKeys.length) {
                throw new Error(
                    `Not collection keys: ${notKeys.join(', ')}. `
                    + 'Call `list_collections` and pass the `key` it returns, not the name.',
                );
            }

            const outcome = await proposeWrite(
                'organize_items',
                {
                    item_ids: itemIds,
                    ...(addTags.length || removeTags.length
                        ? {
                            tags: {
                                ...(addTags.length ? { add: addTags } : {}),
                                ...(removeTags.length ? { remove: removeTags } : {}),
                            },
                        }
                        : {}),
                    ...(addCollections.length || removeCollections.length
                        ? {
                            collections: {
                                ...(addCollections.length ? { add: addCollections } : {}),
                                ...(removeCollections.length ? { remove: removeCollections } : {}),
                            },
                        }
                        : {}),
                },
                context.toolCallId,
            );
            return {
                items: itemIds.length,
                ...(addTags.length ? { add_tags: addTags } : {}),
                ...(removeTags.length ? { remove_tags: removeTags } : {}),
                ...(addCollections.length ? { add_to_collections: addCollections } : {}),
                ...(removeCollections.length ? { remove_from_collections: removeCollections } : {}),
                ...outcomeFields(outcome, {
                    proposed: 'Shown to the user for approval once your answer is finished. Carry on.',
                    applied: 'Already done — the user set this kind of change to apply without asking.',
                }),
            };
        },

        create_collection: async (args, context) => {
            const name = String(args.name ?? '').trim();
            if (!name) throw new Error('name is required.');
            const itemIds = Array.isArray(args.item_ids)
                ? args.item_ids.map((id) => String(id).trim()).filter(Boolean)
                : [];
            const malformed = itemIds.filter((id) => !parseItemReference(id));
            if (malformed.length) {
                throw new Error(
                    `Not valid item ids: ${malformed.join(', ')}. Use the ids a search or `
                    + 'metadata result returned, e.g. "u-23PWVCK3".',
                );
            }
            const rawParentKey = String(args.parent_key ?? '');
            const parentKey = collectionKey(rawParentKey);
            if (parentKey && !/^[A-Z0-9]{8}$/.test(parentKey)) {
                throw new Error(
                    `parent_key "${parentKey}" is not a collection key. `
                    + 'Call `list_collections` and pass the `key` it returns.',
                );
            }

            const outcome = await proposeWrite(
                'create_collection',
                {
                    name,
                    ...newCollectionLibrary(itemIds, rawParentKey, parentKey),
                    ...(parentKey ? { parent_key: parentKey } : {}),
                    ...(itemIds.length ? { item_ids: itemIds } : {}),
                },
                context.toolCallId,
            );
            return {
                name,
                items: itemIds.length,
                ...outcomeFields(outcome, {
                    proposed: 'Shown to the user for approval once your answer is finished. Carry on.',
                    applied: 'The collection exists — the user set this kind of change to apply without asking.',
                }),
            };
        },
    };
}

/**
 * Turn an OpenAlex record into the shape the create-item action reads.
 *
 * `library_items` stays empty: it records where the paper already exists in the
 * user's library, which only a library search can answer, and claiming a
 * location that is not there would be worse than saying nothing.
 */
function workToExternalReference(work: OpenAlexWork): Record<string, unknown> {
    return {
        source: 'openalex',
        source_id: work.id,
        title: work.title,
        authors: work.authors.map((a) => a.name),
        ...(work.year != null ? { year: work.year } : {}),
        ...(work.venue ? { venue: work.venue } : {}),
        ...(work.abstract ? { abstract: work.abstract } : {}),
        ...(work.openAccessUrl ? { url: work.openAccessUrl } : {}),
        // Lowercase `doi`, which is what the create path reads — and reading it
        // does more than fill a field: a DOI sends the import through Zotero's
        // own translator first, so the item arrives with the journal, volume
        // and pages that OpenAlex does not carry. Spelled `DOI` it was silently
        // ignored, and items landed with no DOI and no journal.
        ...(work.doi ? { identifiers: { doi: work.doi } } : {}),
        library_items: [],
    };
}

/**
 * @param signal  Aborted when the user stops the run — Stop, New chat, Switch
 *   chat. It ends the model loop and every OpenAlex request in flight, and
 *   nothing this run started proposes, applies or asks anything afterwards.
 */
export async function executeLocalRequest(
    run: AgentRun,
    request: AgentRunRequest,
    get: Getter,
    set: Setter,
    signal?: AbortSignal,
): Promise<void> {
    /*
     * Built first, before anything is awaited.
     *
     * `createWSCallbacks` ties its callbacks to the local run that holds the
     * active slot when they are made — this one, as `executeWSRequest` starts
     * it — and drops whatever that run reports once it has been stopped,
     * replaced or has finished. That is what keeps a loop winding down from
     * streaming into the next answer, or finalizing, saving and unlocking it.
     * Made after an await, they could be tied to whichever run took the slot
     * in the meantime.
     */
    const callbacks = createWSCallbacks(set);
    const isStopped = () => runStopped(get, run.id, signal);

    // A selection question may run on its own model, and reads differently: it
    // is about one passage and its answer has to stay short enough to live in a
    // highlight's comment.
    const isSelectionChat = (request.user_prompt as any)?.origin?.kind === 'selection_chat';

    // A local embedding server that is chosen but not running must read as
    // "no topic search" for this whole run — prompt, tools and warning alike.
    await refreshSemanticSearchAvailability(boundFetch);
    const config = buildAgentFromPrefs(boundFetch, {
        surface: isSelectionChat ? 'selection' : 'main',
    });
    if (!config.ok) {
        // A misconfiguration is not a transport failure: say what to fix, and
        // do not offer a retry that would fail identically.
        callbacks.onError({
            event: 'error',
            type: 'not_configured',
            message: config.problem.message,
            run_id: run.id,
            is_retryable: false,
        });
        callbacks.onDone();
        return;
    }

    const prompt = request.user_prompt as any;
    // Nothing about this turn goes into the system prompt: the open document,
    // the page, a selected passage and the selection-question rule all ride in
    // the user message (composeUserContent), so the system message — the first
    // thing every request sends — is identical from turn to turn and the
    // provider's prompt cache covers the whole conversation before it.
    const systemPrompt = buildAgentSystemPrompt();

    /*
     * The thread's rolling summary rides ahead of the replayed history, and
     * old runs lose their tool plumbing. Both are wire-only: the stored runs
     * and the visible transcript never change, and turning the prefs off
     * restores the plain replay exactly.
     */
    const compaction = getPref('contextCompactionEnabled') === true
        ? get(threadCompactionAtom)
        : null;
    const messages = buildRunMessages({
        priorRuns: priorRunsForThread(get, run),
        // Attached items and the open page are stated as context rather than
        // inlined (the model fetches content through tools), and the message
        // builder composes that preamble itself — the same way for this turn
        // and for every replayed one.
        prompt,
        systemPrompt,
        ...(compaction
            ? {
                historySummary: {
                    text: compaction.summary,
                    throughRunId: compaction.throughRunId,
                    runCount: compaction.runCount,
                },
            }
            : {}),
        keepToolDetailRuns: getPref('contextPruneOldToolDetail') === true ? 2 : Number.POSITIVE_INFINITY,
    });

    const provider = createZoteroDataProvider() as any;
    const writesAllowed = getPref('allowAgentWrites') === true;
    /*
     * Full-text search can be switched off, to measure what it is worth.
     *
     * The question "how much better is this than the upstream plugin, which
     * only ever saw titles and abstracts" has no answer from reading the code.
     * The pref exists so the same questions can be run with the tool present
     * and absent; it is not something a user needs to touch.
     */
    const fulltextAvailable = isSemanticSearchAvailable() && getPref('fulltextSearchEnabled') !== false;
    const figuresAvailable = await figureSearchAvailable(config.readsImages);
    // One cache per run: the search fills it, `add_papers_to_library` reads it.
    // Scoped to the run so an id from an older question cannot be imported
    // without searching for it again.
    const foundLiterature: LiteratureCache = new Map();
    // The user's limits for this question, read now so a change in Settings
    // applies to the next message without a restart.
    const limits = readRunLimits();
    const sharedLiterature = literatureBudget(limits.literatureLookups);
    const rawDispatch = withLibrarySearchBudget(dataProviderToolDispatcher(provider, {
        search_web_literature: webSearchTool(foundLiterature, set, sharedLiterature, signal),
        ...literatureTools(foundLiterature, set, sharedLiterature, signal),
        ask_user_question: askUserQuestionTool(set, signal, isStopped),
        // No executor: the chips are rendered from the call's own arguments,
        // so calling it is the whole effect.
        return_suggestions: async () => 'Suggestions shown to the user.',
        ...(fulltextAvailable ? fulltextTool(run.id) : {}),
        ...(figuresAvailable ? figuresTool() : {}),
        ...(writesAllowed
            ? writeTools(provider, set, foundLiterature, run.id, isStopped, run.thread_id ?? request.thread_id ?? run.id)
            : {}),
    }, {
        // A text-only model is refused the image tools even when it names one,
        // and an area the user boxed in the reader is served from the pixels
        // that came with the message — no executor can open it by id.
        readsImages: config.readsImages,
        attachedImages: attachedImagesFromPrompt(prompt),
    }), limits.librarySearches);

    /*
     * Note which documents the run actually opened.
     *
     * The answer names pages in prose and leaves the citation marker off, so
     * the pages are linked after the fact — which needs to know what "page 7"
     * refers to. Recorded here rather than in each tool because every tool that
     * reads a document takes the same `attachment_id`, and one wrapper cannot
     * drift from the tools the way five call sites would.
     */
    const READS_A_DOCUMENT = new Set(['read_document', 'search_in_document', 'view_page_images']);
    const dispatch: typeof rawDispatch = async (name, args, context) => {
        const id = READS_A_DOCUMENT.has(name) ? String((args as any)?.attachment_id ?? '').trim() : '';
        if (id) recordReadAttachment(run.id, id);
        const result = await rawDispatch(name, args, context);
        // The sentence labels this page text printed: the only ones a citation
        // composed from it may carry (see validateComposedLocators).
        if (id && name === 'read_document') {
            const pages = Array.isArray((result as any)?.pages) ? (result as any).pages : [];
            for (const page of pages) {
                if (typeof page?.text !== 'string') continue;
                recordShownLocators(run.id, id, sentenceLabelsIn(page.text));
                // And the text behind each label, so a citation composed from
                // one shows the sentence on its hover card.
                const pageNumber = Number(page.page);
                if (Number.isFinite(pageNumber)) {
                    recordShownSentences(run.id, id, pageNumber, sentenceTextsIn(page.text));
                }
            }
        }
        return result;
    };

    logger(
        `executeLocalRequest: run ${run.id}, ${messages.length} messages, ${
            config.tools.length + 1
        } tools`,
    );

    try {
        await runLocalAgent({
            runId: run.id,
            threadId: run.thread_id ?? request.thread_id ?? run.id,
            messages,
            provider: config.provider,
            // Write tools are advertised only when allowed. Offering a tool the
            // dispatcher will refuse teaches the model to keep trying it.
            tools: [
                ...config.tools,
                WEB_SEARCH_TOOL,
                // Not behind the write preference: asking is not a change to
                // the library, and a user who has not turned writes on should
                // still be asked rather than guessed at.
                ASK_USER_QUESTION_TOOL,
                RETURN_SUGGESTIONS_TOOL,
                ...LITERATURE_GRAPH_TOOLS,
                ...(fulltextAvailable ? [FULLTEXT_TOOL_SCHEMA] : []),
                ...(figuresAvailable ? [FIGURE_TOOL_SCHEMA] : []),
                ...(writesAllowed ? WRITE_TOOL_SCHEMAS : []),
            ],
            dispatch,
            callbacks: callbacks as any,
            signal,
            warnings: config.warnings,
            embeddingFailureSince: (since: number) => embeddingFailureSince(currentEmbeddingModelId(), since),
            maxIterations: limits.modelRequests,
            outputTokenLimit: config.outputTokenLimit,
        });
    } catch (error) {
        // runLocalAgent reports through onError before rethrowing; this guard
        // exists so an unexpected throw cannot leave the composer locked.
        logger(`executeLocalRequest: run ${run.id} threw: ${error}`, 2);
    }
}
