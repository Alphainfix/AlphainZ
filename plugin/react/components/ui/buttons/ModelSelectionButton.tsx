import React, { useEffect, useMemo, useRef, useState } from 'react';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { BrainIcon, ArrowDownIcon, Icon } from '../../icons/icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { 
  selectedModelAtom,
  availableModelsAtom,
  updateSelectedModelAtom,
  validateSelectedModelAtom,
} from '../../../atoms/models';
import type { ModelConfig } from '../../../atoms/models';
import { getPref, setPref } from '../../../../src/utils/prefs';
import { modelThinkingTiers } from '../../../../src/services/llm/modelTuning';
import { THINKING_TIER_NAMES, nearestTier } from '../../../../src/services/llm/thinkingTiers';
import {
    PROVIDER_PRESETS,
    presetCapabilities,
    type ProviderPresetId,
} from '../../../../src/services/llm/openAICompatible';
import { customEndpointLabel, isCustomProviderId } from '../../../../src/services/llm/customEndpoints';

/** What each thinking setting means where the user is choosing it. */
const EFFORT_LABELS: Record<string, string> = {
    none: 'Off — answer straight away',
    minimal: 'Minimal',
    low: 'Low — brief planning',
    medium: 'Medium',
    high: 'High — think it through',
    xhigh: 'Extra high',
    max: 'Max — the longest thinking',
};

/**
 * Which heading a model sits under.
 *
 * The list is every model the stored keys reach, which is a dozen rows across
 * three vendors — flat, that is a wall of `provider · model` strings with no
 * shape. Grouping by vendor is the shape the user already thinks in, and it
 * lets the row itself drop the vendor prefix.
 *
 */
const VENDOR_OF_PRESET: Partial<Record<ProviderPresetId, string>> = {
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
    zhipu: 'Zhipu (BigModel)',
    google: 'Google Gemini',
    openai: 'OpenAI',
    ollama: 'Ollama (local)',
};

/** Vendor headings in the order they should appear. */
export const VENDOR_ORDER = ['DeepSeek', 'OpenRouter', 'Zhipu (BigModel)', 'Google Gemini', 'OpenAI', 'Ollama (local)', 'Added by you'];

const OTHER_VENDOR = 'Added by you';

export function vendorFor(model: ModelConfig): string {
    // A hand-added endpoint is its own vendor, under the name the user gave it.
    if (isCustomProviderId(String(model.provider))) {
        return customEndpointLabel(String(model.provider)) ?? OTHER_VENDOR;
    }
    return VENDOR_OF_PRESET[model.provider as ProviderPresetId] ?? OTHER_VENDOR;
}

/**
 * What a model is called on its own, without the vendor: the display name its
 * provider's catalogue gave it, else the model id. The same text everywhere the
 * sidebar names a model — the picker's rows and the composer button — so what
 * was typed under "Display name" in Settings is what the user then sees.
 */
export function displayNameFor(model: Pick<ModelConfig, 'label' | 'snapshot' | 'name'>): string {
    return model.label?.trim() || model.snapshot?.trim() || model.name || '';
}

/** The row label: the model's own name, since the vendor is the heading above it. */
export function rowLabel(model: ModelConfig): string {
    const snapshot = model.snapshot?.trim();
    if (!snapshot) return model.name;
    const own = displayNameFor(model);
    // Per model: a gateway preset can list a text-only model beside one that
    // reads images, and the row must describe the model, not the gateway. A
    // hand-added model says what the user (or the Check button) said.
    const vision = isCustomProviderId(String(model.provider))
        ? model.supports_vision === true
        : presetCapabilities(model.provider as ProviderPresetId, snapshot).supportsVision;
    return vision ? `${own} · reads figures` : own;
}

/**
 * Drop entries that name the same endpoint and model as another.
 *
 * Two lists feed the picker: the presets, derived from the stored keys, and
 * whatever the user typed into the custom-provider editor. Anyone who
 * configured DeepSeek both ways — which was the only way to reach it before
 * the presets existed — got each of those models twice, under two different
 * names, with nothing to say which one the request would use. Presets win
 * because they carry the endpoint's quirks; a hand-added entry survives only
 * if it points somewhere no preset does.
 */
