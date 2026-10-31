/**
 * No source file may name the old chrome package.
 *
 * `chrome://beaver/` resolved to nothing once the plugin was renamed, and the
 * failure mode is a broken image or a stylesheet that silently does not load —
 * no error anywhere. Fifty of these were fixed in the rename; one survived in
 * the first-run header until it was looked for deliberately.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../..');

function grep(pattern: string, dirs: string[]): string[] {
    try {
        const out = execFileSync(
            'grep',
            ['-rn', '--include=*.ts', '--include=*.tsx', '--include=*.css', '--include=*.xhtml',
             '--include=*.html', '--include=*.ftl',
             // Generated, gitignored, and rebuilt from the sources being
             // checked — a stale URL in here is the old build, not a defect.
             '--exclude=reactBundle.js', '--exclude=*.map',
             '-e', pattern, ...dirs],
            { cwd: root, encoding: 'utf8' },
        );
        return out.trim().split('\n').filter(Boolean);
    } catch (error: any) {
        // grep exits 1 with no matches, which is the passing case.
        if (error.status === 1) return [];
        throw error;
    }
}

describe('chrome URLs', () => {
    it('never names the old chrome package', () => {
        const hits = grep('chrome://beaver/', ['react', 'src', 'addon', 'packages']);
        expect(hits, `stale chrome URLs:\n${hits.join('\n')}`).toEqual([]);
    });

    it('has at least one URL built from the addon ref', () => {
        // Guards against the test above passing because every chrome URL was
        // deleted rather than corrected.
        expect(grep('chrome://\\${', ['react', 'src']).length).toBeGreaterThan(0);
    });
});

describe('icons', () => {
    it('never names the icons inherited from the fork', () => {
        // The artwork is the user's own now. A stale filename is not cosmetic:
        // the file is gone, so the reference resolves to a broken image with no
        // error anywhere — exactly how the first-run logo went unnoticed.
        const hits = grep('icons/beaver', ['react', 'src', 'addon']);
        expect(hits, `stale icon references:\n${hits.join('\n')}`).toEqual([]);
    });

    it('ships the icons the manifest and the toolbar ask for', () => {
        for (const name of ['alphain.png', 'alphain@0.5x.png']) {
            expect(
                existsSync(join(root, 'addon/content/icons', name)),
                `${name} is referenced but not shipped`,
            ).toBe(true);
        }
    });
});
