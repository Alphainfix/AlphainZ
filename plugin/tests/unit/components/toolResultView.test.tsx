// @vitest-environment jsdom
 

/**
 * A step's result, expanded. A run on this computer records each result as the
 * one-line summary written when the step finished, and a release build shows
 * that line — not "Tool results not available", which is all it used to show
 * for a step with no richer view (reading a document, searching inside one,
 * looking at a page).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { setHost } from '@beaver/agent-ui/host';
import { ToolResultView } from '../../../react/components/agentRuns/ToolResultView';

let root: Root | null = null;

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    setHost({});
});

function render(content: unknown, development: boolean): HTMLElement {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    setHost({ config: { isDevelopment: () => development } } as any);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const result = { part_kind: 'tool-return', tool_name: 'read_document', tool_call_id: 'c1', content, metadata: {} } as any;
    act(() => root!.render(<ToolResultView result={result} />));
    return host;
}

describe('an expanded step with no richer view', () => {
    it('shows the summary the step recorded', () => {
        const shown = render('pages 4 of 18', false);
        expect(shown.textContent).toBe('pages 4 of 18');
        expect(shown.textContent).not.toContain('not available');
    });

    it('keeps the passage a highlight marks, quotes and all', () => {
        const passage = 'p.6 · s245 · “Converting the zero field χ′(T) to 1/λ²(T)”';
        expect(render(passage, false).textContent).toBe(passage);
    });

    it('says so when there is nothing to show', () => {
        expect(render('', false).textContent).toBe('Tool results not available');
        expect(render({ raw: [1, 2, 3] }, false).textContent).toBe('Tool results not available');
    });

    it('shows a development build the raw content', () => {
        const shown = render({ raw: [1, 2, 3] }, true);
        expect(shown.querySelector('pre')?.textContent).toContain('"raw"');
    });
});
