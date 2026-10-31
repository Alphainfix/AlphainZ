/**
 * create_item validation accepts both payload dialects.
 *
 * The batch shape carries `items[]`; the local agent's proposeWrite sends the
 * execute shape — a single `item: ExternalReference` — to validation too. The
 * mismatch made every locally proposed paper fail with "At least one item must
 * be provided" before the user ever saw an approval card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1]) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn(() => null),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} excluded`),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

const batchFind = vi.fn(async (items: Array<{ id: string }>) => ({
    results: items.map((i) => ({ id: i.id, item: null })),
    timing: { total_ms: 1 },
}));
vi.mock('../../../react/utils/batchFindExistingReferences', () => ({
    batchFindExistingReferences: (...args: any[]) => (batchFind as any)(...args),
}));

vi.mock('../../../react/utils/addItemActions', () => ({
    applyCreateItemData: vi.fn(),
}));

import { validateCreateItemAction } from '../../../src/services/agentDataProvider/actions/createItems';
import type { WSAgentActionValidateRequest } from '@beaver/agent-core/protocol/agentProtocol';

function request(actionData: Record<string, unknown>): WSAgentActionValidateRequest {
    return {
        type: 'agent_action_validate_request',
        request_id: 'req-1',
        action_type: 'create_item',
        action_data: actionData,
    } as unknown as WSAgentActionValidateRequest;
}

describe('validateCreateItemAction payload dialects', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero = {
            ...((globalThis as any).Zotero ?? {}),
            Libraries: {
                get: vi.fn((id: number) =>
                    id === 1 ? { libraryID: 1, name: 'My Library', editable: true } : null),
                userLibraryID: 1,
            },
            Collections: {
                getByLibraryAndKeyAsync: vi.fn(async () => ({ name: 'Batch7' })),
            },
        };
    });

    it('accepts the single-item execute shape the local agent proposes', async () => {
        const response = await validateCreateItemAction(request({
            item: {
                source: 'openalex',
                source_id: 'W4390000017',
                title: 'Street-tree canopy and afternoon surface heat in a mid-sized city',
                authors: ['Achterberg', 'Pemberton-Lowe', 'Oduya'],
                year: 2023,
                identifiers: { doi: '10.1000/urbanheat.2023.249' },
            },
            file_available: true,
            reason: 'requested by the user',
        }));
        expect(response.valid).toBe(true);
        expect((response.current_value as any).items_count).toBe(1);
        // The duplicate check ran over the derived item, DOI included.
        expect(batchFind).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'W4390000017', data: expect.objectContaining({ DOI: '10.1000/urbanheat.2023.249' }) })],
            [1],
        );
    });

    it('still accepts the batch items[] shape', async () => {
        const response = await validateCreateItemAction(request({
            items: [{ source_id: 's1', title: 'A paper', year: 2020 }],
        }));
        expect(response.valid).toBe(true);
        expect((response.current_value as any).items_count).toBe(1);
    });

    it('rejects a payload with neither shape', async () => {
        const response = await validateCreateItemAction(request({ file_available: false }));
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe('no_items');
    });
});

describe('validateCreateItemAction destination', () => {
    it('validates collection_keys on the single-item shape and names the folder', async () => {
        const response = await validateCreateItemAction(request({
            item: { source: 'openalex', source_id: 'W1', title: 'T' },
            file_available: false,
            collection_keys: ['RLST8KEY'],
        }));
        expect(response.valid).toBe(true);
        expect((response.current_value as any).resolved_collections).toEqual([{ key: 'RLST8KEY', name: 'Batch7' }]);
    });
});
