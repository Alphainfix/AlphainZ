import React, { useEffect, useId, useRef, useState, ReactNode } from 'react';
import ReactDOM from 'react-dom';
import { getWindowFromElement, getDocumentFromElement } from '../utils/windowContext';
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect';

/** What a keyboard can land on inside the anchor: the control the tooltip is about. */
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
    '[contenteditable=""]',
].join(', ');

/** How long after opening a scroll only moves the tooltip: focusing a control scrolls it into view. */
const SCROLL_GRACE_MS = 150;

function normalizeText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Whether focus arrived from the keyboard; a click that focuses a button is not a reason to open. */
function isKeyboardFocus(target: EventTarget | null): boolean {
    const element = target as Element | null;
    if (!element || typeof element.matches !== 'function') return false;
    try {
        return element.matches(':focus-visible');
    } catch {
        return true;
    }
}

/** Set an IDREF-list attribute to its other tokens plus `wanted`, touching only `ours`. */
function syncIdRefs(element: Element, attribute: string, ours: readonly string[], wanted: readonly string[]): void {
    const current = (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean);
    const next = [...current.filter((token) => !ours.includes(token)), ...wanted];
    if (next.join(' ') === current.join(' ')) return;
    if (next.length > 0) element.setAttribute(attribute, next.join(' '));
    else element.removeAttribute(attribute);
}

/** The control's own accessible name, ignoring anything this tooltip added. */
function ownAccessibleName(element: HTMLElement, ours: readonly string[]): string {
    const label = normalizeText(element.getAttribute('aria-label'));
    if (label) return label;
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter((id) => id && !ours.includes(id));
    if (labelledBy.length > 0) {
        const doc = element.ownerDocument;
        const text = normalizeText(labelledBy.map((id) => doc.getElementById(id)?.textContent ?? '').join(' '));
        if (text) return text;
    }
    const labels = (element as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
        let text = '';
        for (let i = 0; i < labels.length; i++) text += ` ${labels[i]?.textContent ?? ''}`;
        if (normalizeText(text)) return normalizeText(text);
    }
    return normalizeText(element.textContent) || normalizeText(element.getAttribute('title'));
}

/** The first control a keyboard can reach inside the anchor, outside the hidden copies of the text. */
function findControl(anchor: HTMLElement | null, hiddenCopies: ReadonlyArray<Element | null>): HTMLElement | null {
    if (!anchor) return null;
    const candidates = anchor.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (!hiddenCopies.some((copy) => copy?.contains(candidate))) return candidate;
    }
    return null;
}

/**
* Props for the Tooltip component
*/
export interface TooltipProps {
    /** The element that triggers the tooltip */
    children: ReactNode;
    /** Main text content of the tooltip */
    content: ReactNode;
    /** Secondary content displayed on the right side */
    secondaryContent?: ReactNode;
    /** Whether to show the arrow pointing to the anchor element */
    showArrow?: boolean;
    /** Whether to display all content on a single line */
    singleLine?: boolean;
    /** Additional CSS class names */
    classNames?: string;
    /** Whether the tooltip is disabled */
    disabled?: boolean;
    /** Whether to use a portal for rendering (prevents containment issues) */
    usePortal?: boolean;
    /** Padding */
    padding?: boolean;
    /** Whether to show the tooltip on hover */
    width?: string;
    /** Whether to parse HTML in the content (use with caution) */
    allowHtml?: boolean;
    /** Custom content to render instead of the default content */
    customContent?: ReactNode;
    /** Whether the tooltip should stay open when clicking the anchor element */
    stayOpenOnAnchorClick?: boolean;
    /** Optional preferred placement ('top' or 'bottom') */
    placement?: 'top' | 'bottom';
    /** Horizontal alignment relative to the anchor element */
    horizontalAlign?: 'center' | 'start' | 'end';
    /** CSS display value for the anchor wrapper */
    anchorDisplay?: React.CSSProperties['display'];
}

