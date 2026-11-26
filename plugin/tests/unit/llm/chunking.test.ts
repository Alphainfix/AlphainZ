/**
 * Splitting a document into searchable passages.
 *
 * Two things have to hold: a chunk must start somewhere a reader would start —
 * a fragment beginning mid-sentence embeds badly and matches nothing useful —
 * and every chunk must keep its page, because a full-text hit that cannot say
 * where to look is not an answer.
 */
import { describe, expect, it } from 'vitest';

import { chunkDocument, chunkText, cleanChunkForEmbedding } from '@beaver/agent-llm/chunking';

const sentences = (n: number, word = 'word') =>
    Array.from({ length: n }, (_, i) => `${word} ${i} sentence text here.`).join(' ');

describe('chunkText', () => {
    it('leaves a short page as one chunk', () => {
        expect(chunkText('A single short paragraph.')).toEqual(['A single short paragraph.']);
    });

    it('drops a fragment too short to mean anything', () => {
        // Page numbers and running heads extract as a few characters.
        expect(chunkText('7')).toEqual([]);
    });

    it('returns nothing for an empty page', () => {
        expect(chunkText('   \n\n  ')).toEqual([]);
    });

    it('splits a long page into several chunks', () => {
        const chunks = chunkText(sentences(200), { size: 500, overlap: 50 });
        expect(chunks.length).toBeGreaterThan(3);
        expect(chunks.every((c) => c.length <= 600)).toBe(true);
    });

    it('breaks at a paragraph boundary when one is near the target', () => {
        const text = `${'a'.repeat(400)}\n\n${'b'.repeat(400)}`;
        const chunks = chunkText(text, { size: 500, overlap: 0 });
        expect(chunks[0]).toBe('a'.repeat(400));
    });

    it('breaks after a sentence when no paragraph break is near', () => {
        const chunks = chunkText(sentences(60), { size: 400, overlap: 0 });
        // A chunk that begins mid-word embeds as noise. Each one after the first
        // starts at a word boundary, which is what the sentence break buys.
        for (const chunk of chunks.slice(1)) {
            expect(chunk).toBe(chunk.trim());
            expect(/^\w/.test(chunk)).toBe(true);
        }
    });

    it('overlaps consecutive chunks so a straddling claim still matches', () => {
        const chunks = chunkText(sentences(120), { size: 500, overlap: 100 });
        const firstTail = chunks[0].slice(-60);
        // Some of the first chunk's tail reappears at the start of the second.
        expect(chunks[1].slice(0, 160)).toContain(firstTail.split(' ').slice(-3).join(' '));
    });

    it('always advances, even when the overlap would stall the cursor', () => {
        // A pathological size/overlap pair must not loop for ever.
        const chunks = chunkText(sentences(50), { size: 200, overlap: 500 });
        expect(chunks.length).toBeGreaterThan(0);
        // Clamped, so the count stays proportional to the text rather than
        // exploding into near-duplicates.
        expect(chunks.length).toBeLessThan(20);
    });
});

describe('chunkDocument', () => {
    const document = {
        pages: [
            { index: 0, label: 'i', markdown: 'Front matter that is long enough to survive the floor.' },
            { index: 1, markdown: sentences(120) },
            { index: 2, markdown: '  ' },
        ],
    };

    it('keeps each chunk on its own page', () => {
        const chunks = chunkDocument(document, { size: 500, overlap: 50 });
        expect(chunks[0].pageIndex).toBe(0);
        expect(chunks.some((c) => c.pageIndex === 1)).toBe(true);
        // The blank page contributes nothing.
        expect(chunks.some((c) => c.pageIndex === 2)).toBe(false);
    });

    it('carries the printed page label when there is one', () => {
        const chunks = chunkDocument(document);
        expect(chunks[0].pageLabel).toBe('i');
        expect(chunks.find((c) => c.pageIndex === 1)).not.toHaveProperty('pageLabel');
    });

    it('survives a document with no pages', () => {
        expect(chunkDocument(null)).toEqual([]);
        expect(chunkDocument({})).toEqual([]);
    });
});

