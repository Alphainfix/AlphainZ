/**
 * Token usage, read off the stream and summed.
 *
 * The number is the provider's own count rather than an estimate, because the
 * point of showing it is that the user is spending their own money and an
 * estimate is a figure they cannot reconcile with their bill.
 */
import { describe, expect, it } from 'vitest';

import { addUsage, readUsage } from '../../../src/services/llm/sse';

describe('readUsage', () => {
    it('reads the OpenAI shape', () => {
        expect(
            readUsage({ usage: { prompt_tokens: 85, completion_tokens: 16, total_tokens: 101 } }),
        ).toEqual({ promptTokens: 85, completionTokens: 16, totalTokens: 101 });
    });

    it('picks up cached prompt tokens when the provider reports them', () => {
        // Worth surfacing: a long thread whose prompt is mostly cache reads
        // costs far less than the raw input count suggests.
        expect(
            readUsage({
                usage: {
                    prompt_tokens: 4000,
                    completion_tokens: 100,
                    total_tokens: 4100,
                    prompt_tokens_details: { cached_tokens: 3500 },
                },
            }),
        ).toMatchObject({ cachedTokens: 3500 });
    });

    it('omits cached tokens when there are none', () => {
        const usage = readUsage({
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12,
                     prompt_tokens_details: { cached_tokens: 0 } },
        });
        expect(usage).not.toHaveProperty('cachedTokens');
    });

    it('derives the total when the provider omits it', () => {
        expect(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toMatchObject({
            totalTokens: 15,
        });
    });

    it('ignores a frame with no usage', () => {
        expect(readUsage({ choices: [{ delta: { content: 'hi' } }] })).toBeUndefined();
        expect(readUsage({ usage: null })).toBeUndefined();
        expect(readUsage(null)).toBeUndefined();
    });

    it('ignores an all-zero report', () => {
        // Some endpoints send a usage object of zeros on every frame; treating
        // that as real would reset a running total to nothing.
        expect(readUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }))
            .toBeUndefined();
    });
});

describe('addUsage', () => {
    const a = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };
    const b = { promptTokens: 300, completionTokens: 50, totalTokens: 350 };

    it('sums two reports', () => {
        // A tool-using run makes one request per iteration and the user is
        // billed for all of them.
        expect(addUsage(a, b)).toEqual({
            promptTokens: 400,
            completionTokens: 70,
            totalTokens: 470,
        });
    });

    it('starts from nothing', () => {
        expect(addUsage(undefined, a)).toEqual(a);
    });

    it('sums cached tokens too, and omits the field when neither has any', () => {
        expect(addUsage({ ...a, cachedTokens: 10 }, { ...b, cachedTokens: 5 })).toMatchObject({
            cachedTokens: 15,
        });
        expect(addUsage(a, b)).not.toHaveProperty('cachedTokens');
    });
});
