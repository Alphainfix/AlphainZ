import React, { useCallback, useState } from 'react';

import {
    AUTO_OUTPUT_TOKENS,
    DEFAULT_MAX_LIBRARY_SEARCHES,
    DEFAULT_MAX_LITERATURE_LOOKUPS,
    DEFAULT_MAX_MODEL_REQUESTS,
    NO_SEARCH_LIMIT,
} from '@beaver/agent-llm/runLimits';
import { SettingsGroup, SettingsRow } from './SettingsElements';
import { useSettingsHost, type SettingsHost } from './host';
import { t } from '../i18n';

export type LimitPref = 'maxOutputTokens' | 'maxModelRequests' | 'maxLibrarySearches' | 'maxLiteratureLookups';

/** Every limit, in the order the section shows them. */
export const ALL_RUN_LIMITS: readonly LimitPref[] = ['maxOutputTokens', 'maxModelRequests', 'maxLibrarySearches', 'maxLiteratureLookups'];

interface Choice {
    value: number;
    label: string;
}

// Functions, not constants: the labels are read in the interface language when shown.
const outputTokenChoices = (): Choice[] => [
    { value: AUTO_OUTPUT_TOKENS, label: t('Auto (provider default)') },
    ...[8, 16, 32, 64, 128].map((k) => ({ value: k * 1000, label: t('{count}k tokens', { count: k }) })),
];

const modelRequestChoices = (): Choice[] =>
    [12, 24, 40, 60, 100].map((n) => ({ value: n, label: t('{count} requests', { count: n }) }));

const librarySearchChoices = (): Choice[] => [
    ...[10, 20].map((n) => ({ value: n, label: t('{count} searches', { count: n }) })),
    { value: NO_SEARCH_LIMIT, label: t('No limit') },
];

const literatureLookupChoices = (): Choice[] => [
    ...[10, 20].map((n) => ({ value: n, label: t('{count} lookups', { count: n }) })),
    { value: NO_SEARCH_LIMIT, label: t('No limit') },
];

function readStored(host: SettingsHost, key: LimitPref, fallback: number): number {
    const raw = Number(host.getPref(key));
    return Number.isFinite(raw) ? Math.round(raw) : fallback;
}

/**
 * The stored value may not be one of the offered choices — set on another
 * machine, or by hand. It is shown as its own entry rather than silently
 * displayed as the first option, which would misreport what the next run uses.
 */
function withStored(choices: Choice[], stored: number, customLabel: (count: string) => string): Choice[] {
    return choices.some((choice) => choice.value === stored)
        ? choices
        : [...choices, { value: stored, label: customLabel(stored.toLocaleString()) }];
}

function useLimitPref(key: LimitPref, fallback: number): [number, (value: number) => void] {
    const host = useSettingsHost();
    const [value, setValue] = useState(() => readStored(host, key, fallback));
    const update = useCallback((next: number) => {
        host.setPref(key, next);
        setValue(next);
    }, [key]);
    return [value, update];
}

const LimitSelect: React.FC<{
    label: string;
    value: number;
    choices: Choice[];
    onChange: (value: number) => void;
}> = ({ label, value, choices, onChange }) => (
    <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onClick={(e) => e.stopPropagation()}
        style={{ cursor: 'pointer' }}
    >
        {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
        ))}
    </select>
);

/**
 * Limits on one question: how much a reply may spend and how many steps and
 * searches a run may take.
 *
 * Each was a constant chosen against a runaway run; each also stopped real
 * questions short — a thinking model on an 8k reply answered nothing, a
 * literature question ran out at its fourth search. The defaults keep their
 * reasons; the choice is now the user's, and every limit a run reaches says
 * which of these to raise.
 *
 * `limits` names the ones to show, for a client whose runs apply only some.
 */
const RunLimitsSection: React.FC<{ limits?: readonly LimitPref[] }> = ({ limits = ALL_RUN_LIMITS }) => {
    const [outputTokens, setOutputTokens] = useLimitPref('maxOutputTokens', AUTO_OUTPUT_TOKENS);
    const [modelRequests, setModelRequests] = useLimitPref('maxModelRequests', DEFAULT_MAX_MODEL_REQUESTS);
    const [librarySearches, setLibrarySearches] = useLimitPref('maxLibrarySearches', DEFAULT_MAX_LIBRARY_SEARCHES);
    const [literatureLookups, setLiteratureLookups] = useLimitPref('maxLiteratureLookups', DEFAULT_MAX_LITERATURE_LOOKUPS);
    const shows = (limit: LimitPref) => limits.includes(limit);

    return (
        <>
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">{t('Limits per Question')}</div>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                {t('Ceilings, not charges: you pay only for what a question actually uses. They exist so a model that keeps rephrasing or thinking cannot run on without end. Changes apply from the next message.')}
            </div>
            <SettingsGroup>
                {shows('maxOutputTokens') && (
                    <SettingsRow
                        title={t('Output tokens per reply')}
                        description={t('The most one reply may spend, and a thinking model\'s reasoning counts against it — too low and a turn can end mid-thought with nothing to show. Auto is 32k for DeepSeek, GLM, OpenRouter and OpenAI (16k for gpt-4o), 4k for Ollama, 8k for a provider you add, or the Max output set for the model on its card; a higher choice is held to what the provider accepts.')}
                        control={
                            <LimitSelect
                                label={t('Output tokens per reply')}
                                value={outputTokens}
                                choices={withStored(outputTokenChoices(), outputTokens, (count) => t('{count} tokens (custom)', { count }))}
                                onChange={setOutputTokens}
                            />
                        }
                    />
                )}
                {shows('maxModelRequests') && (
                    <SettingsRow
                        title={t('Model requests per question')}
                        description={t('Every step — a search, a page read, a proposed highlight — is one request. A question that reaches the limit stops and says so; ask it to continue.')}
                        control={
                            <LimitSelect
                                label={t('Model requests per question')}
                                value={modelRequests}
                                choices={withStored(modelRequestChoices(), modelRequests, (count) => t('{count} requests (custom)', { count }))}
                                onChange={setModelRequests}
                            />
                        }
                    />
                )}
                {shows('maxLibrarySearches') && (
                    <SettingsRow
                        title={t('Library searches per question')}
                        description={t('Topic, keyword and full-text searches of your library, together. With no limit, the request limit above still ends the question.')}
                        control={
                            <LimitSelect
                                label={t('Library searches per question')}
                                value={librarySearches}
                                choices={withStored(librarySearchChoices(), librarySearches, (count) => t('{count} searches (custom)', { count }))}
                                onChange={setLibrarySearches}
                            />
                        }
                    />
                )}
                {shows('maxLiteratureLookups') && (
                    <SettingsRow
                        title={t('Literature lookups per question')}
                        description={t('OpenAlex searches, DOI lookups and citation walks, together. With no limit, the request limit above still ends the question.')}
                        control={
                            <LimitSelect
                                label={t('Literature lookups per question')}
                                value={literatureLookups}
                                choices={withStored(literatureLookupChoices(), literatureLookups, (count) => t('{count} lookups (custom)', { count }))}
                                onChange={setLiteratureLookups}
                            />
                        }
                    />
                )}
            </SettingsGroup>
        </>
    );
};

export default RunLimitsSection;
