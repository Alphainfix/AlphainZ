/**
 * The settings the model layer keeps: the chosen provider and model, custom
 * endpoints, per-provider overrides, and a few caches.
 *
 * They are read and written through the host's runtime adapter by their
 * unqualified keys, so the host decides where they live: the Zotero plugin
 * keeps them in Zotero's preferences, another client in its own settings
 * store. Every value is a string; a JSON-valued setting is parsed by the
 * module that owns it.
 */
import { getRuntimeAdapter } from '@beaver/agent-core/platform/runtime';

export interface LlmPrefsMap {
    llmProvider: string;
    llmModel: string;
    customEndpoints: string;
    providerOverrides: string;
    visionProbeCache: string;
    embeddingHealth: string;
    embeddingQuota: string;
}

/** Read a setting. A host with no settings store reads as unset. */
export function getPref<K extends keyof LlmPrefsMap>(key: K): LlmPrefsMap[K];
/** Read a setting whose key is computed; the caller validates the value. */
export function getPref(key: string): unknown;
export function getPref(key: string): unknown {
    return getRuntimeAdapter().getPluginPref?.(key);
}

/**
 * Write a setting. Throws when the host keeps no settings: a lost write is a
 * lost user choice, which is worse than an error at the source.
 */
export function setPref<K extends keyof LlmPrefsMap>(key: K, value: LlmPrefsMap[K]): void {
    const adapter = getRuntimeAdapter();
    if (!adapter.setPluginPref) {
        throw new Error(`The host keeps no settings; cannot write "${key}".`);
    }
    adapter.setPluginPref(key, value);
}
