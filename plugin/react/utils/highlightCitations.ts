/**
 * Making a proposed highlight reachable from the sentence that describes it.
 *
 * The answer would say "the sentence in §II.B that states the core design
 * principle (p. 4)" and quote it — with nothing to click. The reader then opens
 * the paper and hunts for the passage again, which is the work the highlight
 * was supposed to save.
 *
 * The tool hands the model a ready `<citation>` tag for exactly this, and the
 * model does not place it: told to, DeepSeek flash quoted the passage, named the
 * page, and left the tag out. Which is the same lesson this codebase has learned
 * twice already — a requirement that has to hold cannot live in the prompt.
 *
 * So it is done here instead, and only where it is certain: the quoted passage
 * is matched against the answer's own text, and the tag goes immediately after
 * the quote. No match, no edit. Nothing is guessed about where the passage is
 * mentioned, and an answer that already cites the page is left alone.
 */

import { logger } from '@beaver/agent-core/platform/logger';

export interface ProposedHighlight {
    /** Model-facing attachment id the citation should point at. */
    attachmentId: string;
    /** 1-based page the passage was actually located on. */
    page: number;
    /** The passage, exactly as it appears in the document. */
    text: string;
    /**
     * Where the passage sits on the page, as `[l, t, r, b]` quads.
     *
     * Carried so the citation can be sentence-level rather than page-level:
     * with boxes the hover card shows the sentence itself and clicking the
     * marker opens the PDF *with the passage highlighted*, which is what
     * Beaver's citations do and what the "Keep Cited Passages Highlighted"
     * setting has been controlling nothing for.
     */
    boxes?: number[][];
}

/** Highlights proposed during a run, so the answer can be linked to them. */
const byRun = new Map<string, ProposedHighlight[]>();

export function recordProposedHighlight(runId: string, highlight: ProposedHighlight): void {
    if (!runId) return;
    const list = byRun.get(runId);
    if (list) list.push(highlight);
    else byRun.set(runId, [highlight]);
}

/** Read and forget a run's proposals. Called once, when the run finishes. */
export function takeProposedHighlights(runId: string): ProposedHighlight[] {
    const list = byRun.get(runId) ?? [];
    byRun.delete(runId);
    return list;
}

/** Drop everything for a run that ended without finishing. */
export function forgetProposedHighlights(runId: string): void {
    byRun.delete(runId);
}

/**
 * Where the quote ends in the answer, or -1.
 *
 * The model reproduces the passage but not always byte for byte: it may
 * straighten the quotes it copied, or drop the trailing full stop when the
 * sentence continues. Matching walks the answer once, comparing only letters
 * and digits, which is enough to place the end of the quote exactly while
 * ignoring every difference that does not change the words.
 */
export function findQuoteEnd(answer: string, quote: string): number {
    const significant = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
    const needle = [...quote].filter(significant).map((c) => c.toLowerCase());
    if (needle.length < 12) return -1;

    let matched = 0;
    for (let i = 0; i < answer.length; i += 1) {
        const ch = answer[i];
        if (!significant(ch)) continue;
        if (ch.toLowerCase() === needle[matched]) {
            matched += 1;
            if (matched === needle.length) return i + 1;
        } else {
            // Restart, but reconsider this character as a fresh first match so
            // a repeated opening word does not desynchronise the scan.
            matched = ch.toLowerCase() === needle[0] ? 1 : 0;
        }
    }
    return -1;
}

/**
 * Shortest run of the quote's words worth anchoring on.
 *
 * Below this a match is coincidence — "in the presence of" appears everywhere —
 * and a citation on the wrong sentence is worse than none.
 */
const MIN_ANCHOR_WORDS = 8;

/**
 * Where the quote, or the longest part of it the answer reproduces, ends.
 *
 * Requiring the whole passage was too strict in the ordinary case: the model
 * quotes the half of the sentence that makes its point, or trims the citation
 * marker off the end, and the link was then dropped for a paraphrase that was
 * really just shorter. Windows are tried longest-first, so the tag lands after
 * the most complete reproduction the answer contains.
 */
