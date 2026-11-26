import React, { useCallback, useState } from 'react';
import { SettingsGroup, SettingsRow, SectionLabel } from './components/SettingsElements';
import { getPref, setPref } from '../../../src/utils/prefs';
import { applyAppearance, FONT_SIZES, LINE_HEIGHTS, normalizeTheme, type UiTheme } from '../../../src/utils/appearance';
import { msg, t } from '../../../src/utils/i18n';
import { LanguageSettingRow } from './LanguageChoice';

/**
 * Appearance.
 *
 * Every control writes a preference and the change lands immediately — a theme
 * is a class on the pane's root, so there is nothing to rebuild and nothing to
 * restart. The pane behind this window repaints while you are still choosing,
 * which is the only honest way to pick a colour. Fresh is the default.
 */
const THEMES: Array<{ id: UiTheme; label: string; hint: string }> = [
    { id: 'fresh', label: msg('Fresh'), hint: msg('Celadon on rice paper — light and quiet') },
    { id: 'warm', label: msg('Warm'), hint: msg('Warm paper and terracotta') },
    { id: 'quiet', label: msg('Quiet'), hint: msg('Warm paper and a slate blue') },
    { id: 'sky', label: msg('Sky'), hint: msg('Pale blue paper, white cards, a cool blue — the DeepSeek Harness look') },
];

const SCHEMES: Array<{ id: string; label: string }> = [
    { id: 'auto', label: msg('Follow Zotero') },
    { id: 'light', label: msg('Light') },
    { id: 'dark', label: msg('Dark') },
];

const FONTS: Array<{ id: string; label: string; hint: string }> = [
    { id: 'system', label: msg('System'), hint: msg("Zotero's own interface font") },
    { id: 'serif', label: msg('Serif'), hint: 'Iowan / Palatino / 宋体' },
    { id: 'sans', label: msg('Sans'), hint: 'Inter / SF / 苹方' },
];

const LEADING_LABELS: Record<string, string> = {
    compact: msg('Compact'),
    normal: msg('Normal'),
    relaxed: msg('Relaxed'),
};

/**
 * The select the settings rows use.
 *
 * Sized here rather than inline on each one: the native chevron is drawn over
 * the field's own right padding, so a select left at Zotero's two pixels has
 * its longest option's last character sitting under the arrow.
 */
const Choice: React.FC<{
    label: string;
    value: string;
    options: Array<{ id: string; label: string }>;
    onChange: (v: string) => void;
}> = ({ label, value, options, onChange }) => (
    <select
        aria-label={t(label)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        className="py-1 preference-input text-sm"
        style={{ paddingLeft: '8px', paddingRight: '26px', minWidth: '9rem' }}
    >
        {options.map((o) => <option key={o.id} value={o.id}>{t(o.label)}</option>)}
    </select>
);

/**
 * `showLanguage` is off in the welcome wizard, whose first page has its own
 * language row.
 */
const AppearanceSection: React.FC<{ showLanguage?: boolean }> = ({ showLanguage = true }) => {
    const [theme, setTheme] = useState<UiTheme>(() => normalizeTheme(getPref('uiTheme')));
    const [scheme, setScheme] = useState(() => String(getPref('uiColorScheme') ?? 'auto'));
    const [font, setFont] = useState(() => String(getPref('uiFont') ?? 'system'));
    const [size, setSize] = useState(() => Number(getPref('uiFontSize')) || 13);
    const [leading, setLeading] = useState(() => String(getPref('uiLineHeight') ?? 'normal'));

    const change = useCallback((key: any, value: any, set: (v: any) => void) => {
        set(value);
        setPref(key, value);
        // Straight away, so the choice is visible while it is being made.
        applyAppearance();
    }, []);

    return (
        <>
            <SectionLabel>{t('Appearance')}</SectionLabel>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                {t("Affects AlphainZ's own panes only — the rest of Zotero is untouched.")}
            </div>
            <SettingsGroup>
                {showLanguage && <LanguageSettingRow renderSelect={(props) => <Choice {...props} />} />}
                <SettingsRow
                    title={t('Theme')}
                    description={t(THEMES.find((option) => option.id === theme)?.hint ?? '')}
                    control={
                        <Choice label={t('Theme')} value={theme} options={THEMES}
                            onChange={(v) => change('uiTheme', v, setTheme)} />
                    }
                />
                <SettingsRow
                    title={t('Light or dark')}
                    description={t('Overrides the system setting for AlphainZ')}
                    control={
                        <Choice label={t('Light or dark')} value={scheme}
                            options={SCHEMES}
                            onChange={(v) => change('uiColorScheme', v, setScheme)} />
                    }
                />
                <SettingsRow
                    title={t('Font')}
                    description={t(FONTS.find((f) => f.id === font)?.hint ?? '')}
                    control={
                        <Choice label={t('Font')} value={font} options={FONTS}
                            onChange={(v) => change('uiFont', v, setFont)} />
                    }
                />
                <SettingsRow
                    title={t('Text size')}
                    description={`${size} px`}
                    control={
                        <input
                            type="range"
                            aria-label={t('Text size')}
                            min={FONT_SIZES[0]}
                            max={FONT_SIZES[FONT_SIZES.length - 1]}
                            step={1}
                            value={size}
                            onChange={(e) => change('uiFontSize', Number(e.target.value), setSize)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ width: '9rem' }}
                        />
                    }
                />
                <SettingsRow
                    title={t('Line spacing')}
                    description={`${LINE_HEIGHTS[leading] ?? 1.55}×`}
                    control={
                        <Choice label={t('Line spacing')} value={leading}
                            options={Object.keys(LINE_HEIGHTS).map((k) => ({ id: k, label: LEADING_LABELS[k] ?? k }))}
                            onChange={(v) => change('uiLineHeight', v, setLeading)} />
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default AppearanceSection;
