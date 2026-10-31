// @vitest-environment jsdom
/**
 * The textarea composer engine: same contract as the Lexical editor, native
 * caret. These tests pin the imperative handle's math (slash insertion,
 * trailing-query removal, pill presence) and the Enter/IME rules — the parts
 * where a rewrite could silently diverge from what the menus and the send
 * path expect.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    TextareaComposer,
    fitPlaceholderFontSize,
    pillsPresentInText,
} from '@beaver/agent-ui/composer/TextareaComposer';
import type { LexicalEditorInputHandle } from '@beaver/agent-ui/composer/LexicalEditorInput';
import type { SlashCommandDescriptor } from '@beaver/agent-ui/composer/slashCommands';

const pill = (name: string, actionId = `act-${name}`): SlashCommandDescriptor => ({
    commandName: name,
    actionId,
});

describe('TextareaComposer', () => {
    let host: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    let handle: React.RefObject<LexicalEditorInputHandle | null>;
    let latest: { value: string };
    let submitted: number;

    const mount = (initial = '') => {
        latest = { value: initial };
        submitted = 0;
        const Harness: React.FC = () => {
            const [value, setValue] = React.useState(initial);
            latest.value = value;
            return React.createElement(TextareaComposer, {
                ref: handle as React.Ref<LexicalEditorInputHandle>,
                value,
                onChange: (text: string) => { latest.value = text; setValue(text); },
                onSubmit: () => { submitted += 1; },
                placeholder: 'Ask…',
            });
        };
        act(() => root.render(React.createElement(Harness)));
    };

    const textarea = () => host.querySelector('textarea') as HTMLTextAreaElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        handle = React.createRef();
        vi.clearAllMocks();
    });

    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('renders the value in a real textarea', () => {
        mount('hello');
        expect(textarea().value).toBe('hello');
    });

    it('shows the placeholder as a one-line overlay while empty, and drops it once there is text', () => {
        mount('');
        const overlay = () => host.querySelector('.alphainz-composer-placeholder');
        expect(overlay()?.textContent).toBe('Ask…');
        // Not the native placeholder: that one wraps onto the toolbar in a
        // narrow pane. Assistive tech still hears it.
        expect(textarea().getAttribute('placeholder')).toBeNull();
        expect(textarea().getAttribute('aria-placeholder')).toBe('Ask…');
        act(() => handle.current!.setText('hi'));
        expect(overlay()).toBeNull();
    });

    it('insertSlashCommand appends the token, replaces a typed query, and reports the pill', () => {
        mount('please /sum');
        act(() => handle.current!.insertSlashCommand(pill('summarize'), 3));
        expect(latest.value).toBe('please /summarize ');
        expect(handle.current!.getSlashCommands()).toEqual([pill('summarize')]);
        // Caret parked after the trailing space.
        expect(textarea().selectionStart).toBe(latest.value.length);
    });

    it('adds a separating space for a programmatic insert after text', () => {
        mount('color the paper');
        act(() => handle.current!.insertSlashCommand(pill('annotate'), null));
        expect(latest.value).toBe('color the paper /annotate ');
    });

    it('renames a colliding command the way the Lexical engine did', () => {
        mount('');
        act(() => handle.current!.insertSlashCommand(pill('explain', 'a1'), null));
        act(() => handle.current!.insertSlashCommand(pill('explain', 'a2'), null));
        expect(latest.value).toBe('/explain /explain-2 ');
        expect(handle.current!.getSlashCommands().map((p) => p.commandName))
            .toEqual(['explain', 'explain-2']);
    });

    it('a pill whose token was edited away stops being reported', () => {
        mount('');
        act(() => handle.current!.insertSlashCommand(pill('explain'), null));
        act(() => handle.current!.setText('explain this instead'));
        expect(handle.current!.getSlashCommands()).toEqual([]);
    });

    it('deleteTrailingQuery trims exactly the typed trigger text', () => {
        mount('find @vort');
        act(() => handle.current!.deleteTrailingQuery(5));
        expect(latest.value).toBe('find ');
    });

    it('selectRange clamps and honours skipFocus', () => {
        mount('abcdef');
        act(() => handle.current!.selectRange(2, 4, { skipFocus: true }));
        expect(textarea().selectionStart).toBe(2);
        expect(textarea().selectionEnd).toBe(4);
        expect(document.activeElement).not.toBe(textarea());
        act(() => handle.current!.selectRange(99, 99));
        expect(textarea().selectionStart).toBe(6);
        expect(document.activeElement).toBe(textarea());
    });

    it('flushPendingText returns the live value; discard drops nothing', () => {
        mount('draft');
        expect(handle.current!.flushPendingText()).toBe('draft');
        act(() => handle.current!.discardPendingText());
        expect(latest.value).toBe('draft');
    });

    it('Enter submits; Shift+Enter and a composing Enter do not', () => {
        mount('ready');
        const el = textarea();
        const press = (init: KeyboardEventInit) =>
            act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })); });
        press({});
        expect(submitted).toBe(1);
        press({ shiftKey: true });
        expect(submitted).toBe(1);
        press({ keyCode: 229 } as KeyboardEventInit);
        expect(submitted).toBe(1);
    });
});

describe('fitPlaceholderFontSize', () => {
    it('keeps the base size when the text already fits', () => {
        expect(fitPlaceholderFontSize(12, 300, 250)).toBe(12);
        expect(fitPlaceholderFontSize(12, 300, 300)).toBe(12);
    });

    it('shrinks proportionally when it does not', () => {
        // 300 wide for 360 of text: 12 * (300/360) = 10.0
        expect(fitPlaceholderFontSize(12, 300, 360)).toBe(10);
        expect(fitPlaceholderFontSize(13, 330, 360)).toBe(11.9);
    });

    it('never goes below the floor — the ellipsis takes over there', () => {
        expect(fitPlaceholderFontSize(12, 100, 400)).toBe(10);
        expect(fitPlaceholderFontSize(12, 100, 400, 8)).toBe(8);
    });

    it('leaves the size alone when nothing is measurable yet', () => {
        expect(fitPlaceholderFontSize(12, 0, 0)).toBe(12);
        expect(fitPlaceholderFontSize(12, 0, 300)).toBe(12);
    });
});

describe('pillsPresentInText', () => {
    it('keeps only tokens present, in first-occurrence order', () => {
        const known = [pill('b'), pill('a')];
        expect(pillsPresentInText('/a then /b', known).map((p) => p.commandName)).toEqual(['a', 'b']);
        expect(pillsPresentInText('nothing here', known)).toEqual([]);
    });

    it('does not match a token inside a word', () => {
        expect(pillsPresentInText('path/a', [pill('a')])).toEqual([]);
    });
});
