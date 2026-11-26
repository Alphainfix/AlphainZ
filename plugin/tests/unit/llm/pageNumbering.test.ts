/**
 * `view_page_images` counts pages the way everything else the model sees does.
 *
 * `read_document`, `search_in_document`, a citation's `page` and the message
 * preamble all number pages from the first page of the file. Page images read
 * the same numbers the same way, so a page named anywhere else — a boxed
 * figure's page in the preamble, a page `read_document` returned — renders
 * that page, even in a PDF whose printed labels start over after
 * roman-numbered front matter.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { buildToolRequest, TOOL_SPECS_BY_NAME } from '../../../src/services/llm/toolSchemas';
import { pageImagesToToolResult, shapeDocumentResult } from '../../../src/services/llm/zoteroToolDispatch';
import { describePromptContext } from '@beaver/agent-llm/runRequestToMessages';
import { resolvePageValue } from '../../../src/services/agentDataProvider/pageLabelResolution';

/** A thesis: three roman-numbered pages, then the body printed 1, 2, 3, … */
const THESIS_LABELS: Record<number, string> = { 0: 'i', 1: 'ii', 2: 'iii', 3: '1', 4: '2', 5: '3', 6: '4' };

/** The 1-based page of the file the page-images handler renders for a request. */
function renderedPage(request: Record<string, unknown>, labels: Record<number, string>): number[] {
    return (request.pages as number[]).map((page) => resolvePageValue(page, labels, request.prefer_page_labels === true));
}

describe('a figure boxed in the reader', () => {
    const boxed = {
        type: 'annotation', annotation_type: 'image', library_id: 1, library_ref: 'u',
        zotero_key: 'FIG12345', parent_key: 'PDF12345', page_label: 'iii', position: { page_index: 2, rects: [] },
    };

    it('is looked at on its own page when view_page_images is asked for the page the preamble names', () => {
        const preamble = describePromptContext({ content: 'What does this show?', attachments: [boxed] } as any)!;
        const named = Number(/boxed on page (\d+) of \[u-PDF12345\]/.exec(preamble)![1]);
        const request = buildToolRequest('view_page_images', { attachment_id: 'u-PDF12345', pages: [named] }, 'req-1');
        // Page 3 of the file is printed "iii"; the page printed "3" is page 6.
        expect(renderedPage(request, THESIS_LABELS)).toEqual([3]);
    });
});

describe('a page read with read_document', () => {
    it('renders as the same page', () => {
        const document = {
            result: {
                document: {
                    pageCount: 7,
                    pages: Object.entries(THESIS_LABELS).map(([index, label]) => ({
                        index: Number(index), label, markdown: `text of page ${Number(index) + 1}`,
                    })),
                },
            },
        };
        // Page 4 of the file is printed "1"; the page printed "4" is page 7.
        const read = shapeDocumentResult(document, { attachment_id: 'u-PDF12345', pages: [4] }) as any;
        expect(read.pages[0]).toMatchObject({ page: 4, label: '1' });
        const request = buildToolRequest('view_page_images', { attachment_id: 'u-PDF12345', pages: [read.pages[0].page] }, 'req-1');
        expect(renderedPage(request, THESIS_LABELS)).toEqual([4]);
    });
});

describe('what the tool says it rendered', () => {
    it('names the page of the file, with the printed label beside it when they differ', () => {
        const result = pageImagesToToolResult({
            pages: [
                { page_number: 6, page_label: '3', image_data: 'x', format: 'jpeg' },
                { page_number: 7, page_label: '7', image_data: 'x', format: 'jpeg' },
            ],
            total_pages: 7,
        });
        expect(result.text).toContain('Rendered pages 6 (printed 3), 7.');
    });

    it('tells the model which numbering the pages argument takes', () => {
        const pages = (TOOL_SPECS_BY_NAME.get('view_page_images')!.schema.parameters as any).properties.pages;
        expect(pages.description).toMatch(/first page of the file/);
        expect(pages.description).toMatch(/not the printed page labels/);
    });
});
