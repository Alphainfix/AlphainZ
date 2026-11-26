import React from "react";
import { useAtomValue } from 'jotai';
import { allLibrariesExcludedAtom } from "../../atoms/profile";
import RecentChats from "../RecentChats";
import HomeLauncher from "../HomeLauncher";
import InputArea from "../input/InputArea";
import DragDropWrapper from "../input/DragDropWrapper";
import PopupOverlayContainer from "../PopupOverlayContainer";
import { SettingsIcon }  from "../icons/icons";
import { openPreferencesWindow } from "../../../src/ui/openPreferencesWindow";
import { useAgentConfigured } from "../../hooks/useAgentConfigured";
import Button from "@beaver/agent-ui/primitives/Button";
import { t } from '../../../src/utils/i18n';

interface HomePageProps {
    isWindow?: boolean;
    inputRef: React.RefObject<HTMLElement | null>;
}


const AllLibrariesExcludedMessage = () => (
    <div
        className="display-flex flex-row items-center gap-2 text-sm p-2 rounded-md"
        style={{ color: 'var(--tag-red-secondary)', border: '1px solid var(--tag-red-tertiary)', background: 'var(--tag-red-quinary)' }}
    >
        <span className="flex-1">
            {t('AlphainZ can\'t access any libraries. You\'ve excluded all of them.')}
        </span>
        <Button
            variant="error"
            icon={SettingsIcon}
            onClick={() => openPreferencesWindow('sync')}
        >
            {t('Open Settings')}
        </Button>
    </div>
);

/**
 * Shown until a provider and key are stored.
 *
 * Without this, a first send would fall through to a transport this fork has no
 * account for and fail with a connection error — sending the user to hunt a
 * network problem instead of the one field they actually need to fill in.
 */
const NoModelConfiguredMessage = () => (
    <div
        className="display-flex flex-row items-center gap-2 text-sm p-2 rounded-md bg-quinary"
    >
        <span className="flex-1 font-color-secondary">
            {t('No model is configured yet. Choose a provider and paste your API key to start.')}
        </span>
        <Button
            variant="outline"
            icon={SettingsIcon}
            onClick={() => openPreferencesWindow('models')}
        >
            {t('Open Settings')}
        </Button>
    </div>
);

const HomePage: React.FC<HomePageProps> = ({ isWindow = false, inputRef }) => {
    const allLibrariesExcluded = useAtomValue(allLibrariesExcludedAtom);
    const agentConfigured = useAgentConfigured();

    return (
        <div
            id="welcome-page"
            className="display-flex flex-col flex-1 min-h-0"
        >
            {/* Scrollable top section */}
            <div className="display-flex flex-col flex-1 overflow-y-auto scrollbar px-3 pt-4 gap-4">
                {/* Top spacer */}
                <div className="flex-1" style={{ minHeight: '2vh', maxHeight: '4vh' }} />

                {/* Greeting */}
                <div className="text-2xl font-semibold text-center p-2">{t('How can I help you?')}</div>

                {/* Input area */}
                <DragDropWrapper>
                    <InputArea inputRef={inputRef} verticalPosition="below" />
                </DragDropWrapper>

                {/* Action launcher — category row + expandable panels */}
                {!agentConfigured ? (
                    <NoModelConfiguredMessage />
                ) : allLibrariesExcluded ? (
                    <AllLibrariesExcludedMessage />
                ) : (
                    <HomeLauncher />
                )}

                {/* Bottom spacer */}
                <div className="flex-1" />
            </div>

            {/* Fixed bottom section */}
            <div
                id="alphainz-home-footer"
                className="flex-none px-25"
            >
                <RecentChats />

                <div className="relative -mx-4 px-4 mb-3">
                    <PopupOverlayContainer />
                </div>

            </div>
        </div>
    );
};

export default HomePage;
