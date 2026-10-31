/**
 * The composer's caret survives the window changing shape (`/alphainz/test/caret-probe`).
 *
 * In Zotero's chrome document a childList mutation anywhere collapses a
 * focused contenteditable's selection to offset 0. That is not theoretical:
 * with eight characters typed and the caret at the end, appending one empty
 * `<span>` to the header and removing it again put the caret in front of
 * everything already written, and the next keystroke landed there. It showed
 * up in normal use when the chips for a newly opened paper finished loading
 * while the user was already typing their question.
 *
 * `MutationCaretRepairPlugin` writes the model's selection back to the DOM
 * after any such mutation. These are the cases that matter:
 *   - a mutation inside the pane (the header, where tooltips mount)
 *   - a mutation on the document element (where popups mount, outside the pane)
 *   - a caret in the middle of the text, which must come back to where it was
 *     rather than to the end
 *
 * The repair runs in the MutationObserver's microtask, so the probe reports
 * both the synchronous reading (still collapsed) and the settled one.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build loaded in a running Zotero (NODE_ENV=development).
 *   - The sidebar open; the probe opens nothing itself.
 *
 * Run with: `npm run test:live -- composerCaret`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

const SEED = '这是一句用来测试的中文';

async function probe(body: Record<string, unknown>) {
    return post('/alphainz/test/caret-probe', body) as Promise<{
        ok: boolean;
        textLength: number;
        caret: { before: number; afterAdd: number; afterRemove: number; afterSettle: number };
        moved: boolean;
        repaired: boolean;
    }>;
}

describe('composer caret survives DOM mutations', () => {
    let available = false;

    beforeAll(async () => {
        available = await isZoteroAvailable();
        if (!available) return;
        await post('/alphainz/test/alphainz-sidebar', { open: true });
    });

    beforeEach((ctx) => { skipIfNoZotero(ctx, available); });

    it('comes back after a mutation inside the pane', async () => {
        const r = await probe({ where: 'header', seed: SEED });
        expect(r.ok).toBe(true);
        expect(r.textLength).toBe(SEED.length);
        // The collapse still happens — the repair is what undoes it.
        expect(r.caret.before).toBe(SEED.length);
        expect(r.caret.afterSettle).toBe(SEED.length);
        expect(r.moved).toBe(false);
    });

    it('comes back after a mutation on the document element', async () => {
        // Popups and tooltips mount here, outside the pane entirely, which is
        // why the observer watches the document rather than the pane.
        const r = await probe({ where: 'document', seed: SEED });
        expect(r.caret.afterSettle).toBe(SEED.length);
        expect(r.moved).toBe(false);
    });

    it('restores where the caret was, not the end of the text', async () => {
        const r = await probe({ where: 'header', seed: SEED, caretAt: 4 });
        expect(r.caret.before).toBe(4);
        expect(r.caret.afterSettle).toBe(4);
        expect(r.moved).toBe(false);
    });
});
