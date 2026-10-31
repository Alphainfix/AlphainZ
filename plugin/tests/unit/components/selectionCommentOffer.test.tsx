// @vitest-environment jsdom
/**
 * The card that offers to write a highlight-chat answer into the highlight.
 *
 * Two things are worth pinning down: the user can read the exact text before
 * approving it, and approving twice does not append it twice. The second needs
 * a real click, so this file runs against a DOM.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SelectionCommentOfferContent from '../../../react/components/ui/popup/SelectionCommentOfferContent';

type Props = React.ComponentProps<typeof SelectionCommentOfferContent>;

const BASE: Props = {
    highlightText: 'the R* level is set mostly by the nutrient supply',
    pageLabel: '3',
    preview: '— AlphainZ\nQ: what sets R*?\nA: the supply.',
    onSave: () => true,
    onDismiss: () => {},
};

const markup = (props: Partial<Props> = {}) =>
    renderToStaticMarkup(React.createElement(SelectionCommentOfferContent, { ...BASE, ...props }));

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Mount into a real DOM and hand back the button matching `label`. */
function mount(props: Partial<Props>): { button: (label: string) => HTMLButtonElement } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
        root.render(React.createElement(SelectionCommentOfferContent, { ...BASE, ...props }));
    });
    return {
        button: (label: string) => {
            const match = [...host.querySelectorAll('button')].find(
                (b) => b.textContent?.trim() === label,
            );
            if (!match) throw new Error(`no button labelled ${label}`);
            return match as HTMLButtonElement;
        },
    };
}

describe('SelectionCommentOfferContent', () => {
    it('shows the text that will be written, verbatim', () => {
        // Approving a write you cannot see is the failure this replaces.
        const html = markup();
        expect(html).toContain('Q: what sets R*?');
        expect(html).toContain('A: the supply.');
    });

    it('names the highlight and its page', () => {
        const html = markup();
        expect(html).toContain('the R* level is set mostly by the nutrient supply');
        expect(html).toContain('Page 3');
    });

    it('omits the page when the highlight has no label', () => {
        expect(markup({ pageLabel: null })).not.toContain('Page');
    });

    it('offers decline and approve, in that order and weighting', () => {
        // Same grammar as the agent's own approval cards: outline declines,
        // solid applies.
        const html = markup();
        expect(html.indexOf('Not now')).toBeLessThan(html.indexOf('Save'));
        expect(html).toContain('variant-outline');
        expect(html).toContain('variant-solid');
    });

    it('takes the highlight colour it is given', () => {
        expect(markup({ color: '#e56eee' })).toContain('#e56eee');
    });

    it('writes once even if approve is clicked twice', () => {
        // The comment is appended to, so a second write duplicates the exchange.
        let release: (saved: boolean) => void = () => {};
        const onSave = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));

        const { button } = mount({ onSave });
        // Held by reference: once the write starts the button relabels itself,
        // and looking it up again by label would find nothing and pass for the
        // wrong reason.
        const save = button('Save');
        act(() => { save.click(); });
        act(() => { save.click(); });

        expect(onSave).toHaveBeenCalledTimes(1);
        release(true);
    });

    it('does not offer to decline while the write is in flight', () => {
        let release: (saved: boolean) => void = () => {};
        const onSave = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
        const onDismiss = vi.fn();

        const { button } = mount({ onSave, onDismiss });
        act(() => { button('Save').click(); });
        act(() => { button('Not now').click(); });

        expect(onDismiss).not.toHaveBeenCalled();
        release(true);
    });

    it('declines without writing', () => {
        const onSave = vi.fn(() => true);
        const onDismiss = vi.fn();
        const { button } = mount({ onSave, onDismiss });
        act(() => { button('Not now').click(); });
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });
});
