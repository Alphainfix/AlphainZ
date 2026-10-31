import { version } from "../package.json";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { BeaverUIFactory } from "./ui/ui";
import eventBus from "../react/eventBus";
import { CitationService } from "./services/CitationService";
import { BeaverDB } from "./services/database";
import { DocumentCache, DOCUMENT_CACHE_DIR } from "./services/documentCache";
import { BackgroundExtractor } from "./services/backgroundExtractor";
import { uiManager, restoreReaderSidebarWidthHandler } from "../react/ui/UIManager";
import { getPref, setPref } from "./utils/prefs";
import { addPendingVersionNotification } from "./utils/versionNotificationPrefs";
import { adoptLegacyPreferences } from "./utils/legacyPrefs";
import { compareVersions } from "./utils/compareVersions";
import { disposeMuPDFWorker } from "./beaver-extract";
import { configurePDFForBeaver } from "./utils/configurePDFForBeaver";
import { registerBeaverProtocolHandler, unregisterBeaverProtocolHandler } from "./services/protocolHandler";
import { cancelAllActiveTasks } from "./utils/backgroundTasks";
import { initContextMenus, cleanupContextMenus } from "./modules/zoteroContextMenu";
import { applyAppearance, startAppearanceObserver, stopAppearanceObserver } from "./utils/appearance";
import { startSettingsSyncObserver, stopSettingsSyncObserver } from "./services/conversationSync/settingsSync";
import { initReaderIntegration, cleanupReaderIntegration } from "./modules/readerIntegration";
import { initReaderToolbarMenu, cleanupReaderToolbarMenu } from "./modules/readerToolbarMenu";
import { setActionClient } from "@beaver/agent-core/types/actions";
import { ZOTERO_PLUGIN_CLIENT_TYPE } from "@beaver/agent-core/protocol/agentProtocol";
import { PLUGIN_DIR_NAME } from "./utils/pluginPaths";
import { openPluginDatabase } from "./services/pluginDatabaseOpen";

/** Timeout for individual async shutdown operations to prevent hangs. */
const SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * Race a promise against a timeout. Returns the promise result if it
 * settles before the deadline, otherwise resolves with `undefined` and
 * logs a warning.  Never rejects – callers should still wrap in try/catch
 * for safety, but a stalled operation will not block shutdown.
 */
function withShutdownTimeout<T>(
    promise: Promise<T>,
    label: string,
): Promise<T | undefined> {
    let timeoutId: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<undefined>((resolve) => {
            timeoutId = setTimeout(() => {
                Zotero.debug(`[beaver] onMainWindowUnload: ${label} timed out after ${SHUTDOWN_TIMEOUT_MS}ms, continuing shutdown`);
                resolve(undefined);
            }, SHUTDOWN_TIMEOUT_MS);
        }),
    ]).finally(() => clearTimeout(timeoutId));
}

async function cleanupSupabaseWindowState(
    win: Window | null | undefined,
): Promise<void> {
    if (!win) return;

    try {
        if (win.__alphainzDisposeSupabase) {
            await withShutdownTimeout(win.__alphainzDisposeSupabase(), "disposeSupabase");
        }
    } catch (e) {
        ztoolkit.log(`disposeSupabase: ${e}`);
    } finally {
        win.__alphainzDisposeSupabase = undefined;
        delete (win as any).__alphainzAuthLock;
    }
}

/**
 * Close the agent connection via the window's React bundle (`agentService` is
 * per-bundle). Synchronous and best-effort — teardown must not wait on the network.
 */
function closeAgentConnection(
    win: Window | null | undefined,
    reason: string,
    options?: { rememberInterruptedThread?: boolean },
): void {
    const close = (win as any)?.AlphainZReact?.closeAgentConnection;
    if (typeof close !== "function") return;

    try {
        close(reason, options);
    } catch (e) {
        ztoolkit.log(`closeAgentConnection: ${e}`);
    }
}

async function cleanupDevTemporaryAnnotations(
    win: Window | null | undefined,
): Promise<void> {
    if (process.env.NODE_ENV !== "development") return;

    const cleanup = (win as any)?.AlphainZReact?.cleanupTemporaryAnnotations;
    if (typeof cleanup !== "function") return;

    try {
        await withShutdownTimeout(cleanup(), "cleanupTemporaryAnnotations");
    } catch (e) {
        ztoolkit.log(`cleanupTemporaryAnnotations: ${e}`);
    }
}

let isAppQuitting = false;
let quitObserverRegistered = false;
const quitObserver = {
    observe(_subject: any, topic: string) {
        if (topic === "quit-application-granted" || topic === "quit-application") {
            isAppQuitting = true;
            Zotero.__alphainzShuttingDown = true;
        }
        // Close beaver.sqlite on quit-application, BEFORE the
        // profile-before-change barrier where Sqlite.sys.mjs waits for all
        // connections.
        if (topic === "quit-application") {
            try {
                if (addon?.db) {
                    addon.db.closeDatabase().catch((error: unknown) => {
                        Zotero.logError(error as Error);
                    });
                    addon.db = undefined;
                }
            } catch (_) {
                // Best-effort — process is dying
            }
        }
    },
};

