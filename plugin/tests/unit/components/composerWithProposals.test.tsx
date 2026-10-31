// @vitest-environment jsdom
 
/**
 * The composer while proposed changes wait for a decision.
 *
 * A proposal does not hold its run, and it waits on its card for as long as
 * the user likes — in this chat or another. None of that may take the
 * composer away: the text box stays typeable, the model and attachments stay
 * reachable, Enter sends, and the main button is Stop during a run and Send
 * otherwise. It never turns into a Reject that throws the draft away.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/components/ui/buttons/ModelSelectionButton', () => ({
    default: (props: { disabled?: boolean }) => React.createElement('button', {
        'data-testid': 'model-picker',
        disabled: props.disabled ?? false,
    }, 'Model'),
}));
vi.mock('../../../react/components/messages/MessageAttachmentDisplay', () => ({
    default: (props: { disabled?: boolean }) => React.createElement('button', {
        'data-testid': 'add-sources',
        disabled: props.disabled ?? false,
    }, '+'),
}));
vi.mock('../../../react/components/input/RunUsageChip', () => ({ default: () => null }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    (Zotero as any).isMac = true;
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

async function mount(options: { draft?: string; running?: boolean; approvals: Array<[string, Record<string, unknown>]> }) {
    const { store } = await import('../../../react/store');
    const { Provider } = await import('jotai');
    const { pendingApprovalsAtom } = await import('../../../react/agents/agentActions');
    const { currentMessageContentAtom } = await import('../../../react/atoms/messageComposition');
    const { isWSChatPendingAtom } = await import('../../../react/atoms/agentRunAtoms');
    const { selectedModelAtom } = await import('../../../react/atoms/models');
    const { currentThreadIdAtom, threadRunsAtom } = await import('@beaver/agent-core/run-state/atoms');
    const { default: InputArea } = await import('../../../react/components/input/InputArea');

    store.set(pendingApprovalsAtom as any, new Map(options.approvals.map(([id, scope]) => [id, {
        actionId: id,
        toolcallId: `call-${id}`,
        actionType: 'create_highlight_annotations',
        actionData: {},
        ...scope,
    }])) as any);
    store.set(currentMessageContentAtom, options.draft ?? '');
    store.set(isWSChatPendingAtom, options.running ?? false);
    store.set(currentThreadIdAtom, null);
    store.set(threadRunsAtom, []);
    try {
        store.set(selectedModelAtom as any, { id: 'test-model', provider: 'test' } as any);
    } catch {
        // A derived model atom: a model is selected however the prefs say.
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const inputRef = React.createRef<HTMLElement>();
    await act(async () => {
        root!.render(React.createElement(Provider, { store }, React.createElement(InputArea, { inputRef })));
    });
    return { host, store };
}

const textarea = () => host!.querySelector('textarea') as HTMLTextAreaElement;
const mainButton = () => host!.querySelector('button[aria-label="Send message"], button[aria-label="Stop generating"], button[aria-label^="Reject"]') as HTMLButtonElement | null;

describe('the composer while proposals wait', () => {
    it('stays typeable in a new chat while another chat has undecided proposals', async () => {
        await mount({ approvals: [['a', { runId: 'run-old', threadId: 'thread-old', threadName: 'Bee paper' }]] });

        expect(textarea().disabled).toBe(false);
        expect(host!.querySelector('[data-testid="model-picker"]')!.hasAttribute('disabled')).toBe(false);
        expect(host!.querySelector('[data-testid="add-sources"]')!.hasAttribute('disabled')).toBe(false);
        // The placeholder the box carries, and the overlay that draws it.
        expect(textarea().getAttribute('aria-placeholder')).toMatch(/^@ to add a source/);
        expect(host!.textContent).not.toContain('Add instructions to reject');
    });

    it('keeps the ordinary placeholder next to this chat’s own proposals', async () => {
        await mount({ approvals: [['a', {}]] });

        expect(textarea().getAttribute('aria-placeholder')).toMatch(/^@ to add a source/);
        expect(textarea().getAttribute('aria-placeholder')).not.toMatch(/reject/i);
    });

    it('stays typeable next to this chat’s own proposals too', async () => {
        await mount({ draft: 'Also, what limits T1 here?', approvals: [['a', {}], ['b', {}]] });

        expect(textarea().disabled).toBe(false);
        expect(textarea().value).toBe('Also, what limits T1 here?');
        // The draft is a message, not rejection instructions.
        expect(mainButton()?.getAttribute('aria-label')).toBe('Send message');
        const composerButtons = Array.from(host!.querySelectorAll('.composer-controls button'))
            .map((button) => button.textContent?.trim());
        expect(composerButtons).not.toContain('Reject');
        expect(composerButtons).not.toContain('Reject All');
    });

    it('keeps Stop during a run, whatever is typed and whatever is waiting', async () => {
        await mount({ draft: 'a follow-up', running: true, approvals: [['a', {}]] });

        const button = mainButton()!;
        expect(button.getAttribute('aria-label')).toBe('Stop generating');
        expect(button.textContent).toBe('Stop');
        expect(button.disabled).toBe(false);
    });
});
