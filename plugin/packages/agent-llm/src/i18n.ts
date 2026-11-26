/**
 * Interface text produced by the model layer: key checks, setup and run
 * errors, run warnings, indexing status.
 *
 * Written in English and passed through `t`, with `{name}` placeholders for
 * the parts that vary. A client registers its translator with
 * `setTranslator`; without one, `t` fills the placeholders and keeps the
 * English. Text the model reads never goes through here.
 */
export type TranslationVars = Record<string, string | number>;

export interface Translator {
    /** Interface text in the client's language. */
    t(source: string, vars?: TranslationVars): string;
    /** Whole sentences one after another, run together the way the client's language does it. */
    joinSentences(sentences: string[]): string;
}

/** The English of a source: an "@@context" suffix only tells translators which meaning is meant. */
function englishOf(source: string): string {
    const at = source.indexOf('@@');
    return at < 0 ? source : source.slice(0, at);
}

const english: Translator = {
    t: (source, vars) =>
        !vars
            ? englishOf(source)
            : englishOf(source).replace(/\{(\w+)\}/g, (whole, name: string) =>
                Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole),
    joinSentences: (sentences) => sentences.join(' '),
};

let translator: Translator = english;

/** Install the client's translator; `null` goes back to English. */
export function setTranslator(next: Translator | null): void {
    translator = next ?? english;
}

/**
 * Marks English kept in a constant and translated where it is shown
 * (`label: msg('High')` … `t(tier.label)`). Returns its argument; it exists
 * so the translation check can find the string.
 */
export function msg(source: string): string {
    return source;
}

/** Interface text in the client's language. `source` is the English, with `{name}` placeholders. */
export function t(source: string, vars?: TranslationVars): string {
    return translator.t(source, vars);
}

/** Whole sentences one after another; empty ones are skipped. */
export function joinSentences(sentences: Array<string | null | undefined | false>): string {
    return translator.joinSentences(
        sentences.filter((s): s is string => typeof s === 'string' && s.length > 0),
    );
}
