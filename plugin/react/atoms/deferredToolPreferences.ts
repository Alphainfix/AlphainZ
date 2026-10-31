/**
 * Deferred Tool Preferences
 * 
 * Manages user preferences for how deferred tools (like edit_metadata) should behave.
 * 
 * Structure:
 * - toolToGroup: Maps tool names to group names (allows renaming tools while preserving preference)
 * - groupPreferences: Maps group names to the preference value
 * 
 * This two-level structure allows:
 * 1. Multiple tools to share the same preference (grouping)
 * 2. Renaming tools without losing preferences (just update toolToGroup)
 */

import { atom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    NO_STANDING_APPROVAL_GROUPS,
    DEFAULT_DEFERRED_TOOL_GROUPS,
    RUN_APPROVAL_ACTION_TYPE_ALIASES,
} from './runApprovalPolicy';

// =============================================================================
// Types
// =============================================================================

export type DeferredToolPreference = 'always_ask' | 'always_apply' | 'continue_without_applying';

export interface DeferredToolPreferencesData {
    /** Maps tool names to group names */
    toolToGroup: Record<string, string>;
    /** Maps group names to preference values */
    groupPreferences: Record<string, DeferredToolPreference>;
}

// Default preferences for groups
const DEFAULT_GROUP_PREFERENCES: Record<string, DeferredToolPreference> = {
    'metadata_edits': 'always_ask',
    'note_edits': 'always_ask',
    /*
     * Notes ask, like every other write.
     *
     * Upstream shipped this as `always_apply`, and an evaluation sweep showed
     * what that costs: asked only whether the library *had* a review paper, a
     * run wrote a note, created a collection and added papers — and the note
     * landed silently because of this line. A note is a paragraph of text in
     * the user's library; it is not more disposable than a highlight, which
     * has always asked.
     */
    'note_creation': 'always_ask',
    'library_modifications': 'always_ask',
    'library_structure': 'always_ask',
    'annotations': 'always_ask',
    'create_items': 'always_ask',
};

// =============================================================================
// Preference Labels
// =============================================================================

export const DEFERRED_TOOL_PREFERENCE_LABELS: Record<DeferredToolPreference, string> = {
    'always_ask': 'Always ask',
    'always_apply': 'Always apply',
    'continue_without_applying': 'Always review later',
};

/*
 * What each choice does, as the Permissions menu shows it. "Always review
 * later" queues: nothing is asked while the answer is written, and each change
 * waits on its card, with its own Apply and Reject, and in the list of changes
 * to review at the end of the answer.
 */
