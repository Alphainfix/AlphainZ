import React, { useState, useCallback, useMemo } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { getPref, setPref } from '../../../src/utils/prefs';
import { semanticSearchState } from '../../../src/services/llm/agentConfig';
import { embeddingProviderProblem } from '../../atoms/fulltextIndex';
import { RepeatIcon, SettingsIcon, Icon, SearchIcon, LockIcon, KeyIcon, ZapIcon, ToolsIcon } from '../icons/icons';
import Button from "@beaver/agent-ui/primitives/Button";
import { useSetAtom } from 'jotai';
import { profileWithPlanAtom } from "../../atoms/profile";
import { activePreferencePageTabAtom, PreferencePageTab } from "../../atoms/ui";
import { logger } from "@beaver/agent-core/platform/logger";
import { isDiffPreviewSupported } from "../../utils/noteEditorDiffPreview";
import { 
    embeddingIndexStateAtom, 
    forceReindexAtom, 
    isEmbeddingIndexingAtom 
} from "../../atoms/embeddingIndex";
import { accountService } from "@beaver/agent-core/transport/clients/accountService";
import {SettingsGroup, SettingsRow, SectionLabel} from "./components/SettingsElements";
import AppearanceSection from "./AppearanceSection";
import ActionsPreferenceSection from "./ActionsPreferenceSection";
import ModelSettingsSection from "./ModelSettingsSection";
import AdvancedSection from "./AdvancedSection";
import PermissionsSection from "./PermissionsSection";
import EmbeddingIndexProgress from "../pages/onboarding/EmbeddingIndexProgress";
import ExcludedLibrariesList from "./ExcludedLibrariesList";
import { useEmbeddingHealth } from "../../hooks/useEmbeddingHealth";
import { msg, t, tn } from '../../../src/utils/i18n';


