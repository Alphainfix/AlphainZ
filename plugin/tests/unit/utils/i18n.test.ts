import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    currentUiLanguage,
    englishOf,
    joinAlternatives,
    joinList,
    joinSentences,
    languageForLocale,
    msg,
    normalizeUiLanguageSetting,
    resolveUiLanguage,
    t,
    tn,
    translate,
} from '../../../src/utils/i18n';
import { ZH_CN } from '../../../src/i18n/zh-CN';

/** Sets the AlphainZ language preference and Zotero's own locale for one test. */
function useLanguage(setting: string, locale?: string) {
    vi.mocked(Zotero.Prefs.get).mockImplementation(
        ((key: string) => (key.endsWith('.uiLanguage') ? setting : undefined)) as any,
    );
    (Zotero as any).locale = locale;
}

afterEach(() => {
    vi.mocked(Zotero.Prefs.get).mockReset();
    vi.mocked(Zotero.Prefs.get).mockReturnValue(undefined);
    delete (Zotero as any).locale;
});

describe('choosing the interface language', () => {
    it('reads any Chinese Zotero locale as Chinese and everything else as English', () => {
        expect(languageForLocale('zh-CN')).toBe('zh-CN');
        expect(languageForLocale('zh-TW')).toBe('zh-CN');
        expect(languageForLocale('zh')).toBe('zh-CN');
        expect(languageForLocale('en-US')).toBe('en');
        expect(languageForLocale('fr')).toBe('en');
        expect(languageForLocale(undefined)).toBe('en');
    });

    it('keeps only the settings it knows, and treats anything else as "follow Zotero"', () => {
        expect(normalizeUiLanguageSetting('en')).toBe('en');
        expect(normalizeUiLanguageSetting('zh-CN')).toBe('zh-CN');
        expect(normalizeUiLanguageSetting('auto')).toBe('auto');
        expect(normalizeUiLanguageSetting('zh')).toBe('auto');
        expect(normalizeUiLanguageSetting(undefined)).toBe('auto');
    });

    it('lets an explicit choice win over Zotero’s locale', () => {
        expect(resolveUiLanguage('auto', 'zh-CN')).toBe('zh-CN');
        expect(resolveUiLanguage('auto', 'en-US')).toBe('en');
        expect(resolveUiLanguage('en', 'zh-CN')).toBe('en');
        expect(resolveUiLanguage('zh-CN', 'en-US')).toBe('zh-CN');
    });

    it('follows the stored preference and Zotero’s locale', () => {
        useLanguage('auto', 'zh-CN');
        expect(currentUiLanguage()).toBe('zh-CN');
        useLanguage('en', 'zh-CN');
        expect(currentUiLanguage()).toBe('en');
        useLanguage('zh-CN', 'en-US');
        expect(currentUiLanguage()).toBe('zh-CN');
        useLanguage('auto', 'en-US');
        expect(currentUiLanguage()).toBe('en');
    });
});

describe('translating a string', () => {
    it('shows the English, placeholders filled, when the interface is English', () => {
        expect(translate('Showing {shown} of {total} tags', 'en', { shown: 3, total: 10 }))
            .toBe('Showing 3 of 10 tags');
    });

    it('shows the Chinese entry when there is one', () => {
        expect(translate('Showing {shown} of {total} tags', 'zh-CN', { shown: 3, total: 10 }))
            .toBe(ZH_CN['Showing {shown} of {total} tags'].replace('{shown}', '3').replace('{total}', '10'));
    });

    it('falls back to the English for a string with no entry', () => {
        expect(translate('A sentence nobody translated, about {topic}', 'zh-CN', { topic: 'tags' }))
            .toBe('A sentence nobody translated, about tags');
    });

    it('leaves a placeholder it has no value for as it is', () => {
        expect(translate('Hello {name}', 'en', {})).toBe('Hello {name}');
    });

    it('spaces Latin letters and digits away from Chinese characters at a placeholder', () => {
        const key = "Some {kind} attachments can't be read";
        expect(ZH_CN[key]).toBe('部分{kind}附件无法读取');
        expect(translate(key, 'zh-CN', { kind: 'PDF' })).toBe('部分 PDF 附件无法读取');
        expect(translate(key, 'zh-CN', { kind: '扫描版 PDF' })).toBe('部分扫描版 PDF 附件无法读取');
        expect(translate(key, 'zh-CN', { kind: '网页链接' })).toBe('部分网页链接附件无法读取');
    });

    it('never shows a translation context in English', () => {
        expect(englishOf('Archive@@zotero field')).toBe('Archive');
        expect(translate('Archive@@zotero field', 'en')).toBe('Archive');
        expect(translate('Archive@@zotero field', 'zh-CN')).toBe('档案');
        expect(translate('Archive', 'zh-CN')).toBe('归档');
        expect(translate('Unknown thing@@some context', 'zh-CN')).toBe('Unknown thing');
    });

    it('marks a constant without translating it', () => {
        expect(msg('Show all steps')).toBe('Show all steps');
    });

    it('picks the singular or plural English and fills the count', () => {
        useLanguage('en');
        expect(tn(1, '{count} more chat', '{count} more chats')).toBe('1 more chat');
        expect(tn(4, '{count} more chat', '{count} more chats')).toBe('4 more chats');
        useLanguage('zh-CN');
        expect(tn(4, '{count} more chat', '{count} more chats')).toBe('另外 4 个对话');
    });

    it('uses the language in effect when it is called', () => {
        useLanguage('en');
        expect(t('Start a new chat')).toBe('Start a new chat');
        useLanguage('zh-CN');
        expect(t('Start a new chat')).toBe('开始新对话');
    });
});

describe('joining words and sentences', () => {
    it('joins lists the English way', () => {
        useLanguage('en');
        expect(joinList(['a'])).toBe('a');
        expect(joinList(['a', 'b'])).toBe('a and b');
        expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
        expect(joinAlternatives(['a', 'b'])).toBe('a or b');
        expect(joinAlternatives(['a', 'b', 'c'])).toBe('a, b, or c');
        expect(joinSentences(['One.', null, 'Two.'])).toBe('One. Two.');
    });

    it('joins lists the Chinese way', () => {
        useLanguage('zh-CN');
        expect(joinList(['甲', '乙', '丙'])).toBe('甲、乙和丙');
        expect(joinAlternatives(['甲', '乙', '丙'])).toBe('甲、乙或丙');
        expect(joinSentences(['第一句。', undefined, '第二句。'])).toBe('第一句。第二句。');
    });
});
