/**
 * Dev-only HTTP handlers for headless annotation creation primitives.
 */

import {
    createHighlightAnnotation,
    createNoteAnnotation,
    MissingPageGeometryError,
    type CreateHighlightInput,
    type CreateNoteInput,
} from "../../../src/services/annotations/createAnnotation";
import { UNRESOLVED_LIBRARY_ID } from "../../../src/utils/libraryIdentity";

type AnnotationCreateKind = "highlight" | "note";

interface AnnotationCreateRequest {
    library_id: number;
    zotero_key: string;
    type: AnnotationCreateKind;
    input: CreateHighlightInput | CreateNoteInput;
    force_file_path?: string;
    open_reader?: boolean;
    check_reader?: boolean;
}

function getPageIndex(
    type: AnnotationCreateKind,
    input: CreateHighlightInput | CreateNoteInput,
): number {
    return type === "highlight"
        ? (input as CreateHighlightInput).pageIndex
        : (input as CreateNoteInput).notePosition.page_index;
}

async function loadAnnotation(ref: {
    library_id: number;
    zotero_key: string;
}): Promise<Zotero.Item | null> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        ref.library_id,
        ref.zotero_key,
    );
    if (!item) return null;
    await item.loadDataType("annotation");
    return item;
}

async function findCachedGeometry(attachment: Zotero.Item, pageIndex: number) {
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) return null;
    const record = await Zotero.AlphainZ?.documentCache?.getMetadata(
        { libraryId: attachment.libraryID, zoteroKey: attachment.key },
        filePath,
    );
    return record?.pages?.[pageIndex] ?? null;
}

/**
 * Poll the open reader until the newly created annotation reaches its
 * annotation manager (the Zotero notifier drives that refresh).
 *
 * The budget is deliberately far above how long the refresh takes on an idle
 * instance (well under a second): it runs on Zotero's main thread, so on an
 * instance that a long live-test run has loaded up, the notifier round-trip can
 * take many seconds. A tight budget here reads as "the annotation never reached
 * the reader" when the refresh was merely slow.
 */
async function waitForReaderAnnotation(
    reader: any,
    zoteroKey: string,
    timeoutMs = 15000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const annotations = reader?._internalReader?._annotationManager?._annotations ?? [];
        if (annotations.some((annotation: any) => annotation?.id === zoteroKey)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

function serializeAnnotation(item: Zotero.Item) {
    return {
        item_id: item.id,
        library_id: item.libraryID,
        zotero_key: item.key,
        parent_id: item.parentID,
        annotationType: item.annotationType,
        annotationText: item.annotationText,
        annotationComment: item.annotationComment,
        annotationColor: item.annotationColor,
        annotationPageLabel: item.annotationPageLabel,
        annotationSortIndex: item.annotationSortIndex,
        annotationAuthorName: item.annotationAuthorName,
        annotationPosition: JSON.parse(item.annotationPosition),
    };
}

export async function handleTestAnnotationCreateHttpRequest(
    request: AnnotationCreateRequest,
) {
    const { library_id, zotero_key, type, input } = request || {};
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { ok: false, error: "Provide library_id + zotero_key" };
    }
    if (type !== "highlight" && type !== "note") {
        return { ok: false, error: "type must be highlight or note" };
    }

    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
        library_id,
        zotero_key,
    );
    if (!attachment) return { ok: false, error: "not_found" };
    if (!attachment.isAttachment()) {
        return { ok: false, error: "not_an_attachment" };
    }

    const pageIndex = getPageIndex(type, input);
    let reader: any = null;
    if (request.open_reader) {
        reader = await Zotero.Reader.open(attachment.id, { pageIndex });
        // Zotero.Reader.open() returns undefined when it selects an existing tab.
        reader = reader ??
            Zotero.Reader._readers?.find((candidate: any) => {
                return candidate?.itemID === attachment.id;
            }) ??
            null;
        await reader?._internalReader?._primaryView?.initializedPromise;
    }

    const originalGetFilePathAsync = attachment.getFilePathAsync.bind(attachment);
    if (request.force_file_path) {
        // Dev-only negative-path hook; do not run this handler concurrently for the same cached Zotero item.
        attachment.getFilePathAsync = async () => request.force_file_path ?? false;
    }

    try {
        const ref = type === "highlight"
            ? await createHighlightAnnotation(
                attachment,
                input as CreateHighlightInput,
            )
            : await createNoteAnnotation(attachment, input as CreateNoteInput);
        const annotation = await loadAnnotation(ref);
        if (!annotation) {
            return { ok: false, error: "created_annotation_not_found" };
        }
        const reader_visible = request.check_reader && reader
            ? await waitForReaderAnnotation(reader, ref.zotero_key)
            : null;

        return {
            ok: true,
            reference: ref,
            annotation: serializeAnnotation(annotation),
            geometry: await findCachedGeometry(attachment, pageIndex),
            reader_visible,
        };
    } catch (error) {
        if (error instanceof MissingPageGeometryError) {
        return {
            ok: false,
            code: error.code,
            reason: error.reason,
            message: error.message,
        };
        }
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        if (request.force_file_path) {
            attachment.getFilePathAsync = originalGetFilePathAsync;
        }
    }
}

/**
 * Dev-only: move annotations to the trash, and drop any anchor row pointing at
 * them.
 *
 * Exists because the create endpoint above did not have a counterpart. Every
 * verification run that created a highlight left it behind in a real library,
 * and a run that got the geometry wrong left a visibly misplaced one. A harness
 * that can write needs a way to undo what it wrote.
 *
 * Trash rather than erase: Zotero's trash is recoverable, and a test has no
 * business making an unrecoverable deletion in someone's library.
 *
 * Body: { library_id, annotation_keys: string[] }
 */
export async function handleTestAnnotationTrashHttpRequest(request: any) {
    const libraryId = Number(request?.library_id);
    const keys: string[] = Array.isArray(request?.annotation_keys)
        ? request.annotation_keys.map(String)
        : request?.annotation_key
          ? [String(request.annotation_key)]
          : [];
    if (!Number.isFinite(libraryId) || keys.length === 0) {
        return { ok: false, error: 'Provide library_id and annotation_keys' };
    }

    const db = (Zotero as any).AlphainZ?.db;
    const trashed: string[] = [];
    const missing: string[] = [];

    for (const key of keys) {
        const item = Zotero.Items.getByLibraryAndKey(libraryId, key) as Zotero.Item | false;
        if (!item) {
            missing.push(key);
            continue;
        }
        item.deleted = true;
        await item.saveTx();
        await db?.deleteThreadAnchor?.(libraryId, key).catch(() => {});
        trashed.push(key);
    }

    return { ok: missing.length === 0, trashed, missing };
}
