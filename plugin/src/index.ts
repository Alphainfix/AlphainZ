import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

// Always construct a fresh Addon on script load
_globalThis.addon = new Addon();
defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
});
// @ts-ignore - Plugin instance is not typed
Zotero[config.addonInstance] = _globalThis.addon;

/*
 * No `Zotero.Beaver` alias any more.
 *
 * The React bundle reaches the addon through this global in ~90 places, and it
 * used to be aliased to the inherited name so merges from upstream would not
 * conflict at every one of them. That trade was wrong, and the way it was wrong
 * is the worst kind: with the real Beaver plugin also enabled, **whichever
 * loads second owns the name** — and the name carries `.db`. Our code would
 * then read and write Beaver's database, and Beaver's would read ours, with
 * nothing anywhere to say so.
 *
 * Every shared name is now our own: the global, the `/alphainz/*` HTTP routes,
 * the `zotero://alphainz` handler, the window globals. Two plugins in one
 * Zotero no longer touch each other's anything. Merges from upstream cost more;
 * a silently shared database costs more than that.
 */

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
    // `configurable: true` so a re-define (defensive — should not happen in
    // practice since each reload spawns a new sandbox) does not throw.
    Object.defineProperty(_globalThis, name, {
        configurable: true,
        get() {
            return getter ? getter() : basicTool.getGlobal(name);
        },
    });
}
