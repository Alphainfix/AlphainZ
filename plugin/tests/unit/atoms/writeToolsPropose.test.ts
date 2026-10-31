/**
 * A proposed write must not hold the model up.
 *
 * The first design waited for the answer inside the tool call, which made
 * every write a barrier. Colour-coding a paper wants 4-8 highlights, so that
 * turned one request into eight round trips, each needing a click before the
 * model could think about the next passage — and the model could see the
 * constraint, spending a whole turn reasoning about whether it had to
 * serialise before giving up and asking what to do.
 *
 * What has to stay true: the card still appears, nothing reaches the library
 * without a yes, and a yes still writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { writeTools } from '../../../react/atoms/executeLocalRun';
import {
    isLocalApprovalWaiting,
    resolveAllLocalApprovals,
    resolveLocalApproval,
} from '../../../react/utils/localApprovals';
import { indexItemAttachmentsAtom } from '../../../react/atoms/fulltextIndex';

const PAGE_TEXT = 'The waggle dance tells nestmates how far away the food source lies.';

/** A provider whose document has one page carrying `PAGE_TEXT`. */
function makeProvider(execute: (payload: any) => any) {
    return {
        zotero_document_request: {
            handle: async () => ({
                result: {
                    document: {
                        pages: [
                            {
                                index: 0,
                                label: '1',
                                items: [
                                    { sentences: [{ text: PAGE_TEXT, bboxes: [[10, 20, 300, 32]] }] },
                                ],
                            },
                        ],
                    },
                },
            }),
        },
        agent_action_execute: { handle: async (payload: any) => execute(payload) },
    };
}

beforeEach(() => {
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    // A highlight lands on a file, so the tool resolves its id to an
    // attachment before proposing. Stub the lookup as one.
    (Zotero as any).Libraries = {
        ...((Zotero as any).Libraries ?? {}),
        userLibraryID: 1,
    };
    (Zotero as any).Items = {
        ...((Zotero as any).Items ?? {}),
        getByLibraryAndKeyAsync: async (libraryID: number, key: string) => ({
            libraryID,
            key,
            isAttachment: () => true,
            isPDFAttachment: () => true,
        }),
    };
    resolveAllLocalApprovals('test reset');
});