function findAnchorEnd(answer: string, quote: string): number {
    const exact = findQuoteEnd(answer, quote);
    if (exact >= 0) return exact;

    const words = quote.split(/\s+/).filter(Boolean);
    for (let length = words.length - 1; length >= MIN_ANCHOR_WORDS; length -= 1) {
        for (let start = 0; start + length <= words.length; start += 1) {
            const end = findQuoteEnd(answer, words.slice(start, start + length).join(' '));
            if (end >= 0) return end;
        }
    }
    return -1;
}

/**
 * Put a citation after each quoted passage the run proposed a highlight on.
 *
 * Returns the answer unchanged when there is nothing to add — no proposals, no
 * quote found, or a citation for that page already present.
 */
export function attachHighlightCitations(
    answer: string,
    highlights: ProposedHighlight[],
): string {
    if (!answer || highlights.length === 0) return answer;

    let out = answer;
    for (const highlight of highlights) {
        const tag = `<citation id="${highlight.attachmentId}" page="${highlight.page}"/>`;
        if (out.includes(tag)) continue;

        const end = findAnchorEnd(out, highlight.text);
        if (end < 0) continue;

        // Step past the punctuation and closing quote marks that belong to the
        // sentence, so the marker lands after them rather than inside.
        let insertAt = end;
        while (insertAt < out.length && /[.,;:!?)\]”"'’»]/.test(out[insertAt])) insertAt += 1;

        out = `${out.slice(0, insertAt)}${tag}${out.slice(insertAt)}`;
        logger(`attachHighlightCitations: linked p.${highlight.page} of ${highlight.attachmentId}`, 3);
    }
    return out;
}

/**
 * Replace the answer text on a finished run.
 *
 * The answer is the last text part of the last response message; everything
 * earlier is the thinking-out-loud that preceded a tool call.
 */
export function withRewrittenAnswer<T extends {
    model_messages?: Array<{ kind: string; parts: Array<Record<string, any>> }>;
}>(run: T, rewrite: (answer: string) => string): T {
    /*
     * Every response that has text, not just the last one.
     *
     * The old rule stopped at the last response with text, which was right
     * until a tool could be called *after* the answer: a run wrote its answer,
     * called `return_suggestions`, then added a one-line sign-off — and the
     * sign-off was the only thing considered, so the quotes in the answer above
     * it were never linked.
     *
     * Each response is rewritten on its own rather than joining them all: the
     * parts have to keep belonging to the message they came from, and a rewrite
     * that only matches in one of them should not disturb the others.
     */
    const messages = run.model_messages ?? [];
    let changed = false;
    const nextMessages = messages.map((message) => {
        if (message.kind !== 'response') return message;
        const textParts = message.parts
            .map((part, index) => ({ part, index }))
            .filter(({ part }) => part.part_kind === 'text' && typeof part.content === 'string');
        if (textParts.length === 0) return message;

        const joined = textParts.map(({ part }) => part.content as string).join('');
        if (!joined.trim()) return message;

        const next = rewrite(joined);
        if (next === joined) return message;

        changed = true;
        // Collapse into the first text part and blank the rest, so the parts
        // still join to exactly the rewritten text.
        const parts = [...message.parts];
        textParts.forEach(({ index }, position) => {
            parts[index] = { ...parts[index], content: position === 0 ? next : '' };
        });
        return { ...message, parts };
    });
    return changed ? { ...run, model_messages: nextMessages } : run;
}

// ---------------------------------------------------------------------------
// Linking the pages an answer names
// ---------------------------------------------------------------------------

/** Attachments a run actually read, so a page it names can be made clickable. */
const readByRun = new Map<string, Set<string>>();

export function recordReadAttachment(runId: string, attachmentId: string): void {
    if (!runId || !attachmentId) return;
    const set = readByRun.get(runId);
    if (set) set.add(attachmentId);
    else readByRun.set(runId, new Set([attachmentId]));
}

export function takeReadAttachments(runId: string): string[] {
    const set = readByRun.get(runId);
    readByRun.delete(runId);
    return set ? [...set] : [];
}

