/**
 * A model that cannot read images is never sent one.
 *
 * A text-only endpoint rejects the whole request over one image part, and a
 * thread started on a model that reads figures still carries its images when
 * it moves to one that does not, so every later message there would fail. The
 * images are replaced by a notice instead, which also tells the model why it
 * cannot see them.
 */
import { describe, expect, it } from 'vitest';

import {
    OpenAICompatibleProvider,
    providerFromPreset,
    type FetchLike,
} from '../../../src/services/llm/openAICompatible';
import type { ChatMessage, ProviderConfig } from '../../../src/services/llm/types';

const B64 = 'iVBORw0KGgo=';
const noFetch = (async () => {
    throw new Error('not called');
}) as unknown as FetchLike;

const figureQuestion: ChatMessage[] = [
    {
        role: 'user',
        content: [
            { type: 'text', text: 'What does this figure show?' },
            { type: 'image', mimeType: 'image/png', base64: B64, label: 'figure 2' },
        ],
    },
    {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'view_page_images', argumentsJson: '{"pages":[3]}' }],
    },
    {
        role: 'tool',
        toolCallId: 'c1',
        name: 'view_page_images',
        content: [
            { type: 'text', text: 'Rendered page 3.' },
            { type: 'image', mimeType: 'image/jpeg', base64: B64, label: 'page 3' },
            { type: 'image', mimeType: 'image/jpeg', base64: B64, label: 'page 3 (crop)' },
        ],
    },
];

function provider(supportsVision: boolean | undefined): OpenAICompatibleProvider {
    const config: ProviderConfig = {
        label: 'Lab server',
        baseUrl: 'http://10.0.0.5:8000/v1',
        apiKey: '',
        model: 'm',
        wireFormat: 'openai',
        imagesInToolResults: false,
        ...(supportsVision !== undefined ? { supportsVision } : {}),
    };
    return new OpenAICompatibleProvider(config, noFetch);
}

const wireMessages = (p: OpenAICompatibleProvider) => p.buildBody({ messages: figureQuestion }).messages as any[];

describe('a text-only model', () => {
    it('is sent a notice in place of the image the user attached', () => {
        const [question] = wireMessages(provider(false));
        expect(question.role).toBe('user');
        expect(typeof question.content).toBe('string');
        expect(question.content).toContain('What does this figure show?');
        expect(question.content).toContain('An image was not sent: this model cannot read images.');
    });

    it('is sent the text of a tool result that returned images, and no follow-up images', () => {
        const messages = wireMessages(provider(false));
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
        const result = messages[2];
        expect(result.tool_call_id).toBe('c1');
        expect(result.content).toContain('Rendered page 3.');
        expect(result.content).toContain('2 images returned by view_page_images were not sent');
    });

    it('carries no pixels anywhere in the request', () => {
        const body = JSON.stringify(provider(false).buildBody({ messages: figureQuestion }));
        expect(body).not.toContain('image_url');
        expect(body).not.toContain(B64);
    });

    it('is what the Ollama preset builds', () => {
        const body = JSON.stringify(
            providerFromPreset('ollama', '', noFetch, { model: 'qwen3:32b' }).buildBody({ messages: figureQuestion }),
        );
        expect(body).not.toContain('image_url');
        expect(body).toContain('this model cannot read images');
    });
});

describe('a model that reads images', () => {
    it('still receives them', () => {
        const messages = wireMessages(provider(true));
        expect(messages[0].content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } });
        // The tool's images are lifted into a user message after the result.
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    });

    it('receives them when nothing was said about vision at all', () => {
        expect(JSON.stringify(provider(undefined).buildBody({ messages: figureQuestion }))).toContain('image_url');
    });
});
