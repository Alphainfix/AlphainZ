// @vitest-environment jsdom
/**
 * Text about long chats says what will happen, not how it is built.
 *
 * The compaction card and Settings → Advanced were written as implementation
 * notes: the summary "stands in on the wire", discarding it "restores the plain
 * replay window", compaction keeps threads "light on the wire", "uncompacted
 * history is invisible to the model", and a rule named after a default the
 * setting no longer has. For a reader in a second language none of that says
 * what Discard or the setting will do. These check the plain wording stays,
 * and that it is true: discarding brings back the last 10 exchanges rather
 * than the whole chat in full, and the marker does not say the model reads a
 * summary while compaction is off and no request carries it.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../../package.json';

vi.mock('../../../react/utils/syncModeSwitch', async (importOriginal) => {
    const real = await importOriginal<any>();
    return { ...real, joinSyncBackend: vi.fn(async () => ({ adoptedSettings: false, exported: null })) };
});

const PREFIX = pkg.config.prefsPrefix;
let prefs: Record<string, unknown> = {};

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs = {};
    (Zotero.Prefs.get as any).mockImplementation((key: string) => prefs[key]);
    document.body.innerHTML = '';
    vi.resetModules();
});

async function render(element: React.ReactElement): Promise<HTMLDivElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(element); });
    await act(async () => { await Promise.resolve(); });
    return host;
}

/** Wording that describes the plumbing rather than the result. */
const SHORTHAND = [
    /on the wire/i,
    /replay/i,
    /invisible to the model/i,
    /uncompacted/i,
    /rides along/i,
    /8-turn/i,
    /stands in/i,
    /rock-solid/i,
    /Obsidian/i,
];

describe('the compaction card', () => {
    it('says what the summary does and what discarding it costs', async () => {
        const { CompactionSummaryCard } = await import('../../../react/components/agentRuns/ContextCompressionIndicator');
        const host = await render(React.createElement(CompactionSummaryCard, {
            summary: 'Topic: honeybee navigation in meadows.',
            runCount: 7,
            onDismiss: () => {},
            onDiscard: async () => {},
        }));
        const text = host.textContent ?? '';
        for (const pattern of SHORTHAND) expect(text).not.toMatch(pattern);
        expect(text).toContain('The model reads this summary instead of those 7 earlier exchanges');
        expect(text).toContain('They stay here in full');
        expect(text).toContain('which costs more');
        expect(text).toContain('Discard summary');
    });

    it('says discarding brings back the last 10 exchanges, not the whole chat in full', async () => {
        const { CompactionSummaryCard } = await import('../../../react/components/agentRuns/ContextCompressionIndicator');
        const host = await render(React.createElement(CompactionSummaryCard, {
            summary: 'Topic: honeybee navigation in meadows.',
            runCount: 7,
            onDismiss: () => {},
            onDiscard: async () => {},
        }));
        const text = host.textContent ?? '';
        expect(text).toContain('the model is sent your last 10 exchanges instead of the summary (older ones are left out)');
        expect(text).not.toMatch(/in full again/i);
    });

    it('speaks of a single exchange in the singular', async () => {
        const { CompactionSummaryCard } = await import('../../../react/components/agentRuns/ContextCompressionIndicator');
        const host = await render(React.createElement(CompactionSummaryCard, {
            summary: 'Topic: honeybee navigation in meadows.',
            runCount: 1,
            onDismiss: () => {},
            onDiscard: async () => {},
        }));
        expect(host.textContent).toContain('instead of that earlier exchange. It stays here in full');
    });

    it('says the summary is not sent while automatic compaction is off', async () => {
        const { CompactionSummaryCard } = await import('../../../react/components/agentRuns/ContextCompressionIndicator');
        const host = await render(React.createElement(CompactionSummaryCard, {
            summary: 'Topic: honeybee navigation in meadows.',
            runCount: 7,
            inUse: false,
            onDismiss: () => {},
            onDiscard: async () => {},
        }));
        const text = host.textContent ?? '';
        for (const pattern of SHORTHAND) expect(text).not.toMatch(pattern);
        expect(text).toContain('Automatic compaction is off in Settings → Advanced, so the model is not sent this summary');
        expect(text).not.toContain('The model reads this summary');
        expect(text).toContain('Discard summary');
    });
});

