import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import config from '../../package.json';
import { currentUiLanguage } from '../../src/utils/i18n';
import { uiLanguageAtom } from '../atoms/uiLanguage';

/**
 * Follow the language preference wherever it changes: the settings page, the
 * welcome wizard, another window, or settings taken from another computer.
 */
export function useUiLanguageObserver(): void {
    const setLanguage = useSetAtom(uiLanguageAtom);

    useEffect(() => {
        setLanguage(currentUiLanguage());
        let symbol: symbol | undefined;
        try {
            symbol = Zotero.Prefs.registerObserver(
                `${config.config.prefsPrefix}.uiLanguage`,
                () => setLanguage(currentUiLanguage()),
                true, // global pref name
            );
        } catch (e) {
            Zotero.debug(`AlphainZ: could not observe the interface language: ${e}`);
        }
        return () => {
            if (symbol === undefined) return;
            try { Zotero.Prefs.unregisterObserver(symbol); } catch { /* already gone */ }
        };
    }, [setLanguage]);
}
