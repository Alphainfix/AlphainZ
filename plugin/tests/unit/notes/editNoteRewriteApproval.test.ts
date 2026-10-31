/**
 * A whole-note rewrite that would destroy the note asks first.
 *
 * `edit_note` with operation `rewrite` replaces the note's entire body. A
 * rewrite that drops or replaces most of a note the user wrote is classified
 * the same way `edit_note_batch` classifies one, and answers to its own
 * approval group — so "Note Edits: Always apply" does not reach it. Short
 * notes and rewrites that keep most of the text stay ordinary note edits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn((_noteId: string, rawHtml: string, _libId: number) => ({
        simplified: rawHtml.replace(/<[^>]+>/g, ''), // Crude strip-tags for testing
        metadata: { elements: new Map() },
        isStale: false,
    })),
    countOccurrences: vi.fn((haystack: string, needle: string) => {
        if (!needle) return 0;
        let count = 0;
        let pos = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
        return count;
    }),
    invalidateSimplificationCache: vi.fn(),
    normalizeNoteHtml: vi.fn((html: string) => html),
    simplifyNoteHtml: vi.fn((rawHtml: string) => ({
        simplified: rawHtml,
        metadata: { elements: new Map() },
    })),
}));

vi.mock('../../../src/utils/editNoteValidation', async () => {
    // `applyOldStringEnrichment` delegates to `enrichOldStringCitationRefs`,
    // mirroring the production wrapper so existing tests that mock
    // `enrichOldStringCitationRefs` (including `.toHaveBeenCalled()` assertions)
    // keep working without change.
    const enrichMock = vi.fn((_oldString: string, _metadata: any) => null as string | null);
    // Re-export the real `detectPartialSimplifiedTag` so the validator and
    // executor can recognize partial citation/annotation openers in old_string
    // even with this module mocked. Pure string analysis, no side effects.
    const actual = await vi.importActual<typeof import('../../../src/utils/editNoteValidation')>(
        '../../../src/utils/editNoteValidation'
    );
    return {
        validateNewString: vi.fn(() => null),
        checkNewCitationItemsExist: vi.fn(() => null),
        checkDuplicateCitations: vi.fn(() => null),
        enrichOldStringCitationRefs: enrichMock,
        applyOldStringEnrichment: vi.fn((oldString: string | undefined, metadata: any) => {
            if (!oldString) return oldString;
            const enriched = enrichMock(oldString, metadata);
            return enriched ?? oldString;
        }),
        detectPartialSimplifiedTag: actual.detectPartialSimplifiedTag,
        buildPartialSimplifiedTagMessage: actual.buildPartialSimplifiedTagMessage,
        buildCitationRefHint: actual.buildCitationRefHint,
        buildExpansionErrorMessage: actual.buildExpansionErrorMessage,
    };
});

vi.mock('../../../src/utils/noteHtmlEntities', () => {
    // Mirrors the production CJK range in `noteHtmlEntities.ts`. Built from
    // a concatenated source so ESLint's `no-irregular-whitespace` rule does
    // not flag the literal U+3000 ideographic space at the range start.
    const CJK_RE = new RegExp(
        '[\\u3000-\\u303F'
        + '\\u3040-\\u30FF'
        + '\\u31F0-\\u31FF'
        + '\\u3400-\\u4DBF'
        + '\\u4E00-\\u9FFF'
        + '\\uA960-\\uA97F'
        + '\\uAC00-\\uD7AF'
        + '\\uF900-\\uFAFF'
        + '\\uFF00-\\uFFEF]',
    );
    const isCjkChar = (ch: string) => !!ch && CJK_RE.test(ch);
    return {
        decodeHtmlEntities: vi.fn((s: string) => s),
        encodeTextEntities: vi.fn((s: string) => s),
        ENTITY_FORMS: ['hex', 'decimal', 'named'],
        foldTypographicQuotes: vi.fn((s: string) => s),
        normalizeWS: vi.fn((s: string) =>
            s.replace(/(?:\s|&nbsp;)+/g, ' ').trim()),
        hasWhitespaceOrNbsp: vi.fn((s: string) => /(?:\s|&nbsp;)/.test(s)),
        isCjkChar: vi.fn(isCjkChar),
        hasCjkAsciiBoundary: vi.fn((s: string) => {
            for (let i = 1; i < s.length; i++) {
                const a = s.charAt(i - 1);
                const b = s.charAt(i);
                if (/\s/.test(a) || /\s/.test(b)) continue;
                if (isCjkChar(a) !== isCjkChar(b)) return true;
            }
            return false;
        }),
        normalizeCjkSpacing: vi.fn((s: string) => {
            // Tag-aware: skip boundary drops inside <...> tags and at HTML
            // delimiter chars, mirroring the production behavior so the
            // editNote unit tests load the matcher under a faithful stub.
            const isHtmlDelim = (ch: string) => /[<>="'/]/.test(ch);
            const collapsed = s.replace(/(?:\s|&nbsp;)+/g, ' ').trim();
            let out = '';
            let inTag = false;
            for (let i = 0; i < collapsed.length; i++) {
                const ch = collapsed.charAt(i);
                if (ch === '<') inTag = true;
                if (ch === ' ' && !inTag) {
                    const prev = i > 0 ? collapsed.charAt(i - 1) : '';
                    const next = i + 1 < collapsed.length ? collapsed.charAt(i + 1) : '';
                    if (
                        prev && next
                        && !isHtmlDelim(prev) && !isHtmlDelim(next)
                        && isCjkChar(prev) !== isCjkChar(next)
                    ) continue;
                }
                out += ch;
                if (ch === '>') inTag = false;
            }
            return out;
        }),
        normalizeCjkSpacingMapped: vi.fn((s: string) => ({
            text: s,
            indexMap: Array.from({ length: s.length + 1 }, (_, k) => k),
        })),
        WS_OR_NBSP_CLASS: '(?:\\s|&nbsp;)',
    };
});

vi.mock('../../../src/utils/noteWrapper', () => ({
    stripDataCitationItems: vi.fn((html: string) => html),
    extractDataCitationItems: vi.fn(() => null),
    rebuildDataCitationItems: vi.fn((html: string) => html),
    hasSchemaVersionWrapper: vi.fn((html: string) => html.includes('data-schema-version=')),
    stripNoteWrapperDiv: vi.fn((html: string) => {
        const trimmed = html.trim();
        if (!trimmed.startsWith('<div') || !trimmed.endsWith('</div>')) return html;
        const closeAngle = trimmed.indexOf('>');
        if (closeAngle === -1) return html;
        return trimmed.substring(closeAngle + 1, trimmed.length - 6);
    }),
}));

vi.mock('../../../src/utils/noteEditorIO', () => ({
    getLatestNoteHtml: vi.fn((item: any) => item.getNote()),
    isNoteInEditor: vi.fn(() => false),
    waitForPMNormalization: vi.fn().mockResolvedValue(undefined),
    waitForNoteSaveStabilization: vi.fn().mockResolvedValue(undefined),
    flushLiveEditorToDB: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../src/utils/noteCitationExpand', () => ({
    expandToRawHtml: vi.fn((str: string, _metadata: any, _context: string) => str),
    preloadPageLabelsForNewCitations: vi.fn().mockResolvedValue({}),
    preloadNotePageLabels: vi.fn().mockResolvedValue({}),
    preloadStructuralLocatorPages: vi.fn().mockResolvedValue({ pages: {}, unresolved: [] }),
    buildUnresolvedLocatorWarning: vi.fn(() => null),
    isCitationRefNotFoundError: vi.fn(() => false),
}));

vi.mock('../../../src/utils/editNoteStrippers', () => ({
    stripPartialSimplifiedElements: vi.fn(() => null),
    stripSpuriousWrappingTags: vi.fn(() => []),
}));

vi.mock('../../../src/utils/editNoteHints', () => ({
    findCandidateSnippets: vi.fn(() => []),
    findStructuralAnchorHint: vi.fn(() => null),
    findInlineTagDriftMatch: vi.fn(() => null),
    findWindowCandidates: vi.fn(() => []),
    centerTruncate: vi.fn((text: string) => ({ snippet: text, truncated: false })),
    markTruncatedUnlessVerbatim: vi.fn(
        (result: { snippet: string; truncated: boolean }) => result,
    ),
    pasteableSnippetBudget: vi.fn(() => 600),
    DEFAULT_MAX_SNIPPET_LENGTH: 200,
    MAX_PASTEABLE_SNIPPET_LENGTH: 600,
}));

vi.mock('../../../src/utils/editNoteRawPosition', async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/editNoteRawPosition')>(
        '../../../src/utils/editNoteRawPosition'
    );
    return {
        ...actual,
        findUniqueRawMatchPosition: vi.fn(() => null),
        captureValidatedEditTargetContext: vi.fn(() => null),
        findTargetRawMatchPosition: vi.fn(() => null),
    };
});

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

vi.mock('../../../react/utils/sourceUtils', () => ({
    clearNoteEditorSelection: vi.fn(),
}));

vi.mock('../../../react/utils/citationRenderers', () => ({
    renderToHTML: vi.fn((content: string) => content),
}));

vi.mock('../../../react/utils/citationRenderContext', () => ({
    prepareCitationRenderContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 2]) },
}));

vi.mock('@beaver/agent-core/citations/atoms', () => ({
    citationMapAtom: Symbol('citationMapAtom'),
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom: Symbol('currentThreadIdAtom'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(() => null),
    backfillMetadataForError: vi.fn(),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} is excluded from AlphainZ.`),
    checkLibraryExcluded: vi.fn(() => null),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    canSetField: vi.fn(() => true),
    SETTABLE_PRIMARY_FIELDS: [],
    sanitizeCreators: vi.fn((c: any) => c),
    createCitationHTML: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../react/utils/batchFindExistingReferences', () => ({
    batchFindExistingReferences: vi.fn().mockResolvedValue([]),
    BatchReferenceCheckItem: {},
}));

vi.mock('../../../react/utils/addItemActions', () => ({
    applyCreateItemData: vi.fn(),
}));

// =============================================================================
// Imports
// =============================================================================

import { handleAgentActionValidateRequest } from '../../../src/services/agentDataProvider/handleAgentActionValidateRequest';
import { getOrSimplify } from '../../../src/utils/noteHtmlSimplifier';
import { validateNewString } from '../../../src/utils/editNoteValidation';
import { expandToRawHtml } from '../../../src/utils/noteCitationExpand';
import { getLatestNoteHtml } from '../../../src/utils/noteEditorIO';
import { getDeferredToolPreference } from '../../../src/services/agentDataProvider/utils';
import { store } from '../../../react/store';

// =============================================================================
// Helpers
// =============================================================================

/** A note long enough to be worth protecting: well over the escalation floor. */
const LONG_NOTE_TEXT = Array.from(
    { length: 12 },
    (_, index) => `Paragraph ${index + 1} records what the user read about bee dances and why it matters.`,
).join(' ');

