import { describe, expect, it } from 'vitest';

import {
    isToolImagesResult,
    toolImagesToContent,
    serializeToolResult,
    type ToolImagesResult,
} from '../../../src/services/llm/agentLoop';
import { toOpenAIMessages } from '../../../src/services/llm/openAICompatible';
import { pageImagesToToolResult } from '../../../src/services/llm/zoteroToolDispatch';
import {
    contentToText,
    hasImageParts,
    toDataUrl,
    type ChatMessage,
} from '../../../src/services/llm/types';

const B64 = 'iVBORw0KGgo=';

const imageResult = (n: number): ToolImagesResult => ({
    kind: 'tool-images',
    text: `Rendered ${n} page(s).`,
    images: Array.from({ length: n }, (_, i) => ({
        mimeType: 'image/jpeg',
        base64: B64,
        label: `page ${i + 1}`,
    })),
});

// ---------------------------------------------------------------------------
// Content-part helpers
// ---------------------------------------------------------------------------

describe('content parts', () => {
    it('builds a data URL the wire format expects', () => {
        expect(toDataUrl({ mimeType: 'image/png', base64: B64 })).toBe(
            `data:image/png;base64,${B64}`,
        );
    });

    it('detects images only in a parts array', () => {
        expect(hasImageParts('plain text')).toBe(false);
        expect(hasImageParts([{ type: 'text', text: 'hi' }])).toBe(false);
        expect(hasImageParts([{ type: 'image', mimeType: 'image/png', base64: B64 }])).toBe(true);
    });

    it('describes an image when flattening rather than dropping it', () => {
        // A silently dropped image leaves the model reading a caption that
        // refers to something it was never shown.
        const text = contentToText([
            { type: 'text', text: 'Figure 3:' },
            { type: 'image', mimeType: 'image/jpeg', base64: B64, label: 'page 7' },
        ]);
        expect(text).toContain('Figure 3:');
        expect(text).toContain('page 7');
    });
});

// ---------------------------------------------------------------------------
// Tool image results
// ---------------------------------------------------------------------------