describe('write tools propose rather than block', () => {
    it('returns before the user has answered, and says nothing was written', async () => {
        const executed: any[] = [];
        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;

        const tools = writeTools(makeProvider((p) => { executed.push(p); return { success: true }; }), set);

        const result: any = await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT, color: 'yellow' },
            { toolCallId: 'call-1' },
        );

        // The call is back with nobody having clicked anything.
        // The status is a sentence now, not a flag: a boolean beside a dozen
        // other result fields is easy for a model to skim past, and one did —
        // it wrote "both are done" over two proposals.
        expect(result.status).toMatch(/^PROPOSED — nothing has been written yet/);
        expect(result.created).toBeUndefined();
        expect(executed).toHaveLength(0);

        // …and the card is in front of the user, tied to the call that made it.
        expect(cards).toHaveLength(1);
        expect(cards[0].action_type).toBe('create_highlight_annotations');
        expect(cards[0].toolcall_id).toBe('call-1');
        expect(cards[0].action_data.items[0].color).toBe('yellow');
    });

    it('lets several proposals stack up without waiting on each other', async () => {
        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;
        const tools = writeTools(makeProvider(() => ({ success: true })), set);

        for (const color of ['yellow', 'green', 'blue', 'purple']) {
            await tools.create_highlight(
                { attachment_id: 'u-ABCD1234', text: PAGE_TEXT, color },
                { toolCallId: `call-${color}` },
            );
        }

        expect(cards.map((c) => c.action_data.items[0].color))
            .toEqual(['yellow', 'green', 'blue', 'purple']);
    });

    it('writes once the user approves, after the call has already returned', async () => {
        const executed: any[] = [];
        let cardId = '';
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cardId = payload.action_id;
        }) as any;
        const tools = writeTools(makeProvider((p) => { executed.push(p); return { success: true }; }), set);

        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );
        expect(executed).toHaveLength(0);

        resolveLocalApproval(cardId, true);
        await vi.waitFor(() => expect(executed).toHaveLength(1));
        expect(executed[0].action_type).toBe('create_highlight_annotations');
    });

    it('writes nothing when the user declines', async () => {
        const executed: any[] = [];
        let cardId = '';
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cardId = payload.action_id;
        }) as any;
        const tools = writeTools(makeProvider((p) => { executed.push(p); return { success: true }; }), set);

        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );
        resolveLocalApproval(cardId, false);
        await new Promise((r) => setTimeout(r, 10));
        expect(executed).toHaveLength(0);
    });

    it('proposes each found paper as its own card under one decision', async () => {
        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'Honeybee navigation', year: 2017, authors: [{ name: 'Valcourt' }],
                     venue: 'Annu. Rev. Entomol.', doi: '10.1000/x', openAccessUrl: 'http://x/p.pdf', citedByCount: 1, referencedWorkCount: 1 }],
            ['W2', { id: 'W2', title: 'Odometry in honeybees', year: 2014, authors: [{ name: 'Rehberg' }],
                     citedByCount: 1, referencedWorkCount: 1 }],
        ]);
        const tools = writeTools(makeProvider(() => ({ success: true })), set, found);

        const out: any = await tools.add_papers_to_library(
            { openalex_ids: ['W1', 'W2'], reason: 'Both are standard reviews.' },
            { toolCallId: 'call-1' },
        );

        expect(out.status).toMatch(/^PROPOSED — nothing has been written yet/);
        expect(cards).toHaveLength(2);
        // One tool call id across both, so the card reads as a single decision.
        expect(cards.every((c) => c.toolcall_id === 'call-1')).toBe(true);
        expect(cards.map((c) => c.action_type)).toEqual(['create_item', 'create_item']);

        const first = cards[0].action_data;
        expect(first.item.title).toBe('Honeybee navigation');
        expect(first.item.authors).toEqual(['Valcourt']);
        // Lowercase `doi`: that is what the create path reads, and a DOI there
        // routes the import through Zotero's own translator, so the item
        // arrives with the journal, volume and pages OpenAlex does not carry.
        // Spelled `DOI` it was silently ignored and items landed bare.
        expect(first.item.identifiers).toEqual({ doi: '10.1000/x' });
        expect(first.reason).toBe('Both are standard reviews.');
        // A PDF is only claimed where the search actually offered one.
        expect(first.file_available).toBe(true);
        expect(cards[1].action_data.file_available).toBe(false);
    });

    it('refuses an id no search returned, so an invented paper cannot get in', async () => {
        const set = vi.fn() as any;
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'Real paper', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const tools = writeTools(makeProvider(() => ({ success: true })), set, found);

        await expect(
            tools.add_papers_to_library({ openalex_ids: ['W1', 'W999'] }, { toolCallId: 'c' }),
        ).rejects.toThrow(/W999/);
    });

    it('claims nothing about where the paper already sits in the library', async () => {
        // `library_items` says where a copy already exists, which only a library
        // search can answer — asserting it from OpenAlex would be a guess.
        const cards: any[] = [];
        const set = vi.fn((_a: unknown, p: any) => {
            if (p?.event === 'deferred_approval_request') cards.push(p);
        }) as any;
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'T', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const tools = writeTools(makeProvider(() => ({ success: true })), set, found);
        await tools.add_papers_to_library({ openalex_ids: ['W1'] }, { toolCallId: 'c' });
        expect(cards[0].action_data.item.library_items).toEqual([]);
    });

    it('refuses a colour outside the palette instead of quietly using the default', async () => {
        // Falling back to blue would turn a four-colour pass into one flat
        // colour with nothing to tell the model it had failed.
        const set = vi.fn() as any;
        const tools = writeTools(makeProvider(() => ({ success: true })), set);
        await expect(
            tools.create_highlight(
                { attachment_id: 'u-ABCD1234', text: PAGE_TEXT, color: 'chartreuse' },
                { toolCallId: 'call-1' },
            ),
        ).rejects.toThrow(/not a Zotero palette colour/);
    });
});

