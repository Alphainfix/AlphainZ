/**
 * The anchor highlight behind a selection question, over its life.
 *
 * Asking about the same passage twice must not stack a second magenta
 * highlight on the first. A question can tell, once it is over, whether its
 * anchor got a conversation — and let go of its own anchor without taking a
 * newer question's with it. A highlight placed for a question that never ran
 * can be taken back, but never one that holds something or opens something.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    clearPendingAnchor,
    discardAnchor,
    drainPendingAnchor,
    findAnchorAt,
    isAnchorParked,
    placeAnchor,
    stashPendingAnchor,
} from '../../../react/utils/selectionAnchors';
import { ALPHAIN_ANCHOR_AUTHOR } from '../../../src/constants/annotations';

const position = { pageIndex: 2, rects: [[100.12, 200.5, 300.25, 212.75]] };
const readerAnnotation = {
    type: 'highlight',
    text: 'waggle run duration',
    pageLabel: '3',
    sortIndex: '00002|000000|00100',
    position,
};

let annotations: any[];
let created: any[];
let saveThreadAnchor: any;
let getThreadAnchor: any;
let byKey: Map<string, any>;

function anchorItem(key: string, overrides: Record<string, unknown> = {}) {
    const item = {
        key,
        libraryID: 1,
        isAnnotation: () => true,
        deleted: false,
        annotationType: 'highlight',
        annotationAuthorName: ALPHAIN_ANCHOR_AUTHOR,
        annotationPosition: JSON.stringify(position),
        annotationComment: '',
        eraseTx: vi.fn(async () => undefined),
        ...overrides,
    };
    byKey.set(`${item.libraryID}-${key}`, item);
    return item;
}

const attachment = {
    id: 204,
    key: 'ATTACH01',
    libraryID: 1,
    getAnnotations: () => annotations,
} as any;

beforeEach(() => {
    clearPendingAnchor();
    annotations = [];
    created = [];
    byKey = new Map();
    saveThreadAnchor = vi.fn(async () => undefined);
    getThreadAnchor = vi.fn(async () => null);
    (Zotero as any).Item = function (this: any, itemType: string) {
        this.itemType = itemType;
        this.key = `NEW${created.length}`;
        this.saveTx = vi.fn(async () => undefined);
        created.push(this);
    };
    (Zotero as any).Items = {
        getByLibraryAndKey: vi.fn((libraryID: number, key: string) => byKey.get(`${libraryID}-${key}`) ?? false),
    };
    (Zotero as any).AlphainZ = { db: { saveThreadAnchor, getThreadAnchor } };
});

describe('placing an anchor', () => {
    it('reuses the anchor already on the passage instead of stacking a second one', async () => {
        const existing = anchorItem('ANCHOR01');
        annotations = [existing];

        const placed = await placeAnchor(attachment, readerAnnotation);

        expect(placed).toEqual({ anchor: existing, created: false });
        expect(created).toHaveLength(0);
    });

    it('matches positions the reader gives back with float noise', () => {
        annotations = [anchorItem('ANCHOR01')];
        const noisy = { pageIndex: 2, rects: [[100.1200001, 200.4999999, 300.25, 212.75]] };
        expect(findAnchorAt(attachment, noisy)?.key).toBe('ANCHOR01');
    });

    it('does not reuse the user\'s own highlight, a deleted anchor, or one elsewhere', async () => {
        annotations = [
            anchorItem('USERS001', { annotationAuthorName: 'Jane' }),
            anchorItem('DELETED1', { deleted: true }),
            anchorItem('ELSEWHER', { annotationPosition: JSON.stringify({ pageIndex: 7, rects: [[1, 2, 3, 4]] }) }),
        ];
        const placed = await placeAnchor(attachment, readerAnnotation);
        expect(placed?.created).toBe(true);
        expect(created).toHaveLength(1);
    });

    it('creates one when the passage has none', async () => {
        const placed = await placeAnchor(attachment, readerAnnotation);
        expect(placed?.created).toBe(true);
        expect(placed?.anchor).toBe(created[0]);
    });
});

describe('a parked anchor', () => {
    it('reports being linked once its thread claims it', async () => {
        const anchor = anchorItem('ANCHOR01');
        const parked = stashPendingAnchor({ annotation: anchor as any, attachment, selectedText: 'x' });
        expect(parked.state).toBe('waiting');
        await drainPendingAnchor('thread-1');
        expect(parked.state).toBe('linked');
        expect(saveThreadAnchor).toHaveBeenCalledWith(expect.objectContaining({ annotationKey: 'ANCHOR01', threadId: 'thread-1' }));
    });

    it('reports being released when it is let go, or overtaken by a newer one', () => {
        const first = stashPendingAnchor({ annotation: anchorItem('ANCHOR01') as any, attachment, selectedText: 'x' });
        const second = stashPendingAnchor({ annotation: anchorItem('ANCHOR02') as any, attachment, selectedText: 'y' });
        expect(first.state).toBe('released');
        clearPendingAnchor();
        expect(second.state).toBe('released');
    });

    it('keeps opening the conversation it was first asked in', async () => {
        // Linked on another computer, or earlier in another chat; the rule the
        // index follows for stored runs is that the first link stays.
        const anchor = anchorItem('ANCHOR01');
        getThreadAnchor.mockResolvedValue({ threadId: 'thread-first', selectedText: 'x' });
        const parked = stashPendingAnchor({ annotation: anchor as any, attachment, selectedText: 'x' });

        await drainPendingAnchor('thread-later');

        expect(parked.state).toBe('linked');
        expect(saveThreadAnchor).not.toHaveBeenCalled();
    });

    it('can be let go by its own question without taking a newer question\'s anchor', async () => {
        const older = anchorItem('ANCHOR01');
        const newer = anchorItem('ANCHOR02');
        stashPendingAnchor({ annotation: older as any, attachment, selectedText: 'x' });
        const parked = stashPendingAnchor({ annotation: newer as any, attachment, selectedText: 'y' });

        clearPendingAnchor(older);
        expect(isAnchorParked(newer)).toBe(true);
        expect(parked.state).toBe('waiting');

        await drainPendingAnchor('thread-9');
        expect(saveThreadAnchor.mock.calls[0][0].annotationKey).toBe('ANCHOR02');
    });
});

describe('taking an anchor back', () => {
    it('erases an anchor nothing holds or opens', async () => {
        const anchor = anchorItem('ANCHOR01');
        expect(await discardAnchor(anchor as any)).toBe(true);
        expect(anchor.eraseTx).toHaveBeenCalled();
    });

    it('keeps an anchor with something written in its comment', async () => {
        const anchor = anchorItem('ANCHOR01', { annotationComment: '— AlphainZ\nQ: q\nA: a' });
        expect(await discardAnchor(anchor as any)).toBe(false);
        expect(anchor.eraseTx).not.toHaveBeenCalled();
    });

    it('keeps an anchor a conversation claims', async () => {
        const anchor = anchorItem('ANCHOR01');
        getThreadAnchor.mockResolvedValueOnce({ threadId: 'thread-1', selectedText: 'x' });
        expect(await discardAnchor(anchor as any)).toBe(false);
        expect(anchor.eraseTx).not.toHaveBeenCalled();
    });

    it('keeps an anchor still waiting for its thread', async () => {
        const anchor = anchorItem('ANCHOR01');
        stashPendingAnchor({ annotation: anchor as any, attachment, selectedText: 'x' });
        expect(await discardAnchor(anchor as any)).toBe(false);
    });

    it('never erases the user\'s own highlight', async () => {
        const users = anchorItem('USERS001', { annotationAuthorName: 'Jane' });
        expect(await discardAnchor(users as any)).toBe(false);
        expect(users.eraseTx).not.toHaveBeenCalled();
    });
});
