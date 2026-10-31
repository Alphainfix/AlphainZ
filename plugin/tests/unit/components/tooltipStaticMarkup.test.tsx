/**
 * A tooltip adds none of its text to server-rendered markup.
 *
 * The hidden copies a tooltip ties to its control exist only in a live DOM,
 * once there is a control to tie them to. Rendered to a string, as markdown
 * is when an answer is saved into a note, a Tooltip is its anchor alone: no
 * hidden span whose text a note editor could keep.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { CancelIcon } from '@beaver/agent-ui/icons';

describe('a tooltip rendered to a string', () => {
    it('leaves no copy of its text over a button', () => {
        const html = renderToStaticMarkup(
            React.createElement(Tooltip, { content: 'Reject', secondaryContent: '⌘R' } as any,
                React.createElement(IconButton, { icon: CancelIcon, onClick: () => {} })),
        );
        expect(html).toContain('<button');
        expect(html).not.toContain('Reject');
        expect(html).not.toContain('⌘R');
    });

    it('leaves no copy of its text over plain text', () => {
        const html = renderToStaticMarkup(
            React.createElement(Tooltip, { content: 'Honeybee odometry, page 4' } as any,
                React.createElement('span', null, '(Smith 2020)')),
        );
        expect(html).toContain('(Smith 2020)');
        expect(html).not.toContain('Honeybee odometry');
    });
});
