/**
 * The cited location, as the sources list states it.
 *
 * The rules matter more than they look: a location that is wrong sends the
 * reader to the wrong page, and a location invented for a document that has no
 * pages is worse than none at all.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { citationLocationDisplay } from '../../../packages/agent-ui/src/utils/citationLocation';
import { setHost } from '../../../packages/agent-ui/src/host';

const cite = (extra: Record<string, unknown> = {}) =>
    ({
        citation_id: 'c1',
        raw_tag: '<citation id="u-ABC" page="3"/>',
        resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ABC', library_ref: 'u' },
        citation_type: 'attachment',
        display_name: '已提交版本',
        ...extra,
    }) as any;

afterEach(() => setHost({}));

describe('citationLocationDisplay', () => {
    it('states a single page', () => {
        expect(citationLocationDisplay(cite({ pages: [3] }))).toBe('3');
    });

    it('collapses consecutive pages into a range', () => {
        expect(citationLocationDisplay(cite({ pages: [2, 3, 4] }))).toBe('2-4');
    });

    it('says nothing when the citation names no location', () => {
        // An empty string, not "p. undefined": the row omits the chip entirely.
        expect(citationLocationDisplay(cite({}))).toBe('');
        expect(citationLocationDisplay(cite({ pages: [] }))).toBe('');
    });

    it('says nothing for a snapshot', () => {
        // A web snapshot's page number is a logical coordinate in a continuous
        // scroll view; presenting it as a page would send the reader nowhere.
        expect(citationLocationDisplay(cite({ pages: [7], content_kind: 'snapshot' }))).toBe('');
    });

    it("prefers the labels a document prints on its own pages", () => {
        // A paper whose body starts at S3 should be cited as S3, not as 3.
        const display = citationLocationDisplay(
            cite({ pages: [3], page_labels: { 2: 'S3' } }),
        );
        expect(display).toBe('S3');
    });

    it('falls back to preloaded labels when the citation carries none', () => {
        setHost({
            itemData: {
                resolvePageLabels: () => ({ 2: 'iv' }),
            },
        } as any);
        expect(
            citationLocationDisplay(cite({ pages: [3] }), {
                pageLabelsByAttachmentId: { 'u-ABC': { 2: 'iv' } },
            }),
        ).toBe('iv');
    });

    it('uses raw numbers when labels are turned off', () => {
        expect(
            citationLocationDisplay(cite({ pages: [3], page_labels: { 2: 'S3' } }), {
                usePageLabels: false,
            }),
        ).toBe('3');
    });

    it('cites an EPUB only where a label exists', () => {
        // An EPUB has no pages of its own, so an unlabelled locator is not a
        // place the reader can be sent to.
        expect(citationLocationDisplay(cite({ pages: [3], content_kind: 'epub' }))).toBe('');
        expect(
            citationLocationDisplay(
                cite({ pages: [3], content_kind: 'epub', page_labels: { 2: 'Chapter 2' } }),
            ),
        ).toBe('Chapter 2');
    });

    it('works with no host installed', () => {
        // The render surface is meant to run without the Zotero host; a throw
        // here would take the whole answer down with it.
        setHost({});
        expect(citationLocationDisplay(cite({ pages: [5] }))).toBe('5');
    });
});