export function dedupeByEndpoint(models: ModelConfig[]): ModelConfig[] {
    const host = (url?: string) => {
        if (!url) return '';
        try {
            return new URL(url).host.toLowerCase();
        } catch {
            return url.trim().toLowerCase();
        }
    };
    const keyOf = (model: ModelConfig) => {
        const preset = PROVIDER_PRESETS[model.provider as ProviderPresetId];
        const base = preset ? preset.baseUrl : model.custom_model?.api_base;
        return `${host(base)}::${(model.snapshot ?? '').trim().toLowerCase()}`;
    };
    const seen = new Set<string>();
    const out: ModelConfig[] = [];
    // Presets first, so a preset always wins the key over a hand-added twin.
    for (const model of [...models].sort((a, b) => Number(!!a.custom_model) - Number(!!b.custom_model))) {
        const key = keyOf(model);
        // Nothing to compare on — keep it rather than silently dropping a
        // model the user can no longer reach any other way.
        if (key === '::') {
            out.push(model);
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(model);
    }
    return out;
}

// Only a backstop against a pathological model id; the common case is
// well under this and shows whole.
const MAX_MODEL_NAME_LENGTH = 42;

const getModelSelectionKey = (model: Pick<ModelConfig, 'id' | 'access_mode'>) => {
    return `${model.id}:${model.access_mode || 'app_key'}`;
};

const isBeaverModel = (model: Pick<ModelConfig, 'access_mode' | 'allow_app_key' | 'is_custom'>) => {
    return !model.is_custom && (model.access_mode === 'app_key' || (!model.access_mode && model.allow_app_key));
};

const getAccessibleModelLabel = (model: ModelConfig | null, isRecommended = false) => {
    if (!model) {
        return 'None Selected';
    }
    if (isBeaverModel(model)) {
        return isRecommended ? 'Model (recommended)' : `Model: ${model.name}`;
    }
    return model.name;
};

/**
 * Component for displaying a model menu item
 */
const ModelMenuItemContent: React.FC<{
    model: any;
    isSelected: boolean;
    showCreditCosts?: boolean;
    showRecommended?: boolean;
}> = ({ model, isSelected, showCreditCosts = false, showRecommended = false }) => {
    const creditCost = model.credit_cost ?? 1;
    return (
        <div className="display-flex flex-col min-w-0">
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <div className={`display-flex text-sm truncate ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                    {model.name}
                </div>
            </div>
            {(showCreditCosts || showRecommended) && (
                <div className="text-xs font-color-tertiary items-center">
                    {showCreditCosts ? (
                        <div className="text-xs">{creditCost} credit${creditCost !== 1 ? 's' : ''}</div>
                    ) : showRecommended ? (
                        <div className="text-xs">Recommended</div>
                    ) : null}
                </div>
            )}
        </div>
    );
};

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC<{
    inputRef?: React.RefObject<HTMLElement | null>;
    focusInput?: () => void;
    disabled?: boolean;
}> = ({ inputRef, focusInput, disabled = false }) => {
    const selectedModel = useAtomValue(selectedModelAtom);
    const availableModels = useAtomValue(availableModelsAtom);
    const liveRegionRef = useRef<HTMLDivElement | null>(null);
    const previousSelectedKeyRef = useRef<string | null>(null);
    const hasInitializedSelectionRef = useRef(false);
    const announcementTimerRef = useRef<{ win: Window; id: number } | null>(null);
    const [selectionAnnouncement, setSelectionAnnouncement] = useState('');
    // Mirrored in state so the tick moves the moment it is clicked; the
    // preference stays the source of truth for the runner.
    const [currentEffort, setCurrentEffort] = useState<string>(() => {
        const stored = getPref('reasoningEffort');
        return typeof stored === 'string' && stored ? stored : 'low';
    });
    // Which page of the menu is showing. One menu, three views: the two
    // choices, then the list behind each. A flat menu had to show a dozen
    // models and four thinking levels at once, and the heading that separated
    // them scrolled off the top.
    const [view, setView] = useState<'root' | 'model' | 'thinking'>('root');

    const updateSelectedModel = useSetAtom(updateSelectedModelAtom);
    const validateSelectedModel = useSetAtom(validateSelectedModelAtom);
    const selectedKey = selectedModel ? getModelSelectionKey(selectedModel) : null;
    const custom_models = useMemo(() => availableModels.filter((model) => model.is_custom), [availableModels]);
    const included_models = useMemo(() => availableModels.filter((model) => model.allow_app_key && model.is_enabled && !model.is_custom) || [], [availableModels]);
    const byok_models = useMemo(() => availableModels.filter((model) => model.allow_byok && model.is_enabled && !model.is_custom), [availableModels]);
    const selectedModelAccessibleLabel = getAccessibleModelLabel(
        selectedModel,
        !!selectedModel && included_models.length === 1 && isBeaverModel(selectedModel),
    );

    // Watch for api key changes
    useEffect(() => {
        validateSelectedModel();
    }, [availableModels, validateSelectedModel]);

    useEffect(() => {
        return () => {
            if (announcementTimerRef.current) {
                announcementTimerRef.current.win.clearTimeout(announcementTimerRef.current.id);
            }
        };
    }, []);

    useEffect(() => {
        if (!hasInitializedSelectionRef.current) {
            hasInitializedSelectionRef.current = true;
            previousSelectedKeyRef.current = selectedKey;
            return;
        }

        if (previousSelectedKeyRef.current === selectedKey) {
            return;
        }

        previousSelectedKeyRef.current = selectedKey;
        const message = selectedModel
            ? `Selected AI model: ${selectedModelAccessibleLabel}`
            : 'No AI model selected';

        if (announcementTimerRef.current) {
            announcementTimerRef.current.win.clearTimeout(announcementTimerRef.current.id);
            announcementTimerRef.current = null;
        }

        // Clear first so selecting the same visible name through a different
        // access mode is still announced by screen readers.
        setSelectionAnnouncement('');
        const win = liveRegionRef.current?.ownerDocument.defaultView;
        if (!win) {
            setSelectionAnnouncement(message);
            return;
        }

        const id = win.setTimeout(() => {
            setSelectionAnnouncement(message);
            announcementTimerRef.current = null;
        }, 50);
        announcementTimerRef.current = { win, id };
    }, [selectedKey, selectedModel, selectedModelAccessibleLabel]);

    // The tiers the model in use takes — its own list, set on its card or
    // known for its preset. The one setting is shown as the tier it becomes.
    // Read again when the model list is rebuilt, which every edit to a
    // provider card or endpoint triggers.
    const effortTiers = useMemo(
        () => (selectedModel ? modelThinkingTiers(String(selectedModel.provider), selectedModel.snapshot ?? '') : []),
        // The list is the signal that a model's tuning changed.
        [selectedModel?.provider, selectedModel?.snapshot, availableModels],
    );
    const supportsEffort = effortTiers.length > 0;
    const shownEffort = nearestTier(currentEffort, effortTiers) ?? currentEffort;

    const chooseModels = useMemo(
        () => dedupeByEndpoint([...custom_models, ...byok_models, ...included_models]),
        [custom_models, byok_models, included_models],
    );

    const menuItems = useMemo((): MenuItem[] => {
        const items: MenuItem[] = [];

        const row = (
            label: string,
            content: React.ReactNode,
            onClick: () => void,
            extra: Partial<MenuItem> = {},
        ): MenuItem => ({ label, onClick, customContent: content, ...extra });

        const backRow = (title: string) =>
            row(
                `Back to ${title}`,
                <div className="display-flex flex-row items-center gap-1 text-sm font-color-tertiary">
                    <span>‹</span>
                    <span>{title}</span>
                </div>,
                () => setView('root'),
                { keepOpen: true },
            );

        if (view === 'root') {
            items.push(
                row(
                    'Model',
                    <div className="display-flex flex-row items-center gap-2 min-w-0">
                        <span className="text-sm font-color-primary">Model</span>
                        <span className="flex-1 text-sm font-color-tertiary text-right truncate">
                            {selectedModel ? rowLabel(selectedModel) : 'None selected'}
                        </span>
                        <span className="font-color-tertiary">›</span>
                    </div>,
                    () => setView('model'),
                    { keepOpen: true },
                ),
            );
            /*
             * Thinking effort, for the providers that take one.
             *
             * Next to the model rather than in settings because it is a
             * per-question choice: the same model wants "off" for a lookup and
             * "high" for a synthesis. Hidden for a model that takes no
             * effort at all (gpt-4o, a hand-added model left unticked), where
             * the dial would offer a control that 400s the request.
             *
             * It is not purely a quality dial: thinking comes out of the same
             * output budget as the answer, so a high setting on a long
             * tool-using run can end the turn inside the reasoning with
             * nothing to show.
             */
            if (supportsEffort) {
                items.push(
                    row(
                        'Thinking',
                        <div className="display-flex flex-row items-center gap-2 min-w-0">
                            <span className="text-sm font-color-primary">Thinking</span>
                            <span className="flex-1 text-sm font-color-tertiary text-right truncate">
                                {THINKING_TIER_NAMES[shownEffort as keyof typeof THINKING_TIER_NAMES] ?? shownEffort}
                            </span>
                            <span className="font-color-tertiary">›</span>
                        </div>,
                        () => setView('thinking'),
                        { keepOpen: true },
                    ),
                );
            }
            return items;
        }

        if (view === 'thinking') {
            items.push(backRow('Thinking'));
            for (const effort of effortTiers) {
                items.push({
                    label: EFFORT_LABELS[effort] ?? effort,
                    role: 'menuitemradio',
                    ariaChecked: shownEffort === effort,
                    onClick: () => {
                        setPref('reasoningEffort', effort);
                        setCurrentEffort(effort);
                    },
                });
            }
            return items;
        }

        items.push(backRow('Model'));

        const byVendor = new Map<string, ModelConfig[]>();
        for (const model of chooseModels) {
            const vendor = vendorFor(model);
            const bucket = byVendor.get(vendor);
            if (bucket) bucket.push(model);
            else byVendor.set(vendor, [model]);
        }
        // Presets in their fixed order, then the user's endpoints by name, then
        // the leftover heading last.
        const rank = (vendor: string) => {
            const i = VENDOR_ORDER.indexOf(vendor);
            if (vendor === OTHER_VENDOR) return VENDOR_ORDER.length + 1;
            return i < 0 ? VENDOR_ORDER.length : i;
        };
        const vendors = [...byVendor.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

        for (const vendor of vendors) {
            items.push({ label: vendor, isGroupHeader: true, onClick: () => {} });
            for (const model of byVendor.get(vendor) ?? []) {
                const withAccess: ModelConfig = model.is_custom
                    ? model
                    : { ...model, access_mode: model.allow_app_key ? 'app_key' : 'byok' };
                const modelKey = getModelSelectionKey(withAccess);
                items.push({
                    label: getAccessibleModelLabel(withAccess),
                    role: 'menuitemradio',
                    ariaChecked: selectedKey === modelKey,
                    onClick: () => updateSelectedModel(withAccess),
                    customContent: (
                        <ModelMenuItemContent
                            model={{ ...model, name: rowLabel(model) }}
                            isSelected={selectedKey === modelKey}
                        />
                    ),
                });
            }
        }

        return items;
    }, [
        view,
        chooseModels,
        updateSelectedModel,
        selectedKey,
        selectedModel,
        currentEffort,
        shownEffort,
        supportsEffort,
        effortTiers,
    ]);

    /**
     * What the button says.
     *
     * The name of a locally-configured model is "provider · model", which is
     * about forty-five characters and was being chopped in JavaScript at
     * twenty-five — so the button read "deepseek-vision · deeps…" and never
     * told you which model you were about to spend money on. The model is the
     * half that matters; the provider is in the menu and the tooltip. Nothing
     * is cut here any more: if the row genuinely runs out of room, CSS
     * ellipsis handles it, and that only happens in a very narrow sidebar.
     */
    const getButtonLabel = () => {
        if (!selectedModel) return 'None Selected';
        const name = displayNameFor(selectedModel);
        return name.length > MAX_MODEL_NAME_LENGTH
            ? `${name.slice(0, MAX_MODEL_NAME_LENGTH - 1)}…`
            : name;
    };

    const handleAfterClose = () => {
        setView('root');
        if (focusInput) {
            focusInput();
        } else if (inputRef?.current) {
            inputRef.current.focus();
        }
    };

    const agentComponent = (
        <div className="display-flex items-center gap-1">
            <Icon icon={BrainIcon} />
            {getButtonLabel()}
            <Icon icon={ArrowDownIcon} className="scale-11 -ml-1" />
        </div>
    );

    const dynamicStyle = {
        padding: '2px 0px',
        fontSize: '0.80rem',
        // No fixed cap. 250px truncated the name in a sidebar wider than that,
        // and a model picker that shows "deepseek-vision · deeps…" is not
        // telling you which model you are about to spend money on. It shrinks
        // only when the row genuinely runs out of room.
        minWidth: 0,
        flexShrink: 1,
    };

    // Hidden only when there is genuinely nothing to choose. Counting menu
    // rows was the old test, and the menu is now two rows deep — with a
    // model that takes no thinking effort, the root view is a single row,
    // which that test read as "no models" and hid the picker outright.
    if (chooseModels.length <= 1 && !supportsEffort) {
        return null;
    }

    return (
        <>
            <div
                ref={liveRegionRef}
                className="sr-only"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {selectionAnnouncement}
            </div>
            <MenuButton
                menuItems={menuItems}
                variant="ghost-secondary"
                customContent={agentComponent}
                buttonLabel={getButtonLabel()}
                rightIcon={ArrowDownIcon}
                className="truncate"
                style={dynamicStyle}
                iconClassName="scale-11 -mr-015"
                rightIconClassName="scale-11 -ml-1"
                ariaLabel={`AI model: ${selectedModelAccessibleLabel}. Choose AI model`}
                // No hover card in the normal state: the button already shows
                // the model id, its job is obvious, and the card popped up
                // right over the composer. The one state that needs explaining
                // is a dead button with no models behind it. (The full
                // provider identity stayed reachable via the aria-label and
                // the menu itself.)
                tooltipContent={availableModels.length === 0 ? 'No models available' : undefined}
                showArrow={false}
                disabled={disabled || availableModels.length === 0}
                onAfterClose={handleAfterClose}
            />
        </>
    );
};

export default ModelSelectionButton;
