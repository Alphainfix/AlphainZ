/**
 * Every failure a local run can end with has a headline of its own.
 *
 * The error card's title comes from the error type. A type with no entry reads
 * "An error occurred", which tells a student nothing — a missing key, an
 * unreachable server and a crash in the run would all look alike. The types
 * are taken from the runner's own classifier, so a new one it starts to emit
 * without a title fails here.
 */
import { describe, expect, it } from 'vitest';

import { getRunErrorTitle } from '@beaver/agent-core/run-state/runErrorCopy';
import { classifyRunError } from '@beaver/agent-llm/localRunner';
import { ModelRequestError, type ModelRequestErrorInit } from '@beaver/agent-llm/sse';

const GENERIC = 'An error occurred';

const modelError = (init: ModelRequestErrorInit) =>
    new ModelRequestError('request failed', { label: 'DeepSeek', ...init });

/** One failure of each shape the runner distinguishes. */
const FAILURES: Array<[string, Error]> = [
    ['a thrown exception', new Error('Cannot read properties of undefined')],
    ['an abort', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })],
    ['a stop', modelError({ kind: 'cancelled' })],
    ['no connection', modelError({ kind: 'network' })],
    ['no answer in time', modelError({ kind: 'timeout' })],
    ['a reply cut off mid-stream', modelError({ kind: 'stream' })],
    ['a rejected key', modelError({ kind: 'http', status: 401 })],
    ['a region block', modelError({ kind: 'http', status: 403, code: 'unsupported_country_region_territory' })],
    ['a refused request', modelError({ kind: 'http', status: 403 })],
    ['no credit', modelError({ kind: 'http', status: 402 })],
    ['a spent quota', modelError({ kind: 'http', status: 429, code: '1113' })],
    ['a rate limit', modelError({ kind: 'http', status: 429 })],
    ['an unknown model', modelError({ kind: 'http', status: 404 })],
    ['a request too long', modelError({ kind: 'http', status: 413 })],
    ['a gateway timeout', modelError({ kind: 'http', status: 504 })],
    ['a server error', modelError({ kind: 'http', status: 500 })],
    ['a rejected request', modelError({ kind: 'http', status: 400 })],
    ['a failure inside a reply', modelError({ kind: 'provider' })],
    ['a refusal inside a reply', modelError({ kind: 'provider', retryable: false })],
];

describe('the headline of a failed local run', () => {
    it.each(FAILURES)('names %s', (_what, error) => {
        const { type } = classifyRunError(error);
        expect(getRunErrorTitle(type)).not.toBe(GENERIC);
    });

    it('says the model is not set up when the run could not be configured', () => {
        expect(getRunErrorTitle('not_configured')).toBe('Model Not Set Up');
    });

    it('says the model cannot be reached when the connection failed', () => {
        expect(getRunErrorTitle('llm_network_error')).toBe("Can't Reach the Model");
    });

    it('gives a crash in the run and an unexpected stop their own titles', () => {
        expect(getRunErrorTitle('llm_error')).toBe('Run Failed');
        expect(getRunErrorTitle('run_cancelled')).toBe('Run Stopped');
    });
});
