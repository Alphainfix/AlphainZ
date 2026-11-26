/**
 * Whether a model reads images is asked of the endpoint, not assumed.
 *
 * DeepSeek routes retired ids to whatever answers for them and `deepseek-flash`
 * is itself a floating name; a flag pinned to an id can be wrong the day the
 * vendor moves it, so the Check button asks the endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    PROBE_CODE,
    PROBE_IMAGE_DATA_URL,
    PROBE_QUESTION,
    PROBE_VERSION,
    cachedVisionVerdict,
    judgeVisionAnswer,
    refreshVisionCapability,
    visionProbeApplies,
} from '@beaver/agent-llm/visionProbe';
import {
    presetSupportsVision,
    presetVisionByProbe,
    providerFromPreset,
    resetProbedVision,
} from '@beaver/agent-llm/openAICompatible';

/** A fetch that answers every chat completion with `text`, billed at `promptTokens`. */
function answering(text: string, status = 200, promptTokens = 160) {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        return {
            status,
            json: async () => (status === 200
                ? { choices: [{ message: { content: text } }], usage: { prompt_tokens: promptTokens } }
                : { error: { message: text } }),
        };
    });
    return { fetchImpl, calls };
}

const SEES = PROBE_CODE;
const BLIND = 'I am unable to view the image.';

beforeEach(() => {
    for (const key of Object.keys(prefs)) delete prefs[key];
    resetProbedVision();
});

describe('judgeVisionAnswer', () => {
    it('counts only the number in the picture as seeing', () => {
        expect(judgeVisionAnswer(200, PROBE_CODE)).toBe(true);
        expect(judgeVisionAnswer(200, `The number is ${PROBE_CODE}.`, 159)).toBe(true);
    });

    it('never lets the prompt give the number away', () => {
        expect(PROBE_QUESTION).not.toContain(PROBE_CODE);
    });

    it('reads "cannot see", "no image" and a made-up number as not seeing, even on 200', () => {
        // DeepSeek's text models answer an image request with 200 and either a
        // sentence about not seeing anything or a number they invented (1442,
        // 17 — observed live). Neither is this number.
        expect(judgeVisionAnswer(200, 'I am unable to view the image.')).toBe(false);
        expect(judgeVisionAnswer(200, 'NO IMAGE')).toBe(false);
        expect(judgeVisionAnswer(200, '1442')).toBe(false);
        expect(judgeVisionAnswer(200, `1${PROBE_CODE}`)).toBe(false);
    });

    it('trusts the bill over the words: a text-only prompt size means the image was dropped', () => {
        expect(judgeVisionAnswer(200, PROBE_CODE, 40)).toBe(false);
        expect(judgeVisionAnswer(200, PROBE_CODE, 217)).toBe(true);
        expect(judgeVisionAnswer(200, PROBE_CODE, null)).toBe(true);
    });

    it('never says yes to an error', () => {
        expect(judgeVisionAnswer(400, PROBE_CODE)).toBe(false);
    });
});

describe('which models are probed', () => {
    it('DeepSeek\'s preset may be asked about any of its models; declared-only presets are not', () => {
        expect(presetVisionByProbe('deepseek')).toBe(true);
        expect(visionProbeApplies('deepseek', 'deepseek-flash')).toBe(true);
        expect(visionProbeApplies('deepseek', 'some-hand-added-id')).toBe(true);
        expect(visionProbeApplies('openai', 'gpt-4o')).toBe(false);
        expect(visionProbeApplies('nonsense', 'x')).toBe(false);
        expect(visionProbeApplies('deepseek', '')).toBe(false);
    });

    it('starts from the preset\'s declared answer: deepseek-flash reads images, Ollama\'s models do not', () => {
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(true);
        expect(presetSupportsVision('ollama', 'qwen2.5:7b')).toBe(false);
    });
});

