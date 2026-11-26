/* eslint-disable no-undef */

// User ID and email
pref("userId", "");
pref("userEmail", "");
pref("currentPlanId", "");
pref("installedVersion", "");
// Set once the settings from an earlier plugin name were carried over; the
// pass never runs again, so a key deleted later stays deleted.
pref("legacyPrefsAdopted", false);
pref("showIndexingCompleteMessage", false);
pref("showHighTokenUsageWarningMessage", true);
// Long conversations: automatically summarize the oldest exchanges into a
// rolling note the model reads instead of the full replay. Local data and the
// visible history are never touched.
pref("contextCompactionEnabled", true);
// Trim tool-call detail (long arguments, oversized stored results) out of
// replayed history older than the last two runs. The current runs keep full detail.
pref("contextPruneOldToolDetail", true);
// Token weight of a run's first request (history + context) above which the
// automatic compaction may fire early, before the 8-run count rule.
pref("contextCompactionThreshold", 80000);
// Compact once MORE THAN this many exchanges sit uncompacted. The replay
// window holds 10, so the default summarizes exactly when it would overflow.
pref("contextCompactionAfterRuns", 10);
// Limits per question (Settings → Advanced → Limits per Question; see runLimits.ts).
// Output tokens one reply may spend, thinking included. 0 = the provider's own
// default; any value is held under what the provider accepts.
pref("maxOutputTokens", 0);
// Model requests one question may make; every tool step is one.
pref("maxModelRequests", 24);
// Topic, keyword and full-text library searches per question. 0 = no limit.
pref("maxLibrarySearches", 20);
// OpenAlex lookups per question, shared by its four tools. 0 = no limit.
pref("maxLiteratureLookups", 20);
// Which engine renders the message composer: "textarea" (native control, the
// caret cannot be disturbed by the host document) or "lexical" (rich
// contenteditable with inline pill chips). Applies on restart.
pref("composerEngine", "textarea");
pref("authMethod", "otp");

// App settings
pref("keyboardShortcut", "j");
pref("statefulChat", true);
pref("addSelectedItemsOnOpen", true);
pref("addSelectedItemsOnNewThread", true);
pref("addBeaverProvenanceNote", false);
pref("focusResponseForScreenReaders", false);
pref("annotationToolEnabled", true);
// Author name on annotations Beaver creates. Empty string = no attribution.
// Only affects new annotations. Reader-created annotations ignore this —
// Zotero stores no author for them.
pref("annotationAuthorName", "AlphainZ");

// How long a reasoning model may think before answering. "none" turns thinking
// off where the provider supports it. Thinking is spent from the same output
// budget as the answer, so a high setting on a long tool-using run can end the
// turn before the model has said anything — see localRunner's output_limit
// warning. One setting for every provider; a model that takes no effort
// (gpt-4o, a hand-added model left unticked) is simply sent none.
pref("reasoningEffort", "low");
pref("maxAddAttachmentToMessage", 10);
pref("readerExplainPrompt", "Explain the selected passage or annotation(s) from this paper in plain language. Provide context for any technical terms, statistical methods, or domain-specific concepts. If it references other work, briefly explain that context too.");

// Chat composer IME handling: on Windows, defer Lexical's composition-end
// processing until the composition's final input event (prevents IMEs such as
// Sogou Pinyin from discarding committed text). Kill-switch in case an IME
// interacts badly with the deferral.
pref("imeCompositionOrderFix", true);
// Verbose IME event tracing in the chat composer, for diagnosing composition
// issues from debug output.
pref("debugImeTrace", false);

pref("accessRemoteFiles", true);

// Data provider: keep a provider-wake subscription open while logged in so
// agent runs started from other Beaver clients can
// request library data from this Zotero on demand.
pref("dataProviderEnabled", false);

