/**
 * No preference path may be spelled out in the source.
 *
 * Same failure as the l10n ids, one layer down. A pref read through `getPref`
 * is built from the plugin's own prefix, so a rename carries it; a pref path
 * typed as a literal does not, and nothing complains — the read just returns
 * undefined forever.
 *
 * Two of these survived the rename to AlphainZ:
 *
 *   - `extensions.zotero.beaver.actions`, watched by the context-menu
 *     observer, so editing a custom action never rebuilt the menu;
 *   - `extensions.zotero.beaver.backgroundExtractorEnabled`, watched by the
 *     background extractor, so turning it back on never woke the loop.
 *
 * Both were silent. Neither had a test. This is that test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = join(__dirname, '../../..');
const PREFIX = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).config.prefsPrefix;

/**
 * The one legitimate use: the migration list that carries settings across a
 * rename has to name the prefixes this plugin used to have.
 */
const ALLOWED = [/hooks\.ts:\d+:.*LEGACY_PREF_PREFIXES/, /LEGACY_PREF_PREFIXES/];

function literalPrefPaths(): string[] {
    const grep = execSync(
        `grep -rnE "['\\"\\\`]extensions\\.zotero\\.[a-zA-Z]" src react || true`,
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    return grep
        .split('\n')
        .filter((line) => line.trim())
        // Comments explaining a past bug are allowed to quote the old name.
        .filter((line) => !/^\s*\S+:\d+:\s*(\/\/|\*|\/\*)/.test(line))
        .filter((line) => !ALLOWED.some((re) => re.test(line)));
}

describe('preference paths in the source', () => {
    it('are never spelled out — they come from the plugin config', () => {
        const offenders = literalPrefPaths().filter(
            // Another plugin's or Zotero's own pref is not ours to build.
            (line) => line.includes(`extensions.zotero.beaver`)
                || line.includes(`extensions.zotero.alphainreader`)
                || line.includes(PREFIX),
        );
        expect(
            offenders,
            'a literal pref path does not survive a rename and fails silently; '
            + 'build it from config.config.prefsPrefix instead',
        ).toEqual([]);
    });

    it('knows what the prefix actually is', () => {
        expect(PREFIX).toBe('extensions.zotero.alphainz');
    });
});

/**
 * The MCP endpoint and the config the preferences pane hands out must agree.
 *
 * They did not. The server registered `/alphainz/mcp`; the "copy config"
 * button produced `http://localhost:PORT/beaver/mcp`. Pasting it gave a client
 * pointed at a path nothing serves — the same rename failure as the menu
 * labels, except it crossed a clipboard, so nothing in the plugin could ever
 * have noticed.
 */
describe('the MCP config the preferences pane hands out', () => {
    it('uses the path the server actually registers', () => {
        const advanced = readFileSync(
            join(ROOT, 'react/components/preferences/AdvancedSection.tsx'), 'utf8',
        );
        const service = readFileSync(join(ROOT, 'src/services/mcpService.ts'), 'utf8');

        // Both sides read one exported constant rather than spelling a path.
        expect(service).toMatch(/export const MCP_ENDPOINT_PATH = '\/alphainz\/mcp'/);
        expect(advanced).toContain('MCP_ENDPOINT_PATH');
        expect(advanced).toContain('MCP_SERVER_NAME');

        // And neither spells the old one anywhere but in a comment.
        for (const [name, source] of [['AdvancedSection', advanced], ['mcpService', service]] as const) {
            const offending = source.split('\n')
                .filter((line) => line.includes('/beaver/mcp'))
                .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
            expect(offending, `${name} still spells the old MCP path outside a comment`).toEqual([]);
        }
    });
});
