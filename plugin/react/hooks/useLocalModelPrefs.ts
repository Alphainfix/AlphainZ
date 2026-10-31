import { useEffect } from 'react';
import { useSetAtom } from 'jotai';

import pkg from '../../package.json';
import { KEY_PREF_BY_PROVIDER } from '../../src/services/llm/agentConfig';
import { refreshLocalModelAtom } from '../atoms/models';

const PREFS_PREFIX = pkg.config.prefsPrefix;

/** Preferences the composer's model list is computed from. */
export const MODEL_LIST_PREFS: readonly string[] = [
    'llmProvider',
    'llmModel',
    'ollamaModels',
    // Hand-added endpoints and their models, and the verdicts the Check
    // button earned: both change which rows exist and what they say.
    'customEndpoints',
    'visionProbeCache',
    'providerOverrides',
    ...new Set(
        Object.values(KEY_PREF_BY_PROVIDER).filter(
            (key): key is NonNullable<typeof key> => key !== null,
        ),
    ),
];

/**
 * Keeps the composer's model list in step with the preferences it is built
 * from, whichever surface wrote them: the settings window, the first-run
 * wizard, or settings sync landing on this computer.
 *
 * The list is otherwise computed when the bundle loads. On a fresh install
 * that is before any key exists, so without this the composer had no model to
 * offer until Zotero restarted — and the first message could not run.
 *
 * Changes are coalesced into one refresh per tick: a provider and model are
 * written as two preferences, and refreshing between the writes would act on
 * a half-updated pair.
 */
export function useLocalModelPrefs(): void {
    const refresh = useSetAtom(refreshLocalModelAtom);

    useEffect(() => {
        let scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            void Promise.resolve().then(() => {
                scheduled = false;
                refresh();
            });
        };
        // Registered by full name with `global` set, the form the rest of the
        // plugin uses: observers registered by a branch-relative name never
        // fired for this plugin's preferences.
        const symbols = MODEL_LIST_PREFS.map((key) =>
            Zotero.Prefs.registerObserver(`${PREFS_PREFIX}.${key}`, schedule, true),
        );
        return () => symbols.forEach((symbol) => Zotero.Prefs.unregisterObserver(symbol));
    }, [refresh]);
}
