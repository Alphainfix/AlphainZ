/**
 * The React-side face of settings sync: run an import, then wake the atoms
 * that mirror preferences and would otherwise keep their stale hydration.
 *
 * Three mirrors need the poke, each for a documented reason:
 *  - the model picker hydrates from prefs once and *writes back* on selection
 *    (`updateSelectedModelAtom`) — refreshing via `refreshLocalModelAtom` is
 *    the read-only path that cannot clobber the imported values;
 *  - `streamDisplayModeAtom` caches the pref in `modeOverrideAtom`; writing
 *    the freshly-read value through it re-primes the cache (and re-writing an
 *    identical pref value is harmless);
 *  - `actionsAtom` is seeded from `getMergedActions()` at module load.
 * Appearance needs nothing here: `startAppearanceObserver` already reacts to
 * the pref writes themselves. Nor does the question rail: `conversationRailAtom`
 * observes its pref while the pane shows it and re-reads it when it next does.
 */
import { store } from '../store';
import { importSettingsNow as importCore } from '../../src/services/conversationSync/settingsSync';
import { refreshLocalModelAtom } from '../atoms/models';
import { streamDisplayModeAtom, readStreamDisplayPref } from '../atoms/streamDisplay';
import { actionsAtom } from '../atoms/actions';
import { getMergedActions } from '../types/actionStorage';
import { logger } from '@beaver/agent-core/platform/logger';

export async function importSettingsNow(): Promise<boolean> {
    let applied = false;
    try {
        applied = await importCore();
    } catch (error) {
        logger(`settingsSyncClient: import failed: ${error}`, 1);
        return false;
    }
    if (!applied) return false;
    try {
        store.set(refreshLocalModelAtom);
        store.set(streamDisplayModeAtom, readStreamDisplayPref());
        store.set(actionsAtom, getMergedActions());
    } catch (error) {
        logger(`settingsSyncClient: atom refresh failed: ${error}`, 1);
    }
    return true;
}
