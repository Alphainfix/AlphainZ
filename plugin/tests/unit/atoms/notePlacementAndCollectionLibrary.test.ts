/**
 * Where the agent's new notes and collections land.
 *
 * A note written for a paper belongs under that paper, and a collection made
 * for group-library papers belongs in that group library. In both cases the
 * place follows from the ids the model passed; nothing else says where the
 * user expects to find the result.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { writeTools } from '../../../react/atoms/executeLocalRun';
import { WRITE_TOOL_SCHEMAS } from '../../../src/services/llm/writeTools';
import { resolveAllLocalApprovals } from '../../../react/utils/localApprovals';
import { store } from '../../../react/store';
import { localZoteroLibrariesAtom } from '../../../react/atoms/profile';

const GROUP_ID = 42;
const GROUP_LIBRARY_ID = 5;

function harness() {
    const cards: any[] = [];
    const set = vi.fn((_atom: unknown, payload: any) => {
        if (payload?.event === 'deferred_approval_request') cards.push(payload);
    }) as any;
    const tools = writeTools(
        { agent_action_execute: { handle: async () => ({ success: true }) } },
        set,
    );
    return { tools, cards };
}

beforeEach(() => {
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    (Zotero as any).Libraries = { ...((Zotero as any).Libraries ?? {}), userLibraryID: 1 };
    (Zotero as any).Groups = {
        getLibraryIDFromGroupID: (groupID: number) => (groupID === GROUP_ID ? GROUP_LIBRARY_ID : false),
        getGroupIDFromLibraryID: (libraryID: number) => (libraryID === GROUP_LIBRARY_ID ? GROUP_ID : false),
    };
    // One collection, in the group library.
    (Zotero as any).Collections = {
        getByLibraryAndKey: (libraryID: number, key: string) =>
            libraryID === GROUP_LIBRARY_ID && key === 'BEEHIVE1' ? { key } : false,
    };
    store.set(localZoteroLibrariesAtom, [
        { library_id: 1, is_group: false, name: 'My Library' },
        { library_id: GROUP_LIBRARY_ID, is_group: true, group_id: GROUP_ID, name: 'Lab' },
    ] as any);
    resolveAllLocalApprovals('test reset');
});

describe('create_note', () => {
    it('files the note under the item it was written for', async () => {
        const { tools, cards } = harness();
        await tools.create_note(
            { item_id: 'g42-PAPER001', title: 'Summary', content: 'The paper shows a thing.' },
            { toolCallId: 'call-1' },
        );
        expect(cards).toHaveLength(1);
        // What the validator and both executors read to place a note.
        expect(cards[0].action_data).toEqual({
            parent_item_id: 'g42-PAPER001',
            library_ref: 'g42',
            title: 'Summary',
            content: 'The paper shows a thing.',
        });
    });

    it('titles an untitled note by its opening heading, without repeating it', async () => {
        const { tools, cards } = harness();
        await tools.create_note(
            { item_id: 'u-PAPER001', content: '# Honeybee odometry\n\nThe paper shows a thing.' },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.title).toBe('Honeybee odometry');
        expect(cards[0].action_data.content).toBe('The paper shows a thing.');
    });

    it('reads an HTML heading the same way', async () => {
        const { tools, cards } = harness();
        await tools.create_note(
            { item_id: 'u-PAPER001', content: '<h2>Key <b>points</b></h2><p>One.</p>' },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.title).toBe('Key points');
        expect(cards[0].action_data.content).toBe('<p>One.</p>');
    });

    it('calls a note with no heading "Note" rather than refusing it', async () => {
        const { tools, cards } = harness();
        await tools.create_note(
            { item_id: 'u-PAPER001', content: 'The paper shows a thing.' },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.title).toBe('Note');
        expect(cards[0].action_data.content).toBe('The paper shows a thing.');
    });

    it('keeps a heading that is the whole note as its body too', async () => {
        const { tools, cards } = harness();
        await tools.create_note(
            { item_id: 'u-PAPER001', content: '# Read this again' },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.title).toBe('Read this again');
        expect(cards[0].action_data.content).toBe('# Read this again');
    });

    it('takes no title from a heading further down, and the tool tells the model so', async () => {
        const { tools, cards } = harness();
        const content = 'The paper shows a thing.\n\n## Methods\n\nA tunnel test.';
        await tools.create_note({ item_id: 'u-PAPER001', content }, { toolCallId: 'call-1' });

        // A section heading is not the note's name.
        expect(cards[0].action_data.title).toBe('Note');
        expect(cards[0].action_data.content).toBe(content);

        const schema = WRITE_TOOL_SCHEMAS.find((tool) => tool.name === 'create_note')!;
        const title = (schema.parameters as any).properties.title.description as string;
        expect(title).toMatch(/opens with a heading/);
        expect(title).toMatch(/"Note"/);
    });
});

describe('create_collection', () => {
    it('creates the collection in the library its items are in', async () => {
        const { tools, cards } = harness();
        await tools.create_collection(
            { name: 'Pollinators', item_ids: ['g42-AAAA1111', 'g42-BBBB2222'] },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.library_ref).toBe('g42');
        expect(cards[0].action_data.item_ids).toEqual(['g42-AAAA1111', 'g42-BBBB2222']);
    });

    it('nests under a parent found in a group library by its bare key', async () => {
        const { tools, cards } = harness();
        await tools.create_collection(
            { name: 'Foraging trips', parent_key: 'BEEHIVE1' },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.library_ref).toBe('g42');
        expect(cards[0].action_data.parent_key).toBe('BEEHIVE1');
    });

    it('reads the library off a prefixed parent key', async () => {
        const { tools, cards } = harness();
        await tools.create_collection(
            { name: 'Foraging trips', parent_key: 'g42-BEEHIVE1' },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.library_ref).toBe('g42');
        expect(cards[0].action_data.parent_key).toBe('BEEHIVE1');
    });

    it('refuses items from two libraries, before anyone is asked', async () => {
        const { tools, cards } = harness();
        await expect(
            tools.create_collection(
                { name: 'Mixed', item_ids: ['u-AAAA1111', 'g42-BBBB2222'] },
                { toolCallId: 'call-1' },
            ),
        ).rejects.toThrow(/different libraries/);
        expect(cards).toHaveLength(0);
    });

    it('refuses a parent in a different library from the items', async () => {
        const { tools, cards } = harness();
        await expect(
            tools.create_collection(
                { name: 'Sub', parent_key: 'BEEHIVE1', item_ids: ['u-AAAA1111'] },
                { toolCallId: 'call-1' },
            ),
        ).rejects.toThrow(/different libraries/);
        expect(cards).toHaveLength(0);
    });

    it('uses My Library when nothing says otherwise', async () => {
        const { tools, cards } = harness();
        await tools.create_collection({ name: 'Reading list' }, { toolCallId: 'call-1' });
        expect(cards[0].action_data.library_ref).toBe('u');
    });
});
