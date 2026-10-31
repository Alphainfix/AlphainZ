import React from "react";
import { Spinner, ArrowRightIcon, ArrowLeftIcon } from "../../icons/icons";
import Button, { ButtonVariant } from "@beaver/agent-ui/primitives/Button";

interface OnboardingFooterProps {
    /** Message displayed on the left side of the footer */
    message?: string;
    /** Button label text */
    buttonLabel: string;
    /** Whether the button action is in progress */
    isLoading?: boolean;
    /** Whether the button is disabled */
    disabled?: boolean;
    /** Click handler for the button */
    onButtonClick: () => void;
    /** Whether to show terms and privacy policy links */
    /** Whether to show a back button */
    showBackButton?: boolean;
    /** Click handler for the back button */
    onBackClick?: () => void;
    /** Label for the back button */
    backButtonLabel?: string;
    /** Whether the back button is disabled */
    backButtonDisabled?: boolean;
    /** Whether the back button action is in progress */
    backButtonLoading?: boolean;
    /** Hide the back button's left arrow icon for secondary actions. */
    hideBackIcon?: boolean;
    /** Visual style for the action button. */
    buttonVariant?: ButtonVariant;
    /** Hide the right-side arrow icon. The spinner is still shown when loading. */
    hideRightIcon?: boolean;
}

/**
 * Shared footer component for onboarding pages
 * Displays optional terms links, a message, and an action button
 */
const OnboardingFooter: React.FC<OnboardingFooterProps> = ({
    message,
    buttonLabel,
    isLoading = false,
    disabled = false,
    onButtonClick,
    showBackButton = false,
    onBackClick,
    backButtonLabel = "Back",
    backButtonDisabled = false,
    backButtonLoading = false,
    buttonVariant = "solid",
    hideRightIcon = false,
    hideBackIcon = false,
}) => {
    const rightIcon = isLoading
        ? Spinner
        : hideRightIcon
            ? undefined
            : ArrowRightIcon;
    return (
        <div className="p-4 border-top-quinary">
            <div className="display-flex flex-row items-center gap-4">
                {/* Back button */}
                {showBackButton && onBackClick && (
                    <Button
                        variant="ghost"
                        className="fit-content whitespace-nowrap"
                        icon={hideBackIcon ? undefined : ArrowLeftIcon}
                        onClick={onBackClick}
                        disabled={backButtonDisabled}
                        loading={backButtonLoading}
                    >
                        {backButtonLabel}
                    </Button>
                )}

                {/* Message area */}
                <div className="font-color-secondary text-sm">
                    {message}
                </div>

                <div className="flex-1" />

                {/* Action button */}
                <Button
                    variant={buttonVariant}
                    className="fit-content whitespace-nowrap"
                    rightIcon={rightIcon}
                    onClick={onButtonClick}
                    disabled={disabled || isLoading}
                >
                    {buttonLabel}
                </Button>
            </div>
        </div>
    );
};

export default OnboardingFooter;
