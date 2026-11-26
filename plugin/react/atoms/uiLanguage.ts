import { atom } from 'jotai';
import { setPref } from '../../src/utils/prefs';
import {
    currentUiLanguage,
    normalizeUiLanguageSetting,
    type UiLanguage,
    type UiLanguageSetting,
} from '../../src/utils/i18n';

/**
 * The interface language in effect. LanguageBoundary keys the panes on it, so
 * a change remounts them in the new language. Kept in step with the
 * preference by useUiLanguageObserver, which also hears changes that arrive
 * from settings sync or another window.
 */
export const uiLanguageAtom = atom<UiLanguage>(currentUiLanguage());

/** Store a language choice ("auto", "en" or "zh-CN") and switch to it at once. */
export const chooseUiLanguageAtom = atom(null, (_get, set, setting: UiLanguageSetting) => {
    setPref('uiLanguage', normalizeUiLanguageSetting(setting));
    set(uiLanguageAtom, currentUiLanguage());
});
