/**
 * The Zotero side of the shared model settings (@beaver/agent-ui/settings):
 * they read and write Zotero's preferences, reach the network through the
 * window's `fetch`, ask with Zotero's dialogs, and rebuild the model list
 * through the model atoms. Every settings component that comes from the shared
 * package is rendered inside {@link ZoteroSettingsHost}.
 */
import React, { useMemo, type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    SettingsHostProvider,
    type OllamaService,
    type OllamaStatus,
    type SettingsHost,
} from '@beaver/agent-ui/settings/host';

import { getPref, setPref } from '../../../src/utils/prefs';
import { conversationSyncMode } from '../../../src/services/conversationSync';
import {
    boundFetch,
    migrateLegacyBaseUrl,
    ollamaBaseUrlFromPrefs,
    refreshSemanticSearchAvailability,
    resetSemanticSearchProbe,
} from '../../../src/services/llm/agentConfig';
import {
    availableModelsAtom,
    modelAfterRemoving,
    ollamaModelsFromPrefs,
    refreshLocalModelAtom,
    releaseRemovedProvidersAtom,
} from '../../atoms/models';
import { copyToClipboard } from '../../utils/clipboard';
import {
    OLLAMA_MODELS,
    cancelOllamaPull,
    isModelInstalled,
    isOllamaEmbeddingModel,
    normalizeOllamaBase,
    ollamaChatModels,
    ollamaPullState,
    ollamaPullsVersion,
    ollamaStatus,
    ollamaVersionAtLeast,
    onOllamaStatus,
    publishOllamaStatus,
    pullCommand,
    startOllamaPull,
    subscribeOllamaPulls,
} from '../../utils/ollama';
import { t } from '../../../src/utils/i18n';

const ollamaFetch = (url: string, init?: any) => fetch(url, init);

/**
 * Record what an Ollama has, wherever it was read.
 *
 * The chat models go to the preference the model picker is built from; an
 * embedding-only model is left out, since it cannot answer a question and
 * would otherwise be listed, and even picked, as a chat model. The topic
 * search probe is asked again, so an index waiting for Ollama or for its
 * embedding model starts as soon as it can. Every open guide then hears the news.
 */
export async function recordOllamaStatus(base: string, status: OllamaStatus): Promise<void> {
    if (status.running) {
        setPref('ollamaModels', JSON.stringify(ollamaChatModels(status.models, status.capabilities)));
    }
    resetSemanticSearchProbe();
    try {
        await refreshSemanticSearchAvailability();
    } catch {
        // The next run probes again.
    }
    publishOllamaStatus(base, status);
}

/** Read an Ollama's status and record it. */
export async function refreshOllamaStatus(
    base: string,
    fetchImpl: (url: string, init?: any) => Promise<any> = ollamaFetch,
): Promise<OllamaStatus> {
    const status = await ollamaStatus(base, fetchImpl);
    await recordOllamaStatus(base, status);
    return status;
}

/** Ollama as this plugin talks to it (react/utils/ollama). */
const ZOTERO_OLLAMA: OllamaService = {
    models: OLLAMA_MODELS,
    normalizeBase: normalizeOllamaBase,
    isEmbeddingModel: isOllamaEmbeddingModel,
    isModelInstalled,
    versionAtLeast: ollamaVersionAtLeast,
    pullCommand,
    refreshStatus: (base, fetchImpl) => refreshOllamaStatus(base, fetchImpl),
    onStatus: onOllamaStatus,
    startPull: startOllamaPull,
    cancelPull: cancelOllamaPull,
    pullState: ollamaPullState,
    subscribePulls: subscribeOllamaPulls,
    pullsVersion: ollamaPullsVersion,
};

/** A blocking Zotero confirm dialog; with no dialog to show, the answer is yes. */
const confirmDialog = (title: string, text: string, button0: string): boolean => {
    if (typeof (Zotero as any)?.Prompt?.confirm !== 'function') return true;
    return Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text,
        button0,
        button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
        defaultButton: 1,
    }) === 0;
};

/** Provides the Zotero {@link SettingsHost} to the shared settings inside it. */
export const ZoteroSettingsHost: React.FC<{ children: ReactNode }> = ({ children }) => {
    const availableModels = useAtomValue(availableModelsAtom);
    const refreshLocalModel = useSetAtom(refreshLocalModelAtom);
    const releaseRemovedProviders = useSetAtom(releaseRemovedProvidersAtom);
    const host = useMemo<SettingsHost>(() => ({
        getPref: (key) => getPref(key as any),
        setPref: (key, value) => setPref(key as any, value as any),
        fetch: boundFetch as any,
        confirm: confirmDialog,
        openUrl: (url) => Zotero.launchURL(url),
        copyText: (text) => copyToClipboard(text),
        models: {
            refresh: () => refreshLocalModel(),
            releaseRemoved: (providerIds) => releaseRemovedProviders(providerIds),
            afterRemoving: (providerIds) => modelAfterRemoving(providerIds),
            ollamaModels: ollamaModelsFromPrefs,
        },
        ollama: ZOTERO_OLLAMA,
        ollamaBaseUrl: ollamaBaseUrlFromPrefs,
        migrateLegacyBaseUrl,
        // The model choice is among the settings that sync; keys and providers are not.
        choiceTravelsNote: () => (conversationSyncMode() !== 'off'
            ? t('With settings sync on, your other computers switch to it too, so it has to be set up on each of them.')
            : ''),
        keysNote: t('Keys, addresses and catalogues stay on this computer. With settings sync on, the choice of model travels to your other computers and the keys do not, so each computer needs its own. Keys are kept as plain text in Zotero\'s preferences: anyone who can read your Zotero profile folder can read them.'),
    }), [refreshLocalModel, releaseRemovedProviders]);
    return (
        <SettingsHostProvider host={host} modelsVersion={availableModels}>
            {children}
        </SettingsHostProvider>
    );
};
