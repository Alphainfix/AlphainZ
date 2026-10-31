/**
 * Which revision of the welcome wizard this build carries.
 *
 * The wizard shows whenever `welcomeWizardShownForVersion` differs from this —
 * so a fresh install sees it, an upgrader sees it once, and bumping this
 * constant re-shows a materially revised wizard exactly once more. The pref is
 * deliberately machine-local and excluded from settings sync: a synced flag
 * would let one machine mark the wizard "seen" on a machine that never saw it,
 * and the wizard is precisely where sync itself gets configured.
 */
import { getPref, setPref } from './prefs';

export const WIZARD_VERSION = '1';

export function isWelcomeWizardComplete(): boolean {
    return String(getPref('welcomeWizardShownForVersion') ?? '') === WIZARD_VERSION;
}

export function markWelcomeWizardComplete(): void {
    setPref('welcomeWizardShownForVersion', WIZARD_VERSION);
}
