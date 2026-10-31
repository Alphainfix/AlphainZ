/**
 * Where this run's imported papers go.
 *
 * The Zotero browser connector asks once, in a picker, and files everything you
 * save into what you chose. Nothing asked here: an import landed in whichever
 * collection happened to be selected in Zotero, which the user was neither
 * asked about nor told about afterwards.
 *
 * One choice per run rather than one per paper, because a run that proposes
 * four papers proposed them for the same reason — they belong together, and
 * making the same choice four times is four chances to put one in the wrong
 * place. And no more than one run: a folder picked for last week's papers says
 * nothing about where today's belong, and must not override a folder today's
 * proposal names.
 */

import { atom } from 'jotai';

import { logger } from '@beaver/agent-core/platform/logger';
import { getSelectedCollection, getSelectedLibraryId } from '../../src/utils/zoteroSelection';

export interface ImportDestination {
    libraryId: number;
    /** null means the library's root — no collection. */
    collectionKey: string | null;
}

export interface DestinationChoice extends ImportDestination {
    /** Indented by nesting depth, the way the collection tree reads. */
    label: string;
}

/**
 * The indent character.
 *
 * A figure space, not a plain one: an `<option>` collapses leading ordinary
 * whitespace, so a tree indented with spaces arrives flat.
 */
const INDENT = '\u2007\u2007';

/**
 * The destination the user picked on an import card, by the run it was picked
 * for. A run with no entry follows its proposal, then Zotero's selection.
 */
export const importDestinationAtom = atom<Readonly<Record<string, ImportDestination>>>({});

/** Record the user's pick for one run's imports. */
export const chooseImportDestinationAtom = atom(
    null,
    (_get, set, { runId, destination }: { runId: string; destination: ImportDestination | null }) => {
        set(importDestinationAtom, (previous) => {
            const next = { ...previous };
            if (destination) next[runId] = destination;
            else delete next[runId];
            return next;
        });
    },
);

/** The destination the user picked for this run's imports, or null when they have not. */
export function chosenImportDestination(
    chosen: Readonly<Record<string, ImportDestination>>,
    runId: string | null | undefined,
): ImportDestination | null {
    if (!runId) return null;
    return chosen[runId] ?? null;
}

/** What Zotero currently has selected, as the picker's starting point. */
export function currentDestination(): ImportDestination {
    try {
        const pane = Zotero.getActiveZoteroPane();
        const libraryId = getSelectedLibraryId(pane) ?? Zotero.Libraries.userLibraryID;
        const collection = getSelectedCollection(pane);
        return { libraryId, collectionKey: collection?.key ?? null };
    } catch (error) {
        logger(`currentDestination: ${error}`, 1);
        return { libraryId: Zotero.Libraries.userLibraryID, collectionKey: null };
    }
}

/**
 * Every place a paper could go: each editable library, then its collections in
 * tree order, indented.
 *
 * @param allowedLibraryIds  The libraries the agent may write to. Pass it for
 *   anything the agent adds: an excluded library is refused when the write
 *   runs, so offering one would offer a choice that fails on Apply.
 */
export function destinationChoices(allowedLibraryIds?: Iterable<number>): DestinationChoice[] {
    const out: DestinationChoice[] = [];
    const allowed = allowedLibraryIds ? new Set(allowedLibraryIds) : null;
    try {
        const libraries = (Zotero.Libraries.getAll() ?? []).filter(
            (library: any) => library?.editable !== false
                && (allowed === null || allowed.has(library?.libraryID)),
        );
        for (const library of libraries) {
            const libraryId = (library as any).libraryID;
            out.push({
                libraryId,
                collectionKey: null,
                label: (library as any).name ?? 'My Library',
            });

            const walk = (parentId: number | false, depth: number) => {
                const children = (Zotero.Collections.getByParent?.(parentId as any, false) ?? []) as any[];
                for (const collection of children.sort((a, b) => a.name.localeCompare(b.name))) {
                    out.push({
                        libraryId,
                        collectionKey: collection.key,
                        label: `${INDENT.repeat(depth + 1)}${collection.name}`,
                    });
                    walk(collection.id, depth + 1);
                }
            };
            const roots = (Zotero.Collections.getByLibrary?.(libraryId, false) ?? []) as any[];
            for (const collection of roots.sort((a, b) => a.name.localeCompare(b.name))) {
                out.push({
                    libraryId,
                    collectionKey: collection.key,
                    label: `${INDENT}${collection.name}`,
                });
                walk(collection.id, 1);
            }
        }
    } catch (error) {
        logger(`destinationChoices: ${error}`, 1);
    }
    return out;
}