function mockNote(text: string) {
    return {
        isNote: vi.fn(() => true),
        isRegularItem: vi.fn(() => false),
        isAttachment: vi.fn(() => false),
        isAnnotation: vi.fn(() => false),
        itemType: 'note',
        libraryID: 1,
        key: 'NOTE0001',
        id: 42,
        loadDataType: vi.fn().mockResolvedValue(undefined),
        getNote: vi.fn(() => `<div data-schema-version="9"><p>${text}</p></div>`),
        setNote: vi.fn(),
        getNoteTitle: vi.fn(() => 'My Note'),
        saveTx: vi.fn().mockResolvedValue(undefined),
    };
}

function setNote(text: string) {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        Libraries: { get: vi.fn(() => ({ name: 'My Library', editable: true })) },
        Items: { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(mockNote(text)) },
    };
    vi.mocked(getOrSimplify).mockReturnValue({
        simplified: text,
        metadata: { elements: new Map() },
        isStale: false,
    } as any);
}

function rewrite(newString: string) {
    return handleAgentActionValidateRequest({
        event: 'agent_action_validate',
        request_id: 'val-rewrite',
        action_type: 'edit_note',
        action_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            operation: 'rewrite',
            new_string: newString,
        },
    } as any);
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(store.get).mockImplementation(() => [1, 2] as any);
    vi.mocked(getLatestNoteHtml).mockImplementation((item: any) => item.getNote());
    vi.mocked(validateNewString).mockReturnValue(null);
    vi.mocked(expandToRawHtml).mockImplementation((str: string) => str);
    // Note edits are set to apply automatically; the rewrite group has no
    // standing preference and so always asks.
    vi.mocked(getDeferredToolPreference).mockImplementation(
        (toolName: string) => (toolName === 'destructive_note_rewrite' ? 'always_ask' : 'always_apply') as any,
    );
});