// Agent actions
pref("autoApplyAnnotations", true);
pref("autoCreateNotes", true);
pref("autoImportItems", false);
pref("confirmExtractionCosts", true);
pref("confirmExternalSearchCosts", true);
// Ask once per run before it spends credits, and the projected run total (in
// credits) above which the backend asks.
pref("confirmCredits", true);
pref("creditConfirmThreshold", 5);
pref("requestPlusTools", false);
pref("showDiffPreviewInNoteEditor", true);

// Show an OS-native system notification when an agent action needs approval
pref("enableSystemNotifications", true);

// Show an OS-native system notification when a response is complete and Beaver is not visible
pref("enableResponseCompleteNotifications", true);

// Deferred tool preferences: maps tool group to preference (always_ask, always_apply, continue_without_applying)
// Defaults are defined in react/atoms/deferredToolPreferences.ts and merged at load time.
// This pref only stores user overrides.
pref("deferredToolPreferences", "");

// AI settings
pref("customInstructions", "");
pref("googleGenerativeAiApiKey", "");
pref("openAiApiKey", "");
pref("anthropicApiKey", "");
pref("lastUsedModel", "");
pref("customChatModels", "[]");

// Search
pref("recentItems", "[]");

// Citation format: author-year or numeric
pref("citationFormat", "numeric");
pref("citationStyle", "http://www.zotero.org/styles/chicago-author-date");
pref("citationLocale", "en-US");
// When true, citation clicks create temporary PDF highlight annotations
// instead of using Zotero's native transient position highlight.
pref("useTemporaryCitationAnnotations", false);
// When true, in-text citations display PDF page labels (e.g., Roman numerals
// for front matter) instead of raw 1-based page numbers.
pref("usePageLabels", true);

// Custom Prompts (versioned format: { version, prompts }; each prompt has a stable id)
// Variables supported in prompt text: {{recent_items}}, {{recent_item}}, {{open_attachment}}, {{active_item}}, {{selected_items}}, {{current_collection}}
pref("customPrompts", '{ "version": 2, "prompts": [ { "id": "default-fit-research", "title": "How does this paper fit into my library?", "text": "How does this paper connect to the rest of my library? Does it support, challenge, or extend ideas in papers I already have? Write a short report that directly compares the paper to other research in my library including a comparison table. Use a Zotero note attached to the item.{{active_item}}", "requiresAttachment": false, "shortcut": 1 }, { "id": "default-discover-missing", "title": "What recent research am I missing?", "text": "Based on the topics of these recently added papers, search for external references that I might be missing. Focus on papers from the last two years that are relevant to my main research areas.{{recent_items}}", "requiresAttachment": false, "shortcut": 2 }, { "id": "default-organize-collections", "title": "Organize my recent additions", "text": "Review the papers I added in the last two weeks. Check what collections I have, then help me file these items into the appropriate existing collections based on their topics.", "requiresAttachment": false, "shortcut": 3 }, { "id": "default-review-metadata", "title": "Review and fix metadata", "text": "Check my 10 most recently added items for missing or incomplete metadata — especially DOIs for journal articles, publication info, and abstracts. Look up the correct information and help me fix any issues.", "requiresAttachment": false, "shortcut": 4 } ] }');

// Separate storage for prompt lastUsed timestamps (keyed by prompt id)
// Kept outside customPrompts so using a prompt doesn't dirty the main pref default
pref("customPromptsLastUsed", "{}");

// Actions V2 — two-layer architecture: built-in actions (in code) + user overrides/custom
pref("actions", '{"version":1,"overrides":{},"custom":[]}');
pref("actionsLastUsed", "{}");
pref("legacyPromptsImported", false);

// Deletion jobs
pref("deletionJobs", "[]");

// Items skipped during sync
pref("skippedItems", "[]")

// Onboarding popups
pref("onboardingWelcomeShown", false);
pref("onboardingReaderTipShown", false);
pref("onboardingReaderTipShownV2", false);
pref("onboardingNoteTipShown", false);
pref("onboardingCitationTipShown", false);
pref("onboardingWelcomeShownAt", "");
pref("versionUpdatePopupShownAt", "");
pref("onboardingSignInTextShown", false);

