/**
 * What a run's tool dispatcher knows about images.
 *
 * Two facts come from the run itself rather than from the library: whether
 * the chosen model reads images at all, and the pixels of anything the user
 * attached to the message. A text-only model is refused the image tools even
 * when it names one, and an area the user boxed in the reader — which no
 * executor can open by id — is served from the pixels that came with the
 * message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { options?: any } = {};
const setup = vi.hoisted(() => ({ readsImages: true }));

vi.mock('../../../src/services/llm/localRunner', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/services/llm/localRunner')>()),
    runLocalAgent: vi.fn(async (options: any) => {
        captured.options = options;
    }),
}));

vi.mock('../../../src/services/llm/agentConfig', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/services/llm/agentConfig')>()),
    refreshSemanticSearchAvailability: vi.fn(async () => {}),
    buildAgentFromPrefs: vi.fn(() => ({
        ok: true,
        provider: {},
        tools: [],
        warnings: [],
        outputTokenLimit: 1000,
        readsImages: setup.readsImages,
    })),
    buildAgentSystemPrompt: vi.fn(() => 'You are a test.'),
    isSemanticSearchAvailable: vi.fn(() => false),
}));

import { executeLocalRequest } from '../../../react/atoms/executeLocalRun';
import { store } from '../../../react/store';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';

const get = ((atom: any) => store.get(atom)) as any;
const set = ((atom: any, ...args: any[]) => (store.set as any)(atom, ...args)) as any;

/** A region the user boxed on page 3 of a PDF, as the reader attaches it. */
const BOXED_REGION = {
    type: 'annotation',
    annotation_type: 'image',
    library_ref: 'u',
    zotero_key: 'ANNOT001',
    parent_key: 'PDF00001',
    position: { page_index: 2 },
    image_base64: 'iVBORw0KGgoAAAANSUhEUg==',
};

async function dispatcherFor(attachments: any[] = []) {
    captured.options = undefined;
    const run = {
        id: 'run-a',
        thread_id: 'thread-1',
        status: 'in_progress',
        user_prompt: { content: 'What does this figure show?', attachments },
        model_messages: [],
        created_at: '2026-09-25T12:00:00.000Z',
    } as any;
    store.set(activeRunAtom, run);
    await executeLocalRequest(run, { user_prompt: run.user_prompt, thread_id: 'thread-1' } as any, get, set);
    expect(captured.options).toBeDefined();
    return captured.options.dispatch as (name: string, args: any, context: any) => Promise<any>;
}

beforeEach(() => {
    setup.readsImages = true;
    store.set(activeRunAtom, null);
});

describe('the dispatcher of a run', () => {
    it('shows the model the exact region the user boxed, from the pixels sent with the message', async () => {
        const dispatch = await dispatcherFor([BOXED_REGION]);

        const result = await dispatch(
            'view_attachment_image',
            { attachment_id: 'u-ANNOT001' },
            { toolCallId: 'call-1' },
        );

        expect(result).toMatchObject({
            kind: 'tool-images',
            images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUg==' }],
        });
    });

    it('refuses the page images to a model that reads text only', async () => {
        setup.readsImages = false;
        const dispatch = await dispatcherFor();

        await expect(
            dispatch('view_page_images', { attachment_id: 'u-PDF00001', pages: [3] }, { toolCallId: 'call-1' }),
        ).rejects.toThrow(/reads text only/);
    });

    it('refuses an attached image to a model that reads text only, too', async () => {
        setup.readsImages = false;
        const dispatch = await dispatcherFor([BOXED_REGION]);

        await expect(
            dispatch('view_attachment_image', { attachment_id: 'u-ANNOT001' }, { toolCallId: 'call-1' }),
        ).rejects.toThrow(/reads text only/);
    });
});
