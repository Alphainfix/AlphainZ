/**
 * The prompt has to ask for LaTeX, or none of the rendering matters.
 *
 * The renderer, the KaTeX stylesheet and the fonts all shipped from the start;
 * what was missing was any instruction to write mathematics as mathematics, so
 * symbols came back as plain text with underscores and carets.
 */
import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from '../../../src/services/llm/systemPrompt';

describe('system prompt: formulas', () => {
    const prompt = buildSystemPrompt({});

    it('asks for LaTeX with both delimiters', () => {
        expect(prompt).toContain('$…$');
        expect(prompt).toContain('$$…$$');
    });

    it('names the symbol case, not just equations', () => {
        // A whole answer can be about one quantity and contain no equation.
        expect(prompt).toMatch(/x_2\^\*/);
    });

    it('rules out the dollar sign for money', () => {
        // Otherwise a price becomes math and swallows the sentence around it.
        expect(prompt).toContain('5 USD');
    });

    it('survives into the no-index variant', () => {
        // The only thing that still changes the prompt is the embedding index
        // being absent; the formula rule has to be there either way.
        expect(buildSystemPrompt({ semanticSearchAvailable: false })).toContain('$$…$$');
    });
});
