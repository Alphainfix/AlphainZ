import React, { useCallback, useEffect, useMemo, useState } from "react";
import { MCP_ENDPOINT_PATH, MCP_SERVER_NAME } from '../../../src/services/mcpService';
import { CONVERSATIONS_TITLE } from '../../../src/services/threadZoteroSync';
import { getPref, setPref } from '../../../src/utils/prefs';
import { conversationSyncMode, getConversationBackend } from '../../../src/services/conversationSync';
import { exportAllThreads } from '../../../src/services/conversationSync/exportAll';
import { pickFolder } from '../../utils/folderPicker';
import {
    confirmAndSwitchSyncMode,
    forgetSyncLocation,
    joinSyncBackend,
    type JoinOutcome,
} from '../../utils/syncModeSwitch';
import Button from "@beaver/agent-ui/primitives/Button";
import {SettingsGroup, SettingsRow, DocLink} from "./components/SettingsElements";
import { dataProviderEnabledAtom, mcpCreateNoteToolEnabledAtom, mcpServerEnabledAtom } from "../../atoms/ui";
import { isMcpServerSupportedAtom } from "../../atoms/profile";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { currentMessageExternalFilesAtom } from "../../atoms/messageComposition";
import { ensureMcpBridgeScript } from "../../hooks/useMcpServer";
import { copyToClipboard } from "../../utils/clipboard";
import { logger } from "@beaver/agent-core/platform/logger";
import { TickIcon, CopyIcon } from "../icons/icons";
import CustomInstructionsSection from "./CustomInstructionsSection";
import RunLimitsSection from "./RunLimitsSection";
import ConversationViewSection from "./ConversationViewSection";
import {
    deleteAllExternalFiles,
    getExternalFilesStats,
    revealExternalFilesDir,
} from "../../../src/services/externalFiles";

/** What joining a sync location did, in the words of the Export row. */
export function describeJoinOutcome(outcome: JoinOutcome): string {
    const parts: string[] = [];
    if (outcome.adoptedSettings) parts.push('Settings taken from your other computer');
    const exported = outcome.exported;
    if (exported) {
        let line = exported.written > 0
            ? `Exported ${exported.written} conversation${exported.written === 1 ? '' : 's'}`
            : 'Nothing new to export';
        if (exported.upToDate > 0) line += `; ${exported.upToDate} already there`;
        if (exported.skipped > 0) {
            line += `; ${exported.skipped} left alone (newer on another computer, or still downloading)`;
        }
        if (exported.failed > 0) line += `; ${exported.failed} failed — see the debug log`;
        parts.push(line);
    }
    return parts.length > 0 ? `${parts.join('. ')}.` : 'Sync is on.';
}

