import { describe, expect, it } from 'vitest';

import {
    MissingArgumentError,
    TOOL_LIMITS,
    TOOL_SPECS,
    TOOL_SPECS_BY_NAME,
    UnknownToolError,
    buildToolRequest,
    clampLimit,
    toolSchemas,
} from '../../../src/services/llm/toolSchemas';

const { DEFAULT_LIMIT, MAX_LIMIT } = TOOL_LIMITS;

// ---------------------------------------------------------------------------
// Spec integrity — guards against a malformed schema reaching a provider
// ---------------------------------------------------------------------------

describe('TOOL_SPECS', () => {
    it('has no duplicate tool names', () => {
        const names = TOOL_SPECS.map((s) => s.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('gives every spec a distinct wire event', () => {
        const events = TOOL_SPECS.map((s) => s.event);
        expect(new Set(events).size).toBe(events.length);
    });

    it('names each schema after its tool', () => {
        // The provider dispatches on schema.name, so a mismatch routes a call
        // to a tool the registry has never heard of.
        for (const spec of TOOL_SPECS) {
            expect(spec.schema.name).toBe(spec.name);
        }
    });

    it('declares every required field as a property', () => {
        for (const spec of TOOL_SPECS) {
            for (const field of spec.schema.parameters.required ?? []) {
                expect(
                    Object.keys(spec.schema.parameters.properties),
                    `${spec.name}.${field}`,
                ).toContain(field);
            }
        }
    });

    it('gives every tool and property a description the model can act on', () => {
        for (const spec of TOOL_SPECS) {
            expect(spec.schema.description.length, spec.name).toBeGreaterThan(20);
            for (const [key, prop] of Object.entries(spec.schema.parameters.properties)) {
                expect((prop as any).description, `${spec.name}.${key}`).toBeTruthy();
            }
        }
    });

    it('never puts a field in both defaults and required', () => {
        // A required field that is also defaulted can never actually be missing,
        // which makes the required marker a lie to the model.
        for (const spec of TOOL_SPECS) {
            for (const field of spec.schema.parameters.required ?? []) {
                expect(Object.keys(spec.defaults), `${spec.name}.${field}`).not.toContain(field);
            }
        }
    });
});

describe('toolSchemas', () => {
    it('returns every schema by default', () => {
        expect(toolSchemas()).toHaveLength(TOOL_SPECS.length);
    });

    it('returns only the named subset, in order', () => {
        expect(toolSchemas(['list_libraries', 'get_metadata']).map((s) => s.name)).toEqual([
            'list_libraries',
            'get_metadata',
        ]);
    });

    it('silently drops an unknown name rather than emitting a hole', () => {
        expect(toolSchemas(['list_libraries', 'nope']).map((s) => s.name)).toEqual([
            'list_libraries',
        ]);
    });
});

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

describe('clampLimit', () => {
    it('passes an in-range value through', () => {
        expect(clampLimit(25)).toBe(25);
    });

    it('caps the runaway value models like to ask for', () => {
        expect(clampLimit(1000)).toBe(MAX_LIMIT);
    });

    it('raises a non-positive value to one row', () => {
        expect(clampLimit(0)).toBe(1);
        expect(clampLimit(-5)).toBe(1);
    });

    it('floors a fractional value', () => {
        expect(clampLimit(7.9)).toBe(7);
    });

    it('coerces a numeric string, since models emit them', () => {
        expect(clampLimit('30')).toBe(30);
    });

    it('falls back when the value is not a number at all', () => {
        expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
        expect(clampLimit('lots')).toBe(DEFAULT_LIMIT);
        expect(clampLimit(NaN)).toBe(DEFAULT_LIMIT);
        expect(clampLimit(null, 7)).toBe(7);
    });

    it('treats null and empty string as absent, not as zero', () => {
        // Number(null) and Number('') are both 0, which is finite — without an
        // explicit guard they clamp to 1 and a "no preference" limit silently
        // becomes a one-row answer.
        expect(clampLimit(null)).toBe(DEFAULT_LIMIT);
        expect(clampLimit('')).toBe(DEFAULT_LIMIT);
        expect(clampLimit(undefined, 7)).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// buildToolRequest
// ---------------------------------------------------------------------------

describe('buildToolRequest', () => {
    it('stamps the envelope the handler dispatches on', () => {
        const request = buildToolRequest('list_libraries', {}, 'req-1');
        expect(request).toMatchObject({ event: 'list_libraries_request', request_id: 'req-1' });
    });

    it('fills the required-but-not-model-facing fields', () => {
        // find_annotations requires recursive/sort_by/sort_order/limit/offset in
        // the wire type, none of which a model should have to supply.
        const request = buildToolRequest('find_annotations', { tag: 'bees' }, 'r');
        expect(request).toMatchObject({
            tag: 'bees',
            recursive: true,
            sort_by: 'date_modified',
            sort_order: 'desc',
            limit: DEFAULT_LIMIT,
            offset: 0,
        });
    });

    it('lets the model override a default', () => {
        const request = buildToolRequest('find_annotations', { sort_order: 'asc' }, 'r');
        expect(request.sort_order).toBe('asc');
    });

    it('never lets the model overwrite the envelope', () => {
        const request = buildToolRequest(
            'list_libraries',
            { event: 'evil_request', request_id: 'spoofed' },
            'real',
        );
        expect(request).toMatchObject({ event: 'list_libraries_request', request_id: 'real' });
    });

    it('clamps a limit the model inflated', () => {
        const request = buildToolRequest('item_search_by_topic', { topic_query: 'x', limit: 9999 }, 'r');
        expect(request.limit).toBe(MAX_LIMIT);
    });

    it('normalizes a nonsensical offset to zero', () => {
        for (const offset of [-3, 'abc', NaN]) {
            const request = buildToolRequest(
                'item_search_by_topic',
                { topic_query: 'x', offset },
                'r',
            );
            expect(request.offset).toBe(0);
        }
    });

    it('does not invent paging for a tool that has none', () => {
        const request = buildToolRequest('get_metadata', { item_ids: ['1'] }, 'r');
        expect(request).not.toHaveProperty('limit');
        expect(request).not.toHaveProperty('offset');
    });

    it('keeps an explicit null as an intentional empty filter', () => {
        const request = buildToolRequest('find_annotations', { tag: null }, 'r');
        expect(request.tag).toBeNull();
    });

    it('drops undefined so it cannot erase a default', () => {
        // Spreading `{sort_order: undefined}` over the defaults would otherwise
        // blank a field the wire type requires.
        const request = buildToolRequest('find_annotations', { sort_order: undefined }, 'r');
        expect(request.sort_order).toBe('desc');
    });

    it('applies get_metadata include flags that the type requires', () => {
        const request = buildToolRequest('get_metadata', { item_ids: ['a', 'b'] }, 'r');
        expect(request).toMatchObject({
            item_ids: ['a', 'b'],
            include_attachments: true,
            include_notes: false,
            detail: 'full',
        });
    });

    it('rejects an unknown tool and lists what is available', () => {
        try {
            buildToolRequest('teleport', {}, 'r');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(UnknownToolError);
            expect((error as Error).message).toContain('list_libraries');
        }
    });

    it('reports a missing required argument by name', () => {
        try {
            buildToolRequest('item_search_by_topic', {}, 'r');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(MissingArgumentError);
            expect((error as Error).message).toContain('topic_query');
        }
    });

    it('treats an empty string as missing, not as a valid query', () => {
        // A blank topic would run a semantic search over nothing and return
        // arbitrary rows, which reads to the model as a real answer.
        expect(() => buildToolRequest('item_search_by_topic', { topic_query: '' }, 'r')).toThrow(
            MissingArgumentError,
        );
        expect(() => buildToolRequest('get_metadata', { item_ids: null }, 'r')).toThrow(
            MissingArgumentError,
        );
    });

    it('builds a request for every spec given its required fields', () => {
        // Smoke test across the whole catalogue, so adding a spec with a broken
        // default cannot pass unnoticed.
        const sample: Record<string, unknown> = {
            topic_query: 'bee navigation',
            item_ids: ['1'],
            note_id: '1',
            attachment_id: 'u-ABCD1234',
            query: 'pollen loads',
            pages: [1],
        };
        for (const spec of TOOL_SPECS) {
            const args: Record<string, unknown> = {};
            for (const field of spec.schema.parameters.required ?? []) {
                args[field] = sample[field];
            }
            const request = buildToolRequest(spec.name, args, 'r');
            expect(request.event, spec.name).toBe(spec.event);
        }
    });

    it('exposes every spec through the lookup map', () => {
        expect(TOOL_SPECS_BY_NAME.size).toBe(TOOL_SPECS.length);
        for (const spec of TOOL_SPECS) {
            expect(TOOL_SPECS_BY_NAME.get(spec.name)).toBe(spec);
        }
    });
});
