/**
 * Dev-only: run the Check that the settings page offers, for any provider.
 *
 * The plugin never probes on its own — the user presses Check — so this is how
 * a script sees what a Check would conclude, for a preset model (verdict kept
 * beside the presets) or a hand-added one (its own "reads figures" switch set).
 */

import { checkModelVision, keyPrefForProvider } from '../../../src/services/llm/agentConfig';
import { fetchModelIds } from '@beaver/agent-llm/listModels';
import { baseUrlOverrideFor } from '@beaver/agent-llm/providerOverrides';
import { findCustomEndpoint } from '@beaver/agent-llm/customEndpoints';
import { PROVIDER_PRESETS, presetSupportsVision, type ProviderPresetId } from '@beaver/agent-llm/openAICompatible';
import { customModelCapabilities, isCustomProviderId } from '@beaver/agent-llm/customEndpoints';
import { getPref } from '../../../src/utils/prefs';

const trimmed = (key: any): string => {
    const value = getPref(key);
    return typeof value === 'string' ? value.trim() : '';
};

/** Body: { provider?, model? } — defaults to the configured pair. Always asks the endpoint. */
export async function handleTestVisionProbeHttpRequest(request: any): Promise<any> {
    const provider = typeof request?.provider === 'string' && request.provider ? request.provider : trimmed('llmProvider');
    const model = typeof request?.model === 'string' && request.model ? request.model : trimmed('llmModel');
    if (!provider || (!isCustomProviderId(provider) && !(provider in PROVIDER_PRESETS))) {
        return { ok: false, error: `unknown provider "${provider}"` };
    }
    if (!model) return { ok: false, error: 'model is required' };
    const result = await checkModelVision(provider, model);
    const supportsVisionNow = isCustomProviderId(provider)
        ? customModelCapabilities(provider, model)?.supportsVision === true
        : presetSupportsVision(provider as ProviderPresetId, model) === true;
    return {
        ok: true,
        provider,
        model,
        verdict: result.verdict,
        applied: result.applied,
        supports_vision_now: supportsVisionNow,
    };
}

/**
 * Body: { provider? } — what "Fetch available models" would list for a
 * provider: a preset (its key, its address override if any) or a custom one.
 */
export async function handleTestListModelsHttpRequest(request: any): Promise<any> {
    const provider = typeof request?.provider === 'string' && request.provider ? request.provider : trimmed('llmProvider');
    try {
        if (isCustomProviderId(provider)) {
            const endpoint = findCustomEndpoint(provider);
            if (!endpoint) return { ok: false, error: `no custom endpoint for "${provider}"` };
            const models = await fetchModelIds({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, authStyle: endpoint.authStyle }, fetch as any);
            return { ok: true, provider, base_url: endpoint.baseUrl, models };
        }
        if (!(provider in PROVIDER_PRESETS)) return { ok: false, error: `unknown provider "${provider}"` };
        const preset = PROVIDER_PRESETS[provider as ProviderPresetId] as { baseUrl: string; authStyle?: 'bearer' | 'x-api-key' };
        const keyPref = keyPrefForProvider(provider);
        const apiKey = keyPref ? trimmed(keyPref) : '';
        const baseUrl = baseUrlOverrideFor(provider) || preset.baseUrl;
        const models = await fetchModelIds({ baseUrl, apiKey, authStyle: preset.authStyle }, fetch as any);
        return { ok: true, provider, base_url: baseUrl, key_length: apiKey.length, models };
    } catch (error) {
        return { ok: false, provider, error: error instanceof Error ? error.message : String(error) };
    }
}
