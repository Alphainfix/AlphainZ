/**
 * What the question rail and the outline say about each question.
 *
 * One mark or row per question the user asked; the start of the answer as
 * plain text (no markdown, no citation tags, a table named rather than
 * flattened); and a stand-in while the answer is being written or after it
 * failed.
 */
import { describe, expect, it } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import {
    TABLE_LABEL,
    answerSnippet,
    buildConversationTurns,
    filterTurns,
    formatTurnTime,
    highlightSegments,
    nearestCentreIndex,
    plainAnswerText,
    questionCountLabel,
    sameTurns,
    turnMeta,
} from '../../../react/utils/conversationTurns';

function makeRun(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: `What does paper ${id} conclude?` },
        status: 'completed',
        model_messages: [],
        created_at: '2026-10-09T14:32:00',
        consent_to_share: false,
        model_name: 'test-model',
        ...overrides,
    } as AgentRun;
}

const response = (...parts: Array<Record<string, unknown>>) => ({ kind: 'response', run_id: 'r', parts }) as any;
const text = (content: string) => ({ part_kind: 'text', content });
const toolCall = (toolName: string, id = toolName) => ({ part_kind: 'tool-call', tool_name: toolName, tool_call_id: id, args: {} });

describe('the questions of a conversation', () => {
    it('gives each question one turn, with its number and its time', () => {
        const turns = buildConversationTurns([makeRun('a'), makeRun('b'), makeRun('c')]);
        expect(turns.map((turn) => [turn.index, turn.runId])).toEqual([[0, 'a'], [1, 'b'], [2, 'c']]);
        expect(turns[1].question).toBe('What does paper b conclude?');
        expect(turns[1].createdAt).toBe('2026-10-09T14:32:00');
    });

    it('reads a continued answer as part of the question it continues', () => {
        const failed = makeRun('a', {
            status: 'error',
            error: { type: 'llm_network_error', message: 'The connection dropped.' },
            model_messages: [response(text('The first half'))],
        });
        const continuation = makeRun('a2', {
            user_prompt: { content: '', is_resume: true, resumes_run_id: 'a' },
            model_messages: [response(text('and the second half.'))],
        });
        const turns = buildConversationTurns([failed, continuation, makeRun('b')]);
        expect(turns).toHaveLength(2);
        expect(turns[0].runId).toBe('a');
        expect(turns[0].status).toBe('done');
        expect(turns[0].answer).toBe('The first half and the second half.');
        expect(turns[1].index).toBe(1);
    });

    it('writes the question on one line, with the actions it ran', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            user_prompt: {
                content: 'Compare   these\n\ntwo',
                actions: [{ action_id: 'x', command: 'summarize', title: 'Summarize' }],
            } as any,
        })]);
        expect(turn.question).toBe('/summarize Compare these two');
    });

    it('names a question that is only attachments', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            user_prompt: { content: '', attachments: [{}, {}] } as any,
        })]);
        expect(turn.question).toBe('2 attachments');
    });
});

