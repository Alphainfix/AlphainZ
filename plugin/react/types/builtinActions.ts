/**
 * Built-in actions — always shipped with the plugin.
 *
 * These are defined in code so they can be improved across updates without
 * being frozen by user edits. User overrides are stored separately in the
 * `beaver.actions` preference via ActionCustomizations.
 */

import { Action } from '@beaver/agent-core/types/actions';
import { ARCHIVED_ACTIONS } from './archivedActions';
import { msg } from '../../src/utils/i18n';



/** Default built-in actions for Beaver. */
export const BUILTIN_ACTIONS: Action[] = [

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: items (single or multiple selected items)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-summarize',
        name: 'summarize',
        title: msg('Summarize'),
        description: msg('Write a Zotero note summarizing each item so you can recall it at a glance.'),
        text: 'Summarize the attached item(s) so I can quickly recall what each says and decide whether to read it in full.\n\nSteps:\n1. Understand the content of each attached document. For shorter articles, read the full document. For longer articles or books, use the extract tool to create a detailed summary. If the extract tool is not available, read relevant sections of the attached document. If multiple items are attached, handle each separately and write one note per item, preferring the extract tool over reading each document in full.\n2. Match the summary to the document type: for empirical papers cover the research question, data and methods, key findings, and conclusions; for theoretical or review work cover the aim, main arguments, and contribution; for books cover the purpose, structure, and central claims.\n3. Save each summary as a Zotero note attached to the item.\n\nFormat: 200-400 words with short bold section headings and prose under each (no bullet lists). Support every substantive claim with citations to specific passages in the document.\n\nIf no full text is available, base the summary on the abstract and metadata and say so at the top of the note. If my message names a specific focus, emphasize it.',
        argumentHint: msg('Optional: what to focus on, e.g. methods or findings'),
        targets: ['items', 'attachment'],
        category: 'write',
        sortOrder: 100,
    },

    {
        id: 'builtin-fit-research',
        name: 'fit-into-library',
        title: msg('How does this fit into my library?'),
        description: msg('Position this paper against the rest of your library. What it supports, challenges, and extends.'),
        text: 'Show me how this paper relates to the rest of my library.\n\nSteps:\n1. Identify the paper\'s core question, method, and main claims. The abstract is often enough; read the full text only for a short article. For a long document or book, use the extract tool if available (ask for the research question, methods, and main findings) instead of reading it end to end. Otherwise read the introduction and conclusion.\n2. Search my library from several angles — same topic, same method, same phenomenon. To compare against the most relevant matches, use the extract tool if available to pull each one\'s question, method, and findings; otherwise read their most relevant passages.\n3. Write the result as a Zotero note attached to the item.\n\nThe note should contain: a short paragraph positioning the paper within my library; what it builds on or supports, what it challenges or complicates, and what it extends; a comparison table (paper, relationship, key difference); and a closing sentence on what this paper adds that my library did not already have. Cite every library paper you mention.\n\nIf little in my library relates to it, say so directly instead of forcing weak connections, and note that this paper opens a new area for me. If multiple items are attached, handle each in turn.',
        argumentHint: msg('Optional: what to compare, e.g. argument, method, or findings'),
        targets: ['items', 'attachment'],
        category: 'research',
        sortOrder: 110,
    },

    {
        id: 'builtin-find-similar',
        name: 'find-similar',
        title: msg('Find similar papers'),
        description: msg('Search for research outside of your library to find closely related work.'),
        text: 'Find papers closely related to this item.\n\nSteps:\n1. Identify what makes this paper distinctive: its topic, method, data or population, and central claim. The abstract and metadata are usually enough; for a long document without a useful abstract, use the extract tool if available instead of reading it.\n2. Run external searches from more than one of those angles so the results are not one-dimensional. Use `search_web_literature` for these — it needs no key and is always available. Never present library results as if they were new work found outside it.\n3. Check which results are already in my library.\n\nFormat: a ranked list of up to 8 papers. For each, give authors (year), title, and one sentence on why it is relevant. Clearly mark the papers I already have, and cite the rest as external references so I can add them. If you fell back to searching my library, say so at the top and mark every result as one I already have.\n\nIf the item has no abstract or full text, work from the title and metadata and say so. If my message names a specific kind of similarity (same method, same data, competing argument), prioritize it. If multiple items are attached, handle each separately.',
        argumentHint: msg('Optional: similar how, e.g. method, data, or theory'),
        targets: ['items', 'attachment'],
        category: 'research',
        sortOrder: 120,
    },

    {
        id: 'builtin-tag-items',
        name: 'auto-tag',
        title: msg('Auto-tag'),
        description: msg('Assign consistent Zotero tags to the selected items, reusing your existing tags.'),
        text: 'Assign tags to the attached items.\n\nSteps:\n1. Look at my existing tags first and reuse them wherever they fit, matching my style and level of granularity.\n2. Work from each item\'s abstract and metadata and assign 2-5 subject tags covering the topic and, where clear, the method. Many items have no abstract: tag those from the title where the topic is clear, and open the attachment only for a handful of genuinely ambiguous ones — do not try to read full text across a large batch.\n3. Be consistent: items on the same subtopic must share the same tags. Create a new tag only when nothing existing fits, and keep new tags lowercase and 1-3 words.\n\nWhen done, show a table of items and their assigned tags, marking newly created tags so I can spot vocabulary drift. Cover every attached item, and if any were tagged from the title alone or left untagged, list them explicitly instead of presenting the job as complete.',
        targets: ['items'],
        category: 'organize',
        sortOrder: 140,
    },

    {
        id: 'builtin-sort-into-collections',
        name: 'sort-into-collections',
        title: msg('Sort into collections'),
        description: msg('File the selected items into the collections where they best belong.'),
        text: 'File the attached items into my existing collections.\n\nSteps:\n1. Review my collections (including sub-collections) to understand how my library is organized.\n2. Add each item to the collection or collections where it clearly belongs — the best one or two, not every plausible match. Never remove an item from a collection it is already in.\n3. If an item fits no existing collection, do not force it: list it separately and suggest a sensible new collection name for it.\n\nWhen done, show a table of items and where each was filed, with the no-fit items and suggested new collections at the end.',
        targets: ['items'],
        category: 'organize',
        sortOrder: 150,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: attachment (PDF/EPUB open in reader or selected)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-skim-paper',
        name: 'skim',
        title: msg('Skim this paper'),
        description: msg('Add highlight annotations to key passages so you can grasp the paper in a few minutes.'),
        text: 'Help me skim this document by highlighting only what I need to read to get the gist.\n\nSteps:\n1. Find the passages that carry the document: the central argument and contribution, the data and methods, the main findings, and the key conclusions. For non-empirical work (theory, review, book chapter), target the central claims, the key evidence they rest on, and the conclusions instead. Read a short article in full; for a long document or book, do not read it end to end — locate the key sections first (with the extract tool or in-attachment search, if available) and read only those pages.\n2. Create 4-8 highlight annotations of 2-3 sentences each. Prefer the body of the document over the abstract and introduction, which I can skim myself. Be extremely selective — reading only the highlights should take a few minutes.\n3. End with a short structured summary: **Central argument and contribution** — 1-2 sentences citing the relevant highlights — then the same for **Data and methods**, **Main findings**, and **Conclusions**, adapting the headings if the document type requires it.\n\nIf my message names a specific focus, weight the highlights toward it.',
        argumentHint: msg('Optional: what to focus on while skimming'),
        targets: ['attachment'],
        category: 'annotate',
        sortOrder: 108,
    },

    {
        id: 'builtin-color-code',
        name: 'color-code',
        title: msg('Color-code this paper'),
        description: msg('Add color-coded highlights for question, methods, results, and limitations.'),
        text: 'Color-code this document with highlight annotations so I can navigate it at a glance:\n- Yellow: the research question, aim, or central argument\n- Green: data and methods\n- Blue: main results and findings\n- Purple: limitations, caveats, and open questions\n\nIf the document has no empirical sections (theory, review, essay), adapt the legend — yellow for central claims, green for the evidence or literature supporting them, blue for implications, purple for limitations — and state the adapted legend in your summary. If my message specifies a different scheme, use mine.\n\nFollow these rules:\n- If the attachment already has more than 4 annotations, check the existing annotations first and skip any that are already there.\n- Be selective: highlight only short, high-signal passages (1-3 sentences each) in the main body, and skip background and literature review.\n- Add a brief comment to each highlight noting what it captures.\n- For long books, do not read it end to end — locate the key sections first (with the extract tool or in-attachment search, if available) and work from those.\n\nWhen finished, write a short summary organized by color (🟨, 🟩, 🟦, 🟪): state the legend, then 1-2 sentences per color citing its annotations.',
        argumentHint: msg('Optional: your own color scheme or focus'),
        targets: ['attachment'],
        category: 'annotate',
        locked: true,
        sortOrder: 105,
    },

    {
        id: 'builtin-extract-references',
        name: 'key-references',
        title: msg('Find key references from this paper'),
        description: msg('Identify key references in this paper, and whether you already have them.'),
        text: 'Identify the references this paper most depends on, so I can decide what to read next.\n\nSteps:\n1. Pick the 3-5 cited works that are genuinely load-bearing: foundational to its argument, the source of its method or data, or the main position it argues against. Judge by the role each reference plays in the text, not by how often it is cited. Read a short article in full; for a long document, focus on the framing sections and the bibliography, and use the extract tool (if available) or in-attachment search to see how the key works are actually used.\n2. For each key reference, explain in 1-2 sentences what role it plays in this paper.\n3. Search my library to check whether I already have each one. For the ones I am missing, look them up with `lookup_work` — it resolves known references by title, DOI, or ISBN and does not need external search — and cite them as external references so I can add them.\n\nFormat: a numbered list with the reference, its role in the paper, and whether it is already in my library. If the bibliography is not readable (e.g. a scanned PDF), say so and work from the citations you can read in the text.\n\nExample output:\n 1. **Davis (ed.)**, *Policing the Black Man: Arrest, Prosecution, and Imprisonment* (2018) <citation id="1-XKL32LOP"/> — In your library.\n Supplies the paper\'s central framing of disparate policing outcomes; the argument builds directly on its account of how discretion compounds at each stage of the process.\n Key passages: <citation id="1-ABC123D4" loc="s86-88"/> <citation id="1-ABC123D4" loc="s176-177"/>\n 2. **Smith**, *A Theory of Discretionary Enforcement* (2023) <citation external_id="W2141613219"/> — Not in your library (added as an external reference so you can import it).\n The main position the paper argues against; its model of enforcement as neutral is the foil the authors spend the second half rebutting.\n Key passages: <citation id="1-ABC123D4" loc="s23-24"/> <citation id="1-ABC123D4" loc="s298"/>\n [additional references]\n [short recap]\n',
        targets: ['attachment'],
        category: 'research',
        sortOrder: 230,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: collection (a collection is selected in sidebar)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-collection-gaps',
        name: 'find-gaps',
        title: msg('What am I missing in this collection?'),
        description: msg('Analyze this collection and suggest papers that fill its most important gaps.'),
        text: 'Analyze this collection and tell me what is missing.\n\nSteps:\n1. Survey the collection: the topics, methods, populations or cases, time periods, and perspectives it represents.\n2. Identify 2-4 specific gaps — subtopics, methods, or viewpoints that the collection\'s own scope implies but does not cover. Anchor each gap in what the collection is evidently about; do not invent adjacent topics.\n3. For each gap, use external search to find strong papers that would fill it. Also check whether good candidates are already in my library but outside this collection. Use `search_web_literature` for this — it needs no key and is always available. Never invent a DOI or a title in order to look it up — look up only references you have actually seen.\n\nFormat: organize by gap. For each, give 1-2 sentences on what is missing and why it matters, then the suggested papers (up to 8 total across all gaps), each with a one-sentence rationale, cited as external references. Mark any suggestion that is already elsewhere in my library.\n\nIf the collection is small (under about 5 items), say the analysis is provisional and interpret its scope generously.',
        argumentHint: msg('Optional: what kind of gaps to look for'),
        targets: ['collection'],
        category: 'research',
        sortOrder: 400,
    },

    {
        id: 'builtin-collection-literature-review',
        name: 'literature-review',
        title: msg('Literature review outline'),
        description: msg('Draft a thematic literature-review outline from the papers in this collection.'),
        text: 'Create a literature review outline from the papers in this collection.\n\nSteps:\n1. Review every paper in the collection: abstracts for all of them, and — if the extract tool is available — use it across the collection to pull each paper\'s core argument, approach, and findings. Read closely only the few papers central to the debates you identify.\n2. Group the papers thematically, never chronologically or paper-by-paper. Identify the key debates, the points of consensus, and the open questions.\n3. Propose the outline as a Zotero note in this collection.\n\nThe note should contain: a working title; a one-paragraph framing of the field; one section per theme with a heading, 3-5 sentences in prose on the state of that theme (who argues what and where the disagreement lies), and citations to the collection papers that belong there; and a closing section on the open questions the review should end on. Write in prose — no bullet points or numbered lists. Every paper in the collection should appear somewhere; if some genuinely fit no theme, list them at the end with a brief note on why.\n\nIf my message says what the review is for (a dissertation chapter, a paper introduction, a grant application), shape the outline to that purpose.',
        argumentHint: msg('Optional: what the review is for, e.g. a paper intro or dissertation chapter'),
        targets: ['collection'],
        category: 'write',
        sortOrder: 410,
    },

    {
        id: 'builtin-collection-organize-sub-collections',
        name: 'organize-sub-collections',
        title: msg('Organize into thematic sub-collections'),
        description: msg('Propose and create thematic sub-collections for the items in this collection.'),
        text: 'Organize the items in this collection into thematic sub-collections.\n\nSteps:\n1. Review the items and any existing sub-collections. Reuse existing sub-collections whenever they fit.\n2. Design a scheme of roughly 3-7 sub-collections with clear, mutually distinct themes and reasonably balanced sizes. Prefer themes that reflect how the material would actually be used, not surface keywords. If my message specifies an organizing principle (by method, by period, by debate), use it.\n3. Lay out the proposed scheme in your message first — each sub-collection with an item count and 2-3 example items. State it as your recommendation and keep going; do not stop to ask me to confirm it, since I approve the changes themselves as you call the tools. Ask me a question only if the scheme turns on a choice you genuinely cannot make for me (e.g. which organizing principle to use), and then ask that one question with the concrete alternatives as options.\n4. Propose the new sub-collections, each with the items that belong in it — one `create_collection` call per sub-collection, passing its `item_ids`. Items that fit nowhere stay where they are — list them at the end rather than forcing them in.\n\nFinish with a summary of the final structure.',
        argumentHint: msg('Optional: how to organize, e.g. by theme, method, or time period'),
        targets: ['collection'],
        category: 'organize',
        sortOrder: 430,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: global (no specific context, library-wide)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-start-project',
        name: 'start-project',
        title: msg('Start a research project'),
        description: msg('Create a new Zotero collection and populate it from your library and external search.'),
        text: 'Set up a new research project in my library.\n\nSteps:\n1. Confirm the scope: restate the project topic in one sentence. If I did not name a topic, or it is too broad to search well, ask me a clarifying question before continuing.\n2. Create a new collection with a short, descriptive name for the project.\n3. Search my library from several angles for items relevant to the topic and add the clearly relevant ones to the new collection. Do not remove them from any other collection.\n4. If available as a tool, use 1-3 external topic searches to find important papers on the topic that are not yet in my library. Use the create_items tool to import the most relevant ones directly into the new collection. Your external search should be broad and cover multiple angles to ensure full coverage particularily if my own library does not have a lot of material on the topic.\n5. Close with a short, structured summary: the collection you created, how many existing items you added, and the key external papers you imported. Use bold formatting to clearly structure the short summary and make it readable to the user. End with suggestions for next steps such as "**Next step:** If you want, I can create a zotero note with a high-level overview of the relevant literature."',
        argumentHint: msg('Name the project or research topic'),
        targets: ['global'],
        category: 'research',
        locked: true,
        sortOrder: 505,
    },

    {
        id: 'builtin-whats-new',
        name: 'discover',
        title: msg('Discover new research'),
        description: msg('Find notable recent or influential papers in your area that are not yet in your library.'),
        text: 'Find notable research I should know about in my area of interest.\n\nStep 1. Determine the focus: if I named a topic or question, use that. Otherwise, infer what I am currently working on from my most recent \nadditions. If there are multiple plausible topics, proceed with the most likely one and note the alternatives in your response; only ask me to choose when you genuinely cannot tell which I mean.\n\nStep 2. Run 1-2 parallel topic searches in my own library to understand what I already have in my library.\n\nStep 3. Run 2-3 external topic searches to find notable work in this area outside of my library. Use `search_web_literature` for these — it needs no key and is always available. Never invent a DOI or a title in order to look it up. Prioritize a mix of recent papers (last 2-3 \nyears) and influential work I appear to be missing. Return up to 8 papers not yet in my library ranked by relevance. For each, provide the \nauthors, publiation year, title, journal name, citation count (if available), and one sentence on why it matters to me. Always cite the external \nreference using a citation tag so I can add the ones I want. Do not add anything to my library. Just present the list.\n\nFormat your final response like this:\n\n[Short, high-level overview of what you found]\n\n1. **Smith (2019)**. Title of reference. *Name of Journal* (citations: X)\n[1-2 sentence on why this reference is relevant ending with a citation to the item]\n\n2. ... (repeat for up to 8 references)\n\n**Recap**: [End with a short recap of what you found and how it fits into my current work]',
        argumentHint: msg('Name a topic or research question'),
        targets: ['global'],
        category: 'research',
        locked: true,
        sortOrder: 510,
    },

    {
        id: 'builtin-annotate',
        name: 'annotate',
        title: msg('Annotate'),
        description: msg('Create targeted highlight annotations across a document or your whole library.'),
        text: 'Propose highlight annotations based on my request.\n\nSteps:\n1. Determine the scope:\n   - If I have a document open or attached, work within that document.\n   - If my request names a topic across my library (for example, "all definitions of social capital"), search my library to find the relevant documents first. When the target is clear — a document is open or attached, or my request names specific passages or a specific topic — proceed. Ask me to confirm the scope first only when it is genuinely ambiguous, such as a library-wide request with no clear target.\n2. Locate the matching passages and propose a highlight on the 1-3 sentences that actually match, each with a short comment explaining why it matters. Use in-attachment search or the extract tool (if available) rather than reading each document end to end. Be selective — a few precise highlights beat many loose ones.\n3. Write a structured summary of what you are proposing (see format below).\n\nFormat the summary as a clear, scannable overview, not a long write-up:\n- Open with one sentence stating the scope and how many highlights you are proposing across how many documents.\n- Then one section per document, each with a bold heading (the document title). Under each heading, give 2-4 sentences in prose describing what you are proposing there and why it matters, citing each passage inline so I can click straight to it. Keep it tight; do not restate every highlight verbatim.\n- If only one document is involved, skip the per-document headings and give a single short section.\n- Close with a **Recap** that ties the highlights together. When multiple documents are involved, this recap must compare across them: where they agree, differ, or complement each other, and what the overall picture is. When only one document is involved, use the recap to state the single most important takeaway.\n\nKeep the whole summary readable at a glance: bold headings, short prose, no walls of text.',
        argumentHint: msg('What should I highlight? E.g. "the methods" or "every mention of selection bias"'),
        targets: ['global'],
        category: 'annotate',
        sortOrder: 515,
    },

    {
        id: 'builtin-create-note',
        name: 'create-note',
        title: msg('Create a Zotero note'),
        description: msg('Write a Zotero note on a topic, synthesized and cited from your library.'),
        text: 'Write a Zotero note on the topic I describe, grounded in my library.\n\nSteps:\n1. If the topic is clear from my message, proceed. If it is unclear, restate your best interpretation in one line and continue unless it is genuinely ambiguous or missing — in which case ask one brief clarifying question first.\n2. Search my library from several angles. Use the extract tool (if available) to pull what each relevant paper says about the topic; otherwise read the most relevant passages. Do not write from titles and metadata alone.\n3. Write a clear, well-structured note that synthesizes what my library says about the topic: a short title, a brief opening that states the takeaway, then sections in prose. Cite specific papers and specific passages where possible for every substantive claim.\n4. Where my library\'s evidence is thin, conflicting, or missing, say so explicitly in the note instead of papering over it. Do not assert anything you cannot support from my library.\n5. Propose the result as a new Zotero note.',
        argumentHint: msg('What should the note be about?'),
        targets: ['global'],
        category: 'write',
        sortOrder: 520,
    },

    {
        id: 'builtin-tidy-up',
        name: 'tidy-up',
        title: msg('Tidy up my library'),
        description: msg('Find what needs organizing (unfiled items, tags, or metadata) then clean it up.'),
        text: "Help me tidy up my library. Work in four steps.\n\nStep 1 — Explore. Find what actually needs attention without changing anything yet. Use `list_collections` and `list_tags` to see how I organize, `list_items` with 'sort_by': 'dateAdded', 'sort_order': 'desc', 'limit': 20, 'item_category': 'regular' for what I added recently, and `get_metadata` on those to spot missing abstracts or DOIs. `item_search_by_topic` and `item_search_by_metadata` find items by subject or by field. Note whether I use tags at all, whether I use collections at all, and any collection that has outgrown itself.\n\nStep 2 — Choose what to do first. If my message already said what to focus on, use that. Otherwise decide for yourself: weigh how I actually organize against the messes you found, pick the 1-2 highest-impact tasks, and go straight to Step 3 — do not stop to ask. Open your Step 3 summary with one line naming what you are starting with and noting that I can redirect you. Examples worth prioritizing:\n- File the unfiled items into collections where they clearly belong\n- Assign tags to items that have none\n- If I barely use tags: design a small, consistent tag vocabulary and apply it to a batch\n- If a collection has outgrown itself: split it into thematic sub-collections\n\nStep 3 — Do the work. Work through a manageable batch (about 20 items) so the run stays reviewable; if more remain afterward, say so. Decide from metadata alone wherever you can — do not read full text across a batch.\n- Filing and tagging both go through `organize_items`: pass the item ids together with `add_tags` and/or `add_to_collections`, batched rather than one call per item. Collections are named by the key `list_collections` returns, never by their title.\n- A collection that does not exist yet goes through `create_collection` with `item_ids`, which creates it and files the items in one proposal.\n- Reuse my existing tags wherever they fit; keep new ones lowercase and 1-3 words. Assign 1-4 subject tags per item.\n- Never take an item out of a collection it is already in unless I asked you to.\n- You cannot edit metadata fields, rename or delete tags, or delete anything. If the main mess is missing abstracts or DOIs, say so and list the items rather than pretending to fix them.\nNothing is written when you call these tools: each one registers a proposal I approve after your answer is finished, so keep going without waiting, and describe what you are proposing rather than what was done.\n\nFinish with a compact summary grouped by item so I can review what you proposed.\n\nStep 4 — Suggest a next step. Based on what you saw, offer one useful follow-up and wait for me to confirm before doing it — the next batch, the next task, or a kind of mess you have not looked at yet.",
        argumentHint: msg('Optional: what to focus on (e.g. filing, tags, or metadata)'),
        targets: ['global'],
        category: 'organize',
        locked: true,
        sortOrder: 530,
    },

    // Uncategorized: not shown on the homepage launcher, available from the
    // slash menu. A quick, tool-free answer for definitions and clarifications.
    {
        id: 'builtin-quick',
        name: 'quick',
        title: msg('Quick answer'),
        description: msg('Answer a quick question directly, with no tools or library search.'),
        text: 'Answer my question directly from your own knowledge. Do not call any tools (no library search, no web search, no document reading, no metadata or file lookups). Keep the response concise and conversational rather than a full research answer.',
        argumentHint: msg('Quick question, no detailed research'),
        targets: ['global'],
        sortOrder: 560,
    },

];

/**
 * Complete built-in base list: active actions plus deprecated tombstones from
 * `archivedActions.ts`. Use this — not `BUILTIN_ACTIONS` — wherever built-in
 * identity or override merging matters (merge loops, `isBuiltinAction`,
 * override diffing), so customizations of retired actions keep resolving
 * against their full default definition.
 */
export const ALL_BUILTIN_ACTIONS: Action[] = [...BUILTIN_ACTIONS, ...ARCHIVED_ACTIONS];
