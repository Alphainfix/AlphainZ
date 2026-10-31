/**
 * The link between a highlight and the conversation started from it.
 *
 * Two things here are easy to get wrong and expensive when wrong: the anchor
 * must carry its own author, or the observer that treats a new annotation as
 * context attaches the anchor to the very conversation that created it; and the
 * link must be written when the thread id arrives rather than when the highlight
 * is made, because a new thread has no id until its first run starts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    clearPendingAnchor,
    createAnchorAnnotation,
    drainPendingAnchor,
    stashPendingAnchor,
    threadForAnchor,
} from '../../../react/utils/selectionAnchors';
import { ALPHAIN_ANCHOR_AUTHOR, ALPHAIN_ANCHOR_COLOR } from '../../../src/constants/annotations';

let saveTx: any;
let created: any;
let saveThreadAnchor: any;
let getThreadAnchor: any;
let getThreadAnchorsForAttachment: any;

const attachment = { libraryID: 1, id: 204, key: 'ATTACH01' } as any;
const annotationItem = { libraryID: 1, key: 'ANNOT001' } as any;

/** The reader's prospective annotation for the current selection. */
const readerAnnotation = {
    type: 'highlight',
    text: 'waggle run duration',
    color: '#ffd400',
    pageLabel: '3',
    sortIndex: '00003|000000|00100',
    position: { pageIndex: 2, rects: [[1, 2, 3, 4]] },
};

beforeEach(() => {
    clearPendingAnchor();
    saveTx = vi.fn(async () => undefined);
    created = null;
    saveThreadAnchor = vi.fn(async () => undefined);
    getThreadAnchor = vi.fn(async () => null);
    getThreadAnchorsForAttachment = vi.fn(async () => []);

    // The real constructor is a Zotero data object; a bag of assignable fields
    // is enough to assert what the anchor is built with.
    (Zotero as any).Item = function (this: any, itemType: string) {
        this.itemType = itemType;
        this.saveTx = saveTx;
        this.key = 'ANNOT001';
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- hands the constructed item back to the test
        created = this;
    };
    (Zotero as any).AlphainZ = {
        db: { saveThreadAnchor, getThreadAnchor, getThreadAnchorsForAttachment },
    };
});

describe('createAnchorAnnotation', () => {
    it('saves a highlight carrying the anchor author and colour', async () => {
        await createAnchorAnnotation(attachment, readerAnnotation);

        expect(created.itemType).toBe('annotation');
        expect(created.annotationType).toBe('highlight');
        expect(created.parentID).toBe(attachment.id);
        // The author is what keeps the anchor out of the new-annotation observer.
        expect(created.annotationAuthorName).toBe(ALPHAIN_ANCHOR_AUTHOR);
        // Its own colour, not the colour the reader proposed.
        expect(created.annotationColor).toBe(ALPHAIN_ANCHOR_COLOR);
        expect(created.annotationColor).not.toBe(readerAnnotation.color);
        expect(saveTx).toHaveBeenCalled();
    });

    it('carries the position the reader computed', async () => {
        // Re-deriving the position by searching for the text would land on the
        // wrong occurrence whenever the phrase repeats.
        await createAnchorAnnotation(attachment, readerAnnotation);
        expect(JSON.parse(created.annotationPosition)).toEqual(readerAnnotation.position);
        expect(created.annotationSortIndex).toBe(readerAnnotation.sortIndex);
        expect(created.annotationPageLabel).toBe('3');
        expect(created.annotationText).toBe(readerAnnotation.text);
    });

    it('accepts a position that is already serialized', async () => {
        // The reader hands over an object, but a snapshot round-tripped through
        // JSON arrives as a string; double-encoding it would break placement.
        const serialized = JSON.stringify(readerAnnotation.position);
        await createAnchorAnnotation(attachment, { ...readerAnnotation, position: serialized });
        expect(created.annotationPosition).toBe(serialized);
    });

    it('declines to anchor a selection with no position', async () => {
        // The conversation can still happen; it just has nowhere to be reopened
        // from, which is better than saving a highlight Zotero cannot place.
        const result = await createAnchorAnnotation(attachment, { text: 'x' });
        expect(result).toBeNull();
        expect(saveTx).not.toHaveBeenCalled();
    });

    it('returns null when Zotero refuses to save', async () => {
        saveTx.mockRejectedValueOnce(new Error('nope'));
        expect(await createAnchorAnnotation(attachment, readerAnnotation)).toBeNull();
    });
});

describe('the pending anchor slot', () => {
    it('writes the link only once the thread id exists', async () => {
        stashPendingAnchor({ annotation: annotationItem, attachment, selectedText: 'text' });
        expect(saveThreadAnchor).not.toHaveBeenCalled();

        await drainPendingAnchor('thread-9');
        expect(saveThreadAnchor).toHaveBeenCalledWith({
            libraryId: 1,
            annotationKey: 'ANNOT001',
            threadId: 'thread-9',
            attachmentKey: 'ATTACH01',
            selectedText: 'text',
        });
    });

    it('drains once, so a later thread cannot claim the same anchor', async () => {
        // Without this a thread started from the composer would inherit the
        // highlight of whatever selection chat came before it.
        stashPendingAnchor({ annotation: annotationItem, attachment, selectedText: 'text' });
        await drainPendingAnchor('thread-1');
        await drainPendingAnchor('thread-2');
        expect(saveThreadAnchor).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no anchor is waiting', async () => {
        await drainPendingAnchor('thread-1');
        expect(saveThreadAnchor).not.toHaveBeenCalled();
    });

    it('keeps only the newest parked anchor', async () => {
        stashPendingAnchor({ annotation: annotationItem, attachment, selectedText: 'first' });
        stashPendingAnchor({
            annotation: { libraryID: 1, key: 'ANNOT002' } as any,
            attachment,
            selectedText: 'second',
        });
        await drainPendingAnchor('thread-1');
        expect(saveThreadAnchor.mock.calls[0][0].annotationKey).toBe('ANNOT002');
    });
});

describe('threadForAnchor', () => {
    it('returns the thread behind a highlight', async () => {
        getThreadAnchor.mockResolvedValueOnce({ threadId: 't7', selectedText: 'x' });
        expect(await threadForAnchor(1, 'ANNOT001')).toBe('t7');
    });

    it('returns null for a highlight with no conversation', async () => {
        expect(await threadForAnchor(1, 'ANNOT001')).toBeNull();
    });

    it('returns null rather than throwing on a database error', async () => {
        getThreadAnchor.mockRejectedValueOnce(new Error('locked'));
        expect(await threadForAnchor(1, 'ANNOT001')).toBeNull();
    });
});
