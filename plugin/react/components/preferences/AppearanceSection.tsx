import React, { useCallback, useState } from 'react';
import { SettingsGroup, SettingsRow, SectionLabel } from './components/SettingsElements';
import { getPref, setPref } from '../../../src/utils/prefs';
import { applyAppearance, FONT_SIZES, LINE_HEIGHTS, normalizeTheme, type UiTheme } from '../../../src/utils/appearance';

/**
 * Appearance.
 *
 * Every control writes a preference and the change lands immediately — a theme
 * is a class on the pane's root, so there is nothing to rebuild and nothing to
 * restart. The pane behind this window repaints while you are still choosing,
 * which is the only honest way to pick a colour. Fresh is the default.
 */
const THEMES: Array<{ id: UiTheme; label: string; hint: string }> = [
    { id: 'fresh', label: 'Fresh', hint: 'Celadon on rice paper — light and quiet' },
    { id: 'warm', label: 'Warm', hint: 'Warm paper and terracotta' },
    { id: 'quiet', label: 'Quiet', hint: 'Warm paper and a slate blue' },
    { id: 'sky', label: 'Sky', hint: 'Pale blue paper, white cards, a cool blue — the DeepSeek Harness look' },
];

const SCHEMES: Array<{ id: string; label: string }> = [
    { id: 'auto', label: 'Follow Zotero' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
];

const FONTS: Array<{ id: string; label: string; hint: string }> = [
    { id: 'system', label: 'System', hint: "Zotero's own interface font" },
    { id: 'serif', label: 'Serif', hint: 'Iowan / Palatino / 宋体' },
    { id: 'sans', label: 'Sans', hint: 'Inter / SF / 苹方' },
];

const LEADING_LABELS: Record<string, string> = {
    compact: 'Compact',
    normal: 'Normal',
    relaxed: 'Relaxed',
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
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        className="py-1 preference-input text-sm"
        style={{ paddingLeft: '8px', paddingRight: '26px', minWidth: '9rem' }}
    >
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
);

const AppearanceSection: React.FC = () => {
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
            <SectionLabel>Appearance</SectionLabel>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Affects AlphainZ's own panes only — the rest of Zotero is untouched.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="Theme"
                    description={THEMES.find((t) => t.id === theme)?.hint}
                    control={
                        <Choice label="Theme" value={theme} options={THEMES}
                            onChange={(v) => change('uiTheme', v, setTheme)} />
                    }
                />
                <SettingsRow
                    title="Light or dark"
                    description="Overrides the system setting for AlphainZ"
                    control={
                        <Choice label="Light or dark" value={scheme}
                            options={SCHEMES}
                            onChange={(v) => change('uiColorScheme', v, setScheme)} />
                    }
                />
                <SettingsRow
                    title="Font"
                    description={FONTS.find((f) => f.id === font)?.hint}
                    control={
                        <Choice label="Font" value={font} options={FONTS}
                            onChange={(v) => change('uiFont', v, setFont)} />
                    }
                />
                <SettingsRow
                    title="Text size"
                    description={`${size} px`}
                    control={
                        <input
                            type="range"
                            aria-label="Text size"
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
                    title="Line spacing"
                    description={`${LINE_HEIGHTS[leading] ?? 1.55}×`}
                    control={
                        <Choice label="Line spacing" value={leading}
                            options={Object.keys(LINE_HEIGHTS).map((k) => ({ id: k, label: LEADING_LABELS[k] ?? k }))}
                            onChange={(v) => change('uiLineHeight', v, setLeading)} />
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default AppearanceSection;
