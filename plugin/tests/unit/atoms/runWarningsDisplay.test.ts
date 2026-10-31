/**
 * Which warnings each answer shows.
 *
 * "Topic search is off" comes with every answer while a chosen embedding
 * provider cannot be used. Shown above each one, it pushed every answer down
 * and trained the reader to skip grey boxes — including the ones about the
 * answer itself. It now shows on the first answer of a chat that carries it,
 * and once dismissed stays dismissed for the session. A warning about one
 * answer (it was cut off, a change could not be applied) still shows on that
 * answer, every time.
 */
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    addWarningAtom,
    dismissWarningAtom,
    runWarningsForDisplayAtom,
    selectRunWarnings,
    threadWarningsAtom,
    warningTone,
    type RunWarning,
} from '../../../react/atoms/warnings';

const TOPIC_OFF = 'Topic search is off: the bge-m3 model is not installed in Ollama. Keyword and metadata search still work.';
const TOPIC_NO_KEY = 'Topic search is off: embeddings are set to OpenAI, but this computer has no OpenAI API key.';
const CUT_OFF = 'The answer was cut off at the 32k-token output limit.';

let nextId = 0;
const warning = (run_id: string, type: string, message: string): RunWarning => ({
    id: `w${nextId++}`,
    run_id,
    type,
    message,
    created_at: '2026-09-25T12:00:00.000Z',
});

const ids = (shown: Record<string, RunWarning[]>, runId: string) => (shown[runId] ?? []).map((w) => w.message);

describe('warningTone', () => {
    it('tells a standing notice, a warning about the answer and a failed change apart', () => {
        expect(warningTone('semantic_search_unavailable')).toBe('notice');
        expect(warningTone('output_limit')).toBe('warning');
        expect(warningTone('iteration_limit')).toBe('warning');
        expect(warningTone('write_failed')).toBe('error');
        // A type this client does not know yet asks for attention rather than hiding.
        expect(warningTone('something_new')).toBe('warning');
    });
});

describe('selectRunWarnings', () => {
    it('shows a notice on the first answer of the chat that carries it, not on every one', () => {
        const warnings = [
            warning('r1', 'semantic_search_unavailable', TOPIC_OFF),
            warning('r2', 'semantic_search_unavailable', TOPIC_OFF),
            warning('r3', 'semantic_search_unavailable', TOPIC_OFF),
        ];
        const shown = selectRunWarnings(['r1', 'r2', 'r3'], warnings, new Set());
        expect(ids(shown, 'r1')).toEqual([TOPIC_OFF]);
        expect(shown.r2).toBeUndefined();
        expect(shown.r3).toBeUndefined();
    });

    it('moves the notice to the next answer when the first one is no longer in the chat', () => {
        const warnings = [
            warning('r1', 'semantic_search_unavailable', TOPIC_OFF),
            warning('r2', 'semantic_search_unavailable', TOPIC_OFF),
        ];
        // r1 was retried away.
        expect(ids(selectRunWarnings(['r2'], warnings, new Set()), 'r2')).toEqual([TOPIC_OFF]);
    });

    it('shows a notice again when its reason changes', () => {
        const warnings = [
            warning('r1', 'semantic_search_unavailable', TOPIC_OFF),
            warning('r2', 'semantic_search_unavailable', TOPIC_NO_KEY),
        ];
        const shown = selectRunWarnings(['r1', 'r2'], warnings, new Set());
        expect(ids(shown, 'r1')).toEqual([TOPIC_OFF]);
        expect(ids(shown, 'r2')).toEqual([TOPIC_NO_KEY]);
    });

    it('shows a warning about an answer on every answer that has it', () => {
        const warnings = [
            warning('r1', 'output_limit', CUT_OFF),
            warning('r2', 'output_limit', CUT_OFF),
        ];
        const shown = selectRunWarnings(['r1', 'r2'], warnings, new Set());
        expect(ids(shown, 'r1')).toEqual([CUT_OFF]);
        expect(ids(shown, 'r2')).toEqual([CUT_OFF]);
    });

    it('leaves credit info to its own bar above the composer', () => {
        const shown = selectRunWarnings(['r1'], [warning('r1', 'credit_info', 'Credits: 12 left')], new Set());
        expect(shown.r1).toBeUndefined();
    });
});

describe('the display atom', () => {
    it('keeps a dismissed notice hidden when the next answer brings it again', () => {
        const store = createStore();
        store.set(threadRunsAtom, [{ id: 'r1' }, { id: 'r2' }] as any);
        store.set(addWarningAtom, { run_id: 'r1', type: 'semantic_search_unavailable', message: TOPIC_OFF });
        const first = store.get(threadWarningsAtom)[0];
        expect(ids(store.get(runWarningsForDisplayAtom), 'r1')).toEqual([TOPIC_OFF]);

        store.set(dismissWarningAtom, first.id);
        store.set(addWarningAtom, { run_id: 'r2', type: 'semantic_search_unavailable', message: TOPIC_OFF });
        const shown = store.get(runWarningsForDisplayAtom);
        expect(shown.r1).toBeUndefined();
        expect(shown.r2).toBeUndefined();
    });

    it('dismisses a warning about an answer on that answer only', () => {
        const store = createStore();
        store.set(threadRunsAtom, [{ id: 'r1' }, { id: 'r2' }] as any);
        store.set(addWarningAtom, { run_id: 'r1', type: 'output_limit', message: CUT_OFF });
        store.set(dismissWarningAtom, store.get(threadWarningsAtom)[0].id);
        store.set(addWarningAtom, { run_id: 'r2', type: 'output_limit', message: CUT_OFF });
        expect(ids(store.get(runWarningsForDisplayAtom), 'r2')).toEqual([CUT_OFF]);
    });

    it('does not recompute for every streamed token of the answer in progress', () => {
        const store = createStore();
        store.set(threadRunsAtom, [{ id: 'r1', model_messages: [] }] as any);
        store.set(addWarningAtom, { run_id: 'r1', type: 'output_limit', message: CUT_OFF });
        const before = store.get(runWarningsForDisplayAtom);
        // Same runs, new objects: what a streamed part does to the run list.
        store.set(threadRunsAtom, [{ id: 'r1', model_messages: [{ parts: [] }] }] as any);
        expect(store.get(runWarningsForDisplayAtom)).toBe(before);
    });
});
