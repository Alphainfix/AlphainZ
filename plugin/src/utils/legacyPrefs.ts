import { getPref, setPref } from './prefs';

/** Preference prefixes this plugin has used, newest first. */
export const LEGACY_PREF_PREFIXES = ['extensions.zotero.alphainreader', 'extensions.zotero.beaver'];

/**
 * Account-era settings have no meaning here; carrying them forward resurfaced
 * stale marketing popups and sign-in state.
 */
export const LEGACY_PREFS_NOT_ADOPTED = new Set([
    'userEmail', 'authMethod', 'threadsClaimKey', 'currentPlanId', 'deletionJobs',
    'pendingVersionNotifications',
]);

/** The slice of nsIPrefBranch the adoption needs; injectable for tests. */
export interface PrefBranchLike {
    readonly PREF_STRING?: number;
    readonly PREF_INT?: number;
    readonly PREF_BOOL?: number;
    getChildList(prefix: string): string[];
    prefHasUserValue(key: string): boolean;
    getPrefType(key: string): number;
    getStringPref(key: string): string;
    getIntPref(key: string): number;
    getBoolPref(key: string): boolean;
    setStringPref(key: string, value: string): void;
    setIntPref(key: string, value: number): void;
    setBoolPref(key: string, value: boolean): void;
}

/**
 * Carry settings across a rename — once.
 *
 * The preference prefix is derived from the plugin's own name, so renaming it
 * orphans every setting the user ever made, API keys included. On the first
 * start under the current name, everything the user set under an earlier name
 * is copied (never moved) wherever the new key is still unset.
 *
 * The pass runs once and records that it ran: a blank preference is also what
 * a *deleted* key looks like, so re-running on every start would bring back a
 * key the user removed in the settings, from a branch nothing else reads.
 *
 * Returns the number of settings carried, or -1 when the pass was skipped
 * because it already ran.
 */
export function adoptLegacyPreferences(
    branch: PrefBranchLike,
    prefsPrefix: string,
    log: (message: string) => void = () => {},
): number {
    if (getPref('legacyPrefsAdopted')) return -1;
    let carried = 0;
    try {
        for (const legacy of LEGACY_PREF_PREFIXES) {
            for (const key of branch.getChildList(`${legacy}.`)) {
                const suffix = key.slice(legacy.length + 1);
                if (LEGACY_PREFS_NOT_ADOPTED.has(suffix) || suffix.startsWith('auth.')) continue;
                const target = `${prefsPrefix}.${suffix}`;
                if (branch.prefHasUserValue(target)) continue;

                switch (branch.getPrefType(key)) {
                    case branch.PREF_STRING:
                        branch.setStringPref(target, branch.getStringPref(key));
                        break;
                    case branch.PREF_INT:
                        branch.setIntPref(target, branch.getIntPref(key));
                        break;
                    case branch.PREF_BOOL:
                        branch.setBoolPref(target, branch.getBoolPref(key));
                        break;
                    default:
                        continue;
                }
                carried += 1;
            }
        }
        if (carried > 0) log(`adoptLegacyPreferences: carried ${carried} setting(s) forward`);
        setPref('legacyPrefsAdopted', true);
    } catch (error) {
        // Losing a setting costs the user a retype; refusing to start costs
        // them the plugin. Not marking the pass done lets the next start retry.
        log(`adoptLegacyPreferences: skipped (${error})`);
    }
    return carried;
}
