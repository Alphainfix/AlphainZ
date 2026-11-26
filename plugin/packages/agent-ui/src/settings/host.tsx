/**
 * What the shared settings components need from the client that shows them.
 *
 * The provider cards, the Ollama guide and the other model settings are the
 * same in every client; where settings are stored, how a request reaches the
 * network, how a dialog asks for confirmation and how the client's model list
 * is rebuilt are not. Each client provides those once, around the settings it
 * shows, with {@link SettingsHostProvider}.
 */
import React, { createContext, useContext, type ReactNode } from 'react';

/** `fetch` as the settings use it: a key test, a model list, Ollama. */
export type SettingsFetch = (url: string, init?: any) => Promise<any>;

/** What an Ollama server reported when it was last asked. */
export interface OllamaStatus {
    running: boolean;
    version: string | null;
    /** Every installed model, chat and embedding alike. */
    models: string[];
    /** What Ollama said each model can do (`completion`, `embedding`, `vision`…), when it said. */
    capabilities?: Record<string, string[]>;
    error?: string;
}

/** A model download started from the guide, as it stands. */
export interface OllamaPullState {
    status: 'pulling' | 'done' | 'error' | 'cancelled';
    percent: number | null;
    message?: string;
}

/** A model the guide offers to download. */
export interface OllamaModelOffer {
    name: string;
    role: 'chat' | 'embedding';
    /** As Ollama reports it, e.g. "4.7 GB". */
    size: string;
    /** Why this model, in English; shown through `t`. */
    purpose: string;
    /** The oldest Ollama that runs it, when that matters. */
    minOllama?: string;
}

/**
 * Talking to a local Ollama. A download belongs to the client, not to the
 * guide showing it: it keeps going when the guide closes, and any guide shows
 * its progress.
 */
export interface OllamaService {
    /** The models the guide offers. */
    readonly models: readonly OllamaModelOffer[];
    /** The server root: no trailing slash, never the `/v1` suffix; the local default when empty. */
    normalizeBase(raw?: string | null): string;
    /** Whether an installed model only embeds text (and so cannot chat). */
    isEmbeddingModel(tag: string, capabilities?: readonly string[]): boolean;
    isModelInstalled(installed: readonly string[], name: string): boolean;
    versionAtLeast(version: string | null | undefined, min: string): boolean;
    /** `ollama pull <name>`, for people who would rather use a terminal. */
    pullCommand(name: string): string;
    /** Ask a server what it has, record it (the model list, every listener) and return it. */
    refreshStatus(base: string, fetchImpl?: SettingsFetch): Promise<OllamaStatus>;
    /** Hear about every fresh read of a server; returns the unsubscribe. */
    onStatus(listener: (base: string, status: OllamaStatus) => void): () => void;
    startPull(
        base: string,
        name: string,
        options: { fetchImpl?: SettingsFetch; onFinished?: (status: OllamaPullState['status']) => void },
    ): void;
    cancelPull(base: string, name: string): void;
    pullState(base: string, name: string): OllamaPullState | undefined;
    /** Called whenever any download's state changes; returns the unsubscribe. */
    subscribePulls(listener: () => void): () => void;
    /** Changes whenever any download's state does. */
    pullsVersion(): number;
}

/** The client's list of models, the one its model picker shows. */
export interface SettingsModels {
    /** Rebuild the list from the settings, after a key, a catalogue or the model in use changed. */
    refresh(): void;
    /** After providers are removed on this computer: move a model choice that used one of them. */
    releaseRemoved(providerIds: readonly string[]): void;
    /** The model chosen once these providers are gone, or null when nothing else is set up. */
    afterRemoving(providerIds: readonly string[]): { name: string } | null;
    /** The Ollama chat models found on this computer. */
    ollamaModels(): string[];
}

export interface SettingsHost {
    /** A setting by its unqualified key (`llmProvider`, `llmKeyDeepseek`…); undefined when unset. */
    getPref(key: string): unknown;
    setPref(key: string, value: string | number | boolean): void;
    /** For the requests the settings make. */
    fetch: SettingsFetch;
    /**
     * Ask before something that cannot be undone. A client whose dialogs
     * block answers at once; one whose dialogs do not answers with a promise.
     */
    confirm(title: string, text: string, confirmLabel: string): boolean | Promise<boolean>;
    /** Open a web page in the user's browser. */
    openUrl(url: string): void;
    /** Copy text; resolves to whether it worked. */
    copyText(text: string): Promise<boolean>;
    models: SettingsModels;
    ollama: OllamaService;
    /** Ollama's address as set on its card, without a trailing slash; the local default when none is. */
    ollamaBaseUrl(): string;
    /**
     * Move an address that older versions applied to every provider onto the
     * provider it redirects. For a client that once had such a setting.
     */
    migrateLegacyBaseUrl?(): void;
    /**
     * What removing the provider in use also does on the user's other
     * computers, as a sentence; empty when it does nothing there.
     */
    choiceTravelsNote(): string;
    /** Under the provider cards: where keys, addresses and catalogues are kept. */
    keysNote: ReactNode;
}

const SettingsHostContext = createContext<SettingsHost | null>(null);
const ModelsVersionContext = createContext<unknown>(undefined);

/**
 * Provides the client's {@link SettingsHost} to the settings inside it.
 *
 * `host` should keep its identity from one render to the next: the settings
 * hold on to its functions the way they would hold on to any stable callback.
 * `modelsVersion` is what changes instead: any value that changes whenever the
 * client's model list is rebuilt, here or elsewhere (the picker beside the
 * message box, settings arriving from another computer), so the settings
 * follow what changed under them.
 */
export const SettingsHostProvider: React.FC<{ host: SettingsHost; modelsVersion?: unknown; children: ReactNode }> = ({
    host,
    modelsVersion,
    children,
}) => (
    <SettingsHostContext.Provider value={host}>
        <ModelsVersionContext.Provider value={modelsVersion}>{children}</ModelsVersionContext.Provider>
    </SettingsHostContext.Provider>
);

/** The client's {@link SettingsHost}; throws outside a {@link SettingsHostProvider}. */
export function useSettingsHost(): SettingsHost {
    const host = useContext(SettingsHostContext);
    if (!host) throw new Error('A settings component was rendered outside a SettingsHostProvider.');
    return host;
}

/** Changes whenever the client's model list is rebuilt (see {@link SettingsHostProvider}). */
export function useModelsVersion(): unknown {
    return useContext(ModelsVersionContext);
}

/**
 * Run `proceed` once `answer` says yes: at once for a dialog that blocks,
 * when the promise settles for one that does not.
 */
export function whenConfirmed(answer: boolean | Promise<boolean>, proceed: () => void): void {
    if (typeof answer === 'boolean') {
        if (answer) proceed();
        return;
    }
    // A dialog that fails to answer is a no.
    void answer.then(
        (yes) => {
            if (yes) proceed();
        },
        () => undefined,
    );
}
