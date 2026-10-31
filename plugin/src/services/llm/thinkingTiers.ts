/**
 * Thinking tiers, and what a model can be told about itself.
 *
 * Every model gets its own list of the tiers it takes. The composer's
 * Thinking menu offers that list, and the one setting it writes is read
 * through it: a tier the model in use does not take becomes the nearest one
 * it does. Models disagree about the scale — Zhipu's GLM-5.3 takes low, high
 * and max; GPT-6.1 Sol refuses none; Gemini 3.5 Flash-Lite starts at minimal —
 * and one fixed menu of four could not say so.
 *
 * No imports: the provider presets, the hand-added endpoints and the settings
 * all use this, and it must not pull any of them into the others.
 */

/** Every tier any model is known to take, least thinking first. */
export const THINKING_TIERS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingTier = (typeof THINKING_TIERS)[number];

/** The four the composer offered before models had lists of their own. */
export const LEGACY_THINKING_TIERS: readonly ThinkingTier[] = ['none', 'low', 'medium', 'high'];

/** Each tier's name where space is short: the composer's Thinking row, the settings' checkboxes. */
export const THINKING_TIER_NAMES: Record<ThinkingTier, string> = {
    none: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
};

export function isThinkingTier(value: unknown): value is ThinkingTier {
    return typeof value === 'string' && (THINKING_TIERS as readonly string[]).includes(value);
}

/** A stored list as tiers in scale order, duplicates and unknown names dropped; undefined when it is not a list. */
export function normalizeTiers(raw: unknown): ThinkingTier[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return THINKING_TIERS.filter((tier) => raw.includes(tier));
}

/**
 * The tier to send when `wanted` is chosen and the model takes `tiers`: itself
 * when it is taken, else the nearest on the scale, the higher one on a tie —
 * a model that refuses "none" thinks a little rather than not at all.
 */
export function nearestTier(wanted: string, tiers: readonly ThinkingTier[]): ThinkingTier | undefined {
    if (tiers.length === 0) return undefined;
    if (isThinkingTier(wanted) && tiers.includes(wanted)) return wanted;
    const rank = isThinkingTier(wanted) ? THINKING_TIERS.indexOf(wanted) : THINKING_TIERS.indexOf('low');
    let best = tiers[0];
    let bestDistance = Infinity;
    for (const tier of tiers) {
        const distance = Math.abs(THINKING_TIERS.indexOf(tier) - rank);
        if (distance < bestDistance || (distance === bestDistance && THINKING_TIERS.indexOf(tier) > THINKING_TIERS.indexOf(best))) {
            best = tier;
            bestDistance = distance;
        }
    }
    return best;
}

/** What the user set for one model. Absent fields mean "what the provider says". */
export interface ModelTuning {
    /** The tiers it takes, in scale order; empty means no thinking setting is sent. */
    efforts?: ThinkingTier[];
    /** Its context window in tokens. */
    contextWindow?: number;
    /** The most output one answer may use; Limits per question can lower it. */
    maxOutputTokens?: number;
}

/** A positive whole number, or undefined. */
export function positiveInt(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : undefined;
}

/** A stored tuning with anything malformed dropped; null when nothing is left. */
export function normalizeTuning(raw: unknown): ModelTuning | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const t = raw as Record<string, unknown>;
    const efforts = normalizeTiers(t.efforts);
    const contextWindow = positiveInt(t.contextWindow);
    const maxOutputTokens = positiveInt(t.maxOutputTokens);
    const out: ModelTuning = {
        ...(efforts ? { efforts } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
    };
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Share of a model's context window a conversation may fill before the older
 * part of it is summarized. The rest is room for the question's own reading
 * and for the answer.
 */
export const COMPACT_AT_WINDOW_SHARE = 0.7;