export const DEFERRED_TOOL_PREFERENCE_DESCRIPTIONS: Record<DeferredToolPreference, string> = {
    'always_ask': 'Show each change and wait for your approval',
    'always_apply': 'Make the change without asking (the riskiest ones still ask)',
    'continue_without_applying': "Don't ask now; list the changes after the answer for you to apply or reject",
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Load preferences from Zotero prefs
 */
function loadPreferences(): DeferredToolPreferencesData {
    try {
        const prefString = getPref('deferredToolPreferences');
        if (prefString && typeof prefString === 'string') {
            const parsed = JSON.parse(prefString);
            const storedToolToGroup = { ...(parsed.toolToGroup ?? {}) };
            // Older versions persisted the full run-authorization alias map.
            // Strip those action-record names so they cannot acquire a
            // preference merely by being authorization aliases.
            for (const actionType of Object.keys(RUN_APPROVAL_ACTION_TYPE_ALIASES)) {
                delete storedToolToGroup[actionType];
            }
            // Deletion moved out of the shared annotations preference group.
            // A persisted mapping from an older profile must not override the
            // new safety boundary and turn annotations=always_apply into an
            // implicit standing grant to delete annotations.
            delete storedToolToGroup.delete_annotations;
            return {
                toolToGroup: { ...DEFAULT_DEFERRED_TOOL_GROUPS, ...storedToolToGroup },
                groupPreferences: { ...DEFAULT_GROUP_PREFERENCES, ...parsed.groupPreferences },
            };
        }
    } catch (error) {
        logger(`deferredToolPreferences: Failed to load preferences: ${error}`, 1);
    }
    return {
        toolToGroup: { ...DEFAULT_DEFERRED_TOOL_GROUPS },
        groupPreferences: { ...DEFAULT_GROUP_PREFERENCES },
    };
}

/**
 * Save preferences to Zotero prefs
 */
function savePreferences(data: DeferredToolPreferencesData): void {
    try {
        const prefString = JSON.stringify(data);
        setPref('deferredToolPreferences', prefString);
    } catch (error) {
        logger(`deferredToolPreferences: Failed to save preferences: ${error}`, 1);
    }
}

/**
 * Get the group name for a tool
 */
function getGroupForTool(data: DeferredToolPreferencesData, toolName: string): string {
    // Return existing group mapping, or use tool name as its own group
    return data.toolToGroup[toolName] ?? toolName;
}

/**
 * Get the preference for a tool
 */
function getPreferenceForTool(data: DeferredToolPreferencesData, toolName: string): DeferredToolPreference {
    const group = getGroupForTool(data, toolName);
    // Not a preference: see NO_STANDING_APPROVAL_GROUPS. A stored value from a
    // build that still offered the choice is read past, not honoured; only a
    // grant given on a card during the run can apply these.
    if (NO_STANDING_APPROVAL_GROUPS.has(group)) return 'always_ask';
    return data.groupPreferences[group] ?? 'always_ask';
}

// =============================================================================
// State Atoms
// =============================================================================

/**
 * Main atom for deferred tool preferences.
 * Initialized from Zotero prefs on first read.
 */
export const deferredToolPreferencesAtom = atom<DeferredToolPreferencesData>(loadPreferences());

// =============================================================================
// Derived Atoms
// =============================================================================

/**
 * Get the preference for a specific tool name.
 * Usage: const pref = useAtomValue(getPreferenceForToolAtom)('edit_metadata');
 */
export const getPreferenceForToolAtom = atom(
    (get) => (toolName: string): DeferredToolPreference => {
        const data = get(deferredToolPreferencesAtom);
        return getPreferenceForTool(data, toolName);
    }
);

/**
 * Get the group name for a specific tool.
 * Useful for displaying which group a tool belongs to.
 */
export const getGroupForToolAtom = atom(
    (get) => (toolName: string): string => {
        const data = get(deferredToolPreferencesAtom);
        return getGroupForTool(data, toolName);
    }
);

// =============================================================================
// Mutation Atoms
// =============================================================================

/**
 * Update the preference for a tool.
 * This updates the group preference, affecting all tools in the same group.
 */
export const updateToolPreferenceAtom = atom(
    null,
    (get, set, { toolName, preference }: { toolName: string; preference: DeferredToolPreference }) => {
        const currentData = get(deferredToolPreferencesAtom);
        
        // Ensure tool has a group mapping
        const group = getGroupForTool(currentData, toolName);
        
        const newData: DeferredToolPreferencesData = {
            toolToGroup: {
                ...currentData.toolToGroup,
                [toolName]: group,
            },
            groupPreferences: {
                ...currentData.groupPreferences,
                [group]: preference,
            },
        };
        
        set(deferredToolPreferencesAtom, newData);
        savePreferences(newData);
        
        logger(`deferredToolPreferences: Updated ${toolName} (group: ${group}) to ${preference}`, 1);
    }
);

/**
 * Add a tool to a specific group.
 * Useful for grouping multiple tools to share the same preference.
 */
export const addToolToGroupAtom = atom(
    null,
    (get, set, { toolName, groupName }: { toolName: string; groupName: string }) => {
        const currentData = get(deferredToolPreferencesAtom);
        
        const newData: DeferredToolPreferencesData = {
            toolToGroup: {
                ...currentData.toolToGroup,
                [toolName]: groupName,
            },
            groupPreferences: {
                ...currentData.groupPreferences,
                // Ensure group has a default preference if new
                [groupName]: currentData.groupPreferences[groupName] ?? 'always_ask',
            },
        };
        
        set(deferredToolPreferencesAtom, newData);
        savePreferences(newData);
        
        logger(`deferredToolPreferences: Added tool ${toolName} to group ${groupName}`, 1);
    }
);

/**
 * Reload preferences from Zotero prefs.
 * Useful if preferences were changed externally.
 */
export const reloadPreferencesAtom = atom(
    null,
    (_get, set) => {
        const data = loadPreferences();
        set(deferredToolPreferencesAtom, data);
    }
);