/**
 * The destination a proposal itself names, if any.
 *
 * A proposal carries collection keys but not the library they live in; the
 * key is looked up in the choices (keys are unique within a library, and the
 * user's own library is listed first) so the picker can pre-select it.
 */
export function proposedDestination(
    actionData: { collection_keys?: unknown; library_id?: unknown } | null | undefined,
    choices: DestinationChoice[],
): ImportDestination | null {
    const keys = Array.isArray(actionData?.collection_keys) ? actionData!.collection_keys : [];
    const key = typeof keys[0] === 'string' ? keys[0] : null;
    if (!key) return null;
    const wantedLibrary = typeof actionData?.library_id === 'number' ? actionData.library_id : null;
    const match = choices.find(
        (c) => c.collectionKey === key && (wantedLibrary === null || c.libraryId === wantedLibrary),
    );
    return match ? { libraryId: match.libraryId, collectionKey: match.collectionKey } : null;
}

/** Whether a destination is one of the choices the picker lists. */
function isListed(destination: ImportDestination, choices: DestinationChoice[]): boolean {
    return choices.some(
        (choice) => choice.libraryId === destination.libraryId
            && choice.collectionKey === destination.collectionKey,
    );
}

/**
 * Where an approved import actually goes — the same rule the card's picker
 * displays, in the same order: the user's choice for this run, then the folder
 * the proposal named, then whatever Zotero has selected, then My Library.
 *
 * Every answer is one of `choices`, so what the card shows can always be
 * selected in its list: a selection in a read-only or excluded library, or a
 * proposal naming a folder that is not offered, falls through to the next
 * rule rather than being displayed as something else and written anyway.
 * Returns null only when nothing is listed at all, and the proposal is applied
 * as written. Kept pure so the card and the apply path cannot drift: showing
 * one folder and filing into another is exactly the bug this exists to
 * prevent.
 */
export function resolveImportDestination(
    chosen: ImportDestination | null,
    actionData: { collection_keys?: unknown; library_id?: unknown } | null | undefined,
    current: () => ImportDestination,
    choices: DestinationChoice[],
): ImportDestination | null {
    if (choices.length === 0) return null;
    if (chosen && isListed(chosen, choices)) return chosen;
    const proposed = proposedDestination(actionData, choices);
    if (proposed) return proposed;
    const selected = current();
    if (isListed(selected, choices)) return selected;
    const userLibraryId = (() => {
        try {
            return Zotero.Libraries.userLibraryID;
        } catch {
            return null;
        }
    })();
    const userLibrary = choices.find(
        (choice) => choice.libraryId === userLibraryId && choice.collectionKey === null,
    );
    const fallback = userLibrary ?? choices.find((choice) => choice.collectionKey === null) ?? choices[0];
    return { libraryId: fallback.libraryId, collectionKey: fallback.collectionKey };
}

/** Encode a destination for a `<select>` value, and back. */
export const destinationValue = (d: ImportDestination) => `${d.libraryId}:${d.collectionKey ?? ''}`;
export function parseDestinationValue(value: string): ImportDestination | null {
    const [rawLibrary, rawKey] = value.split(':');
    const libraryId = Number(rawLibrary);
    if (!Number.isFinite(libraryId)) return null;
    return { libraryId, collectionKey: rawKey ? rawKey : null };
}
