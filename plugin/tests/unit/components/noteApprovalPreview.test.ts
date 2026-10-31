/**
 * You should be able to see a note before you approve it.
 *
 * The card summarised `create_note` with `args.title` alone, and the model
 * often supplies none — so it asked the user to put a note into their library
 * while showing them nothing of what it said. A highlight card has always
 * shown its passage.
 */
import { describe, expect, it } from 'vitest';

import { summarizeArgs } from '../../../react/components/agentRuns/GenericAgentActionView';

const note = (args: Record<string, unknown>) => summarizeArgs('create_note', args);

describe('what a note approval card says', () => {
    it('shows the body when there is no title', () => {
        expect(note({ content: '<p>Tm = 30.5 °C，由 PCR 初始曲线标定。</p>' }))
            .toBe('Tm = 30.5 °C，由 PCR 初始曲线标定。');
    });

    it('shows title and body together when both are there', () => {
        expect(note({ title: '要点', content: '<p>三条结论</p>' })).toBe('要点 — 三条结论');
    });

    it('strips the HTML a Zotero note is made of', () => {
        const html = '<div class="zotero-note"><p>First point</p><p>Second point</p></div>';
        expect(note({ content: html })).toBe('First point Second point');
    });

    it('brings entities back rather than showing them raw', () => {
        expect(note({ content: '<p>a &amp; b &lt;tag&gt; &nbsp;c</p>' })).toBe('a & b <tag> c');
    });

    it('clips a long note rather than filling the card', () => {
        const summary = note({ content: '<p>' + '很长的内容'.repeat(60) + '</p>' }) as string;
        expect(summary.length).toBeLessThanOrEqual(90);
        expect(summary.endsWith('…')).toBe(true);
    });

    it('says nothing when there is genuinely nothing', () => {
        expect(note({})).toBeNull();
        expect(note({ content: '<p></p>' })).toBeNull();
    });
});