describe('a proposal outlives the answer', () => {
    it('is still waiting after the run that made it has finished', async () => {
        // The regression this guards: approvals were cleared when a run
        // completed, and clearing declines them. That was correct while a write
        // suspended the tool call — an approval still outstanding then meant
        // something had gone wrong. Once proposals stopped blocking, it
        // declined every highlight and every paper the instant the answer
        // finished: on a short run the card never appeared at all.
        const executed: any[] = [];
        let cardId = '';
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cardId = payload.action_id;
        }) as any;
        const tools = writeTools(makeProvider((p) => { executed.push(p); return { success: true }; }), set);

        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );

        // The answer is written and the run settles; nobody has clicked yet.
        await new Promise((r) => setTimeout(r, 20));
        expect(executed).toHaveLength(0);

        // The decision is still live and still honoured.
        expect(resolveLocalApproval(cardId, true)).toBe(true);
        await vi.waitFor(() => expect(executed).toHaveLength(1));
    });
});

describe('an added paper becomes searchable on its own', () => {
    /** Approve the one card that was registered, and let the detached task run. */
    async function approveAndSettle(cardId: string) {
        resolveLocalApproval(cardId, true);
        await new Promise((r) => setTimeout(r, 20));
    }

    it('indexes the new item, so it is not missing from search until settings is opened', async () => {
        // Indexing only ever ran from the settings panel, so a paper the user
        // had just asked for came back missing from every full-text search
        // with nothing to say why.
        let cardId = '';
        const setCalls: Array<[unknown, unknown]> = [];
        const set = vi.fn((atom: unknown, payload: any) => {
            setCalls.push([atom, payload]);
            if (payload?.event === 'deferred_approval_request') cardId = payload.action_id;
        }) as any;

        const provider = {
            agent_action_execute: {
                handle: async () => ({
                    success: true,
                    result_data: { library_id: 1, zotero_key: 'NEWKEY01' },
                }),
            },
        };
        const tools = writeTools(provider as any, set, new Map([
            ['W1', { id: 'W1', title: 'T', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]));

        await tools.add_papers_to_library({ openalex_ids: ['W1'] }, { toolCallId: 'c' });
        await approveAndSettle(cardId);

        const indexCall = setCalls.find(([atom]) => atom === indexItemAttachmentsAtom);
        expect(indexCall).toBeDefined();
        expect(indexCall![1]).toEqual({ libraryId: 1, zoteroKey: 'NEWKEY01' });
    });

    it('does not index when the write was refused', async () => {
        let cardId = '';
        const setCalls: Array<[unknown, unknown]> = [];
        const set = vi.fn((atom: unknown, payload: any) => {
            setCalls.push([atom, payload]);
            if (payload?.event === 'deferred_approval_request') cardId = payload.action_id;
        }) as any;
        const provider = {
            agent_action_execute: {
                handle: async () => ({ success: false, error: 'nope' }),
            },
        };
        const tools = writeTools(provider as any, set, new Map([
            ['W1', { id: 'W1', title: 'T', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]));

        await tools.add_papers_to_library({ openalex_ids: ['W1'] }, { toolCallId: 'c' });
        await approveAndSettle(cardId);

        expect(setCalls.find(([atom]) => atom === indexItemAttachmentsAtom)).toBeUndefined();
    });

    it('does not index a highlight, which adds no searchable text', async () => {
        let cardId = '';
        const setCalls: Array<[unknown, unknown]> = [];
        const set = vi.fn((atom: unknown, payload: any) => {
            setCalls.push([atom, payload]);
            if (payload?.event === 'deferred_approval_request') cardId = payload.action_id;
        }) as any;
        const tools = writeTools(makeProvider(() => ({ success: true })), set);

        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'c' },
        );
        await approveAndSettle(cardId);

        expect(setCalls.find(([atom]) => atom === indexItemAttachmentsAtom)).toBeUndefined();
    });
});

/**
 * The card has to survive its own tool return.
 *
 * `onToolReturn` drops any approval tied to the call that just returned — a
 * safety net from the blocking design, where a return meant the user had
 * already answered. Non-blocking proposals return immediately, so that net
 * caught every live proposal: the card was deleted microseconds after being
 * registered, the promise behind it went unanswered, and nothing the agent
 * proposed could ever be approved.
 */
describe('a proposal outlives the call that made it', () => {
    it('is still waiting after its tool call has returned', async () => {
        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;

        const tools = writeTools(makeProvider(() => ({ success: true })), set);
        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );

        // The tool has returned. The decision has not been made.
        expect(cards).toHaveLength(1);
        expect(isLocalApprovalWaiting(cards[0].action_id)).toBe(true);
    });

    it('stops being waiting once answered', async () => {
        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;
        const tools = writeTools(makeProvider(() => ({ success: true })), set);
        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-2' },
        );
        resolveLocalApproval(cards[0].action_id, true);
        expect(isLocalApprovalWaiting(cards[0].action_id)).toBe(false);
    });
});

