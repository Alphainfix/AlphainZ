/**
 * The model picker's list, as data.
 *
 * Two lists feed it — the presets derived from the stored keys, and whatever
 * the user typed into the custom-provider editor — and for a while it showed
 * both raw. Anyone who had configured DeepSeek by hand before the presets
 * existed saw each of its models twice under two different names, and the
 * vision model three times, of which only one row actually sent vision
 * messages.
 */
import { describe, expect, it } from 'vitest';

import {
    dedupeByEndpoint,
    rowLabel,
    vendorFor,
    VENDOR_ORDER,
} from '../../../react/components/ui/buttons/ModelSelectionButton';
import type { ModelConfig } from '../../../react/atoms/models';

const preset = (provider: string, snapshot: string): ModelConfig =>
    ({
        id: `local-${provider}::${snapshot}`,
        provider,
        name: `${provider} · ${snapshot}`,
        snapshot,
        is_custom: true,
        allow_byok: true,
        allow_app_key: false,
        credit_cost: 0,
        is_default: false,
    }) as ModelConfig;

const handAdded = (name: string, snapshot: string, apiBase: string): ModelConfig =>
    ({
        id: `custom:custom:${snapshot}:${name}`,
        provider: 'custom',
        name,
        snapshot,
        is_custom: true,
        allow_byok: true,
        allow_app_key: false,
        credit_cost: 0,
        is_default: false,
        custom_model: { api_base: apiBase, format: 'openai', api_key: 'x', name, snapshot },
    }) as unknown as ModelConfig;

describe('model picker grouping', () => {
    it('drops a hand-added entry that names the same endpoint and model', () => {
        const models = [
            preset('deepseek', 'deepseek-flash'),
            handAdded('Deepseek V4 Flash', 'deepseek-flash', 'https://api.deepseek.com'),
        ];
        const kept = dedupeByEndpoint(models);
        expect(kept).toHaveLength(1);
        // The preset wins: it carries the endpoint's quirks, which a
        // hand-typed base URL does not.
        expect(kept[0].provider).toBe('deepseek');
    });

    it('keeps a hand-added entry that points somewhere no preset does', () => {
        const models = [
            preset('deepseek', 'deepseek-flash'),
            handAdded('My proxy', 'deepseek-flash', 'https://proxy.example.com/v1'),
        ];
        expect(dedupeByEndpoint(models)).toHaveLength(2);
    });

    it('keeps two models from the same vendor apart', () => {
        const models = [preset('deepseek', 'deepseek-flash'), preset('deepseek', 'deepseek-v4-pro')];
        expect(dedupeByEndpoint(models)).toHaveLength(2);
    });

    it('files a preset\'s models under its vendor heading', () => {
        expect(vendorFor(preset('deepseek', 'deepseek-flash'))).toBe('DeepSeek');
        expect(vendorFor(preset('openrouter', 'z-ai/glm-5.3-flash'))).toBe('OpenRouter');
    });

    it('gives the Zhipu preset its own heading instead of filing it under "Added by you"', () => {
        const vendor = vendorFor(preset('zhipu', 'glm-5.3-flash'));
        expect(vendor).toBe('Zhipu (BigModel)');
        expect(VENDOR_ORDER.indexOf(vendor)).toBeLessThan(VENDOR_ORDER.indexOf('Added by you'));
    });

    it('files anything unrecognised under a heading that still sorts last', () => {
        const vendor = vendorFor(handAdded('My proxy', 'x', 'https://proxy.example.com/v1'));
        expect(VENDOR_ORDER.indexOf(vendor)).toBe(VENDOR_ORDER.length - 1);
    });

    it('describes the model, not the gateway', () => {
        // Both OpenRouter models read figures now; a text-only local model does
        // not, and a hand-added entry with no preset says nothing it cannot know.
        expect(rowLabel(preset('openrouter', 'z-ai/glm-5.3-flash'))).toContain('reads figures');
        expect(rowLabel(preset('openrouter', 'deepseek/deepseek-v4.1-flash'))).toContain('reads figures');
        expect(rowLabel(preset('ollama', 'qwen2.5:7b'))).toBe('qwen2.5:7b');
        expect(rowLabel(handAdded('My proxy', 'x', 'https://proxy.example.com/v1'))).toBe('x');
    });

    it('names a row by its model id, and says which one reads figures', () => {
        expect(rowLabel(preset('deepseek', 'deepseek-flash'))).toBe('deepseek-flash · reads figures');
    });
});
