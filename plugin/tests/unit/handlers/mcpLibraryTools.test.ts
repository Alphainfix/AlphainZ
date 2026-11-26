/**
 * The assistant's library tools as the MCP server serves them: descriptions
 * that name the tools MCP clients have, Zotero links in place of the
 * assistant's citation markers, MCP content (images included), failures a
 * client can read, and the index searches gated on the settings.
 *
 * The dispatcher is the real one; only the executors behind it are stand-ins,
 * so these tests cover the same argument handling and result shaping the
 * sidebar uses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ value: {} as Record<string, { handle: (event: any) => Promise<any> }> }));
const semanticSearch = vi.hoisted(() => ({
    reachable: true,
    fulltextPref: undefined as unknown,
    state: { status: 'ready', provider: 'google' } as any,
}));

vi.mock('../../../src/services/zoteroDataProvider', () => ({
    createZoteroDataProvider: () => provider.value,
}));

vi.mock('../../../react/atoms/librarySearchTools', () => ({
    fulltextTool: () => ({
        search_library_fulltext: async (args: any) => ({
            coverage: 'Searched 2 of 3 PDFs.',
            matches: [{
                attachment_id: 'u-AAAA1111',
                title: 'A paper about ' + String(args.query),
                page: 5,
                similarity: 0.71,
                cite: '<citation id="u-AAAA1111" page="5" loc="s3-s4"/>',
                passage: 'The passage that matched.',
            }],
        }),
    }),
    figuresTool: () => ({
        search_library_figures: async () => ({ pages: [] }),
    }),
}));

vi.mock('../../../src/services/llm/agentConfig', () => ({
    refreshSemanticSearchAvailability: vi.fn(async () => semanticSearch.reachable),
    semanticSearchState: vi.fn(() => semanticSearch.state),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => (key === 'fulltextSearchEnabled' ? semanticSearch.fulltextPref : undefined)),
}));

import {
    MCP_LIBRARY_TOOL_NAMES,
    callLibraryTool,
    indexSearchUnavailable,
    mcpLibraryTools,
    toMcpError,
    toMcpResult,
    withMcpToolNames,
    withZoteroLinks,
    zoteroOpenUri,
    zoteroSelectUri,
} from '../../../react/hooks/mcpLibraryTools';
import { FULLTEXT_TOOL_SCHEMA } from '../../../src/services/llm/writeTools';
import { TOOL_SPECS_BY_NAME } from '../../../src/services/llm/toolSchemas';

const ASSISTANT_ONLY_NAMES = /\b(?:item_search_by_topic|item_search_by_metadata|get_metadata|read_document)\b/;

beforeEach(() => {
    provider.value = {};
    semanticSearch.reachable = true;
    semanticSearch.fulltextPref = undefined;
    semanticSearch.state = { status: 'ready', provider: 'google' };
});

describe('tool names in descriptions', () => {
    it("rewrites the assistant's tool names to the MCP tools that do the same job", () => {
        expect(withMcpToolNames('Use item_search_by_topic, then read_document the pages.'))
            .toBe('Use search_by_topic, then read_attachment the pages.');
        expect(withMcpToolNames('`item_search_by_metadata` or get_metadata'))
            .toBe('`search_by_metadata` or get_item_details');
    });

    it('leaves other names, and longer words that contain one, alone', () => {
        const text = 'search_in_document, read_documents, my_get_metadata, view_page_images';
        expect(withMcpToolNames(text)).toBe(text);
    });
});

describe('Zotero links', () => {
    it('selects an item in the personal library or a group', () => {
        expect(zoteroSelectUri('u-ABCD1234')).toBe('zotero://select/library/items/ABCD1234');
        expect(zoteroSelectUri('g42-ABCD1234')).toBe('zotero://select/groups/42/items/ABCD1234');
    });

    it('opens an attachment at a page, and at an annotation in the same library', () => {
        expect(zoteroOpenUri('u-ABCD1234')).toBe('zotero://open-pdf/library/items/ABCD1234');
        expect(zoteroOpenUri('u-ABCD1234', 5)).toBe('zotero://open-pdf/library/items/ABCD1234?page=5');
        expect(zoteroOpenUri('g7-ABCD1234', 2, 'g7-NOTE5678'))
            .toBe('zotero://open-pdf/groups/7/items/ABCD1234?page=2&annotation=NOTE5678');
    });

    it('drops a page that is not a page number and an annotation from another library', () => {
        expect(zoteroOpenUri('u-ABCD1234', 0)).toBe('zotero://open-pdf/library/items/ABCD1234');
        expect(zoteroOpenUri('u-ABCD1234', 1.5)).toBe('zotero://open-pdf/library/items/ABCD1234');
        expect(zoteroOpenUri('u-ABCD1234', 3, 'g7-NOTE5678')).toBe('zotero://open-pdf/library/items/ABCD1234?page=3');
    });

    it('gives no link for an id it cannot place', () => {
        expect(zoteroSelectUri('1-ABCD1234')).toBeNull();
        expect(zoteroOpenUri('not an id')).toBeNull();
        expect(zoteroSelectUri(undefined)).toBeNull();
    });

    it("replaces the assistant's citation marker with a link to the page", () => {
        const shaped = {
            matches: [
                { page: 3, cite: '<citation id="g42-BBBB2222" page="3"/>', excerpts: ['a phrase'] },
                {
                    attachment_id: 'u-AAAA1111',
                    page: 5,
                    cite: '<citation id="u-AAAA1111" page="5" loc="s3-s4"/>',
                    passage: 'text',
                },
            ],
        };
        expect(withZoteroLinks(shaped)).toEqual({
            matches: [
                { page: 3, excerpts: ['a phrase'], open_uri: 'zotero://open-pdf/groups/42/items/BBBB2222?page=3' },
                {
                    attachment_id: 'u-AAAA1111',
                    page: 5,
                    passage: 'text',
                    open_uri: 'zotero://open-pdf/library/items/AAAA1111?page=5',
                },
            ],
        });
    });

    it('links an annotation to its place in the PDF and its paper in the library', () => {
        const row = {
            annotation_id: 'u-CCCC3333',
            attachment_id: 'u-DDDD4444',
            item_id: 'u-EEEE5555',
            page: 2,
            text: 'highlighted',
        };
        expect(withZoteroLinks({ annotations: [row] })).toEqual({
            annotations: [{
                ...row,
                open_uri: 'zotero://open-pdf/library/items/DDDD4444?page=2&annotation=CCCC3333',
                zotero_uri: 'zotero://select/library/items/EEEE5555',
            }],
        });
    });

    it('keeps a link a result already has, and a marker it cannot read', () => {
        const row = { item_id: 'u-EEEE5555', zotero_uri: 'zotero://select/library/items/OTHER', cite: '[1]' };
        expect(withZoteroLinks(row)).toEqual(row);
    });
});

describe('MCP content', () => {
    it('sends the pixels of an image result as MCP images after its text', () => {
        const result = toMcpResult('view_page_images', {
            kind: 'tool-images',
            text: 'Rendered page 3.',
            images: [{ mimeType: 'image/jpeg', base64: 'QUJD', label: 'page 3' }],
        });
        expect(result).toEqual({
            content: [
                { type: 'text', text: 'Rendered page 3.' },
                { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
            ],
        });
    });

    it('says how many images there are when an image result has no text', () => {
        const result = toMcpResult('view_page_images', { kind: 'tool-images', images: [] });
        expect(result.content).toEqual([{ type: 'text', text: '0 images returned.' }]);
    });

    it("adds links but leaves the library's own text exactly as it is", () => {
        const result = toMcpResult('find_annotations', {
            query: 'read_document',
            annotations: [{
                annotation_id: 'u-CCCC3333',
                attachment_id: 'u-DDDD4444',
                page: 1,
                text: 'Call get_metadata, then read_document.',
                comment: 'check item_search_by_topic',
            }],
        });
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse((result.content[0] as any).text);
        expect(parsed.query).toBe('read_document');
        expect(parsed.annotations[0].text).toBe('Call get_metadata, then read_document.');
        expect(parsed.annotations[0].comment).toBe('check item_search_by_topic');
        expect(parsed.annotations[0].open_uri).toBe('zotero://open-pdf/library/items/DDDD4444?page=1&annotation=CCCC3333');
    });

    it("clips a result to the assistant's budget for that tool, and says so", () => {
        const result = toMcpResult('search_in_document', { matches: [{ excerpts: ['x'.repeat(20_000)] }] });
        const text = (result.content[0] as any).text as string;
        expect(text.length).toBeLessThan(12_200);
        expect(text).toMatch(/…\[truncated \d+ characters\]$/);
    });

    it('turns a failure into a tool error the model can read, worded as the tool worded it', () => {
        expect(toMcpError(new Error('attachment_id "read_document" is not a valid id.'))).toEqual({
            content: [{ type: 'text', text: 'attachment_id "read_document" is not a valid id.' }],
            isError: true,
        });
        expect(toMcpError('plain')).toEqual({ content: [{ type: 'text', text: 'plain' }], isError: true });
    });
});

describe('calling a tool', () => {
    it("runs the assistant's executor and shapes its answer the sidebar's way", async () => {
        const handle = vi.fn(async (event: any) => ({
            event: 'zotero_attachment_search_response',
            request_id: event.request_id,
            query: 'dough rise',
            total_matches: 2,
            pages_with_matches: 1,
            total_pages: 12,
            pages: [{ page_index: 6, label: '7', match_count: 2, hits: [{ matched_text: 'dough rise time' }] }],
        }));
        provider.value = { zotero_attachment_search_request: { handle } };

        const result = await callLibraryTool('search_in_document', { attachment_id: 'u-AAAA1111', query: 'dough rise' });

        expect(handle).toHaveBeenCalledTimes(1);
        expect(handle.mock.calls[0][0].event).toBe('zotero_attachment_search_request');
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse((result.content[0] as any).text);
        expect(parsed.request_id).toBeUndefined();
        expect(parsed.matches).toEqual([{
            page: 7,
            label: '7',
            match_count: 2,
            excerpts: ['dough rise time'],
            open_uri: 'zotero://open-pdf/library/items/AAAA1111?page=7',
        }]);
    });

    it('reports an executor that answers with an error as a tool error', async () => {
        provider.value = {
            get_annotations_request: {
                handle: async () => ({ error: 'That library is excluded in AlphainZ.', error_code: 'library_excluded' }),
            },
        };
        const result = await callLibraryTool('get_annotations', { attachment_id: 'u-AAAA1111' });
        expect(result.isError).toBe(true);
        expect((result.content[0] as any).text).toBe('That library is excluded in AlphainZ. (library_excluded)');
    });

    it('reports arguments the executor cannot take as a tool error, without running it', async () => {
        const handle = vi.fn();
        provider.value = { zotero_attachment_page_images_request: { handle } };
        const result = await callLibraryTool('view_page_images', { attachment_id: 'nonsense', pages: [1] });
        expect(result.isError).toBe(true);
        expect((result.content[0] as any).text).toContain('is not a valid id');
        expect(handle).not.toHaveBeenCalled();
    });

    it('sends rendered pages as images', async () => {
        provider.value = {
            zotero_attachment_page_images_request: {
                handle: async () => ({
                    total_pages: 9,
                    pages: [{ page_number: 2, page_label: '2', format: 'png', image_data: 'UE5H' }],
                }),
            },
        };
        const result = await callLibraryTool('view_page_images', { attachment_id: 'u-AAAA1111', pages: [2] });
        expect(result.content).toEqual([
            { type: 'text', text: 'Rendered page 2. Document has 9 pages total.' },
            { type: 'image', data: 'UE5H', mimeType: 'image/png' },
        ]);
    });

    it('runs the full-text search and links its hits', async () => {
        const result = await callLibraryTool('search_library_fulltext', { query: 'sourdough proofing' });
        const parsed = JSON.parse((result.content[0] as any).text);
        expect(parsed.matches[0]).toEqual({
            attachment_id: 'u-AAAA1111',
            title: 'A paper about sourdough proofing',
            page: 5,
            similarity: 0.71,
            passage: 'The passage that matched.',
            open_uri: 'zotero://open-pdf/library/items/AAAA1111?page=5',
        });
    });

    it('sends an image attachment as an MCP image, described as an attachment', async () => {
        provider.value = {
            zotero_attachment_image_request: {
                handle: async () => ({ image: { image_data: 'UE5H', format: 'png', width: 2, height: 3 } }),
            },
        };
        const result = await callLibraryTool('view_attachment_image', { attachment_id: 'u-AAAA1111' });
        expect(result.content).toEqual([
            { type: 'text', text: 'Rendered the image attachment (2×3).' },
            { type: 'image', data: 'UE5H', mimeType: 'image/png' },
        ]);
    });

    it('does not run an index search the settings rule out, and says why', async () => {
        const dispatch = vi.fn();
        semanticSearch.fulltextPref = false;
        const result = await callLibraryTool('search_library_fulltext', { query: 'x' }, () => dispatch);
        expect(result).toEqual({
            content: [{ type: 'text', text: "Searching AlphainZ's index is turned off in its settings." }],
            isError: true,
        });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('says the local embedding server is down instead of searching', async () => {
        const dispatch = vi.fn();
        semanticSearch.state = { status: 'unreachable', provider: 'ollama', reason: 'Ollama is not running on this computer' };
        semanticSearch.reachable = false;
        const result = await callLibraryTool('search_library_figures', { query: 'x' }, () => dispatch);
        expect(result).toEqual({
            content: [{ type: 'text', text: 'Ollama is not running on this computer.' }],
            isError: true,
        });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('takes arguments that are not an object as no arguments', async () => {
        const dispatch = vi.fn(async () => ({ libraries: [] }));
        await callLibraryTool('list_libraries', 'oops', () => dispatch);
        expect(dispatch).toHaveBeenCalledWith('list_libraries', {}, expect.objectContaining({ toolCallId: expect.any(String) }));
    });
});

describe('the tool definitions', () => {
    it('serves the eight tools in a fixed order', () => {
        expect(mcpLibraryTools().map((tool) => tool.definition.name)).toEqual([...MCP_LIBRARY_TOOL_NAMES]);
        expect(MCP_LIBRARY_TOOL_NAMES).toHaveLength(8);
    });

    it('names no tool an MCP client does not have, in any description', () => {
        for (const { definition } of mcpLibraryTools()) {
            expect(definition.description).not.toMatch(ASSISTANT_ONLY_NAMES);
            expect(JSON.stringify(definition.inputSchema)).not.toMatch(ASSISTANT_ONLY_NAMES);
        }
    });

    it("takes the assistant's arguments, and marks every tool read-only", () => {
        const tools = new Map(mcpLibraryTools().map((tool) => [tool.definition.name, tool.definition]));
        expect(Object.keys(tools.get('view_page_images')!.inputSchema.properties)).toEqual(
            Object.keys(TOOL_SPECS_BY_NAME.get('view_page_images')!.schema.parameters.properties),
        );
        expect(tools.get('search_library_fulltext')!.inputSchema.required)
            .toEqual(FULLTEXT_TOOL_SCHEMA.parameters.required);
        for (const definition of tools.values()) {
            expect(definition.inputSchema.type).toBe('object');
            expect(definition.description.length).toBeGreaterThan(40);
            expect(definition.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
        }
    });

    it('describes view_attachment_image as an image file in the library, not a picture in a message', () => {
        const definition = mcpLibraryTools().find((tool) => tool.definition.name === 'view_attachment_image')!.definition;
        expect(definition.description).toContain("image file stored in the user's library");
        expect(definition.description).not.toMatch(/message/i);
    });

    it('lists the full-text search when an embedding model is set up and the search is on', () => {
        const fulltext = mcpLibraryTools().find((tool) => tool.definition.name === 'search_library_fulltext')!;
        expect(fulltext.isAvailable!()).toBe(true);
        semanticSearch.fulltextPref = false;
        expect(fulltext.isAvailable!()).toBe(false);
        semanticSearch.fulltextPref = undefined;
        semanticSearch.state = { status: 'off' };
        expect(fulltext.isAvailable!()).toBe(false);
        semanticSearch.state = { status: 'needs_key', provider: 'openai', label: 'OpenAI' };
        expect(fulltext.isAvailable!()).toBe(false);
    });

    it('keeps listing a search whose local embedding server is only down for now', () => {
        semanticSearch.state = { status: 'unreachable', provider: 'ollama', reason: 'Ollama is not running on this computer' };
        semanticSearch.reachable = false;
        expect(indexSearchUnavailable('search_library_fulltext')).toBeNull();
        expect(indexSearchUnavailable('search_library_figures')).toBeNull();
    });

    it('lists the figure search only for an embedding model that takes pictures', () => {
        const figures = mcpLibraryTools().find((tool) => tool.definition.name === 'search_library_figures')!;
        expect(figures.isAvailable!()).toBe(true);
        semanticSearch.state = { status: 'ready', provider: 'openai' };
        expect(figures.isAvailable!()).toBe(false);
        expect(indexSearchUnavailable('search_library_figures')).toContain('takes pictures');
        semanticSearch.state = { status: 'ready', provider: 'ollama' };
        expect(figures.isAvailable!()).toBe(true);
    });

    it('always lists the other six', () => {
        const always = mcpLibraryTools().filter((tool) => !tool.isAvailable).map((tool) => tool.definition.name);
        expect(always).toEqual([
            'search_in_document',
            'view_page_images',
            'view_attachment_image',
            'find_annotations',
            'get_annotations',
            'list_libraries',
        ]);
    });
});