describe('the start of the answer', () => {
    it('is plain text: no markdown and no citation tags', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            model_messages: [response(text(
                '## Encapsulation\n\nThe **ALD stack** extends T80 to 1500 h <citation att_id="1-ABC" sid="s12"/>.\n\n- moisture is the main path',
            ))],
        })]);
        expect(turn.answer).toBe('Encapsulation The ALD stack extends T80 to 1500 h. moisture is the main path');
        expect(turn.answer).not.toMatch(/[#*<>]/);
    });

    it('names a table instead of flattening its cells', () => {
        const markdown = 'Read off figure 3b:\n\n| time | bare | stack |\n| --- | --- | --- |\n| 0 h | 100% | 100% |\n| 200 h | 41% | 98% |\n\nThe stack holds.';
        expect(plainAnswerText(markdown)).toBe(`Read off figure 3b: ${TABLE_LABEL} The stack holds.`);
        // A thematic break is not a table.
        expect(plainAnswerText('one\n\n---\n\ntwo')).toBe('one --- two');
    });

    it('writes formulas as characters, not LaTeX', () => {
        expect(plainAnswerText('The model maps $\\langle x\\rangle\\leftrightarrow\\langle y\\rangle$ in ${}^{14}\\mathrm{C}^0$.'))
            .toBe('The model maps ⟨x⟩ ↔ ⟨y⟩ in ¹⁴C⁰.');
        // The markdown stripping leaves the formula alone: x₂* keeps its asterisk.
        expect(plainAnswerText('**Latency**: $x_2^*$ is 2 µs, $$x_2 = \\frac{1}{\\gamma}$$')).toBe('Latency: x₂* is 2 µs, x₂ = 1/γ');
        // Prices are not formulas.
        expect(plainAnswerText('It costs $5 and $10.')).toBe('It costs $5 and $10.');
    });

    it('writes formulas in the question as characters too', () => {
        const [turn] = buildConversationTurns([makeRun('a', { user_prompt: { content: 'Why is $x_2^*$ shorter than\n$x_2$?' } } as Partial<AgentRun>)]);
        expect(turn.question).toBe('Why is x₂* shorter than x₂?');
    });

    it('names the library changes the answer proposed', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            model_messages: [response(
                text('Two passages carry the argument.'),
                toolCall('create_highlight', 'h1'),
                toolCall('create_highlight', 'h2'),
            )],
        })]);
        expect(turn.answer).toBe('Two passages carry the argument. (2 library changes)');
    });

    it('is the answer after the last tool call, not the narration before it', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            model_messages: [
                response(text('Let me look at pages 4 and 7.'), toolCall('read_pages')),
                response(text('The limit is the tunnel lining.')),
            ],
        })]);
        expect(turn.answer).toBe('The limit is the tunnel lining.');
    });

    it('says the answer is being written while the run works', () => {
        const turns = buildConversationTurns([
            makeRun('a', { status: 'in_progress', model_messages: [response(text('Partial'))] }),
            makeRun('b', { status: 'awaiting_deferred' }),
        ]);
        expect(turns.map((turn) => [turn.status, turn.answer])).toEqual([
            ['answering', 'Answering…'],
            ['waiting', 'Waiting for your approval…'],
        ]);
    });

    it('is one short line for a failed run', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            status: 'error',
            error: { type: 'llm_rate_limit', message: 'llm_rate_limit: The provider is rate limiting this key. Wait a minute and retry.' },
            model_messages: [response(text('Half an answer'))],
        })]);
        expect(turn.status).toBe('failed');
        expect(turn.answer).toBe('Failed: The provider is rate limiting this key.');
    });

    it('falls back to the error title when a failure has no message', () => {
        const [turn] = buildConversationTurns([makeRun('a', { status: 'error', error: { type: 'llm_rate_limit', message: '' } })]);
        expect(turn.answer).toBe('Failed: Rate Limit Exceeded');
    });

    it('says when a run was stopped before it answered', () => {
        const [stopped, cutOff] = buildConversationTurns([
            makeRun('a', { status: 'canceled', error: { type: 'run_cancelled', message: '', reason_code: 'client_cancel' } }),
            makeRun('b', { status: 'canceled', error: { type: 'run_cancelled', message: '', reason_code: 'connection_lost' } }),
        ]);
        expect(stopped.answer).toBe('Stopped before it answered.');
        expect(cutOff.answer).toBe('Cut off before it answered.');
    });
});

describe('citations', () => {
    it('counts the resolved citations a run carries, leaving out invalid ones', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            metadata: { citations: [{ citation_id: '1' }, { citation_id: '2' }, { citation_id: '3', invalid: true }] } as any,
            model_messages: [response(text('x <citation a="1"/> y <citation a="2"/> z <citation a="3"/>'))],
        })]);
        expect(turn.citations).toBe(2);
    });

    it('counts the tags in the answer when the run carries none', () => {
        const [turn] = buildConversationTurns([makeRun('a', {
            model_messages: [response(text('x <citation a="1"/> y <citation a="2" />'))],
        })]);
        expect(turn.citations).toBe(2);
        expect(turnMeta(turn, new Date('2026-10-09T18:00:00'))).toBe('14:32 · 2 citations');
    });
});

