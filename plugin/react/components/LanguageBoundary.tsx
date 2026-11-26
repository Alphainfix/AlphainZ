import React, { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { uiLanguageAtom } from '../atoms/uiLanguage';

/**
 * Remounts its children when the interface language changes, so every string
 * that went through `t` renders again in the new language — memoized
 * components included, which a plain re-render would skip. State that lives in
 * atoms (conversations, drafts, the open settings tab) carries over; state
 * local to a component (an open menu, a scroll position) starts fresh.
 *
 * Also marks the pane's root element with the language, which line breaking
 * and font fallback for Chinese text depend on.
 */
const LanguageBoundary: React.FC<{ root?: HTMLElement; children: React.ReactNode }> = ({ root, children }) => {
    const language = useAtomValue(uiLanguageAtom);

    useEffect(() => {
        root?.setAttribute('lang', language);
    }, [root, language]);

    return <React.Fragment key={language}>{children}</React.Fragment>;
};

export default LanguageBoundary;
