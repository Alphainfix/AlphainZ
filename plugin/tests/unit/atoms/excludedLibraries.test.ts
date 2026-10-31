import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// These suites cover the account-backed paths inherited from Beaver (REST
// truncation, the socket connect loop, the cloud identity gate). This build
// keeps everything local, so the branch is opened here explicitly.
vi.mock('../../../src/services/llm/agentConfig', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/services/llm/agentConfig')>()),
    isLocalBrain: () => false,
}));

import { SafeProfileWithPlan } from '@beaver/agent-core/types/profile';
import { ZoteroLibrary } from '@beaver/agent-core/types/zotero';

const { updateExcludedLibrariesMock, popupMessages } = vi.hoisted(() => ({
    updateExcludedLibrariesMock: vi.fn(),
    popupMessages: [] as any[],
}));

vi.mock('@beaver/agent-core/transport/clients/accountService', () => ({
    accountService: {
        updateExcludedLibraries: updateExcludedLibrariesMock,
    },
}));

// Exclusions live in a preference now, not on the hosted profile.
const { prefs } = vi.hoisted(() => ({ prefs: {} as Record<string, unknown> }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs[key],
    setPref: (key: string, value: unknown) => { prefs[key] = value; },
    clearPref: (key: string) => { delete prefs[key]; },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-local' })),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await vi.importActual<typeof import('jotai')>('jotai');
    return {
        addPopupMessageAtom: atom(null, (_get, _set, message: any) => {
            popupMessages.push(message);
        }),
    };
});

import {
    allLibrariesExcludedAtom,
    excludedLibrariesAtom,
    isLibraryAccessReadyAtom,
    isProfileLoadedAtom,
    localZoteroLibrariesAtom,
    profileWithPlanAtom,
    searchableLibraryIdsAtom,
} from '../../../react/atoms/profile';
import { toggleExcludedLibraryAtom } from '../../../react/atoms/excludedLibraries';

function library(overrides: Partial<ZoteroLibrary>): ZoteroLibrary {
    return {
        library_id: 1,
        group_id: null,
        name: 'My Library',
        is_group: false,
        type: 'user',
        type_id: 1,
        read_only: false,
        ...overrides,
    };
}

function profile(overrides: Partial<SafeProfileWithPlan> = {}): SafeProfileWithPlan {
    return {
        user_id: 'user-1',
        current_plan_id: 'plan-1',
        credit_plan: null,
        credit_plan_status: 'none',
        credit_plan_monthly_credits: 0,
        credit_period_start: null,
        credit_period_end: null,
        credit_monthly_reset_at: null,
        credit_cancel_at_period_end: false,
        credit_pending_downgrade: false,
        rolled_over_credits: 0,
        purchased_credits_expires_at: null,
        zotero_user_id: null,
        zotero_local_ids: ['test-local'],
        use_zotero_sync: false,
        has_authorized_access: false,
        has_completed_onboarding: true,
        has_authorized_free_access: true,
        pending_upgrade_consent: false,
        pending_downgrade_ack: false,
        consent_to_share: false,
        email_notifications: false,
        libraries: [],
        excluded_libraries: [],
        first_run_completed_at: null,
        first_run_completion_kind: null,
        standard_page_balance: 0,
        purchased_standard_page_balance: 0,
        chat_credits_used: 0,
        purchased_chat_credits: 0,
        indexing_complete: false,
        data_version: 0,
        data_migrated_at: null,
        plan: {
            id: 'plan-1',
            name: 'free',
            display_name: 'Free',
            price_monthly: 0,
            active: true,
            monthly_chat_credits: 0,
            initial_page_grant: 0,
            monthly_page_grant: 0,
            sync_database: false,
            upload_files: false,
            mcp_server: false,
            supported_file_types: [],
            max_file_size_mb: 10,
            max_page_count: 100,
            max_storage_gb: 0,
            max_user_attachments: 2,
        },
        ...overrides,
    };
}

