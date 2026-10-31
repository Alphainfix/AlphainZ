import React, { useCallback, useState } from 'react';

import { getPref, setPref } from '../../../src/utils/prefs';
import {
    AUTO_OUTPUT_TOKENS,
    DEFAULT_MAX_LIBRARY_SEARCHES,
    DEFAULT_MAX_LITERATURE_LOOKUPS,
    DEFAULT_MAX_MODEL_REQUESTS,
    NO_SEARCH_LIMIT,
} from '../../../src/services/llm/runLimits';
import { SettingsGroup, SettingsRow } from './components/SettingsElements';

type LimitPref = 'maxOutputTokens' | 'maxModelRequests' | 'maxLibrarySearches' | 'maxLiteratureLookups';

interface Choice {
    value: number;
    label: string;
}

const OUTPUT_TOKEN_CHOICES: Choice[] = [
    { value: AUTO_OUTPUT_TOKENS, label: 'Auto (provider default)' },
    { value: 8_000, label: '8k tokens' },
    { value: 16_000, label: '16k tokens' },
    { value: 32_000, label: '32k tokens' },
    { value: 64_000, label: '64k tokens' },
    { value: 128_000, label: '128k tokens' },
];

const MODEL_REQUEST_CHOICES: Choice[] = [12, 24, 40, 60, 100].map((n) => ({ value: n, label: `${n} requests` }));

const LIBRARY_SEARCH_CHOICES: Choice[] = [
    ...[10, 20].map((n) => ({ value: n, label: `${n} searches` })),
    { value: NO_SEARCH_LIMIT, label: 'No limit' },
];

const LITERATURE_LOOKUP_CHOICES: Choice[] = [
    ...[10, 20].map((n) => ({ value: n, label: `${n} lookups` })),
    { value: NO_SEARCH_LIMIT, label: 'No limit' },
];

function readStored(key: LimitPref, fallback: number): number {
    const raw = Number(getPref(key));
    return Number.isFinite(raw) ? Math.round(raw) : fallback;
}

/**
 * The stored value may not be one of the offered choices — set on another
 * machine, or by hand. It is shown as its own entry rather than silently
 * displayed as the first option, which would misreport what the next run uses.
 */
function withStored(choices: Choice[], stored: number, unit: string): Choice[] {
    return choices.some((choice) => choice.value === stored)
        ? choices
        : [...choices, { value: stored, label: `${stored.toLocaleString()} ${unit} (custom)` }];
}

function useLimitPref(key: LimitPref, fallback: number): [number, (value: number) => void] {
    const [value, setValue] = useState(() => readStored(key, fallback));
    const update = useCallback((next: number) => {
        setPref(key, next);
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
 */
const RunLimitsSection: React.FC = () => {
    const [outputTokens, setOutputTokens] = useLimitPref('maxOutputTokens', AUTO_OUTPUT_TOKENS);
    const [modelRequests, setModelRequests] = useLimitPref('maxModelRequests', DEFAULT_MAX_MODEL_REQUESTS);
    const [librarySearches, setLibrarySearches] = useLimitPref('maxLibrarySearches', DEFAULT_MAX_LIBRARY_SEARCHES);
    const [literatureLookups, setLiteratureLookups] = useLimitPref('maxLiteratureLookups', DEFAULT_MAX_LITERATURE_LOOKUPS);

    return (
        <>
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">Limits per Question</div>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Ceilings, not charges: you pay only for what a question actually uses. They exist so
                a model that keeps rephrasing or thinking cannot run on without end. Changes apply
                from the next message.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="Output tokens per reply"
                    description="The most one reply may spend, and a thinking model's reasoning counts against it — too low and a turn can end mid-thought with nothing to show. Auto is 32k for DeepSeek, GLM, OpenRouter and OpenAI (16k for gpt-4o), 4k for Ollama, 8k for a provider you add, or the Max output set for the model on its card; a higher choice is held to what the provider accepts."
                    control={
                        <LimitSelect
                            label="Output tokens per reply"
                            value={outputTokens}
                            choices={withStored(OUTPUT_TOKEN_CHOICES, outputTokens, 'tokens')}
                            onChange={setOutputTokens}
                        />
                    }
                />
                <SettingsRow
                    title="Model requests per question"
                    description="Every step — a search, a page read, a proposed highlight — is one request. A question that reaches the limit stops and says so; ask it to continue."
                    control={
                        <LimitSelect
                            label="Model requests per question"
                            value={modelRequests}
                            choices={withStored(MODEL_REQUEST_CHOICES, modelRequests, 'requests')}
                            onChange={setModelRequests}
                        />
                    }
                />
                <SettingsRow
                    title="Library searches per question"
                    description="Topic, keyword and full-text searches of your library, together. With no limit, the request limit above still ends the question."
                    control={
                        <LimitSelect
                            label="Library searches per question"
                            value={librarySearches}
                            choices={withStored(LIBRARY_SEARCH_CHOICES, librarySearches, 'searches')}
                            onChange={setLibrarySearches}
                        />
                    }
                />
                <SettingsRow
                    title="Literature lookups per question"
                    description="OpenAlex searches, DOI lookups and citation walks, together. With no limit, the request limit above still ends the question."
                    control={
                        <LimitSelect
                            label="Literature lookups per question"
                            value={literatureLookups}
                            choices={withStored(LITERATURE_LOOKUP_CHOICES, literatureLookups, 'lookups')}
                            onChange={setLiteratureLookups}
                        />
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default RunLimitsSection;