// Thread whose agent run was cut off when Beaver's WebSocket was closed at
// shutdown (JSON: threadId/userId/threadName/closedAt; userId is the Beaver
// account, so a record is never offered to a different one). Consumed and
// cleared by the "chat interrupted" popup on the next start.
pref("interruptedThread", "");

// Throttle for the automatic pre-sync thread claim: the
// `${beaverUserId}:${zoteroUserId}:${localUserKey}` combination that was
// last claimed successfully. Empty = never claimed (or cleared after
// logging out of the Zotero account so the next login can re-claim).
pref("threadsClaimKey", "");

// MCP server
pref("mcpServerEnabled", false);
pref("mcpCreateNoteToolEnabled", false);

// Background extractor kill-switch (drains the background_jobs queue)
pref("backgroundExtractorEnabled", true);

// Flags to show notifications, run consistency check and collection sync on upgrade
pref("runConsistencyCheck", false);
pref("runCollectionSync", false);
pref("runWebDAVSync", false);
pref("runEmbeddingFullDiff", false);
pref("pendingVersionNotifications", "[]");

// Library suggestions cache (JSON-encoded LibrarySuggestionsResponse + ISO timestamp)
pref("librarySuggestions", "");
pref("librarySuggestionsGeneratedAt", "");

// Account-scoped first-run assignment map, keyed by Beaver user id.
pref("firstRunAssignments", "{}");

// Largest attachment file, in MB, that Beaver will read
// for document extraction, page and image rendering, in-file search, and
// attaching an external file. It also decides which attachments count as
// readable at all, so raising it un-blocks oversized ones in the sidebar.
pref("maxAttachmentFileSizeMB", 100);

// ---------------------------------------------------------------------------
// Local model configuration (AlphainReader)
// ---------------------------------------------------------------------------
// The agent loop runs in this client and calls the model directly, so the
// endpoint and key live here rather than on an account.
//
// Keys in prefs are stored in plain text in prefs.js. That is a real
// limitation, and worth stating plainly: it is *comparable* to the alternative
// in this codebase, whose EncryptedStorage documents itself as obfuscation
// "not designed to protect against attackers with file system access". Anyone
// who can read the profile directory can read either one.

// Which endpoint to call: deepseek | openrouter | zhipu | google | openai | ollama | custom:<id>
pref("llmProvider", "");
// Model id. Empty means the provider preset's default.
pref("llmModel", "");
// Per-provider API keys. Only the one matching llmProvider is used.
pref("llmKeyDeepseek", "");
pref("llmKeyOpenrouter", "");
pref("llmKeyZhipu", "");
pref("llmKeyGoogle", "");
pref("fulltextIndexAuto", true);
// Index every PDF page as a picture too, when the embedding model takes pictures.
pref("pageImageIndexAuto", true);
pref("excludedLibraries", "[]");
pref("llmKeyOpenai", "");
// Free OpenAlex API key (openalex.org/settings/api) — literature search.
// OpenAlex requires one from Feb 2026; anonymous search is rate-limited.
pref("openalexApiKey", "");
// Ollama on this machine: where it listens, and the models `Detect models` found.
pref("ollamaBaseUrl", "http://127.0.0.1:11434");
pref("ollamaModels", "[]");
// What the endpoint said about each model reading images, per provider:model,
// with a timestamp — see src/services/llm/visionProbe.ts. Per computer.
pref("visionProbeCache", "{}");
// Endpoints the user added by hand, with the models filed under each — see
// src/services/llm/customEndpoints.ts. Carries keys, so it never syncs.
pref("customEndpoints", "[]");
// Per-provider edits to the built-in presets: an address override and a
// replaced model catalogue — see src/services/llm/providerOverrides.ts.
pref("providerOverrides", "{}");
// Base URL override, for a custom OpenAI-compatible endpoint or a local server.
pref("llmBaseUrl", "");

