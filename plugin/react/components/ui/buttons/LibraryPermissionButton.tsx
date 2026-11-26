import React from 'react';
import PermissionMenu, { PermissionMenuOption } from '@beaver/agent-ui/primitives/PermissionMenu';
import HandIcon from '@beaver/agent-ui/icons/HandIcon';
import SecurityWarningIcon from '@beaver/agent-ui/icons/SecurityWarningIcon';
import { msg, t } from '../../../../src/utils/i18n';

/**
 * How much Beaver may change in the library on its own: ask before every write,
 * or apply writes as they come.
 */
export type LibraryPermissionMode = 'ask' | 'full_access';

export const LIBRARY_PERMISSION_HEADING = msg('How should library changes be approved?');

/**
 * The Zotero-side copy for the shared permission menu. The menu itself is
 * client-agnostic; a document-hosted client supplies its own option set.
 */
export const LIBRARY_PERMISSION_OPTIONS: readonly PermissionMenuOption<LibraryPermissionMode>[] = [
    {
        value: 'ask',
        label: msg('Ask for approval'),
        description: msg('Review every change before it is applied'),
        icon: HandIcon,
    },
    {
        value: 'full_access',
        label: msg('Full access'),
        description: msg('Edit items, collections, and annotations without asking'),
        icon: SecurityWarningIcon,
        tone: 'warning',
    },
];

interface LibraryPermissionButtonProps {
    mode: LibraryPermissionMode;
    onChange: (mode: LibraryPermissionMode) => void;
    disabled?: boolean;
    /** Render the trigger as its icon alone, for a tight toolbar. */
    iconOnly?: boolean;
    className?: string;
    style?: React.CSSProperties;
    onAfterClose?: () => void;
}

/**
 * The library-changes permission control: the shared `PermissionMenu` with
 * Beaver's Zotero copy. Presentational — the caller owns where the mode is
 * stored, since persistent per-tool preferences live in
 * `atoms/deferredToolPreferences` and carry their own safety carve-outs.
 */
const LibraryPermissionButton: React.FC<LibraryPermissionButtonProps> = ({
    mode,
    onChange,
    disabled = false,
    iconOnly = false,
    className,
    style,
    onAfterClose,
}) => (
    <PermissionMenu
        options={LIBRARY_PERMISSION_OPTIONS.map((option) => ({ ...option, label: t(option.label), description: option.description && t(option.description) }))}
        value={mode}
        onChange={onChange}
        heading={t(LIBRARY_PERMISSION_HEADING)}
        disabled={disabled}
        iconOnly={iconOnly}
        className={className}
        style={style ?? { padding: '2px 6px', fontSize: '0.80rem' }}
        tooltipContent={t('How library changes are approved')}
        onAfterClose={onAfterClose}
    />
);

export default LibraryPermissionButton;