describe('cleanChunkForEmbedding', () => {
    it('strips heading markers and figure images', () => {
        expect(cleanChunkForEmbedding('## Results\n![fig](x.png)\nText.')).toBe('Results\n\nText.');
    });

    it('drops table rows', () => {
        expect(cleanChunkForEmbedding('| a | b |\nProse.')).toBe('Prose.');
    });

    it('leaves notation alone', () => {
        // These run over research papers; a general cleaner would eat the formulas.
        const formula = 'K2* = 1/(2π Δt) and V_max S_t K_m';
        expect(cleanChunkForEmbedding(formula)).toBe(formula);
    });
});

describe('chunkDocument over structured pages', () => {
    const sentence = (n: number, text: string) => ({ id: `s${n}`, text });
    const para = (text: string, ...sents: Array<{ id: string; text: string }>) => ({
        kind: 'text', text, sentences: sents,
    });

    it('records the sentence range each chunk covers', () => {
        const a = 'Sourdough starters are living cultures.';
        const b = 'They are stable at room temperature.';
        const chunks = chunkDocument({
            pages: [{ index: 0, items: [para(`${a} ${b}`, sentence(10, a), sentence(11, b))] }],
        });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].sentenceStart).toBe(10);
        expect(chunks[0].sentenceEnd).toBe(11);
    });

    it('splits ranges across chunks instead of blaming every sentence on each', () => {
        const items = Array.from({ length: 12 }, (_, i) => {
            const text = `Paragraph ${i} carries a full argument about bee navigation number ${i}.`;
            return para(text, sentence(100 + i, text));
        });
        const chunks = chunkDocument({ pages: [{ index: 0, items }] }, { size: 220, overlap: 20 });
        expect(chunks.length).toBeGreaterThan(2);
        expect(chunks[0].sentenceStart).toBe(100);
        const last = chunks[chunks.length - 1];
        expect(last.sentenceEnd).toBe(111);
        // A later chunk must not still claim the first sentence.
        expect(last.sentenceStart).toBeGreaterThan(100);
    });

    it('skips margins and pictures, keeps headers and formulas as text', () => {
        const chunks = chunkDocument({
            pages: [{
                index: 0,
                items: [
                    { kind: 'margin', text: 'ANIMAL BEHAVIOUR 104, 014409' },
                    { kind: 'section_header', text: 'Results and discussion here' },
                    { kind: 'picture' },
                    para('The measured flight distance doubles.', sentence(3, 'The measured flight distance doubles.')),
                ],
            }],
        });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).not.toContain('ANIMAL BEHAVIOUR');
        expect(chunks[0].text).toContain('Results and discussion');
        expect(chunks[0].sentenceStart).toBe(3);
        expect(chunks[0].sentenceEnd).toBe(3);
    });

    it('drops a sentence it cannot locate rather than guessing', () => {
        const text = 'Only this sentence is really present in the paragraph.';
        const chunks = chunkDocument({
            pages: [{
                index: 0,
                items: [para(text, sentence(7, 'A sentence the splitter never produced.'), sentence(8, text))],
            }],
        });
        expect(chunks[0].sentenceStart).toBe(8);
        expect(chunks[0].sentenceEnd).toBe(8);
    });

    it('leaves the range off when no sentence maps into the chunk', () => {
        const chunks = chunkDocument({
            pages: [{
                index: 0,
                items: [{ kind: 'section_header', text: 'A heading long enough to survive the minimum chunk floor' }],
            }],
        });
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).not.toHaveProperty('sentenceStart');
    });

    it('keeps markdown pages exactly as before — page only, no range', () => {
        const chunks = chunkDocument({
            pages: [{ index: 4, markdown: 'A plain markdown page with enough text to keep.' }],
        });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].pageIndex).toBe(4);
        expect(chunks[0]).not.toHaveProperty('sentenceStart');
    });
});
