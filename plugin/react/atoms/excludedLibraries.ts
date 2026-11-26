import { atom } from 'jotai';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { ZoteroLibrary } from '@beaver/agent-core/types/zotero';
import {
    excludedEntryFromLibrary,
    excludedEntryKey,
    excludedLibrariesAtom,
    libraryExclusionKey,
    profileWithPlanAtom,
} from './profile';
import { t } from '../../src/utils/i18n';

export const isUpdatingExcludedLibrariesAtom = atom(false);

/**
 * Include or exclude one library.
 *
 * This used to refuse outright without a hosted profile, and then write the
 * change through the account service. Neither exists here, so every toggle
 * popped "Your profile is not loaded" and nothing was ever excluded. It writes
 * to a preference now — see `excludedLibrariesAtom`.
 */
export const toggleExcludedLibraryAtom = atom(
    null,
    async (get, set, library: ZoteroLibrary) => {
        const toggledKey = libraryExclusionKey(library);
        const current = get(excludedLibrariesAtom);
        const isExcluded = current.some(entry => excludedEntryKey(entry) === toggledKey);
        const next = isExcluded
            ? current.filter(entry => excludedEntryKey(entry) !== toggledKey)
            : [...current, excludedEntryFromLibrary(library)];

        set(isUpdatingExcludedLibrariesAtom, true);
        try {
            set(excludedLibrariesAtom, next);
            // A profile, if one is ever loaded again, is the other half of this
            // seam and would otherwise disagree with the preference.
            const profile = get(profileWithPlanAtom);
            if (profile) set(profileWithPlanAtom, { ...profile, excluded_libraries: next });
        } catch (error) {
            set(addPopupMessageAtom, {
                type: 'error',
                title: t('Unable to update library access'),
                text: t('That change could not be saved. Check the Zotero error console.'),
            });
        } finally {
            set(isUpdatingExcludedLibrariesAtom, false);
        }
    },
);
