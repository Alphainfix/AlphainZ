/**
 * The prompt has to name the language rule, or the answer drifts to English.
 *
 * The failure this guards is not the model ignoring a plain instruction — it is
 * the pull of the context. Every tool result is English (papers, titles,
 * extracted text) and so is the prompt itself, so by the time the model
 * generates, almost everything it has just read was English. Saying "match the
 * user" is not enough on its own; the prompt has to say that the sources'
 * language is not the answer's.
 */
import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from '../../../src/services/llm/systemPrompt';

describe('system prompt: language', () => {
    const prompt = buildSystemPrompt({});

    it('ties the answer to the user rather than to the prompt', () => {
        expect(prompt).toMatch(/language the user writes in/i);
    });

    it('says the latest message decides, so a switch is followed', () => {
        expect(prompt).toMatch(/latest message decides/i);
    });

    it('puts an explicit request above any standing default', () => {
        /*
         * A live run asked in plain English, ending "Answer in English", came
         * back in Chinese — because the user's standing instruction says to
         * default to Chinese, and it is appended after these rules, so it won.
         * A standing default is a preference; "answer in English" in the
         * message is not.
         */
        expect(prompt).toMatch(/wins over\s+everything else here and over any standing instruction/i);
    });

    it('names the English pull from tool results and overrides it', () => {
        // The whole point: without this the model reads a library of English
        // papers and answers in English regardless of what was asked.
        expect(prompt).toMatch(/language of the sources, not of\s+the answer/i);
    });

    it('protects quotations from being translated', () => {
        // A translated quote breaks the citation: clicking through lands on
        // words that do not match the answer.
        expect(prompt).toMatch(/quote/i);
        expect(prompt).toMatch(/citation and lands on words that do not match/i);
    });

    it('extends the rule to what gets written into the library', () => {
        expect(prompt).toMatch(/note or a highlight's\s+comment/i);
    });

    it('survives into the no-index variant', () => {
        // Selection answers share this prompt (their rule rides in the user
        // message), so a missing embedding index is the only other shape the
        // prompt can take.
        expect(buildSystemPrompt({ semanticSearchAvailable: false }))
            .toMatch(/language the user writes in/i);
    });
});

describe('system prompt: verifying claims', () => {
    const prompt = buildSystemPrompt({});

    it('extends grounding from the library to the science itself', () => {
        // A tool call before naming a paper was already required; the failure
        // this adds is a plausible wrong constant recalled from memory.
        expect(prompt).toMatch(/scaling law or an\s+attribution has to come from something you read this turn/i);
    });

    it('sends a claim about the field to the literature search', () => {
        expect(prompt).toMatch(/confirm it with\s+`search_web_literature` before you assert it/i);
    });

    it('keeps the attached paper the first place to look', () => {
        // Otherwise every question becomes a web search and the paper in front
        // of the user goes unread.
        expect(prompt).toMatch(/Do not go to the literature for something the paper in front of you\s+states/i);
        expect(prompt).toMatch(/Do not turn every question into a search/i);
    });

    it('asks it to name what it could not confirm', () => {
        expect(prompt).toMatch(/say which\s+part is unconfirmed/i);
    });

    it('bounds the checking, so verifying cannot eat the run', () => {
        // Measured: asked for a current record, a run spent 39 searches trying
        // to be exhaustive, hit the step limit and never wrote the answer.
        expect(prompt).toMatch(/One search, two if the first was badly phrased/i);
        expect(prompt).toMatch(/thirty-nine searches/i);
    });
});
