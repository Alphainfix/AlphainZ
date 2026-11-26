/**
 * The vendors this plugin ships keys for, and the providers each key unlocks.
 *
 * One entry per key, not per provider: DeepSeek's text and vision models share
 * a key, so asking for it twice would be asking the same question twice.
 * Shared by the provider cards in Settings → Model and the first-run wizard.
 */

import { PROVIDER_PRESETS } from '../../../src/services/llm/openAICompatible';
import { msg } from '../../../src/utils/i18n';

export type ProviderId = keyof typeof PROVIDER_PRESETS;
export type KeyPrefName = 'llmKeyDeepseek' | 'llmKeyOpenai' | 'llmKeyOpenrouter' | 'llmKeyZhipu' | 'llmKeyGoogle';

interface VendorProvider {
    id: ProviderId;
    /**
     * Models to offer here, when the preset's own list is not the right menu.
     *
     * DeepSeek's text preset lists the vision model as well, but choosing it
     * there would run a vision model without the vision message shape — so
     * vision is offered only under its own preset, and named as such.
     */
    models?: string[];
}

export interface Vendor {
    id: string;
    label: string;
    keyPref: KeyPrefName;
    /** Providers that become usable once this key is present. */
    providers: VendorProvider[];
    keyUrl?: string;
    /** One line, for narrow places (the welcome wizard in the side pane). English; shown through `t`. */
    summary?: string;
    /** The fuller description the provider card shows. English; shown through `t`. */
    note?: string;
}

/**
 * One entry per key, not per provider.
 *
 * DeepSeek's text and vision models share a key, so asking for it twice would
 * be asking the same question twice.
 */
export const VENDORS: Vendor[] = [
    {
        id: 'deepseek',
        label: 'DeepSeek',
        keyPref: 'llmKeyDeepseek',
        providers: [{ id: 'deepseek' }],
        keyUrl: 'https://platform.deepseek.com/api_keys',
        summary: msg('The recommended first pick: reads figures, calls tools, low price.'),
        note: msg('deepseek-flash — DeepSeek V4.1 Flash: 1M context, reads figures, calls tools. $0.15/M in · '
            + '$0.60/M out, twice that at peak hours (weekdays 01:00–04:00 and 06:00–10:00 UTC). A stored '
            + 'choice of a retired V4 model runs as deepseek-flash.'),
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        keyPref: 'llmKeyOpenrouter',
        providers: [{ id: 'openrouter' }],
        keyUrl: 'https://openrouter.ai/keys',
        summary: msg('GLM 5.3 Flash and DeepSeek V4.1 Flash behind one key.'),
        note: msg('Reaches GLM 5.3 Flash (1.3M context, reads figures, ~$0.08/M in) and DeepSeek V4.1 Flash '
            + '(1M context, reads figures, $0.15/M in · $0.60/M out, no peak hours). Both call tools.'),
    },
    {
        id: 'zhipu',
        label: msg('Zhipu (BigModel)'),
        keyPref: 'llmKeyZhipu',
        providers: [{ id: 'zhipu' }],
        keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
        summary: msg('GLM 5.3 Flash from Zhipu directly.'),
        note: msg('GLM 5.3 Flash from Zhipu directly — 1M context, reads figures, calls tools.'),
    },
    {
        id: 'google',
        label: 'Google Gemini',
        keyPref: 'llmKeyGoogle',
        providers: [{ id: 'google' }],
        keyUrl: 'https://aistudio.google.com/apikey',
        summary: msg('Gemini 3.8 Flash and 4 Argon; the same key runs Gemini Embedding for topic search.'),
        note: msg('Gemini 3.8 Flash (the default; $0.75/M in · $3.75/M out until 31 Dec 2026, then double), '
            + '3.5 Flash-Lite ($0.30/M in · $2.50/M out) and 4 Argon ($2/M in · $10/M out until 30 Nov 2026, '
            + 'then double). All read figures, call tools and think before they answer. The same key runs '
            + 'Gemini Embedding 2 for topic and full-text search. A key from a project without billing is '
            + 'free but tightly limited, and Google may use what it is sent to improve its products.'),
    },
    {
        id: 'openai',
        label: 'OpenAI',
        keyPref: 'llmKeyOpenai',
        providers: [{ id: 'openai' }],
        keyUrl: 'https://platform.openai.com/api-keys',
        summary: msg('GPT-4o and GPT-4o mini.'),
    },
];

