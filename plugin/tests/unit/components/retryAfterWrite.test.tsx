// @vitest-environment jsdom
 
/**
 * Try Again on a change that was written.
 *
 * An action marked failed that still carries its result is a change that is
 * in the library. Retrying it means undoing it; applying it again would make
 * it a second time. The card reads that off the record, not off its own
 * memory of which button failed.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyApprovalRequest: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

async function mountFailed(resultData: Record<string, unknown> | undefined) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const agentActions = await import('../../../react/agents/agentActions');
    const { AgentActionView } = await import('../../../react/host/zotero/components/AgentActionView');
    const { toolExpandedAtom } = await import('../../../react/atoms/messageUIState');
    store.set(toolExpandedAtom as any, {});
    store.set(agentActions.pendingApprovalsAtom, new Map());
    store.set(agentActions.threadAgentActionsAtom, [{
        id: 'collection-1',
        run_id: 'run-1',
        toolcall_id: 'call-1',
        action_type: 'create_collection',
        status: 'error',
        error_message: 'Something went wrong',
        proposed_data: { name: 'Pollinators' },
        ...(resultData ? { result_data: resultData } : {}),
    } as any]);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, React.createElement(AgentActionView, {
            toolcallId: 'call-1',
            toolName: 'create_collection',
            runId: 'run-1',
            responseIndex: 0,
            pendingApproval: null,
            hasToolReturn: true,
            runStatus: 'completed',
        })));
    });
    // The failed record is folded to one line; open it.
    const fold = host.querySelector('button[data-settled-action="true"]') as HTMLButtonElement;
    await act(async () => { fold.click(); });
    return host;
}

const buttonTexts = () => Array.from(host!.querySelectorAll('button')).map((button) => button.textContent?.trim());

describe('a failed change', () => {
    it('offers to undo it when it is in the library', async () => {
        await mountFailed({ library_id: 1, collection_key: 'COLL0001' });
        expect(buttonTexts()).toContain('Retry Undo');
        expect(buttonTexts()).not.toContain('Try Again');
    });

    it('offers to apply it again when it never landed', async () => {
        await mountFailed(undefined);
        expect(buttonTexts()).toContain('Try Again');
    });
});
