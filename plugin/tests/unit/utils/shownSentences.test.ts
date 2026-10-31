/**
 * A citation that names its sentence shows that sentence on its hover card.
 *
 * The run keeps the text behind every `[s12]` label it was shown and every
 * passage a search hit handed it, so the card can show what the model read —
 * not "Page 7", which the reader already had.
 */
import { describe, expect, it } from 'vitest';
import {
    clipPassage,
    passageForLocator,
    recordShownPassage,
    recordShownSentences,
    sentenceTextsIn,
    takeShownText,
    type ShownText,
} from '../../../react/utils/highlightCitations';

describe('sentenceTextsIn', () => {
    it('pairs each sentence label with the text it introduces', () => {
        const text =
            '[heading1] II. METHODS\n\n'
            + '[s12] Optic-flow odometry measures the distance. [s13] The tunnel length limits it.\n\n'
            + '[p4] E = mc^2';
        expect(sentenceTextsIn(text)).toEqual([
            [12, 'Optic-flow odometry measures the distance.'],
            [13, 'The tunnel length limits it.'],
        ]);
    });

    it('ignores bracketed reference numbers and text before the first label', () => {
        expect(sentenceTextsIn('[12] Smith et al. [s3] A real sentence [14].')).toEqual([
            [3, 'A real sentence [14].'],
        ]);
    });

    it('returns nothing for text without labels', () => {
        expect(sentenceTextsIn('Plain markdown of a page.')).toEqual([]);
    });
});

describe('passageForLocator', () => {
    const shown: ShownText = {
        sentences: new Map([
            [12, { page: 3, text: 'A.' }],
            [13, { page: 3, text: 'B.' }],
            [14, { page: 4, text: 'C.' }],
        ]),
        passages: [{ start: 40, end: 45, page: 9, text: 'The whole hit, six sentences long.' }],
    };

    it('names one sentence', () => {
        expect(passageForLocator('s12', shown)).toEqual({ page: 3, text: 'A.' });
    });

    it('joins a range on one page, whatever dash the model typed', () => {
        expect(passageForLocator('s12-s13', shown)).toEqual({ page: 3, text: 'A. B.' });
        expect(passageForLocator('s12–13', shown)).toEqual({ page: 3, text: 'A. B.' });
    });

    it('stops a range at the page boundary — a card shows one passage', () => {
        expect(passageForLocator('s13-s14', shown)).toEqual({ page: 3, text: 'B.' });
    });

    it('shows a search hit whole for the range it was handed as', () => {
        expect(passageForLocator('s40-s45', shown)).toEqual({ page: 9, text: 'The whole hit, six sentences long.' });
    });

    it('falls back to the hit that covers a sentence never shown on its own', () => {
        expect(passageForLocator('s42', shown)).toEqual({ page: 9, text: 'The whole hit, six sentences long.' });
    });

    it('has nothing for a sentence the run never saw, or a locator that is not a sentence', () => {
        expect(passageForLocator('s99', shown)).toBeNull();
        expect(passageForLocator('p4', shown)).toBeNull();
        expect(passageForLocator('s12', undefined)).toBeNull();
    });
});

describe('clipPassage', () => {
    it('leaves a short passage alone, whitespace collapsed', () => {
        expect(clipPassage('One  sentence,\n two lines.')).toBe('One sentence, two lines.');
    });

    it('cuts a long passage at a word boundary with one ellipsis', () => {
        const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
        const clipped = clipPassage(long, 100);
        expect(clipped.length).toBeLessThanOrEqual(101);
        expect(clipped.endsWith('…')).toBe(true);
        // Never mid-word: the character before the ellipsis ends a whole token.
        expect(clipped.slice(0, -1)).toMatch(/word\d+$/);
        expect(long.startsWith(clipped.slice(0, -1))).toBe(true);
    });
});

describe('the shown-text record', () => {
    it('is kept per run and read once', () => {
        recordShownSentences('run-1', 'u-A', 3, [[12, 'A.'], [13, 'B.']]);
        recordShownPassage('run-1', 'u-A', { start: 40, end: 45, page: 9, text: 'Hit.' });
        recordShownSentences('run-2', 'u-A', 1, [[1, 'Other run.']]);

        const taken = takeShownText('run-1');
        expect(passageForLocator('s12-s13', taken.get('u-A'))).toEqual({ page: 3, text: 'A. B.' });
        expect(passageForLocator('s40-s45', taken.get('u-A'))).toEqual({ page: 9, text: 'Hit.' });
        expect(takeShownText('run-1').size).toBe(0);
        expect(passageForLocator('s1', takeShownText('run-2').get('u-A'))).toEqual({ page: 1, text: 'Other run.' });
    });

    it('ignores a record with no run, no attachment, or no page', () => {
        recordShownSentences('', 'u-A', 3, [[12, 'A.']]);
        recordShownSentences('run-3', '', 3, [[12, 'A.']]);
        recordShownSentences('run-3', 'u-A', Number.NaN, [[12, 'A.']]);
        expect(takeShownText('run-3').size).toBe(0);
    });
});
