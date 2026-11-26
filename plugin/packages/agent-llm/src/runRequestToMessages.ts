/**
 * Convert the UI's run history into the message list the loop takes.
 *
 * The chat panel keeps each turn as an `AgentRun` carrying `model_messages`, a
 * `ModelRequest`/`ModelResponse` pair sequence in Pydantic-AI's shape. The
 * backend used to own conversation state, so the run request on the wire holds
 * only the *current* prompt — which means a local run has to rebuild the
 * history itself or every turn arrives with amnesia.
 *
 * Pure: shapes in, shapes out, no Zotero and no network.
 */

import type { ChatMessage, ToolResultMessage } from './types';

// ---------------------------------------------------------------------------
// Input shapes (structural copies; see localRunner for why they are not imported)
// ---------------------------------------------------------------------------

/**
 * Cap on the quoted selection.
 *
 * A selection is normally a sentence or two, but nothing stops the user from
 * selecting a whole chapter; the model can read the rest through the document
 * tools rather than through the prompt.
 */
const MAX_SELECTION_CHARS = 4000;

interface PromptLike {
    content: string;
    custom_instructions?: string;
    attachments?: Array<Record<string, any>>;
    application_state?: Record<string, any>;
    /** Where the question came from; a selection question wants a short answer. */
    origin?: { kind?: string } & Record<string, any>;
}

interface PartLike {
    part_kind: string;
    content?: any;
    tool_name?: string;
    tool_call_id?: string;
    args?: string | Record<string, any> | null;
}

interface ModelMessageLike {
    kind: 'request' | 'response';
    parts?: PartLike[];
}

export interface RunLike {
    id: string;
    thread_id?: string | null;
    status?: string;
    /** Why a run ended in error; only `type` is read (see `replayFor`). */
    error?: { type?: string | null } | null;
    user_prompt?: PromptLike;
    model_messages?: ModelMessageLike[];
    created_at?: string;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function argsToJson(args: PartLike['args']): string {
    if (typeof args === 'string') return args;
    if (args && typeof args === 'object') {
        try {
            return JSON.stringify(args);
        } catch {
            return '{}';
        }
    }
    return '{}';
}

function toolContentToString(content: any): string {
    if (typeof content === 'string') return content;
    if (content === undefined || content === null) return 'null';
    try {
        return JSON.stringify(content);
    } catch {
        return '"[unserializable tool result]"';
    }
}

/**
 * How much of a run the next request is shown.
 *
 * - `full`: everything; a call the transcript left hanging is answered as
 *   interrupted. For a run that finished, and for one still open.
 * - `answered`: the question, what the assistant wrote, and each tool call
 *   with its result; a call that never got a result is left out. For a run
 *   that was stopped or failed partway: what it got done still holds, and the
 *   next message ("continue", "try again") needs the question it stopped on.
 * - `text`: the question and what the assistant wrote, without the tool
 *   traffic. For a run that overflowed the context window, whose tool results
 *   are what overflowed it: replayed, they would overflow the next request the
 *   same way.
 *
 * The error itself is never replayed. It is not something the assistant said,
 * and the user already saw it on the error card.
 */
export type RunReplay = 'full' | 'answered' | 'text';

/** The error type of a run that overflowed the model's context window. */
const CONTEXT_WINDOW_EXCEEDED = 'llm_context_window_exceeded';

/**
 * The replay a prior run gets, from what is stored with it — so the same
 * stored runs always produce the same messages, which the prompt cache needs.
 *
 * A failed run whose error type did not travel with it may have been an
 * overflow, so it gets the replay that cannot overflow again.
 */
export function replayFor(run: Pick<RunLike, 'status' | 'error'>): RunReplay {
    if (run.status === 'canceled') return 'answered';
    if (run.status !== 'error') return 'full';
    const type = run.error?.type;
    return typeof type === 'string' && type !== '' && type !== CONTEXT_WINDOW_EXCEEDED ? 'answered' : 'text';
}

/** What one response said, its text parts joined. */
function responseText(parts: PartLike[]): string {
    return parts
        .filter((p) => p.part_kind === 'text')
        .map((p) => String(p.content ?? ''))
        .join('');
}

/** A request part that answers a tool call: its result, or a request to call it again. */
function isToolAnswer(part: PartLike): boolean {
    return (part.part_kind === 'tool-return' || part.part_kind === 'retry-prompt') && !!part.tool_call_id;
}

/** The tool calls in a transcript that a later request part answers. */
function answeredCallIds(transcript: ModelMessageLike[]): Set<string> {
    const called = new Set<string>();
    const answered = new Set<string>();
    for (const message of transcript) {
        for (const part of message.parts ?? []) {
            if (message.kind === 'response') {
                if (part.part_kind === 'tool-call' && part.tool_call_id) called.add(part.tool_call_id);
            } else if (isToolAnswer(part) && called.has(part.tool_call_id!)) {
                answered.add(part.tool_call_id!);
            }
        }
    }
    return answered;
}

/**
 * Flatten one run's `model_messages` into chat messages.
 *
 * Tool calls and their returns are the delicate part: the wire format requires
 * every `tool_call_id` in an assistant turn to be answered by a following tool
 * message, and every tool message to answer a call before it. A run
 * interrupted between the call and its result would otherwise produce a
 * transcript the next request rejects outright, so in a `full` replay an
 * unanswered call gets a synthetic result saying it never finished — which is
 * both true and something the model can act on. A result that answers no call
 * before it is dropped.
 */
export function runToMessages(run: RunLike, replay: RunReplay = 'full'): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // The same text that went out when this run happened — preamble and all.
    // Replaying the bare question would make every earlier turn differ from
    // what the provider saw, and the prompt cache stops at the first difference.
    if (run.user_prompt?.content) {
        messages.push({ role: 'user', content: composeUserContent(run.user_prompt) });
    }

