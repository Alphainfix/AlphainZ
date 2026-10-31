import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
} from 'react';

import { isImeKeyEvent } from '../primitives/ime';
import {
    splitContentByCommandTokens,
    type SlashCommandDescriptor,
} from './slashCommands';
import type {
    ComposerPasteHandlers,
    LexicalEditorInputHandle,
} from './LexicalEditorInput';

/**
 * The composer on a native <textarea>.
 *
 * The Lexical composer lives as a contenteditable in Zotero's chrome document,
 * where the caret belongs to the DOCUMENT selection — and the chrome document
 * resets that selection on DOM mutations, window deactivation, and assorted
 * IME timings. Seventeen repair mechanisms grew around that fact and the bugs
 * kept coming. A textarea's selection is the control's own internal state:
 * none of those events can touch it, and the IME talks to the OS-native
 * widget directly. This engine exists so the caret CANNOT be stolen, not so
 * it can be stolen and repaired.
 *
 * Contract-compatible with LexicalEditorInput: same props, same imperative
 * handle, so the two engines swap behind one preference. `value` was always
 * the full send-ready text (slash pills contribute their literal "/command"
 * token), which is exactly what a textarea holds — the pill descriptors ride
 * in React state and are re-derived against the text on read.
 *
 * Pills keep their chip look through a backdrop: a mirror element behind the
 * textarea paints a rounded background under each command token. All glyphs in
 * the mirror are transparent — the REAL text (and the IME's composition
 * underline) is always drawn by the textarea itself.
 */

export interface TextareaComposerProps {
    value: string;
    onChange: (text: string) => void;
    pills?: SlashCommandDescriptor[];
    onPillsChange?: (pills: SlashCommandDescriptor[]) => void;
    onSubmit: () => void;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
    /** Accepted for contract parity; native navigation needs no suspension. */
    suspendKeyboardNavigation?: boolean;
    onContentEditableRef?: (el: HTMLElement | null) => void;
    pasteHandlers?: ComposerPasteHandlers;
    inlineHint?: string | null;
    /** Accepted for contract parity; the textarea engine has no hover cards. */
    resolveAction?: (actionId: string) => unknown;
}

/** The scroll host caps at the same 12.5em the Lexical composer used. */
const MAX_HEIGHT_EM = 12.5;

/** `/name` collision handling, same rule the Lexical engine applied. */
function resolveCommandCollision(
    descriptor: SlashCommandDescriptor,
    existing: SlashCommandDescriptor[],
): SlashCommandDescriptor {
    const clashing = existing.some(
        (pill) => pill.commandName === descriptor.commandName && pill.actionId !== descriptor.actionId,
    );
    if (!clashing) return descriptor;
    for (let n = 2; n < 100; n += 1) {
        const candidate = `${descriptor.commandName}-${n}`;
        if (!existing.some((pill) => pill.commandName === candidate)) {
            return { ...descriptor, commandName: candidate };
        }
    }
    return descriptor;
}

/** Pills whose token still appears in the text, in first-occurrence order. */
export function pillsPresentInText(
    text: string,
    known: SlashCommandDescriptor[],
): SlashCommandDescriptor[] {
    if (known.length === 0) return [];
    const segments = splitContentByCommandTokens(text, known, (pill) => pill.commandName);
    const present: SlashCommandDescriptor[] = [];
    for (const segment of segments) {
        if (segment.match && !present.some((p) => p.commandName === segment.match!.commandName)) {
            present.push(segment.match);
        }
    }
    return present;
}

/** Smallest the placeholder may shrink to before it truncates instead. */
export const PLACEHOLDER_MIN_PX = 10;

/**
 * The font size at which `neededWidth` of placeholder text fits `availableWidth`.
 *
 * Returns the base size when it already fits (or nothing is measurable), scales
 * down proportionally otherwise, and never goes below the floor — past that,
 * the ellipsis takes over. Pure, so the fit can be pinned without layout.
 */
export function fitPlaceholderFontSize(
    basePx: number,
    availableWidth: number,
    neededWidth: number,
    minPx = PLACEHOLDER_MIN_PX,
): number {
    if (!(basePx > 0) || !(availableWidth > 0) || !(neededWidth > 0)) return basePx;
    if (neededWidth <= availableWidth) return basePx;
    const scaled = Math.floor(basePx * (availableWidth / neededWidth) * 10) / 10;
    return Math.max(minPx, scaled);
}

