import React from 'react';

/**
 * Interface text for the shared components.
 *
 * Shared components are written in English and pass each user-visible string
 * through `t`, with `{name}` placeholders for the parts that vary. The client
 * registers the translator it uses everywhere else with `setTranslator`;
 * without one, `t` fills the placeholders and keeps the English.
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
 * (`label: msg('Copy')` … `t(action.label)`). Returns its argument; it exists
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

/**
 * A translated sentence with elements in it, such as a link or a bold word:
 * `tr('Searching {source} for {query}', { source: <b>…</b>, query })`. The
 * translation decides where each `{name}` goes, so the word order can differ
 * between languages.
 */
export function tr(source: string, parts: Record<string, React.ReactNode>): React.ReactNode {
    const template = t(source);
    const pieces: React.ReactNode[] = [];
    const pattern = /\{(\w+)\}/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(template))) {
        if (match.index > last) pieces.push(template.slice(last, match.index));
        const name = match[1];
        pieces.push(Object.prototype.hasOwnProperty.call(parts, name) ? parts[name] : match[0]);
        last = match.index + match[0].length;
    }
    if (last < template.length) pieces.push(template.slice(last));
    return React.createElement(React.Fragment, null, ...pieces);
}