// Embedding endpoint for semantic search: openai | google | ollama.
// Empty disables semantic search, and the agent is told so rather than being
// left to read an empty result as "the library has nothing like that".
pref("embeddingProvider", "");
// A Google key for embeddings only. Empty means the Gemini card's key.
pref("embeddingKeyGoogle", "");
// The last embedding request that failed, and why, until one succeeds: what
// Settings and the chat warn about (src/services/llm/embeddingHealth.ts).
pref("embeddingHealth", "");
// What the Gemini API said about the embedding key's tier, and how much of the
// free tier's day the indexer has used (src/services/llm/embeddingQuota.ts).
pref("embeddingQuota", "{}");

// Model used for questions asked from the reader's selection popup. Empty means
// "same as the main model" — a separate one is worth having because a selection
// question wants a fast, cheap answer far more often than the sidebar does.
pref("llmSelectionProvider", "");
pref("llmSelectionModel", "");
// Write the answer into the highlight's Zotero comment without asking.
pref("selectionChatAutoComment", false);

// Let the agent write to the library: create highlights and notes. Off by
// default; only additive actions are ever offered, never deletions or
// overwrites, so anything the agent does can be undone by deleting it.
pref("allowAgentWrites", false);

// How the run's working steps are shown: expanded | collapsed | hidden.
// "collapsed" folds thinking, preamble text and tool calls behind one
// disclosure; "hidden" drops them from the transcript entirely. Approval
// requests are never affected — a decision that cannot be seen cannot be taken.
pref("streamDisplay", "collapsed");

// Bring a paper's own highlights in as sources when it is opened, alongside
// the PDF. Bounded by maxAddAttachmentToMessage: a heavily annotated paper
// would otherwise fill the composer with chips. The model is told the true
// total either way and can read the rest with `get_annotations`.
pref("addAnnotationsOnOpen", true);

// Mirror conversations into the Zotero library as JSON attachments, so
// Zotero's own sync carries them between machines.
// Legacy input only (v0.1.26 and earlier). Migrated once into
// conversationSyncBackend at startup; no longer written.
pref("syncThreadsToZotero", false);
// Conversation + settings sync backend: "" = not yet migrated (sentinel),
// then "off" | "zotero" | "folder". Machine-local; never carried by settings sync.
pref("conversationSyncBackend", "");
// Absolute path of the synced folder (folder backend). Machine-specific; never synced.
pref("conversationSyncFolderPath", "");
pref("conversationSyncLastAt", "");
// Wizard version last completed on this machine ("" = never). Local-only by design.
pref("welcomeWizardShownForVersion", "");
// exportedAt of the last settings envelope this machine wrote or applied (LWW stamp).
pref("settingsSyncStamp", "");

// Dev/eval switch: hides `search_library_fulltext` from the model so the
// same questions can be run with and without it. Users leave this alone.
pref("fulltextSearchEnabled", true);

// Appearance. `uiTheme` is one of the plugin's palettes: fresh, warm, quiet or sky
// ("zotero", Beaver's unthemed look, was the default before 0.1.78 and now reads
// as fresh); the rest are typography and apply in every theme.
pref("uiTheme", "fresh");
pref("uiFont", "system");
pref("uiFontSize", 13);
pref("uiLineHeight", "normal");
// "auto" follows Zotero; "light"/"dark" pin a custom theme to one palette.
pref("uiColorScheme", "auto");
// The interface language: "auto" follows Zotero's own (Chinese for a Chinese
// Zotero, English otherwise), "en" or "zh-CN" pins one.
pref("uiLanguage", "auto");
// The question rail at the right edge of a conversation: one mark per question,
// in place of the thread view's scroll bar. Off brings the scroll bar back; the
// outline button in the header shows either way.
pref("conversationRail", true);