export function forgetReadAttachments(runId: string): void {
    readByRun.delete(runId);
}

// ---------------------------------------------------------------------------
// Sentence locators the run was actually given
// ---------------------------------------------------------------------------

/**
 * Per run, per attachment: the sentence numbers the model saw — printed as
 * `[s12]` labels in read_document text, or handed to it inside a search hit's
 * `cite`. A `loc` the answer carries is checked against this set, so a label
 * the model invented cannot send the reader to the wrong sentence: it is
 * dropped and the citation falls back to the page.
 */
const shownLocatorsByRun = new Map<string, Map<string, Set<number>>>();

export function recordShownLocators(runId: string, attachmentId: string, sentences: Iterable<number>): void {
    if (!runId || !attachmentId) return;
    let byAttachment = shownLocatorsByRun.get(runId);
    if (!byAttachment) {
        byAttachment = new Map();
        shownLocatorsByRun.set(runId, byAttachment);
    }
    let set = byAttachment.get(attachmentId);
    if (!set) {
        set = new Set();
        byAttachment.set(attachmentId, set);
    }
    for (const n of sentences) if (Number.isFinite(n)) set.add(n);
}

export function takeShownLocators(runId: string): Map<string, Set<number>> {
    const byAttachment = shownLocatorsByRun.get(runId);
    shownLocatorsByRun.delete(runId);
    return byAttachment ?? new Map();
}

/** The sentence numbers labelled in a stretch of read_document text. */
export function sentenceLabelsIn(text: string): number[] {
    const out: number[] = [];
    const re = /\[s(\d{1,5})\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
    return out;
}

/** Every sentence number in an inclusive range, for recording a search hit's span. */
export function sentenceRangeNumbers(start: number, end: number): number[] {
    const out: number[] = [];
    for (let n = start; n <= end; n += 1) out.push(n);
    return out;
}

// ---------------------------------------------------------------------------
// The sentences the run was shown, so a citation can show them back
// ---------------------------------------------------------------------------

/**
 * Per run, per attachment: the text behind each sentence label the model saw,
 * and the passages search hits handed it whole.
 *
 * A citation composed from a label (`loc="s12"`) names one sentence exactly,
 * and its hover card should show that sentence — not "Page 7", which the
 * reader already has. The click path resolves the sentence's rectangles from
 * the cached extraction; the text is remembered here at the moment it was
 * shown, so the card shows what the model actually read, and nothing has to
 * be looked up when the answer is published (which happens synchronously).
 */
export interface ShownSentence { page: number; text: string }
export interface ShownPassage { start: number; end: number; page: number; text: string }
export interface ShownText { sentences: Map<number, ShownSentence>; passages: ShownPassage[] }

const shownTextByRun = new Map<string, Map<string, ShownText>>();

function shownTextFor(runId: string, attachmentId: string): ShownText {
    let byAttachment = shownTextByRun.get(runId);
    if (!byAttachment) {
        byAttachment = new Map();
        shownTextByRun.set(runId, byAttachment);
    }
    let entry = byAttachment.get(attachmentId);
    if (!entry) {
        entry = { sentences: new Map(), passages: [] };
        byAttachment.set(attachmentId, entry);
    }
    return entry;
}

export function recordShownSentences(
    runId: string,
    attachmentId: string,
    page: number,
    sentences: Iterable<[number, string]>,
): void {
    if (!runId || !attachmentId || !Number.isFinite(page)) return;
    const entry = shownTextFor(runId, attachmentId);
    for (const [n, text] of sentences) {
        if (!Number.isFinite(n) || !text) continue;
        entry.sentences.set(n, { page, text });
    }
}

/** A search hit: one passage spanning `start`–`end`, handed over whole. */
export function recordShownPassage(runId: string, attachmentId: string, passage: ShownPassage): void {
    if (!runId || !attachmentId || !passage.text) return;
    shownTextFor(runId, attachmentId).passages.push(passage);
}

export function takeShownText(runId: string): Map<string, ShownText> {
    const byAttachment = shownTextByRun.get(runId);
    shownTextByRun.delete(runId);
    return byAttachment ?? new Map();
}

/**
 * The sentences labelled in read_document text, each with the text its label
 * introduces. Any label ends the sentence before it — `[p4]` and `[heading2]`
 * included — and text under a non-sentence label is not a sentence.
 */
export function sentenceTextsIn(pageText: string): Array<[number, string]> {
    const out: Array<[number, string]> = [];
    const label = /\[([a-z]+)(\d{1,5})\]/g;
    let pending: { n: number; from: number } | null = null;
    const flush = (to: number) => {
        if (!pending) return;
        const text = pageText.slice(pending.from, to).trim();
        if (text) out.push([pending.n, text]);
        pending = null;
    };
    let m: RegExpExecArray | null;
    while ((m = label.exec(pageText)) !== null) {
        flush(m.index);
        pending = m[1] === 's' ? { n: Number(m[2]), from: m.index + m[0].length } : null;
    }
    flush(pageText.length);
    return out;
}

const LOCATOR_RANGE = /^s(\d{1,5})(?:\s*[-–—]\s*s?(\d{1,5}))?$/;

/**
 * The text a `loc` names, out of what this run was shown for that attachment.
 *
 * A search hit handed over as one passage *is* the passage, however many
 * sentences it spans: a range matching it exactly shows it; so does a range
 * inside it when no sentence text was shown separately. Composed sentences
 * stay on one page — the first one's — because a card shows one passage.
 */
export function passageForLocator(
    loc: string,
    shown: ShownText | undefined,
): { page: number; text: string } | null {
    if (!shown) return null;
    const m = String(loc ?? '').trim().match(LOCATOR_RANGE);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 100) return null;

    const exact = shown.passages.find((p) => p.start === a && p.end === b);
    if (exact) return { page: exact.page, text: exact.text };

    const parts: string[] = [];
    let page: number | null = null;
    for (let n = a; n <= b; n += 1) {
        const sentence = shown.sentences.get(n);
        if (!sentence) continue;
        if (page === null) page = sentence.page;
        if (sentence.page === page) parts.push(sentence.text);
    }
    if (page !== null && parts.length > 0) return { page, text: parts.join(' ') };

    const covering = shown.passages.find((p) => p.start <= a && b <= p.end);
    return covering ? { page: covering.page, text: covering.text } : null;
}

