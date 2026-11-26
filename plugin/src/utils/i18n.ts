import { getPref } from "./prefs";
import { ZH_CN } from "../i18n/zh-CN";

/**
 * The interface language.
 *
 * Interface text is written in English and translated by lookup: `t("Send")`
 * returns the Chinese for "Send" when the interface is in Chinese and "Send"
 * otherwise, so a string that has no translation yet shows in English rather
 * than as a key. Text the model reads (system prompt, tool descriptions) does
 * not pass through here; the model answers in the language of the question.
 *
 * React-free, so both bundles can use it. The React bundle remounts its panes
 * when the language changes (see LanguageBoundary), which re-renders every
 * string that went through `t`.
 */
export type UiLanguage = "en" | "zh-CN";

/** The stored preference: a language, or "auto" to follow Zotero's own interface. */
export type UiLanguageSetting = "auto" | UiLanguage;

export type TranslationVars = Record<string, string | number>;

export function normalizeUiLanguageSetting(value: unknown): UiLanguageSetting {
  return value === "en" || value === "zh-CN" ? value : "auto";
}

/** What "Follow Zotero" means for a Zotero locale: Chinese for any Chinese locale, English otherwise. */
export function languageForLocale(locale: unknown): UiLanguage {
  return typeof locale === "string" && /^zh(\b|[-_])/i.test(locale) ? "zh-CN" : "en";
}

function zoteroLocale(): unknown {
  try {
    return (globalThis as any).Zotero?.locale;
  } catch {
    return undefined;
  }
}

export function resolveUiLanguage(setting: unknown, locale: unknown = zoteroLocale()): UiLanguage {
  const normalized = normalizeUiLanguageSetting(setting);
  return normalized === "auto" ? languageForLocale(locale) : normalized;
}

export function uiLanguageSetting(): UiLanguageSetting {
  try {
    return normalizeUiLanguageSetting(getPref("uiLanguage"));
  } catch {
    return "auto";
  }
}

export function currentUiLanguage(): UiLanguage {
  return resolveUiLanguage(uiLanguageSetting());
}

/** Replace each `{name}` with its value; a name without a value stays as written. */
export function fillPlaceholders(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

const HAN_OR_KANA = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

/**
 * `fillPlaceholders` for Chinese: where a value that starts or ends with a
 * Latin letter or digit meets a Chinese character, a space goes between them,
 * as in the rest of the Chinese text ("共{count}篇" → "共 3 篇",
 * "{kind}附件" → "PDF 附件", while "网页链接附件" stays as it is).
 */
function fillPlaceholdersSpaced(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string, offset: number) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
    let value = String(vars[name]);
    if (!value) return value;
    const before = template[offset - 1];
    const after = template[offset + whole.length];
    if (before && HAN_OR_KANA.test(before) && LATIN_OR_DIGIT.test(value[0])) value = ` ${value}`;
    if (after && HAN_OR_KANA.test(after) && LATIN_OR_DIGIT.test(value[value.length - 1])) value = `${value} `;
    return value;
  });
}

/**
 * The English a source string shows. A source may end in "@@context" when the
 * same English means different things in different places ("Archive" for the
 * chat archive, "Archive@@zotero field" for the item field): the context is
 * part of the lookup key and never shown.
 */
export function englishOf(source: string): string {
  const at = source.indexOf("@@");
  return at < 0 ? source : source.slice(0, at);
}

export function translate(source: string, language: UiLanguage, vars?: TranslationVars): string {
  const english = englishOf(source);
  if (language !== "zh-CN") return fillPlaceholders(english, vars);
  return fillPlaceholdersSpaced(ZH_CN[source] ?? english, vars);
}

/**
 * Marks English kept in a constant and translated where it is shown
 * (`label: msg("Light")` … `t(option.label)`). Returns its argument; it exists
 * so the translation check can find the string.
 */
export function msg(source: string): string {
  return source;
}

/** Interface text in the current language. `source` is the English, with `{name}` placeholders. */
export function t(source: string, vars?: TranslationVars): string {
  return translate(source, currentUiLanguage(), vars);
}

/**
 * A count in a sentence. English picks the singular or the plural source;
 * Chinese has one form, so both sources usually translate to the same text.
 * `{count}` is filled with `count`.
 */
export function tn(count: number, singular: string, plural: string, vars?: TranslationVars): string {
  return t(count === 1 ? singular : plural, { count, ...vars });
}

/** A list in the reader's language: "a, b and c" or "a、b 和 c". */
/** Whole sentences one after another: separated by a space in English, run together in Chinese. */
export function joinSentences(sentences: Array<string | null | undefined | false>): string {
  const parts = sentences.filter((s): s is string => typeof s === "string" && s.length > 0);
  return parts.join(currentUiLanguage() === "zh-CN" ? "" : " ");
}

/** "a or b" / "a, b, or c"; in Chinese "a或b" / "a、b或c". */
export function joinAlternatives(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (currentUiLanguage() === "zh-CN") {
    return `${items.slice(0, -1).join("、")}或${items[items.length - 1]}`;
  }
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (currentUiLanguage() === "zh-CN") {
    return `${items.slice(0, -1).join("、")}和${items[items.length - 1]}`;
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
