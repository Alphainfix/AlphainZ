import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Button from '@beaver/agent-ui/primitives/Button';
import { SettingsGroup, SettingsRow } from './components/SettingsElements';
import { chooseUiLanguageAtom, uiLanguageAtom } from '../../atoms/uiLanguage';
import { t, uiLanguageSetting, type UiLanguage, type UiLanguageSetting } from '../../../src/utils/i18n';

/**
 * The row title stays bilingual, and each language is named in itself, so the
 * row can be found and read whichever language the interface is in.
 */
const ROW_TITLE = 'Language · 语言';

const LANGUAGES: Array<{ id: UiLanguage; label: string }> = [
    { id: 'en', label: 'English' },
    { id: 'zh-CN', label: '简体中文' },
];

/**
 * The language row on the first page of the welcome wizard: one button per
 * language, the one in effect pressed. Choosing stores that language, so the
 * interface stays in it whatever Zotero's own language is.
 */
export const WizardLanguageChoice: React.FC = () => {
    const language = useAtomValue(uiLanguageAtom);
    const choose = useSetAtom(chooseUiLanguageAtom);

    return (
        <SettingsGroup className="mb-3">
            <SettingsRow
                title={ROW_TITLE}
                description={t('You can change it any time in Settings → General → Appearance.')}
                control={
                    <div className="display-flex flex-row items-center gap-2" role="group" aria-label={ROW_TITLE}>
                        {LANGUAGES.map((option) => (
                            <Button
                                key={option.id}
                                variant={option.id === language ? 'solid' : 'outline'}
                                aria-pressed={option.id === language}
                                onClick={() => choose(option.id)}
                            >
                                {option.label}
                            </Button>
                        ))}
                    </div>
                }
            />
        </SettingsGroup>
    );
};

/** The language select in Settings, with "Follow Zotero" as the first choice. */
export const LanguageSettingRow: React.FC<{
    renderSelect: (props: {
        label: string;
        value: string;
        options: Array<{ id: string; label: string }>;
        onChange: (value: string) => void;
    }) => React.ReactNode;
}> = ({ renderSelect }) => {
    const [setting, setSetting] = useState<UiLanguageSetting>(() => uiLanguageSetting());
    const choose = useSetAtom(chooseUiLanguageAtom);

    return (
        <SettingsRow
            title={ROW_TITLE}
            description={t('"Follow Zotero" shows Chinese when Zotero itself is in Chinese, and English otherwise.')}
            control={renderSelect({
                label: ROW_TITLE,
                value: setting,
                options: [{ id: 'auto', label: t('Follow Zotero') }, ...LANGUAGES],
                onChange: (value) => {
                    const next = value as UiLanguageSetting;
                    setSetting(next);
                    choose(next);
                },
            })}
        />
    );
};
