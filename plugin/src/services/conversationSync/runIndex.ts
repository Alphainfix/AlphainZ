/**
 * What one stored run implies beyond its own row: the text a history search
 * should match, the papers it drew on, and the highlight it was asked from.
 *
 * `thread_items` ("chats about this paper") and `thread_anchors` ("the chat
 * behind this highlight") are local tables. The machine that ran a question
 * fills them as it goes; every other machine only ever receives the run, so it
 * derives them from the run itself. Library ids are device-local for group
 * libraries, so each reference resolves through its portable `library_ref`
 * when the run carries one.
 *
 * Pure apart from that library lookup, and free of database and UI imports so
 * both the database and the sync import can use it.
 */
import { resolveLibraryRef } from '../../utils/libraryIdentity';

export interface RunItemLink {
    libraryId: number;
    itemKey: string;
    /** 'attachment' when staged by the user, 'reader' when it was simply open. */
    source: string;
}

export interface RunAnchorLink {
    libraryId: number;
    annotationKey: string;
    attachmentKey: string | null;
    selectedText: string | null;
}

/**
 * This computer's id for a library a run referred to, or null when the
 * library is not here (a group this computer is not a member of).
 */
function localLibraryId(ref: { library_ref?: unknown; library_id?: unknown }): number | null {
    const libraryRef = typeof ref.library_ref === 'string' ? ref.library_ref : undefined;
    const libraryId = Number(ref.library_id);
    const resolved = resolveLibraryRef({
        library_ref: libraryRef,
        library_id: Number.isFinite(libraryId) ? libraryId : null,
    });
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : null;
}

/**
 * The library items a run drew on: what the user staged on the message, and
 * the document open in the reader when they asked (asking with a paper open is
 * asking about that paper). An attachment's parent counts too — the paper is
 * what anyone filtering by it would pick.
 */
export function itemLinksForRun(run: unknown): RunItemLink[] {
    const prompt = (run as any)?.user_prompt;
    const found = new Map<string, RunItemLink>();
    const add = (ref: any, itemKey: unknown, source: string) => {
        if (typeof itemKey !== 'string' || !itemKey) return;
        const libraryId = localLibraryId(ref ?? {});
        if (libraryId === null) return;
        const dedupeKey = `${libraryId}-${itemKey}`;
        // First writer wins, so an explicitly attached item is not relabelled
        // as merely open.
        if (!found.has(dedupeKey)) found.set(dedupeKey, { libraryId, itemKey, source });
    };

    for (const attachment of Array.isArray(prompt?.attachments) ? prompt.attachments : []) {
        add(attachment, attachment?.zotero_key, 'attachment');
        add(attachment, attachment?.parent_key, 'attachment');
    }

    const reader = prompt?.application_state?.reader_state;
    if (reader) {
        add(reader, reader.zotero_key, 'reader');
        add(reader, reader.parent_key, 'reader');
    }

    return [...found.values()];
}

/**
 * The highlight a run was asked from, when it came from the reader's
 * selection popup.
 *
 * The origin names the annotation by its writer-local library id. The anchor
 * sits on the attachment open in the reader, so when that attachment's
 * library is the same one, its portable ref says which library it is here.
 */
export function anchorLinkForRun(run: unknown): RunAnchorLink | null {
    const prompt = (run as any)?.user_prompt;
    const origin = prompt?.origin;
    if (origin?.kind !== 'selection_chat') return null;
    const annotationKey = origin.annotation_key;
    if (typeof annotationKey !== 'string' || !annotationKey) return null;

    const reader = prompt?.application_state?.reader_state;
    const sameLibraryAsReader = reader
        && Number(reader.library_id) === Number(origin.library_id)
        && typeof reader.library_ref === 'string';
    const libraryId = localLibraryId(
        sameLibraryAsReader
            ? { library_ref: reader.library_ref, library_id: origin.library_id }
            : { library_id: origin.library_id },
    );
    if (libraryId === null) return null;

    const selected = reader?.text_selection?.text;
    return {
        libraryId,
        annotationKey,
        attachmentKey: sameLibraryAsReader && typeof reader.zotero_key === 'string'
            ? reader.zotero_key
            : null,
        selectedText: typeof selected === 'string' && selected ? selected : null,
    };
}

/**
 * The words a history search should find this run by: the question, and
 * everything the model wrote back as text.
 *
 * Not the stored JSON: that holds field names and values — `model_name`,
 * `status`, `part_kind`, the model id — so a search for "model" or "response"
 * would match every conversation, and a quoted phrase would never match,
 * because the JSON stores it escaped. Thinking, tool arguments and tool results
 * are left out for the same reason: they are machinery, not the conversation.
 */
export function runSearchText(run: unknown): string {
    const record = run as any;
    const pieces: string[] = [];
    const question = record?.user_prompt?.content;
    if (typeof question === 'string' && question.trim()) pieces.push(question);
    for (const message of Array.isArray(record?.model_messages) ? record.model_messages : []) {
        if (message?.kind !== 'response' || !Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
            if (part?.part_kind === 'text' && typeof part.content === 'string' && part.content) {
                pieces.push(part.content);
            }
        }
    }
    return pieces.join('\n');
}
