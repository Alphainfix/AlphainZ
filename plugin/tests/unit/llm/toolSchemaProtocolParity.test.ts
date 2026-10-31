/**
 * Parity between the model-facing tool schemas and the wire types they build.
 *
 * A handler ignores fields it does not recognise, so a misspelled property name
 * does not error — the request just runs without that filter and comes back
 * empty or unfiltered. That reads to the model (and the user) as a real answer,
 * which makes it the most expensive kind of mistake here and the reason this
 * file parses the protocol source rather than trusting the schemas.
 *
 * Two such drifts were found this way: `item_search_by_metadata` used
 * `title_contains`/`creator_contains` for what the wire calls
 * `title_query`/`author_query`, and `read_note` used `item_id` for `note_id`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOOL_SPECS, buildToolRequest } from '../../../src/services/llm/toolSchemas';

const PROTOCOL_PATH = fileURLToPath(
    new URL('../../../packages/agent-core/src/protocol/agentProtocol.ts', import.meta.url),
);
const protocolSource = readFileSync(PROTOCOL_PATH, 'utf8');

/** Envelope fields every request carries; not tool parameters. */
const ENVELOPE = new Set(['event', 'request_id']);

/** Plausible values for required args, keyed by field name. */
const SAMPLE: Record<string, unknown> = {
    topic_query: 'bee navigation',
    item_ids: ['1'],
    note_id: '1',
    attachment_id: 'u-ABCD1234',
    query: 'pollen loads',
    pages: [1],
};

/**
 * The declared field names of one exported interface.
 *
 * Deliberately shallow — top-level members only, matched at one indent level,
 * which is all the tool requests use.
 */
function interfaceFields(interfaceName: string): Set<string> | null {
    const match = new RegExp(
        `export interface ${interfaceName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
    ).exec(protocolSource);
    if (!match) return null;
    const fields = match[1].matchAll(/^ {4}([a-z_][A-Za-z0-9_]*)\??\s*:/gm);
    return new Set([...fields].map((m) => m[1]));
}

/** Wire interface name for a tool's event, e.g. `list_tags_request` → WSListTagsRequest. */
function interfaceNameForEvent(event: string): string {
    const pascal = event
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    return `WS${pascal}`;
}

describe('tool schema / protocol parity', () => {
    it('resolves an interface for every tool event', () => {
        // If this fails the naming convention changed and the checks below would
        // silently pass by testing nothing.
        for (const spec of TOOL_SPECS) {
            const name = interfaceNameForEvent(spec.event);
            expect(interfaceFields(name), `${spec.name} → ${name}`).not.toBeNull();
        }
    });

    it('exposes only properties the wire type declares', () => {
        const drifts: string[] = [];
        for (const spec of TOOL_SPECS) {
            // A spec with `transformArgs` deliberately shows the model a
            // different shape than the wire takes (an attachment is a composite
            // id to a model, a {library_id, zotero_key} pair on the wire). The
            // post-transform check below is the one that binds those specs.
            if (spec.transformArgs) continue;
            const declared = interfaceFields(interfaceNameForEvent(spec.event));
            if (!declared) continue;
            for (const property of Object.keys(spec.schema.parameters.properties)) {
                if (!declared.has(property)) {
                    drifts.push(`${spec.name}.${property}`);
                }
            }
        }
        expect(drifts).toEqual([]);
    });

    it('defaults only fields the wire type declares', () => {
        const drifts: string[] = [];
        for (const spec of TOOL_SPECS) {
            const declared = interfaceFields(interfaceNameForEvent(spec.event));
            if (!declared) continue;
            for (const field of Object.keys(spec.defaults)) {
                if (!declared.has(field)) drifts.push(`${spec.name}.${field}`);
            }
        }
        expect(drifts).toEqual([]);
    });

    it('supplies every non-optional wire field, from defaults or required args', () => {
        // A field the type marks non-optional has to come from somewhere: the
        // model (required) or the spec (defaults). Anything else reaches the
        // handler as undefined.
        const gaps: string[] = [];
        for (const spec of TOOL_SPECS) {
            const interfaceName = interfaceNameForEvent(spec.event);
            const match = new RegExp(
                `export interface ${interfaceName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
            ).exec(protocolSource);
            if (!match) continue;

            // No `?` before the colon means non-optional.
            const mandatory = [...match[1].matchAll(/^ {4}([a-z_][A-Za-z0-9_]*):/gm)]
                .map((m) => m[1])
                .filter((field) => !ENVELOPE.has(field));

            // A transform is a third source of wire fields, alongside defaults
            // and required args — run it over the sample so its output counts.
            const transformed = spec.transformArgs
                ? Object.keys(
                      spec.transformArgs(
                          Object.fromEntries(
                              (spec.schema.parameters.required ?? []).map((f) => [f, SAMPLE[f]]),
                          ),
                      ),
                  )
                : [];

            const supplied = new Set([
                ...Object.keys(spec.defaults),
                ...(spec.schema.parameters.required ?? []),
                ...transformed,
            ]);
            for (const field of mandatory) {
                if (!supplied.has(field)) gaps.push(`${spec.name}.${field}`);
            }
        }
        expect(gaps).toEqual([]);
    });

    it('stamps the event name the protocol declares as a literal', () => {
        for (const spec of TOOL_SPECS) {
            const interfaceName = interfaceNameForEvent(spec.event);
            expect(protocolSource, spec.name).toContain(`event: '${spec.event}'`);
            expect(interfaceFields(interfaceName)!.has('event')).toBe(true);
        }
    });

    it('builds a request whose keys all exist on the wire type', () => {
        // End-to-end over buildToolRequest, so a default injected outside the
        // spec object is caught too.
        for (const spec of TOOL_SPECS) {
            const declared = interfaceFields(interfaceNameForEvent(spec.event))!;
            const args: Record<string, unknown> = {};
            for (const field of spec.schema.parameters.required ?? []) {
                args[field] = SAMPLE[field];
            }
            const request = buildToolRequest(spec.name, args, 'r');
            for (const key of Object.keys(request)) {
                expect(declared, `${spec.name}.${key}`).toContain(key);
            }
        }
    });
});
