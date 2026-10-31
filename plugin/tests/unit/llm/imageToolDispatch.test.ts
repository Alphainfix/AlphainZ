/**
 * The in-plugin dispatcher and pictures.
 *
 * - A text-only model is refused the image tools even when it names one — the
 *   loop runs whatever the model calls, and a scan's error used to send it
 *   straight there.
 * - An area the user boxed in the reader is shown from the pixels attached to
 *   the message: no executor can open an annotation by id.
 */
import { describe, expect, it, vi } from 'vitest';

import {
    dataProviderToolDispatcher,
    LIBRARY_TOOL_NAMES,
    shapeDocumentResult,
    ZOTERO_TOOL_NAMES,
} from '../../../src/services/llm/zoteroToolDispatch';
import { attachedImagesFromPrompt } from '../../../src/services/llm/runRequestToMessages';

const context = { toolCallId: 'call-1' };

/** A provider map whose page-image and attachment-image executors answer with one picture. */
function providerWithImages() {
    const pageImages = vi.fn(async () => ({
        pages: [{ page_number: 3, format: 'jpeg', image_data: 'PAGE' }],
        total_pages: 12,
    }));
    const attachmentImage = vi.fn(async () => ({ image: { image_data: 'FILE', format: 'png', width: 10, height: 10 } }));
    const documentRequest = vi.fn(async () => ({ result: { document: { pages: [], pageCount: 14 } } }));
    return {
        pageImages,
        attachmentImage,
        documentRequest,
        provider: {
            zotero_attachment_page_images_request: { handle: pageImages },
            zotero_attachment_image_request: { handle: attachmentImage },
            zotero_document_request: { handle: documentRequest },
        },
    };
}

describe('a model that reads text only', () => {
    it('is refused page images and attached images, and the executors never run', async () => {
        const { provider, pageImages, attachmentImage } = providerWithImages();
        const dispatch = dataProviderToolDispatcher(provider, {}, { readsImages: false });

        await expect(dispatch('view_page_images', { attachment_id: 'u-ABCD1234', pages: [3] }, context))
            .rejects.toThrow(/reads text only/);
        await expect(dispatch('view_attachment_image', { attachment_id: 'u-ABCD1234' }, context))
            .rejects.toThrow(/reads figures/);
        expect(pageImages).not.toHaveBeenCalled();
        expect(attachmentImage).not.toHaveBeenCalled();
    });

    it('is not pointed at page images when a PDF has no text layer', async () => {
        const { provider } = providerWithImages();
        const dispatch = dataProviderToolDispatcher(provider, {}, { readsImages: false });
        const failure = dispatch('read_document', { attachment_id: 'u-ABCD1234' }, context);
        await expect(failure).rejects.toThrow(/scan with no text layer/);
        await expect(failure).rejects.not.toThrow(/view_page_images/);
    });
});

describe('a model that reads images', () => {
    it('still gets page images, and the scan hint that leads there', async () => {
        const { provider, pageImages } = providerWithImages();
        const dispatch = dataProviderToolDispatcher(provider, {}, { readsImages: true });
        const result: any = await dispatch('view_page_images', { attachment_id: 'u-ABCD1234', pages: [3] }, context);
        expect(result.kind).toBe('tool-images');
        expect(pageImages).toHaveBeenCalledTimes(1);
        await expect(dispatch('read_document', { attachment_id: 'u-ABCD1234' }, context))
            .rejects.toThrow(/view_page_images can still read it/);
    });

    it('behaves the same when the dispatcher is told nothing', async () => {
        const { provider, pageImages } = providerWithImages();
        await dataProviderToolDispatcher(provider)('view_page_images', { attachment_id: 'u-ABCD1234', pages: [3] }, context);
        expect(pageImages).toHaveBeenCalledTimes(1);
        expect(() => shapeDocumentResult({ result: { document: { pages: [], pageCount: 2 } } }))
            .toThrow(/view_page_images can still read it/);
    });
});

describe('an area the user boxed in the reader', () => {
    const prompt = {
        attachments: [
            { type: 'annotation', annotation_type: 'image', library_ref: 'u', zotero_key: 'FIG12345', image_base64: 'BOXED' },
            { type: 'annotation', annotation_type: 'highlight', library_ref: 'u', zotero_key: 'H1', text: 'a' },
            { type: 'annotation', annotation_type: 'image', library_ref: 'u', zotero_key: 'NOCACHE1' },
        ],
    };

    it('collects the pixels by the id the preamble names them with', () => {
        const images = attachedImagesFromPrompt(prompt as any);
        expect([...images.keys()]).toEqual(['u-FIG12345']);
        expect(images.get('u-FIG12345')).toEqual({ mimeType: 'image/png', base64: 'BOXED' });
    });

    it('is shown from those pixels, without asking an executor that cannot open it', async () => {
        const { provider, attachmentImage } = providerWithImages();
        const dispatch = dataProviderToolDispatcher(provider, {}, {
            readsImages: true,
            attachedImages: attachedImagesFromPrompt(prompt as any),
        });
        const result: any = await dispatch('view_attachment_image', { attachment_id: ' u-FIG12345 ' }, context);
        expect(result.kind).toBe('tool-images');
        expect(result.images).toEqual([{ mimeType: 'image/png', base64: 'BOXED', label: 'attached image' }]);
        expect(attachmentImage).not.toHaveBeenCalled();

        // Anything else — an image file in the library — still goes to the executor.
        const file: any = await dispatch('view_attachment_image', { attachment_id: 'u-IMG12345' }, context);
        expect(file.images[0].base64).toBe('FILE');
        expect(attachmentImage).toHaveBeenCalledTimes(1);
    });
});

describe('the library tools a run can offer', () => {
    it('include the two with executors but no local route', () => {
        expect(LIBRARY_TOOL_NAMES).toEqual(expect.arrayContaining(['get_annotations', 'view_attachment_image']));
        expect(ZOTERO_TOOL_NAMES).not.toContain('get_annotations');
        expect(LIBRARY_TOOL_NAMES).toEqual(expect.arrayContaining(ZOTERO_TOOL_NAMES));
    });
});
