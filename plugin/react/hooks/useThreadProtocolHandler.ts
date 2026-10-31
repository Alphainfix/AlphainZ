/**
 * Hook that listens for "loadThread" events dispatched by the zotero://alphainz
 * protocol handler and loads the requested thread in the sidebar.
 */

import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { LOCAL_USER_ID, userAtom } from '../atoms/auth';
import { isLocalBrain } from '../../src/services/llm/agentConfig';
import { currentThreadIdAtom, loadThreadAtom, pendingScrollToRunAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { logger } from '@beaver/agent-core/platform/logger';

interface PendingProtocolTarget {
    threadId: string;
    runId?: string;
}

export function useThreadProtocolHandler() {
    const user = useAtomValue(userAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const setPendingScrollToRun = useSetAtom(pendingScrollToRunAtom);
    const pendingTargetRef = useRef<PendingProtocolTarget | null>(null);

    const loadTargetThread = (threadId: string, userId: string, runId?: string) => {
        // If the thread is already open, skip reloading — just scroll to the run if requested.
        if (threadId === currentThreadId) {
            logger(`useThreadProtocolHandler: Thread ${threadId} already open, skipping reload${runId ? ` — scrolling to run ${runId}` : ''}`);
            setPendingScrollToRun(runId ?? null);
            return;
        }

        logger(`useThreadProtocolHandler: Loading thread ${threadId}${runId ? ` / run ${runId}` : ''}`);

        // Set/clear scroll target before loading so ThreadView picks up only the current protocol target.
        setPendingScrollToRun(runId ?? null);

        // Load the thread
        loadThread({ user_id: userId, threadId });
    };

    useEventSubscription('loadThread', (detail) => {
        const { threadId, runId } = detail;

        // Always open the panel, even when there is no account.
        eventManager.dispatch('toggleChat', { forceOpen: true });

        /*
         * Running locally there is no account to wait for.
         *
         * Deferring until a user appeared was right for the hosted build, and
         * silently permanent here: a note's own footer links back to the
         * conversation that wrote it, and clicking it opened the panel on
         * whatever was already there. The conversation never loaded, and
         * nothing said why.
         */
        const ownerId = user?.id ?? (isLocalBrain() ? LOCAL_USER_ID : null);
        if (!ownerId) {
            pendingTargetRef.current = { threadId, runId };
            logger('useThreadProtocolHandler: no owner yet, opening sidebar and deferring thread load');
            return;
        }

        loadTargetThread(threadId, ownerId, runId);
    }, [user, currentThreadId, loadThread, setPendingScrollToRun]);

    useEffect(() => {
        const ownerId = user?.id ?? (isLocalBrain() ? LOCAL_USER_ID : null);
        if (!ownerId || !pendingTargetRef.current) return;

        const { threadId, runId } = pendingTargetRef.current;
        pendingTargetRef.current = null;
        logger(`useThreadProtocolHandler: Resuming deferred thread load ${threadId}${runId ? ` / run ${runId}` : ''}`);
        loadTargetThread(threadId, ownerId, runId);
    }, [user, currentThreadId, loadThread, setPendingScrollToRun]);
}
