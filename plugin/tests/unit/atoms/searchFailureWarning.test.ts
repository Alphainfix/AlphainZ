/**
 * "Topic search could not run" — the provider is configured but its requests
 * fail (a revoked key, a spent day). The user is told once per chat: on the
 * first answer that hit it, and not again on later answers of that chat,
 * whatever reason they give and whether or not the first was dismissed.
 */
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    addWarningAtom,
    clearWarningsAtom,
    dismissWarningAtom,
    runWarningsForDisplayAtom,
    selectRunWarnings,
    threadWarningsAtom,
    warningTone,
    type RunWarning,
} from '../../../react/atoms/warnings';

const KEY = 'Topic search could not run: Google Gemini rejected the API key (403). Check it under Settings → Model.';
const DAY = 'Topic search could not run: Google Gemini has used up today’s embedding allowance.';

let nextId = 0;
const warning = (run_id: string, message: string): RunWarning => ({
    id: `w${nextId++}`,
    run_id,
    type: 'semantic_search_failed',
    message,
    created_at: '2026-10-23T12:00:00.000Z',
});

describe('the topic-search failure warning', () => {
    it('is a warning, not a quiet notice', () => {
        expect(warningTone('semantic_search_failed')).toBe('warning');
    });

    it('shows on the first answer that hit it and on no later one, even with another reason', () => {
        const shown = selectRunWarnings(['r1', 'r2', 'r3'], [warning('r1', KEY), warning('r2', KEY), warning('r3', DAY)], new Set());
        expect(shown.r1?.map((w) => w.message)).toEqual([KEY]);
        expect(shown.r2).toBeUndefined();
        expect(shown.r3).toBeUndefined();
    });

    it('stays away for the rest of the chat once dismissed', () => {
        const store = createStore();
        store.set(threadRunsAtom, [{ id: 'r1' }, { id: 'r2' }] as any);
        store.set(addWarningAtom, { run_id: 'r1', type: 'semantic_search_failed', message: KEY });
        store.set(dismissWarningAtom, store.get(threadWarningsAtom)[0].id);
        store.set(addWarningAtom, { run_id: 'r2', type: 'semantic_search_failed', message: DAY });
        const shown = store.get(runWarningsForDisplayAtom);
        expect(shown.r1).toBeUndefined();
        expect(shown.r2).toBeUndefined();
    });

    it('comes back in a new chat', () => {
        const store = createStore();
        store.set(threadRunsAtom, [{ id: 'r1' }] as any);
        store.set(addWarningAtom, { run_id: 'r1', type: 'semantic_search_failed', message: KEY });
        store.set(dismissWarningAtom, store.get(threadWarningsAtom)[0].id);
        store.set(clearWarningsAtom);
        store.set(threadRunsAtom, [{ id: 'n1' }] as any);
        store.set(addWarningAtom, { run_id: 'n1', type: 'semantic_search_failed', message: KEY });
        expect(store.get(runWarningsForDisplayAtom).n1?.map((w) => w.message)).toEqual([KEY]);
    });
});
