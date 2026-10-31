import { getPref } from '../../../src/utils/prefs';
import type { ConfigHost } from '@beaver/agent-ui/host/types';

/** Zotero implementation of {@link ConfigHost} — reads Beaver prefs. */
export const zoteroConfig: ConfigHost = {
    citationFormat() {
        return getPref('citationFormat') === 'numeric' ? 'numeric' : 'author-year';
    },
    usePageLabels() {
        return getPref('usePageLabels') !== false;
    },
    isDevelopment() {
        return Zotero.AlphainZ?.data?.env === 'development';
    },
    // No `docsUrl`: there is no hosted documentation site, so documentation
    // links render as plain text (see DocsLink) instead of pointing nowhere.
    composerEngine() {
        return getPref('composerEngine') === 'lexical' ? 'lexical' as const : 'textarea' as const;
    },
    isImeCompositionOrderFixEnabled() {
        // Kill-switch pref: anything but an explicit `false` (including an
        // unset pref) leaves the workaround on.
        return getPref('imeCompositionOrderFix') !== false;
    },
    isImeTracingEnabled() {
        return getPref('debugImeTrace') === true;
    },
};
