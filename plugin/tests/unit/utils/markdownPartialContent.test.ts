import { describe, expect, it } from 'vitest';
import { processPartialContent } from '../../../react/utils/markdownPartialContent';

describe('processPartialContent', () => {
    it('preserves completed display math followed by prose', () => {
        const content = [
            'The actual array response becomes:',
            '',
            '$$\\mathbf{s}_r(r) = \\mathbf{C} \\cdot \\mathbf{s}_{r,id}(r)$$',
            '',
            'This means the effective array pattern deviates from the nominal design.',
            '',
            '## Sources',
            '',
            'Schmid, Christian M.',
        ].join('\n');

        const result = processPartialContent(content, false);

        expect(result).toContain('$$\\mathbf{s}_r(r) = \\mathbf{C} \\cdot \\mathbf{s}_{r,id}(r)$$');
        expect(result).toContain('This means the effective array pattern deviates');
        expect(result).toContain('## Sources');
    });

    it('preserves completed multiline display math followed by prose', () => {
        const content = [
            'Equation:',
            '',
            '$$',
            '\\mathbf{s}_r(r) = \\mathbf{C} \\cdot \\mathbf{s}_{r,id}(r)',
            '$$',
            '',
            'The next paragraph remains visible.',
        ].join('\n');

        const result = processPartialContent(content, false);

        expect(result).toBe(content);
    });

    it('strips a trailing incomplete inline display math fragment', () => {
        const content = 'The actual array response becomes:\n\n$$\\mathbf{s}_r(r)';

        const result = processPartialContent(content, false);

        expect(result).toBe('The actual array response becomes:\n\n');
    });

    it('strips a trailing incomplete multiline display math block', () => {
        const content = [
            'Equation:',
            '',
            '$$',
            '\\mathbf{s}_r(r) = \\mathbf{C}',
        ].join('\n');

        const result = processPartialContent(content, false);

        expect(result).toBe('Equation:\n\n');
    });

    it('keeps Chinese full-width punctuation and superscripts as written, on screen as in export', () => {
        const text = '能量 E = mc²，单位是焦耳（J）！';
        expect(processPartialContent(text, false)).toBe(text);
        expect(processPartialContent(text, true)).toBe(text);
    });

    it('still drops zero-width characters and soft hyphens', () => {
        expect(processPartialContent('a\u200Bb\u00ADc', false)).toBe('abc');
    });
});
