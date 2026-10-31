/**
 * A citation's `loc` may only name sentences the run was actually shown.
 *
 * The model composes `loc` from the `[s12]` labels in read_document text, which
 * is what makes the click land on the sentence. A label it invented would land
 * the reader on the wrong sentence, so it is dropped and the tag keeps its page.
 */
import { describe, expect, it } from 'vitest';
import {
    recordShownLocators,
    sentenceLabelsIn,
    sentenceRangeNumbers,
    takeShownLocators,
    validateComposedLocators,
} from '../../../react/utils/highlightCitations';

const shown = (ids: Record<string, number[]>) => new Map(Object.entries(ids).map(([k, v]) => [k, new Set(v)]));

describe('validateComposedLocators', () => {
    it('keeps a loc whose sentences were all shown', () => {
        const text = 'Optic-flow odometry <citation id="u-A" page="3" loc="s12-s13"/> works.';
        expect(validateComposedLocators(text, shown({ 'u-A': [11, 12, 13, 14] }))).toBe(text);
    });

    it('drops a loc naming a sentence the run never saw, keeping the page', () => {
        const text = 'Claim <citation id="u-A" page="3" loc="s40"/>.';
        expect(validateComposedLocators(text, shown({ 'u-A': [11, 12, 13] }))).toBe('Claim <citation id="u-A" page="3"/>.');
    });

    it('drops a range that runs past what was shown', () => {
        const text = '<citation id="u-A" page="3" loc="s12-s20"/>';
        expect(validateComposedLocators(text, shown({ 'u-A': [12, 13] }))).toBe('<citation id="u-A" page="3"/>');
    });

    it('leaves attachments it was shown nothing for alone', () => {
        const text = '<citation id="u-B" page="1" loc="s5"/>';
        expect(validateComposedLocators(text, shown({ 'u-A': [1] }))).toBe(text);
    });

    it('leaves tags without loc and answers without citations untouched', () => {
        expect(validateComposedLocators('<citation id="u-A" page="2"/> x', shown({ 'u-A': [1] }))).toBe('<citation id="u-A" page="2"/> x');
        expect(validateComposedLocators('no tags here', shown({ 'u-A': [1] }))).toBe('no tags here');
    });
});

describe('the shown-locator registry', () => {
    it('collects labels from read text and ranges from search hits, per run and attachment', () => {
        recordShownLocators('run-1', 'u-A', sentenceLabelsIn('[p1] [s7] Foraging honeybees. [s8] They gauge distance. [heading2]'));
        recordShownLocators('run-1', 'u-B', sentenceRangeNumbers(30, 33));
        const taken = takeShownLocators('run-1');
        expect([...taken.get('u-A')!]).toEqual([7, 8]);
        expect([...taken.get('u-B')!]).toEqual([30, 31, 32, 33]);
        // Taken once: the run is over.
        expect(takeShownLocators('run-1').size).toBe(0);
    });
});