/** "3 files, 12.4 MB" style summary for the external files row. */
function formatStorageStats(count: number, totalBytes: number): string {
    const files = `${count} file${count === 1 ? '' : 's'}`;
    if (totalBytes <= 0) return files;
    const mb = totalBytes / 1024 / 1024;
    const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(totalBytes / 1024))} KB`;
    return `${files}, ${size}`;
}


const AdvancedSection: React.FC = () => {

    // --- Storage: external files + document cache ---
    const setCurrentMessageExternalFiles = useSetAtom(currentMessageExternalFilesAtom);
    const [externalFileStats, setExternalFileStats] = useState<{ count: number; totalBytes: number } | null>(null);
    const [isDeletingExternalFiles, setIsDeletingExternalFiles] = useState(false);
    const [isDeletingCache, setIsDeletingCache] = useState(false);
    const [cacheDeleted, setCacheDeleted] = useState(false);

    const refreshExternalFileStats = useCallback(async () => {
        try {
            setExternalFileStats(await getExternalFilesStats());
        } catch (error) {
            logger(`AdvancedSection: failed to load external file stats: ${error}`, 1);
            setExternalFileStats(null);
        }
    }, []);

    useEffect(() => {
        refreshExternalFileStats();
    }, [refreshExternalFileStats]);

    const handleShowExternalFilesFolder = useCallback(() => {
        revealExternalFilesDir().catch((error) => {
            logger(`AdvancedSection: failed to reveal external files folder: ${error}`, 1);
        });
    }, []);

    const [syncMode, setSyncMode] = useState(() => conversationSyncMode());
    const [syncFolderPath, setSyncFolderPath] = useState(
        () => String(getPref('conversationSyncFolderPath') ?? ''),
    );
    const [threadExporting, setThreadExporting] = useState(false);
    const [threadExportStatus, setThreadExportStatus] = useState<string | null>(null);

    /*
     * A sync location this computer just started using: take what is there,
     * then back up everything else from here — the same join the welcome
     * wizard runs, so turning sync on here is not only forward-looking. The
     * Export row says what happened.
     */
    const runJoin = useCallback(async () => {
        if (conversationSyncMode() === 'off') {
            setThreadExportStatus(null);
            return;
        }
        setThreadExporting(true);
        setThreadExportStatus('Syncing with the new location…');
        try {
            setThreadExportStatus(describeJoinOutcome(await joinSyncBackend()));
        } catch (error) {
            setThreadExportStatus(`Failed: ${error}`);
        } finally {
            setThreadExporting(false);
        }
    }, []);

    /*
     * Leaving a live backend asks whether to keep or delete ITS remote copies,
     * and never touches the local database. The confirm happens before
     * anything is touched; cancel aborts the switch.
     */
    const applySyncMode = useCallback(async (next: 'off' | 'zotero' | 'folder', nextFolder?: string) => {
        /*
         * All the semantics — the confirm, the folder pick, the old backend's
         * cleanup, the pref writes — live in confirmAndSwitchSyncMode, shared
         * with the welcome wizard so the two surfaces cannot drift. The picker
         * goes in as a callback: the keep/delete question about the backend
         * being left comes first, the folder second, any deletion last.
         */
        const needsPicker = next === 'folder' && !nextFolder && !syncFolderPath;
        const outcome = await confirmAndSwitchSyncMode(next, {
            ...(nextFolder ? { folderPath: nextFolder } : {}),
            ...(needsPicker
                ? {
                    pickFolder: async () => {
                        const picked = await pickFolder('Choose the sync folder');
                        return picked.ok ? picked.path : null;
                    },
                }
                : {}),
        });
        if (outcome === 'cancelled') return;
        setSyncMode(conversationSyncMode());
        setSyncFolderPath(String(getPref('conversationSyncFolderPath') ?? ''));
        if (outcome === 'switched') await runJoin();
    }, [syncFolderPath, runJoin]);

    const handleChooseFolder = useCallback(async () => {
        // Already syncing to a folder: this is a re-point, no mode change and
        // no question to ask. Otherwise it is a switch, and the shared helper
        // asks keep/delete about the old backend BEFORE the picker opens.
        if (conversationSyncMode() !== 'folder') {
            await applySyncMode('folder');
            return;
        }
        const picked = await pickFolder('Choose the sync folder');
        if (!picked.ok) return;
        const changed = picked.path !== String(getPref('conversationSyncFolderPath') ?? '');
        setPref('conversationSyncFolderPath', picked.path);
        setSyncFolderPath(picked.path);
        // A different folder is a different sync location to join.
        if (changed) {
            forgetSyncLocation();
            await runJoin();
        }
    }, [applySyncMode, runJoin]);

    /*
     * Backfill, because turning the switch on is not retroactive.
     *
     * Each finished answer writes its own thread out, so a conversation you
     * never touch again would never travel. This walks what is already on this
     * computer and writes each one the sync location is missing, holds an
     * older copy of, or holds a damaged file for — after a catch-up pass, so a
     * chat archived on another computer since the last one is archived here
     * first rather than written back out as active.
     */
    const handleExportAllThreads = useCallback(async () => {
        if (conversationSyncMode() === 'off' || threadExporting) return;
        setThreadExporting(true);
        setThreadExportStatus(null);
        try {
            const db = (Zotero as any).AlphainZ?.db;
            if (!db) throw new Error('database not available');
            const backend = getConversationBackend();
            if (!backend) throw new Error('no sync backend active');
            const { syncConversationsNow } = await import('../../atoms/loadLocalThreads');
            await syncConversationsNow();
            // A newer copy from another computer is not this one's to overwrite.
            const exported = await exportAllThreads(db, backend, 'local-user', { skipNewerRemote: true });
            setThreadExportStatus(describeJoinOutcome({ adoptedSettings: false, exported }));
        } catch (error) {
            setThreadExportStatus(`Failed: ${error}`);
        } finally {
            setThreadExporting(false);
        }
    }, [threadExporting]);

    const handleDeleteAllExternalFiles = useCallback(async () => {
        const stats = externalFileStats ?? { count: 0, totalBytes: 0 };
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: 'Delete External Files?',
            text:
                `Delete ${formatStorageStats(stats.count, stats.totalBytes)} attached to past chats?\n\n` +
                'AlphainZ will no longer be able to read these files in past conversations. ' +
                'Files can be re-attached at any time.',
            button0: 'Delete',
            // Cancel at button1 so Escape/dialog-close routes here.
            button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;
        setIsDeletingExternalFiles(true);
        try {
            await deleteAllExternalFiles();
            // Pending input-area chips reference the deleted copies.
            setCurrentMessageExternalFiles([]);
        } catch (error) {
            logger(`AdvancedSection: failed to delete external files: ${error}`, 1);
        } finally {
            setIsDeletingExternalFiles(false);
            refreshExternalFileStats();
        }
    }, [externalFileStats, refreshExternalFileStats, setCurrentMessageExternalFiles]);

    const handleDeleteDocumentCache = useCallback(async () => {
        setIsDeletingCache(true);
        try {
            await Zotero.AlphainZ?.documentCache?.clearAll();
            setCacheDeleted(true);
            setTimeout(() => setCacheDeleted(false), 2000);
        } catch (error) {
            logger(`AdvancedSection: failed to clear document cache: ${error}`, 1);
        } finally {
            setIsDeletingCache(false);
        }
    }, []);

    // --- Atoms: MCP Server enabled ---
    const [mcpServerEnabled, setMcpServerEnabled] = useAtom(mcpServerEnabledAtom);
    const [mcpCreateNoteToolEnabled, setMcpCreateNoteToolEnabled] = useAtom(mcpCreateNoteToolEnabledAtom);
    const [mcpCopied, setMcpCopied] = useState(false);
    const [mcpHttpCopied, setMcpHttpCopied] = useState(false);
    const isMcpServerSupported = useAtomValue(isMcpServerSupportedAtom);

    // --- MCP Server port ---
    const mcpServerPort = useMemo(() => {
        try {
            return Zotero.Prefs.get('httpServer.port') || 23119;
        } catch {
            return 23119;
        }
    }, []);

    // --- Copy MCP config for HTTP clients ---
    const handleCopyMcpConfig = useCallback(async () => {
        try {
            const scriptPath = await ensureMcpBridgeScript();
            const serverConfig: any = {
                command: "node",
                args: [scriptPath],
            };
            if (mcpServerPort !== 23119) {
                serverConfig.args.push(String(mcpServerPort));
            }
            const config = JSON.stringify({
                mcpServers: {
                    "alphainz-zotero": serverConfig,
                }
            }, null, 2);
            await copyToClipboard(config);
            setMcpCopied(true);
            setTimeout(() => setMcpCopied(false), 2000);
        } catch (err: any) {
            logger(`Failed to copy MCP config: ${err?.message}`, 1);
        }
    }, [mcpServerPort]);

    const mcpEndpointUrl = `http://localhost:${mcpServerPort}${MCP_ENDPOINT_PATH}`;

    // --- Copy MCP config for HTTPS-only clients ---
    const handleCopyMcpHttpConfig = useCallback(async () => {
        const config = JSON.stringify({
            mcpServers: {
                [MCP_SERVER_NAME]: {
                    type: "http",
                    url: mcpEndpointUrl
                }
            }
        }, null, 2);
        await copyToClipboard(config);
        setMcpHttpCopied(true);
        setTimeout(() => setMcpHttpCopied(false), 2000);
    }, [mcpEndpointUrl]);

    // --- Toggle MCP server enabled ---
    const handleMcpServerToggle = useCallback(() => {
        if (!isMcpServerSupported) return;
        const newValue = !mcpServerEnabled;
        setPref('mcpServerEnabled', newValue);
        setMcpServerEnabled(newValue);
    }, [mcpServerEnabled, isMcpServerSupported, setMcpServerEnabled]);

    const handleMcpCreateNoteToolToggle = useCallback(() => {
        if (!isMcpServerSupported) return;
        const newValue = !mcpCreateNoteToolEnabled;
        setPref('mcpCreateNoteToolEnabled', newValue);
        setMcpCreateNoteToolEnabled(newValue);
    }, [mcpCreateNoteToolEnabled, isMcpServerSupported, setMcpCreateNoteToolEnabled]);

    // --- Long conversations: compaction + old-run trimming ---
    const [compactionEnabled, setCompactionEnabled] = useState(() => getPref('contextCompactionEnabled') === true);
    const handleCompactionToggle = useCallback(() => {
        setCompactionEnabled((v) => {
            setPref('contextCompactionEnabled', !v);
            return !v;
        });
    }, []);
    const [compactionThreshold, setCompactionThreshold] = useState(() => {
        const stored = Number(getPref('contextCompactionThreshold'));
        return Number.isFinite(stored) && stored > 0 ? stored : 80_000;
    });
    const handleThresholdChange = useCallback((value: number) => {
        setPref('contextCompactionThreshold', value);
        setCompactionThreshold(value);
    }, []);
    const [compactAfterRuns, setCompactAfterRuns] = useState(() => {
        const stored = Number(getPref('contextCompactionAfterRuns'));
        return Number.isFinite(stored) && stored >= 4 ? stored : 10;
    });
    const handleAfterRunsChange = useCallback((value: number) => {
        setPref('contextCompactionAfterRuns', value);
        setCompactAfterRuns(value);
    }, []);
    const [composerEngine, setComposerEngine] = useState(() => (getPref('composerEngine') === 'lexical' ? 'lexical' : 'textarea'));
    const handleComposerEngineChange = useCallback((value: string) => {
        setPref('composerEngine', value === 'lexical' ? 'lexical' : 'textarea');
        setComposerEngine(value === 'lexical' ? 'lexical' : 'textarea');
    }, []);
    const [pruneOldTools, setPruneOldTools] = useState(() => getPref('contextPruneOldToolDetail') === true);
    const handlePruneToggle = useCallback(() => {
        setPruneOldTools((v) => {
            setPref('contextPruneOldToolDetail', !v);
            return !v;
        });
    }, []);

    // --- Data provider (library access for other Beaver clients) ---
    const [dataProviderEnabled, setDataProviderEnabled] = useAtom(dataProviderEnabledAtom);
    const handleDataProviderToggle = useCallback(() => {
        const newValue = !dataProviderEnabled;
        setPref('dataProviderEnabled', newValue);
        setDataProviderEnabled(newValue);
    }, [dataProviderEnabled, setDataProviderEnabled]);

    return (
        <>
            {/* ===== CUSTOM INSTRUCTIONS ===== */}
            <CustomInstructionsSection />

            {/* ===== LONG CONVERSATIONS ===== */}
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">Long Conversations</div>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Every message sends the chat so far to the model again, so a long chat costs more
                and answers more slowly. These options shorten what is sent. Your chats stay
                complete on screen and on this computer either way.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="Compact old exchanges automatically"
                    description="When a chat gets long, its older exchanges are summarized (one extra small request) and the model reads the summary instead of them. A marker in the chat shows where; click it to read or discard the summary"
                    onClick={handleCompactionToggle}
                    control={
                        <input type="checkbox" aria-label="Compact old exchanges automatically"
                            checked={compactionEnabled}
                            onChange={handleCompactionToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }} />
                    }
                />
                <SettingsRow
                    title="Compact after"
                    description="Summarize once a chat has more than this many exchanges. Without a summary the model is sent only the last 10 exchanges and sees nothing older"
                    control={
                        <select
                            aria-label="Compact after this many exchanges"
                            value={compactAfterRuns}
                            disabled={!compactionEnabled}
                            onChange={(e) => handleAfterRunsChange(Number(e.target.value))}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: compactionEnabled ? 'pointer' : 'default' }}
                        >
                            <option value={6}>6 exchanges</option>
                            <option value={8}>8 exchanges</option>
                            <option value={10}>10 exchanges</option>
                            <option value={12}>12 exchanges</option>
                            <option value={15}>15 exchanges</option>
                        </select>
                    }
                />
                <SettingsRow
                    title="Compact sooner above"
                    description="Also summarize before that many exchanges once the earlier chat and the attached context sent with each message reach this size (at least 3 exchanges at a time)"
                    control={
                        <select
                            aria-label="Compact sooner above this size"
                            value={compactionThreshold}
                            disabled={!compactionEnabled}
                            onChange={(e) => handleThresholdChange(Number(e.target.value))}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: compactionEnabled ? 'pointer' : 'default' }}
                        >
                            <option value={40_000}>40k tokens</option>
                            <option value={60_000}>60k tokens</option>
                            <option value={80_000}>80k tokens</option>
                            <option value={100_000}>100k tokens</option>
                            <option value={150_000}>150k tokens</option>
                        </select>
                    }
                />
                <SettingsRow
                    title="Trim tool detail from old turns"
                    description="In exchanges older than the last two, long tool inputs and results are shortened before they are sent. Your questions and the answers in those exchanges are not shortened"
                    onClick={handlePruneToggle}
                    control={
                        <input type="checkbox" aria-label="Trim tool detail from old turns"
                            checked={pruneOldTools}
                            onChange={handlePruneToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }} />
                    }
                />
            </SettingsGroup>

            {/* ===== LIMITS PER QUESTION ===== */}
            <RunLimitsSection />

            {/* ===== INPUT ===== */}
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">Input Box</div>
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="Editor engine"
                    description="The native text box keeps the cursor where you put it (recommended). The older rich editor draws command chips inline, but its cursor can jump while you type. Takes effect after restarting Zotero"
                    control={
                        <select
                            aria-label="Composer engine"
                            value={composerEngine}
                            onChange={(e) => handleComposerEngineChange(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer' }}
                        >
                            <option value="textarea">Native text box</option>
                            <option value="lexical">Rich editor (legacy)</option>
                        </select>
                    }
                />
            </SettingsGroup>

            {/* ===== CONVERSATION VIEW ===== */}
            <ConversationViewSection />

            {/* ===== STORAGE ===== */}
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">Conversation Sync</div>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Keeps your conversations and settings on your other machines — either as JSON
                attachments in your Zotero library (your existing Zotero sync carries them), or
                as plain files in a folder you choose (put it inside iCloud Drive, OneDrive or
                any synced folder; the plugin never talks to the cloud itself). One at a time.
                When you switch, you are asked whether to keep the copies in the old place;
                conversations on this computer are always kept.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="Off"
                    description="Conversations stay on this computer only"
                    onClick={() => void applySyncMode('off')}
                    control={
                        <input type="radio" name="conversation-sync-mode" aria-label="Sync off"
                            checked={syncMode === 'off'}
                            onChange={() => void applySyncMode('off')}
                            onClick={(e) => e.stopPropagation()} />
                    }
                />
                <SettingsRow
                    title="Through Zotero sync"
                    description={`Stored under a "${CONVERSATIONS_TITLE}" item in My Library`}
                    onClick={() => void applySyncMode('zotero')}
                    control={
                        <input type="radio" name="conversation-sync-mode" aria-label="Sync through Zotero"
                            checked={syncMode === 'zotero'}
                            onChange={() => void applySyncMode('zotero')}
                            onClick={(e) => e.stopPropagation()} />
                    }
                />
                <SettingsRow
                    title="Synced folder"
                    description={syncMode === 'folder' && syncFolderPath
                        ? syncFolderPath
                        : 'Plain JSON files in a folder you choose, such as one in iCloud Drive or OneDrive'}
                    onClick={() => void applySyncMode('folder')}
                    control={
                        <input type="radio" name="conversation-sync-mode" aria-label="Sync to a folder"
                            checked={syncMode === 'folder'}
                            onChange={() => void applySyncMode('folder')}
                            onClick={(e) => e.stopPropagation()} />
                    }
                />
                {syncMode === 'folder' && (
                    <SettingsRow
                        title="Folder"
                        description={syncFolderPath || 'No folder chosen yet'}
                        control={
                            <div className="display-flex flex-row gap-2">
                                <Button variant="outline" onClick={() => void handleChooseFolder()}>
                                    Choose…
                                </Button>
                                <Button variant="outline" disabled={!syncFolderPath}
                                    onClick={() => { try { Zotero.File.reveal(syncFolderPath); } catch (e) { logger(`reveal: ${e}`, 1); } }}>
                                    Show Folder
                                </Button>
                            </div>
                        }
                    />
                )}
                <SettingsRow
                    title="Export all conversations now"
                    description={threadExportStatus
                        ?? 'Writes each conversation on this computer that the sync location is missing or has an older copy of'}
                    onClick={handleExportAllThreads}
                    disabled={syncMode === 'off' || threadExporting}
                    control={
                        <Button
                            variant="outline"
                            disabled={syncMode === 'off' || threadExporting}
                            onClick={(e) => { e.stopPropagation(); void handleExportAllThreads(); }}
                        >
                            {threadExporting ? 'Exporting…' : 'Export'}
                        </Button>
                    }
                />
            </SettingsGroup>

            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">Storage</div>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Data AlphainZ stores on this computer. This data is not deleted automatically including when the plugin is removed.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="External Files"
                    description={
                        <>
                            Copies of external files you attach to chats.
                            {externalFileStats && externalFileStats.count > 0 && (
                                <span className="display-flex mt-1">
                                    {formatStorageStats(externalFileStats.count, externalFileStats.totalBytes)}
                                </span>
                            )}
                        </>
                    }
                    control={
                        <div className="display-flex flex-row items-center gap-2">
                            <Button
                                variant="outline"
                                onClick={handleDeleteAllExternalFiles}
                                disabled={isDeletingExternalFiles || !externalFileStats || externalFileStats.count === 0}
                                loading={isDeletingExternalFiles}
                                style={{ padding: '4px 6px' }}
                            >
                                Delete All…
                            </Button>
                            <Button
                                variant="outline"
                                onClick={handleShowExternalFilesFolder}
                                style={{ padding: '4px 6px' }}
                            >
                                Show Folder
                            </Button>
                        </div>
                    }
                />
                <SettingsRow
                    title="Document Cache"
                    description="Text extracted from PDFs and other documents, stored to avoid re-processing files"
                    hasBorder
                    control={
                        <Button
                            variant="outline"
                            icon={cacheDeleted ? TickIcon : undefined}
                            onClick={handleDeleteDocumentCache}
                            disabled={isDeletingCache}
                            loading={isDeletingCache}
                            style={{ padding: '4px 6px' }}
                        >
                            {cacheDeleted ? 'Deleted' : 'Delete Cache'}
                        </Button>
                    }
                />
            </SettingsGroup>

            {/* ===== CONNECTED APPS (DATA PROVIDER) ===== */}
            {process.env.NODE_ENV === 'development' && (
                <>
                    <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                        <div className="text-lg font-color-primary font-bold">Connected Apps</div>
                        <span className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary">Experimental</span>
                    </div>
                    <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                        Lets AlphainZ in other apps access your Zotero library while Zotero is running.
                    </div>
                    <SettingsGroup>
                        <SettingsRow
                            title="Allow Library Access"
                            description="AlphainZ chats started in connected apps can search and read this Zotero library"
                            onClick={handleDataProviderToggle}
                            control={
                                <div className="display-flex flex-row items-center gap-2">
                                    <input
                                        type="checkbox"
                                        aria-label="Allow Library Access"
                                        checked={dataProviderEnabled}
                                        onChange={handleDataProviderToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ cursor: 'pointer', margin: 0 }}
                                    />
                                </div>
                            }
                        />
                    </SettingsGroup>
                </>
            )}

            {/* ===== MCP SERVER ===== */}
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">MCP Server</div>
                <span className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary">Experimental</span>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                The MCP server lets AI coding tools like Claude Code, Cursor, and Windsurf search and access your Zotero library.
                {' '}See our <DocLink path="mcp-server">MCP server guide</DocLink> for setup instructions.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="Enable MCP Server"
                    description={`Endpoint at localhost:${mcpServerPort}`}
                    onClick={handleMcpServerToggle}
                    disabled={!isMcpServerSupported}
                    tooltip={isMcpServerSupported
                        ? 'Expose your Zotero library to MCP-compatible AI tools'
                        : 'Only available with AlphainZ Pro'}
                    control={
                        <div className="display-flex flex-row items-center gap-2">
                            <input
                                type="checkbox"
                                aria-label="Enable MCP Server"
                                checked={mcpServerEnabled}
                                onChange={handleMcpServerToggle}
                                onClick={(e) => e.stopPropagation()}
                                disabled={!isMcpServerSupported}
                                style={{ cursor: isMcpServerSupported ? 'pointer' : 'not-allowed', margin: 0 }}
                            />
                        </div>
                    }
                />
                <SettingsRow
                    title="Enable Create Note Tool"
                    description="Allow MCP clients to create Zotero notes. Changing setting requires reloading of the MCP server."
                    onClick={handleMcpCreateNoteToolToggle}
                    hasBorder
                    disabled={!isMcpServerSupported}
                    tooltip={isMcpServerSupported
                        ? 'Advertise and allow the create_note MCP tool'
                        : 'Only available with AlphainZ Pro'}
                    control={
                        <div className="display-flex flex-row items-center gap-2">
                            <input
                                type="checkbox"
                                aria-label="Enable Create Note Tool"
                                checked={mcpCreateNoteToolEnabled}
                                onChange={handleMcpCreateNoteToolToggle}
                                onClick={(e) => e.stopPropagation()}
                                disabled={!isMcpServerSupported}
                                style={{ cursor: isMcpServerSupported ? 'pointer' : 'not-allowed', margin: 0 }}
                            />
                        </div>
                    }
                />
                <SettingsRow
                    title="Config for HTTP Clients"
                    description={
                        <span className="display-flex flex-col gap-05" style={{ opacity: mcpServerEnabled ? 1 : 0.45 }}>
                            <span>For clients that support HTTP directly (e.g., Claude Code, Cursor).</span>
                            {/* <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{mcpEndpointUrl}</span> */}
                        </span>
                    }
                    hasBorder
                    disabled={!mcpServerEnabled}
                    control={
                        <Button
                            variant="outline"
                            icon={mcpHttpCopied ? TickIcon : CopyIcon}
                            onClick={handleCopyMcpHttpConfig}
                            disabled={!mcpServerEnabled}
                            style={{ padding: '4px 6px' }}
                        >
                            {mcpHttpCopied ? 'Copied' : 'Copy'}
                        </Button>
                    }
                />
                <SettingsRow
                    title="Config for HTTPS-Only Clients"
                    description={
                        <span style={{ opacity: mcpServerEnabled ? 1 : 0.45 }}>
                            For clients that only connect to HTTPS endpoints (e.g., Claude Desktop). Requires Node.js.
                        </span>
                    }
                    hasBorder
                    disabled={!mcpServerEnabled}
                    control={
                        <Button
                            variant="outline"
                            icon={mcpCopied ? TickIcon : CopyIcon}
                            onClick={handleCopyMcpConfig}
                            disabled={!mcpServerEnabled}
                            style={{ padding: '4px 6px' }}
                        >
                            {mcpCopied ? 'Copied' : 'Copy'}
                        </Button>
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default AdvancedSection;
