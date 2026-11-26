/**
 * The model settings both clients show: the provider cards with their keys,
 * catalogues and per-model tuning, the Ollama guide, the limits per question,
 * custom instructions and the conversation view switch, with the elements they
 * are laid out in. Each client wraps them in a `SettingsHostProvider` that
 * says where its settings live and how it reaches the network.
 */
export {
    SettingsHostProvider,
    useSettingsHost,
    useModelsVersion,
    whenConfirmed,
    type SettingsHost,
    type SettingsModels,
    type SettingsFetch,
    type OllamaService,
    type OllamaStatus,
    type OllamaPullState,
    type OllamaModelOffer,
} from './host';
export { SectionLabel, SectionHeader, SectionDescription, SettingsGroup, SettingsRow, DocLink } from './SettingsElements';
export { ProgressBar } from './ProgressBar';
export { default as ProviderCards, describeVerdict, type OpenCardRequest } from './ProviderCards';
export { OllamaGuide, type OllamaGuideProps } from './OllamaGuide';
export { default as RunLimitsSection, ALL_RUN_LIMITS, type LimitPref } from './RunLimitsSection';
export { default as CustomInstructionsSection } from './CustomInstructionsSection';
export { default as ConversationViewSection } from './ConversationViewSection';
