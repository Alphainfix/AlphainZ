// @vitest-environment jsdom
/**
 * How a run's warnings look and where they sit.
 *
 * Every warning used to be the same grey box between the question and the
 * answer, with an unlabelled ×: "Topic search is off" above each answer looked
 * exactly like "the answer was cut off" and "could not apply that highlight".
 * Now a notice is a quiet line under the finished answer, a warning about the
 * answer has an orange mark, a change that failed reads as an error, the ×
 * says what it does, and a warning that names a setting opens it.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openPreferencesWindow = vi.fn();
vi.mock('../../../src/ui/openPreferencesWindow', () => ({
    openPreferencesWindow: (...args: unknown[]) => openPreferencesWindow(...args),
}));

const TOPIC_OFF = 'Topic search is off: the bge-m3 model is not installed in Ollama. Keyword and metadata search still work.';
const CUT_OFF = 'The answer was cut off at the 32k-token output limit. Ask it to continue, or raise "Output tokens per reply" in Settings → Advanced.';
const WRITE_FAILED = 'Could not apply that highlight: the PDF is not in your library.';
const ANSWER = 'Sourdough rises faster in a warm kitchen than a cool one.';

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    openPreferencesWindow.mockClear();
    document.body.innerHTML = '';
    vi.resetModules();
});

async function render(element: React.ReactElement) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(React.createElement(Provider, { store }, element));
    });
    return { host, store };
}

const warning = (type: string, message: string) => ({
    id: `${type}-1`,
    run_id: 'run-1',
    type,
    message,
    created_at: '2026-09-25T12:00:00.000Z',
});

async function mountWarning(type: string, message: string) {
    const { RunWarningDisplay } = await import('../../../react/components/agentRuns/RunWarningDisplay');
    return render(React.createElement(RunWarningDisplay, { warning: warning(type, message) }));
}

describe('RunWarningDisplay', () => {
    it('shows topic search being off as a quiet notice with a way to the setting', async () => {
        const { host } = await mountWarning('semantic_search_unavailable', TOPIC_OFF);
        expect(host.querySelector('[data-warning-tone="notice"]')).toBeTruthy();
        const open = host.querySelector<HTMLButtonElement>('[data-warning-action="open-settings"]')!;
        expect(open.textContent).toBe('Open Settings → Model');
        await act(async () => { open.click(); });
        expect(openPreferencesWindow).toHaveBeenCalledWith('models');
    });

    it('marks a warning about the answer differently from a notice', async () => {
        const { host } = await mountWarning('output_limit', CUT_OFF);
        expect(host.querySelector('[data-warning-tone="warning"]')).toBeTruthy();
        expect(host.querySelector('[data-warning-tone="notice"]')).toBeNull();
        await act(async () => {
            host.querySelector<HTMLButtonElement>('[data-warning-action="open-settings"]')!.click();
        });
        expect(openPreferencesWindow).toHaveBeenCalledWith('advanced');
    });

    it('shows a change that could not be applied as an error', async () => {
        const { host } = await mountWarning('write_failed', WRITE_FAILED);
        expect(host.querySelector('[data-warning-tone="error"]')).toBeTruthy();
        expect(host.querySelector('[data-warning-action="open-settings"]')).toBeNull();
    });

    it.each([
        ['semantic_search_unavailable', TOPIC_OFF],
        ['output_limit', CUT_OFF],
        ['write_failed', WRITE_FAILED],
    ])('gives the × on a %s warning a name a screen reader can announce', async (type, message) => {
        const { host } = await mountWarning(type, message);
        const buttons = [...host.querySelectorAll('button')];
        const dismiss = buttons.find((b) => !b.hasAttribute('data-warning-action'))!;
        expect(dismiss.getAttribute('aria-label')).toMatch(/dismiss|hide/i);
    });
});

describe('where a run shows its warnings', () => {
    const run = (status: string, extra: Record<string, unknown> = {}) => ({
        id: 'run-1',
        thread_id: 'th-1',
        status,
        user_prompt: { content: 'What is special about sourdough?' },
        model_messages: [{ kind: 'response', parts: [{ part_kind: 'text', content: ANSWER }] }],
        ...extra,
    });

    async function mountRun(runObject: any, warnings: Array<[string, string]>) {
        const { store } = await import('../../../react/store');
        const { threadRunsAtom } = await import('@beaver/agent-core/run-state/atoms');
        const { addWarningAtom } = await import('../../../react/atoms/warnings');
        store.set(threadRunsAtom, [runObject]);
        for (const [type, message] of warnings) {
            store.set(addWarningAtom, { run_id: runObject.id, type, message });
        }
        const { AgentRunView } = await import('../../../react/components/agentRuns/AgentRunView');
        return render(React.createElement(AgentRunView, { run: runObject, isLastRun: true }));
    }

    const follows = (earlier: Node, later: Node) =>
        Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

    function textNode(host: HTMLElement, needle: string): Node {
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent?.includes(needle)) return node;
        }
        throw new Error(`"${needle}" is not on screen`);
    }

    it('puts them under the answer, not between the question and the answer', async () => {
        const { host } = await mountRun(run('completed'), [
            ['semantic_search_unavailable', TOPIC_OFF],
            ['output_limit', CUT_OFF],
        ]);
        const answer = textNode(host, ANSWER);
        expect(follows(answer, textNode(host, 'Topic search is off'))).toBe(true);
        expect(follows(answer, textNode(host, 'The answer was cut off'))).toBe(true);
        // The one that needs something from the user comes first.
        expect(follows(textNode(host, 'The answer was cut off'), textNode(host, 'Topic search is off'))).toBe(true);
    });

    it('holds a notice back while the answer is still arriving', async () => {
        const { host } = await mountRun(run('in_progress'), [
            ['semantic_search_unavailable', TOPIC_OFF],
            ['write_failed', WRITE_FAILED],
        ]);
        expect(host.textContent).not.toContain('Topic search is off');
        expect(host.textContent).toContain('Could not apply that highlight');
    });

    it('shows one row of suggestions when the model offered them twice', async () => {
        const suggestions = (id: string, text: string) => ({
            part_kind: 'tool-call',
            tool_name: 'return_suggestions',
            tool_call_id: id,
            args: { suggestions: [{ text, query: text, goal: 'expand' }] },
        });
        const { host } = await mountRun(
            run('completed', {
                model_messages: [
                    { kind: 'response', parts: [suggestions('call-1', 'Compare with rye bread'), { part_kind: 'tool-call', tool_name: 'read', tool_call_id: 'call-2', args: {} }] },
                    { kind: 'response', parts: [{ part_kind: 'text', content: ANSWER }, suggestions('call-3', 'Find the original paper')] },
                ],
            }),
            [],
        );
        expect(host.textContent?.match(/Next steps/g)?.length).toBe(1);
        expect(host.textContent).toContain('Find the original paper');
        expect(host.textContent).not.toContain('Compare with rye bread');
    });
});