function registerQuitObserver(): void {
    if (quitObserverRegistered) return;
    try {
        Services.obs.addObserver(quitObserver, "quit-application-granted");
        Services.obs.addObserver(quitObserver, "quit-application");
        quitObserverRegistered = true;
    } catch (error) {
        ztoolkit.log(`registerQuitObserver: Failed to register quit observer: ${error}`);
    }
}

function unregisterQuitObserver(): void {
    if (!quitObserverRegistered) return;
    try {
        Services.obs.removeObserver(quitObserver, "quit-application-granted");
        Services.obs.removeObserver(quitObserver, "quit-application");
    } catch (error) {
        ztoolkit.log(`unregisterQuitObserver: Failed to unregister quit observer: ${error}`);
    } finally {
        quitObserverRegistered = false;
    }
}

/**
 * Handles upgrade tasks between plugin versions.
 * @param lastVersion The previously installed version
 * @param currentVersion The current plugin version
 */
async function handleUpgrade(lastVersion: string, currentVersion: string) {
    // Mark welcome onboarding as shown for existing users who are upgrading.
    // This prevents the first-install popup from showing to users who already have the plugin.
    // The reader tip is intentionally NOT suppressed — existing users should see it once.
    if (!getPref('onboardingWelcomeShown')) {
        setPref('onboardingWelcomeShown', true);
    }

    // Upgrade to 0.5.0 or newer from a version before 0.5.0
    if (compareVersions(lastVersion, '0.5.0') < 0 && compareVersions(currentVersion, '0.5.0') >= 0) {
        setPref('runConsistencyCheck', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flag set for consistency check.`);
    }

    // Upgrade to 0.6.2 or newer from a version before 0.6.2
    if (compareVersions(lastVersion, '0.6.2') < 0 && compareVersions(currentVersion, '0.6.2') >= 0) {
        setPref('runCollectionSync', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flag set for collection sync.`);
    }

    // Upgrade to 0.8.3 or newer
    if (compareVersions(lastVersion, '0.8.3') < 0 && compareVersions(currentVersion, '0.8.3') >= 0) {
        setPref('runWebDAVSync', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flag set for WebDAV sync.`);
    }

    // Upgrade to 0.11.2 or newer: re-sync items with corrected title/date field mappings
    if (compareVersions(lastVersion, '0.11.2') < 0 && compareVersions(currentVersion, '0.11.2') >= 0) {
        setPref('runConsistencyCheck', true);
        setPref('runEmbeddingFullDiff', true);
        ztoolkit.log(`handleUpgrade: Upgrade detected to ${currentVersion}. Flags set for consistency check and embedding full diff.`);
    }
}

async function onStartup() {
    await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
    ]);

    // If the user quit Zotero before plugins finished initializing, the
    // promises above still resolve but the app is already tearing down.
    // Bail out to avoid opening resources that can never be cleaned up.
    if (Services?.startup?.shuttingDown || Zotero.__alphainzShuttingDown) {
        ztoolkit.log("Startup aborted: app is already shutting down");
        return;
    }

    registerQuitObserver();
    initLocale();
    ztoolkit.log("Startup");

    // -------- Configure the PDF package (esbuild bundle copy) --------
    // Idempotent. Must run before any PDF op. The webpack bundle calls the
    // same adapter from `react/index.tsx` for its own copy of the config.
    configurePDFForBeaver();

    // -------- Declare the client actions are gated on --------
    // Each bundle holds its own copy of this seam, so the webpack bundle
    // registers the same value from `react/index.tsx`.
    setActionClient(ZOTERO_PLUGIN_CLIENT_TYPE);

    // -------- Store plugin version --------
    addon.pluginVersion = version;
    ztoolkit.log(`Plugin version: ${version}`);

    // -------- Initialize database --------
    // Wrap in try/catch so that if any later initialization step fails
    // (e.g. main window already destroyed), we still close the DB
    // connection.  An unclosed connection triggers a FATAL AsyncShutdown
    // timeout crash in Mozilla's Sqlite.sys.mjs shutdown blocker.
    // Take over the inherited database file under this plugin's own name.
    //
    // Both plugins derived the filename from the same constant, so an install
    // with the original Beaver enabled had two plugins writing one SQLite file —
    // the same collision class as the shared `Zotero.AlphainZ` global, and a much
    // more damaging one.
    //
    // Copied rather than moved: the original stays untouched as a fallback, so a
    // failed migration costs disk space instead of a research library's chat
    // history and embedding index.
    adoptLegacyPreferences(
        Services.prefs.getBranch(''),
        addon.data.config.prefsPrefix,
        (message) => ztoolkit.log(message),
    );
    await adoptLegacyDatabase();

    const dbConnection = new Zotero.DBConnection(DB_NAME);
    // Zotero's idle maintenance vacuums its databases by copying them and
    // swapping the copy in, and it counts only writes made inside its own
    // transactions as a reason to give up. Most of this plugin's writes are
    // single statements, so one landing in that window would be lost. Its idle
    // backup and log truncation still run.
    (dbConnection as any).vacuum = async () => false;
    const beaverDB = new BeaverDB(dbConnection);
    addon.db = beaverDB;

    try {
        // Test connection and initialize schema
        await beaverDB.whileOpening(
            openPluginDatabase(dbConnection, PathUtils.join(Zotero.DataDirectory.dir, `${DB_NAME}.sqlite`)),
        );
        await beaverDB.initDatabase(version);

        // -------- Initialize Document Cache --------
        const documentCache = new DocumentCache(beaverDB);
        await documentCache.init();
        // Between init and GC on purpose: init guarantees the directories
        // exist, and GC is what would delete the adopted files for matching
        // no row, so the rebase has to land first.
        await adoptLegacyDocumentCache(beaverDB);
        await documentCache.runStartupGC();
        addon.documentCache = documentCache;
        ztoolkit.log("DocumentCache initialized successfully");

        // -------- Initialize background extraction processor --------
        const backgroundExtractor = new BackgroundExtractor();
        addon.backgroundExtractor = backgroundExtractor;
        backgroundExtractor.start();
        ztoolkit.log("BackgroundExtractor started");

        try {
            const legacyContentCache = PathUtils.join(Zotero.Profile.dir, "beaver", "content-cache");
            if (await IOUtils.exists(legacyContentCache)) {
                await IOUtils.remove(legacyContentCache, { recursive: true });
            }
        } catch (error) {
            ztoolkit.log(`Legacy content-cache cleanup failed: ${error}`);
        }

        // -------- Initialize Citation Service with caching --------
        const citationService = new CitationService(ztoolkit);
        addon.citationService = citationService;
        ztoolkit.log("CitationService initialized successfully");

        // -------- Register keyboard shortcuts --------
        BeaverUIFactory.registerShortcuts();

        // -------- Add event bus to window --------
        const mainWindow = Zotero.getMainWindow();
        if (mainWindow) {
            mainWindow.__alphainzEventBus = eventBus;
        }

        // -------- Register protocol handler (zotero://alphainz) --------
        registerBeaverProtocolHandler();

        // -------- Appearance (theme, font, size) on every pane --------
        applyAppearance();
        startAppearanceObserver();
        startSettingsSyncObserver();

        /*
         * One-time backend migration, before React mounts and reads the mode.
         *
         * A sentinel check rather than a version compare: it also covers a
         * fresh install adopting an old profile, and running it twice is a
         * no-op. The legacy bool stays as read-only input — the read-time
         * fallback in `conversationSyncMode` covers any load-order race.
         */
        {
            const backend = String(getPref('conversationSyncBackend') ?? '');
            if (backend !== 'off' && backend !== 'zotero' && backend !== 'folder') {
                setPref('conversationSyncBackend', getPref('syncThreadsToZotero') ? 'zotero' : 'off');
            }
        }

        // -------- Register Zotero 8 context menus (no-op on Zotero 7) --------
        initContextMenus();

        // -------- Register reader text selection popup & context menu --------
        initReaderIntegration();

        // -------- Register reader toolbar dropdown menu --------
        await initReaderToolbarMenu();

        // -------- Register Zotero preferences pane --------
        await Zotero.PreferencePanes.register({
            pluginID: addon.data.config.addonID,
            src: rootURI + 'content/beaverZoteroPrefs.xhtml',
            scripts: [rootURI + 'content/beaverZoteroPrefs.js'],
            id: 'alphainz-prefpane',
            label: 'AlphainZ',
            image: rootURI + 'content/icons/alphain@0.5x.png',
        });

        // -------- Load UI for all windows --------
        const mainWindows = Zotero.getMainWindows();
        if (mainWindows.length > 0) {
            await Promise.all(
                mainWindows.map((win) => onMainWindowLoad(win)),
            );
        }

        // -------- Handle plugin upgrade --------
        const lastVersion = getPref('installedVersion');
        if (lastVersion && lastVersion !== version) {
            await handleUpgrade(lastVersion, version);
        }

        /*
         * -------- Pull in conversations from the Zotero library --------
         *
         * After everything else, and never blocking startup: the files arrive
         * through Zotero's own sync on its own schedule, so this is a catch-up
         * pass rather than a step that has to succeed. It is safe to repeat —
         * only a strictly newer copy replaces what is here.
         */
        {
            void (async () => {
                try {
                    const { getConversationBackend } = await import(
                        './services/conversationSync'
                    );
                    const backend = getConversationBackend();
                    if (!backend) return;
                    // Archive state first: a conversation deleted on another
                    // machine must not be imported back before its remote copy
                    // has been read as "archived".
                    const reconciled = await backend.reconcileArchive(
                        beaverDB as any,
                        'local-user',
                        new Date().toISOString(),
                    );
                    ztoolkit.log(
                        `conversationSync: archive reconcile ${JSON.stringify(reconciled)}`,
                    );

                    const result = await backend.importAll(
                        beaverDB as any,
                        // Matches react/atoms/auth's LOCAL_USER_ID. Not imported:
                        // that module pulls the Jotai store into this bundle.
                        'local-user',
                    );
                    ztoolkit.log(
                        `threadZoteroSync: startup import ${JSON.stringify(result)}`,
                    );
                } catch (error) {
                    ztoolkit.log(`threadZoteroSync: startup import failed: ${error}`);
                }
            })();
        }

        // -------- Set installed version --------
        setPref('installedVersion', version);
        ztoolkit.log(`Installed version: ${getPref('installedVersion')}`);
    } catch (error) {
        // If startup fails after opening the DB, close it immediately
        // to prevent AsyncShutdown timeout → FATAL ERROR crash.
        ztoolkit.log(`Startup failed, closing database: ${error}`);
        // Stop the background extractor
        try {
            if (addon.backgroundExtractor) {
                await addon.backgroundExtractor.stop();
                addon.backgroundExtractor = undefined;
            }
        } catch (stopError) {
            ztoolkit.log(`Failed to stop backgroundExtractor during startup error recovery: ${stopError}`);
        }
        try {
            if (addon.db) {
                await addon.db.closeDatabase();
                addon.db = undefined;
            }
        } catch (closeError) {
            ztoolkit.log(`Failed to close database during startup error recovery: ${closeError}`);
        }
        throw error;
    }
}

const DB_NAME = "alphainz";
/**
 * Older names this plugin has had, newest first.
 *
 * `alphainreader` is this plugin one rename ago and holds a real library — the
 * chunk index alone is tens of megabytes and costs money to rebuild.
 * `beaver` is the fork's original.
 */
const LEGACY_DB_NAMES = ["alphainreader", "beaver"];

/**
 * One-time copy of the inherited `beaver.sqlite` to this plugin's own file.
 *
 * Runs before the connection is opened, and only when the new file is absent
 * and the old one is present — so it happens once, and never overwrites data
 * this plugin has already written. The `-wal` and `-shm` sidecars are
 * deliberately *not* copied: SQLite rebuilds them, and a stale WAL paired with a
 * fresh main file is how a database gets corrupted.
 */
async function adoptLegacyDatabase(): Promise<void> {
    try {
        const target = PathUtils.join(Zotero.DataDirectory.dir, `${DB_NAME}.sqlite`);
        if (await IOUtils.exists(target)) return;

        for (const name of LEGACY_DB_NAMES) {
            const legacy = PathUtils.join(Zotero.DataDirectory.dir, `${name}.sqlite`);
            if (!(await IOUtils.exists(legacy))) continue;
            // Copied, never moved: a failed migration should cost disk, not a
            // research library's conversations and vector index. The newest
            // name wins, so a rename does not fall back past its own history.
            await IOUtils.copy(legacy, target);
            ztoolkit.log(`adoptLegacyDatabase: copied ${name}.sqlite to ${DB_NAME}.sqlite`);
            return;
        }
    } catch (error) {
        // A failure here means starting from an empty database, which is
        // recoverable; refusing to start is not.
        ztoolkit.log(`adoptLegacyDatabase: skipped (${error})`);
    }
}

/**
 * Carry the document-extraction cache across a rename of the plugin.
 *
 * Two things have to move together. The files live in a directory named after
 * the plugin, and the rows that reference them store an absolute path — so
 * copying the files alone leaves every row pointing at the old location, and
 * the startup GC then deletes the copies for matching no row.
 *
 * Driven by the rows rather than by the directory: the files worth carrying
 * are exactly the ones a payload row still points at, and anything else in
 * there is already garbage the GC exists to collect. Asking the filesystem
 * instead invites the wrong answer — a directory emptied by a previous GC
 * still has its per-library subdirectories, so it looks populated.
 *
 * The cache is derived data, so a failure costs re-extraction rather than
 * anything the user would miss — hence logged, not raised. Files are copied,
 * not moved, and the legacy directory is left alone: until the rebase commits,
 * those files are the only ones any row points at.
 */
async function adoptLegacyDocumentCache(db: BeaverDB): Promise<void> {
    try {
        const profileDir = Zotero.Profile.dir;
        const targetCache = PathUtils.join(profileDir, PLUGIN_DIR_NAME, DOCUMENT_CACHE_DIR);
        const payloads = await db.getAllDocumentCachePayloads();
        if (!payloads.length) return;

        // Every legacy name, not just the newest: rows inherited across two
        // renames point at two different directories, and a name skipped here
        // stays a live dependency on a directory this plugin no longer owns.
        for (const name of LEGACY_DB_NAMES) {
            if (name === PLUGIN_DIR_NAME) continue;
            const legacyCache = PathUtils.join(profileDir, name, DOCUMENT_CACHE_DIR);
            const stranded = payloads.filter(payload =>
                payload.payloadPath.startsWith(`${legacyCache}/`));
            if (!stranded.length) continue;

            let carried = 0;
            for (const payload of stranded) {
                const dest = targetCache + payload.payloadPath.slice(legacyCache.length);
                if (await IOUtils.exists(dest).catch(() => false)) {
                    carried++;
                    continue;
                }
                // A row whose file is already gone is left to the GC, which
                // drops the row and schedules a re-extraction.
                if (!(await IOUtils.exists(payload.payloadPath).catch(() => false))) continue;
                const destDir = PathUtils.parent(dest);
                if (!destDir) continue;
                await IOUtils.makeDirectory(destDir, {
                    createAncestors: true,
                    ignoreExisting: true,
                });
                await IOUtils.copy(payload.payloadPath, dest);
                carried++;
            }

            const rebased = await db.rebaseDocumentCachePayloadPaths(legacyCache, targetCache);
            ztoolkit.log(
                `adoptLegacyDocumentCache: carried ${carried} of ${stranded.length} file(s) from ${name}/, rebased ${rebased} row(s)`,
            );
        }
    } catch (error) {
        ztoolkit.log(`adoptLegacyDocumentCache: skipped (${error})`);
    }
}

async function onMainWindowLoad(win: Window): Promise<void> {
    // Create ztoolkit for every window
    addon.data.ztoolkit = createZToolkit();

    // Re-configure the PDF package on every main-window load. Required for
    // the macOS close-last-window-then-reopen lifecycle (see CLAUDE.md):
    // `onStartup()` does not re-run, but the package's module-scope config
    // and the worker's per-window state must be valid for the new window.
    // Idempotent — `configurePDF()` overwrites prior config.
    configurePDFForBeaver();

    registerMainWindowFtl(win);

    // Wait for the UI to be ready
    await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
    ]);

    // Assign the global eventBus instance to this window.
    win.__alphainzEventBus = eventBus;

    BeaverUIFactory.registerChatPanel(win);

    ztoolkit.log("UI ready");
    
    // Load styles for this window
    loadStylesheet();
    loadKatexStylesheet(win);
    ztoolkit.log("Styles loaded for window");
}

/**
 * Cleanup handler for main window unload.
 * 
 * IMPORTANT: This is where ALL cleanup must happen because:
 * 1. onShutdown() is called AFTER Zotero's internal shutdown begins
 * 2. By the time onShutdown() runs, the crash has already occurred
 * 3. Cleanup must happen during window unload, before Zotero's internal cleanup
 * 
 * The cleanup order matters to prevent SIGSEGV crashes:
 * 1. Dispose native resources (MuPDF WASM, database)
 * 2. Unregister Zotero.Reader event listeners 
 * 3. Restore Zotero.Reader.onChangeSidebarWidth
 * 4. Unmount React components
 * 5. Unload stylesheets
 */
async function onMainWindowUnload(win: Window): Promise<void> {
    ztoolkit.log("onMainWindowUnload: Starting cleanup");

    try {
        // Close first: later steps can await, and the window may be gone when
        // this handler returns. Read quitting and the window count here — the
        // later scope check runs after those awaits.
        const appGoingAway = isAppQuitting || (Services?.startup?.shuttingDown ?? false);
        const isLastMainWindow = Zotero.getMainWindows()
            .filter(w => w !== win && !w.closed).length === 0;
        // Record only when Beaver itself is going away. Closing one of several
        // windows also abandons the run, but Beaver keeps running, so a
        // "Beaver closed mid-response" offer would be false — in the surviving
        // window (which runs its own bundle) it would even appear mid-session.
        // That thread is still in the chat history to reopen.
        //
        // On a quit every window is going away, and the one holding the socket
        // is not necessarily the last to unload — the later ones have nothing
        // left to close, so gating on "last window" alone would record nothing.
        closeAgentConnection(
            win,
            appGoingAway ? "Zotero quitting" : "Main window closed",
            { rememberInterruptedThread: appGoingAway || isLastMainWindow },
        );

        // Worker-window hygiene: dispose a slot's client when the closing
        // window is either the realm that spawned its worker (the next
        // postMessage would throw) or the realm whose bundle constructed
        // the client itself.
        try {
            const hotClient = (Zotero as any).__alphainzMuPDFWorkerClient_hot as
                | { spawnedFromWindow: Window | null; createdFromWindow?: Window | null }
                | undefined;
            const backgroundClient = (Zotero as any).__alphainzMuPDFWorkerClient_background as
                | { spawnedFromWindow: Window | null; createdFromWindow?: Window | null }
                | undefined;
            const slots: Array<["hot" | "background", typeof hotClient]> = [
                ["hot", hotClient],
                ["background", backgroundClient],
            ];
            for (const [name, client] of slots) {
                if (
                    client
                    && (client.spawnedFromWindow === win
                        || client.createdFromWindow === win)
                ) {
                    // For the background slot, abort the processor's
                    // in-flight job FIRST.
                    if (name === "background" && addon.backgroundExtractor) {
                        try {
                            await withShutdownTimeout(
                                addon.backgroundExtractor.abortInFlight(),
                                "backgroundExtractor.abortInFlight",
                            );
                        } catch (_e) {
                            // best-effort
                        }
                    }
                    await withShutdownTimeout(
                        disposeMuPDFWorker(name),
                        `disposeMuPDFWorker(${name})`,
                    );
                }
            }
        } catch (_e) {
            // best-effort
        }

        // Determine cleanup scope BEFORE unmounting React, so we can set
        // the shutdown flag before React cleanup effects run.
        const remainingWindows = Zotero.getMainWindows().filter(w => w !== win && !w.closed);
        const isLastWindow = remainingWindows.length === 0;
        const isAppShuttingDown = Services?.startup?.shuttingDown ?? false;
        const shouldRunGlobalCleanup = isLastWindow && (isAppQuitting || isAppShuttingDown);

        // If this is a full shutdown, signal it BEFORE React unmount.
        // React cleanup effects (useZoteroSync, useEmbeddingIndex, etc.)
        // check this flag to skip fire-and-forget async operations that
        // would otherwise outlive the plugin and cause segfaults.
        if (shouldRunGlobalCleanup) {
            ztoolkit.log("onMainWindowUnload: Setting shutdown flag and cancelling in-flight operations");
            Zotero.__alphainzShuttingDown = true;
            addon.data.alive = false;

            // Cancel all background tasks (sync, PDF fetch, metadata enrich)
            // and clear their 60-second cleanup timers that keep the event loop alive.
            cancelAllActiveTasks();
        }

        // Clean up window-specific resources

        // Clean up event bus for this window
        if (win.__alphainzEventBus) {
            win.__alphainzEventBus = null;
        }

        // Stop the busy-context heartbeat timer (registered by busyContext.ts in
        // the webpack bundle) so it doesn't outlive the window.
        try {
            win.__alphainzStopBusyHeartbeat?.();
        } catch (e) {
            ztoolkit.log(`stopBusyHeartbeat: ${e}`);
        }

        // Resume Zotero sync suppression held by a mutating agent run before
        // this window's timers and React cleanup are torn down.
        try {
            const rescheduleSync = !(isAppQuitting || isAppShuttingDown);
            win.__alphainzResumeSyncAfterRun?.(rescheduleSync);
        } catch (e) {
            ztoolkit.log(`resumeSyncAfterRun: ${e}`);
        }

        // The separate Beaver and preferences windows render with THIS window's
        // React instance and share its Jotai store, so they cannot outlive it.
        // Close them before React is torn down (their roots then unmount
        // cleanly). This runs on every main-window unload, not only during
        // global cleanup: with several main windows the owner can close while
        // others remain, and on macOS the app keeps running after the last
        // window closes — in both cases a surviving auxiliary window would be
        // frozen against a dead bundle, with its state invisible to the bundle
        // a reopened main window loads.
        BeaverUIFactory.closeWindowsRenderedBy(win, isLastWindow);

        // Dev-only: visualizer highlights are temporary reader annotations
        // owned by the React bundle, so clear them before unmounting React.
        await cleanupDevTemporaryAnnotations(win);

        // Remove React components and DOM elements for this window.
        // React cleanup effects run here — they will see the shutdown
        // flag and skip any fire-and-forget DB/network operations.
        BeaverUIFactory.removeChatPanel(win);

        // Remove the <link rel="localization"> we added in onMainWindowLoad.
        // Leaving it behind after disable causes the locale bundle to log
        // "Missing resource" and emits an uncaught promise rejection on the
        // next popup translation, breaking Zotero's right-click menu.
        unregisterMainWindowFtl(win);

        if (!isLastWindow) {
            ztoolkit.log("onMainWindowUnload: Other windows remain, skipping global cleanup");
            return;
        }

        // Restore Zotero.Reader.onChangeSidebarWidth even when the app keeps
        // running (macOS last-window close): the wrapper was installed by this
        // window's React bundle and would otherwise outlive the window on the
        // app-lifetime Zotero.Reader singleton, pinning the closed window's
        // compartment. It is re-installed on the next sidebar open.
        restoreReaderSidebarWidthHandler();

        if (!shouldRunGlobalCleanup) {
            ztoolkit.log("onMainWindowUnload: Last window closed but app still running, skipping global cleanup");
            return;
        }

        ztoolkit.log("onMainWindowUnload: Last window closing, running global cleanup");

        // Global cleanup - only run when last window closes

        // 1. Stop Supabase auto-refresh timer to prevent stale timers
        //    surviving plugin reload and causing token refresh races.
        //    The cleanup function is published by zoteroSupabaseStorage.ts
        //    (webpack bundle) on the window where the bundle was loaded.  Use
        //    the `win` parameter (the window being unloaded) rather than
        //    Zotero.getMainWindow(), which may be unreliable during unload of
        //    the last window.
        // Reset the shared auth lock even if disposing Supabase fails so a
        // stale held-lock cannot block authentication on the next load.
        await cleanupSupabaseWindowState(win);

        // 2. Stop the background extraction processor. It owns the
        //    background MuPDFWorkerClient and an in-flight extraction may
        //    still be running; the stop() call aborts it cooperatively and
        //    disposes the worker.
        if (addon.backgroundExtractor) {
            await withShutdownTimeout(
                addon.backgroundExtractor.stop(),
                "backgroundExtractor.stop",
            );
            addon.backgroundExtractor = undefined;
        }

        // 3. Terminate the remaining MuPDF worker(s). Sentencex lives
        //    inside the worker and dies with `worker.terminate()`. With
        //    `name` omitted, disposes any slot still alive (the hot one
        //    in the steady state; the background slot was already
        //    disposed by step 2).
        await withShutdownTimeout(disposeMuPDFWorker(), "disposeMuPDFWorker");

        addon.documentCache = undefined;

        // 4. Close database connection
        if (addon.db) {
            await withShutdownTimeout(addon.db.closeDatabase(), "closeDatabase");
            addon.db = undefined;
        }

        // 4. Dispose CitationService
        if (addon.citationService) {
            addon.citationService.dispose();
            addon.citationService = undefined;
        }

        // 5. Unregister keyboard shortcuts (clears interval, unregisters Zotero.Reader listeners)
        BeaverUIFactory.unregisterShortcuts();

        // 6. Clean up UIManager (restores Zotero.Reader.onChangeSidebarWidth)
        if (uiManager) {
            uiManager.cleanup();
        }

        // 7. Unload stylesheets
        unloadKatexStylesheet(win);
        unloadStylesheet();

        // 8. Unregister ztoolkit and the pref observers
        stopAppearanceObserver();
        stopSettingsSyncObserver();
        ztoolkit.unregisterAll();
        addon.data.dialog?.window?.close();

        // 9. Close separate Beaver and preferences windows if any survived
        //    (normally already closed above, before React was torn down)
        BeaverUIFactory.closeBeaverWindow();
        BeaverUIFactory.closePreferencesWindow();

        // 10. Unregister quit observer
        unregisterQuitObserver();

        // 11. Unregister context menus
        cleanupContextMenus();

        // 12. Unregister reader integration listeners
        cleanupReaderIntegration();

        // 13. Unregister reader toolbar menu
        cleanupReaderToolbarMenu();

        // 14. Unregister protocol handler
        unregisterBeaverProtocolHandler();

        // 15. Drop React-bundle cross-bundle globals attached to Zotero
        Zotero.__alphainzJotaiStore = undefined;
        Zotero.__alphainzShuttingDown = undefined;
        Zotero.__alphainzWrittenAnnotationItems = undefined;
        Zotero.__alphainzWrittenAnnotationKeys = undefined;

        ztoolkit.log("onMainWindowUnload: Cleanup completed successfully");
    } catch (error: any) {
        ztoolkit.log(`onMainWindowUnload: Error during cleanup: ${error.message}`);
    }
}

/**
 * Global AUTHOR_SHEETs, in cascade order.
 *
 * The `agent-ui-*` sheets come from `packages/agent-ui/src/theme/` and are copied
 * into `addon/content/styles/` at build time by `scripts/copy-agent-ui-css.mjs`,
 * so they are generated, not checked in. `agent-ui-tokens.css` holds Beaver's own
 * custom properties plus the documented contract of platform tokens Zotero
 * supplies; `agent-ui-utilities.css` holds the utility layer, scoped
 * `.alphainz-root`; `agent-ui-components.css` holds the shared component rules —
 * today the sign-in surface and the link vocabulary.
 *
 * Order is the cascade. The shared sheets are registered *before* `beaver.css` so
 * this client's own rules win at equal specificity — the package supplies the
 * shared baseline, this client adapts it. Tokens precede the utilities that
 * consume them, and the components sheet follows both: it is written in that
 * vocabulary and has to beat it where the two land on one element, which
 * `.text-link` beside `.font-color-secondary` does.
 *
 * Kept as separate sheets rather than concatenated, so provenance stays readable
 * and the shared files are byte-identical to what the Word add-in imports. Keep
 * this list in step with the `<?xml-stylesheet?>` links in `beaverWindow.xhtml`
 * and `beaverPreferences.xhtml`.
 */
const GLOBAL_STYLESHEETS = [
    "agent-ui-tokens.css",
    "agent-ui-utilities.css",
    "agent-ui-components.css",
    "beaver.css",
    // Last, so a theme's token overrides win over every sheet above it.
    "alphainz-appearance.css",
];

function loadStylesheet() {
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    for (const name of GLOBAL_STYLESHEETS) {
        const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/${name}`;
        const styleSheet = Services.io.newURI(styleURI);
        // Per sheet, so one missing file cannot cost the others. The agent-ui
        // sheets are copied in at build time rather than checked in, so a build
        // that skipped `copy:agent-ui-css` would otherwise take beaver.css down
        // with it and render the whole plugin unstyled.
        try {
            if (ssService.sheetRegistered(styleSheet, sheetType)) {
                ssService.unregisterSheet(styleSheet, sheetType);
            }
            ssService.loadAndRegisterSheet(styleSheet, sheetType);
        } catch (error) {
            Zotero.logError(
                new Error(`AlphainZ: failed to register ${name}: ${error}`),
            );
        }
    }
}

function unloadStylesheet() {
    const ssService = Cc["@mozilla.org/content/style-sheet-service;1"]
        .getService(Ci.nsIStyleSheetService);
    const sheetType = Ci.nsIStyleSheetService.AUTHOR_SHEET!;
    for (const name of GLOBAL_STYLESHEETS) {
        const styleURI = `chrome://${addon.data.config.addonRef}/content/styles/${name}`;
        const styleSheet = Services.io.newURI(styleURI);
        if (ssService.sheetRegistered(styleSheet, sheetType)) {
            ssService.unregisterSheet(styleSheet, sheetType);
        }
    }
}

/**
 * Load KaTeX stylesheet as a per-document <link> element instead of a global
 * AUTHOR_SHEET. This prevents the note editor iframe (resource://zotero/note-editor/)
 * from attempting to load chrome://alphainz/ font resources, which its security
 * policy blocks.
 */
function loadKatexStylesheet(win: Window) {
    if (!win?.document) return;
    const doc = win.document;
    if (doc.getElementById("alphainz-katex-stylesheet")) return;
    const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "html:link") as HTMLLinkElement;
    link.id = "alphainz-katex-stylesheet";
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = `chrome://${addon.data.config.addonRef}/content/styles/katex-embedded.css`;
    doc.documentElement.appendChild(link);
}

