import React, { useEffect, useState, useRef, useCallback, useMemo, useSyncExternalStore } from 'react';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { getPref } from '../../src/utils/prefs';
import { conversationSyncMode } from '../../src/services/conversationSync';
import { getConversationBackend } from '../../src/services/conversationSync';
import {
    describeSyncHealth,
    getSyncHealth,
    subscribeSyncHealth,
    syncHealthHint,
} from '../../src/services/conversationSync/syncHealth';
import { logger } from '@beaver/agent-core/platform/logger';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Icon, SearchIcon, EditIcon, DeleteIcon, TickIcon, CancelIcon, FileViewIcon, UndoIcon, ClockIcon } from './icons/icons';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { isThreadListViewAtom, threadListFilterAtom, showAllThreadInstancesAtom } from '../atoms/ui';
import {
    ThreadData,
    currentThreadNameAtom,
    loadThreadAtom,
    newThreadAtom,
    threadsChangedAtom,
    showArchiveAtom,
} from '../atoms/threads';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { LOCAL_USER_ID, userAtom } from '../atoms/auth';
import { isLocalBrain } from '../../src/services/llm/agentConfig';
import {
    conversationSyncStatusAtom,
    localDeleteThread,
    localRecentThreads,
    localRenameThread,
    localThreadsForItem,
    localSearchThreads,
} from '../atoms/loadLocalThreads';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { threadService, isThreadAgentMismatch } from '@beaver/agent-core/transport/threadService';
import { currentZoteroInstanceRef } from '../../src/utils/zoteroUtils';
import { getDateGroup } from '../utils/dateUtils';
import { formatTimeAgo } from '../utils/formatTimeAgo';
import { buildThreadItemFilter } from '../utils/threadItemFilter';
import { deduplicateByThread, threadModelToThreadData, isThreadInstanceMismatch } from '../utils/threadMatches';
import Button from '@beaver/agent-ui/primitives/Button';
import { ChipButton } from './agentRuns/requestChips/ChipButton';
import { CSSIcon, CSSItemTypeIcon } from './icons/zotero';
import ThreadFilterMenu from './ui/menus/ThreadFilterMenu';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { clearRecentChatsCache } from './RecentChats';
import { isTransientNetworkError } from '../utils/isTransientNetworkError';
import { msg, t, tn } from '../../src/utils/i18n';

type FetchError = { offline: boolean } | null;

interface ThreadListViewProps {
    isWindow?: boolean;
}

interface CacheEntry {
    threads: ThreadData[];
    hasMore: boolean;
    nextCursor: string | null;
    timestamp: number;
    // Last known count of threads hidden by instance scoping for this variant;
    // null when the response didn't carry one (search, later pages).
    otherInstanceCount?: number | null;
}

const PAGE_SIZE = 15;
const CACHE_TTL = 60_000; // 1 minute

/**
 * A row as the local database lists it: with when it was archived, or null
 * while active. Undefined only for rows from a source that does not say.
 */
type ListedRow = ThreadData & { archivedAt?: string | null };

/**
 * A page of the archive — all of it, what matches a search, or what is about
 * one paper — straight from the local database. The active list's helpers
 * only ever read active chats, so every query made under the Archive chip
 * must come through here; otherwise active chats appear in the archive with
 * "Delete forever" beside them.
 */
async function localArchivePage(
    userId: string,
    options: {
        query?: string;
        filter?: { libraryId: number; keys: string[] } | null;
        limit: number;
        offset: number;
    },
): Promise<ListedRow[]> {
    const conn = (Zotero as any).AlphainZ?.db;
    try {
        if (options.filter) {
            return (await conn?.getThreadsForItems?.(
                options.filter.libraryId,
                options.filter.keys,
                options.limit,
                { archived: true },
            )) ?? [];
        }
        if (options.query) {
            return (await conn?.searchThreadsLocal?.(
                userId,
                options.query,
                options.limit,
                options.offset,
                { archived: true },
            )) ?? [];
        }
        return (await conn?.getArchivedThreads?.(userId, options.limit, options.offset)) ?? [];
    } catch (error) {
        logger(`ThreadListView: could not read the archive: ${error}`, 1);
        return [];
    }
}

// Marks a chat created in a different Zotero install. Always says "Zotero" —
// a bare "account" would read as the user's Beaver account, which never
// differs here. A mismatch always implies a different profile (see
// `isThreadInstanceMismatch`), so one label covers every case.
const FOREIGN_THREAD_LABEL = msg('Other Zotero profile');
const FOREIGN_THREAD_TITLE = msg('Created in a different Zotero account or profile');

/**
 * Cache key for a thread-list fetch. Includes the live instance identity so
 * enabling/logging into Zotero (or switching accounts) cannot reuse a prior
 * identity's scoped results under the same "scoped" bucket.
 */
function threadListCacheKey(
    userId: string,
    query: string,
    showAll: boolean,
    scope: { zoteroUserId?: string | null; zoteroLocalId?: string | null } | null | undefined,
    /*
     * The archive is a different list, and leaving it out of the key meant the
     * cache answered for it with the active one: the chip flipped to "Archive"
     * and the same conversations stayed on screen, so the button looked dead.
     */
    archived: boolean,
): string {
    const mode = archived ? 'archived' : 'active';
    if (showAll) return `${userId}:${query}:all:${mode}`;
    return `${userId}:${query}:scoped:${scope?.zoteroUserId ?? ''}:${scope?.zoteroLocalId ?? ''}:${mode}`;
}

// Module-level cache: persists across mount/unmount cycles
const searchCache = new Map<string, CacheEntry>();

export function clearThreadListCache() {
    searchCache.clear();
}

const highlightMatch = (text: string, query: string): React.ReactNode => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
        <>
            {text.slice(0, idx)}
            <span className="font-color-accent-blue">{text.slice(idx, idx + query.length)}</span>
            {text.slice(idx + query.length)}
        </>
    );
};