const PreferencePage: React.FC = () => {

    // --- User profile ---
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);

    // --- State for Preferences ---
    const [citationFormat, setCitationFormat] = useState(() => getPref('citationFormat') === 'numeric');
    const [useTemporaryCitationAnnotations, setUseTemporaryCitationAnnotations] = useState(() => getPref('useTemporaryCitationAnnotations') === true);
    const [keyboardShortcut, setKeyboardShortcut] = useState(() => {
        const shortcut = getPref('keyboardShortcut');
        return /^[a-z]$/i.test(shortcut) ? shortcut.toUpperCase() : 'J';
    });
    const [addSelectedOnNewThread, setAddSelectedOnNewThread] = useState(() => getPref('addSelectedItemsOnNewThread'));
    const [addSelectedOnOpen, setAddSelectedOnOpen] = useState(() => getPref('addSelectedItemsOnOpen'));
    const [addProvenanceNote, setAddProvenanceNote] = useState(() => getPref('addBeaverProvenanceNote'));
    const [focusResponseForScreenReaders, setFocusResponseForScreenReaders] = useState(() => getPref('focusResponseForScreenReaders'));
    const [showDiffPreview, setShowDiffPreview] = useState(() => getPref('showDiffPreviewInNoteEditor') !== false);
    const diffPreviewSupported = isDiffPreviewSupported();
    const [emailNotifications, setEmailNotifications] = useState(() => profileWithPlan?.email_notifications || false);
    const [activeTab, setActiveTab] = useAtom(activePreferencePageTabAtom);
    // Read at render: cheap, and returning to this tab re-evaluates it.
    const semantic = semanticSearchState();
    // Topic search chosen but not working — a key missing, Ollama away, or the
    // last request refused: the Model tab, where it is fixed, says so.
    const embeddingHealth = useEmbeddingHealth();
    const modelTabNeedsAttention = !!embeddingHealth || semantic.status === 'needs_key' || semantic.status === 'unreachable';
    const semanticSearchReady = semantic.status === 'ready';

    // Update local state when atom changes
    React.useEffect(() => {
        setEmailNotifications(profileWithPlan?.email_notifications || false);
    }, [profileWithPlan?.email_notifications]);
    
    // --- Embedding Index ---
    const embeddingIndexState = useAtomValue(embeddingIndexStateAtom);
    const isEmbeddingIndexing = useAtomValue(isEmbeddingIndexingAtom);
    const forceReindex = useSetAtom(forceReindexAtom);

    const handleKeyboardShortcutChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        const nextShortcut = event.target.value.toLowerCase();
        if (!/^[a-z]$/.test(nextShortcut)) {
            return;
        }
        setKeyboardShortcut(nextShortcut.toUpperCase());
        if (nextShortcut !== getPref('keyboardShortcut')) {
            setPref('keyboardShortcut', nextShortcut);
            logger(`Updated keyboard shortcut to ${nextShortcut.toUpperCase()}`);
        }
    }, []);

    // --- Consent Toggle Change Handler ---
    // --- Email Notifications Toggle Change Handler ---
    const handleEmailNotificationsChange = useCallback(async (checked: boolean) => {
        const action = checked ? 'enable' : 'disable';
        try {
            logger(`User confirmed to ${action} email notifications. New value: ${checked}`);
            await accountService.updatePreference('email_notifications', checked);

            setProfileWithPlan((prev) => {
                if (!prev) return null;
                return { ...prev, email_notifications: checked };
            });
            setEmailNotifications(checked);
            logger('Successfully updated email notifications preference.');
        } catch (error) {
            logger(`Failed to update email notifications preference: ${error}`, 1);
            Zotero.logError(error as Error);
            // Revert the toggle on error
            setEmailNotifications(!checked);
        }
    }, [setProfileWithPlan]);

    // --- Rebuild Search Index Handler ---
    const handleRebuildSearchIndex = useCallback(() => {
        if (isEmbeddingIndexing) return;
        logger('handleRebuildSearchIndex: User-initiated search index rebuild');
        forceReindex();
    }, [isEmbeddingIndexing, forceReindex]);

    // --- Inline toggle handlers for card-based layout ---
    const handleCitationFormatToggle = useCallback(() => {
        const newChecked = !citationFormat;
        setPref("citationFormat", newChecked ? "numeric" : "author-year");
        setCitationFormat(newChecked);
    }, [citationFormat]);

    const handleTemporaryCitationAnnotationsToggle = useCallback(() => {
        const newValue = !useTemporaryCitationAnnotations;
        setPref("useTemporaryCitationAnnotations", newValue);
        setUseTemporaryCitationAnnotations(newValue);
    }, [useTemporaryCitationAnnotations]);

    const handleAddSelectedOnNewThreadToggle = useCallback(() => {
        const newValue = !addSelectedOnNewThread;
        setPref("addSelectedItemsOnNewThread", newValue);
        setAddSelectedOnNewThread(newValue);
    }, [addSelectedOnNewThread]);

    const handleAddSelectedOnOpenToggle = useCallback(() => {
        const newValue = !addSelectedOnOpen;
        setPref("addSelectedItemsOnOpen", newValue);
        setAddSelectedOnOpen(newValue);
    }, [addSelectedOnOpen]);

    const handleAddProvenanceNoteToggle = useCallback(() => {
        const newValue = !addProvenanceNote;
        setPref("addBeaverProvenanceNote", newValue);
        setAddProvenanceNote(newValue);
    }, [addProvenanceNote]);

    const handleFocusResponseForScreenReadersToggle = useCallback(() => {
        const newValue = !focusResponseForScreenReaders;
        setPref("focusResponseForScreenReaders", newValue);
        setFocusResponseForScreenReaders(newValue);
    }, [focusResponseForScreenReaders]);

    const handleShowDiffPreviewToggle = useCallback(() => {
        if (!diffPreviewSupported) return;
        const newValue = !showDiffPreview;
        setPref("showDiffPreviewInNoteEditor", newValue);
        setShowDiffPreview(newValue);
    }, [showDiffPreview, diffPreviewSupported]);

    // Helper function to get rebuild index button props
    const getRebuildIndexButtonProps = () => {
        if (isEmbeddingIndexing) {
            const progress = embeddingIndexState.progress > 0 ? ` (${embeddingIndexState.progress}%)` : '';
            return {
                icon: RepeatIcon,
                iconClassName: '',
                disabled: true,
                text: `Indexing${progress}`
            };
        }
        if (embeddingIndexState.failedItems > 0) {
            return {
                icon: RepeatIcon,
                iconClassName: '',
                disabled: false,
                text: t('Indexing Failed ({count})', { count: embeddingIndexState.failedItems })
            };
        }
        return {
            icon: RepeatIcon,
            iconClassName: '',
            disabled: false,
            text: t('Check & Repair')
        };
    };

    const rebuildIndexButtonProps = getRebuildIndexButtonProps();
    const sidebarShortcutLabel = `${Zotero.isMac ? '⌘' : 'Ctrl'}+${keyboardShortcut}`;
    const windowShortcutLabel = `${Zotero.isMac ? '⌘⇧' : 'Ctrl+Shift'}+${keyboardShortcut}`;
    type VisiblePreferencePageTab = Exclude<PreferencePageTab, 'account'>;
    const tabs = useMemo<{ id: VisiblePreferencePageTab; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> | React.ReactElement }[]>(() => [
        { id: 'general', label: msg('General'), icon: SettingsIcon },
        { id: 'sync', label: msg('Search'), icon: SearchIcon },
        { id: 'permissions', label: msg('Permissions'), icon: LockIcon },
        { id: 'models', label: msg('Model'), icon: KeyIcon },
        { id: 'actions', label: msg('Actions'), icon: ZapIcon },
        { id: 'advanced', label: msg('Advanced'), icon: ToolsIcon },
    ], []);
    const effectiveActiveTab: VisiblePreferencePageTab = activeTab === 'account' ? 'general' : activeTab;

    const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const navigationKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!navigationKeys.includes(event.key)) {
            return;
        }

        event.preventDefault();
        const currentIndex = tabs.findIndex((tab) => tab.id === effectiveActiveTab);
        const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? tabs.length - 1
                : event.key === 'ArrowLeft'
                    ? (normalizedIndex - 1 + tabs.length) % tabs.length
                    : (normalizedIndex + 1) % tabs.length;
        const nextTab = tabs[nextIndex];
        setActiveTab(nextTab.id);
        event.currentTarget.ownerDocument
            .getElementById(`alphainz-preferences-tab-${nextTab.id}`)
            ?.focus();
    }, [effectiveActiveTab, setActiveTab, tabs]);

    // Backward compatibility for existing entry points that still request "account".
    React.useEffect(() => {
        if (activeTab === 'account') {
            setActiveTab('general');
        }
    }, [activeTab, setActiveTab]);

    return (
        <div
            id="alphainz-preferences"
            className="flex-1 min-h-0 overflow-y-auto scrollbar min-w-0"
        >
          <div className="display-flex flex-col gap-2 p-4">
            <div className="display-flex flex-row items-center gap-3 px-1">
                <Icon icon={SettingsIcon} className="scale-16 mt-020" aria-hidden="true" focusable="false" />
                <h1 id="alphainz-preferences-title" className="text-2xl font-semibold  font-color-primary" style={{ marginBlock: "0rem" }}>
                    {t('Settings')}
                </h1>
                {/* <Button variant="outline" rightIcon={CancelIcon} onClick={() => togglePreferencePage((prev) => !prev)} className="mt-1">Close</Button> */}
            </div>


            <div
                role="tablist"
                aria-label={t('Settings sections')}
                className="display-flex flex-row items-center mb-3 mt-2"
                style={{ borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--fill-quarternary)', width: 'fit-content' }}
                onKeyDown={handleTabKeyDown}
            >
                {tabs.map((tab, index) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        id={`alphainz-preferences-tab-${tab.id}`}
                        role="tab"
                        aria-selected={tab.id === effectiveActiveTab}
                        aria-controls="alphainz-preferences-panel"
                        tabIndex={tab.id === effectiveActiveTab ? 0 : -1}
                        className="text-base"
                        style={{
                            borderLeft: index > 0 ? '1px solid var(--fill-quarternary)' : 'none',
                            borderTop: 'none',
                            borderBottom: 'none',
                            borderRight: 'none',
                            borderRadius: 0,
                            background: tab.id === effectiveActiveTab ? 'var(--fill-quinary)' : 'transparent',
                            color: tab.id === effectiveActiveTab ? 'var(--fill-primary)' : 'var(--fill-secondary)',
                            padding: '6px 12px',
                            minHeight: '20px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            lineHeight: 1.2,
                            gap: '4px',
                            whiteSpace: 'nowrap',
                            transition: 'background-color 0.15s ease, color 0.15s ease'
                        }}
                    >
                        <Icon
                            icon={tab.icon as React.ComponentType<React.SVGProps<SVGSVGElement>>}
                            className="scale-95 -ml-05"
                        />
                        {t(tab.label)}
                        {tab.id === 'models' && modelTabNeedsAttention && (
                            <span
                                role="img"
                                aria-label={t('Topic search needs attention')}
                                title={t('Topic search needs attention')}
                                data-testid="models-tab-attention"
                                style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '3px',
                                    background: 'var(--tag-orange-secondary)',
                                    flexShrink: 0,
                                }}
                            />
                        )}
                    </button>
                ))}
            </div>

            <div
                role="tabpanel"
                id="alphainz-preferences-panel"
                aria-labelledby={`alphainz-preferences-tab-${effectiveActiveTab}`}
            >
            {/* ===== GENERAL TAB ===== */}
            {effectiveActiveTab === 'general' && (
                <>
                    <AppearanceSection />
                    <>
                            <SectionLabel>{t('Preferences')}</SectionLabel>
                            <SettingsGroup>
                                <SettingsRow
                                    title={t('Keyboard Shortcut')}
                                    description={<>{t('Sidebar:')}{' '}{sidebarShortcutLabel}{' '}{t('· Window:')}{' '}{windowShortcutLabel}{' '}{t('· Changes require restart')}</>}
                                    control={
                                        <select
                                            id="keyboard-shortcut"
                                            value={keyboardShortcut}
                                            onChange={handleKeyboardShortcutChange}
                                            className="py-1 px-2 border preference-input text-sm"
                                            style={{ width: '40px', margin: 0 }}
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            {'DGHJKMRVX'.split('').map((letter) => (
                                                <option key={letter} value={letter}>{letter}</option>
                                            ))}
                                        </select>
                                    }
                                />
                                <SettingsRow
                                    title={t('Citation Format: {format}', { format: citationFormat ? t('Numeric') : t('Author-Year') })}
                                    description={t('Choose between numeric [1] or author-year (Smith, 2023) citations')}
                                    onClick={handleCitationFormatToggle}
                                    hasBorder
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={citationFormat}
                                            onChange={handleCitationFormatToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title={t('Keep Cited Passages Highlighted')}
                                    description={t('When enabled, AlphainZ marks cited passages with temporary Zotero annotations that disappear on your next click. When disabled, AlphainZ briefly flashes the passage instead.')}
                                    onClick={handleTemporaryCitationAnnotationsToggle}
                                    hasBorder
                                    tooltip={t('When disabled, citations use Zotero\'s transient PDF position highlight instead.')}
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={useTemporaryCitationAnnotations}
                                            onChange={handleTemporaryCitationAnnotationsToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title={t('Add Selected Items to New Threads')}
                                    description={t('Automatically attach selected items to new thread')}
                                    onClick={handleAddSelectedOnNewThreadToggle}
                                    hasBorder
                                    tooltip={t('When enabled, any items you have selected in Zotero will be automatically added as sources when you start a new conversation thread.')}
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={addSelectedOnNewThread}
                                            onChange={handleAddSelectedOnNewThreadToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title={t('Add Selected Items When Opening')}
                                    description={t('Automatically attach selected items when opening AlphainZ')}
                                    onClick={handleAddSelectedOnOpenToggle}
                                    hasBorder
                                    tooltip={t('When enabled, any items you have selected in Zotero will be automatically added as sources when you open AlphainZ.')}
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={addSelectedOnOpen}
                                            onChange={handleAddSelectedOnOpenToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title={t('Add Provenance Note to Imported Items')}
                                    description={t('Add a child note that links the item back to its AlphainZ conversation')}
                                    onClick={handleAddProvenanceNoteToggle}
                                    hasBorder
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={addProvenanceNote}
                                            onChange={handleAddProvenanceNoteToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title={t('Announce Responses for Screen Readers')}
                                    description={t('Move focus to screen-reader text when AlphainZ starts and finishes generating a response')}
                                    onClick={handleFocusResponseForScreenReadersToggle}
                                    hasBorder
                                    tooltip={t('When enabled, focus moves from the chat input to screen-reader-only status text while AlphainZ generates, then to a screen-reader-only copy of the completed response.')}
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={focusResponseForScreenReaders}
                                            onChange={handleFocusResponseForScreenReadersToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: 'pointer', margin: 0 }}
                                        />
                                    }
                                />
                                <SettingsRow
                                    title={t('Preview Note Edits in Editor')}
                                    description={diffPreviewSupported
                                        ? t('Show proposed note edits inline in the Zotero note editor')
                                        : t('Requires Zotero 8 — unavailable on this version')}
                                    onClick={diffPreviewSupported ? handleShowDiffPreviewToggle : undefined}
                                    hasBorder
                                    tooltip={t('When enabled, edit_note proposals appear as a colored diff directly in the note editor with Apply / Reject controls. When disabled, approvals fall back to the sidebar preview. Turn off if a Zotero update causes the in-editor preview to misbehave.')}
                                    control={
                                        <input
                                            type="checkbox"
                                            checked={showDiffPreview && diffPreviewSupported}
                                            disabled={!diffPreviewSupported}
                                            onChange={handleShowDiffPreviewToggle}
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ cursor: diffPreviewSupported ? 'pointer' : 'not-allowed', margin: 0 }}
                                        />
                                    }
                                />
                                {/*
                                  * The "Help Improve Beaver" consent toggle
                                  * lived here. It wrote through
                                  * `accountService.updatePreference`, which
                                  * needs the hosted backend — so it failed and
                                  * silently reverted every time. Worse than
                                  * dead: it told the user their prompts were
                                  * being shared to improve a service, when
                                  * nothing is sent anywhere at all.
                                  */}
                            </SettingsGroup>
                    </>
                </>
            )}

            {/* ===== SYNC TAB ===== */}
            {effectiveActiveTab === 'sync' && (
                <>
                    <SectionLabel>{t('Libraries')}</SectionLabel>
                    <ExcludedLibrariesList />

                    <SectionLabel>{t('Titles and abstracts')}</SectionLabel>
                    <SettingsGroup>
                        <SettingsRow
                            title={t('Titles and abstracts')}
                            description={
                                semanticSearchReady ? (
                                    <>
                                    {t('What lets the agent find an item by subject. It is built and kept up to date on its own, so there is normally nothing to do here — run a check if search results look out of date. Reading inside the PDFs is a separate, larger index, under Model.')}
                                    {embeddingIndexState.failedItems > 0 && (
                                        <span className="display-flex font-color-yellow mt-1">
                                            {tn(embeddingIndexState.failedItems, '{count} item failed to index', '{count} items failed to index')}
                                        </span>
                                    )}
                                    {embeddingIndexState.status === 'error' && embeddingIndexState.error && (
                                        <span className="display-flex font-color-red mt-1">
                                            {t('Error:')}{' '}{embeddingIndexState.error}
                                        </span>
                                    )}
                                    </>
                                ) : (
                                    /*
                                     * With no usable embedding provider the
                                     * indexer does not start, so "kept up to
                                     * date on its own" would describe an index
                                     * that does not exist. Say which it is:
                                     * none chosen, or one chosen that cannot be
                                     * used yet — it starts once that is fixed.
                                     */
                                    <span className="display-flex font-color-yellow" data-testid="search-index-state">
                                        {semantic.status === 'off'
                                            ? t('Off: no embedding provider is chosen, so this index is not built and the agent '
                                                + 'cannot find items by subject. Choose a provider under Model to turn it on.')
                                            : `${embeddingProviderProblem(semantic)} ` + t('This index is built by itself once that is '
                                                + 'fixed; until then the agent cannot find items by subject.')}
                                    </span>
                                )
                            }
                            control={
                                semanticSearchReady ? (
                                    <Button
                                        variant="outline"
                                        rightIcon={!isEmbeddingIndexing ? rebuildIndexButtonProps.icon : undefined}
                                        iconClassName={rebuildIndexButtonProps.iconClassName}
                                        onClick={handleRebuildSearchIndex}
                                        disabled={rebuildIndexButtonProps.disabled}
                                        loading={isEmbeddingIndexing}
                                        style={{ padding: '4px 6px' }}
                                    >
                                        {rebuildIndexButtonProps.text}
                                    </Button>
                                ) : (
                                    <Button
                                        variant="outline"
                                        onClick={() => setActiveTab('models')}
                                        style={{ padding: '4px 6px' }}
                                    >
                                        {semantic.status === 'off' ? t('Choose a provider') : t('Fix it under Model')}
                                    </Button>
                                )
                            }
                        />
                        {isEmbeddingIndexing && embeddingIndexState.phase === 'initial' && embeddingIndexState.totalItems > 0 && (
                            <EmbeddingIndexProgress />
                        )}
                    </SettingsGroup>
                </>
            )}

            {/* ===== PERMISSIONS TAB ===== */}
            {effectiveActiveTab === 'permissions' && (
                <PermissionsSection />
            )}

            {/* ===== MODEL TAB ===== */}
            {effectiveActiveTab === 'models' && (
                <ModelSettingsSection />
            )}

            {/* ===== ACTIONS TAB ===== */}
            {effectiveActiveTab === 'actions' && (
                <ActionsPreferenceSection />
            )}

            {/* ===== ADVANCED TAB ===== */}
            {effectiveActiveTab === 'advanced' && (
                <AdvancedSection />
            )}
            </div>

            {/* Spacer at the bottom */}
            {/* <div style={{ height: "20px" }} /> */}
          </div>
        </div>
    );
};

export default PreferencePage;
