/**
 * Filing: the tools the Organize actions had no way to call.
 *
 * Every executor for this — `organize_items`, `create_collection`, their
 * validators, their approval cards — has been in the tree since Beaver, driven
 * by the server. Locally nothing declared them as tools, so the whole Organize
 * category had nothing to call: the model would lay out the tidy-up it was
 * going to do and then do none of it, which reads exactly like success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { writeTools } from '../../../react/atoms/executeLocalRun';
import { resolveAllLocalApprovals, resolveLocalApproval } from '../../../react/utils/localApprovals';

function makeProvider(execute: (payload: any) => any) {
    return { agent_action_execute: { handle: async (payload: any) => execute(payload) } };
}

function harness(execute: (payload: any) => any = () => ({ success: true })) {
    const executed: any[] = [];
    const cards: any[] = [];
    const set = vi.fn((_atom: unknown, payload: any) => {
        if (payload?.event === 'deferred_approval_request') cards.push(payload);
    }) as any;
    const tools = writeTools(
        makeProvider((p) => {
            executed.push(p);
            return execute(p);
        }),
        set,
    );
    return { tools, cards, executed };
}

beforeEach(() => {
    (Zotero as any).AlphainZ = { data: { env: 'test' } };
    resolveAllLocalApprovals('test reset');
});

describe('organize_items', () => {
    it('proposes a tag change without writing it', async () => {
        const { tools, cards, executed } = harness();
        const result: any = await tools.organize_items(
            { item_ids: ['u-AAAA1111', 'u-BBBB2222'], add_tags: ['honeybee'] },
            { toolCallId: 'call-1' },
        );

        // The status is a sentence now, not a flag: a boolean beside a dozen
        // other result fields is easy for a model to skim past, and one did —
        // it wrote "both are done" over two proposals.
        expect(result.status).toMatch(/^PROPOSED — nothing has been written yet/);
        expect(executed).toHaveLength(0);
        expect(cards).toHaveLength(1);
        expect(cards[0].action_type).toBe('organize_items');
        expect(cards[0].toolcall_id).toBe('call-1');
        expect(cards[0].action_data).toEqual({
            item_ids: ['u-AAAA1111', 'u-BBBB2222'],
            tags: { add: ['honeybee'] },
        });
    });

    it('writes once approved', async () => {
        const { tools, cards, executed } = harness();
        await tools.organize_items(
            { item_ids: ['u-AAAA1111'], add_to_collections: ['ABCD1234'] },
            { toolCallId: 'call-1' },
        );
        resolveLocalApproval(cards[0].action_id, true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(executed).toHaveLength(1);
        expect(executed[0].action_type).toBe('organize_items');
        expect(executed[0].action_data.collections).toEqual({ add: ['ABCD1234'] });
    });

    it('writes nothing when declined', async () => {
        const { tools, cards, executed } = harness();
        await tools.organize_items(
            { item_ids: ['u-AAAA1111'], add_tags: ['x'] },
            { toolCallId: 'call-1' },
        );
        resolveLocalApproval(cards[0].action_id, false);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(executed).toHaveLength(0);
    });

    it('refuses a collection name where a key belongs', async () => {
        // The executor rejects it too, but by then the user has been shown a
        // card describing a change that cannot happen.
        const { tools, cards } = harness();
        await expect(
            tools.organize_items(
                { item_ids: ['u-AAAA1111'], add_to_collections: ['Bee Papers'] },
                { toolCallId: 'call-1' },
            ),
        ).rejects.toThrow(/list_collections/);
        expect(cards).toHaveLength(0);
    });

    it('refuses a call that would change nothing', async () => {
        const { tools } = harness();
        await expect(
            tools.organize_items({ item_ids: ['u-AAAA1111'] }, { toolCallId: 'call-1' }),
        ).rejects.toThrow(/at least one of add_tags/);
    });

    it('refuses a malformed item id instead of proposing against it', async () => {
        const { tools } = harness();
        await expect(
            tools.organize_items(
                { item_ids: ['AAAA1111'], add_tags: ['x'] },
                { toolCallId: 'call-1' },
            ),
        ).rejects.toThrow(/not valid item ids/i);
    });

    it('tells the model to batch rather than truncating silently', async () => {
        // A silent cap would file the first hundred and report success for all
        // of them.
        const { tools } = harness();
        const ids = Array.from({ length: 101 }, (_, i) => `u-K${String(i).padStart(7, '0')}`);
        await expect(
            tools.organize_items({ item_ids: ids, add_tags: ['x'] }, { toolCallId: 'call-1' }),
        ).rejects.toThrow(/batches of 100/);
    });
});

describe('create_collection', () => {
    it('proposes the collection and its contents as one decision', async () => {
        // Two steps cannot work: the key does not exist until the user
        // approves, so the model could never learn it in order to file into it.
        const { tools, cards } = harness();
        const result: any = await tools.create_collection(
            { name: 'Waggle dances', item_ids: ['u-AAAA1111', 'u-BBBB2222'] },
            { toolCallId: 'call-1' },
        );
        // The status is a sentence now, not a flag: a boolean beside a dozen
        // other result fields is easy for a model to skim past, and one did —
        // it wrote "both are done" over two proposals.
        expect(result.status).toMatch(/^PROPOSED — nothing has been written yet/);
        expect(cards).toHaveLength(1);
        expect(cards[0].action_type).toBe('create_collection');
        expect(cards[0].action_data.name).toBe('Waggle dances');
        expect(cards[0].action_data.item_ids).toEqual(['u-AAAA1111', 'u-BBBB2222']);
    });

    it('refuses a parent that is not a collection key', async () => {
        const { tools } = harness();
        await expect(
            tools.create_collection(
                { name: 'Sub', parent_key: 'My Papers' },
                { toolCallId: 'call-1' },
            ),
        ).rejects.toThrow(/list_collections/);
    });

    it('requires a name', async () => {
        const { tools } = harness();
        await expect(
            tools.create_collection({ item_ids: ['u-AAAA1111'] }, { toolCallId: 'call-1' }),
        ).rejects.toThrow(/name is required/);
    });
});

/**
 * Collection keys, whether or not the model prefixes them.
 *
 * Item ids are `u-KEY` and collection keys are bare; a model reads both as "an
 * id in this library". Nesting three sub-collections, it passed `u-8YEHB3J9`
 * for all three, was told the rule, and got it right next turn — three calls
 * and a round trip to learn something the tool can just accept. The prefix
 * carries nothing: a collection key is already scoped to its library.
 */
describe('collection keys tolerate the item-id prefix', () => {
    it('accepts a prefixed parent key', async () => {
        const { tools, cards } = harness();
        await tools.create_collection(
            { name: 'Sub', parent_key: 'u-8YEHB3J9' },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.parent_key).toBe('8YEHB3J9');
    });

    it('accepts prefixed collection keys when filing', async () => {
        const { tools, cards } = harness();
        await tools.organize_items(
            { item_ids: ['u-AAAA1111'], add_to_collections: ['u-ABCD1234', 'WXYZ5678'] },
            { toolCallId: 'call-1' },
        );
        expect(cards[0].action_data.collections.add).toEqual(['ABCD1234', 'WXYZ5678']);
    });

    it('still refuses something that is not a key at all', async () => {
        const { tools } = harness();
        await expect(
            tools.create_collection({ name: 'Sub', parent_key: 'My Papers' }, { toolCallId: 'c' }),
        ).rejects.toThrow(/list_collections/);
    });
});
