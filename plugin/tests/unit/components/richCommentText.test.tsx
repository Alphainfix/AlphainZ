/**
 * The offer card shows the comment the way Zotero will show it.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RichCommentText } from '../../../react/components/ui/popup/RichCommentText';

const html = (text: string) => renderToStaticMarkup(<RichCommentText text={text} />);

describe('RichCommentText', () => {
    it('renders the four tags Zotero renders', () => {
        expect(html('T<sub>2</sub><sup>*</sup> and <b>bold</b> <i>it</i>')).toBe(
            'T<sub>2</sub><sup>*</sup> and <b>bold</b> <i>it</i>',
        );
    });

    it('nests a different tag inside another, as an exponent with a subscript does', () => {
        expect(html('e<sup>-t/T<sub>2</sub></sup>')).toBe('e<sup>-t/T<sub>2</sub></sup>');
    });

    it('leaves an unclosed tag and stray angle brackets as text, like Zotero', () => {
        expect(html('a <sub>b and x<y')).toBe('a &lt;sub&gt;b and x&lt;y');
    });

    it('renders plain text unchanged', () => {
        expect(html('— AlphainZ\nQ: why?\nA: because.')).toBe('— AlphainZ\nQ: why?\nA: because.');
    });
});
