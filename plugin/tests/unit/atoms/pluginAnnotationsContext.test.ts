/**
 * The highlights staged with a paper are the user's own.
 *
 * Every message quotes the staged highlights as "the user's own highlights".
 * The ones this plugin writes do not belong there: an anchor behind a
 * selection question carries the saved question and answer in its comment,
 * so the plugin's earlier answers would come back to the model as the user's
 * notes, in every message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { annotationsForAttachment } from '../../../react/atoms/messageComposition';
import {
    ALPHAIN_ANCHOR_AUTHOR,
    BEAVER_ANNOTATION_AUTHOR,
    LEGACY_PLUGIN_ANNOTATION_AUTHORS,
} from '../../../src/constants/annotations';

const highlight = (id: number, author: string) => ({
    id,
    annotationType: 'highlight',
    annotationAuthorName: author,
    deleted: false,
    isAttachment: () => false,
});

function paperWith(annotations: any[]) {
    return { isAttachment: () => true, getAnnotations: () => annotations } as any;
}

beforeEach(() => {
    (Zotero as any).Items = { getAsync: async () => [] };
});

describe('the highlights staged with a paper', () => {
    it('leave out the anchors behind selection questions', async () => {
        const mine = highlight(1, 'A. Reader');
        const anchor = highlight(2, ALPHAIN_ANCHOR_AUTHOR);

        const { staged, total } = await annotationsForAttachment(paperWith([mine, anchor]), 10);

        expect(staged).toEqual([mine]);
        // The count the model is told is the user's too.
        expect(total).toBe(1);
    });

    it('leave out the highlights the agent added', async () => {
        const mine = highlight(1, 'A. Reader');
        const agents = highlight(2, BEAVER_ANNOTATION_AUTHOR);

        const { staged } = await annotationsForAttachment(paperWith([mine, agents]), 10);

        expect(staged).toEqual([mine]);
    });

    it('leave out anchors written under the plugin\'s earlier name', async () => {
        const mine = highlight(1, 'A. Reader');
        const oldAnchor = highlight(2, LEGACY_PLUGIN_ANNOTATION_AUTHORS[0]);

        const { staged } = await annotationsForAttachment(paperWith([mine, oldAnchor]), 10);

        expect(staged).toEqual([mine]);
    });

    it('keep the user\'s own, with or without an author name', async () => {
        const unnamed = highlight(1, '');
        const coauthor = highlight(2, 'A. Coauthor');

        const { staged, total } = await annotationsForAttachment(paperWith([unnamed, coauthor]), 10);

        expect(staged).toEqual([unnamed, coauthor]);
        expect(total).toBe(2);
    });
});