describe('the compaction marker in the chat', () => {
    async function mountMarker(compactionOn: boolean) {
        prefs[`${PREFIX}.contextCompactionEnabled`] = compactionOn;
        const { store } = await import('../../../react/store');
        const { threadCompactionAtom } = await import('../../../react/atoms/threadCompaction');
        store.set(threadCompactionAtom, {
            summary: 'Topic: honeybee navigation in meadows.',
            throughRunId: 'run-12',
            createdAt: '2026-09-25T10:00:00.000Z',
            runCount: 12,
        } as any);
        const { CompactionMarker } = await import('../../../react/components/agentRuns/ContextCompressionIndicator');
        const { Provider } = await import('jotai');
        return render(React.createElement(Provider, { store }, React.createElement(CompactionMarker)));
    }

    it('says the model reads the summary while compaction is on', async () => {
        const host = await mountMarker(true);
        expect(host.textContent).toContain('12 earlier exchanges compacted — the model reads a summary of them instead');
    });

    it('does not claim the model reads the summary while compaction is off', async () => {
        const host = await mountMarker(false);
        expect(host.textContent).toContain('12 earlier exchanges compacted — the summary is not used while automatic compaction is off');
        expect(host.textContent).not.toContain('the model reads a summary');
    });
});

describe('Settings → Advanced', () => {
    it('explains long-chat handling by its outcome', async () => {
        const { default: AdvancedSection } = await import('../../../react/components/preferences/AdvancedSection');
        const host = await render(React.createElement(AdvancedSection));
        const text = host.textContent ?? '';
        for (const pattern of SHORTHAND) expect(text).not.toMatch(pattern);
        expect(text).toContain('so a long chat costs more and answers more slowly');
        expect(text).toContain('the model reads the summary instead of them');
        expect(text).toContain('Without a summary the model is sent only the last 10 exchanges and sees nothing older');
    });

    it('says trimming spares the questions and answers it sends, without promising the whole chat', async () => {
        const { default: AdvancedSection } = await import('../../../react/components/preferences/AdvancedSection');
        const host = await render(React.createElement(AdvancedSection));
        const text = host.textContent ?? '';
        expect(text).toContain('Your questions and the answers in those exchanges are not shortened');
        expect(text).not.toMatch(/always sent in full/i);
        expect(text).not.toMatch(/sent the last 10 in full/i);
    });
});

/*
 * The copy above names numbers the message builder decides: 10 exchanges
 * without a summary, and full tool detail for the last two when trimming is
 * on (what executeLocalRun asks for). If the builder changes, so must the copy.
 */
describe('what the copy promises is what a request carries', () => {
    const exchange = (n: number, toolResult = 'short result') => ({
        id: `run-${n}`,
        thread_id: 'thread-1',
        status: 'completed',
        user_prompt: { content: `Question ${n}` },
        model_messages: [
            {
                kind: 'response',
                parts: [{ part_kind: 'tool-call', tool_call_id: `call-${n}`, tool_name: 'read_document', args: { item: n } }],
            },
            {
                kind: 'request',
                parts: [{ part_kind: 'tool-return', tool_call_id: `call-${n}`, tool_name: 'read_document', content: toolResult }],
            },
            { kind: 'response', parts: [{ part_kind: 'text', content: `Answer ${n}` }] },
        ],
    });

    it('sends the last 10 exchanges when there is no summary, and nothing older', async () => {
        const { buildRunMessages } = await import('../../../src/services/llm/runRequestToMessages');
        const messages = buildRunMessages({
            priorRuns: Array.from({ length: 12 }, (_, i) => exchange(i + 1)) as any,
            prompt: { content: 'Question 13' },
            systemPrompt: 'system',
        });
        const questions = messages.filter((m) => m.role === 'user').map((m) => m.content);
        expect(questions).toEqual([...Array.from({ length: 10 }, (_, i) => `Question ${i + 3}`), 'Question 13']);
    });

    it('shortens only tool detail, and only in exchanges older than the last two', async () => {
        const { buildRunMessages } = await import('../../../src/services/llm/runRequestToMessages');
        const long = 'x'.repeat(5_000);
        const messages = buildRunMessages({
            priorRuns: [1, 2, 3].map((n) => exchange(n, long)) as any,
            prompt: { content: 'Question 4' },
            systemPrompt: 'system',
            keepToolDetailRuns: 2,
        });
        const toolResults = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
        expect(toolResults[0].length).toBeLessThan(long.length);
        expect(toolResults.slice(1)).toEqual([long, long]);
        const prose = messages.filter((m) => m.role !== 'tool').map((m) => m.content);
        expect(prose).toEqual(expect.arrayContaining(['Question 1', 'Answer 1', 'Question 2', 'Answer 2']));
    });
});
