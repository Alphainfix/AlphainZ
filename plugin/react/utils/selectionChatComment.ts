/**
 * Saving a selection answer into the highlight's own comment.
 *
 * Zotero already shows an annotation's comment when the highlight is clicked, and
 * syncs it with the library — so the comment field is where an anchored
 * conversation belongs. Nothing custom has to be drawn in the reader, and the
 * answer travels with the paper.
 *
 * Appended rather than overwritten: a highlight may already carry the user's own
 * note, and asking a second question about the same passage should not erase the
 * first answer.
 */

import { logger } from '@beaver/agent-core/platform/logger';

import { planRunStream } from '../components/agentRuns/workStream';
import { toZoteroCommentText } from '../../src/utils/zoteroCommentText';
import { excludedLibraryIdsAtom } from '../atoms/profile';
import { store } from '../store';
import { t } from '../../src/utils/i18n';

/** Marks the block this plugin appended, so a second answer can be added after it. */
const MARKER = '— AlphainZ';

export interface CommentEntry {
    question: string;
    answer: string;
}

/**
 * Build the text to store in the comment.
 *
 * Q and A both: a highlight can collect several exchanges over time, and
 * without its question each stacked answer loses what it was answering. The
 * answer itself is the final answer only — the narration is stripped upstream
 * by {@link finalAnswerText}.
 *
 * Written in the field's own idiom: Zotero's comment understands four tags —
 * <i>, <b>, <sub>, <sup> — and nothing else, so formulas are converted to
 * those (see `latexToRichText`), markdown emphasis becomes the matching tag,
 * and everything else the model writes by habit is stripped.
 */
export function formatCommentEntry(entry: CommentEntry): string {
    const question = entry.question.trim();
    const answer = stripMarkdown(entry.answer.trim());
    return `${MARKER}\nQ: ${question}\nA: ${answer}`;
}

/**
 * Turn what the model wrote into what the comment can show: formulas as
 * sub- and superscripts, emphasis as Zotero's tags, citation markup gone.
 */
export function stripMarkdown(text: string): string {
    // One conversion for every comment this plugin writes — see
    // `toZoteroCommentText` for what it does and why.
    return toZoteroCommentText(text);
}

/** Append an entry to whatever the comment already holds. */
export function appendToComment(existing: string, entry: CommentEntry): string {
    const block = formatCommentEntry(entry);
    const current = existing.trim();
    return current ? `${current}\n\n${block}` : block;
}

/**
 * Why an answer could not be written into its highlight:
 * - `missing`: the highlight is gone — deleted while the answer was streaming;
 * - `read_only`: Zotero does not let this user change it — a read-only group
 *   library, another member's annotation, one embedded in the PDF file;
 * - `excluded`: its library is excluded from AlphainZ, which does not change it;
 * - `error`: saving failed for another reason.
 */
export type CommentSaveFailure = 'missing' | 'read_only' | 'excluded' | 'error';

export type CommentSaveResult =
    | { saved: true }
    | { saved: false; reason: CommentSaveFailure; message: string };

/** One sentence for the user saying why the save failed. */
export function commentSaveFailureMessage(reason: CommentSaveFailure, detail?: string): string {
    switch (reason) {
        case 'missing':
            return t('That highlight no longer exists.');
        case 'read_only':
            return t('Zotero does not let you change that highlight, so the answer could not be added to its comment.');
        case 'excluded':
            return t('That highlight is in a library excluded from AlphainZ, so AlphainZ does not change it.');
        case 'error':
            return detail
                ? t('Zotero could not save the comment: {detail}', { detail })
                : t('Zotero could not save the comment.');
    }
}

function saveFailure(reason: CommentSaveFailure, detail?: string): CommentSaveResult {
    return { saved: false, reason, message: commentSaveFailureMessage(reason, detail) };
}

/**
 * Write the entry into a highlight's comment, and say why when it cannot.
 */
export async function saveCommentToAnnotation(
    libraryId: number,
    annotationKey: string,
    entry: CommentEntry,
): Promise<CommentSaveResult> {
    let item: Zotero.Item | false;
    try {
        item = Zotero.Items.getByLibraryAndKey(libraryId, annotationKey) as Zotero.Item | false;
    } catch (error) {
        logger(`saveCommentToAnnotation: lookup failed: ${error}`, 1);
        item = false;
    }
    if (!item || !item.isAnnotation() || item.deleted) return saveFailure('missing');
    // Excluded since the question was asked: AlphainZ does not change such a library.
    if (store.get(excludedLibraryIdsAtom).includes(item.libraryID)) return saveFailure('excluded');
    try {
        if (!item.isEditable('edit') || (item as any).annotationIsExternal) return saveFailure('read_only');
    } catch {
        // An answer the check cannot give is left to the save itself.
    }

    try {
        item.annotationComment = appendToComment(item.annotationComment || '', entry);
        await item.saveTx();
        return { saved: true };
    } catch (error) {
        logger(`saveCommentToAnnotation: ${error}`, 1);
        const detail = error instanceof Error ? error.message : String(error ?? '');
        return saveFailure('error', detail.trim() || undefined);
    }
}

/**
 * Write the entry into a highlight's comment. Returns whether it was written;
 * `saveCommentToAnnotation` says why when it was not.
 */
export async function saveEntryToAnnotation(
    libraryId: number,
    annotationKey: string,
    entry: CommentEntry,
): Promise<boolean> {
    return (await saveCommentToAnnotation(libraryId, annotationKey, entry)).saved;
}

/** The model's final answer text from a finished run. */
export function finalAnswerText(run: {
    model_messages?: Array<{ kind: string; parts: Array<Record<string, any>> }>;
}): string {
    /*
     * The answer as the fold defines it — nothing else.
     *
     * Two wrong versions preceded this one. Walking backwards to the last text
     * dropped citations whenever a tool ran *after* the answer (a 1365-char
     * answer, then `return_suggestions`, then a 162-char sign-off — and the
     * sign-off became "the answer"). Joining every text part fixed that but
     * saved the narration too, so a comment opened with "let me look at pages
     * 4 and 7" before it got to the point.
     *
     * `planRunStream` already draws this line for the panel: text before the
     * last real tool call is the model talking its way there, text after it is
     * the answer — and `return_suggestions` does not count as a tool, which is
     * what keeps the citations case right. One classifier, both surfaces.
     */
    const messages = (run.model_messages ?? []) as any[];
    const answerIndexes = new Set(
        planRunStream(messages, () => false, { streaming: false })
            .filter((unit) => unit.role === 'answer')
            .map((unit) => unit.messageIndex),
    );
    const blocks: string[] = [];
    messages.forEach((message, index) => {
        if (!answerIndexes.has(index)) return;
        // Parts within one response are concatenated, not paragraph-joined:
        // they are a streaming artefact of one continuous piece of text, and a
        // blank line between them would split a sentence.
        const text = (message.parts as Array<Record<string, any>>)
            .filter((part) => part.part_kind === 'text' && typeof part.content === 'string')
            .map((part) => part.content as string)
            .join('')
            .trim();
        if (text) blocks.push(text);
    });
    return blocks.join('\n\n');
}