describe('streaming', () => {
    it('draws the same turns for every token of a run still being written', () => {
        const done = makeRun('a', { model_messages: [response(text('Done.'))] });
        const before = buildConversationTurns([done, makeRun('b', { status: 'in_progress', model_messages: [response(text('Hal'))] })]);
        const after = buildConversationTurns([done, makeRun('b', { status: 'in_progress', model_messages: [response(text('Halfway there'))] })]);
        expect(sameTurns(before, after)).toBe(true);
        const finished = buildConversationTurns([done, makeRun('b', { model_messages: [response(text('Finished.'))] })]);
        expect(sameTurns(after, finished)).toBe(false);
    });
});

describe('times', () => {
    const now = new Date('2026-10-09T18:00:00');

    it('shows the time alone for today, and the day before it otherwise', () => {
        expect(formatTurnTime('2026-10-09T14:32:00', now)).toBe('14:32');
        expect(formatTurnTime('2026-10-03T09:05:00', now)).toBe('Oct 3 09:05');
        expect(formatTurnTime('2025-10-03T09:05:00', now)).toBe('Oct 3, 2025 09:05');
        expect(formatTurnTime('not a date', now)).toBe('');
    });

    it('counts questions in words', () => {
        expect(questionCountLabel(1)).toBe('1 question');
        expect(questionCountLabel(8)).toBe('8 questions');
    });
});

describe('filtering the outline', () => {
    const turns = buildConversationTurns([
        makeRun('a', {
            user_prompt: { content: 'What is the T80 lifetime?' },
            model_messages: [response(text('T80 is the time until efficiency falls to 80 percent of its initial value under damp heat.'))],
        }),
        makeRun('b', {
            user_prompt: { content: 'Which encapsulation did they use?' },
            model_messages: [response(text('A stack deposited directly on the cell, with no glue seam: the ALD layer blocks water.'))],
        }),
    ]);

    it('keeps questions whose question or answer contains the words, ignoring case', () => {
        expect(filterTurns(turns, '').map((turn) => turn.runId)).toEqual(['a', 'b']);
        expect(filterTurns(turns, 'encapsulation').map((turn) => turn.runId)).toEqual(['b']);
        expect(filterTurns(turns, '  ald LAYER ').map((turn) => turn.runId)).toEqual(['b']);
        expect(filterTurns(turns, 'nothing like this')).toEqual([]);
    });

    it('marks every match', () => {
        expect(highlightSegments('T80 and t80', 't80')).toEqual([
            { text: 'T80', match: true },
            { text: ' and ', match: false },
            { text: 't80', match: true },
        ]);
        expect(highlightSegments('no match', 'zzz')).toEqual([{ text: 'no match', match: false }]);
        expect(highlightSegments('anything', '')).toEqual([{ text: 'anything', match: false }]);
    });

    it('moves the answer snippet to the match when only the answer matches', () => {
        const snippet = answerSnippet(turns[1], 'water');
        expect(snippet.startsWith('…')).toBe(true);
        expect(snippet).toContain('water');
        // When the question matches, the answer starts at its beginning.
        expect(answerSnippet(turns[1], 'encapsulation').startsWith('A stack')).toBe(true);
    });
});

describe('the nearest mark', () => {
    const centres = [108, 124, 140];

    it('is the one whose centre is closest to the pointer', () => {
        expect(nearestCentreIndex(centres, 117)).toBe(1);
        expect(nearestCentreIndex(centres, 114)).toBe(0);
        expect(nearestCentreIndex(centres, 133)).toBe(2);
    });

    it('is the earlier one exactly between two', () => {
        expect(nearestCentreIndex(centres, 116)).toBe(0);
    });

    it('is the end mark beyond either end, and none without marks', () => {
        expect(nearestCentreIndex(centres, -50)).toBe(0);
        expect(nearestCentreIndex(centres, 900)).toBe(2);
        expect(nearestCentreIndex([], 10)).toBe(-1);
    });
});