describe('searchableLibraryIdsAtom', () => {
    it('keeps access decisions pending until profile and local libraries are loaded', () => {
        const store = createStore();

        expect(store.get(searchableLibraryIdsAtom)).toEqual([]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);

        store.set(profileWithPlanAtom, profile());
        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 })]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([1]);
        expect(store.get(isLibraryAccessReadyAtom)).toBe(false);

        store.set(isProfileLoadedAtom, true);

        expect(store.get(isLibraryAccessReadyAtom)).toBe(true);
    });

    it('returns all local library IDs when nothing is excluded', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile());
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([1, 42]);
    });

    it('removes the personal library for the global user exclusion entry', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [{ type: 'user' }] }));
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([42]);
    });

    it('removes group libraries by global group ID', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [{ type: 'group', group_id: 123 }] }));
        store.set(localZoteroLibrariesAtom, [
            library({ library_id: 1 }),
            library({ library_id: 42, group_id: 123, name: 'Group', is_group: true, type: 'group' }),
        ]);

        expect(store.get(searchableLibraryIdsAtom)).toEqual([1]);
    });

    it('reports all libraries excluded only after local libraries are loaded', () => {
        const store = createStore();
        store.set(profileWithPlanAtom, profile({ excluded_libraries: [{ type: 'user' }] }));

        expect(store.get(allLibrariesExcludedAtom)).toBe(false);

        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 })]);

        expect(store.get(allLibrariesExcludedAtom)).toBe(false);

        store.set(isProfileLoadedAtom, true);

        expect(store.get(allLibrariesExcludedAtom)).toBe(true);
    });
});

/**
 * Excluding a library, without a hosted profile.
 *
 * This wrote through the account service and refused outright when no profile
 * was loaded — which is always, here. So every toggle popped "Your profile is
 * not loaded" and no library was ever actually excluded. It writes a
 * preference now, and the round-trip through it is what these check.
 */
describe('toggleExcludedLibraryAtom', () => {
    beforeEach(() => {
        for (const key of Object.keys(prefs)) delete prefs[key];
        updateExcludedLibrariesMock.mockReset();
        popupMessages.length = 0;
    });

    it('excludes a library with no profile loaded at all', async () => {
        const store = createStore();
        const group = library({
            library_id: 42, group_id: 123, name: 'Visible Group', is_group: true, type: 'group',
        });
        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 }), group]);

        await store.set(toggleExcludedLibraryAtom, group);

        expect(store.get(excludedLibrariesAtom)).toEqual([{ type: 'group', group_id: 123 }]);
        // And the boundary the agent actually reads has moved.
        expect(store.get(searchableLibraryIdsAtom)).toEqual([1]);
        expect(popupMessages).toHaveLength(0);
        // Nothing was sent anywhere.
        expect(updateExcludedLibrariesMock).not.toHaveBeenCalled();
    });

    it('persists the change so it survives a restart', async () => {
        const store = createStore();
        const personal = library({ library_id: 1 });
        store.set(localZoteroLibrariesAtom, [personal]);

        await store.set(toggleExcludedLibraryAtom, personal);

        expect(JSON.parse(String(prefs['excludedLibraries']))).toEqual([{ type: 'user' }]);
    });

    it('keeps exclusions for libraries this device cannot see', async () => {
        // A group excluded on another machine is not visible here, and must not
        // be silently un-excluded by toggling something else.
        const store = createStore();
        const absentGroup = { type: 'group' as const, group_id: 999 };
        prefs['excludedLibraries'] = JSON.stringify([absentGroup]);
        const personal = library({ library_id: 1 });
        store.set(localZoteroLibrariesAtom, [personal]);

        await store.set(toggleExcludedLibraryAtom, personal);

        expect(store.get(excludedLibrariesAtom)).toEqual([absentGroup, { type: 'user' }]);
    });

    it('toggles back off', async () => {
        const store = createStore();
        const personal = library({ library_id: 1 });
        prefs['excludedLibraries'] = JSON.stringify([{ type: 'user' }, { type: 'group', group_id: 999 }]);
        store.set(localZoteroLibrariesAtom, [personal]);

        await store.set(toggleExcludedLibraryAtom, personal);

        expect(store.get(excludedLibrariesAtom)).toEqual([{ type: 'group', group_id: 999 }]);
    });

    it('ignores an unreadable preference rather than losing the panel', async () => {
        prefs['excludedLibraries'] = 'not json';
        const store = createStore();
        store.set(localZoteroLibrariesAtom, [library({ library_id: 1 })]);
        expect(store.get(searchableLibraryIdsAtom)).toEqual([1]);
    });
});