function unloadKatexStylesheet(win: Window) {
    if (!win?.document) return;
    const el = win.document.getElementById("alphainz-katex-stylesheet");
    if (el) el.remove();
}

/**
 * Register Beaver's mainWindow.ftl as a <link rel="localization"> in the
 * window's DOM, mirroring MozXULElement.insertFTLIfNeeded
 */
function registerMainWindowFtl(win: Window): void {
    if (!win?.document) return;
    const doc = win.document;
    const ftlPath = `${addon.data.config.addonRef}-mainWindow.ftl`;
    const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
    const XHTML_NS = 'http://www.w3.org/1999/xhtml';
    let container: Element | null = doc.head || doc.querySelector('linkset');
    if (!container) {
        if (doc.documentElement.namespaceURI === XUL_NS) {
            container = doc.createXULElement('linkset');
            doc.documentElement.appendChild(container);
        } else {
            container = doc.documentElement;
        }
    }
    const alreadyPresent = Array.from(container.querySelectorAll('link')).some(
        (l: any) => l?.getAttribute('href') === ftlPath,
    );
    if (alreadyPresent) return;
    const link = doc.createElementNS(XHTML_NS, 'link');
    link.setAttribute('rel', 'localization');
    link.setAttribute('href', ftlPath);
    container.appendChild(link);
}

