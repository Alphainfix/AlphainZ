/* eslint-disable no-undef, no-restricted-globals */
// Get Zotero using the modern ES module import (same as Zotero's note window)
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");

var AlphainZReact;
var root;

async function onLoad() {
    // Wait for Zotero initialization
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;

    // Apply Zotero's font-size and UI density preferences to the React mount point.
    // This mirrors how Zotero's own windows do it (e.g. zoteroPane.js calls registerRoot
    // on #zotero-pane, advancedSearch.js on #zotero-search-box-container).
    const mountContainer = document.getElementById('alphainz-pane-preferences');
    if (mountContainer) {
        Zotero.UIProperties.registerRoot(mountContainer);
    }

    // Register keyboard shortcut for closing the window (Cmd+W on Mac, Ctrl+W on Windows)
    window.addEventListener("keydown", (event) => {
        const isMacClose = Zotero.isMac && event.key === 'w' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        const isWindowsClose = !Zotero.isMac && event.key === 'w' && event.ctrlKey && !event.altKey && !event.shiftKey;

        if (isMacClose || isWindowsClose) {
            event.preventDefault();
            window.close();
        }
    });

    // Read the initial tab (and, for the Actions tab, an initial category filter
    // or an action to open in edit mode) from window arguments (if passed)
    var initialTab = null;
    var initialActionsCategoryFilter = null;
    var initialActionId = null;
    try {
        if (window.arguments && window.arguments[0]) {
            if (window.arguments[0].tab) {
                initialTab = window.arguments[0].tab;
            }
            // `!= null` so the uncategorized filter (`""`) is not dropped as falsy.
            if (window.arguments[0].actionsCategoryFilter != null) {
                initialActionsCategoryFilter = window.arguments[0].actionsCategoryFilter;
            }
            if (window.arguments[0].actionId) {
                initialActionId = window.arguments[0].actionId;
            }
        }
    } catch (e) {
        // Ignore errors reading arguments
    }

    // Use the main window's AlphainZReact instance to ensure shared state (Jotai store)
    const mainWindow = Zotero.getMainWindow();

    if (mainWindow && mainWindow.AlphainZReact) {
        AlphainZReact = mainWindow.AlphainZReact;

        // Record which main window's bundle renders this one. That bundle owns
        // our React root and Jotai store, so the plugin closes this window when
        // that main window unloads (a surviving window would be frozen against
        // a dead bundle).
        window.__alphainzOwnerWindowRef = new WeakRef(mainWindow);

        if (typeof AlphainZReact.renderPreferencesWindow === "function") {
            const container = document.getElementById("alphainz-pane-preferences");
            if (container) {
                root = AlphainZReact.renderPreferencesWindow(container, initialTab, initialActionsCategoryFilter, initialActionId);
                Zotero.debug("AlphainZ: Preferences window React component mounted");
            } else {
                Zotero.debug("AlphainZ Error: Container element #alphainz-pane-preferences not found");
            }
        } else {
            Zotero.debug("AlphainZ Error: renderPreferencesWindow function not found on Main Window instance");
        }
    } else {
        Zotero.debug("AlphainZ Error: Main Window AlphainZReact instance not found for preferences window");
    }
}

function onUnload() {
    try {
        if (AlphainZReact && typeof AlphainZReact.unmountFromElement === "function") {
            const container = document.getElementById("alphainz-pane-preferences");
            if (container) {
                AlphainZReact.unmountFromElement(container);
                Zotero.debug("AlphainZ: Preferences window React component unmounted");
            }
        }
    } catch (e) {
        Zotero.debug("AlphainZ: Error unmounting preferences window: " + e);
    }

    // Clear references to help garbage collection
    AlphainZReact = null;
    root = null;
}

// Set up event listeners
window.addEventListener("load", onLoad, { once: true });
window.addEventListener("unload", onUnload, { once: true });