/** Cut a passage down for a hover card: whole words, one ellipsis. */
export function clipPassage(text: string, max = 320): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    const cut = flat.lastIndexOf(' ', max);
    return `${flat.slice(0, cut > max * 0.6 ? cut : max).trimEnd()}…`;
}

const CITATION_TAG = /<citation\b[^>]*\/>/g;

/**
 * Keep a citation's `loc` only when every sentence it names was shown to the
 * run for that attachment. Attachments the run was never shown labels for are
 * left alone — their `loc`, if any, came from somewhere this check cannot see.
 */
export function validateComposedLocators(answer: string, shown: Map<string, Set<number>>): string {
    if (!answer || shown.size === 0) return answer;
    CITATION_TAG.lastIndex = 0;
    return answer.replace(CITATION_TAG, (tag) => {
        const id = tag.match(/\bid="([^"]+)"/)?.[1];
        const locAttr = tag.match(/\s+loc="([^"]*)"/);
        if (!id || !locAttr) return tag;
        const allowed = shown.get(id);
        if (!allowed) return tag;
        const range = locAttr[1].trim().match(/^s(\d{1,5})(?:\s*[-–—]\s*s?(\d{1,5}))?$/);
        let ok = false;
        if (range) {
            const a = Number(range[1]);
            const b = range[2] ? Number(range[2]) : a;
            ok = b >= a;
            for (let n = a; ok && n <= b; n += 1) if (!allowed.has(n)) ok = false;
        }
        return ok ? tag : tag.replace(locAttr[0], '');
    });
}

/**
 * Page references the answer writes in prose, in the forms it actually uses.
 *
 * English and Chinese both, because the answer follows the language of the
 * question and this user asks in both. The page number is group 1 in every
 * alternative.
 */
