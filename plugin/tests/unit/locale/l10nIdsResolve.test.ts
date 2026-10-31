/**
 * Every l10n id the code asks for has to exist at runtime.
 *
 * Not a cosmetic rule: an id the locale bundle cannot resolve breaks Zotero's
 * right-click menu outright. The plugin's own shutdown path already carries a
 * comment saying so — removing the FTL link on disable was needed to stop
 * exactly that.
 *
 * The rename from Beaver to AlphainZ moved the ids in the source and left them
 * in the FTL. The result: a context menu that opened once, showed one
 * unlabelled row and an empty submenu, and then would not open again at all
 * until the plugin was disabled.
 *
 * The subtle part, and the reason a naive check would have passed: the build
 * rewrites the keys. `zotero-plugin-scaffold` prefixes every FTL message with
 * the addon ref unless it already starts with it —
 *
 *     needsPrefix(name) { return !!this.prefix && !name.startsWith(this.prefix); }
 *
 * — so the source key `beaver-context-menu-submenu` shipped as
 * `alphainz-beaver-context-menu-submenu`, while the code asked for
 * `alphainz-context-menu-submenu`. Comparing source keys to code ids directly
 * would have called that a match. This models the build rule instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = join(__dirname, '../../..');
const LOCALE_DIR = join(ROOT, 'addon/locale/en-US');
const PREFIX = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).config.addonRef;

/** The build's own rule, copied deliberately rather than approximated. */
function runtimeKey(sourceKey: string): string {
    return sourceKey.startsWith(PREFIX) ? sourceKey : `${PREFIX}-${sourceKey}`;
}

function runtimeKeys(): Set<string> {
    const keys = new Set<string>();
    for (const file of readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.ftl'))) {
        for (const line of readFileSync(join(LOCALE_DIR, file), 'utf8').split('\n')) {
            const match = /^([A-Za-z][\w-]*)\s*=/.exec(line);
            if (match) keys.add(runtimeKey(match[1]));
        }
    }
    return keys;
}

/** Every `l10nID: '...'` the shipped source hands to Zotero's MenuManager. */
function requestedIds(): Array<{ id: string; where: string }> {
    const out: Array<{ id: string; where: string }> = [];
    const grep = execSync(
        `grep -rnoE "l10nID: '[^']+'" src react || true`,
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    for (const line of grep.split('\n')) {
        if (!line.trim()) continue;
        const [file, lineNo, ...rest] = line.split(':');
        const match = /'([^']+)'/.exec(rest.join(':'));
        if (match) out.push({ id: match[1], where: `${file}:${lineNo}` });
    }
    return out;
}

describe('localization ids', () => {
    it('models the build rule the way the build does', () => {
        expect(runtimeKey('item-pane-status')).toBe('alphainz-item-pane-status');
        expect(runtimeKey('alphainz-context-menu-submenu')).toBe('alphainz-context-menu-submenu');
        // The bug, stated as a fact: a stale key does not collide with the id
        // the code asks for, it ships under a third name nobody looks up.
        expect(runtimeKey('beaver-context-menu-submenu'))
            .toBe('alphainz-beaver-context-menu-submenu');
    });

    it('finds the ids the source asks for', () => {
        // A guard on the guard: if the scan silently matched nothing, the check
        // below would pass while checking nothing at all.
        expect(requestedIds().length).toBeGreaterThan(0);
    });

    it('has every one of them defined', () => {
        const defined = runtimeKeys();
        const missing = requestedIds().filter(({ id }) => !defined.has(id));
        expect(
            missing.map((m) => `${m.id}  (${m.where})`),
            "asked for in the source but not shipped by addon/locale/en-US/*.ftl — "
            + "an unresolvable menu label breaks Zotero's right-click menu",
        ).toEqual([]);
    });

    it('carries no leftover beaver-prefixed keys', () => {
        // Harmless in isolation, but this is what a half-finished rename leaves
        // behind, and the pair that mattered was missed exactly this way.
        const stale = readdirSync(LOCALE_DIR)
            .filter((f) => f.endsWith('.ftl'))
            .flatMap((f) => readFileSync(join(LOCALE_DIR, f), 'utf8').split('\n'))
            .map((line) => /^([A-Za-z][\w-]*)\s*=/.exec(line)?.[1])
            .filter((k): k is string => !!k && k.startsWith('beaver-'));
        expect(stale).toEqual([]);
    });
});
