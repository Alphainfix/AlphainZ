/**
 * Zotero implementation of the platform runtime adapter.
 *
 * Routes `debug`, preference access, and version reporting through the
 * `Zotero` global. Reads `Zotero` only inside its methods (never at import
 * time), so importing this module is safe in any context.
 *
 * Unlike the other Zotero seams, this one is installed by `src/utils/prefs.ts`
 * rather than from a bundle entry — see the comment there.
 */

import { setRuntimeAdapterIfUnset, type RuntimeAdapter } from '@beaver/agent-core/platform/runtime';
import config from '../../package.json';

const PREFS_PREFIX = config.config.prefsPrefix;

/** The running Zotero's version, or an empty string when it reports none. */
function zoteroVersion(): string {
    if (typeof Zotero === 'undefined') return '';
    const { version } = Zotero;
    return version && typeof version === 'string' ? version : '';
}

const zoteroAdapter: RuntimeAdapter = {
    debug(message, level, maxDepth, stack) {
        Zotero.debug(message, level as any, maxDepth as any, stack as any);
    },
    isDevelopment() {
        // Optional all the way down: this runs inside `logger`, so a throw here
        // is raised from whatever was being logged and surfaces as a failure in
        // that code instead. The global is also an alias now (the plugin
        // renamed itself), which is one more way for it to be present but not
        // yet fully populated.
        return (Zotero as any).AlphainZ?.data?.env === "development";
    },
    getPref(key) {
        return Zotero.Prefs.get(key, true);
    },
    setPref(key, value) {
        Zotero.Prefs.set(key, value as any, true);
    },
    clearPref(key) {
        Zotero.Prefs.clear(key, true);
    },
    getPluginPref(key) {
        return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true);
    },
    setPluginPref(key, value) {
        Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value as any, true);
    },
    hostVersion() {
        return zoteroVersion();
    },
    getVersionHeaders() {
        const versionHeaders: Record<string, string> = {};

        const version = zoteroVersion();
        if (version) {
            versionHeaders['X-Zotero-Version'] = version;
        }

        const pluginVersion = typeof Zotero !== 'undefined' ? Zotero.AlphainZ?.pluginVersion : undefined;
        if (pluginVersion && typeof pluginVersion === 'string') {
            versionHeaders['X-Beaver-Version'] = pluginVersion;
        }

        return versionHeaders;
    },
};

/**
 * Install the Zotero-backed runtime adapter, unless a host already installed
 * one. Declining to overwrite keeps the outcome the same whichever order the
 * two happen in, so a non-Zotero host that reaches this module indirectly does
 * not lose its own adapter.
 */
export function registerZoteroRuntime(): void {
    setRuntimeAdapterIfUnset(zoteroAdapter);
}