    const transcript = run.model_messages ?? [];

    // What the assistant wrote across its steps, as one reply: with the tool
    // calls between them gone, the steps would otherwise be assistant messages
    // back to back.
    if (replay === 'text') {
        const text = transcript
            .filter((message) => message.kind === 'response')
            .map((message) => responseText(message.parts ?? []))
            .filter((part) => part.length > 0)
            .join('\n\n');
        if (text) messages.push({ role: 'assistant', content: text });
        return messages;
    }

    // In a partial replay, only the calls that got a result are kept.
    const kept = replay === 'answered' ? answeredCallIds(transcript) : null;
    const pendingCallIds: string[] = [];
    const answeredCallIdSet = new Set<string>();
    const callNameById = new Map<string, string>();

    for (const message of transcript) {
        const parts = message.parts ?? [];

        if (message.kind === 'response') {
            const text = responseText(parts);
            const toolCalls = parts
                .filter((p) => p.part_kind === 'tool-call' && p.tool_call_id && (!kept || kept.has(p.tool_call_id)))
                .map((p) => {
                    callNameById.set(p.tool_call_id!, p.tool_name ?? 'unknown');
                    pendingCallIds.push(p.tool_call_id!);
                    return {
                        id: p.tool_call_id!,
                        name: p.tool_name ?? 'unknown',
                        argumentsJson: argsToJson(p.args),
                    };
                });

            // Thinking parts are dropped: they are the provider's own scratch
            // space, not part of the conversation, and replaying them invites
            // the model to treat old reasoning as established fact.
            if (text || toolCalls.length > 0) {
                messages.push({
                    role: 'assistant',
                    content: text,
                    ...(toolCalls.length > 0 ? { toolCalls } : {}),
                });
            }
            continue;
        }

        // A request message carries tool returns and any follow-up user text.
        for (const part of parts) {
            // A result for a call this transcript never made (or made later)
            // answers nothing, and strict endpoints reject the whole request
            // over one such message.
            if (!isToolAnswer(part) || !callNameById.has(part.tool_call_id!)) continue;
            const callId = part.tool_call_id!;
            answeredCallIdSet.add(callId);
            messages.push({
                role: 'tool',
                toolCallId: callId,
                name: part.tool_name ?? callNameById.get(callId) ?? 'unknown',
                content: part.part_kind === 'retry-prompt'
                    ? toolContentToString(part.content ?? 'The call was rejected; try again.')
                    : toolContentToString(part.content),
            } as ToolResultMessage);
        }
    }

    // Close any call the transcript left hanging. A partial replay has none:
    // it kept only the calls that were answered.
    for (const callId of pendingCallIds) {
        if (answeredCallIdSet.has(callId)) continue;
        messages.push({
            role: 'tool',
            toolCallId: callId,
            name: callNameById.get(callId) ?? 'unknown',
            content: JSON.stringify({
                error: 'This tool call did not complete — the previous run was interrupted.',
            }),
        } as ToolResultMessage);
    }

    return messages;
}

