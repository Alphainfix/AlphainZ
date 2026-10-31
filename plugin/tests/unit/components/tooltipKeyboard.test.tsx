// @vitest-environment jsdom
/**
 * A tooltip is reachable from the keyboard and tied to its control.
 *
 * Many icon-only buttons (Reject, Apply, Undo, the archive chip) have no label
 * but their tooltip, and the tooltip opened on mouse hover only: a keyboard
 * user never saw it and a screen reader announced "button". Now keyboard focus
 * opens it, Escape closes it, and its text names a control that has no name of
 * its own or describes one that has.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { CancelIcon } from '@beaver/agent-ui/icons';

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function render(element: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(element); });
    return { host, root };
}

const tooltip = () => document.querySelector('[role="tooltip"]');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pointer entering `element` from outside the page. */
const pointerOver = (element: Element) =>
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
/** The pointer leaving `element` for `to`, or for somewhere outside the chat. */
const pointerOut = (element: Element, to: Element = document.body) =>
    element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));

/**
 * Focus as the Tab key gives it. The DOM decides :focus-visible from the last
 * input it saw, and a test before this one may have left that a mouse event.
 */
function focusByKeyboard(element: HTMLElement) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    element.focus();
}

/** Focus as a mouse click gives it: the browser does not match :focus-visible. */
function focusByClick(element: HTMLElement) {
    const matches = Element.prototype.matches;
    const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        return selector === ':focus-visible' ? false : matches.call(this, selector);
    });
    try {
        element.focus();
    } finally {
        spy.mockRestore();
    }
}

/** A citation-like card: plain text as the anchor, a link inside the card. */
function cardOver(anchor: React.ReactElement) {
    return React.createElement(
        'div',
        null,
        React.createElement(
            Tooltip,
            {
                content: 'Honeybee odometry',
                customContent: React.createElement('a', { href: '#paper', id: 'card-link' }, 'doi.org/10.1000/bees'),
            } as any,
            anchor,
        ),
        React.createElement('button', { id: 'elsewhere' }, 'Elsewhere'),
    );
}