export const TextareaComposer = forwardRef<LexicalEditorInputHandle, TextareaComposerProps>(
    function TextareaComposer(
        {
            value,
            onChange,
            pills,
            onPillsChange,
            onSubmit,
            placeholder,
            ariaLabel,
            disabled,
            onKeyDown,
            onContentEditableRef,
            pasteHandlers,
            inlineHint,
        },
        ref,
    ) {
        const textareaRef = useRef<HTMLTextAreaElement | null>(null);
        const backdropRef = useRef<HTMLDivElement | null>(null);
        const rootRef = useRef<HTMLDivElement | null>(null);
        const placeholderRef = useRef<HTMLDivElement | null>(null);

        /*
         * The placeholder is an overlay, not the textarea's own: a native
         * placeholder wraps in a narrow pane, and its second line lands on the
         * toolbar below the single-line box. The overlay stays on one line and
         * shrinks its type to fit the width, truncating only past the floor.
         */
        const showPlaceholder = value.length === 0 && Boolean(placeholder);
        const fitPlaceholder = useCallback(() => {
            const box = placeholderRef.current;
            const text = box?.firstElementChild as HTMLElement | null | undefined;
            if (!box || !text) return;
            text.style.fontSize = '';
            const view = box.ownerDocument.defaultView;
            const base = parseFloat(view?.getComputedStyle(text)?.fontSize ?? '') || 12;
            const size = fitPlaceholderFontSize(base, box.clientWidth, text.scrollWidth);
            if (size !== base) text.style.fontSize = `${size}px`;
        }, []);

        useLayoutEffect(() => {
            fitPlaceholder();
        }, [showPlaceholder, placeholder, fitPlaceholder]);

        useEffect(() => {
            const root = rootRef.current;
            const view = root?.ownerDocument.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null | undefined;
            if (!root || !view?.ResizeObserver) return;
            const observer = new view.ResizeObserver(() => fitPlaceholder());
            observer.observe(root);
            return () => observer.disconnect();
        }, [fitPlaceholder]);
        // Descriptors ever staged in this composer; presence in the text decides
        // what getSlashCommands reports. Kept in a ref: pill identity changes
        // never need a re-render beyond the value change that carries them.
        const knownPillsRef = useRef<SlashCommandDescriptor[]>(pills ? [...pills] : []);

        // External pill state (draft restore, edit overlay) folds in additively.
        useEffect(() => {
            for (const pill of pills ?? []) {
                if (!knownPillsRef.current.some((p) => p.commandName === pill.commandName)) {
                    knownPillsRef.current.push(pill);
                }
            }
        }, [pills]);

        const setValue = useCallback(
            (next: string, selectionStart?: number, selectionEnd?: number) => {
                const el = textareaRef.current;
                onChange(next);
                if (el) {
                    // The controlled re-render also writes el.value; writing it
                    // here first keeps the selection math synchronous.
                    el.value = next;
                    const start = Math.max(0, Math.min(selectionStart ?? next.length, next.length));
                    const end = Math.max(start, Math.min(selectionEnd ?? start, next.length));
                    el.setSelectionRange(start, end);
                }
                if (onPillsChange) onPillsChange(pillsPresentInText(next, knownPillsRef.current));
            },
            [onChange, onPillsChange],
        );

        const grow = useCallback(() => {
            const el = textareaRef.current;
            if (!el) return;
            const view = el.ownerDocument.defaultView;
            let fontSize = 13;
            if (view) {
                const computed = view.getComputedStyle(el);
                fontSize = parseFloat(computed?.fontSize || '13') || 13;
            }
            const lineHeightPx = fontSize * MAX_HEIGHT_EM;
            el.style.height = 'auto';
            const next = Math.min(el.scrollHeight, lineHeightPx);
            el.style.height = `${next}px`;
            el.style.overflowY = el.scrollHeight > lineHeightPx ? 'auto' : 'hidden';
            if (backdropRef.current) {
                backdropRef.current.style.height = el.style.height;
                backdropRef.current.scrollTop = el.scrollTop;
            }
        }, []);

        useLayoutEffect(() => {
            grow();
        }, [value, grow]);

        useImperativeHandle(
            ref,
            () => ({
                focus: () => {
                    const el = textareaRef.current;
                    if (!el) return;
                    el.focus();
                    // The caret sits where the user left it — the textarea
                    // remembers its own selection across blur, which is the
                    // behaviour the Lexical engine needed a snapshot plugin for.
                },
                clear: () => setValue('', 0, 0),
                setText: (text: string, caretOffset?: number) => setValue(text, caretOffset ?? text.length),
                deleteTrailingQuery: (length: number) => {
                    const el = textareaRef.current;
                    const current = el ? el.value : value;
                    if (length <= 0) return;
                    setValue(current.slice(0, Math.max(0, current.length - length)));
                },
                selectRange: (start: number, end: number, options?: { skipFocus?: boolean }) => {
                    const el = textareaRef.current;
                    if (!el) return;
                    if (!options?.skipFocus) el.focus();
                    // setSelectionRange never moves focus by itself, so the
                    // skipFocus contract is the native behaviour.
                    el.setSelectionRange(
                        Math.max(0, Math.min(start, el.value.length)),
                        Math.max(0, Math.min(end, el.value.length)),
                    );
                },
                getSelectionOffset: () => textareaRef.current?.selectionStart ?? null,
                insertSlashCommand: (descriptor: SlashCommandDescriptor, queryLength: number | null) => {
                    const el = textareaRef.current;
                    let current = el ? el.value : value;
                    if (queryLength != null) {
                        // The typed "/query" is replaced by the pill.
                        current = current.slice(0, Math.max(0, current.length - queryLength - 1));
                    }
                    const resolved = resolveCommandCollision(descriptor, knownPillsRef.current);
                    if (!knownPillsRef.current.some((p) => p.commandName === resolved.commandName)) {
                        knownPillsRef.current.push(resolved);
                    }
                    const needsSpace = current.length > 0 && !/[\s([{]$/.test(current);
                    const next = `${current}${needsSpace ? ' ' : ''}/${resolved.commandName} `;
                    setValue(next, next.length, next.length);
                    textareaRef.current?.focus();
                },
                getSlashCommands: () => {
                    const current = textareaRef.current?.value ?? value;
                    return pillsPresentInText(current, knownPillsRef.current);
                },
                // A textarea's value is always current — nothing is ever
                // withheld from the parent — so the send guard reads the live
                // value and the discard path has nothing to drop.
                flushPendingText: () => textareaRef.current?.value ?? value,
                discardPendingText: () => {},
            }),
            [setValue, value],
        );

        const handleKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                // An IME Enter commits the candidate; treating it as send would
                // fire mid-word. keyCode 229 covers engines that do not set
                // isComposing on the synthetic event.
                if (
                    e.key === 'Enter'
                    && !e.shiftKey
                    && !e.nativeEvent.isComposing
                    && e.nativeEvent.keyCode !== 229
                    && !isImeKeyEvent(e.nativeEvent)
                ) {
                    // The parent's keydown chain (menus, shortcuts) runs first;
                    // a menu that consumed Enter calls preventDefault.
                    onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLElement>);
                    if (!e.defaultPrevented) {
                        e.preventDefault();
                        onSubmit();
                    }
                    return;
                }
                onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLElement>);

                // File copied in a file manager dispatches no paste event on
                // Cmd/Ctrl+V — poll the clipboard on the key, like the Lexical
                // engine did.
                const isPasteCombo = (e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V');
                if (
                    isPasteCombo
                    && !isImeKeyEvent(e.nativeEvent)
                    && pasteHandlers?.hasClipboardFile?.()
                ) {
                    e.preventDefault();
                    void pasteHandlers.onPasteFromClipboard?.();
                }
            },
            [onKeyDown, onSubmit, pasteHandlers],
        );

        const handlePaste = useCallback(
            (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
                if (!pasteHandlers) return;
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                    e.preventDefault();
                    void pasteHandlers.onPasteFiles?.(Array.from(files));
                    return;
                }
                if (pasteHandlers.hasClipboardImage?.()) {
                    e.preventDefault();
                    void pasteHandlers.onPasteFromClipboard?.();
                }
            },
            [pasteHandlers],
        );

        // The chip backdrop: transparent glyphs, visible chip backgrounds.
        const backdropSegments = useMemo(
            () => splitContentByCommandTokens(value, knownPillsRef.current, (pill) => pill.commandName),
            // knownPillsRef mutates without re-render; value changing is the
            // only moment a token can appear or vanish.
            [value, pills],
        );
        const hasChips = backdropSegments.some((segment) => segment.match);
        // The hint rides the mirror too: the trigger is always trailing text,
        // so a visible span after the transparent glyphs lands exactly where
        // the caret is.
        const showHint = Boolean(inlineHint && value.length > 0);
        const showBackdrop = hasChips || showHint;

        return (
            <div ref={rootRef} className="alphainz-composer-root">
                {showPlaceholder && (
                    <div ref={placeholderRef} className="alphainz-composer-placeholder" aria-hidden="true">
                        <span>{placeholder}</span>
                    </div>
                )}
                {showBackdrop && (
                    <div ref={backdropRef} className="alphainz-composer-backdrop" aria-hidden="true">
                        {backdropSegments.map((segment, index) =>
                            segment.match ? (
                                <span
                                    key={`c-${index}`}
                                    className={`alphainz-slash-command alphainz-slash-command-live${segment.match.missing ? ' alphainz-slash-command-missing' : ''} alphainz-composer-backdrop-chip`}
                                >
                                    {segment.text}
                                </span>
                            ) : (
                                <span key={`t-${index}`}>{segment.text}</span>
                            ),
                        )}
                        {showHint && (
                            <span className="alphainz-composer-hint-text">{inlineHint}</span>
                        )}
                        {/* Trailing newline keeps the mirror's height in step
                            when the value ends with one. */}
                        {'\n'}
                    </div>
                )}
                <textarea
                    ref={(el) => {
                        textareaRef.current = el;
                        onContentEditableRef?.(el);
                    }}
                    className="chat-input alphainz-composer-textarea"
                    rows={1}
                    value={value}
                    aria-placeholder={placeholder}
                    aria-label={ariaLabel ?? 'Message'}
                    disabled={disabled}
                    spellCheck
                    onChange={(e) => {
                        onChange(e.target.value);
                        if (onPillsChange) onPillsChange(pillsPresentInText(e.target.value, knownPillsRef.current));
                    }}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onScroll={() => {
                        if (backdropRef.current && textareaRef.current) {
                            backdropRef.current.scrollTop = textareaRef.current.scrollTop;
                        }
                    }}
                />

            </div>
        );
    },
);

export default TextareaComposer;
