/**
 * Interface text produced by the core: tool-call labels, run status and error
 * copy.
 *
 * Written in English and passed through `t`, with `{name}` placeholders for
 * the parts that vary. A client registers its translator with
 * `setTranslator`; without one, `t` fills the placeholders and keeps the
 * English. Text the model reads never goes through here.
 */
export type TranslationVars = Record<string, string | number>;
export type Translator = (source: string, vars?: TranslationVars) => string;

/** The English of a source: an "@@context" suffix only tells translators which meaning is meant. */
const englishOf = (source: string): string => {
    const at = source.indexOf('@@');
    return at < 0 ? source : source.slice(0, at);
};

const fillPlaceholders: Translator = (source, vars) =>
    !vars
        ? englishOf(source)
        : englishOf(source).replace(/\{(\w+)\}/g, (whole, name: string) =>
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);

let translator: Translator = fillPlaceholders;

/** Install the client's translator; `null` goes back to English. */
export function setTranslator(next: Translator | null): void {
    translator = next ?? fillPlaceholders;
}

/**
 * Marks English kept in a constant and translated where it is shown
 * (`label: msg('Read')` … `t(entry.label)`). Returns its argument; it exists
 * so the translation check can find the string.
 */
export function msg(source: string): string {
    return source;
}

/** Interface text in the client's language. `source` is the English, with `{name}` placeholders. */
export function t(source: string, vars?: TranslationVars): string {
    return translator(source, vars);
}

/** A count in a sentence: the singular or the plural source, with `{count}` filled. */
export function tn(count: number, singular: string, plural: string, vars?: TranslationVars): string {
    return t(count === 1 ? singular : plural, { count, ...vars });
}