function unregisterMainWindowFtl(win: Window): void {
    if (!win?.document) return;
    const doc = win.document;
    const ftlPath = `${addon.data.config.addonRef}-mainWindow.ftl`;
    const link = doc.querySelector(`link[rel="localization"][href="${ftlPath}"]`);
    if (link) link.remove();
}

/**
 * Plugin shutdown handler.
 * 
 * NOTE: Most cleanup should happen in onMainWindowUnload() instead.
 * This function runs AFTER Zotero's internal cleanup has begun,
 * which can cause SIGSEGV if we try to access destroyed objects.
 * 
 * This is kept as a fallback for any remaining cleanup.
 */
async function onShutdown(): Promise<void> {
    ztoolkit.log("onShutdown: Running fallback cleanup");
    
    try {
        const isAppShuttingDown = Services?.startup?.shuttingDown ?? false;
        if (!isAppShuttingDown) {
            const openWindows = Zotero.getMainWindows?.().filter(w => w && !w.closed) ?? [];
            for (const win of openWindows) {
                // Plugin disable/uninstall/upgrade: windows are still alive.
                // The bundle goes away with the plugin, so an interrupted run
                // is worth recording however many windows are open.
                closeAgentConnection(win as Window, "AlphainZ plugin shutting down", {
                    rememberInterruptedThread: true,
                });
                await cleanupDevTemporaryAnnotations(win as Window);
                BeaverUIFactory.removeChatPanel(win as Window);
            }
        }

        // These should already be done in onMainWindowUnload, but just in case
        try {
            await cleanupSupabaseWindowState(Zotero.getMainWindow());
        } catch (_e) { /* may not be available during shutdown */ }

        if (addon.backgroundExtractor) {
            try {
                await addon.backgroundExtractor.stop();
            } catch (_e) { /* best-effort */ }
            addon.backgroundExtractor = undefined;
        }

        addon.documentCache = undefined;

        if (addon.db) {
            await addon.db.closeDatabase();
            addon.db = undefined;
        }

        if (addon.citationService) {
            addon.citationService.dispose();
            addon.citationService = undefined;
        }

        BeaverUIFactory.unregisterShortcuts();

        if (uiManager) {
            uiManager.cleanup();
        }

        BeaverUIFactory.closeBeaverWindow();
        BeaverUIFactory.closePreferencesWindow();

        // Remove the FTL <link> from any still-open main windows so the
        // locale bundle doesn't try to resolve Beaver's FTL after disable,
        // which breaks Zotero's right-click menu.
        const openWins = Zotero.getMainWindows?.().filter(w => w && !w.closed) ?? [];
        for (const w of openWins) {
            unregisterMainWindowFtl(w as Window);
            unloadKatexStylesheet(w as Window);
        }
        unloadStylesheet();
        
        unregisterQuitObserver();
        cleanupContextMenus();
        cleanupReaderIntegration();
        cleanupReaderToolbarMenu();
        unregisterBeaverProtocolHandler();

        ztoolkit.unregisterAll();
        addon.data.dialog?.window?.close();
        addon.data.alive = false;

        // Drop React-bundle cross-bundle globals so plugin disable doesn't
        // leak the Jotai store (dead atom-keyed entries) or leave a stale
        // shutdown flag that would short-circuit the next onStartup().
        Zotero.__alphainzJotaiStore = undefined;
        Zotero.__alphainzShuttingDown = undefined;
        Zotero.__alphainzWrittenAnnotationItems = undefined;
        Zotero.__alphainzWrittenAnnotationKeys = undefined;
        // Note: the singleton is removed from Zotero in addon/bootstrap.js's
    } catch (error) {
        ztoolkit.log("onShutdown: Error during cleanup:", error);
    } finally {
        // A step above that threw must not leave the connection open behind a
        // plugin that is going away: the next one would find the database not
        // closed and have Zotero check all of it.
        if (addon.db) {
            try {
                await addon.db.closeDatabase();
            } catch (e) {
                ztoolkit.log("onShutdown: closeDatabase failed:", e);
            }
            addon.db = undefined;
        }
        // Force-clear the cross-bundle MuPDF worker slots even if the cleanup
        // above threw
        try {
            await disposeMuPDFWorker(undefined, { force: true });
        } catch (e) {
            ztoolkit.log("onShutdown: disposeMuPDFWorker failed:", e);
        }
    }
}

export default {
    onStartup,
    onShutdown,
    onMainWindowLoad,
    onMainWindowUnload
};