/**
* A reusable tooltip component.
*
* Opens on hover and on keyboard focus of the control inside it, and closes on
* Escape. Its text is tied to that control for assistive technology: it names a
* control that has no name of its own (an icon-only button) and describes one
* that does, unless it only repeats that name.
*/
const Tooltip: React.FC<TooltipProps> = ({
    children,
    content,
    secondaryContent,
    showArrow = true,
    singleLine = false,
    classNames = '',
    disabled = false,
    usePortal = false,
    padding = true,
    width,
    allowHtml = false,
    customContent,
    stayOpenOnAnchorClick = false,
    placement: preferredPlacement,
    horizontalAlign = 'center',
    anchorDisplay = 'inline-block',
}) => {
    const [isOpen, setIsOpen] = useState<boolean>(false);
    const [position, setPosition] = useState<{ x: number; y: number; placement: 'top' | 'bottom' }>({ 
        x: 0, 
        y: 0, 
        placement: preferredPlacement || 'bottom'
    });
    const [arrowPosition, setArrowPosition] = useState<string>('50%');
    
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);

    // Add a ref to track if the click occurred on the anchor
    const anchorClicked = useRef<boolean>(false);

    // What keeps the tooltip open: the pointer over the anchor, or keyboard
    // focus on the anchor or inside the tooltip. Either one alone is enough.
    const pointerInside = useRef<boolean>(false);
    const keyboardFocusInside = useRef<boolean>(false);
    const openedAt = useRef<number>(0);
    // Set while Escape hands focus back to the control, which must not reopen it.
    const refocusing = useRef<boolean>(false);

    // Hidden copies of the text, for the control to be named or described by.
    // They are rendered only while the anchor holds a control to tie them to:
    // over plain text, such as a citation in a paragraph, a copy would only
    // add the tooltip's text to the text of everything around it.
    const baseId = useId();
    const textId = `${baseId}-text`;
    const secondaryId = `${baseId}-secondary`;
    const textRef = useRef<HTMLSpanElement | null>(null);
    const secondaryRef = useRef<HTMLSpanElement | null>(null);
    const wiredControl = useRef<HTMLElement | null>(null);
    const [copiesNeeded, setCopiesNeeded] = useState<boolean>(false);
    const hasContent = !(content === null || content === undefined || content === '');

    /*
     * Closing is delayed so the pointer can reach the tooltip.
     *
     * The tooltip is positioned 10-12px clear of its anchor, so moving towards
     * it crosses dead space — and leaving the anchor closed it instantly. Any
     * tooltip with something to read or click in it was therefore unreachable:
     * the citation card names a paper and offers to open it, and the pointer
     * could never get there.
     *
     * The grace period is short enough that a tooltip you moved away from still
     * disappears immediately to the eye, and hovering the tooltip itself
     * cancels the close for as long as the pointer stays on it.
     */
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelClose = () => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
    };
    const scheduleClose = () => {
        cancelClose();
        closeTimer.current = setTimeout(() => {
            closeTimer.current = null;
            setIsOpen(false);
        }, 160);
    };
    useEffect(() => cancelClose, []);
    
    // Calculate tooltip position
    const calculatePosition = () => {
        if (!anchorRef.current || !tooltipRef.current) return;
        
        // Get the correct window context for this component
        const win = getWindowFromElement(anchorRef.current);
        if (!win) return;
        const anchorRect = anchorRef.current.getBoundingClientRect();
        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        
        // Calculate anchor points for horizontal positioning.
        const centerX = anchorRect.left + (anchorRect.width / 2);
        const arrowInsetFromEdge = Math.min(32, anchorRect.width / 2);
        const targetX = horizontalAlign === 'start'
            ? anchorRect.left + arrowInsetFromEdge
            : horizontalAlign === 'end'
                ? anchorRect.right - arrowInsetFromEdge
                : centerX;
        
        // Check if tooltip should be displayed below or above the anchor
        const spaceBelow = win.innerHeight - anchorRect.bottom;
        const spaceAbove = anchorRect.top;
        
        // The preferred side wins while it fits; when it does not, the tooltip
        // flips — unless the other side is even tighter, in which case the
        // preference stands and clips less badly.
        const fitsBelow = spaceBelow >= tooltipRect.height + 12;
        const fitsAbove = spaceAbove >= tooltipRect.height + 12;
        const placement: 'top' | 'bottom' = preferredPlacement === 'top'
            ? (fitsAbove || !fitsBelow ? 'top' : 'bottom')
            : (fitsBelow || !fitsAbove ? 'bottom' : 'top');
        const posY = placement === 'top'
            ? anchorRect.top - tooltipRect.height - 12
            : anchorRect.bottom + 10;
                
        let posX = horizontalAlign === 'start'
            ? anchorRect.left + (tooltipRect.width / 2)
            : horizontalAlign === 'end'
                ? anchorRect.right - (tooltipRect.width / 2)
                : centerX;
        
        // Adjust if tooltip would overflow right or left edge
        const rightEdge = posX + (tooltipRect.width / 2);
        if (rightEdge > win.innerWidth - 8) {
            // Shift left to avoid right overflow
            const adjustment = rightEdge - (win.innerWidth - 8);
            posX -= adjustment;
        }
        
        const leftEdge = posX - (tooltipRect.width / 2);
        if (leftEdge < 8) {
            // Shift right to avoid left overflow
            const adjustment = 8 - leftEdge;
            posX += adjustment;
        }
        
        const tooltipLeft = posX - (tooltipRect.width / 2);
        const minArrowOffset = 12;
        const maxArrowOffset = Math.max(minArrowOffset, tooltipRect.width - minArrowOffset);
        const arrowOffset = Math.min(
            Math.max(targetX - tooltipLeft, minArrowOffset),
            maxArrowOffset
        );
        
        setPosition({ x: posX, y: posY, placement });
        setArrowPosition(`${arrowOffset}px`);
    };
    
    // Update position when tooltip is shown
    useEffect(() => {
        if (!isOpen) return;

        // Get the correct window context for this component
        const win = getWindowFromElement(anchorRef.current);
        if (!win) return;

        // Initial position calculation with a slight delay to ensure
        // the tooltip has been rendered and can be measured
        const initialPositionTimer = setTimeout(() => {
            calculatePosition();
        }, 10);

        // Handle window resize
        const handleResize = () => calculatePosition();
        win.addEventListener('resize', handleResize);
        
        // Handle scroll events to close the tooltip. Right after opening, a
        // scroll is the focused control being scrolled into view: follow it.
        const handleScroll = () => {
            if (Date.now() - openedAt.current < SCROLL_GRACE_MS) {
                calculatePosition();
                return;
            }
            setIsOpen(false);
        };
        win.addEventListener('scroll', handleScroll, true);
        
        // Handle click events to close the tooltip
        const handleClick = (e: MouseEvent) => {
            // If stayOpenOnAnchorClick is true and the click was on the anchor, don't close
            if (stayOpenOnAnchorClick && anchorClicked.current) {
                anchorClicked.current = false;
                return;
            }
            // A click inside the tooltip is a click on the tooltip's own
            // content — a link, a button. Closing on it would cancel the thing
            // the user was reaching for.
            const target = e.target as Node | null;
            if (target && tooltipRef.current?.contains(target)) return;
            setIsOpen(false);
        };
        win.addEventListener('click', handleClick);
        
        return () => {
            clearTimeout(initialPositionTimer);
            win.removeEventListener('resize', handleResize);
            win.removeEventListener('scroll', handleScroll, true);
            win.removeEventListener('click', handleClick);
        };
    }, [isOpen, stayOpenOnAnchorClick]);
    
    // Close tooltip when disabled prop changes to true
    useEffect(() => {
        if (disabled && isOpen) {
            setIsOpen(false);
        }
    }, [disabled]);
    
    const open = () => {
        // Don't show tooltip if disabled or content is empty
        if (disabled || !hasContent) return;
        cancelClose();
        if (!isOpen) openedAt.current = Date.now();
        setIsOpen(true);
    };

    // Handle mouse enter/leave for the anchor element
    const handleMouseEnter = () => {
        pointerInside.current = true;
        open();
    };

    const handleMouseLeave = () => {
        pointerInside.current = false;
        if (!keyboardFocusInside.current) scheduleClose();
    };

    const handleFocus = (e: React.FocusEvent) => {
        if (!isKeyboardFocus(e.target)) return;
        keyboardFocusInside.current = true;
        if (refocusing.current) {
            refocusing.current = false;
            return;
        }
        open();
    };

    // Inside the tooltip, too, only keyboard focus holds it open. Clicking a
    // link in it also focuses the link, and the tooltip should still close
    // once the pointer leaves.
    const handleTooltipFocus = (e: React.FocusEvent) => {
        keyboardFocusInside.current = isKeyboardFocus(e.target);
        if (keyboardFocusInside.current) cancelClose();
    };

    // Focus moving between the anchor and the tooltip's own content keeps it open.
    const handleBlur = (e: React.FocusEvent) => {
        const next = e.relatedTarget as Node | null;
        if (next && (anchorRef.current?.contains(next) || tooltipRef.current?.contains(next))) return;
        keyboardFocusInside.current = false;
        if (!pointerInside.current) {
            cancelClose();
            setIsOpen(false);
        }
    };

    // Escape dismisses the tooltip without moving focus away from the control;
    // from inside the tooltip, focus goes back to the control.
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== 'Escape' || !isOpen) return;
        e.stopPropagation();
        const focusWasInside = tooltipRef.current?.contains(e.target as Node) ?? false;
        cancelClose();
        setIsOpen(false);
        if (focusWasInside && wiredControl.current) {
            refocusing.current = true;
            wiredControl.current.focus();
            refocusing.current = false;
        }
    };

    // Add a click handler to mark when anchor is clicked
    const handleAnchorClick = () => {
        anchorClicked.current = true;
    };

    /*
     * Tie the text to the control inside the anchor.
     *
     * An icon-only button has no name of its own, so the tooltip names it
     * (aria-labelledby); a control that has one is described by the tooltip
     * instead (aria-describedby), unless the name already says it. Only
     * this tooltip's own ids are ever added or removed, so the control's other
     * references survive. Checked after every render: the control can change.
     * When a control first appears, this pass asks for the hidden copies and
     * the render that adds them ties them to it.
     */
    useIsomorphicLayoutEffect(() => {
        const ours = [textId, secondaryId];
        const control = findControl(anchorRef.current, [textRef.current, secondaryRef.current]);
        const previous = wiredControl.current;
        if (previous && previous !== control) {
            syncIdRefs(previous, 'aria-labelledby', ours, []);
            syncIdRefs(previous, 'aria-describedby', ours, []);
        }
        wiredControl.current = control;
        const needed = control !== null && !disabled;
        if (needed !== copiesNeeded) setCopiesNeeded(needed);
        if (!control) return;

        const text = disabled ? '' : normalizeText(textRef.current?.textContent);
        const secondary = disabled ? '' : normalizeText(secondaryRef.current?.textContent);
        const name = ownAccessibleName(control, ours);
        const labelledBy: string[] = [];
        const describedBy: string[] = [];
        if (text) {
            if (!name) labelledBy.push(textId);
            else if (!name.toLowerCase().includes(text.toLowerCase())) describedBy.push(textId);
        }
        if (secondary && (text || name)) describedBy.push(secondaryId);
        syncIdRefs(control, 'aria-labelledby', ours, labelledBy);
        syncIdRefs(control, 'aria-describedby', ours, describedBy);
    });

    useEffect(() => () => {
        const control = wiredControl.current;
        if (!control) return;
        syncIdRefs(control, 'aria-labelledby', [textId, secondaryId], []);
        syncIdRefs(control, 'aria-describedby', [textId, secondaryId], []);
    }, [textId, secondaryId]);

    // Render content with HTML support if enabled
    const renderContent = () => {
        if (typeof content === 'string' && allowHtml) {
            return <span dangerouslySetInnerHTML={{ __html: content }} />;
        }
        return content;
    };

    // Render secondary content with HTML support if enabled
    const renderSecondaryContent = () => {
        if (typeof secondaryContent === 'string' && allowHtml) {
            return <span dangerouslySetInnerHTML={{ __html: secondaryContent }} />;
        }
        return secondaryContent;
    };

    // Wrap children to add mouse, focus and key handlers
    const wrappedChildren = (
        <span
            ref={anchorRef}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onClick={handleAnchorClick}
            style={{ display: anchorDisplay }}
        >
            {children}
            {copiesNeeded && hasContent && (
                <span id={textId} ref={textRef} hidden style={{ display: 'none' }}>
                    {renderContent()}
                </span>
            )}
            {copiesNeeded && secondaryContent && (
                <span id={secondaryId} ref={secondaryRef} hidden style={{ display: 'none' }}>
                    {renderSecondaryContent()}
                </span>
            )}
        </span>
    );
    
    // Tooltip element
    const tooltipElement = isOpen && (
        <span
            ref={tooltipRef}
            className={`
                bg-quaternary rounded-md shadow-md fixed z-100000 border-popup block
                ${position.placement === 'bottom' ? 'tooltip-fade-in-bottom' : 'tooltip-fade-in-top'}
                ${classNames}
            `}
            style={{
                top: position.y,
                left: position.x,
                transform: 'translateX(-50%)',
                width: width,
                display: 'block'
            }}
            role="tooltip"
            aria-hidden={!isOpen}
            onMouseEnter={() => { pointerInside.current = true; cancelClose(); }}
            onMouseLeave={() => { pointerInside.current = false; if (!keyboardFocusInside.current) scheduleClose(); }}
            onFocus={handleTooltipFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
        >
            <span className={`
                    ${padding && 'px-2 py-1'} block
                    ${singleLine ? 'display-flex items-center' : 'whitespace-normal'}
                    ${singleLine ? 'single-line' : ''}
                `}
                style={{ display: singleLine ? 'flex' : 'block' }}
            >
                {customContent ? (
                    customContent
                ) : (
                    <>
                        <span 
                            className={`text-base font-color-secondary overflow-hidden text-ellipsis ${singleLine ? 'single-line' : ''}`}
                            style={{ display: 'inline-block', verticalAlign: 'middle' }}
                        >
                            {renderContent()}
                        </span>
                        {secondaryContent && (
                            <span className={`
                                text-sm font-color-tertiary
                                ${singleLine ? 'ml-3' : 'mt-1'}
                                ${singleLine ? 'single-line' : ''}
                            `}
                            style={{ 
                                display: singleLine ? 'inline-block' : 'block',
                                verticalAlign: 'middle'
                            }}
                            >
                                {renderSecondaryContent()}
                            </span>
                        )}
                    </>
                )}
            </span>
            
            {showArrow && (
                <span 
                    className={`tooltip-arrow tooltip-arrow-${position.placement} block`}
                    style={{ left: arrowPosition, display: 'block' }}
                />
            )}
        </span>
    );
    
    // Use portal if requested - this helps when the tooltip needs to 
    // break out of a container with overflow:hidden or similar
    if (usePortal && isOpen) {
        // Portal into the document the anchor lives in. While the anchor is not
        // attached there is no document to portal into, so render inline rather
        // than guess a window and land the tooltip in the wrong one.
        const doc = getDocumentFromElement(anchorRef.current);
        if (doc) {
            return (
                <>
                {wrappedChildren}
                {ReactDOM.createPortal(
                    tooltipElement,
                    doc.body
                )}
                </>
            );
        }
    }
    
    return (
        <>
        {wrappedChildren}
        {tooltipElement}
        </>
    );
};

export default Tooltip;
