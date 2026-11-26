/* eslint-disable no-undef, no-restricted-globals */
/**
 * Script for the Beaver pane in Zotero's Preferences window.
 *
 * Registered via the `scripts` option of `Zotero.PreferencePanes.register()`
 * (see `src/hooks.ts`), which loads it into a sandbox scoped to the
 * preferences window before the pane markup is inserted.
 *
 * The handler lives here rather than in an `oncommand` attribute on the button
 * because Firefox 153 (Zotero 11) applies a baseline `script-src` CSP to every
 * chrome: document, which blocks inline event handlers. Zotero disables that
 * CSP for now but intends to remove the override.
 *
 * Because the script runs *before* the pane fragment is inserted, the button
 * does not exist yet — so this listens for the `command` event as it bubbles
 * up to the document instead of binding to the element directly.
 */
document.addEventListener("command", (event) => {
    const target = event.target;
    if (!target || target.id !== "alphainz-open-prefs-btn") {
        return;
    }

    const mainWin = Zotero.getMainWindow();
    if (!mainWin) {
        return;
    }
    mainWin.focus();

    const eventBus = mainWin.__alphainzEventBus;
    if (!eventBus) {
        return;
    }
    eventBus.dispatchEvent(
        new mainWin.CustomEvent("toggleChat", {
            detail: { forceOpen: true },
        }),
    );
});

/*
 * The button's label in the plugin's interface language: Chinese when the
 * plugin is set to Chinese, or set to follow Zotero and Zotero is in Chinese.
 * The pane fragment is inserted after this script runs, so wait for the button.
 */
(function labelOpenButton() {
    let setting = "auto";
    try {
        setting = Zotero.Prefs.get("extensions.zotero.alphainz.uiLanguage", true) || "auto";
    } catch (_e) { /* default */ }
    const chinese = setting === "zh-CN" || (setting !== "en" && /^zh(\b|[-_])/i.test(String(Zotero.locale || "")));
    if (!chinese) return;
    const apply = () => {
        const button = document.getElementById("alphainz-open-prefs-btn");
        if (!button) return false;
        button.setAttribute("label", "打开 AlphainZ");
        return true;
    };
    if (apply()) return;
    const observer = new MutationObserver(() => {
        if (apply()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
})();
