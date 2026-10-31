/**
 * The sources list names where a claim came from, not just what it came from.
 *
 * With the default numeric citation format the inline marker is a bare `[1]`,
 * so this list is the only place on screen the cited page can appear. It did
 * not appear anywhere.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import CitedSourcesList from '../../../packages/agent-ui/src/chat/CitedSourcesList';
import { setHost } from '../../../packages/agent-ui/src/host';

const source = (extra: Record<string, unknown> = {}) =>
    ({
        citation_id: 'c1',
        raw_tag: '<citation id="u-ABC" page="3"/>',
        resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ABC', library_ref: 'u' },
        citation_type: 'attachment',
        display_name: '已提交版本',
        formatted_citation: '"已提交版本"',
        numericCitation: 1,
        ...extra,
    }) as any;

const render = (citations: any[]) =>
    renderToStaticMarkup(React.createElement(CitedSourcesList, { citations }));

afterEach(() => setHost({}));

describe('CitedSourcesList', () => {
    it('states the cited page beside the source', async () => {
        const html = render([source({ pages: [3] })]);
        expect(html).toContain('已提交版本');
        expect(html).toContain('p. 3');
    });

    it('states a page range', async () => {
        expect(render([source({ pages: [2, 3, 4] })])).toContain('p. 2-4');
    });

    it('omits the page when the citation names none', async () => {
        // No "p. undefined", and no empty chip taking up the row.
        const html = render([source({})]);
        expect(html).toContain('已提交版本');
        expect(html).not.toContain('p. ');
    });

    it('omits the page for a snapshot', async () => {
        // Its page number is a logical coordinate, not somewhere to turn to.
        expect(render([source({ pages: [7], content_kind: 'snapshot' })])).not.toContain('p. ');
    });

    it('drops invalid citations from the list', async () => {
        const html = render([source({ pages: [3], invalid: true, invalid_reason: 'not_found' })]);
        expect(html).not.toContain('已提交版本');
    });

    it('renders each cited page when one source is cited twice', async () => {
        // Two claims from two places in one paper are two rows, because the
        // page is the part that distinguishes them.
        const html = render([
            source({ citation_id: 'c1', pages: [2] }),
            source({ citation_id: 'c2', raw_tag: '<citation id="u-ABC" page="6"/>', pages: [6] }),
        ]);
        expect(html).toContain('p. 2');
        expect(html).toContain('p. 6');
    });
});