const PAGE_MENTION =
    /(?:\bpp?\.\s*(\d{1,4})|\bpages?\s+(\d{1,4})|第\s*(\d{1,4})\s*页)/g;

/**
 * Turn "p. 7" into something the reader can click.
 *
 * The model names pages constantly and links them almost never — it was given a
 * ready-made tag by every tool that returns a page and still writes the number
 * in prose. Asking harder does not work; this codebase has established that
 * twice. So the page it names is linked here.
 *
 * Two conditions, both learned the hard way on one live run.
 *
 * The run must have read exactly one document: with two open, "p. 7" does not
 * say which paper, and a link to the wrong one is worse than plain text.
 *
 * And the page must be one this run actually put a highlight on. The first
 * version linked any page the answer named, and the answer it was tested
 * against said "on page 7 — not page 8". Page 7 already carried the model's own
 * marker, so the only thing this function added was a link to page 8: a
 * confident pointer to the page the sentence exists to rule out. A regex cannot
 * tell an assertion from a denial, so it does not get to guess — it only links
 * pages something was demonstrably placed on.
 *
 * One link per distinct page: an answer that discusses page 7 four times does
 * not need four markers, and the first mention is where a reader looks.
 */
/**
 * A bare locator label the model left in its answer.
 *
 * `[s307]`, `[s307-s308]`, `[p4]`, `[heading2]` — handles `read_document` puts
 * in front of every sentence so a highlight can be placed by index.
 */
const STRAY_LOCATOR = /([ \t]*)(\n?)[ \t]*\[(?:s\d+(?:\s*[-–]\s*s?\d+)?|p\d+|heading\d+)\]([ \t]*)/g;

/**
 * A bare attachment id the model wrote as text.
 *
 * Measured across fifty-two answers, models wrap these seven different ways —
 * `[u-X]`, `(u-X)`, `（u-X）`, `` `u-X` ``, `*u-X*`, `[u-X ` and bare — so the
 * brackets are optional rather than part of the pattern. The lookarounds keep
 * it off an id already inside a tag, where it is quoted, and off anything with
 * a word character against it.
 *
 * The id itself is right — it is exactly what belongs inside a citation tag —
 * so the model has done the hard part and got the syntax wrong.
 */