/**
 * A proposed highlight has to be reachable from the answer.
 *
 * Without this the answer described the passage and named the page in prose —
 * "the sentence in §II.B (p. 4)" — and there was nothing to click, so the
 * reader had to go and find it again. Which is the work the highlight existed
 * to save.
 */
describe('a proposed highlight comes back citable', () => {
    it('hands back a citation tag for the page the passage was found on', async () => {
        const set = vi.fn() as any;
        const tools = writeTools(makeProvider(() => ({ success: true })), set);
        const result: any = await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );
        // The page comes from where the text was actually located, not from
        // whatever the model passed in.
        expect(result.page).toBe(1);
        expect(result.citation).toBe('<citation id="u-ABCD1234" page="1"/>');
        expect(result.note).toMatch(/citation/);
    });
});

/**
 * A highlight has to be proposed against the file it will live on.
 *
 * The model is handed whatever id a search returned, and for an attached paper
 * that is the item, not its PDF. The geometry lookup accepted it — document
 * extraction resolves an item to its PDF by itself — so the card was built
 * against the parent and looked perfectly normal. The write then failed at the
 * far end with "Resolved item is not a local PDF or EPUB attachment", *after*
 * the user had clicked Apply.
 */
describe('a highlight is proposed against an attachment', () => {
    const asItem = (overrides: Record<string, unknown>) => ({
        libraryID: 1,
        isAttachment: () => false,
        isRegularItem: () => true,
        ...overrides,
    });

    it('resolves a parent item to its PDF before building the card', async () => {
        (Zotero as any).Items.getByLibraryAndKeyAsync = async (_lib: number, key: string) =>
            asItem({ key, getAttachments: () => [10] });
        (Zotero as any).Items.loadDataTypes = async () => {};
        (Zotero as any).Items.getAsync = async () => [
            {
                libraryID: 1,
                key: 'PDFKEY01',
                deleted: false,
                isAttachment: () => true,
                isPDFAttachment: () => true,
                attachmentContentType: 'application/pdf',
            },
        ];

        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;
        const tools = writeTools(makeProvider(() => ({ success: true })), set);
        await tools.create_highlight(
            { attachment_id: 'u-PARENT01', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );

        expect(cards).toHaveLength(1);
        // Not the id the model passed: the file under it.
        expect(cards[0].action_data.resolved_ref.zotero_key).toBe('PDFKEY01');
        expect(cards[0].action_data.requested_ref.zotero_key).toBe('PDFKEY01');
    });

    it('fails at propose time when there is no file to highlight', async () => {
        // Better here, where the model can still act on it, than after the user
        // has approved a card that could never work.
        (Zotero as any).Items.getByLibraryAndKeyAsync = async (_lib: number, key: string) =>
            asItem({ key, getAttachments: () => [] });
        (Zotero as any).Items.loadDataTypes = async () => {};
        (Zotero as any).Items.getAsync = async () => [];

        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;
        const tools = writeTools(makeProvider(() => ({ success: true })), set);
        await expect(
            tools.create_highlight(
                { attachment_id: 'u-NOFILE01', text: PAGE_TEXT },
                { toolCallId: 'call-1' },
            ),
        ).rejects.toThrow(/no PDF attachment/);
        expect(cards).toHaveLength(0);
    });
});

/**
 * The user's standing answer, honoured.
 *
 * Settings → Permissions offers "Always ask" / "Always apply" / "Continue
 * without applying" per kind of change, and note creation ships set to always
 * apply. Nothing local read it: every write raised a card regardless. Worst on
 * "always apply", where the user has said not to be asked and was asked
 * anyway — a control that did nothing.
 */
describe('standing approval preferences', () => {
    async function withPreference(group: string, preference: string) {
        const { store } = await import('../../../react/store');
        const { deferredToolPreferencesAtom } = await import(
            '../../../react/atoms/deferredToolPreferences'
        );
        const current: any = store.get(deferredToolPreferencesAtom as any);
        store.set(deferredToolPreferencesAtom as any, {
            ...current,
            groupPreferences: { ...current.groupPreferences, [group]: preference },
        } as any);
        return () =>
            store.set(deferredToolPreferencesAtom as any, current);
    }

    it('writes straight away when the user said always apply', async () => {
        const restore = await withPreference('annotations', 'always_apply');
        try {
            const executed: any[] = [];
            const cards: any[] = [];
            const set = vi.fn((_atom: unknown, payload: any) => {
                if (payload?.event === 'deferred_approval_request') cards.push(payload);
            }) as any;
            const tools = writeTools(
                makeProvider((p) => { executed.push(p); return { success: true }; }),
                set,
            );
            await tools.create_highlight(
                { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
                { toolCallId: 'call-1' },
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(cards).toHaveLength(0);
            expect(executed).toHaveLength(1);
        } finally {
            restore();
        }
    });

    it('does neither when the user said continue without applying', async () => {
        const restore = await withPreference('annotations', 'continue_without_applying');
        try {
            const executed: any[] = [];
            const cards: any[] = [];
            const set = vi.fn((_atom: unknown, payload: any) => {
                if (payload?.event === 'deferred_approval_request') cards.push(payload);
            }) as any;
            const tools = writeTools(
                makeProvider((p) => { executed.push(p); return { success: true }; }),
                set,
            );
            await tools.create_highlight(
                { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
                { toolCallId: 'call-1' },
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(cards).toHaveLength(0);
            expect(executed).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('asks for a paper even when the stored preference says always apply', async () => {
        // A preference saved by a build that still offered the choice. Adding a
        // paper is not something the user can be spared the sight of.
        const restore = await withPreference('create_items', 'always_apply');
        try {
            const executed: any[] = [];
            const cards: any[] = [];
            const set = vi.fn((_atom: unknown, payload: any) => {
                if (payload?.event === 'deferred_approval_request') cards.push(payload);
            }) as any;
            const found = new Map<string, any>([
                ['W1', { id: 'W1', title: 'Honeybee navigation', year: 2017, authors: [{ name: 'Valcourt' }],
                         citedByCount: 1, referencedWorkCount: 1 }],
            ]);
            const tools = writeTools(
                makeProvider((p) => { executed.push(p); return { success: true }; }),
                set,
                found,
            );
            const out: any = await tools.add_papers_to_library(
                { openalex_ids: ['W1'] },
                { toolCallId: 'call-1' },
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(cards).toHaveLength(1);
            expect(executed).toHaveLength(0);
            expect(out.status).toMatch(/^PROPOSED/);
        } finally {
            restore();
        }
    });

    it('still asks by default', async () => {
        const executed: any[] = [];
        const cards: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
        }) as any;
        const tools = writeTools(
            makeProvider((p) => { executed.push(p); return { success: true }; }),
            set,
        );
        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );
        expect(cards).toHaveLength(1);
        expect(executed).toHaveLength(0);
    });
});

/**
 * What was decided stays in the conversation.
 *
 * A card disappears once it is answered, and nothing replaced it — a run that
 * added six highlights left a thread with no sign of it beyond the model's own
 * prose, which is exactly the claim the user wanted to be able to check.
 */
describe('the decision leaves a record', () => {
    function harnessWithActions() {
        const cards: any[] = [];
        const recorded: any[] = [];
        const executed: any[] = [];
        const set = vi.fn((_atom: unknown, payload: any) => {
            if (payload?.event === 'deferred_approval_request') cards.push(payload);
            else if (Array.isArray(payload) && payload[0]?.action_type) {
                // One record per id: the decision supersedes the pending
                // record the card was raised with.
                for (const action of payload) {
                    const at = recorded.findIndex((existing) => existing.id === action.id);
                    if (at >= 0) recorded[at] = { ...recorded[at], ...action };
                    else recorded.push(action);
                }
            }
        }) as any;
        const tools = writeTools(
            makeProvider((p) => { executed.push(p); return { success: true, result_data: { ok: 1 } }; }),
            set,
        );
        return { tools, cards, recorded, executed };
    }

    it('records an applied action carrying what was written', async () => {
        const { tools, cards, recorded } = harnessWithActions();
        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );
        resolveLocalApproval(cards[0].action_id, true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe('applied');
        expect(recorded[0].action_type).toBe('create_highlight_annotations');
        expect(recorded[0].toolcall_id).toBe('call-1');
        // The preview renders from this, so it has to be the real payload.
        expect(recorded[0].proposed_data.items[0].text).toBe(PAGE_TEXT);
    });

    it('records a rejection too, rather than letting the card just vanish', async () => {
        const { tools, cards, recorded, executed } = harnessWithActions();
        await tools.create_highlight(
            { attachment_id: 'u-ABCD1234', text: PAGE_TEXT },
            { toolCallId: 'call-1' },
        );
        resolveLocalApproval(cards[0].action_id, false);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(executed).toHaveLength(0);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe('rejected');
    });
});

describe('add_papers_to_library destination', () => {
    it('files the proposal into the collection the model named', async () => {
        const cards: any[] = [];
        const set = vi.fn((_a: unknown, p: any) => {
            if (p?.event === 'deferred_approval_request') cards.push(p);
        }) as any;
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'T', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const tools = writeTools(makeProvider(() => ({ success: true })), set, found);
        const out: any = await tools.add_papers_to_library(
            { openalex_ids: ['W1'], collection_key: 'RLST8KEY' },
            { toolCallId: 'c' },
        );
        // The destination rides on the proposal itself: the run ends at the
        // approval, so there is no later step that could file the paper.
        expect(cards[0].action_data.collection_keys).toEqual(['RLST8KEY']);
        expect(out.collection_key).toBe('RLST8KEY');
        expect(out.note).toContain('collection you named');
    });

    it('rejects a collection name where a key is required', async () => {
        const set = vi.fn() as any;
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'T', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const tools = writeTools(makeProvider(() => ({ success: true })), set, found);
        await expect(
            tools.add_papers_to_library({ openalex_ids: ['W1'], collection_key: 'Batch7' }, { toolCallId: 'c' }),
        ).rejects.toThrow(/list_collections/);
    });

    it('leaves the destination to the card when no collection is named', async () => {
        const cards: any[] = [];
        const set = vi.fn((_a: unknown, p: any) => {
            if (p?.event === 'deferred_approval_request') cards.push(p);
        }) as any;
        const found = new Map<string, any>([
            ['W1', { id: 'W1', title: 'T', authors: [], citedByCount: 0, referencedWorkCount: 0 }],
        ]);
        const tools = writeTools(makeProvider(() => ({ success: true })), set, found);
        const out: any = await tools.add_papers_to_library({ openalex_ids: ['W1'] }, { toolCallId: 'c' });
        expect(cards[0].action_data.collection_keys).toBeUndefined();
        expect(out.note).toContain('do not promise to file them yourself');
    });
});
