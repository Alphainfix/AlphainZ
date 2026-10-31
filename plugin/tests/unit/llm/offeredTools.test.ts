/**
 * The tools a run offers and what the model is told about them agree.
 *
 * - Every tool the system prompt, the message preamble or a tool description
 *   names is one the run actually offers.
 * - A model that cannot read images is offered no image tools, and its prompt
 *   says so instead of describing them.
 * - With changes to the library turned off, the prompt says so and where to
 *   turn them on — the same way on every turn.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({} as Record<string, unknown>));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { buildAgentFromPrefs, buildAgentSystemPrompt, resetSemanticSearchProbe } from '../../../src/services/llm/agentConfig';
import { buildSystemPrompt, LIBRARY_WRITES_SETTING } from '../../../src/services/llm/systemPrompt';
import { describePromptContext } from '../../../src/services/llm/runRequestToMessages';
import { TOOL_SPECS } from '../../../src/services/llm/toolSchemas';
import { writeCustomEndpoints } from '../../../src/services/llm/customEndpoints';
import { writeProviderOverrides } from '../../../src/services/llm/providerOverrides';
import { resetDeclaredVision, resetProbedVision } from '../../../src/services/llm/openAICompatible';
import {
    ASK_USER_QUESTION_TOOL,
    FULLTEXT_TOOL_SCHEMA,
    LITERATURE_GRAPH_TOOLS,
    RETURN_SUGGESTIONS_TOOL,
    WRITE_TOOL_SCHEMAS,
} from '../../../src/services/llm/writeTools';

/** Tools a run adds beside the library ones (see executeLocalRequest). */
const RUN_EXTRAS = [
    'search_web_literature',
    ASK_USER_QUESTION_TOOL.name,
    RETURN_SUGGESTIONS_TOOL.name,
    ...LITERATURE_GRAPH_TOOLS.map((tool) => tool.name),
    FULLTEXT_TOOL_SCHEMA.name,
];
const WRITE_NAMES = WRITE_TOOL_SCHEMAS.map((tool) => tool.name);
const KNOWN_TOOLS = new Set([...TOOL_SPECS.map((spec) => spec.name), ...RUN_EXTRAS, ...WRITE_NAMES]);

/** Every known tool a text mentions by name. */
function toolsNamedIn(text: string): string[] {
    return [...new Set([...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]))]
        .filter((name) => KNOWN_TOOLS.has(name));
}

const toolNames = (result: ReturnType<typeof buildAgentFromPrefs>) =>
    result.ok ? result.tools.map((tool) => tool.name) : [];

const IMAGE_TOOL_NAMES = ['view_page_images', 'view_attachment_image'];

beforeEach(() => {
    for (const key of Object.keys(prefs)) delete prefs[key];
    resetSemanticSearchProbe();
    resetDeclaredVision();
    resetProbedVision();
});

/** A model that reads images, writes on, and topic search ready: everything offered. */
function everythingOn() {
    prefs.llmProvider = 'deepseek';
    prefs.llmModel = 'deepseek-flash';
    prefs.llmKeyDeepseek = 'k';
    prefs.embeddingProvider = 'openai';
    prefs.llmKeyOpenai = 'k';
    prefs.allowAgentWrites = true;
}

describe('every tool the model is told about is offered', () => {
    it('in the system prompt, the message preamble and the tool descriptions', () => {
        everythingOn();
        const built = buildAgentFromPrefs(vi.fn() as any);
        expect(built.ok).toBe(true);
        const offered = new Set([...toolNames(built), ...RUN_EXTRAS, ...WRITE_NAMES]);

        const preamble = describePromptContext({
            content: 'What does this figure show, and what else did I mark?',
            attachments: [
                {
                    type: 'annotation', annotation_type: 'image', library_id: 1, library_ref: 'u',
                    zotero_key: 'FIG12345', parent_key: 'PDF12345', page_label: '7',
                    position: { page_index: 6, rects: [[0, 0, 10, 10]] },
                },
                { type: 'annotation', annotation_type: 'highlight', library_ref: 'u', zotero_key: 'H1', text: 'a', page_label: '2' },
                {
                    type: 'source', library_id: 1, library_ref: 'u', zotero_key: 'IMG12345',
                    attachment: { attachment_id: 'u-IMG12345', content_kind: 'image', filename: 'setup.png' },
                },
            ],
            application_state: { reader_state: { library_ref: 'u', zotero_key: 'PDF12345', current_page: 7, annotation_count: 30 } },
        } as any) ?? '';

        const texts = [
            buildAgentSystemPrompt(),
            preamble,
            ...(built.ok ? built.tools.map((tool) => tool.description) : []),
            ...WRITE_TOOL_SCHEMAS.map((tool) => tool.description),
        ];
        const named = new Set(texts.flatMap(toolsNamedIn));
        // The preamble's two are the ones that used to be named and never offered.
        expect(named.has('get_annotations')).toBe(true);
        expect(named.has('view_attachment_image')).toBe(true);
        expect([...named].filter((name) => !offered.has(name))).toEqual([]);
    });

    it('offers the rest of a paper\'s highlights and an attached picture to a model that reads images', () => {
        everythingOn();
        const names = toolNames(buildAgentFromPrefs(vi.fn() as any));
        expect(names).toEqual(expect.arrayContaining(['get_annotations', 'view_attachment_image', 'view_page_images']));
    });
});

