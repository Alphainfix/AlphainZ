/**
 * Settings are carried across a plugin rename exactly once.
 *
 * The copy fills in whatever is unset under the current name. A blank
 * preference is also what a deleted API key looks like, so a pass that ran on
 * every start brought a removed key back from a branch nothing else reads.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import pkg from '../../../package.json';
import { adoptLegacyPreferences, type PrefBranchLike } from '../../../src/utils/legacyPrefs';

const PREFIX = pkg.config.prefsPrefix;

/** Every preference with a user value, keyed by full name. */
let values: Record<string, string | number | boolean> = {};

const branch: PrefBranchLike = {
    PREF_STRING: 32,
    PREF_INT: 64,
    PREF_BOOL: 128,
    getChildList: (prefix) => Object.keys(values).filter((k) => k.startsWith(prefix)),
    prefHasUserValue: (key) => key in values,
    getPrefType: (key) => {
        const v = values[key];
        return typeof v === 'string' ? 32 : typeof v === 'number' ? 64 : typeof v === 'boolean' ? 128 : 0;
    },
    getStringPref: (key) => values[key] as string,
    getIntPref: (key) => values[key] as number,
    getBoolPref: (key) => values[key] as boolean,
    setStringPref: (key, value) => { values[key] = value; },
    setIntPref: (key, value) => { values[key] = value; },
    setBoolPref: (key, value) => { values[key] = value; },
};

beforeEach(() => {
    values = {};
    // `getPref`/`setPref` go through the Zotero stub; back them with the same map.
    (Zotero.Prefs.get as any).mockImplementation((key: string) => values[key]);
    (Zotero.Prefs.set as any).mockImplementation((key: string, value: unknown) => {
        values[key] = value as string;
    });
});

describe('adoptLegacyPreferences', () => {
    it('copies what the user set under an earlier name where the new key is unset', () => {
        values['extensions.zotero.alphainreader.llmKeyDeepseek'] = 'old-key';
        values['extensions.zotero.alphainreader.llmProvider'] = 'deepseek';
        values['extensions.zotero.alphainreader.uiFontSize'] = 15;
        values['extensions.zotero.beaver.statefulChat'] = true;
        values['extensions.zotero.beaver.userEmail'] = 'someone@example.org';
        values['extensions.zotero.beaver.auth.token'] = 'jwt';
        values[`${PREFIX}.llmProvider`] = 'openrouter'; // already chosen here — keep it

        const carried = adoptLegacyPreferences(branch, PREFIX);

        expect(carried).toBe(3);
        expect(values[`${PREFIX}.llmKeyDeepseek`]).toBe('old-key');
        expect(values[`${PREFIX}.uiFontSize`]).toBe(15);
        expect(values[`${PREFIX}.statefulChat`]).toBe(true);
        expect(values[`${PREFIX}.llmProvider`]).toBe('openrouter');
        expect(`${PREFIX}.userEmail` in values).toBe(false);
        expect(`${PREFIX}.auth.token` in values).toBe(false);
        // The originals are copied, never moved.
        expect(values['extensions.zotero.alphainreader.llmKeyDeepseek']).toBe('old-key');
    });

    it('runs once: a key deleted afterwards stays deleted across restarts', () => {
        values['extensions.zotero.alphainreader.llmKeyDeepseek'] = 'old-key';
        adoptLegacyPreferences(branch, PREFIX);
        expect(values[`${PREFIX}.llmKeyDeepseek`]).toBe('old-key');

        // The user removes the key in the settings (blank = no user value).
        delete values[`${PREFIX}.llmKeyDeepseek`];

        expect(adoptLegacyPreferences(branch, PREFIX)).toBe(-1);
        expect(`${PREFIX}.llmKeyDeepseek` in values).toBe(false);
    });

    it('marks the pass done even when there was nothing to carry', () => {
        expect(adoptLegacyPreferences(branch, PREFIX)).toBe(0);
        expect(values[`${PREFIX}.legacyPrefsAdopted`]).toBe(true);
    });

    it('leaves the pass open for the next start when the branch throws', () => {
        const broken: PrefBranchLike = { ...branch, getChildList: () => { throw new Error('no prefs'); } };
        const logs: string[] = [];
        adoptLegacyPreferences(broken, PREFIX, (m) => logs.push(m));
        expect(logs[0]).toContain('skipped');
        expect(`${PREFIX}.legacyPrefsAdopted` in values).toBe(false);
    });
});
