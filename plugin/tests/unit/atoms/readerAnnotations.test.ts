/**
 * A paper's own highlights, staged when it opens.
 *
 * Opening a paper staged the PDF and nothing else, so the annotations the user
 * had made on it — often the reason they opened it — were invisible to the
 * agent until they attached one by hand. What they saw instead was the single
 * annotation an Explain/Ask from the reader popup attaches, which reads as
 * "only one highlight got imported".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { annotationsForAttachment } from '../../../react/atoms/messageComposition';
import { describePromptContext } from '@beaver/agent-llm/runRequestToMessages';

const annotation = (id: number, type: string, deleted = false) =>
    ({ id, annotationType: type, deleted, isAttachment: () => false });

beforeEach(() => {
    (Zotero as any).Items = {
        getAsync: async (ids: number[]) => ids.map((id) => ITEMS.get(id)),
    };
});

const ITEMS = new Map<number, any>();
// Zotero returns loaded items on the reader path and ids elsewhere; both shapes
// have to survive the round trip, so every case below runs twice.
function attachmentWith(shape: 'items' | 'ids', items: any[]) {
    ITEMS.clear();
    items.forEach((item) => ITEMS.set(item.id, item));
    const returns = shape === 'ids' ? items.map((i) => i.id) : items;
    return { isAttachment: () => true, getAnnotations: () => returns } as any;
}

describe.each(['items', 'ids'] as const)('collecting a paper\'s highlights (%s)', (shape) => {
    it('takes every readable one, and reports the total', async () => {
        const attachment = attachmentWith(shape, [
            annotation(1, 'highlight'), annotation(2, 'underline'), annotation(3, 'note'),
        ]);
        const { staged, total } = await annotationsForAttachment(attachment, 10);
        expect(staged).toHaveLength(3);
        expect(total).toBe(3);
    });

    it('leaves out the ones carrying no text', async () => {
        // An ink scribble or an image region spends a chip and says nothing.
        const attachment = attachmentWith(shape, [
            annotation(1, 'highlight'), annotation(2, 'ink'), annotation(3, 'image'),
        ]);
        const { staged, total } = await annotationsForAttachment(attachment, 10);
        expect(staged).toHaveLength(1);
        expect(total).toBe(1);
    });

    it('leaves out trashed ones', async () => {
        const attachment = attachmentWith(shape, [
            annotation(1, 'highlight'), annotation(2, 'highlight', true),
        ]);
        expect((await annotationsForAttachment(attachment, 10)).total).toBe(1);
    });

    it('stages up to the limit but still reports the whole set', async () => {
        // The bound keeps a heavily annotated paper from filling the composer;
        // the total is what stops the model calling ten "all of them".
        const many = Array.from({ length: 40 }, (_, i) => annotation(i + 1, 'highlight'));
        const { staged, total } = await annotationsForAttachment(attachmentWith(shape, many), 10);
        expect(staged).toHaveLength(10);
        expect(total).toBe(40);
    });

    it('says nothing for a paper with none, or for a regular item', async () => {
        expect(await annotationsForAttachment(attachmentWith(shape, []), 10)).toEqual({ staged: [], total: 0 });
        expect(await annotationsForAttachment({ isAttachment: () => false } as any, 10))
            .toEqual({ staged: [], total: 0 });
    });
});

describe('what the model is told', () => {
    it('names the whole count, not the number of chips', async () => {
        const context = describePromptContext({
            content: '总结一下我标出来的部分',
            application_state: {
                reader_state: {
                    library_ref: 'u', zotero_key: 'ABC', current_page: 3, annotation_count: 40,
                },
            },
        } as any);
        expect(context).toContain('40');
        expect(context).toContain('get_annotations');
    });

    it('says nothing about highlights when the paper has none', async () => {
        const context = describePromptContext({
            content: 'x',
            application_state: { reader_state: { library_ref: 'u', zotero_key: 'ABC' } },
        } as any);
        expect(context).not.toContain('get_annotations');
    });
});

describe('leaving the reader', () => {
    it('drops the highlights together with the paper', async () => {
        /*
         * The bug this pins: `clearReaderAttachmentAtom` (the tab-switch exit)
         * cleared the attachment and left the annotations atom alone, so
         * moving to a library or note tab removed the PDF chip and stranded
         * "35 Highlights". Every fix to `updateReaderAttachmentAtom` missed
         * it, because this is the other way out of a reader.
         */
        const {
            readerAnnotationsAtom,
            readerAnnotationCountAtom,
            clearReaderAttachmentAtom,
        } = await import('../../../react/atoms/messageComposition');
        const { createStore } = await import('jotai');
        const store = createStore();
        store.set(readerAnnotationsAtom, [{ key: 'A1' } as any]);
        store.set(readerAnnotationCountAtom, 35);

        store.set(clearReaderAttachmentAtom);

        expect(store.get(readerAnnotationsAtom)).toEqual([]);
        expect(store.get(readerAnnotationCountAtom)).toBe(0);
    });
});