const refText = (element: Element, attribute: string) =>
    (element.getAttribute(attribute) ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');

function rejectButton(props: Partial<React.ComponentProps<typeof IconButton>> = {}) {
    return React.createElement(
        'div',
        null,
        React.createElement(
            Tooltip,
            { content: 'Reject', showArrow: true, singleLine: true } as any,
            React.createElement(IconButton, { icon: CancelIcon, onClick: () => {}, ...props }),
        ),
        React.createElement('button', { id: 'elsewhere' }, 'Elsewhere'),
    );
}

describe('opening from the keyboard', () => {
    it('opens when its button receives keyboard focus and closes when focus moves on', async () => {
        const { host } = await render(rejectButton());
        const button = host.querySelector('button')!;
        await act(async () => { focusByKeyboard(button); });
        expect(tooltip()?.textContent).toContain('Reject');

        await act(async () => { focusByKeyboard(document.getElementById('elsewhere') as HTMLElement); });
        expect(tooltip()).toBeNull();
    });

    it('closes on Escape and leaves focus on the button', async () => {
        const { host } = await render(rejectButton());
        const button = host.querySelector('button')!;
        await act(async () => { focusByKeyboard(button); });
        expect(tooltip()).toBeTruthy();

        await act(async () => {
            button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(tooltip()).toBeNull();
        expect(document.activeElement).toBe(button);
    });

    it('stays closed when a click is what focused the button', async () => {
        const { host } = await render(rejectButton());
        await act(async () => { focusByClick(host.querySelector('button')!); });
        expect(tooltip()).toBeNull();
    });

    it('stays closed while disabled', async () => {
        const { host } = await render(
            React.createElement(
                Tooltip,
                { content: 'Reject', disabled: true } as any,
                React.createElement(IconButton, { icon: CancelIcon, onClick: () => {} }),
            ),
        );
        await act(async () => { focusByKeyboard(host.querySelector('button')!); });
        expect(tooltip()).toBeNull();
    });
});

describe('a link inside the tooltip', () => {
    it('still lets the card close when the pointer leaves after the link was clicked', async () => {
        const { host } = await render(cardOver(React.createElement('span', { id: 'citation' }, '(Smith 2020)')));
        await act(async () => { pointerOver(host.querySelector('#citation')!); });
        expect(tooltip()).toBeTruthy();

        const link = document.getElementById('card-link') as HTMLAnchorElement;
        await act(async () => { pointerOut(host.querySelector('#citation')!, link); });
        await act(async () => { focusByClick(link); });
        expect(document.activeElement).toBe(link);

        await act(async () => { pointerOut(link); });
        await act(async () => { await wait(250); });
        expect(tooltip()).toBeNull();
    });

    it('stays open while the keyboard is on the link, wherever the pointer goes', async () => {
        const { host } = await render(cardOver(
            React.createElement(IconButton, { icon: CancelIcon, onClick: () => {}, ariaLabel: 'Open paper' }),
        ));
        const button = host.querySelector('button')!;
        await act(async () => { focusByKeyboard(button); });
        const link = document.getElementById('card-link') as HTMLAnchorElement;
        await act(async () => { focusByKeyboard(link); });
        expect(tooltip()).toBeTruthy();

        await act(async () => { pointerOver(link); });
        await act(async () => { pointerOut(link); });
        await act(async () => { await wait(250); });
        expect(tooltip()).toBeTruthy();
        expect(document.activeElement).toBe(link);
    });
});

describe('the text around a tooltip', () => {
    it('gains nothing from a tooltip over plain text, such as a citation', async () => {
        const { host } = await render(
            React.createElement(
                'p',
                null,
                'As shown in ',
                React.createElement(Tooltip, { content: 'Honeybee odometry, page 4', secondaryContent: 'Opens PDF' } as any,
                    React.createElement('span', null, '(Smith 2020)')),
                '.',
            ),
        );
        expect(host.textContent).toBe('As shown in (Smith 2020).');
    });
});

describe('what a screen reader hears', () => {
    it('names an icon-only button that has no label of its own', async () => {
        const { host } = await render(rejectButton());
        const button = host.querySelector('button')!;
        expect(refText(button, 'aria-labelledby')).toBe('Reject');
        expect(button.getAttribute('aria-describedby')).toBeNull();
    });

    it('describes a labelled button with the tooltip', async () => {
        const { host } = await render(
            React.createElement(
                Tooltip,
                { content: 'Remove this paper from the proposal' } as any,
                React.createElement(IconButton, { icon: CancelIcon, onClick: () => {}, ariaLabel: 'Reject' }),
            ),
        );
        const button = host.querySelector('button')!;
        expect(button.getAttribute('aria-label')).toBe('Reject');
        expect(button.getAttribute('aria-labelledby')).toBeNull();
        expect(refText(button, 'aria-describedby')).toBe('Remove this paper from the proposal');
    });

    it('does not repeat a label the button already has, but adds the shortcut', async () => {
        const { host } = await render(
            React.createElement(
                Tooltip,
                { content: 'New chat', secondaryContent: '⌘N' } as any,
                React.createElement(IconButton, { icon: CancelIcon, onClick: () => {}, ariaLabel: 'New chat' }),
            ),
        );
        const button = host.querySelector('button')!;
        expect(refText(button, 'aria-describedby')).toBe('⌘N');
    });

    it('adds nothing when the label already says what the tooltip says', async () => {
        const { host } = await render(
            React.createElement(
                Tooltip,
                { content: 'Chat history' } as any,
                React.createElement(IconButton, { icon: CancelIcon, onClick: () => {}, ariaLabel: 'Show chat history' }),
            ),
        );
        const button = host.querySelector('button')!;
        expect(button.getAttribute('aria-describedby')).toBeNull();
        expect(button.getAttribute('aria-labelledby')).toBeNull();
    });

    it('keeps the button\'s own references and takes back only its own', async () => {
        const describedElsewhere = document.createElement('span');
        describedElsewhere.id = 'own-description';
        describedElsewhere.textContent = 'Deletes the note';
        document.body.appendChild(describedElsewhere);

        const deleteButton = (disabled: boolean) => React.createElement(
            Tooltip,
            { content: 'Delete this note', disabled } as any,
            React.createElement(IconButton, {
                icon: CancelIcon,
                onClick: () => {},
                ariaLabel: 'Delete',
                ariaDescribedBy: 'own-description',
            }),
        );
        const { host, root } = await render(deleteButton(false));
        const button = host.querySelector('button')!;
        expect(refText(button, 'aria-describedby')).toBe('Deletes the note Delete this note');

        await act(async () => { root.render(deleteButton(true)); });
        expect(host.querySelector('button')).toBe(button);
        expect(button.getAttribute('aria-describedby')).toBe('own-description');

        await act(async () => { root.unmount(); });
        expect(button.getAttribute('aria-describedby')).toBe('own-description');
    });
});