const groupThreadsByDate = <T extends ThreadData>(threads: T[]) => {
    const groups: Record<string, T[]> = {
        'Today': [],
        'Yesterday': [],
        'This Week': [],
        'This Month': [],
        'Older': [],
    };
    threads.forEach(thread => {
        const group = getDateGroup(thread.updatedAt);
        groups[group].push(thread);
    });
    return groups;
};

const ThreadListView: React.FC<ThreadListViewProps> = ({ isWindow: _isWindow }) => {
    const setIsThreadListView = useSetAtom(isThreadListViewAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const newThread = useSetAtom(newThreadAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const user = useAtomValue(userAtom);
    // There is no account when the model runs locally; the database is keyed by
    // a fixed local identity instead.
    const ownerId = user?.id ?? LOCAL_USER_ID;
    const filter = useAtomValue(threadListFilterAtom);
    const setFilter = useSetAtom(threadListFilterAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);

    const [threads, setThreads] = useState<ListedRow[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [fetchError, setFetchError] = useState<FetchError>(null);

    // Instance scoping: hide threads stamped by other Zotero accounts/installs
    // by default; "Show all" reveals them. Read live — the Zotero account id
    // can appear/disappear when the user logs in or out without remounting.
    const instanceRef = currentZoteroInstanceRef();
    // Global so the choice survives closing and reopening the thread list.
    const showAllInstances = useAtomValue(showAllThreadInstancesAtom);
    const setShowAllInstances = useSetAtom(showAllThreadInstancesAtom);
    const threadsChanged = useAtomValue(threadsChangedAtom);
    /*
     * The archive is a mode of this same list, not a second screen.
     *
     * Everything around the rows — search, the item filter, rename, the JSON
     * button — applies just as well to an archived conversation, and a
     * separate view would have to grow all of it again.
     */
    const [showArchive, setShowArchive] = useAtom(showArchiveAtom);
    const showArchiveRef = useRef(showArchive);
    useEffect(() => { showArchiveRef.current = showArchive; }, [showArchive]);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    // Read once per mount: the row action is meaningless with the mirror off,
    // and a button that always says "not written yet" is worse than no button.
    const threadSyncEnabled = React.useMemo(() => conversationSyncMode() !== 'off', []);
    const syncStatus = useAtomValue(conversationSyncStatusAtom);
    // What the last pass could not do; the footer says it instead of only
    // "last synced".
    const syncHealth = useSyncExternalStore(subscribeSyncHealth, getSyncHealth);
    const setCurrentThreadName = useSetAtom(currentThreadNameAtom);

    // The footer's "Sync now": the same pass every automatic trigger runs,
    // followed by the same list refresh, just on demand and visible.
    const handleSyncNow = React.useCallback(() => {
        void (async () => {
            const { syncConversationsNow } = await import('../atoms/loadLocalThreads');
            await syncConversationsNow(ownerId);
            searchCache.clear();
            fetchThreads(activeQueryRef.current);
        })();
    }, [ownerId]);
    // Read inside fetch callbacks (kept out of their deps so toggling in
    // item-filtered mode doesn't trigger a needless by-item refetch). Seeded
    // from the atom so the first fetch after a remount honors a prior opt-out.
    const showAllInstancesRef = useRef(showAllInstances);
    const [otherInstanceCount, setOtherInstanceCount] = useState<number | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [activeQuery, setActiveQuery] = useState('');
    const activeQueryRef = useRef('');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Guards against a stale in-flight fetch (e.g. from a filter that was
    // just replaced or cleared) overwriting state set by a newer one.
    const fetchSeqRef = useRef(0);

    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [isSavingRename, setIsSavingRename] = useState(false);
    const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const menuPortalContainer = containerRef.current?.closest('[id^="alphainz-react-root-"], #alphainz-pane-window') as HTMLElement | null;
    const searchInputRef = useRef<HTMLInputElement | null>(null);

    // The filter menu's own search input holds focus while the menu is open
    // and nothing restores it on close, so refocus after the close settles.
    const focusSearchInput = () => {
        setTimeout(() => searchInputRef.current?.focus(), 5);
    };

    useEffect(() => {
        activeQueryRef.current = activeQuery;
    }, [activeQuery]);

    // Keeps the ref honest if the atom is changed outside this component.
    useEffect(() => {
        showAllInstancesRef.current = showAllInstances;
    }, [showAllInstances]);

    // Fetch threads (initial load or after search)
    // Locally there is no account, and `ownerId` falls back to a fixed local
    // identity. An early `if (!user) return` here is what kept this list empty
    // however many conversations were on disk — the local branches further down
    // never ran, because nothing got past this line.
    const isLocal = isLocalBrain();

    const fetchThreads = useCallback(async (query: string) => {
        if (!user && !isLocal) return;

        // Invalidate any earlier request before taking a synchronous path
        // (such as a cache hit) so stale results cannot overwrite it later.
        const seq = ++fetchSeqRef.current;

        if (filter) {
            // Exclusions can change (AlphainZ Settings) while the view is
            // open, so re-check at fetch time instead of trusting the atom.
            if (!searchableLibraryIds.includes(filter.libraryId)) {
                // Do not leave item-filtered rows visible after removing the
                // filter chip. The atom update below triggers the unfiltered
                // fetch on the next render.
                setThreads([]);
                setHasMore(false);
                setNextCursor(null);
                setFetchError(null);
                setIsLoading(true);
                setFilter(null);
                return;
            }

            setThreads([]);
            setIsLoading(true);
            try {
                // "View All" from a reader tab arrives here with a filter. The
                // REST lookup has nothing to answer with locally, so the
                // filtered list came back empty while the unfiltered one worked.
                if (isLocal) {
                    // Under the Archive chip, the archived chats about this paper.
                    const local = showArchiveRef.current
                        ? await localArchivePage(ownerId, { filter, limit: PAGE_SIZE, offset: 0 })
                        : await localThreadsForItem(filter.libraryId, filter.keys, PAGE_SIZE);
                    if (seq === fetchSeqRef.current) {
                        setThreads(local);
                        setHasMore(false);
                        setNextCursor(null);
                        setOtherInstanceCount(null);
                        setFetchError(null);
                        setIsLoading(false);
                    }
                    return;
                }
                const matches = await threadService.findThreadsByItem(
                    { libraryId: filter.libraryId, libraryRef: filter.libraryRef },
                    filter.keys,
                    'both'
                );
                // The by-item route takes no agent scope, so drop another
                // client's threads here (the other lists are scoped server-side).
                const deduped = deduplicateByThread(matches.filter(m => !isThreadAgentMismatch(m)));
                if (seq === fetchSeqRef.current) {
                    setThreads(deduped);
                    setHasMore(false);
                    setNextCursor(null);
                    setFetchError(null);
                }
            } catch (error) {
                console.error('Error fetching threads by item:', error);
                if (seq === fetchSeqRef.current) {
                    if (isTransientNetworkError(error)) {
                        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
                        setFetchError({ offline });
                    } else {
                        setFetchError(null);
                    }
                }
            } finally {
                if (seq === fetchSeqRef.current) setIsLoading(false);
            }
            return;
        }

        const showAll = showAllInstancesRef.current;
        // Live identity for every fetch — do not close over a mount-time snapshot.
        const liveInstance = currentZoteroInstanceRef();
        const scope = showAll ? undefined : (liveInstance ?? undefined);
        const cacheKey = threadListCacheKey(ownerId, query, showAll, liveInstance, showArchiveRef.current);

        // Check cache with TTL
        const cached = searchCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            setThreads(cached.threads);
            setHasMore(cached.hasMore);
            setNextCursor(cached.nextCursor);
            // Retain the last known count when this variant has none cached.
            if (cached.otherInstanceCount != null) setOtherInstanceCount(cached.otherInstanceCount);
            setFetchError(null);
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        try {
            // Locally-run conversations live in this install's database. There
            // is no cursor to page through and no other instance to scope
            // against: a local database belongs to exactly one install.
            let mapped: ListedRow[];
            let response: any = { next_cursor: null, has_more: false, other_instance_count: null };
            if (isLocal && showArchiveRef.current) {
                // One row past the page says whether there is another page.
                const page = await localArchivePage(ownerId, { query, limit: PAGE_SIZE + 1, offset: 0 });
                mapped = page.slice(0, PAGE_SIZE);
                response = {
                    next_cursor: null,
                    has_more: page.length > PAGE_SIZE,
                    other_instance_count: null,
                };
            } else if (isLocal) {
                mapped = query
                    ? await localSearchThreads(query, PAGE_SIZE, ownerId)
                    : await localRecentThreads(PAGE_SIZE, ownerId);
                // A full page means there may be another. There is no cursor to
                // hand back — the local pager works from an offset, which is the
                // row count already on screen.
                response = {
                    next_cursor: null,
                    has_more: mapped.length === PAGE_SIZE,
                    other_instance_count: null,
                };
            } else {
                response = query
                    ? await threadService.searchThreads(query, PAGE_SIZE, null, scope)
                    // Only the scoped first page can report how many threads the
                    // scoping hides.
                    : await threadService.getPaginatedThreads(PAGE_SIZE, null, scope, scope !== undefined);
                mapped = response.data.map(threadModelToThreadData);
            }
            if (seq === fetchSeqRef.current) {
                setThreads(mapped);
                setNextCursor(response.next_cursor);
                setHasMore(response.has_more);
                // Search responses carry no count — retain the last known one.
                if (response.other_instance_count != null) {
                    setOtherInstanceCount(response.other_instance_count);
                }
            }
            searchCache.set(cacheKey, {
                threads: mapped,
                hasMore: response.has_more,
                nextCursor: response.next_cursor,
                timestamp: Date.now(),
                otherInstanceCount: response.other_instance_count ?? null,
            });
            if (seq === fetchSeqRef.current) setFetchError(null);
        } catch (error) {
            console.error('Error fetching threads:', error);
            if (seq === fetchSeqRef.current) {
                if (isTransientNetworkError(error)) {
                    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
                    setFetchError({ offline });
                } else {
                    setFetchError(null);
                }
            }
        } finally {
            if (seq === fetchSeqRef.current) setIsLoading(false);
        }
    }, [user, isLocal, filter, searchableLibraryIds]);

    // Toggle between the scoped and all-instances list. Unfiltered mode
    // refetches (cache-hit when warm); item-filtered mode only flips the
    // display partition of the already-fetched matches.
    const toggleShowAllInstances = (next: boolean) => {
        showAllInstancesRef.current = next;
        setShowAllInstances(next);
        if (!filter) fetchThreads(activeQueryRef.current);
    };

    // Initial fetch, and refetch (with the in-progress query) whenever the
    // filter is set/cleared/switched — or whenever a run starts or finishes
    // and changes the threads table underneath an open list.
    useEffect(() => {
        fetchThreads(activeQueryRef.current);
    }, [fetchThreads, threadsChanged, showArchive]);

    /*
     * Catch up with the other machine's conversations when the list opens.
     *
     * The mirrored files are pulled in at startup, and Zotero's sync does not
     * keep to that schedule: a conversation written on Windows arrived minutes
     * later and then sat unread until the next launch. Opening the history is
     * exactly when someone is looking for it.
     */
    useEffect(() => {
        let cancelled = false;
        const pass = async () => {
            const { syncConversationsNow } = await import('../atoms/loadLocalThreads');
            await syncConversationsNow(ownerId);
            if (!cancelled) {
                searchCache.clear();
                fetchThreads(activeQueryRef.current);
            }
        };
        void pass();
        /*
         * The folder backend has no notifier: nothing announces that a cloud
         * client just dropped new files in. While the list is on screen --
         * exactly when staleness is visible -- poll cheaply (one directory
         * listing per tick; shouldImport makes an idle tick free).
         */
        let interval: ReturnType<typeof setInterval> | null = null;
        if (conversationSyncMode() === 'folder') {
            interval = setInterval(() => { void pass(); }, 60_000);
        }
        return () => {
            cancelled = true;
            if (interval !== null) clearInterval(interval);
        };
    }, [ownerId]);

    // Debounced search
    useEffect(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
        }
        if (searchQuery === activeQuery) return;

        debounceRef.current = setTimeout(() => {
            setActiveQuery(searchQuery);
            // Filtered mode searches the already-fetched set client-side —
            // no network call or cache invalidation needed.
            if (!filter) fetchThreads(searchQuery);
        }, 400);

        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
        };
    }, [searchQuery, activeQuery, filter, fetchThreads]);

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsThreadListView(false);
            return;
        }
        if (e.key === 'Enter') {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
            setActiveQuery(searchQuery);
            if (filter) return;
            // Invalidate cache for this query to get fresh results on Enter
            if (user) {
                searchCache.delete(threadListCacheKey(
                    ownerId,
                    searchQuery,
                    showAllInstancesRef.current,
                    currentZoteroInstanceRef(),
                    showArchiveRef.current,
                ));
            }
            fetchThreads(searchQuery);
        }
    };

    const handleSelectFilterItem = async (item: Zotero.Item) => {
        const f = await buildThreadItemFilter(item, searchableLibraryIds);
        if (f) setFilter(f);
        focusSearchInput();
    };

    // Load more
    const loadMoreThreads = async () => {
        if ((!user && !isLocal) || isLoading || filter) return;

        const seq = ++fetchSeqRef.current;
        setIsLoading(true);
        try {
            const showAll = showAllInstancesRef.current;
            const liveInstance = currentZoteroInstanceRef();
            const scope = showAll ? undefined : (liveInstance ?? undefined);
            const cacheKey = threadListCacheKey(ownerId, activeQuery, showAll, liveInstance, showArchiveRef.current);
            let response;
            let mapped: ListedRow[];
            if (isLocal && showArchiveRef.current) {
                // The next page of the archive, never of the active list.
                const page = await localArchivePage(ownerId, {
                    query: activeQuery,
                    limit: PAGE_SIZE + 1,
                    offset: threads.length,
                });
                mapped = page.slice(0, PAGE_SIZE);
                response = {
                    next_cursor: null,
                    has_more: page.length > PAGE_SIZE,
                    other_instance_count: null,
                };
            } else if (isLocal) {
                // Offset rather than cursor: the rows already on screen are the
                // offset, which is exactly what the local pager takes.
                mapped = activeQuery
                    ? await localSearchThreads(activeQuery, PAGE_SIZE, ownerId, threads.length)
                    : await localRecentThreads(PAGE_SIZE, ownerId, threads.length);
                response = {
                    next_cursor: null,
                    has_more: mapped.length === PAGE_SIZE,
                    other_instance_count: null,
                };
            } else if (activeQuery) {
                response = await threadService.searchThreads(activeQuery, PAGE_SIZE, nextCursor, scope);
                mapped = response.data.map(threadModelToThreadData);
            } else {
                response = await threadService.getPaginatedThreads(PAGE_SIZE, nextCursor, scope);
                mapped = response.data.map(threadModelToThreadData);
            }
            const combined = [...threads, ...mapped];
            if (seq === fetchSeqRef.current) {
                setThreads(combined);
                setNextCursor(response.next_cursor);
                setHasMore(response.has_more);
            }
            searchCache.set(cacheKey, {
                threads: combined,
                hasMore: response.has_more,
                nextCursor: response.next_cursor,
                timestamp: Date.now(),
                // Later pages carry no count — keep the variant's last known one.
                otherInstanceCount: searchCache.get(cacheKey)?.otherInstanceCount ?? null,
            });
            if (seq === fetchSeqRef.current) setFetchError(null);
        } catch (error) {
            console.error('Error loading more threads:', error);
            if (seq === fetchSeqRef.current && isTransientNetworkError(error)) {
                const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
                setFetchError({ offline });
            }
        } finally {
            if (seq === fetchSeqRef.current) setIsLoading(false);
        }
    };

    // Thread actions
    const handleSelectThread = async (thread: ThreadData) => {
        if (!user && !isLocal) return;
        // Clicking the already-open thread just closes the list.
        if (thread.id === currentThreadId) {
            setIsThreadListView(false);
            return;
        }
        try {
            const loaded = await loadThread({
                user_id: ownerId,
                threadId: thread.id,
                threadName: thread.name,
                threadIdentity: {
                    zoteroUserId: thread.zoteroUserId ?? null,
                    zoteroLocalId: thread.zoteroLocalId ?? null,
                },
            });
            // Keep the list open when the load was aborted (e.g. the user
            // canceled the other-instance confirm) or failed.
            if (loaded) setIsThreadListView(false);
        } catch (error) {
            console.error('Error loading thread:', error);
        }
    };

    /**
     * Put the conversation's JSON in front of the user, in Zotero.
     *
     * The point is to be able to hand a whole transcript to something else —
     * "把这个对话拿去给 codex 帮我画图". Selecting the attachment gets them to
     * the file: right-click → Show File, or drag it straight out.
     */
    const handleRevealJson = async (threadId: string, archived: boolean) => {
        try {
            const backend = getConversationBackend();
            const outcome = backend ? await backend.revealThread(threadId) : 'missing';
            if (outcome === 'missing') {
                addPopupMessage({
                    type: 'info',
                    title: t('Not written yet'),
                    // "Export all" walks the active history only, so it is no
                    // answer for an archived chat.
                    text: archived
                        ? t('This archived chat has no file in the sync location -- archived chats '
                            + 'are not exported. Restore it, and its file is written with its next change.')
                        : t('This conversation has no file yet -- it is written when the '
                            + 'next answer finishes, or by "Export all conversations" in settings.'),
                    expire: true,
                    duration: 6000,
                });
                return;
            }
        } catch (error) {
            addPopupMessage({
                type: 'error',
                title: t('Could not open the conversation JSON'),
                text: String(error),
                expire: true,
                duration: 8000,
            });
        }
    };

    const handleRestore = async (threadId: string) => {
        try {
            const { localRestoreThread } = await import('../atoms/loadLocalThreads');
            await localRestoreThread(threadId, ownerId);
            setThreads((prev) => prev.filter((th) => th.id !== threadId));
            searchCache.clear();
            clearRecentChatsCache();
            addPopupMessage({
                type: 'info',
                title: t('Restored'),
                text: t('The chat is back in your history.'),
                expire: true,
                duration: 4000,
            });
        } catch (error) {
            addPopupMessage({
                type: 'error',
                title: t('Could not restore the chat'),
                text: String(error),
                expire: true,
                duration: 6000,
            });
        }
    };

    const handlePurge = async (threadId: string) => {
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: t('Delete forever?'),
            // Honest this time: the tombstone makes the deletion stick on
            // every synced machine, so "cannot be undone" is finally true.
            text: t('This permanently deletes the chat here and on your other synced computers. It cannot be undone.'),
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        const removed = threads.find(th => th.id === threadId);
        setThreads(prev => prev.filter(th => th.id !== threadId));
        searchCache.clear();
        clearRecentChatsCache(threadId);

        try {
            const { localPurgeThread } = await import('../atoms/loadLocalThreads');
            await localPurgeThread(threadId, ownerId);
            if (threadId === currentThreadId) {
                await newThread({ skipActiveRunConfirm: true });
            }
            addPopupMessage({
                type: 'info',
                title: t('Deleted forever'),
                text: t('The chat was permanently removed.'),
                expire: true,
                duration: 4000,
            });
        } catch (error) {
            console.error('Error purging thread:', error);
            if (removed) {
                setThreads(prev => prev.some(th => th.id === threadId)
                    ? prev
                    : [removed, ...prev]);
            }
            searchCache.clear();
            addPopupMessage({
                type: 'error',
                title: t('Could not delete the chat'),
                text: String(error),
                expire: true,
                duration: 6000,
            });
        }
    };

    const handleDelete = async (threadId: string) => {
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: t('Delete chat?'),
            // It goes to the archive. The old copy promised the opposite —
            // "cannot be undone" — which is both wrong and the scarier of the
            // two things it could say.
            text: t('This chat moves to the archive. You can restore it from there.'),
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        /*
         * The row goes first, and the work happens behind it.
         *
         * Deleting archives the conversation, trashes its synced attachment and
         * can start a new thread — none of it fast, and all of it was awaited
         * before the list was told anything, so the row a user had just
         * confirmed away sat there for a beat looking like a click that missed.
         *
         * The caches are dropped in the same breath: a refetch racing this
         * update used to answer out of a cache that still held the row and put
         * it straight back.
         */
        const removed = threads.find(th => th.id === threadId);
        setThreads(prev => prev.filter(th => th.id !== threadId));
        searchCache.clear();
        clearRecentChatsCache(threadId);

        try {
            if (isLocalBrain()) await localDeleteThread(threadId, ownerId);
            else await threadService.deleteThread(threadId);
            // If deleting the current thread, create a new one. The user already
            // confirmed the delete above, so skip the active-run confirmation.
            if (threadId === currentThreadId) {
                await newThread({ skipActiveRunConfirm: true });
            }
        } catch (error) {
            console.error('Error deleting thread:', error);
            // Put it back rather than leave the list claiming something that
            // did not happen.
            if (removed) {
                setThreads(prev => prev.some(th => th.id === threadId)
                    ? prev
                    : [removed, ...prev]);
            }
            searchCache.clear();
        }
    };

    const handleStartRename = (threadId: string, currentName: string) => {
        setEditingThreadId(threadId);
        setEditingName(currentName || t('Unnamed conversation'));
    };

    const handleCancelRename = () => {
        setEditingThreadId(null);
    };

    const handleConfirmRename = async (threadId: string) => {
        const newName = editingName.trim();
        if (!threadId || !newName) {
            setEditingThreadId(null);
            return;
        }
        setIsSavingRename(true);
        try {
            if (isLocalBrain()) await localRenameThread(threadId, newName, ownerId);
            else await threadService.renameThread(threadId, newName);
            setThreads(prev => prev.map(th =>
                th.id === threadId ? { ...th, name: newName } : th
            ));
            /*
             * The open conversation's name also lives in memory — the header
             * shows it, saved notes take their title from it, and each answer
             * stores it back. Renaming the open chat here must change that
             * copy too, or the next answer puts the old name back.
             */
            if (threadId === currentThreadId) setCurrentThreadName(newName);
            // Invalidate caches
            searchCache.clear();
            clearRecentChatsCache();
            setEditingThreadId(null);
        } catch (error) {
            console.error('Error renaming thread:', error);
            // The box stays open with what was typed, and the reason is shown:
            // closing it silently would look like a rename that worked.
            addPopupMessage({
                type: 'error',
                title: t('Could not rename the chat'),
                text: String(error),
                expire: true,
                duration: 6000,
            });
        } finally {
            setIsSavingRename(false);
        }
    };

    const handleRenameKeyDown = (e: React.KeyboardEvent, threadId: string) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            handleConfirmRename(threadId);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancelRename();
        }
    };

    // Item-filtered mode fetches unscoped and partitions client-side (the
    // deduplicated match set is bounded); unfiltered mode is server-scoped, so
    // no partition is needed there.
    const filteredMismatchCount = useMemo(
        () => filter
            ? threads.filter(th => isThreadInstanceMismatch(instanceRef, {
                zoteroUserId: th.zoteroUserId, zoteroLocalId: th.zoteroLocalId,
            })).length
            : 0,
        [filter, threads, instanceRef]
    );

    const displayedThreads = useMemo(() => {
        let visible = threads;
        if (filter && !showAllInstances) {
            visible = visible.filter(th => !isThreadInstanceMismatch(instanceRef, {
                zoteroUserId: th.zoteroUserId, zoteroLocalId: th.zoteroLocalId,
            }));
        }
        if (filter && activeQuery) {
            visible = visible.filter(th => (th.name || t('Unnamed conversation')).toLowerCase().includes(activeQuery.toLowerCase()));
        }
        return visible;
    }, [filter, activeQuery, threads, showAllInstances, instanceRef]);

    // Threads hidden by instance scoping: exact client-side count when
    // item-filtered, the backend-reported count otherwise.
    const hiddenInstanceCount = filter ? filteredMismatchCount : (otherInstanceCount ?? 0);
    // Whether the escape hatch out of instance scoping should be offered.
    const canShowHidden = !isLoading && !showAllInstances && hiddenInstanceCount > 0;
    // Search responses carry no count, so the retained one describes the
    // unfiltered list rather than the current results — drop the number there.
    // Item-filtered mode partitions client-side, so its count is exact.
    const hasExactHiddenCount = !!filter || !activeQuery;
    const hiddenCountSummary = !hasExactHiddenCount
        ? t('Chats from other Zotero profiles are hidden')
        : tn(hiddenInstanceCount, '{count} chat from a different Zotero profile is hidden', '{count} chats from other Zotero profiles are hidden');
    const hiddenExplanation = !hasExactHiddenCount
        ? t('Some of your chats were created in a different Zotero profile. AlphainZ keeps chat history separate for each one.')
        : tn(hiddenInstanceCount,
            'You have {count} chat that was created in a different Zotero profile. AlphainZ keeps chat history separate for each one.',
            'You have {count} chats that were created in a different Zotero profile. AlphainZ keeps chat history separate for each one.');

    const groupedThreads = groupThreadsByDate(displayedThreads);

    return (
        <div className="display-flex flex-col flex-1 min-h-0" ref={containerRef}>
            {/* Title */}
            <div className="thread-overlay-title mb-1">{t('Chats')}</div>

            {/* Search bar */}
            <div className="px-3 pb-2">
                <div className="thread-search-wrapper">
                    <SearchIcon
                        width={14}
                        height={14}
                        className="thread-search-icon"
                    />
                    <input
                        type="text"
                        className="thread-search-input"
                        placeholder={t('Search chats...')}
                        aria-label={t('Search chats')}
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        autoFocus
                        ref={searchInputRef}
                    />
                    {isLoading && (
                        <div className="thread-search-spinner">
                            <Spinner size={12} />
                        </div>
                    )}
                </div>
            </div>

            {/* Filter row */}
            <div className="thread-filter-row">
                {/* Into the archive and back. A mode of this list rather than a
                    separate screen, so search, the item filter and the row
                    actions all keep working inside it. */}
                <Tooltip
                    content={showArchive ? t('Back to your chats') : t('Archive')}
                    secondaryContent={showArchive
                        ? undefined
                        : t('Deleted chats are kept here and can be restored.')}
                    width="220px"
                >
                    <ChipButton
                        className={showArchive ? 'thread-filter-chip' : undefined}
                        onClick={() => setShowArchive((v) => !v)}
                        aria-label={t('Archive')}
                        aria-pressed={showArchive}
                    >
                        <Icon icon={showArchive ? UndoIcon : ClockIcon} className="scale-80" />
                        <span className="truncate">{t('Archive')}</span>
                    </ChipButton>
                </Tooltip>
                <div className="thread-filter-divider" />
                <ThreadFilterMenu
                    disabled={isLoading}
                    activeFilter={filter}
                    onSelect={handleSelectFilterItem}
                    menuPortalContainer={menuPortalContainer}
                />
                {filter && (
                    <>
                        <div className="thread-filter-divider" />
                        <ChipButton
                            className="thread-filter-chip"
                            onClick={() => {}}
                            aria-label={t('Filtered by {label}', { label: filter.label })}
                        >
                            <CSSItemTypeIcon itemType={filter.itemType} className="scale-80" />
                            <span className="truncate">{filter.label}</span>
                            <span
                                role="button"
                                aria-label={t('Remove filter')}
                                className="thread-filter-chip-remove"
                                onClick={(e) => { e.stopPropagation(); setFilter(null); focusSearchInput(); }}
                            >
                                <CSSIcon name="x-8" className="icon-16 scale-80" />
                            </span>
                        </ChipButton>
                    </>
                )}
                {/* Active-scope chip mirroring the item-filter chip beside it:
                    it names the current scope, and clicking it (the "x") drops
                    back to this profile. The entry point into "show all" lives
                    in the footer / empty state below the list. */}
                {showAllInstances && (
                    <div className="thread-filter-row-end">
                        <Tooltip
                            content={t('Showing all Zotero profiles')}
                            secondaryContent={t('AlphainZ normally shows only chats created with this Zotero profile.')}
                            width="220px"
                        >
                            <ChipButton
                                onClick={() => toggleShowAllInstances(false)}
                                aria-label={t('Showing chats from all Zotero profiles. Show only this profile\'s chats')}
                            >
                                <span className="truncate">{t('All profiles')}</span>
                                <span className="thread-filter-chip-remove" aria-hidden="true">
                                    <CSSIcon name="x-8" className="icon-16 scale-80" />
                                </span>
                            </ChipButton>
                        </Tooltip>
                    </div>
                )}
            </div>
            {filter && !isLoading && (
                <div className="thread-filter-count">
                    {showArchive
                        ? tn(displayedThreads.length, 'Showing {count} archived chat related to {label}', 'Showing {count} archived chats related to {label}', { label: filter.label })
                        : tn(displayedThreads.length, 'Showing {count} chat related to {label}', 'Showing {count} chats related to {label}', { label: filter.label })}
                </div>
            )}

            {/* Thread list */}
            <div className="flex-1 overflow-y-auto px-1">
                {Object.entries(groupedThreads).map(([groupName, groupThreads]) => {
                    if (groupThreads.length === 0) return null;
                    return (
                        <div key={groupName}>
                            <div className="thread-group-header">{t(groupName)}</div>
                            {groupThreads.map(thread => {
                                const threadName = thread.name || t('Unnamed conversation');
                                const isCurrent = thread.id === currentThreadId;
                                const isEditing = editingThreadId === thread.id;
                                const isHovered = hoveredThreadId === thread.id;
                                // Only ever true while showing all instances — the scoped
                                // list contains no foreign threads to label.
                                const isForeign = isThreadInstanceMismatch(instanceRef, {
                                    zoteroUserId: thread.zoteroUserId, zoteroLocalId: thread.zoteroLocalId,
                                });
                                // The row's own state picks its actions: "Delete forever"
                                // belongs to an archived chat, never to whichever list is
                                // showing. Rows that do not say fall back to the list.
                                const isArchivedRow = thread.archivedAt === undefined
                                    ? showArchive
                                    : !!thread.archivedAt;

                                return (
                                    <div
                                        key={thread.id}
                                        className={`thread-list-item ${isEditing ? 'thread-list-item-editing' : ''} ${isHovered ? 'thread-list-item-hovered' : ''}`}
                                        role={isEditing ? undefined : 'button'}
                                        tabIndex={isEditing ? undefined : 0}
                                        aria-label={isEditing ? undefined : [
                                            threadName,
                                            formatTimeAgo(thread.updatedAt),
                                            isCurrent ? t('current chat') : null,
                                            isForeign ? t(FOREIGN_THREAD_TITLE) : null,
                                        ].filter(Boolean).join(', ')}
                                        onClick={() => {
                                            if (!isEditing) {
                                                handleSelectThread(thread);
                                            }
                                        }}
                                        onKeyDown={isEditing ? undefined : (e) => {
                                            // Ignore keys bubbling up from nested controls
                                            // (e.g. the Rename/Delete buttons) so they keep
                                            // their own keyboard activation.
                                            if (e.target !== e.currentTarget) return;
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                handleSelectThread(thread);
                                            }
                                        }}
                                        onMouseEnter={() => setHoveredThreadId(thread.id)}
                                        onMouseLeave={() => setHoveredThreadId(null)}
                                    >
                                        <div className="flex-1 min-w-0">
                                            {isEditing ? (
                                                <input
                                                    type="text"
                                                    className="thread-rename-input"
                                                    value={editingName}
                                                    onChange={e => setEditingName(e.target.value)}
                                                    onKeyDown={e => handleRenameKeyDown(e, thread.id)}
                                                    onClick={e => e.stopPropagation()}
                                                    autoFocus
                                                />
                                            ) : (
                                                <div className="thread-list-item-name truncate">
                                                    {activeQuery ? highlightMatch(threadName, activeQuery) : threadName}
                                                </div>
                                            )}
                                            <div className="thread-list-item-time">
                                                {formatTimeAgo(thread.updatedAt)}{isCurrent && t(' (current chat)')}
                                                {isForeign && (
                                                    <span className="thread-list-item-badge" title={t(FOREIGN_THREAD_TITLE)}>
                                                        {t(FOREIGN_THREAD_LABEL)}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="thread-list-item-actions">
                                            {isEditing ? (
                                                <div className="display-flex gap-2">
                                                    <IconButton
                                                        icon={CancelIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleCancelRename();
                                                        }}
                                                        className="scale-90"
                                                        ariaLabel={t('Cancel rename')}
                                                    />
                                                    <IconButton
                                                        icon={TickIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleConfirmRename(thread.id);
                                                        }}
                                                        className="scale-11"
                                                        ariaLabel={t('Confirm rename')}
                                                        loading={isSavingRename}
                                                    />
                                                </div>
                                            ) : (
                                                <div className="display-flex gap-3">
                                                    {threadSyncEnabled && (
                                                        <IconButton
                                                            icon={FileViewIcon}
                                                            variant="ghost-secondary"
                                                            onClick={e => {
                                                                e.stopPropagation();
                                                                void handleRevealJson(thread.id, isArchivedRow);
                                                            }}
                                                            className="scale-95"
                                                            ariaLabel={t('Show conversation JSON in Zotero')}
                                                        />
                                                    )}
                                                    <IconButton
                                                        icon={EditIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleStartRename(thread.id, threadName);
                                                        }}
                                                        className="scale-95"
                                                        ariaLabel={t('Rename thread')}
                                                    />
                                                    <IconButton
                                                        icon={isArchivedRow ? UndoIcon : DeleteIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            if (isArchivedRow) void handleRestore(thread.id);
                                                            else handleDelete(thread.id);
                                                        }}
                                                        className="scale-95"
                                                        ariaLabel={isArchivedRow
                                                            ? t('Restore this chat')
                                                            : t('Move this chat to the archive')}
                                                    />
                                                    {isArchivedRow && (
                                                        <IconButton
                                                            icon={DeleteIcon}
                                                            variant="ghost-secondary"
                                                            onClick={e => {
                                                                e.stopPropagation();
                                                                void handlePurge(thread.id);
                                                            }}
                                                            className="scale-95"
                                                            ariaLabel={t('Delete this chat forever, on every synced computer')}
                                                        />
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}

                {/* Network error state — replaces empty state when fetch failed transiently */}
                {!isLoading && displayedThreads.length === 0 && fetchError && (
                    <div className="display-flex flex-col items-center justify-center gap-2 py-6 text-center px-3 mt-2">
                        <span className="font-color-primary font-semibold text-sm">
                            {fetchError.offline ? t('You\'re offline') : t('Couldn\'t load chats')}
                        </span>
                        <span className="font-color-tertiary text-sm">
                            {fetchError.offline
                                ? t('Reconnect to load your chats.')
                                : t('Check your connection and try again.')}
                        </span>
                        <Button
                            variant="outline"
                            onClick={() => fetchThreads(activeQuery)}
                            disabled={isLoading}
                            type="button"
                            loading={isLoading}
                        >
                            {t('Try again')}
                        </Button>
                    </div>
                )}

                {/* Empty state — prominent variant. With nothing else on screen
                    the hidden chats are the whole story, so they get the full
                    explanation plus the escape hatch instead of a footer note. */}
                {!isLoading && displayedThreads.length === 0 && !fetchError && canShowHidden && (
                    <div className="display-flex flex-col items-center justify-center gap-3 py-6 text-center px-3 mt-2">
                        <span className="font-color-primary font-semibold text-base">
                            {activeQuery ? t('No matching chats') : filter ? t('No chats about {label}', { label: filter.label }) : t('No chats on this Zotero profile')}
                        </span>
                        <span className="font-color-secondary text-base">
                            {hiddenExplanation}
                        </span>
                        <Button
                            variant="outline"
                            onClick={() => toggleShowAllInstances(true)}
                            type="button"
                            className="mt-2"
                        >
                            {t('Show all chats')}
                        </Button>
                    </div>
                )}

                {/* Empty state */}
                {!isLoading && displayedThreads.length === 0 && !fetchError && !canShowHidden && (
                    <div className="display-flex items-center justify-center py-6">
                        <span className="font-color-tertiary text-sm">
                            {activeQuery
                                ? t('No matching chats')
                                : filter
                                    ? (showArchive
                                        ? t('No archived chats about {label}', { label: filter.label })
                                        : t('No chats about {label}', { label: filter.label }))
                                    : showArchive ? t('The archive is empty') : t('No chats yet')}
                        </span>
                    </div>
                )}

                {/* Loading spinner */}
                {isLoading && displayedThreads.length === 0 && (
                    <div className="display-flex items-center justify-center py-6">
                        <Spinner size={18} />
                    </div>
                )}

                {/* Inline network error — when we already have some threads but a refresh / load-more failed */}
                {displayedThreads.length > 0 && fetchError && !isLoading && (
                    <div className="display-flex items-center gap-2 px-3 py-2">
                        <span className="font-color-tertiary text-sm flex-1">
                            {fetchError.offline ? t('You\'re offline.') : t('Couldn\'t reach the server.')}
                        </span>
                        <Button
                            variant="outline"
                            onClick={() => fetchThreads(activeQuery)}
                            disabled={isLoading}
                            type="button"
                        >
                            {t('Try again')}
                        </Button>
                    </div>
                )}

                {/* Show more */}
                {hasMore && !fetchError && (
                    <div className="display-flex justify-start p-2 ml-2 pb-3">
                        <Button
                            variant="outline"
                            onClick={loadMoreThreads}
                            disabled={isLoading}
                            type="button"
                            loading={isLoading}
                        >
                            {t('Show more')}
                        </Button>
                    </div>
                )}
            </div>

            {/* Footer: instance-scoping escape hatch. Outside the scroll area so
                it stays visible, and only while the list has rows — an empty
                list gets the prominent variant above instead. */}
            {canShowHidden && displayedThreads.length > 0 && (
                <div className="thread-filter-footer-note">
                    {hiddenCountSummary}
                    {' · '}
                    <span
                        role="button"
                        tabIndex={0}
                        className="font-color-accent-blue cursor-pointer"
                        onClick={() => toggleShowAllInstances(true)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleShowAllInstances(true); } }}
                    >
                        {t('Show all')}
                    </span>
                </div>
            )}

            {/* Footer: sync, made visible. The pass itself runs on every
                automatic trigger anyway; what this adds is a hand on the lever,
                an answer to "did it actually run?", and — after it — what it
                could not do: files still downloading, conflict copies, a
                missing folder, a failed write. A pass that could not reach the
                sync folder synced nothing, so it does not claim "last synced". */}
            {threadSyncEnabled && (
                <div className="thread-filter-footer-note">
                    <span
                        role="button"
                        tabIndex={0}
                        className="font-color-accent-blue cursor-pointer"
                        onClick={handleSyncNow}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSyncNow(); } }}
                    >
                        {t('Sync now')}
                    </span>
                    {(syncStatus.running || !syncHealth.folderMissing) && (
                        <>
                            {' · '}
                            {syncStatus.running
                                ? t('syncing…')
                                : syncStatus.lastAt
                                    ? t('last synced {time}', { time: formatTimeAgo(syncStatus.lastAt) })
                                    : t('not synced yet')}
                        </>
                    )}
                    {describeSyncHealth(syncHealth).length > 0 && (
                        <>
                            {' · '}
                            <span
                                className="font-color-red"
                                title={syncHealthHint(syncHealth, conversationSyncMode()) ?? undefined}
                            >
                                {describeSyncHealth(syncHealth).join(' · ')}
                            </span>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default ThreadListView;
