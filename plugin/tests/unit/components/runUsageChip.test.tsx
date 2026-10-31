/**
 * The usage chip's arithmetic and its silence.
 */
import { describe, expect, it } from 'vitest';

import { formatTokens, sumUsage } from '../../../react/components/input/RunUsageChip';

const run = (input: number, output: number, cached = 0) =>
    ({ total_usage: { input_tokens: input, output_tokens: output, cache_read_tokens: cached } }) as any;

describe('formatTokens', () => {
    it('keeps small counts exact', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(999)).toBe('999');
    });

    it('abbreviates thousands, with a decimal only where it carries information', () => {
        expect(formatTokens(1234)).toBe('1.2k');
        expect(formatTokens(45_000)).toBe('45k');
    });

    it('abbreviates millions', () => {
        expect(formatTokens(2_400_000)).toBe('2.4M');
    });
});

describe('sumUsage', () => {
    it('sums across the runs in a thread', () => {
        expect(sumUsage([run(100, 20), run(300, 50)])).toEqual({
            input: 400,
            output: 70,
            cached: 0,
            runs: 2,
        });
    });

    it('skips runs that reported nothing', () => {
        // A run that failed before the first token has no usage, and counting
        // it would overstate how many messages were billed.
        expect(sumUsage([run(100, 20), {} as any]).runs).toBe(1);
    });

    it('reports zero runs for an empty thread, so the chip can stay quiet', () => {
        // "0 tokens" would read as a claim that the last answer was free.
        expect(sumUsage([]).runs).toBe(0);
    });

    it('tracks cache reads separately from the input total', () => {
        const totals = sumUsage([run(4000, 100, 3500)]);
        expect(totals.input).toBe(4000);
        expect(totals.cached).toBe(3500);
    });
});
