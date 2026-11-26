import React, { useState } from 'react';
import { SettingsGroup, SettingsRow } from '../../../preferences/components/SettingsElements';
import { EMBEDDING_OPTIONS } from '../../../preferences/ModelSettingsSection';
import { getPref, setPref } from '../../../../../src/utils/prefs';
import { embeddingKeyFor } from '../../../../../src/services/llm/agentConfig';
import { OllamaGuide } from '../../../preferences/OllamaGuide';
import { t } from '../../../../../src/utils/i18n';

/**
 * Step ③: whether the library gets a meaning-based index.
 *
 * The honest version of the trade: it is what makes "find me papers about X"
 * work at all, it costs embedding tokens (except Ollama), and it is entirely
 * optional — keyword search keeps working without it.
 */
const IndexStep: React.FC = () => {
    const wasAlreadySet = React.useMemo(
        () => String(getPref('embeddingProvider') ?? '').trim().length > 0, [],
    );
    const [provider, setProvider] = useState(() => String(getPref('embeddingProvider') ?? ''));

    const choose = (id: string) => {
        setProvider(id);
        setPref('embeddingProvider', id);
    };

    return (
        <>
            <div className="text-base font-color-secondary mb-2">
                {t('The search index is what lets the agent find papers by meaning, not just by keyword. It reads titles, abstracts and PDF text through an embedding model — that costs a small amount of that provider\'s quota (Ollama runs locally and is free). Skip it and keyword search still works.')}
                {wasAlreadySet && <span className="font-color-green">{' '}{t('Already set ✓')}</span>}
            </div>
            <SettingsGroup>
                {EMBEDDING_OPTIONS.map((option) => (
                    <SettingsRow
                        key={option.id || 'off'}
                        title={t(option.label)}
                        description={option.id === '' ? '' : option.id === 'ollama'
                            ? t('Free, and nothing leaves this computer — needs the Ollama app (0.40 or later) and '
                                + 'the EmbeddingGemma 2 model, 671 MB (set up below)')
                            : option.keyPref && !embeddingKeyFor(option.id)
                                ? t('Needs that vendor’s API key (step 1)')
                                : option.id === 'google'
                                    ? t('Gemini Embedding 2, with the Google key from the Gemini card in step 1')
                                    : ''}
                        onClick={() => choose(option.id)}
                        control={<input type="radio" name="wizard-embedding" aria-label={t(option.label)}
                            checked={provider === option.id}
                            onChange={() => choose(option.id)}
                            onClick={(e) => e.stopPropagation()} />}
                    />
                ))}
            </SettingsGroup>
            {provider === 'ollama' && (
                <div className="mt-2">
                    <OllamaGuide showEmbedding compact />
                </div>
            )}
        </>
    );
};

export default IndexStep;
