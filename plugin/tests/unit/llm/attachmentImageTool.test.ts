/**
 * Looking at a figure the user boxed in the reader.
 *
 * The handler that renders one image item has been in this tree since the fork
 * and nothing called it: Beaver's backend fetched these itself when the user
 * attached one. Locally, an attached figure arrived as a line of text with an
 * id — indistinguishable from an attached PDF — so "what does this show?" got
 * an answer about the paper in general.
 */
import { describe, expect, it } from 'vitest';

import { attachmentImageToToolResult, IMAGE_TOOLS } from '../../../src/services/llm/zoteroToolDispatch';
import { describePromptContext } from '@beaver/agent-llm/runRequestToMessages';
import { TOOL_SPECS } from '../../../src/services/llm/toolSchemas';

describe('view_attachment_image', () => {
    it('is registered as an image tool, so its result carries pixels', () => {
        // Without this the shared shaper would stringify the base64 payload
        // into the text result, which is both useless and enormous.
        expect(IMAGE_TOOLS.has('view_attachment_image')).toBe(true);
    });

    it('is in the tool registry with a resolvable event', () => {
        const spec = TOOL_SPECS.find((t) => t.name === 'view_attachment_image');
        expect(spec?.event).toBe('zotero_attachment_image_request');
    });

    it('turns one rendered image into the shared image envelope', () => {
        const result = attachmentImageToToolResult({
            image: { image_data: 'AAAA', format: 'png', width: 640, height: 480 },
        }) as any;
        expect(result.kind).toBe('tool-images');
        expect(result.images).toHaveLength(1);
        expect(result.images[0].mimeType).toBe('image/png');
        expect(result.images[0].base64).toBe('AAAA');
        expect(result.text).toContain('640×480');
    });

    it('says so rather than returning an empty picture', () => {
        const result = attachmentImageToToolResult({}) as any;
        expect(result.images).toEqual([]);
        expect(result.text).toMatch(/could not be rendered/i);
    });
});

describe('an attached image announces itself', () => {
    it('names the image and the tool that opens it', () => {
        const context = describePromptContext({
            content: 'What does this show?',
            attachments: [
                { attachment_id: 'u-FIG12345', title: 'Figure 3', annotation_type: 'image' },
            ],
        } as any);
        expect(context).toContain('u-FIG12345');
        expect(context).toContain('an image');
        expect(context).toContain('view_attachment_image');
    });

    it('says nothing extra when nothing attached is a picture', () => {
        const context = describePromptContext({
            content: 'Summarize this',
            attachments: [{ attachment_id: 'u-PDF12345', title: 'A paper' }],
        } as any);
        expect(context).not.toContain('view_attachment_image');
    });
});