describe('tool image results', () => {
    it('recognises only the tagged shape', () => {
        expect(isToolImagesResult(imageResult(1))).toBe(true);
        expect(isToolImagesResult({ items: [] })).toBe(false);
        expect(isToolImagesResult(null)).toBe(false);
        expect(isToolImagesResult('a string')).toBe(false);
        expect(isToolImagesResult({ kind: 'tool-images' })).toBe(false);
    });

    it('always leads with a text part', () => {
        // Pixels with no caption give the model nothing to anchor on, and some
        // endpoints reject a content array with no text part.
        const parts = toolImagesToContent({ kind: 'tool-images', images: [
            { mimeType: 'image/png', base64: B64 },
        ] });
        expect(parts[0]).toMatchObject({ type: 'text' });
        expect((parts[0] as any).text).toContain('1 image');
    });

    it('preserves order and labels', () => {
        const parts = toolImagesToContent(imageResult(2));
        expect(parts).toHaveLength(3);
        expect((parts[1] as any).label).toBe('page 1');
        expect((parts[2] as any).label).toBe('page 2');
    });

    it('never routes an image result through JSON serialization', () => {
        // Base64 through JSON.stringify arrives as a quoted blob the model
        // cannot decode, and blows the character budget getting there.
        const asJson = serializeToolResult(imageResult(1), 60_000);
        expect(asJson).toContain('tool-images');
        expect(isToolImagesResult(imageResult(1))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// pageImagesToToolResult
// ---------------------------------------------------------------------------

describe('pageImagesToToolResult', () => {
    const page = (n: number, format = 'jpeg') => ({
        page_number: n,
        image_data: B64,
        format,
        width: 800,
        height: 1000,
    });

    it('maps rendered pages with their MIME type', () => {
        const result = pageImagesToToolResult({ pages: [page(3)], total_pages: 12 });
        expect(result.images).toEqual([
            { mimeType: 'image/jpeg', base64: B64, label: 'page 3' },
        ]);
        expect(result.text).toContain('page 3');
        expect(result.text).toContain('12 pages');
    });

    it('honours png', () => {
        const result = pageImagesToToolResult({ pages: [page(1, 'png')] });
        expect(result.images[0].mimeType).toBe('image/png');
    });

    it('prefers the page label when the document declares one', () => {
        const result = pageImagesToToolResult({
            pages: [{ ...page(4), page_label: 'iv' }],
        });
        expect(result.images[0].label).toBe('page iv');
    });

    it('says the document length when nothing rendered', () => {
        // Otherwise a request for page 40 of a 12-page paper is
        // indistinguishable from a blank page.
        const result = pageImagesToToolResult({ pages: [], total_pages: 12 });
        expect(result.images).toEqual([]);
        expect(result.text).toContain('No pages were rendered');
        expect(result.text).toContain('12 pages');
    });

    it('caps the batch and says how many it dropped', () => {
        const result = pageImagesToToolResult({
            pages: Array.from({ length: 10 }, (_, i) => page(i + 1)),
        });
        expect(result.images).toHaveLength(6);
        expect(result.text).toContain('4 further page(s) omitted');
    });

    it('survives a malformed response', () => {
        expect(pageImagesToToolResult({}).images).toEqual([]);
        expect(pageImagesToToolResult({ pages: null }).images).toEqual([]);
        expect(pageImagesToToolResult({ pages: [{}] })[
            'images'
        ][0]).toMatchObject({ base64: '' });
    });
});

// ---------------------------------------------------------------------------
// Wire serialization — the two strategies
// ---------------------------------------------------------------------------

describe('toOpenAIMessages with images', () => {
    const toolMessage: ChatMessage = {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'view_page_images',
        content: toolImagesToContent(imageResult(2)),
    };
    // The assistant turn that asked for it: a tool result is only sent after
    // the call it answers.
    const asked = (id: string, name: string): ChatMessage => ({
        role: 'assistant',
        content: '',
        toolCalls: [{ id, name, argumentsJson: '{}' }],
    });
    const viewCall = asked('call_1', 'view_page_images');

    it('keeps images on the tool message when the endpoint allows it', () => {
        const wire = toOpenAIMessages([viewCall, toolMessage], { imagesInToolResults: true });
        expect(wire).toHaveLength(2);
        expect(wire[1].role).toBe('tool');
        const parts = wire[1].content as any[];
        expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
        expect(parts[1].image_url.url).toBe(`data:image/jpeg;base64,${B64}`);
    });

    it('lifts images into a follow-up user message otherwise', () => {
        const wire = toOpenAIMessages([viewCall, toolMessage], { imagesInToolResults: false });
        expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
        expect((wire[2].content as any[]).filter((p) => p.type === 'image_url')).toHaveLength(2);
    });

    it('still answers the tool_call_id when images are lifted out', () => {
        // An unanswered tool_call_id makes the whole next request 400, so the
        // tool message must survive the split even though its images left.
        const wire = toOpenAIMessages([viewCall, toolMessage], { imagesInToolResults: false });
        expect(wire[1].tool_call_id).toBe('call_1');
        expect(typeof wire[1].content).toBe('string');
        expect(wire[1].content as string).toContain('image omitted');
    });

    it('defaults to lifting when the flag is absent', () => {
        expect(toOpenAIMessages([viewCall, toolMessage])).toHaveLength(3);
    });

    it('leaves a text-only tool result as a plain string either way', () => {
        const plain: ChatMessage = {
            role: 'tool',
            toolCallId: 'c',
            name: 'list_tags',
            content: '{"tags":[]}',
        };
        for (const flag of [true, false]) {
            const wire = toOpenAIMessages([asked('c', 'list_tags'), plain], { imagesInToolResults: flag });
            expect(wire).toHaveLength(2);
            expect(wire[1].content).toBe('{"tags":[]}');
        }
    });

    it('carries images on a user message', () => {
        const wire = toOpenAIMessages([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What does this figure show?' },
                    { type: 'image', mimeType: 'image/png', base64: B64 },
                ],
            },
        ]);
        const parts = wire[0].content as any[];
        expect(parts[0]).toEqual({ type: 'text', text: 'What does this figure show?' });
        expect(parts[1].image_url.url).toContain('data:image/png;base64,');
    });

    it('keeps an assistant tool-call turn untouched by the image path', () => {
        const wire = toOpenAIMessages([
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'view_page_images', argumentsJson: '{}' }],
            },
        ]);
        expect(wire[0].content).toBeNull();
        expect(wire[0].tool_calls).toHaveLength(1);
    });

    it('holds lifted images until the whole tool block has answered', () => {
        // One assistant turn, two tool calls — view_page_images answers first.
        // The lifted user message must NOT wedge itself between the two tool
        // messages: the API requires the block answering a tool_calls turn to
        // be uninterrupted, and the wedge is a 400 on every following request
        // ("insufficient tool messages following tool_calls message" —
        // DeepSeek, seen live from a selection chat that viewed a page and
        // fetched metadata in the same turn).
        const wire = toOpenAIMessages(
            [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'call_1', name: 'view_page_images', argumentsJson: '{}' },
                        { id: 'c2', name: 'get_metadata', argumentsJson: '{}' },
                    ],
                },
                toolMessage,
                { role: 'tool', toolCallId: 'c2', name: 'get_metadata', content: '{"title":"x"}' },
            ],
            { imagesInToolResults: false },
        );
        expect(wire.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
        expect(wire[1].tool_call_id).toBe('call_1');
        expect(wire[2].tool_call_id).toBe('c2');
        expect((wire[3].content as any[]).filter((p) => p.type === 'image_url')).toHaveLength(2);
    });

    it('preserves message order when a split happens mid-transcript', () => {
        const wire = toOpenAIMessages(
            [
                { role: 'user', content: 'look at page 3' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'call_1', name: 'view_page_images', argumentsJson: '{}' }],
                },
                toolMessage,
                { role: 'user', content: 'and page 4?' },
            ],
            { imagesInToolResults: false },
        );
        expect(wire.map((m) => m.role)).toEqual([
            'user',
            'assistant',
            'tool',
            'user',
            'user',
        ]);
    });
});
