import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Icon, AlertIcon, RepeatIcon, ArrowDownIcon, ArrowRightIcon, LinkForwardIcon, SettingsIcon } from '../icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import ContextMenu from '@beaver/agent-ui/primitives/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';
import { regenerateFromRunAtom, resumeFromRunAtom, retryPendingRunIdAtom } from '../../atoms/agentRunAtoms';
import { runErrorVisibilityAtom, setRunErrorVisibilityAtom } from '../../atoms/messageUIState';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { getRunErrorTitle, stripRunErrorTypePrefix } from '@beaver/agent-core/run-state/runErrorCopy';

interface RunError {
    type: string;
    message: string;
    user_facing_details?: string;
    details?: string;
    is_retryable?: boolean;
    has_beaver_fallback?: boolean;
    retry_after?: number;
    is_resumable?: boolean;
}

interface RunErrorDisplayProps {
    runId: string;
    error: RunError;
    isLastRun: boolean;
}

/**
 * Failures whose fix is on the Model tab of Settings: a key to paste or
 * correct, a provider or model to set up, or another model to switch to. Each
 * of their messages names the place; the card opens it.
 */
const MODEL_SETTINGS_ERROR_TYPES = new Set([
    'not_configured',
    'model_requires_api_key',
    'llm_auth_error',
    'llm_model_access_denied',
    'llm_invalid_model',
    'llm_insufficient_credits',
    'llm_quota_exceeded',
]);

/**
 * Displays an error message for a failed agent run.
 *
 * A collapsible card with the actions that can help: Resume for a run that
 * was cut off, Open Settings for a failure only a setting can fix, and Retry
 * unless sending the same request again is bound to fail the same way.
 */
export const RunErrorDisplay: React.FC<RunErrorDisplayProps> = ({ runId, error, isLastRun }) => {
    const regenerateFromRun = useSetAtom(regenerateFromRunAtom);
    const resumeFromRun = useSetAtom(resumeFromRunAtom);

    // Visibility state
    const runErrorVisibility = useAtomValue(runErrorVisibilityAtom);
    const setVisibility = useSetAtom(setRunErrorVisibilityAtom);
    const isExpanded = runErrorVisibility[runId] ?? isLastRun;

    const contentRef = useRef<HTMLDivElement | null>(null);


    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    const [isHovered, setIsHovered] = useState(false);

    // Loading state while this run's retry commits its removal on the
    // backend (truncate POST + undo). `clickedAction` remembers which button
    // started it so only that one shows the spinner; the others just disable.
    const isRetryPending = useAtomValue(retryPendingRunIdAtom) === runId;
    const [clickedAction, setClickedAction] = useState<'retry' | 'try-with-beaver' | null>(null);

    const handleRetry = async () => {
        setClickedAction('retry');
        await regenerateFromRun(runId);
    };

    const handleResume = async () => {
        await resumeFromRun(runId);
    };

    // Set once the user has gone to the setting this card points at: from
    // then on the same request can succeed, so Retry is offered.
    const [openedSettings, setOpenedSettings] = useState(false);
    const handleOpenSettings = () => {
        setOpenedSettings(true);
        openPreferencesWindow('models');
    };

    const handleToggle = () => {
        setVisibility({ runId, visible: !isExpanded });
    };

    const displayMessage = stripRunErrorTypePrefix(error.message, error.type);

    const headerTitle = getRunErrorTitle(error.type);
    const canResume = Boolean(error.is_resumable && isLastRun);
    const canOpenSettings = isLastRun && MODEL_SETTINGS_ERROR_TYPES.has(error.type);
    // An error that does not say whether it is retryable keeps its Retry.
    const canRetry = isLastRun && (error.is_retryable !== false || (canOpenSettings && openedSettings));
    const primaryErrorAction = canResume
        ? 'resume'
        : canOpenSettings && !openedSettings
            ? 'open-settings'
            : canRetry ? 'retry' : null;
    const primaryActionAttr = (action: string) => primaryErrorAction === action ? 'true' : undefined;

    return (
        <div className="px-4 user-select-text" ref={contentRef} onContextMenu={handleContextMenu}>
             <div
                id={`run-error-${runId}`}
                className={`
                    rounded-md flex flex-col min-w-0 border-error
                    ${isExpanded ? 'mb-2' : ''}
                `}
                style={{ background: 'var(--tag-red-quinary)' }}
            >
                <div
                    className="display-flex flex-row py-15"
                    style={{ 
                        borderBottom: isExpanded ? '1px solid var(--tag-red-quarternary)' : 'none'
                    }}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <button
                        type="button"
                        className="variant-ghost-secondary display-flex flex-row py-15 cursor-pointer gap-2 w-full text-left"
                        style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                        aria-expanded={isExpanded}
                        aria-controls={`run-error-content-${runId}`}
                        onClick={handleToggle}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className="display-flex mt-010 font-color-red">
                                <Icon icon={isHovered ? (isExpanded ? ArrowDownIcon : ArrowRightIcon) : AlertIcon} />
                            </div>
                            
                            <div className="display-flex font-color-red font-medium">
                                {headerTitle}
                            </div>
                        </div>
                    </button>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                    <div className="p-3" id={`run-error-content-${runId}`}>
                        <div className="display-flex flex-col gap-4">
                            <div className="display-flex flex-col gap-1">
                                <div className="text-base font-color-red">
                                    {parseTextWithLinksAndNewlines(displayMessage, "text-link-red")}
                                </div>
                                {error.user_facing_details && (
                                    <div
                                        className="text-base font-color-red user-select-text"
                                        style={{ opacity: 0.75 }}
                                    >
                                        {parseTextWithLinksAndNewlines(
                                            `${error.type === 'connection_error' ? 'Connection details' : 'Reason'}: ${error.user_facing_details}`,
                                            "text-link-red",
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="display-flex flex-row gap-3 items-center">
                                <div className="flex-1" />
                                {canResume && (
                                    <Button
                                        variant="error"
                                        iconClassName="font-color-red"
                                        rightIcon={LinkForwardIcon}
                                        onClick={handleResume}
                                        disabled={isRetryPending}
                                        data-run-error-action="resume"
                                        data-run-error-primary-action={primaryActionAttr('resume')}
                                    >
                                        Resume
                                    </Button>
                                )}
                                {canOpenSettings && (
                                    <Button
                                        variant="error"
                                        iconClassName="font-color-red"
                                        rightIcon={SettingsIcon}
                                        onClick={handleOpenSettings}
                                        data-run-error-action="open-settings"
                                        data-run-error-primary-action={primaryActionAttr('open-settings')}
                                    >
                                        <span className="font-color-red">Open Settings → Model</span>
                                    </Button>
                                )}
                                {canRetry && (
                                    <Button
                                        variant="error"
                                        iconClassName="font-color-red"
                                        rightIcon={RepeatIcon}
                                        onClick={handleRetry}
                                        disabled={isRetryPending}
                                        loading={isRetryPending && clickedAction === 'retry'}
                                        data-run-error-action="retry"
                                        data-run-error-primary-action={primaryActionAttr('retry')}
                                    >
                                        <span className="font-color-red">Retry</span>
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Text selection context menu */}
                <ContextMenu
                    menuItems={selectionMenuItems}
                    isOpen={isSelectionMenuOpen}
                    onClose={closeSelectionMenu}
                    position={selectionMenuPosition}
                    useFixedPosition={true}
                />
            </div>
        </div>
    );
};

export default RunErrorDisplay;