export interface BuildMessagesOptions {
    /** Runs in this thread, oldest first. The current run may be included. */
    priorRuns?: RunLike[];
    /** The prompt for this turn. */
    prompt: PromptLike;
    systemPrompt: string;
    /** Cap on prior turns replayed, newest kept. */
    maxPriorRuns?: number;
    /**
     * The thread's rolling summary. Runs up to and including `throughRunId`
     * are replaced on the wire by the summary text; the stored runs are not
     * touched. A cutoff id that is not in `priorRuns` (a thread imported from
     * another machine can diverge) falls back to replaying everything — a
     * repeated fact costs tokens, a dropped one costs the answer.
     */
    historySummary?: { text: string; throughRunId: string; runCount: number };
    /**
     * How many of the newest replayed runs keep their full tool detail.
     * Older runs get their tool-call arguments and tool-result text clipped —
     * the prose survives, the plumbing shrinks. Non-finite disables clipping.
     */
    keepToolDetailRuns?: number;
}

/** Replayed tool results older than the detail window are clipped to this. */
const PRUNED_TOOL_RESULT_CHARS = 200;
/** Replayed tool-call arguments older than the detail window are clipped to this. */
const PRUNED_TOOL_ARGS_CHARS = 300;

/**
 * Shrink one old run's messages: long tool-call arguments and oversized tool
 * results lose their tails. Assistant and user prose is never touched — it is
 * the conversation; the tool traffic is scaffolding the model has already
 * acted on.
 */
function pruneToolDetail(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => {
        if (message.role === 'tool' && typeof message.content === 'string'
            && message.content.length > PRUNED_TOOL_RESULT_CHARS) {
            return {
                ...message,
                content: `${message.content.slice(0, PRUNED_TOOL_RESULT_CHARS)}…[trimmed]`,
            };
        }
        if (message.role === 'assistant' && message.toolCalls?.length) {
            const clipped = message.toolCalls.map((call) =>
                call.argumentsJson && call.argumentsJson.length > PRUNED_TOOL_ARGS_CHARS
                    ? { ...call, argumentsJson: `${call.argumentsJson.slice(0, PRUNED_TOOL_ARGS_CHARS)}…[trimmed]` }
                    : call,
            );
            return { ...message, toolCalls: clipped };
        }
        return message;
    });
}

/**
 * Assemble the full message list for one turn.
 *
 * History is capped rather than unbounded: a long thread would otherwise grow
 * the request until it outgrew the context window, and the failure mode there
 * is a hard error mid-conversation rather than a gradual loss of quality.
 */
export function buildRunMessages(options: BuildMessagesOptions): ChatMessage[] {
    const { priorRuns = [], prompt, systemPrompt, maxPriorRuns = 10, historySummary } = options;
    const keepToolDetailRuns = options.keepToolDetailRuns ?? 2;

    /*
     * Every run is replayed, a stopped or failed one included, each as far as
     * is safe to send again (`replayFor`).
     *
     * Leaving a failed run out entirely would send the message after it — "try
     * again", "continue", a follow-up — without the question it failed on or
     * anything it had already found.
     */

    // The summary stands in for everything up to its cutoff.
    let summaryMessage: ChatMessage | null = null;
    let replayable = priorRuns;
    if (historySummary) {
        const cutIndex = priorRuns.findIndex((run) => run.id === historySummary.throughRunId);
        if (cutIndex >= 0) replayable = priorRuns.slice(cutIndex + 1);
        summaryMessage = {
            role: 'user',
            content:
                `[Summary of ${historySummary.runCount} earlier exchanges in this conversation — `
                + `the originals are not repeated below]\n${historySummary.text}`,
        };
    }

    const kept = replayable.slice(-maxPriorRuns);

    /*
     * Standing instructions belong in the system message, not appended to what
     * the user just typed.
     *
     * Appending them made the user's message something the user did not write,
     * and anything keyed to that message read the wrong thing. The language
     * rule is the clearest case: a standing instruction reading "答复默认用中文；
     * 如果我用纯英文问，就用英文答" is itself Chinese, so appending it to an
     * English question produced a message that was no longer in English — and
     * the model, correctly following both the instruction and the prompt,
     * answered in Chinese. They are also standing, so repeating them on every
     * turn while calling them part of this one misdescribes them.
     *
     * Last in the system message: closest to generation, and after the rules it
     * is allowed to override.
     */
    const systemContent = prompt.custom_instructions
        ? `${systemPrompt}\n\n## Standing instructions from the user\n\n${prompt.custom_instructions}`
        : systemPrompt;

    const messages: ChatMessage[] = [{ role: 'system', content: systemContent }];
    if (summaryMessage) messages.push(summaryMessage);
    kept.forEach((run, index) => {
        const runMessages = runToMessages(run, replayFor(run));
        // The newest runs keep their full tool detail — the model often refers
        // back to what it just read; older plumbing is clipped.
        const keepDetail = index >= kept.length - keepToolDetailRuns;
        messages.push(...(keepDetail ? runMessages : pruneToolDetail(runMessages)));
    });

    messages.push({ role: 'user', content: composeUserContent(prompt) });

    return messages;
}

