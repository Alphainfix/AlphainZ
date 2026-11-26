import React from 'react';
import { CancelIcon } from '../../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Button from '@beaver/agent-ui/primitives/Button';
import { eventManager } from '../../../events/eventManager';
import { t } from '../../../../src/utils/i18n';

interface NoteTipContentProps {
    onDismiss: () => void;
}

const NoteTipContent: React.FC<NoteTipContentProps> = ({ onDismiss }) => {
    const handleOpenBeaver = () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        onDismiss();
    };

    return (
        <div className="display-flex flex-col gap-3 w-full">
            {/* Header: logo + name + dismiss */}
            <div className="display-flex flex-row items-center justify-between w-full">
                <div className="display-flex flex-row gap-2 items-center">
                    <img
                        src="chrome://alphainz/content/icons/alphain-128.png"
                        style={{ width: '2rem', height: '2rem' }}
                        alt="AlphainZ"
                    />
                    <span className="font-color-primary text-xl font-medium">
                        AlphainZ
                    </span>
                </div>
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={onDismiss}
                />
            </div>

            {/* Primary text */}
            <div className="font-color-secondary text-base">
                {t('Use AlphainZ as a writing assistant for your Zotero notes.')}
            </div>

            {/* Secondary text */}
            <div className="font-color-tertiary text-base">
                {t('Summarize papers, draft sections, and find citations while you write.')}
            </div>

            {/* CTA button */}
            <Button
                variant="solid"
                onClick={handleOpenBeaver}
                className="items-center"
                style={{ padding: '4px 6px', width: '100%', alignItems: 'center', justifyContent: 'center', fontSize: "0.95rem" }}
            >
                {t('Open AlphainZ →')}
            </Button>
        </div>
    );
};

export default NoteTipContent;
