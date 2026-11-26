import React, { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { ChartIcon, ChattingIcon, CancelIcon, HighlighterIcon, Icon, LibraryIcon } from '../../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Button from '@beaver/agent-ui/primitives/Button';
import { eventManager } from '../../../events/eventManager';
import { stageActionPillAtom } from '../../../atoms/actions';
import { useActionRunner } from '../../../hooks/useActionRunner';
import { msg, t } from '../../../../src/utils/i18n';

interface ReaderTipContentProps {
    onDismiss: () => void;
}

interface ReaderTipFeature {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    title: string;
    description: string;
    /** Built-in action to stage in the chat input when the user clicks Try it. */
    actionId?: string;
}

const features: ReaderTipFeature[] = [
    {
        icon: ChattingIcon,
        title: msg('Ask about this paper'),
        description: msg('Answers grounded in the open PDF, with sentence-level citations.'),
    },
    {
        icon: ChartIcon,
        title: msg('Understand text, figures & tables'),
        description: msg('Select a passage in the PDF and choose Explain, or attach a figure with an area annotation, for an instant explanation.'),
    },
    {
        icon: HighlighterIcon,
        title: msg('Annotate the PDF'),
        description: msg('Ask AlphainZ to highlight key findings or anything relevant to your work.'),
        actionId: 'builtin-color-code',
    },
    {
        icon: LibraryIcon,
        title: msg('Connect it to your library'),
        description: msg('Ask whether the rest of your library confirms, contradicts, or extends this paper.'),
        actionId: 'builtin-fit-research',
    },
];

const ReaderTipContent: React.FC<ReaderTipContentProps> = ({ onDismiss }) => {
    const { isBusy } = useActionRunner();
    const stageActionPill = useSetAtom(stageActionPillAtom);

    const handleOpenBeaver = () => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        onDismiss();
    };


    const handleTryAction = useCallback((actionId: string) => {
        if (isBusy) return;
        eventManager.dispatch('toggleChat', { forceOpen: true });
        stageActionPill({
            actionId,
            targetType: 'attachment',
            targetWindow: Zotero.getMainWindow(),
        });
        onDismiss();
    }, [isBusy, onDismiss, stageActionPill]);

    return (
        <div className="display-flex flex-col gap-5 w-full">
            <div className="display-flex flex-col gap-05 w-full">
                <div className="display-flex flex-row items-center justify-between w-full">
                    <span className="text-base font-semibold font-color-secondary">
                        AlphainZ
                    </span>
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost-secondary"
                        onClick={onDismiss}
                    />
                </div>

                <div className="font-color-primary text-xl font-semibold">
                    {t('Reading assistant')}
                </div>
            </div>

            <div className="display-flex flex-col gap-4">
                {features.map((feature) => (
                    <div key={feature.title} className="display-flex flex-row gap-3 items-start">
                        <div className="flex-shrink-0">
                            <Icon icon={feature.icon} className="scale-11 mt-020 font-color-primary" />
                        </div>
                        <div className="display-flex flex-col gap-05">
                            <span className="font-color-primary text-base font-medium">
                                {t(feature.title)}
                            </span>
                            <span className="font-color-secondary text-sm">
                                {t(feature.description)}
                                {feature.actionId && (
                                    <>
                                        {' '}
                                        <button
                                            type="button"
                                            className={`text-link text-sm p-0 border-0 bg-transparent inline ${isBusy ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                                            style={{ opacity: isBusy ? 0.5 : 1 }}
                                            onClick={() => handleTryAction(feature.actionId!)}
                                            disabled={isBusy}
                                        >
                                            {t('Try it →')}
                                        </button>
                                    </>
                                )}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            <div
                className="display-flex flex-row items-center justify-between gap-2 pt-3"
                style={{ borderTop: '1px solid var(--fill-quinary)' }}
            >
                <Button
                    variant="solid"
                    onClick={handleOpenBeaver}
                    className="items-center"
                    style={{ padding: '4px 10px', alignItems: 'center', justifyContent: 'center', fontSize: '0.95rem' }}
                >
                    {t('Open AlphainZ')}
                </Button>
            </div>
        </div>
    );
};

export default ReaderTipContent;