const BARE_REFERENCE =
    /(?<!["'\w-])[[(（`*]{0,2}((?:u|g\d+)-[A-Z0-9]{6,10})[\])）`*]{0,2}(?![\w"'-])/g;

/**
 * Turn a bare id into a citation the reader can click.
 *
 * Converted rather than stripped, which is the opposite of what happens to a
 * locator: a locator names a sentence inside a document nobody downstream can
 * resolve, but `[u-GPQ4HIAG]` names the attachment itself, so the tag can be
 * rebuilt from it exactly. Observed filling a real answer — six in a single
 * bullet — every one unclickable and meaningless to a reader.
 *
 * Ids already inside a tag are left alone: this pattern requires square
 * brackets, and a tag writes the id in quotes.
 */
export function promoteBareReferences(answer: string): string {
    if (!answer) return answer;
    BARE_REFERENCE.lastIndex = 0;
    return answer.replace(BARE_REFERENCE, (_match, id) => `<citation id="${id}"/>`);
}

/**
 * A sentence locator the model wrote as prose, bracketed or bare.
 *
 * `[s307]`, `[s223-s225]`, `s223`, `s223–s225`, `s223-225` — with any of the
 * three dashes. The lookarounds keep it off ids already inside a tag (the tag
 * quotes them) and off words like "1980s" or "S11" (case-sensitive, and a
 * word character on either side disqualifies).
 */
const SENTENCE_LOCATOR =
    /(?<!["'\w-])\[?s(\d{1,4})(?:\s*[-–—]\s*s?(\d{1,4}))?\]?(?![\w"'-])/g;

/**
 * Turn a prose sentence locator into a citation the reader can click.
 *
 * Only possible when the run read exactly ONE document — the locator names a
 * sentence but not its paper, and guessing wrong would jump the reader into a
 * different PDF. With the document known, the rebuilt tag rides the whole
 * existing citation pipeline: hover preview, click-to-open, the temporary
 * highlight on the sentence's own boxes. A locator the model invented resolves
 * to no position downstream and degrades to a reveal, never an error.
 *
 * Ranges are normalised to the both-prefixed form (`s223-s225`): the grammar's
 * range parser requires the prefix on both ends.
 */
export function promoteBareSentenceLocators(
    answer: string,
    soleReadAttachmentId: string | null,
): string {
    if (!answer || !soleReadAttachmentId) return answer;
    SENTENCE_LOCATOR.lastIndex = 0;
    return answer.replace(SENTENCE_LOCATOR, (_match, a: string, b?: string) => {
        const loc = b ? `s${a}-s${b}` : `s${a}`;
        return `<citation id="${soleReadAttachmentId}" loc="${loc}"/>`;
    });
}

/**
 * Take the locator labels back out of the answer.
 *
 * The prompt says twice that they belong in tool arguments and never in prose,
 * and models write them anyway — measured across eighteen runs, at every
 * reasoning setting, a few answers each pass. They are worse than nothing to a
 * reader: `[s307-s308]` looks like a reference, points at nothing, and cannot
 * be clicked or looked up. A rule the model keeps breaking is a rule the code
 * should enforce.
 *
 * Stripped rather than converted: turning one into a citation needs the page
 * it fell on, and by the time the answer is rewritten the document that could
 * say so is no longer in hand. Removing it costs the reader nothing, because
 * the citation tags the model *did* place are what the passage is reachable
 * through.
 */
export function stripStrayLocators(answer: string): string {
    if (!answer) return answer;
    STRAY_LOCATOR.lastIndex = 0;
    /*
     * The whitespace around the label decides what replaces it.
     *
     * A label opening its own line keeps the line break; one sitting mid
     * sentence leaves a single space so the words either side do not run
     * together; one before punctuation leaves nothing, so "vanishes [s307]."
     * closes up rather than becoming "vanishes ."
     */
    return answer.replace(STRAY_LOCATOR, (_match, before, newline, after) => {
        if (newline) return '\n';
        return before && after ? ' ' : '';
    });
}

export function attachPageCitations(
    answer: string,
    readAttachmentIds: string[],
    linkablePages: number[],
): string {
    if (!answer || readAttachmentIds.length !== 1 || linkablePages.length === 0) return answer;
    const attachmentId = readAttachmentIds[0];
    const allowed = new Set(linkablePages);

    const linked = new Set<number>();
    const insertions: Array<{ at: number; tag: string }> = [];

    PAGE_MENTION.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAGE_MENTION.exec(answer)) !== null) {
        const page = Number(match[1] ?? match[2] ?? match[3]);
        if (!Number.isFinite(page) || page < 1 || linked.has(page)) continue;
        if (!allowed.has(page)) continue;

        const tag = `<citation id="${attachmentId}" page="${page}"/>`;
        if (answer.includes(tag)) {
            linked.add(page);
            continue;
        }

        // A marker already sitting on this mention means the model did place
        // one; leave its work alone.
        const after = answer.slice(match.index + match[0].length, match.index + match[0].length + 12);
        if (/^\s*[)\]]?\s*<citation/.test(after)) {
            linked.add(page);
            continue;
        }

        linked.add(page);
        // After the closing bracket when the reference is parenthetical, so the
        // marker does not land inside "(p. 7)".
        let at = match.index + match[0].length;
        while (at < answer.length && /[)\]]/.test(answer[at])) at += 1;
        insertions.push({ at, tag });
    }

    if (insertions.length === 0) return answer;

    let out = answer;
    for (const { at, tag } of insertions.sort((a, b) => b.at - a.at)) {
        out = `${out.slice(0, at)}${tag}${out.slice(at)}`;
    }
    logger(`attachPageCitations: linked ${insertions.length} page reference(s)`, 3);
    return out;
}


