import { config } from '../../../../package.json';
import React from "react";
import { t } from '../../../../src/utils/i18n';

interface OnboardingHeaderProps {
    title?: string;
    message: string | React.ReactNode;
    tag?: string
}

/**
 * Shared header component for onboarding pages
 * Displays the Beaver logo, welcome title, and a descriptive message
 */
const OnboardingHeader: React.FC<OnboardingHeaderProps> = ({
    title = t("Welcome to AlphainZ"),
    message,
    tag
}) => {
    return (
        <div className="display-flex flex-col items-start mb-3">
            <div className="display-flex flex-row gap-2 items-end">
                {/* The chrome package is named after the plugin, so the URL
                    left over from the fork resolved to nothing and the first-run
                    page showed a broken image. Built from `addonRef` rather than
                    written out, so a rename cannot break it again. */}
                <img
                    src={`chrome://${config.addonRef}/content/icons/alphain-128.png`}
                    style={{ width: '4rem', height: '4rem' }}
                    alt={t('AlphainZ logo')}
                />
                <div className="display-flex flex-row gap-1 items-center">
                <div className="text-2xl font-semibold mb-2">{title}</div>
                    {tag && (
                        <div className="font-color-secondary scale-90 px-15 py-05 mb-3 text-sm rounded-md bg-quinary border-quinary">
                            {tag}
                        </div>
                    )}
                </div>
            </div>
            {typeof message === 'string' ? (
                <p className="text-base font-color-secondary" style={{ whiteSpace: 'pre-line' }}>
                    {message}
                </p>
            ) : (
                message
            )}
        </div>
    );
};

export default OnboardingHeader;