/**
 * How a selection question is answered. Stated with the question rather than
 * in the system prompt, so a passage question in the middle of a thread does
 * not change the one message every request begins with.
 */
const SELECTION_QUESTION_NOTE =
    'This question is about the selected passage quoted above, asked from inside the reader. '
    + 'Answer about that passage, not about the paper in general; if it is only intelligible in '
    + 'context, read the page it is on before answering — do not answer from the title and abstract. '
    + 'Keep it to two or three sentences: the answer is displayed next to the highlight and can be '
    + "saved into the highlight's own comment, so length costs the user directly. No preamble, no "
    + 'restating the passage, no bullet lists.';

/**
 * The user message as the model sees it: what is attached and open, how a
 * selection question should be answered, then what the user typed.
 *
 * One function for the turn being sent and for every replayed turn, so a
 * conversation's earlier messages are byte-for-byte what they were — which is
 * what lets the provider's prompt cache cover them.
 */
export function composeUserContent(prompt: PromptLike): string {
    const parts: string[] = [];
    const note = describePromptContext(prompt);
    if (note) parts.push(note);
    if (prompt.origin?.kind === 'selection_chat') parts.push(SELECTION_QUESTION_NOTE);
    parts.push(prompt.content);
    return parts.join('\n\n');
}

/** Longest highlight quoted inline; past this the model can call `get_annotations`. */
const MAX_QUOTED_ANNOTATION = 300;

/**
 * One attached highlight, rendered as its own text.
 *
 * Returns null for anything that is not a text-bearing annotation, so an image
 * region still falls through to the "— an image" line that tells the model to
 * open it.
 */
function annotationLine(attachment: any): string | null {
    if (attachment?.type !== 'annotation') return null;
    const kind = attachment.annotation_type;
    if (kind !== 'highlight' && kind !== 'underline' && kind !== 'note') return null;

    const text = typeof attachment.text === 'string' ? attachment.text.trim() : '';
    const comment = typeof attachment.comment === 'string' ? attachment.comment.trim() : '';
    if (!text && !comment) return null;

    const page = attachment.page_label ? `p.${attachment.page_label}` : null;
    const clipped = text.length > MAX_QUOTED_ANNOTATION
        ? `${text.slice(0, MAX_QUOTED_ANNOTATION)}…`
        : text;

    const parts = [kind === 'note' ? 'Note' : 'Highlight'];
    if (page) parts.push(page);
    const head = parts.join(', ');
    const body = clipped ? `"${clipped.replace(/\s+/g, ' ')}"` : '(no quoted text)';
    return comment ? `${head} — ${body} — user's comment: ${comment}` : `${head} — ${body}`;
}

/** The id an attachment is named by in the preamble, and passed to tools as. */
function attachmentId(attachment: any): string | null {
    return (
        attachment?.attachment_id ??
        attachment?.item_id ??
        (attachment?.library_ref && attachment?.zotero_key
            ? `${attachment.library_ref}-${attachment.zotero_key}`
            : null)
    );
}

/**
 * Where an area the user boxed in the reader sits: the attachment it was drawn
 * on and the 1-based page, which is what `view_page_images` takes. Null for
 * anything else, or when the position did not travel.
 */
function boxedRegionPage(attachment: any): { attachmentId: string; page: number } | null {
    if (attachment?.type !== 'annotation' || attachment.annotation_type !== 'image') return null;
    const index = attachment.position?.page_index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
    if (!attachment.library_ref || !attachment.parent_key) return null;
    return { attachmentId: `${attachment.library_ref}-${attachment.parent_key}`, page: index + 1 };
}