describe('a model that reads text only', () => {
    it('gets no image tools, and a prompt that says it cannot read images', () => {
        // Ollama's chat models are declared text-only.
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'qwen3:8b';
        const built = buildAgentFromPrefs(vi.fn() as any);
        expect(built.ok && built.readsImages).toBe(false);
        const names = toolNames(built);
        for (const name of IMAGE_TOOL_NAMES) expect(names).not.toContain(name);
        // Reading text is untouched.
        expect(names).toEqual(expect.arrayContaining(['read_document', 'search_in_document', 'get_annotations']));

        const prompt = buildAgentSystemPrompt();
        expect(prompt).not.toContain('- `view_page_images`');
        expect(prompt).toContain('reads text only');
        expect(prompt).toContain('reads figures');
        expect(buildAgentSystemPrompt()).toBe(prompt);
    });

    it('includes a hand-added model left without "Reads figures", and not one with it', () => {
        writeCustomEndpoints([{
            id: 'ep-1', name: 'Lab box', baseUrl: 'http://10.0.0.2:8000/v1', apiKey: '', authStyle: 'bearer',
            models: [
                { id: 'text-model', supportsVision: false, reasoningEffort: false },
                { id: 'vision-model', supportsVision: true, reasoningEffort: false },
            ],
        }] as any);
        prefs.llmProvider = 'custom:ep-1';

        prefs.llmModel = 'text-model';
        expect(toolNames(buildAgentFromPrefs(vi.fn() as any))).not.toContain('view_page_images');
        expect(buildAgentSystemPrompt()).toContain('reads text only');

        prefs.llmModel = 'vision-model';
        expect(toolNames(buildAgentFromPrefs(vi.fn() as any))).toEqual(expect.arrayContaining(IMAGE_TOOL_NAMES));
        expect(buildAgentSystemPrompt()).toContain('- `view_page_images`');
    });

    it('follows a "reads figures" flag declared in a provider\'s catalogue', () => {
        writeProviderOverrides({ ollama: { models: [{ id: 'llava:13b', supportsVision: true }] } });
        prefs.llmProvider = 'ollama';
        prefs.llmModel = 'llava:13b';
        expect(toolNames(buildAgentFromPrefs(vi.fn() as any))).toEqual(expect.arrayContaining(IMAGE_TOOL_NAMES));
        expect(buildAgentSystemPrompt()).not.toContain('reads text only');
    });
});

describe('with changes to the library turned off', () => {
    beforeEach(() => {
        prefs.llmProvider = 'deepseek';
        prefs.llmModel = 'deepseek-flash';
        prefs.llmKeyDeepseek = 'k';
    });

    it('says so, and where to turn them on — writes are off by default', () => {
        const prompt = buildAgentSystemPrompt();
        expect(prompt).toContain('## Changes to the library are turned off');
        expect(prompt).toContain(`can be turned on under ${LIBRARY_WRITES_SETTING},`);
        // A configuration fact, not a per-turn one: the first message of every
        // request stays byte-for-byte the same.
        expect(buildAgentSystemPrompt()).toBe(prompt);
    });

    it('sends the user to the tab and section where the switch is', () => {
        // The Permissions tab's per-kind rules do nothing while the switch is
        // off, so a pointer that lands there leaves the user stuck.
        const [root, tab, section] = LIBRARY_WRITES_SETTING.split(' → ');
        expect(root).toBe('Settings');
        const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
        expect(read('react/components/preferences/PreferencePage.tsx')).toContain(`label: '${tab}'`);
        const tabSource: Record<string, string> = {
            Model: 'react/components/preferences/ModelSettingsSection.tsx',
            Permissions: 'react/components/preferences/PermissionsSection.tsx',
        };
        expect(Object.keys(tabSource)).toContain(tab);
        const source = read(tabSource[tab]);
        expect(source).toContain("setPref('allowAgentWrites'");
        expect(source).toContain(`>${section}<`);
    });

    it('says nothing of the kind once they are on', () => {
        prefs.allowAgentWrites = true;
        expect(buildAgentSystemPrompt()).not.toContain('turned off');
    });

    it('leaves the prompt for a model that reads images, with writes on, as it was', () => {
        prefs.allowAgentWrites = true;
        expect(buildAgentSystemPrompt()).toBe(buildSystemPrompt({ semanticSearchAvailable: false }));
    });
});