// =============================================================================
// Tests
// =============================================================================

describe('validateEditNoteAction — rewrite approval', () => {
    it('asks before a rewrite that throws most of a long note away', async () => {
        setNote(LONG_NOTE_TEXT);
        const response: any = await rewrite('<p>Just a one-line summary now.</p>');

        expect(response.valid).toBe(true);
        expect(response.preference).toBe('always_ask');
        expect(getDeferredToolPreference).toHaveBeenCalledWith(
            'destructive_note_rewrite',
            { library_id: 1, zotero_key: 'NOTE0001' },
        );
    });

    it('asks before a rewrite that keeps the length but replaces the content', async () => {
        setNote(LONG_NOTE_TEXT);
        const replacement = Array.from(
            { length: 12 },
            (_, index) => `Item ${index + 1}: zzzz qqqq xxxx vvvv wwww kkkk jjjj yyyy mmmm nnnn.`,
        ).join(' ');
        const response: any = await rewrite(`<p>${replacement}</p>`);

        expect(response.preference).toBe('always_ask');
    });

    it('lets a rewrite that keeps the note\'s text follow the note-edit setting', async () => {
        setNote(LONG_NOTE_TEXT);
        const response: any = await rewrite(`<p>${LONG_NOTE_TEXT} One more line at the end.</p>`);

        expect(response.preference).toBe('always_apply');
    });

    it('lets a short note be rewritten under the note-edit setting', async () => {
        setNote('Buy milk.');
        const response: any = await rewrite('<p>Something else entirely.</p>');

        expect(response.preference).toBe('always_apply');
    });

    it('marks a destructive rewrite on the action itself, so its card is not a plain note edit', async () => {
        setNote(LONG_NOTE_TEXT);
        const response: any = await rewrite('<p>Just a one-line summary now.</p>');

        // What the card and the queued record carry from here on: the whole
        // payload, still executable, plus the classification.
        expect(response.normalized_action_data).toEqual({
            library_id: 1,
            zotero_key: 'NOTE0001',
            operation: 'rewrite',
            new_string: '<p>Just a one-line summary now.</p>',
            destructive_rewrite: true,
        });
    });

    it('leaves an ordinary rewrite unmarked', async () => {
        setNote(LONG_NOTE_TEXT);
        const response: any = await rewrite(`<p>${LONG_NOTE_TEXT} One more line at the end.</p>`);

        expect(response.normalized_action_data?.destructive_rewrite).toBeUndefined();
    });
});