/**
 * The pixels of the images attached to this message, by the id the preamble
 * names them with.
 *
 * An area the user boxed in the reader has no file behind it, so no tool can
 * open it by id; its rendering is read when the message is sent and travels
 * with it. Handing these to the dispatcher is what lets `view_attachment_image`
 * show the model exactly the region the user drew.
 */
export function attachedImagesFromPrompt(
    prompt: Pick<PromptLike, 'attachments'>,
): Map<string, { mimeType: string; base64: string }> {
    const images = new Map<string, { mimeType: string; base64: string }>();
    for (const attachment of prompt.attachments ?? []) {
        const base64 = typeof attachment?.image_base64 === 'string' ? attachment.image_base64 : '';
        const id = attachmentId(attachment);
        // Zotero caches an image annotation's rendering as PNG.
        if (base64 && id) images.set(id, { mimeType: 'image/png', base64 });
    }
    return images;
}

/**
 * Say when an attachment is a picture.
 *
 * A figure the user boxed in the reader arrived here as a line of text with an
 * id, indistinguishable from an attached PDF — so "what does this show?" got an
 * answer about the paper in general. Naming it as an image, and naming the tool
 * that opens it, is what turns the attachment into something the model can
 * actually look at. An image file from the library carries its kind on its
 * attachment stub rather than at the top level.
 */
function isImageAttachment(attachment: any): boolean {
    const kind = attachment?.annotation_type ?? attachment?.content_kind ?? attachment?.attachment?.content_kind;
    return kind === 'image';
}

/** One attachment's line in the preamble. */
function attachmentEntry(attachment: any): string {
    const id = attachmentId(attachment);

    /*
     * A highlight is quoted here, not just named.
     *
     * The general rule — name the attachment, let a tool fetch the text — is
     * right for a PDF and backwards for an annotation, whose entire content is
     * one short quote. Naming it alone made the model call `get_annotations` to
     * read thirty tokens it could have been handed, and, when told not to call
     * tools, answer that it had nothing.
     */
    const quoted = annotationLine(attachment);
    if (quoted) return `- ${quoted}${id ? ` [${id}]` : ''}`;

    const region = boxedRegionPage(attachment);
    const name = attachment.title ?? attachment.name ?? attachment.filename
        ?? (region ? `Image region${attachment.page_label ? `, p.${attachment.page_label}` : ''}` : '(untitled)');
    if (!isImageAttachment(attachment)) return `- ${name}${id ? ` [${id}]` : ''}`;
    return `- ${name}${id ? ` [${id}]` : ''} — an image`
        + (region ? `, boxed on page ${region.page} of [${region.attachmentId}]` : '');
}

/**
 * The attached annotations this message is about, when its origin names them.
 *
 * Explain or Ask on one highlight attaches it beside every highlight staged
 * from the open paper; as one quoted line among dozens, nothing says which one
 * the user clicked. The origin carries its key (`annotation_key`, or
 * `annotation_keys` for several), and a `library_id` there must match too.
 */
function targetAnnotations(prompt: PromptLike, attachments: Array<Record<string, any>>): Array<Record<string, any>> {
    const origin = prompt.origin ?? {};
    const keys = new Set(
        [origin.annotation_key, ...(Array.isArray(origin.annotation_keys) ? origin.annotation_keys : [])]
            .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
            .map((key) => key.trim()),
    );
    if (keys.size === 0) return [];
    const libraryId = typeof origin.library_id === 'number' ? origin.library_id : null;
    return attachments.filter((attachment) =>
        attachment?.type === 'annotation'
        && keys.has(String(attachment.zotero_key ?? ''))
        && (libraryId === null || typeof attachment.library_id !== 'number' || attachment.library_id === libraryId));
}

/** What to call one annotation when saying the question is about it. */
function annotationNoun(attachment: any): string {
    switch (attachment?.annotation_type) {
        case 'highlight': return 'highlight';
        case 'underline': return 'underlined passage';
        case 'note': return 'note';
        case 'image': return 'image region';
        case 'ink': return 'drawing';
        default: return 'annotation';
    }
}

/**
 * The 1-based page a selected passage is on, when the selection says.
 *
 * Read from `page_index`, the 0-based index of the page the selection itself
 * sits on (Zotero's `position.pageIndex`). The selection's `page` is not a
 * substitute: where it is set it holds the page in view when the passage was
 * staged, or a highlight's printed page label, and runs already stored carry
 * those values — read as the passage's page, they would tell the model a page
 * the passage is not on.
 */