describe('refreshVisionCapability', () => {
    it('turns the preset\'s answer off when the model cannot see, and on again when it can', async () => {
        const no = answering(BLIND, 200, 40);
        const first = await refreshVisionCapability('deepseek', 'deepseek-flash', 'k', no.fetchImpl);
        expect(first.verdict.seesImages).toBe(false);
        expect(first.changed).toBe(true);
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(false);
        // The provider built for a run carries the same answer.
        const provider: any = providerFromPreset('deepseek', 'k', no.fetchImpl as any, { model: 'deepseek-flash' });
        expect(provider.config?.supportsVision ?? provider.supportsVision).toBe(false);
        // Another model on the preset is untouched.
        expect(presetSupportsVision('deepseek', 'another-model')).toBe(true);

        const yes = answering(SEES);
        const second = await refreshVisionCapability('deepseek', 'deepseek-flash', 'k', yes.fetchImpl, { force: true });
        expect(second.verdict.seesImages).toBe(true);
        expect(second.changed).toBe(true);
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(true);
    });

    it('sends one small image request with thinking off, and never logs the key', async () => {
        const { fetchImpl, calls } = answering(SEES);
        await refreshVisionCapability('deepseek', 'deepseek-flash', 'secret-key', fetchImpl);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
        const body = JSON.parse(calls[0].init.body);
        expect(body.model).toBe('deepseek-flash');
        expect(body.messages[0].content[0].text).not.toContain(PROBE_CODE);
        expect(body.max_tokens).toBeLessThanOrEqual(64);
        expect(body.reasoning_effort).toBe('none');
        expect(body.stream).toBe(false);
        const parts = body.messages[0].content;
        expect(parts.some((p: any) => p.type === 'image_url' && p.image_url.url === PROBE_IMAGE_DATA_URL)).toBe(true);
        expect(calls[0].init.headers.Authorization).toBe('Bearer secret-key');
        // The persisted verdict carries the answer, not the key.
        expect(String(prefs['visionProbeCache'])).not.toContain('secret-key');
    });

    it('keeps a verdict for half a day and re-records it from the preference', async () => {
        const { fetchImpl, calls } = answering(BLIND, 200, 40);
        await refreshVisionCapability('deepseek', 'deepseek-flash', 'k', fetchImpl);
        const again = await refreshVisionCapability('deepseek', 'deepseek-flash', 'k', fetchImpl);
        expect(calls).toHaveLength(1);
        expect(again.changed).toBe(false);
        // A fresh process knows only the declaration until it reads the preference back.
        resetProbedVision();
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(true);
        expect(cachedVisionVerdict('deepseek', 'deepseek-flash')?.seesImages).toBe(false);
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(false);
    });

    it('discards a verdict reached by an older probe', async () => {
        prefs['visionProbeCache'] = JSON.stringify({
            'deepseek:deepseek-flash': { seesImages: false, checkedAt: Date.now(), detail: 'old rules', version: PROBE_VERSION - 1 },
        });
        expect(cachedVisionVerdict('deepseek', 'deepseek-flash')).toBeNull();
        expect(presetSupportsVision('deepseek', 'deepseek-flash')).toBe(true);
        const { fetchImpl, calls } = answering(SEES);
        const result = await refreshVisionCapability('deepseek', 'deepseek-flash', 'k', fetchImpl);
        expect(calls).toHaveLength(1);
        expect(result.verdict.seesImages).toBe(true);
        expect(result.verdict.version).toBe(PROBE_VERSION);
    });

    it('shares one request between callers asking at the same time', async () => {
        const { fetchImpl, calls } = answering(SEES);
        await Promise.all([
            refreshVisionCapability('deepseek', 'deepseek-flash', 'k', fetchImpl),
            refreshVisionCapability('deepseek', 'deepseek-flash', 'k', fetchImpl),
        ]);
        expect(calls).toHaveLength(1);
    });

    it('reads a failure as not seeing, without throwing', async () => {
        const failing = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
        const result = await refreshVisionCapability('deepseek', 'deepseek-flash', 'k', failing);
        expect(result.verdict.seesImages).toBe(false);
        expect(result.verdict.detail).toMatch(/probe failed/);
        const refused = answering('Model does not support image input', 400);
        const second = await refreshVisionCapability('deepseek', 'deepseek-flash', 'k', refused.fetchImpl, { force: true });
        expect(second.verdict.seesImages).toBe(false);
        expect(second.verdict.detail).toMatch(/HTTP 400/);
    });

    it('does nothing without a key, and never probes a declared preset', async () => {
        const { fetchImpl, calls } = answering(SEES);
        const noKey = await refreshVisionCapability('deepseek', 'deepseek-flash', '', fetchImpl);
        expect(noKey.verdict.seesImages).toBe(false);
        const declared = await refreshVisionCapability('openai', 'gpt-4o', 'k', fetchImpl);
        expect(declared.verdict.seesImages).toBe(true);
        expect(declared.verdict.detail).toBe('declared by the preset');
        expect(calls).toHaveLength(0);
    });
});
