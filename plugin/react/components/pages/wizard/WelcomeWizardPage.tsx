import React, { useState } from 'react';
import { useSetAtom } from 'jotai';

import OnboardingHeader from '../onboarding/OnboardingHeader';
import OnboardingFooter from '../onboarding/OnboardingFooter';
import { completeWelcomeWizardAtom } from '../../../atoms/welcomeWizard';
import ApiKeysStep from './steps/ApiKeysStep';
import SyncChoiceStep from './steps/SyncChoiceStep';
import IndexStep from './steps/IndexStep';
import AppearanceSection from '../../preferences/AppearanceSection';
import FeatureTourStep from './steps/FeatureTourStep';
import config from '../../../../package.json';
import { msg, t } from '../../../../src/utils/i18n';
import { WizardLanguageChoice } from '../../preferences/LanguageChoice';

/**
 * The five-step welcome wizard.
 *
 * Shown once per WIZARD_VERSION per machine (see atoms/welcomeWizard). Every
 * step writes its preferences immediately — Next never blocks, Skip completes —
 * so there is no separate "apply" and no way to lose work by backing out. The
 * indexes start on their own once the chosen embedding provider can be used.
 *
 * When a sync location was chosen, the completion atom joins it
 * (joinSyncBackend): it takes the location's settings, keeping this
 * computer's own choices over install defaults; writes this computer's
 * settings, merged with what it took or as the location's first document when
 * there is none; reconciles and imports the conversations; then backs up only
 * what the location lacks, holds in an older version, or holds damaged. The
 * settings it took are announced by a listener in atoms/welcomeWizard.
 */
const STEPS: Array<{ id: string; title: string; blurb: string }> = [
    { id: 'keys', title: msg('Connect a model'), blurb: msg('AlphainZ talks straight to the model vendor with your own key — no account, no middleman.') },
    { id: 'sync', title: msg('Sync (optional)'), blurb: msg('Carry conversations and settings to your other machines.') },
    { id: 'index', title: msg('Search index (optional)'), blurb: msg('Let the agent search your library by meaning.') },
    { id: 'appearance', title: msg('Make it yours'), blurb: msg('Theme, font and spacing — every change lands instantly.') },
    { id: 'tour', title: msg('What it can do'), blurb: msg('Two minutes on the features you would otherwise find by accident.') },
];

const WelcomeWizardPage: React.FC = () => {
    const [step, setStep] = useState(0);
    const completeWizard = useSetAtom(completeWelcomeWizardAtom);

    const finish = () => {
        completeWizard();
    };

    const isLast = step === STEPS.length - 1;
    const current = STEPS[step];

    return (
        <div className="display-flex flex-col flex-1 min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar px-4">
                <OnboardingHeader
                    title={t('Welcome to AlphainZ')}
                    message={t(current.blurb)}
                    tag={`v${config.version}`}
                />
                {/* Step dots — clickable, like the feature tour's. */}
                <div className="display-flex flex-row items-center gap-2 mb-3" role="tablist" aria-label={t('Setup steps')}>
                    {STEPS.map((s, i) => (
                        <button
                            key={s.id}
                            type="button"
                            role="tab"
                            aria-selected={i === step}
                            aria-label={t(s.title)}
                            onClick={() => setStep(i)}
                            className="variant-ghost-secondary"
                            style={{
                                width: 8, height: 8, borderRadius: 8, padding: 0, border: 0,
                                cursor: 'pointer',
                                background: i === step ? 'var(--accent-blue)' : 'var(--fill-quinary)',
                            }}
                        />
                    ))}
                    <span className="text-sm font-color-secondary" style={{ marginLeft: 6 }}>
                        {step + 1} / {STEPS.length} · {t(current.title)}
                    </span>
                </div>

                {/* The language comes first, so the rest of the setup reads in it. */}
                {current.id === 'keys' && <WizardLanguageChoice />}
                {current.id === 'keys' && <ApiKeysStep />}
                {current.id === 'sync' && <SyncChoiceStep />}
                {current.id === 'index' && <IndexStep />}
                {current.id === 'appearance' && <AppearanceSection showLanguage={false} />}
                {current.id === 'tour' && <FeatureTourStep />}
            </div>

            <OnboardingFooter
                buttonLabel={isLast ? t('Get Started') : t('Next')}
                onButtonClick={() => (isLast ? finish() : setStep(step + 1))}
                showBackButton={true}
                backButtonLabel={step === 0 ? t('Skip setup') : t('Back')}
                hideBackIcon={step === 0}
                onBackClick={() => (step === 0 ? finish() : setStep(step - 1))}
                hideRightIcon={isLast}
            />
        </div>
    );
};

export default WelcomeWizardPage;
