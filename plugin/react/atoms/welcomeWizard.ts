/**
 * When the welcome wizard shows, and what completing it does.
 *
 * The gate is a machine-local pref holding the wizard version last completed
 * here. Deliberately not synced: the wizard is where sync itself is chosen, so
 * no remote document may mark it done on a machine that never saw it. Bumping
 * `WIZARD_VERSION` re-shows a materially revised wizard exactly once.
 */
import { atom } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';
import { conversationSyncMode } from '../../src/services/conversationSync';
import {
    describeSettingsTaken,
    onSettingsTaken,
    type SettingsTaken,
} from '../../src/services/conversationSync/settingsSync';

import { getPref, setPref } from '../../src/utils/prefs';
import { WIZARD_VERSION, isWelcomeWizardComplete, markWelcomeWizardComplete } from '../../src/utils/welcomeWizard';

/**
 * When the model just taken from another computer cannot run here, what to
 * do about it; null when it can. Keys never sync, so this is the usual case
 * for a second computer whose first key was for another vendor.
 */
async function missingModelHint(): Promise<string | null> {
    const { isAgentConfigured } = await import('../../src/services/llm/agentConfig');
    if (isAgentConfigured()) return null;
    const { PROVIDER_PRESETS } = await import('../../src/services/llm/openAICompatible');
    const provider = String(getPref('llmProvider') ?? '').trim();
    const label = (PROVIDER_PRESETS as Record<string, { label?: string } | undefined>)[provider]?.label;
    return label
        ? `Its model needs a ${label} key, and API keys stay on each computer: paste one in `
            + 'Settings → Model, or pick another model.'
        : 'Its model\'s provider is not set up on this computer: add it in Settings → Model, '
            + 'or pick another model.';
}

/**
 * The popup that says this computer now uses another one's settings: which
 * ones, which of its own it kept (they go to the other computer too), and
 * what to do when the model it took cannot run here.
 */
async function announceSettingsTaken(taken: SettingsTaken): Promise<void> {
    try {
        const modelHint = taken.changed.includes('llmProvider') || taken.changed.includes('llmModel')
            ? await missingModelHint()
            : null;
        const kept = taken.kept.length > 0
            ? `Kept from this computer, and sent to the other one: ${describeSettingsTaken(taken.kept)}. `
            : '';
        const { store } = await import('../store');
        const { addPopupMessageAtom } = await import('../utils/popupMessageUtils');
        store.set(addPopupMessageAtom, {
            type: 'info',
            title: 'Using your other computer\'s settings',
            text: `Taken from the computer that already syncs here: ${describeSettingsTaken(taken.changed)}. `
                + kept
                + (modelHint ?? 'API keys stay on each computer.'),
            expire: true,
            duration: modelHint || kept ? 15000 : 8000,
        });
    } catch (error) {
        logger(`welcomeWizard: could not announce the settings taken: ${error}`, 1);
    }
}

/*
 * Joining a location announces the settings it took wherever that happens:
 * at the join itself (this wizard, or the settings page), or at a later
 * pass, when a document that could not be read at the join arrives. So the
 * listener is registered with the module, which the sidebar loads at startup,
 * rather than in the completion below.
 */
onSettingsTaken((taken) => {
    if (taken.firstContact) void announceSettingsTaken(taken);
});

/** Dev-tools override: show the wizard regardless of the pref. */
export const welcomeWizardForcedAtom = atom(false);

const completedAtom = atom(isWelcomeWizardComplete());

export const welcomeWizardVisibleAtom = atom(
    (get) => get(welcomeWizardForcedAtom) || !get(completedAtom),
);

/**
 * Mark the wizard done and, when a sync location was chosen, join it.
 *
 * Returns the sync tail's promise so a caller (or a test) can wait for it;
 * the wizard itself does not — completion never waits on the network.
 */
export const completeWelcomeWizardAtom = atom(null, (_get, set): Promise<void> => {
    markWelcomeWizardComplete();
    /*
     * Suppress the floating install popup too — the wizard has already
     * welcomed; two welcomes read as a bug.
     */
    if (!getPref('onboardingWelcomeShown')) {
        setPref('onboardingWelcomeShown', true);
        setPref('onboardingWelcomeShownAt', new Date().toISOString());
    }
    set(completedAtom, true);
    set(welcomeWizardForcedAtom, false);

    /*
     * Joining takes what the sync location already holds before writing
     * anything from here: on a second computer, the first one's settings and
     * conversations are there, and this one's install defaults must not
     * replace them. `joinSyncBackend` owns that order for both surfaces that
     * can turn sync on; the settings it takes are announced by the listener
     * above.
     */
    return (async () => {
        try {
            if (conversationSyncMode() === 'off') return;
            const { joinSyncBackend } = await import('../utils/syncModeSwitch');
            await joinSyncBackend();
        } catch (error) {
            // A sync hiccup must not un-complete the wizard; the next
            // catch-up pass repeats the import. But say what happened —
            // a silent catch here cost a debugging round already.
            logger(`completeWelcomeWizard: sync tail failed: ${error}`, 1);
        }
    })();
});

export { WIZARD_VERSION };