function selectionPage(selection: unknown): number | null {
    const index = (selection as { page_index?: unknown } | null | undefined)?.page_index;
    return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index + 1 : null;
}

/**
 * Describe attached items and reader position as a text preamble.
 *
 * The model reaches library content through tools, so an attachment only needs
 * to name itself and its id — enough for the model to go and read it. Inlining
 * the content here would duplicate what `read`/`get_metadata` return and spend
 * the window twice on the same text.
 */
export function describePromptContext(prompt: PromptLike): string | null {
    const lines: string[] = [];

    const attachments = prompt.attachments ?? [];
    if (attachments.length > 0) {
        const targeted = targetAnnotations(prompt, attachments);
        const others = attachments.filter((attachment) => !targeted.includes(attachment));
        if (targeted.length > 0) {
            lines.push(
                targeted.length === 1
                    ? `The user is asking about this ${annotationNoun(targeted[0])}:`
                    : 'The user is asking about these annotations:',
            );
            lines.push(...targeted.map(attachmentEntry));
        }
        if (others.length > 0) {
            lines.push(targeted.length > 0 ? 'Also attached to this message:' : 'Items attached to this message:');
            lines.push(...others.map(attachmentEntry));
        }
        if (attachments.some(isImageAttachment)) {
            lines.push(
                'Call `view_attachment_image` on an attached image before answering about it.'
                + (attachments.some((attachment) => boxedRegionPage(attachment))
                    ? ' If it cannot open an area boxed in the reader, `view_page_images` on the page '
                        + 'named beside it shows the area in place.'
                    : ''),
            );
        }
    }

    const reader = prompt.application_state?.reader_state;
    if (reader) {
        /*
         * The selected passage's own page, when it travelled with it.
         *
         * `current_page` is the page mostly in view, and a sentence selected at
         * the top of page 6 while page 5 fills the screen is not on it. The
         * model is told to read the page the passage is on, so that is the page
         * it is given.
         */
        const selectionText = reader.text_selection?.text;
        const hasSelection = typeof selectionText === 'string' && selectionText.trim().length > 0;
        const passagePage = hasSelection ? selectionPage(reader.text_selection) : null;
        const page = passagePage ?? reader.current_page ?? reader.page_index;
        const title = reader.title ?? reader.attachment_title;
        // The reader state carries the attachment's identity, not its title, and
        // the id is the useful half: without it the model is told "a document"
        // and has to go looking for the paper the user already has open — and it
        // cannot read the page it is being asked about at all.
        const id =
            reader.zotero_key && (reader.library_ref || reader.library_id != null)
                ? `${reader.library_ref ?? reader.library_id}-${reader.zotero_key}`
                : null;
        if (title || id || page != null) {
            lines.push(
                `Currently open in the reader: ${title ?? 'a document'}${
                    id ? ` [${id}]` : ''
                }${page != null ? `, page ${page}` : ''}.`,
            );
        }

        /*
         * The user's own highlights on the open paper.
         *
         * Some of them are attached to this message as items; the count is the
         * whole set. Without it a model that saw ten chips would answer "your
         * ten highlights" about a paper carrying forty, and never think to
         * fetch the rest.
         */
        const annotationCount = (reader as any).annotation_count;
        if (typeof annotationCount === 'number' && annotationCount > 0) {
            const attachedAnnotations = attachments.filter(
                (a: any) => a?.type === 'annotation',
            ).length;
            const covered = attachedAnnotations >= annotationCount;
            lines.push(
                `It carries ${annotationCount} of the user's own highlights or notes`
                + (covered
                    ? ' — all of them are quoted above.'
                    : ` — ${attachedAnnotations} quoted above; \`get_annotations\` returns the rest.`),
            );
        }

        // The selected passage, verbatim.
        //
        // This is the whole point of a selection question, and it used to be
        // dropped: the passage reached `application_state` and stopped there, so
        // "what does this mean?" arrived with no "this" attached and the model
        // answered about the paper in general.
        if (hasSelection) {
            const trimmed = selectionText.trim();
            const passage =
                trimmed.length > MAX_SELECTION_CHARS
                    ? `${trimmed.slice(0, MAX_SELECTION_CHARS)}…`
                    : trimmed;
            lines.push(
                passagePage !== null
                    ? `The user has selected this passage on page ${passagePage}, which is what "this" refers to:`
                    : 'The user has selected this passage, which is what "this" refers to:',
            );
            lines.push(`"""\n${passage}\n"""`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : null;
}
