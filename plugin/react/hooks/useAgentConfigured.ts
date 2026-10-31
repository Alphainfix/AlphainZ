import { useEffect, useState } from 'react';

import pkg from '../../package.json';
import { KEY_PREF_BY_PROVIDER, isAgentConfigured } from '../../src/services/llm/agentConfig';

const PREFS_PREFIX = pkg.config.prefsPrefix;

/**
 * Preferences that decide whether the agent can run at all: the provider, and
 * every key a provider might need.
 */
const WATCHED: readonly string[] = [
    'llmProvider',
    'llmModel',
    'ollamaModels',
    // A hand-added endpoint is its own key holder.
    'customEndpoints',
    // Derived, not hand-listed: a vendor missing here kept the banner up
    // after its key was pasted.
    ...new Set(Object.values(KEY_PREF_BY_PROVIDER).filter((k): k is NonNullable<typeof k> => k !== null)),
];

/**
 * Whether a model is configured, kept current as the settings change.
 *
 * Preferences are edited in a separate window, so a value read once at mount
 * would leave the "no model configured" banner standing after the user had
 * just fixed it — the one moment they are watching for it to go away.
 */
export function useAgentConfigured(): boolean {
    const [configured, setConfigured] = useState(() => isAgentConfigured());

    useEffect(() => {
        const recheck = () => setConfigured(isAgentConfigured());
        // Full name with `global` set — the form the rest of the plugin uses.
        // Registered by a branch-relative name, the observer never fired and
        // the banner stayed up after the key had been pasted.
        const symbols = WATCHED.map((key) =>
            Zotero.Prefs.registerObserver(`${PREFS_PREFIX}.${key}`, recheck, true),
        );
        return () => symbols.forEach((symbol) => Zotero.Prefs.unregisterObserver(symbol));
    }, []);

    return configured;
}
