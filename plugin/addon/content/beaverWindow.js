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
    const mountContainer = document.getElementById('alphainz-pane-window');
    if (mountContainer) {
        Zotero.UIProperties.registerRoot(mountContainer);
    }

    // Register keyboard shortcut for closing the window (Cmd+W on Mac, Ctrl+W on Windows)
    window.addEventListener("keydown", (event) => {
        // Check for Cmd+W (Mac) or Ctrl+W (Windows)
        const isMacClose = Zotero.isMac && event.key === 'w' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        const isWindowsClose = !Zotero.isMac && event.key === 'w' && event.ctrlKey && !event.altKey && !event.shiftKey;
        
        if (isMacClose || isWindowsClose) {
            event.preventDefault();
            window.close();
        }
    });

    // Use the main window's AlphainZReact instance to ensure shared state (Jotai store)
    // This allows the separate window to share the same Atom instances and Store as the main window
    const mainWindow = Zotero.getMainWindow();
    
    if (mainWindow && mainWindow.AlphainZReact) {
        AlphainZReact = mainWindow.AlphainZReact;

        // Record which main window's bundle renders this one. That bundle owns
        // our React root and Jotai store, so the plugin closes this window when
        // that main window unloads (a surviving window would be frozen against
        // a dead bundle).
        window.__alphainzOwnerWindowRef = new WeakRef(mainWindow);
        
        if (typeof AlphainZReact.renderWindowSidebar === "function") {
            // Note: We use "alphainz-pane-window" to match the CSS selectors in beaver.css
            const container = document.getElementById("alphainz-pane-window");
            if (container) {
                // Render into this window's container using the main window's React instance
                root = AlphainZReact.renderWindowSidebar(container);
                Zotero.debug("AlphainZ: Separate window React component mounted using Main Window instance");
            } else {
                Zotero.debug("AlphainZ Error: Container element #alphainz-pane-window not found");
            }
        } else {
            Zotero.debug("AlphainZ Error: renderWindowSidebar function not found on Main Window instance");
        }
    } else {
        Zotero.debug("AlphainZ Error: Main Window AlphainZReact instance not found");
        
        // Fallback: If for some reason we can't get the main window instance,
        // we could try to load the bundle locally, but that causes the state split issue.
        // Better to fail and log than to show a broken login screen.
    }
}

function onUnload() {
    // Use the stored AlphainZReact reference (which points to Main Window's instance)
    try {
        if (AlphainZReact && typeof AlphainZReact.unmountFromElement === "function") {
            const container = document.getElementById("alphainz-pane-window");
            if (container) {
                AlphainZReact.unmountFromElement(container);
                Zotero.debug("AlphainZ: Separate window React component unmounted");
            }
        }
    } catch (e) {
        Zotero.debug("AlphainZ: Error unmounting separate window: " + e);
    }
    
    // Clear references to help garbage collection
    AlphainZReact = null;
    root = null;
}

// Set up event listeners
window.addEventListener("load", onLoad, { once: true });
window.addEventListener("unload", onUnload, { once: true });
