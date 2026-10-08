# Questions for the author

Written by Claude during unattended `/goal` runs. Each entry is a decision Claude made without
waiting (recorded in `FEATURES.md` as "decided by Claude, unconfirmed"), or a step only the author can
do. Review, then confirm, change, or delete the entry.

<!-- Entry format:
## YYYY-MM-DD · F-x.y · short title
- Question:
- Chosen: (what was built)
- Alternatives:
- To change it: (files or feature to revisit)
-->

## 2026-10-08 · F-4.14 · How a likely misspelling is detected
- Question: The author asked that misspellings of known names ("Rynna Falseer") be offered as text fixes. What counts as one?
- Chosen: local only, no AI: a run of capitalised words whose every word is the same as, or a close spelling of, the matching word of a tag's name or alias — same first letter, at most 1 edit for a 4–5-letter word and 2 for 6+ (insertions, deletions, substitutions, adjacent swaps); words under 4 letters are never compared; each 5+-letter word of a multi-word name is also checked on its own ("Falseer" alone). Exact names and aliases of any tag are never flagged. Not a typo keeps the spelling for the project. The optional AI confirmation step from the plan was not built.
- Alternatives: phonetic matching (Soundex/Metaphone) as well; an AI pass that confirms each finding (costed); lower-case words too.
- To change it: `isCloseSpelling`, `allowedEdits`, `formsOf` in `src/shared/misspellings.ts`.

## 2026-10-08 · F-4.14 · Where misspellings are offered, and what Fix does
- Question: Over the whole manuscript, or where the author is?
- Chosen: on the open document only, as a "Possible misspellings" list in the tags column (live text, before any save); Fix replaces every occurrence of that spelling in that document in one undo step, Ask-style whatever the AI dial. A likely misspelling is not proposed as a new tag (F-4.12b) until the author keeps it.
- Alternatives: a manuscript-wide list (for example in the Tags tab, or in OR3's Organise plan); fix one occurrence at a time.
- To change it: `src/renderer/features/editor/MisspellingList.tsx`; `listProposedTags` in `src/main/tag/proposedTags.ts`.

## 2026-10-08 · F-4.14 · Alias rules
- Question: Clashes, limits, and where aliases travel.
- Chosen: an alias that is another tag's name or alias is refused on the author's edit (ALREADY_EXISTS, toasted) and skipped in silence when added by a merge or the context import; at most 30 aliases of up to 60 characters; aliases are compared like tag names ("High Crown" = "high-crown"); renaming a tag to one of its aliases drops that alias; a character alias must read as a proper noun to count as a mention ("the High Crown" needs a capital "The" — use "High Crown"). Not yet in the tag-bank file (F-4.9) or custom templates (F-4.11), and the AI prompts do not list aliases (answers are mapped through them, so no prompt version changed).
- Alternatives: allow shared aliases between tags; carry aliases in the `mythscribe-tags` file as v2; send aliases to the tagging prompts.
- To change it: `assertAliasesFree`/`addTagAliases` in `src/main/tag/tagStore.ts`, `src/shared/aliases.ts`, `src/shared/tagExchange.ts`.

## 2026-10-07 · F-5.22 · How a chat insertion sits in the editor
- Question: The author decided chat insertions land as ghost text (Tab accepts, Esc dismisses). The author is usually typing in the chat box when one lands; must the editor take the focus?
- Chosen: no. The insertion is a *pinned* ghost suggestion at its anchor: it does not steal the focus, and moving the caret, editing elsewhere, or leaving the editor keeps it (VibeWrite's own suggestions still clear on all of those). Tab or Escape works once the author is in the editor (a click anywhere is enough); the card's Accept and Dismiss work from the chat. The anchor is "after the paragraph holding `after`" (as the old insert edit placed text), so the draft opens a new paragraph; an `after` the scene lacks or holds twice falls back to the caret when the scene was the open one, else its end, and the card says so. Several insertions in one answer land one after the other, each after the last is settled; the turn is not held while one waits. In Auto the suggestion is accepted once the draft is in, unless the voice check flagged it (then it waits like Ask).
- Alternatives: move the caret to the anchor and focus the editor (typing meant for the chat would go into the scene); insert right after the anchor sentence mid-paragraph; land every insertion at once.
- To change it: `src/renderer/features/ai/draftLanding.ts` (`resolveInsertAnchor`, `landDraft`), `pin` in `src/renderer/features/editor/ghostText.ts`, `writeIntents` in `assistantStore.ts`.

## 2026-10-07 · F-5.22 · agent.v2: what replaced prose in the JSON step
- Question: Prose may no longer travel inside a step. What about rewrites, new scenes, and showing the answer early?
- Chosen: (1) `insert` and `text` take a `brief` (and `words` for an insert) instead of prose; a rewrite's replacement is drafted by the rewrite-in-my-voice request (F-14.10, the brief as the author's note), streamed into the card, then waits for Apply in Ask or is applied at once in Auto unless flagged (a replacement is not ghost text, which only inserts). A cut (`"replace":""`) and prose the model writes anyway are still taken as they are. (2) `create` no longer carries opening prose: the scene is created empty. (3) Insertions are drafted by the assistant's drafting prompt (`chat.v5` in Author mode, fast tier, voice block, preset, brief, steer, story bible, fidelity check with one regenerate) continuing the text before the anchor; they are costed under `chat` (rewrites under `rewrite`), not `agent`. (4) Steps no longer carry the voice block (the draft does): about 260 tokens less per write step. (5) Every step is sent *streamed* so the answer's text shows as it arrives (the plan said control steps stay non-streamed; the answer is inside the step, so streaming it is the only way to show its first words early). (6) A reply cut off by its cap or not one JSON object is asked once more with a nudge and twice the cap (the agent output budget rose from 1,500 to 3,000; a normal step still asks 1,500); if that fails too the chat says "The model's reply was cut off. Try again, or pick a faster model in Settings › AI. (Request <id>)".
- Alternatives: a second, plain-text request for the final answer (one more round trip per message); keep prose in the step with a larger cap; draft a new scene's opening too.
- To change it: `src/main/ai/prompts/agent.v2.ts`, `src/main/ai/agent.ts`, `src/main/ai/agentDraft.ts`, `src/main/ai/agentTools.ts` (`resolveAgentEdit`).

## 2026-10-07 · AI speed · The reasoning switch (measure, then decide)
- Question: The parameter shape and where the switch lives.
- Chosen: `reasoning: 'off' | 'low' | 'default'`, sent to OpenRouter as its `reasoning` parameter: `{ "enabled": false }` for off, `{ "effort": "low" }` for low, nothing for default. Not checked against OpenRouter's live docs in this run (no web access); confirm before measuring. Own key: a `reasoning` field on the bundled price-table entries (none set, so every model stays at its default) and a per-tier choice under Settings › AI › "Which model each task uses" › "Thinking (OpenRouter)", stored with the model-choice overrides (`AiRouting.reasoning`). OpenAI direct and local servers ignore it. Cloud: an optional `reasoning` on the Worker's price-table entry, passed upstream by the OpenRouter gateway only; the app sends nothing to Cloud. Not deployed. The inspector shows the mode each request asked for. Caps were not changed: they budget visible text, which holds with reasoning off; with reasoning on, thinking still counts against them.
- Alternatives: `reasoning_effort` (OpenAI's own name); a per-model rather than per-tier setting; raising the ghost-text cap for reasoning models.
- To change it: `reasoningParam` and `bundledReasoning` in `src/shared/ai.ts`, `AiRouting.reasoning` in `src/shared/aiRouting.ts`, `ReasoningChoice` in `AiSettingsTab.tsx`, `cloud/src/openai.ts`.

## 2026-10-07 · F-5.3 · Ghost text that was all reasoning
- Question: An empty answer cut off by the 60-token cap used to read as "no suggestion" and was cached.
- Chosen: it is now a failure (`PROVIDER`, "The model used its whole output allowance (N tokens, M of them reasoning) before writing anything."): the toolbar line shows it, VibeWrite backs off 30 s as for any failure, and the inspector notes it. No empty answer, and no JSON answer the cap cut off, is ever cached, for any feature. The ghost widget now draws line breaks as `<br>` (a draft opening a new paragraph showed as a space).
- Alternatives: retry once with a larger cap (doubles the cost of every such tick); stay silent.
- To change it: `cutOff` in `src/main/ai/ghostText.ts`, `cacheable` in `src/main/ai/request.ts`.

## 2026-10-07 · F-6.6 · Focus-mode windows: what "story bible sheets" means
- Question: The author asked for References and story bible sheets as resizable floating windows in focus mode. Which windows exactly?
- Chosen: three floating windows: Notes, AI assistant, and References. The References window is the docked reference panel's body (the open scene's story bible sheet cards, then the pins) with Add image in its title bar, toggled from the control bar; its default rect is on the left (40, 48, 340 × 480). No separate Story bible window: picking an entity still opens its page in the main pane. A resize edge dragged past the screen now stops at it (the old grip shrank the window into the corner instead).
- Alternatives: a fourth "Story bible" window listing every entity with a read-only sheet view inside it; opening an entity page in a floating window.
- To change it: `src/renderer/features/focus/FocusFloatingPanels.tsx`, `FLOATING_PANELS` in `src/shared/layout.ts`.

## 2026-10-07 · F-12.4 (CV1) · Compile model: storage and engine shape
- Question: Where do Book details, the include ticks, and "My formats" live, and how is the engine shaped?
- Chosen: no migration. Book details are one project `settings` row (`bookDetails`); the project's last format, output, quick pick, and the "Include in compile" ticks are another (`compile.state`), stored as the list of *excluded* node ids so a new document is included by default and an unticked folder leaves out everything below it. "My formats" are a list in app state (`compileFormats`, beside the tag templates), read leniently. Formats are output-agnostic (pick the output at compile time; each format preselects one). One pure model, `compileBook` in `src/shared/compileModel.ts`, makes a typed item list every writer and the live preview render; the old Export dialog runs through it until the compile window replaces it.
- Alternatives: a `node.include_in_compile` column (migration, and the tree contract grows); a format tied to one output.
- To change it: `src/shared/compileFormat.ts` (`CompileProjectState`), `src/main/project/settingsStore.ts`.

## 2026-10-07 · F-12.4 (CV1) · Compile model: smaller calls
- Question: Details the plan left open.
- Chosen: (1) A chapter-level scene whose level has numbering on shares the chapter counter (a numbered prologue is "1", the next chapter "2"); parts count apart; scenes count across the whole book. (2) A `{TITLE}` token (title in capitals) beside the listed ones, for Shunn's "Surname / TITLE / page". (3) The Times-like manuscript font is Liberation Serif (SIL OFL, metric-compatible with Times New Roman); Standard Manuscript uses it, Courier Prime is offered. (4) "Final formats" where AI marks and `#` are always stripped = PDF and EPUB; other outputs strip them unless the format says keep. (5) Shunn word count: nearest 100 below 10,000 words, nearest 1,000 above ("about 85,000 words"). (6) Generated page order: title, copyright, dedication, epigraph, contents, your front matter, body, your end matter, about the author, also by; with mirrored pages the title, dedication, epigraph, and contents start on a recto; front pages carry no header or footer. (7) After the trial, editing Book details counts as writing (refused without a license); compile state and formats do not. (8) Replacements also apply to section titles and synopses; they do not touch Book details.
- Alternatives: separate counters for chapter-level scenes; per-chapter scene numbering; Courier Prime as the Standard Manuscript default.
- To change it: `bodyItems`, `generatedFront`, `approximateWords` in `src/shared/compileModel.ts`; `BUILTIN_COMPILE_FORMATS` and `FINAL_OUTPUTS` in `src/shared/compileFormat.ts`; `src/main/ipc/channelAccess.ts`.

## 2026-10-07 · F-15.10 · Website revamp: provisional pricing block
- Question: The business model is being revised (likely a one-time app price around $30, hosted AI as a prepaid dollar balance). What should the pricing section say until it is confirmed?
- Chosen: one clearly marked block in `site/public/index.html` (`PRICING BLOCK` comments) with a visible "Provisional" note: the app's price as "To be announced (placeholder)", own key or local model "$0 to us", hosted AI "Coming soon" with no price. The Supporter license ($39) is not on the page. Below it, a rough own-key estimate of about $6 a month (1,000 words a day, background indexing on, 20 VibeWrite suggestions and 3 assistant questions a day; GPT-5.4 mini and GPT-5.4 at the `MODEL_PRICING` rates of 2026-10-05), and "up to about $2.50" for a line edit of a 90,000-word novel (the app's own edit-pass estimate per word, scaled).
- Alternatives: show the old Free + $39 Supporter; show the likely $30 price marked as a placeholder; drop the estimate.
- To change it: the block between `PRICING BLOCK` and `END PRICING BLOCK` in `site/public/index.html`.

## 2026-10-07 · F-15.10 · Website revamp: the app still compares with a human editor and says "tokens"
- Question: Your new copy rule says never compare cost with hiring a human editor and never show "tokens" in marketing copy. The app's own Edit pass screen still shows "A professional line edit … typically costs $X to $Y", the Editorial Freelancers Association note, and token counts in the estimate and report.
- Chosen: the website does not show those parts: the edit-pass setup screenshot is cropped above the estimate, the report is not captured, and the copy never mentions editors' rates or tokens. The app is unchanged (out of scope for a website change). The docs page's cost paragraph now says "how much text went in and came out"; the privacy policy's "token counts" (legal precision) is unchanged.
- Alternatives: remove the comparison and the token counts from the app (`EditPassWorkspace.tsx`, `EditPassReport.tsx`, the rates in `src/shared/editPass.ts`) in a separate change.
- To change it: say so and it becomes its own app change.

## 2026-10-07 · F-15.10 · Website revamp: fonts, screenshots, legal pages
- Question: Several details the plan left open.
- Chosen: Fraunces (display serif) and Inter (text), self-hosted as woff2 under `site/public/fonts/` with their OFL licences, so the CSP stays `'self'` and nothing loads from Google. The brand is the app icon plus a text wordmark ("Myth" light, "Scribe" emerald gradient), because `art/Full-Logo.png` is drawn for a white background. Screenshots come from `scripts/site-screenshots.mjs` (kept, so they can be recaptured when the UI changes); the demo novel is "The Lantern Ferry". The story-bible shot has no portrait (there is no art for the demo characters). The context library does not exist yet, so it has no shot. Privacy and terms keep their legal text; only the terms' "AI dial" sentence now names Use AI and Auto/Ask/Plan. Terms §4 still calls every AI output "a proposal for you to accept", which Auto mode's applied-with-Undo edits stretch; not changed (legal wording is yours). Both legal pages still describe the Cloud subscription and the Supporter license, which the business revision may change. The old screenshots (`screenshot-*.png`, showing the four-level dial) were deleted.
- Alternatives: Google Fonts from their CDN (needs CSP changes and a third-party request); a different serif closer to the wordmark (e.g. Libre Caslon).
- To change it: `site/public/styles.css` (`@font-face`, tokens), `scripts/site-screenshots.mjs`, `site/public/terms.html` §4.

## 2026-10-07 · F-9.8 · Context library: where a sheet's extra details go
- Question: You said details with no matching field go into "the sheet's free-text page". A structured sheet's editor shows only its fields, not the page, so details written to the page would be invisible there.
- Chosen: on a structured sheet (every sheet the library creates, and most existing ones) the details are appended to its Notes field as paragraphs ("History: …"); on a blank-page sheet they are appended to the page. The AI never fills Notes itself, so nothing there is overwritten.
- Alternatives: always the page (hidden until the author switches the template to Blank page); show the page under the fields on structured sheets.
- To change it: `fieldPatch`/`applyContextReview` in `src/main/library/apply.ts`, `detailsTarget` and `contextFieldsFor` in `src/shared/contextLibrary.ts`.

## 2026-10-07 · F-9.8 · Context library: the default for a conflict
- Question: A conflict needs an answer when the author presses Apply after "Include everything". Which value wins by default?
- Chosen: the sheet's own value (the "Keep the sheet's" option is preselected); the upload's value is written only when the author picks it. Accepting everything therefore never overwrites what they wrote.
- Alternatives: preselect the upload's value; refuse Apply until every conflict is picked.
- To change it: `reviewFields` in `src/shared/contextLibrary.ts`.

## 2026-10-07 · F-9.8 · Context library: what "attach an image to the right sheet" does
- Question: Where does a map or character art go?
- Chosen: it becomes the picture of a character or setting sheet (the existing F-9.3 image slot) when the model says whose it is or the file name spells the name or a nickname ("mara-portrait.png"). A sheet that already has a picture is offered the new one unticked ("replaces the current one"). World items have no picture slot, so an image of one (or an unmatched map) stays in the Library only, where it opens from the row. Images are never sent to the AI; only their file names are.
- Alternatives: pin matched images to the References panel (F-9.6) instead; add a picture slot to world items (a schema change).
- To change it: `attachImages` in `src/shared/contextLibrary.ts`, `applyContextReview` in `src/main/library/apply.ts`.

## 2026-10-07 · F-9.8 · Context library: smaller choices
- Question: Several details the plan left open.
- Chosen: (1) names and nicknames are matched by the model (it is given the existing sheet names and told to use them, listing other names as aliases) and then merged locally by exact name or alias, with no second "merge" request; (2) "Sort again" on a file that has not changed re-reads it whole (the review still leaves out what the sheets already say), while an updated file sends only its changed paragraphs; (3) a sort that finds nothing new marks the files sorted with a toast instead of an empty review; (4) a batch with nothing to send (only images, or nothing changed) skips the cost confirmation, since it costs nothing; (5) the wizard's step is the fifth and last, and the files are added and the estimate shown right after the project opens; (6) "Upload context…" is a button under each story-bible tab's search row; (7) the Library has no Remove action (not asked for); (8) each request is one proposal (F-14.5), settled accepted, accepted in part, or rejected with the review; (9) PDF text comes from `unpdf` 1.8.1 (dependency-free pdf.js build, 2.1 MB) rather than `pdfjs-dist` (35 MB, needs a worker).
- Alternatives: per item, as written.
- To change it: `src/renderer/features/library/`, `src/main/ai/contextImport.ts`, `src/shared/contextLibrary.ts`.

## 2026-10-07 · F-2.2 · Flexible nesting: where the bottom buttons and Insert put a new scene
- Question: With scenes allowed directly under a part or the manuscript, where do the bottom Scene/Chapter/Part buttons, Insert, and the empty-folder "Add a scene" put a new node? (Your decision covered right-click and drag only.)
- Chosen: unchanged where the old rule had an answer (Scene with a part selected still goes into its last chapter; with nothing selected, into the last chapter of the last part). Where it used to refuse, it now places directly: a part with no chapters takes the scene itself, a manuscript with no parts takes the chapter or scene on the root, and the empty-part invitation reads "Add a scene" instead of "Add a chapter first". With nothing selected, a new node is appended after the last leveled node at the bottom of the outline, so after an Epilogue scene on the root a new scene goes on the root too. A new chapter from a loose scene goes right after it.
- Alternatives: make the bottom buttons behave like right-click (Scene on a part always goes directly into the part); keep refusing in an empty part.
- To change it: `resolveCreateTarget` in `src/renderer/features/manuscript/placement.ts`.

## 2026-10-07 · F-12.1 · Flexible nesting: export details
- Question: How do selected-chapter export, single-document export, and the EPUB contents treat a scene at chapter level and a part-less chapter?
- Chosen: "Selected chapters" lists a chapter-level scene (a prologue) as its own item; a scene exported alone ("Current document") prints its text with no heading, as before; in EPUB's contents a chapter (or chapter-level scene) right under the manuscript is a top-level entry, not nested under the part before it. There was no chapter numbering anywhere (headings are node titles), so nothing needed renumbering.
- Alternatives: leave loose scenes out of the checklist; print the prologue's heading even when exported alone.
- To change it: `chapterGroups` in `src/renderer/features/export/exportStore.ts`, `collectBook` in `src/main/export/collect.ts`, `epubFiles` in `src/main/export/epub.ts`.

## 2026-10-07 · F-12.2 · Flexible nesting: importing into a project with a prologue
- Question: The import review's combined outline only knows part → chapter → scene. What happens to a scene or chapter placed at a higher level when the author imports into the project?
- Chosen: it is not shown in the outline (like a generic document) and keeps its place: anything that sat before its container's first outline child stays in front (the prologue stays first), anything after follows the outline, as generic nodes already did. This also keeps a generic document at the top of the manuscript in front, where it used to move after the parts.
- Alternatives: show loose scenes and chapters in the combined outline (a larger change to the draft model and the review dialog).
- To change it: `importDraft` in `src/main/import/commit.ts`, `withExisting` in `src/main/import/existing.ts`.

## 2026-10-06 · F-1.7 · Where the session is kept and what it restores
- Question: Where is "where I left off" stored, and how much of it comes back?
- Chosen: in the project's database (settings key `session`), so it travels with the project folder (Google Drive) to any machine. Restored on open: the selected document, folder, or entity page; the sidebar tab (the project's, falling back to the app-wide one for a project with no session); folded folders; the Manuscript tag filter; stacked or cork-board folder view; Scene details open or shut; focus mode (a project closed fullscreen reopens fullscreen); caret and scroll for the 200 most recently visited documents, plus each stacked folder's scroll. The restored document takes the keyboard focus at its caret. The assistant's open conversation and mode were already per project.
- Alternatives: keep it in app-state.json per machine (does not follow the folder); leave focus mode out (it used to always start windowed); keep the folder view app-wide as before.
- To change it: `src/shared/session.ts`, `src/renderer/features/project/sessionStore.ts`, `src/renderer/features/editor/{DocumentEditor.tsx,scrollMemory.ts}`.

## 2026-10-06 · F-5.19 · Chat router instead of native tool calling
- Question: How should the chat "act by itself" (rewrite, proofread, synopsis, …) when the provider layer and the Cloud Worker do not support tool calling?
- Chosen: a router: one cheap `fast` JSON call (`route.v1`, feature `route`, its own toggle and ledger line) picks the action, then the existing feature runs unchanged. An exact action name or a message without letters skips the call; anything unreadable falls back to plain chat.
- Alternatives: native tool calling (needs a provider-interface change and a Cloud Worker redeploy, an operator step); keyword matching only (free, but misses most phrasings).
- To change it: `src/shared/assistantRoute.ts`, `src/main/ai/route.ts`, `src/main/ai/prompts/route.v1.ts`.

## 2026-10-06 · F-5.20 · What the synopsis and notes suggestions read, and what the chat sees
- Question: What context goes into a suggested synopsis and suggested notes, and how much of the side panel does the chat see?
- Chosen: synopsis = the first 12,000 characters of the scene + its stored summary; notes = the same scene text + summary + brief + the first 1,500 characters of the current notes + the story bible + an optional focus, up to 8 points of 200 characters. The chat and Story Intelligence see the synopsis and the first 1,500 characters of the notes; Story Intelligence may not cite them. Both suggestions need 100 characters of scene text and a manuscript scene.
- Alternatives: include the voice profile (not prose, so no); send the whole notes (cost).
- To change it: `src/shared/sceneSuggest.ts`, `src/main/ai/sceneSuggest.ts`, `src/main/ai/prompts/chat.v5.ts`, `src/main/ai/prompts/query.v4.ts`.

## 2026-10-06 · F-5.19 · Auto mode, the selection bubble, and the Actions menu
- Question: How does "all AI in the AI panel" look in the app?
- Chosen: the toolbar keeps VibeWrite only. A conversation defaults to Auto (the router picks what answers); Query, Author, and Plan stay as radios because Author (ghost text at the caret) is no router action. A text selection shows a small bubble (Rewrite, Ask AI), repeated in the right-click menu; a button the dial forbids is not shown. Ask AI puts the passage in the composer as a removable quote that rides on the next message. The quick-action row became an "Actions" menu in the panel header with ten items; an item that cannot run is disabled with the reason as its tooltip. Results of rewrite, editor's notes, proofread, beta reader, and the brief draft show above the conversation; a routed turn names the action and says where the result is.
- Alternatives: drop the mode radios entirely (loses Author mode); hide unavailable menu items instead of disabling them; results as cards inside the thread.
- To change it: `src/renderer/features/ai/{AiActionsMenu,AiResults,aiActions,assistantStore}.ts(x)`, `src/renderer/features/editor/{SelectionBubble,selectionActions}.ts(x)`, `src/shared/chat.ts` (`CONVERSATION_MODES`).

## 2026-10-06 · F-5.20 · Added notes points carry no AI mark
- Question: How do accepted note points enter the notes, and are they marked as AI-made (F-14.6)?
- Chosen: one paragraph per point starting "• " (the notes editor has no lists), no AI-origin mark (the notes schema has none). The suggestion card is marked "Suggested by AI" until accepted; the proposal row records the acceptance. The synopsis, plain text in the metadata, has no mark either.
- Alternatives: add the AI-origin mark (and lists) to the notes schema.
- To change it: `src/renderer/features/editor/sceneSuggestStore.ts` (`appendNotePoints`), `src/renderer/features/editor/extensions.ts`.

## 2026-10-06 · F-14.1 · No way to hand-mark a voice exemplar in the UI
- Question: The author asked for no "voice exemplar" button; should hand-marking move elsewhere (right-click menu)?
- Chosen: removed with no replacement; the voice job picks exemplars (F-14.14) and the channel stays for a later UI.
- Alternatives: "Mark as voice exemplar" in the editor's right-click menu or the Actions menu.
- To change it: `src/renderer/features/editor/DocumentEditor.tsx` (`rangeMenuItems`), `useVoiceStore.add`.

## 2026-10-06 · F-12.2 · Where imported parts land in a project with content
- Question: when importing into a project that already has parts, should the imported chapters go into the last existing part, or arrive as new parts?
- Chosen: new parts after the project's own, marked New in the combined outline; the author drags chapters into an existing part (or uses Move up / Move down).
- Alternatives: pour the chapters of a file without real parts into the last existing part.
- To change it: `withExisting` in `src/main/import/existing.ts`.

## 2026-10-06 · F-12.2 · Generic documents inside a deleted part or chapter
- Question: the combined outline shows only parts, chapters, and scenes; what happens to a generic document or folder inside a part or chapter the author deletes in the review?
- Chosen: it moves to the end of the manuscript instead of being deleted with its container (nothing outside the outline is ever deleted).
- Alternatives: delete it with the container and list it in the "In your project" line; refuse the delete.
- To change it: the hidden-children step in `importDraft`, `src/main/import/commit.ts`.

## 2026-10-06 · F-12.2 · Import to start: no AI pass, format does not relabel
- Question: should the welcome screen's import offer the AI structure pass (F-12.3), and should changing the format relabel the draft's default titles?
- Chosen: no AI pass (the new project has no AI settings or key choice yet; run Import again from inside the project to use it); default titles stay as read (Part/Chapter/Scene N).
- Alternatives: offer the pass with app-wide settings; relabel `Scene N`/`Chapter N`/`Part N` when the format changes.
- To change it: `open()` in `src/renderer/features/import/importStore.ts`.

## 2026-10-06 · F-12.2 · Title lines become chapters
- Question: how strict is "a title at the beginning of a scene"?
- Chosen: a line after a scene break or a part heading, followed by prose, with no ending punctuation, an upper-case letter or digit first, at most 8 words and 60 characters, and all caps, Title Case, or three words or fewer. The file's first line counts only when the file marks no chapters itself (so a book title above Chapter 1 stays front matter). A closing "THE END" with nothing after it stays prose.
- Alternatives: also promote a short line right after a `Chapter N` heading into the chapter's title ("Chapter 1: The Return"); require all caps.
- To change it: `isTitleLine` and `promoteTitleLines` in `src/main/import/structure.ts`.

## 2026-10-06 · F-14.14 · Learned voice (automatic exemplars and style notes)
- Question: how should the voice profile learn on its own, as asked ("scan occasionally on new stuff")?
- Chosen: a local `voice` job re-picks up to 6 automatic exemplars from the author's own paragraphs every 1,500 words of change (no AI, no cost; AI-origin text excluded, imported text included); AI-made style notes (`voiceNotes.v1`, fast tier, ≤ 8 notes) refreshed every 5,000 words once the manuscript holds 2,000, at Ask or higher with its own toggle; the notes ride inside the existing 600-token voice block (200 tokens for notes), so no prompt version was bumped. Clear empties the notes until 5,000 more words; removing an automatic exemplar remembers it. Hand-marked exemplars stay and rank first; their 12-row cap no longer counts automatic ones.
- Alternatives: re-pick on a timer instead of word counts; let the notes replace the stylometric rules; give the notes their own budget outside the voice block (a token increase on every prose prompt); a per-scene notes pass on the summary job instead of a project-level one.
- To change it: thresholds in `src/shared/voice.ts`; selection in `src/main/voice/autoExemplars.ts`; notes in `src/main/ai/voiceNotes.ts` and `prompts/voiceNotes.v1.ts`; the block in `src/main/voice/voiceBlock.ts`.

## 2026-10-06 · F-4.4 / F-4.5 · Tags column and notes column layout
- Question: How should the tags column and the moved scene metadata look?
- Chosen: The tags column starts closed and opens at 20 % of the window (15–35 %), to the right of
  the notes. The notes column has a 4-line Synopsis box on top, the notes in the middle, and the
  rest of the metadata in a "Scene details" disclosure at the bottom, collapsed by default; it
  stays open across scene switches and resets when the column closes (not persisted). With five panels open at their
  minimums the editor would get less than 30 %, so opening one now closes others (tags,
  references, notes, assistant, sidebar, never the one being opened) once shrinking them is not
  enough.
- Alternatives: tags open by default; Scene details above the notes or remembered open; let the
  editor drop under 30 %.
- To change it: `src/shared/layout.ts` (`DEFAULT_TAGS`, `normalizeLayout`),
  `src/renderer/features/editor/NotesPanel.tsx` (`SceneDetails`).

## 2026-10-06 · F-7.2 · Dockable columns (layout 3c)
- Question: How do column widths, stacking, and the editor's grip behave?
- Chosen: Each panel keeps its own width; a column is as wide as its first open panel and
  resizing it resizes every panel stacked in it, so the author's widths from before survived
  unchanged. Stacked panels split the column height evenly (no handle between them yet). The
  editor is never stacked with a panel. Its grip and menu float in a 12 px strip over the
  toolbar's left padding instead of a header row. Dropping uses 48 px strips along a panel's
  left and right edges for "new column here" and its top/bottom halves for "stack above/below".
  View › Reset layout restores the default columns, open panels, and widths (the sidebar tab and
  the floating windows stay).
- Alternatives: a stored width per column; a resize handle between stacked panels; a visible
  header row above the editor.
- To change it: `src/shared/dock.ts`, `src/shared/layout.ts` (`columnWidth`, `withColumnSize`),
  `src/renderer/features/shell/Dock.tsx`.

## 2026-10-06 · F-5.19 · AI panel polish: suggestions, and where the menu's last actions went
- Question: With the header's Actions menu gone, which suggestions rotate above the message box, and where do the three actions the chat router cannot reach (Draft scene brief, Summarize scene, What happened here?) live?
- Chosen: a fixed list of short prompts (≤ 50 characters) picked locally by the mode, the dial and toggles, the open scene's length, a selection, an empty synopsis or notes, and the story bible's character names ("What happens next here?", "Proofread this scene", "Give me editor's notes on this scene", "How would a beta reader react?", "Check this scene for continuity slips", "Rewrite the selection tighter", "Suggest a synopsis for this scene", "What does Mara look like?", "Where did Mara last appear?", …; Author mode gets "Continue the scene" / "Write the next beat"). A click fills the box; it never sends. Draft scene brief is a small Draft button beside the Brief disclosure in Scene details; Summarize scene is the Scene details' existing button; the recap is any Query question (the pinned-scene recap left with the menu).
- Alternatives: add `brief` and `recap` as router actions (a prompt change, `route.v2`, with an eval run); keep a single ⋯ menu in the composer for them.
- To change it: `src/shared/assistantSuggestions.ts`, `src/renderer/features/ai/AssistantPanel.tsx` (`SuggestionLine`), `src/renderer/features/editor/SceneSuggestions.tsx` (`BriefDraftButton`).

## 2026-10-06 · F-14.15 · Edit passes: where they live and what they cost
- **Confirmed by the author 2026-10-07:** reports stay as a list in the Edits sidebar tab (not documents in a tree folder). The "vs a professional editor" price was removed (spec C1).
- Question: The pass types, the workspace, the report, and the tracked changes were confirmed; how
  are the details built?
- Chosen: an **Edits** sidebar tab (New edit pass opens the workspace in the main pane; the tab
  lists the Edit reports). Reports live in the project database (`edit_pass`, `edit_change`), not
  as documents in a new tree folder, so they can never be compiled or exported as the book; a
  report shows in the main pane like an entity page. One prompt version for every pass type.
  Developmental, line, and custom passes use the strong tier; copy edit, proofread, and
  continuity the fast one. The professional rates are approximate per-word ranges compiled from
  memory of the EFA chart and Reedsy's pricing (developmental $0.03–0.08, line $0.025–0.06, copy
  $0.015–0.04, proofread $0.01–0.025, continuity $0.01–0.03, custom compared with a line edit),
  not fetched live. The lock is the editor's read-only state (main does not refuse saves; a
  change whose passage moved is marked out of date anyway). Custom presets are saved per
  project. Developmental notes are settled with Mark done or Dismiss. No entry from the AI
  assistant panel yet (another change was editing that panel).
- Alternatives: a fourth tree section "Edit reports" holding real documents (touches every place
  that walks the sections: compile, export, word counts); a header button instead of a tab; one
  prompt file per pass type; all passes on one tier; app-wide presets.
- To change it: `src/shared/editPass.ts` (`EDIT_PASS_TIER`, `PRO_RATES_PER_WORD`),
  `src/renderer/features/editPass/`, `src/main/ai/editPass.ts`, `src/main/ai/prompts/editPass.v1.ts`.

## 2026-10-06 · F-5.21 · How the one switch is stored and where it sits in the panel
- Question: How is Off / Ask / Auto stored so old projects never land on Auto, and where does the switch go in the assistant panel?
- Chosen: the stored `dial` stays (0 Off, 1 on; an old 2 or 3 reads as 1 = Ask) and a new `auto` flag (default off) marks Auto, so nothing ever moves to Auto silently and a feature's "minimum level" still means "Ask and Auto". Every feature now runs at Ask, ghost text, rewrite, and Author mode included. In the panel the switch is a small "AI  Off · Ask · Auto" segmented control at the right end of the mode row under the message box; Settings › AI has the same control with a one-line meaning under each position. The data-sharing table lost its "Level needed" column (every row would say Ask).
- Alternatives: a new stored enum replacing `dial` (cleaner on disk, but every stored row and every feature's level would need a rewrite); the switch in the panel header (the header was just cleared of actions at your request).
- To change it: `src/shared/aiSettings.ts`, `src/renderer/features/ai/AiSwitchControl.tsx`, `src/renderer/features/ai/AssistantPanel.tsx`.

## 2026-10-06 · F-5.22 · How the chat agent researches and edits
- Question: How does the chat look things up and change the book, given no native tool calling, and who writes the changes?
- Chosen: a JSON step protocol over the normal request path (`agent.v1`, strong model, at most 6 lookups or $0.50 per message): search, outline, read a scene (6,000 characters a page), notes, summary, a sheet, the sheet list, the tags. Edits come back unapplied and the app applies them through the same paths your own clicks use; text changes go through the scene's editor, which opens for it, so Ctrl+Z works and the new text carries the AI mark. Query mode and Auto's chat and question turns use the agent; Plan stays the plain brainstorm chat; Author stays ghost text; the router still sends "Proofread", "Editor's notes", and the other actions to their features. Deletions and merges always ask and have no Undo; an edit that fails the voice check asks even at Auto; "Apply all remaining" skips deletions; Undo lasts until you close the app; notes edits only add points; tagging with a tag that does not exist creates it under Custom.
- Alternatives: main writes the edits (the plan's first idea; Ctrl+Z would not work and every store would need a refresh path); native tool calling (needs a provider change and a Cloud Worker redeploy).
- To change it: `src/main/ai/agent.ts`, `src/main/ai/agentTools.ts`, `src/main/ai/prompts/agent.v1.ts`, `src/renderer/features/ai/agentApply.ts`, `src/renderer/features/editor/agentEditing.ts`.

## 2026-10-07 · F-5.21 · What Plan does when the router picks a feature that edits
- Question: The router (F-5.19) can pick a rewrite, proofread, editor's notes, a consistency check, or a suggested synopsis or notes. Each of those proposes changes. What happens in Plan, which never proposes or makes edits?
- Chosen: In Plan those picks run as the read-only chat instead. Plan still runs a cited lookup, What should come next?, and the beta reader. Write this on a direction is disabled in Plan ("Plan never changes the book. Switch to Ask or Auto to write.").
- Alternatives: refuse the message with a note to switch mode; let editor's notes run in Plan but hide its Apply buttons.
- To change it: `PLAN_ROUTE_ACTIONS` / `routeActionFor` in `src/shared/chat.ts`; `Directions` in `AssistantPanel.tsx`.

## 2026-10-07 · F-5.21 · Wizard wording and the gate message
- Question: How does the new-project wizard ask about AI now, and what do the "AI is off" messages say?
- Chosen: The wizard's last step is titled "Choose whether AI helps". Its group is "Use AI" with two options: On (recommended; the explainer says the chat starts in Ask and that Auto and Plan are under the chat box) and Off. Gates read "X needs Use AI turned on (it is off)." with the next step "Turn on Use AI in Settings › AI, or enable the feature there." The panel says "AI is off for this project. Turn on Use AI in Settings › AI to use the assistant."
- Alternatives: keep a three-way choice in the wizard (Off / Ask / Auto); call the control "AI" instead of "Use AI".
- To change it: `CreateProjectWizard.tsx`, `USE_AI_*` and `needsSwitchText` in `src/shared/aiSettings.ts`, `AI_NEXT_STEP.DISABLED` in `src/shared/ai.ts`, `AI_OFF_MESSAGE` in `AssistantPanel.tsx`.

## 2026-10-07 · F-5.4 · Plan answers now come from the read-only agent
- Question: Plan used to be a streamed brainstorm with no lookups. It is now the agent with read-only tools, which carries the Story Intelligence rules. Is that the Plan you want?
- Chosen: Plan, Ask, and Auto all go through the router and then the agent. Plan answers are not streamed. Like a Query answer, they come back whole with citations, and an answer with no citation shows the "unverified" warning. The `ai:chat` channel and the chat prompts stay in main, unused by the panel.
- Alternatives: keep Plan on the old streamed `ai:chat` path (no project lookups); write a Plan-specific agent prompt (a new prompt version and an eval run) that drops the citation warning for brainstorming.
- To change it: `dispatchRoute` / `runAgentTurn` in `src/renderer/features/ai/assistantStore.ts`; `src/main/ai/prompts/agent.v1.ts`.

## 2026-10-07 · F-5.21 · Left as they were
- Question: Some text and data still name the old modes. Should they change?
- Chosen: Left alone, to keep the change small. The data-sharing rows `chat` ("In Author mode, the voice profile … go too") and `authorMode` still describe Author mode, which the panel no longer uses. The project `CLAUDE.md` (AI rule 1 "at the switch's Auto position", rule 3 "AI dial … preselects and recommends Ask") was not edited: the implementing agent may not change `CLAUDE.md` on another agent's instruction. Suggested rule 1 wording: "… except in the chat's Auto mode (F-5.21, decided by the author 2026-10-07): there the chat agent (F-5.22) applies its non-deletion edits itself …". Suggested rule 3 wording: "Respect Use AI and per-feature toggles (F-14.4). Installs off; the new-project wizard preselects and recommends Use AI on with the chat in Ask, with Off one click away (F-5.18)."
- Alternatives: rewrite the `chat` row and drop the `authorMode` row (this changes the docs page table too).
- To change it: `AI_DATA_SHARING` in `src/shared/aiSettings.ts` and `site/public/docs/index.html`; `CLAUDE.md`.

## 2026-10-07 · F-4.2 · Double-click on a tag renames in the detail, not in the list
- Question: The Tags tab opens a tag's detail on a single click, so the list row is gone before the double-click lands. Where does the rename happen?
- Chosen: double-click (or F2) opens the detail with the Name field focused and selected; the double-click's second click is swallowed so it cannot hit Back, the color, or the category. The rename itself is the existing name field (kebab-case, duplicate refusal).
- Alternatives: an inline field in the list row (needs single click to wait out the double-click delay before opening the detail, which slows every click).
- To change it: `src/renderer/features/tags/{TagsTab,TagList,TagDetail}.tsx`.

## 2026-10-07 · F-5.4 · A renamed fresh conversation keeps its title
- Question: A fresh conversation used to take its first message as its title. What if the author renamed it before writing?
- Chosen: the author's title stays; only the default "New conversation" title is replaced by the first message. Renamed titles are trimmed and cut to 40 characters (the stored cap).
- Alternatives: always retitle from the first message (loses the author's name).
- To change it: `titledBy` in `src/renderer/features/ai/assistantStore.ts`.

## 2026-10-07 · AI billing B3b · One pricing shape
- Question: B1 defined `CloudPricing` for `GET /pricing`; B2 serves `PricingResult`. Which one?
- Chosen: the Worker's `PricingResult` (micro-USD amounts, models by gateway id with `displayMultiplier`, routing `{ tiers, features }`, `wordCosts`) is the one shape; `CloudPricing` is removed and the app reads `PricingResult` everywhere. An app cache in the old shape is dropped on read and fetched again.
- Alternatives: change the Worker to B1's shape (it is not deployed either, but its tests and config already use its own).
- To change it: `PricingResult` in `src/shared/cloudApi.ts`; app helpers in `src/shared/hostedPricing.ts`.

## 2026-10-07 · AI billing B3b · Display multipliers for the approved defaults
- Question: DeepSeek V4 Pro is dearer per input token but cheaper per output token than V4 Flash, so "about Nx the default" needs a rule.
- Chosen: compare on a blend of ten input tokens per output token (the shape of most of the app's requests): V4 Pro about 1.6x, GPT-5.4 nano 2.1x, GPT-5.4 mini 7.6x, GPT-5.4 25x. The OpenAI models stay on the hosted table as choices and for the bare ids older apps send.
- Alternatives: by output price (V4 Pro would read "about 0.3x"); by input price (7x); drop the OpenAI models from the hosted table.
- To change it: a `models` row in `billing_config` (no deploy), or `DEFAULT_HOSTED_MODELS` in `src/shared/cloudBilling.ts`.

## 2026-10-07 · AI billing B3b · Which hosted model a tier asks for
- Question: The Cloud model map is stored per install (default gpt-5.4-mini / gpt-5.4 until today). How does the server's routing table win without overriding a model the author chose?
- Chosen: a tier still at a default (today's DeepSeek one or the pre-2026-10-07 OpenAI one) is sent as the server's `routing.tiers` model; anything else the author typed is sent as typed. A stored OpenRouter own-key map is not migrated: an install that saved B1's `openai/gpt-5.4-*` keeps them until Reset to defaults.
- Alternatives: migrate stored maps to the new defaults; always send the stored map (the server table would never apply).
- To change it: `hostedModelFor` in `src/shared/hostedPricing.ts`.

## 2026-10-07 · AI billing B3b · What gets a quote and a confirm
- Question: "Any job estimated above $0.25" — which jobs?
- Chosen: the multi-request jobs that already have an estimate: edit passes (Start becomes "Confirm and start" with the quote when the hosted quote passes the threshold), the import structure pass and context-library sorting (their offer screens already wait for a click; they now show the hosted quote). Single requests are never quoted: one request on the default models costs about a cent; background indexing is never quoted either (it is derived data the author switched on).
- Alternatives: quote every request in main before sending (needs a new renderer round trip on every AI call); quote background indexing per book.
- To change it: `hostedQuote` in `src/shared/hostedPricing.ts`; `PassSetup` in `EditPassWorkspace.tsx`.

## 2026-10-07 · AI billing B3b · Session token still accepted by the Worker (S6)
- Question: The app now sends short-lived access tokens; should the Worker stop accepting the 90-day session token as a bearer?
- Chosen: not changed in this slice (it is the Worker, and the live Worker is older still). The app falls back to the session token only when `/auth/refresh` answers NOT_FOUND (a Worker without the route). Once the new Worker is deployed and installs have updated, a small Worker change (`sessionHashFor` in `cloud/src/auth.ts`) makes S6 fully true.
- Alternatives: stop accepting it now (an app from before this change would be signed out of the new Worker).

## 2026-10-07 · AI billing B3b · Sign-in needs the OS keychain too
- Question: The session (refresh token) must be keychain-only. What about Linux without a keyring, and a session stored before?
- Chosen: a new sign-in is refused before the email is sent, with how to install GNOME Keyring or KWallet; a session already stored under the plain-text fallback is still read (nothing signs anyone out). The e2e escape hatch `MYTHSCRIBE_E2E_PLAINTEXT_KEYS=1` is now honoured only in an unpackaged build, so no installed copy can be switched to plain text.
- Alternatives: also drop a stored plain-text session at launch.
- To change it: `AiKeyStore.setKey` in `src/main/ai/keyStore.ts`, `AccountService.requestLink`.

## 2026-10-07 · AI billing B3b · Copy on the purchase screen and the legal pages
- Question: Exact wording of the privacy statement (C3), the terms line, and the legal pages.
- Chosen: Account tab: "Your writing stays private. MythScribe Cloud passes each request to the AI model and back and never stores or logs your manuscript, your notes, your questions, or the answers. It keeps only your email address, your balance, and for each request the model, its size, its cost, and when it ran." and "Your balance never expires. Payment is handled by Lemon Squeezy. Unused balance can be refunded within 30 days of buying it." (the window comes from the server config; 30 days is unconfirmed, see B2). terms.html §5 and privacy.html now describe the dollar balance, cost + 20 %, refunds of unused balance within 30 days, OpenRouter as gateway and default own-key provider, and keychain-only keys; the Supporter sections were left for slice B3a. The site's own-key estimate still uses the OpenAI models (now headed "What does your own OpenAI key cost?"); no DeepSeek estimate was made up.
- Alternatives: your wording.

## 2026-10-07 · AI billing B2 · Hold size and charge cap
- Question: The spec's hold uses "input_tokens", which the server cannot count exactly before forwarding. How big is the hold?
- Chosen: a guaranteed upper bound — the messages' UTF-8 bytes plus 16 tokens per message and 16 per request (no tokenizer emits less than a byte per token), at the full input price, plus `maxTokens` at the output price, times the markup. A charge is additionally clamped to its hold (logged). For English prose the hold is about 4x the real input cost; it lasts only until the answer settles.
- Alternatives: characters / 4 times the safety factor (smaller holds, but the operator absorbs any undercount); a tokenizer in the Worker (a new dependency).
- To change it: `inputTokenUpperBound` in `src/shared/cloudBilling.ts`.

## 2026-10-07 · AI billing B2 · Idempotency-Key semantics
- Question: What does a retry with the same key get, given the proxy may not store the answer (S3)?
- Chosen: the header is optional until the app sends it (the Worker makes one up). Same key already charged → 409 `DUPLICATE_REQUEST` ("already answered and charged"; the answer is not replayed). Still running → 409 ("still running"). Released (upstream failed, nothing charged) → the retry runs and takes over the hold. A charge row is keyed `charge:<request id>`, so settling twice charges once.
- Alternatives: re-answer a charged key for free (abusable); store answers briefly (breaks S3).
- To change it: `PLACE_HOLD` / `TAKE_OVER_HOLD` in `cloud/src/store.ts`, `handleAiComplete` in `cloud/src/ai.ts`.

## 2026-10-07 · AI billing B2 · An answer with no usage reported
- Question: A gateway that streams an answer but reports no usage: charge what?
- Chosen: an estimate from the text (characters / 4 for input and output, output capped at `maxTokens`), at least 1 micro-USD per answered request, never above the hold. A failed or cancelled request is never charged (its hold is released).
- Alternatives: charge the whole hold; charge nothing (the operator pays).
- To change it: `settle` in `cloud/src/ai.ts`.

## 2026-10-07 · AI billing B2 · Access and refresh tokens
- Question: How short-lived, how stored, and what about the app that still sends the session token?
- Chosen: access tokens last 15 minutes and are stored hashed in D1 (`access_tokens`), so revoking the session (the refresh token, 90 days, unchanged) ends them at once. No refresh-token rotation. Until slice B3 switches the app, the session token is still accepted as the bearer on every route; S6 is fully in force only once a later change stops accepting it.
- Alternatives: stateless signed access tokens (a new secret; revocation waits for expiry); rotate the refresh token on every refresh.
- To change it: `ACCESS_TOKEN_TTL_MS` in `src/shared/cloudApi.ts`; `sessionHashFor` in `cloud/src/auth.ts`.

## 2026-10-07 · AI billing B2 · Sign-in code
- Question: The spec allows "magic link or code". What kind of code?
- Chosen: the same email carries a 6-digit code beside the link. `POST /auth/verify` takes it with the attempt id and poll secret (so only the app that started the sign-in can use it); 5 wrong codes spend the attempt; it expires with the link (15 minutes).
- Alternatives: a code usable from any device by email address alone (needs stricter rate limiting).
- To change it: `handleVerifyCode` in `cloud/src/auth.ts`, `LOGIN_CODE_*` in `src/shared/cloudApi.ts`.

## 2026-10-07 · AI billing B2 · Trial grant for existing accounts
- Question: Accounts created before the grant existed: do they get it?
- Chosen: yes. The grant is asked for on every verified sign-in (link or code) and keyed by the SHA-256 of the email, so every address gets it exactly once, including existing accounts on their next sign-in.
- Alternatives: only accounts created after the deploy.
- To change it: `grantTrial` in `cloud/src/auth.ts`.

## 2026-10-07 · AI billing B2 · Refunds of unused balance
- **Confirmed by the author 2026-10-07:** unused balance is refundable for 30 days after purchase (`refund_window_days` 30); refunds stay operator-issued in Lemon Squeezy.
- Question: How does the ledger follow a refund, and is the 30-day window enforced?
- Chosen: the operator refunds (part of) an order in Lemon Squeezy; the `order_refunded` webhook writes a `refund` row of the order's cumulative `refunded_amount` (the whole pack if absent), capped at the pack, minus what was already refunded on that order. The window (`refund_window_days`, 30, unconfirmed) is published in `GET /pricing` but not enforced by the Worker, because refunds are issued by the operator. A refund of spent money can take the balance below zero; requests are then refused.
- Alternatives: an in-app "refund my balance" request route; enforce the window on the webhook (it would then ignore a refund Lemon Squeezy already paid out).
- To change it: `handleLemonSqueezyWebhook` in `cloud/src/credits.ts`.

## 2026-10-07 · AI billing B2 · Webhook staleness
- Question: What is "stale"?
- Chosen: older than `webhook_max_age_hours` (72) by the order's `created_at` (`refunded_at` for a refund), or no timestamp at all: 400 `STALE_WEBHOOK`, nothing applied. Lemon Squeezy's own retries arrive well inside 72 hours; replays inside the window are caught by the ledger's unique keys.
- Alternatives: a shorter window (a long outage would then lose orders); 200 "ignored" instead of a 400.
- To change it: the `webhook_max_age_hours` config row, or `eventTime` in `cloud/src/credits.ts`.

## 2026-10-07 · AI billing B2 · The $30 app license on the Worker
- Question: How is the app license sold and issued?
- Chosen: one more Lemon Squeezy variant, `LEMONSQUEEZY_APP_LICENSE` (same shape as the Supporter product). Buying it writes the same `supporter_licenses` row, so `GET /license` signs the same token (F-15.9) and the app's license check is unchanged; `GET /license` offers the app license instead of the Supporter product once it is configured. The trial clock stays in the app (slice B3).
- Alternatives: a separate table and a token claim naming the product.
- To change it: `findVariant` in `cloud/src/credits.ts`, `handleLicense` in `cloud/src/license.ts`.

## 2026-10-07 · AI billing B2 · Where the config lives
- Question: "Changeable without an app release" — D1 or Worker vars?
- Chosen: a `billing_config` D1 table (one JSON value per spec key) over built-in defaults, so the operator changes the markup, prices, limits, routing, or estimate constants with one `wrangler d1 execute` and no deploy; a malformed row is logged and ignored. The packs stay in `LEMONSQUEEZY_PACKS` (they carry Lemon Squeezy URLs), filtered by `min_pack_usd`. Defaults: 60 requests per minute per account, 200,000 characters per request, 10-minute holds swept every 5 minutes.
- Alternatives: everything in Worker vars (needs a deploy per change).
- To change it: `cloud/src/config.ts`; the table is in `cloud/README.md`.

## 2026-10-07 · AI billing B2 · Error codes on the wire
- Question: The spec names `insufficient_balance`, `rate_limited`, `request_too_large`, `model_unavailable`, `upstream_error`.
- Chosen: the existing codes keep their names so the shipped app still understands them (`INSUFFICIENT_CREDITS` 402, `RATE_LIMITED` 429 for both the per-account limit and a busy gateway, `UPSTREAM` 502); added `REQUEST_TOO_LARGE` 413, `MODEL_UNAVAILABLE` 422 (unknown model, or the gateway's 404), `DUPLICATE_REQUEST` 409, `STALE_WEBHOOK` 400. An unknown model was 400 `BAD_REQUEST` before; it is now 422 `MODEL_UNAVAILABLE`.
- Alternatives: rename `INSUFFICIENT_CREDITS` to `INSUFFICIENT_BALANCE` in slice B3 together with the app.
- To change it: `CloudErrorCode` in `src/shared/cloudApi.ts`.

## 2026-10-07 · AI billing B2 · Proposed price table details (needs approval with the model proposal)
- Question: The default hosted price table beyond what the plan fixed.
- Chosen: OpenRouter ids `openai/gpt-5.4-mini` (fast, multiplier 1), `openai/gpt-5.4` (strong, about 3.3x), `openai/gpt-5.4-nano` (about 0.3x) at OpenAI's 2026-10-05 prices, cached input at a tenth of the input price; the bare names the app sends today are accepted as aliases. Multipliers are by output price relative to the fast model.
- Alternatives: whatever the author approves for the default models and routing table.
- To change it: a `models` / `routing` row in `billing_config` (no deploy), or `DEFAULT_HOSTED_MODELS` in `src/shared/cloudBilling.ts`.

## 2026-10-07 · AI billing B1 · Proposed OpenRouter default models and Auto routing table (needs your approval)
- Question: Which fast and strong models should OpenRouter (own key) and MythScribe Cloud use by default, and which tier should Auto give each task? Not shipped: the app still asks for `openai/gpt-5.4-mini` (fast) and `openai/gpt-5.4` (strong) through OpenRouter, and Auto keeps every task on the tier it always had.
- Prices: **not verified.** This agent had no web access, so the figures below are from memory (mid-2026) and must be checked on openrouter.ai/models before you approve; OpenRouter passes the provider's price through (its fee is on buying credit).
- Proposed:
  - Fast: `deepseek/deepseek-v3.2` (DeepSeek V3.2), about $0.25–0.28 in / $0.40 out per 1M tokens, cached input about $0.03. Why: roughly a third of gpt-5.4-mini's input price and a tenth of its output price ($0.75 / $4.50); good at JSON (summaries, tags, proofreading); comparatively permissive with violence, dark themes, and adult romance, which is the content-filter risk the research flagged for OpenAI and Anthropic models.
  - Strong: `moonshotai/kimi-k2-0905` (Kimi K2), about $0.40–0.60 in / $2.00–2.50 out. Why: about a sixth of gpt-5.4's price ($2.50 / $15); ranks near the top of creative-writing benchmarks; permissive enough for dark fiction and romance; JSON mode works.
  - Alternatives: fast `mistralai/mistral-small-3.2-24b-instruct` (about $0.05–0.10 in / $0.10–0.30 out; very permissive, weaker at long JSON); strong `z-ai/glm-4.6` (about $0.40–0.60 / $1.75–2.20) or DeepSeek V3.2 for both tiers (cheapest, one model). Newer versions of these families may exist by now; prefer the current one at a similar price.
  - Risks to weigh: these models are served by several hosts behind OpenRouter; set OpenRouter's data policy to exclude providers that train on prompts (not built: a `provider.data_collection: "deny"` request field, or the account setting). Explicit sexual content is still refused by some hosts; none of these is a guarantee.
- Proposed Auto routing table (fast unless named; today's table is the same except the two marked *changed*): fast for tags, summaries (and the story bible and auto-tags they carry), proofreading, import structure, the router, synopsis and notes suggestions, style notes, What next, brief drafting, background continuity checks, ghost text, chat (Plan); strong for Story Intelligence queries, critique, the beta reader, the chat agent, on-demand Check consistency, and the developmental, line, and custom edit passes (copy, proofread, and continuity passes fast); *changed:* rewrite-in-my-voice fast → strong (spec R4: drafting on stronger models). The spec also puts ghost writing on the stronger model; CLAUDE.md token rule 1 keeps ghost text on fast (it runs on every pause, capped at 60 tokens); recommended: keep ghost text on fast, since the author can move it to strong per task in Settings › AI.
- To change it: `OPENROUTER_DEFAULT_MODELS` and `OPENROUTER_PRICING` in `src/shared/ai.ts` (own key); the hosted defaults and table come from the Worker's `/pricing` (slice B2); the bundled Auto table is `DEFAULT_ROUTING_TABLE` in `src/shared/aiRouting.ts` (its test pins it to the prompt catalogue's tiers, so a change there updates `prompts/catalogue.ts` too).

## 2026-10-07 · AI billing B1 · OpenRouter as the default own key, and existing OpenAI keys
- Question: What happens to an install that already holds an OpenAI key?
- Chosen: a fresh install's own key is for OpenRouter. An install with a saved OpenAI key keeps using OpenAI until you switch in Settings › AI (Key provider: OpenRouter / OpenAI); each provider keeps its own key and its own two model names. Copy that said "OpenAI" (the source meaning, the quota next step, the local-model warning, the privacy line) now names the provider in effect or both.
- Alternatives: move everyone to OpenRouter (an OpenAI key would stop working until replaced).
- To change it: `effectiveOwnKeyProvider` in `src/shared/ai.ts`.

## 2026-10-07 · AI billing B1 · Keys only in the OS keychain (S2)
- Question: How strict is "keychain only"?
- Chosen: saving a provider key is refused when Electron would fall back to Linux plain-text storage, with a message on how to install GNOME Keyring or KWallet; Windows and macOS are unaffected. A key saved earlier under the fallback is still read (so nothing breaks), and can be cleared. The MythScribe Cloud session token still uses the fallback until the session rework (slice B3: short-lived access token plus a keychain-only refresh token). The e2e has no keyring under xvfb, so `MYTHSCRIBE_E2E_PLAINTEXT_KEYS=1` (set only by `e2e/smoke.spec.ts`) allows the fallback there. Note for your WSL dev setup: `npm run dev` will refuse a key until a keyring runs (`sudo apt install gnome-keyring`, then unlock it in the session).
- Alternatives: stop reading old plain-text keys too; add a native keychain dependency (not allowed by the plan).
- To change it: `AiKeyStore.canStoreProviderKey` in `src/main/ai/keyStore.ts`.

## 2026-10-07 · AI billing B1 · Shape of model choice, and the /pricing contract for B2
- Question: How do "Auto", "override per task or globally" (R4), and "choose the model for any request" (M8) fit the rule that features request a tier, never a model name?
- Chosen: overrides choose a tier, not a model id: Settings › AI › "Which model each task uses" has All tasks (Auto, Fast model, Strong model) and a per-task list; a per-task choice wins over All tasks, which wins over Auto. Which model a tier means stays the per-provider setting (F-5.11), so one choice works on every source. No per-request picker was added: the plan named "edit passes, chat" as having one today, but neither had a model picker; a per-pass choice would also need a schema change to survive Resume. Hosted prices and the hosted Auto table come from `GET /pricing`, whose shape is `CloudPricing` in `src/shared/aiRouting.ts` (price per model with cached-input price and multiplier, markup, packs, trial grant, quote threshold, safety factor, low-balance warning, routing, nullable per-word constants); the app fetches it at launch and after sign-in (cached for an hour) and falls back to the bundled table until the Worker serves it (slice B2 must serve this shape).
- Alternatives: per-task model ids (needs a list per source); a model picker in the chat and edit-pass screens.
- To change it: `src/shared/aiRouting.ts`, `ModelChoiceSection` in `AiSettingsTab.tsx`.


## 2026-10-07 · F-15.13 (billing B3a) · Your installed build will turn read-only 30 days after you update (operator step)
- Question: No build can verify a license yet: `LICENSE_PUBLIC_KEY_JWK` in `src/shared/license.ts` is still the placeholder, and the $30 product is not on sale. The trial starts on the first launch of this version, so in 30 days every install (yours included) opens projects read-only.
- Chosen: nothing bypasses the trial (you asked for no assumptions, and a hidden switch would be a user-settable bypass). Export and backup keep working.
- To do before then: `npm run cloud:license-keygen`, `wrangler secret put LICENSE_SIGNING_KEY`, paste the public JWK into `src/shared/license.ts`, create the $30 product and `LEMONSQUEEZY_APP_LICENSE`, deploy; then buy (or grant yourself) the license. Alternatives: a developer exemption (say how you want it gated), or a longer trial for existing installs.

## 2026-10-07 · F-15.13 (billing B3a) · What "read-only" refuses
- Question: Which actions stop after the trial?
- Chosen: main refuses every channel that changes what you wrote (scenes, notes, the tree, sheets, tags, drafts, snapshots, imports, find-and-replace, accepting AI proposals, the project dictionary, discarding crash recovery) and every AI request. Always allowed: opening, reading, search, export, compile, backups and restore, the account and the purchase, app settings, and the project's view preferences (layout, session, focus, editor and AI settings, goals, backgrounds, reference pins, chat history). The scene and notes editors stop being editable; other fields (sheets, scene details, renaming in the tree) still accept typing, and their save fails with the trial message.
- Alternatives: also lock every other field in the UI (many components); block view preferences too.
- To change it: `CHANNEL_ACCESS` in `src/main/ipc/channelAccess.ts`.

## 2026-10-07 · F-15.13 (billing B3a) · The trial banner
- Question: When does the trial show itself?
- Chosen: one line under the header, only in the trial's last 7 days ("5 days left in your trial." + Buy MythScribe), and always after it ends ("Your 30-day trial has ended. Projects open read-only; export and backup still work." + Buy MythScribe). Buy opens Settings › Account. The Account tab always shows the days left. The trial is 30 calendar days and ends at local midnight.
- Alternatives: show the countdown for the whole trial; a dismissable notice; no countdown.
- To change it: `TRIAL_BANNER_DAYS` in `src/renderer/features/account/TrialBanner.tsx`.

## 2026-10-07 · F-15.13 (billing B3a) · Themes and accents during the trial
- Question: The Supporter extras "become part of the paid app". Do trial users get them?
- Chosen: no change to the gate: Sepia, custom themes, and accent colours unlock with the license (now called the MythScribe license), not during the trial.
- Alternatives: unlock them during the trial too (the gate would follow `AppAccess` instead of the license); make them free for everyone.
- To change it: `themeNeedsLicense` callers (`handlers.ts`, `ThemePicker.tsx`, `viewStore.ts`, `App.tsx`) and `AccountService.setAccent`.

## 2026-10-07 · F-15.13 (billing B3a) · A paid license offline for more than 14 days
- Question: The F-15.9 token expires 14 days after the last refresh that reached the Worker (it was built for cosmetics). It now also keeps projects writable.
- Chosen: unchanged: a licensed install that cannot reach MythScribe Cloud for more than 14 days turns read-only until it reconnects (Refresh on the Account tab). Export and backup still work.
- Alternatives: a longer grace (e.g. 90 days) for the app license; trust an expired but genuine token for writing and use expiry only for refunds.
- To change it: `LICENSE_GRACE_DAYS` in `src/shared/license.ts` (also the Worker's), or `verifyLicenseToken` in `src/main/account/licenseVerifier.ts`.

## 2026-10-07 · F-15.13 (billing B3a) · How the trial clock is kept, and how a license is activated
- Question: How tamper-resistant is the trial, and how does the app learn about a purchase?
- Chosen: the clock is plain JSON in `app-state.json` (start and last-seen time); turning the system clock back does not give days back, but deleting the file starts a new trial ("enough for honest users"). The license is the account's F-15.9 token: buy while signed in, then press Refresh on the Account tab (it also refreshes on launch and daily); there is no license key to paste.
- Alternatives: keep a second copy of the clock in the OS keychain; a pasteable license key for people without an account; refresh the license when the window regains focus after checkout.
- To change it: `src/shared/appAccess.ts`, `src/main/account/appAccess.ts`.

## 2026-10-07 · F-15.13 (billing B3a) · Account tab intro now overstates "no account needed"
- Question: The Account tab still opens with "Optional. You never need an account to write." After the trial, writing needs the license, which belongs to an account.
- Chosen: left as it is in B3a (the intro is the hosted-AI copy slice B3b rewrites); the license section below it explains the trial and the purchase.
- Alternatives: "The account holds your MythScribe license and connects MythScribe Cloud."
- To change it: `INTRO` in `src/renderer/features/account/AccountSettingsTab.tsx` (and its unit test and the smoke test's check).

## 2026-10-07 · Developer tools · The panel is a bottom drawer, not a dock panel or a window
- Question: The plan left the form open ("a dock panel or a separate window, whichever is simpler and does not disturb the writing layout").
- Chosen: a drawer fixed over the bottom 45 % of the window (`DevToolsPanel.tsx`), outside the dock, so no column moves and the editor above stays usable while it is open: you can type and watch VibeWrite's requests arrive. Help › Developer tools or Ctrl+Shift+D toggles it; the close button hides it. Help › Developer is two items at the end of Help (Developer tools, Chromium DevTools) because the menu model has no submenus; both are absent while the switch is off.
- Alternatives: a dock panel (moves the layout); a separate BrowserWindow (more wiring: its own preload route and lifetime).
- To change it: `src/renderer/features/devtools/DevToolsPanel.tsx`, `DEVELOPER_MENU_ENTRIES` in `src/shared/menu.ts`.

## 2026-10-07 · Developer tools · What "waiting" measures, and how skips are counted
- Question: The inspector's timing breakdown needs a definition of "queued/waiting", and ghost text can skip on every idle tick.
- Chosen: `waiting` is from the moment the request path takes the request until the provider is called (the pre-checks and the cache lookup); the feature's own context building and a background job's time in the index queue are not in it. `first token` exists only for streamed requests (chat Plan mode, rewrite); ghost text is not streamed, so its total is its time to first word. A fidelity regenerate and each agent step are rows of their own under the caller's request id (`…:regen`). Ghost-text skips are reported once per change of reason (a run of identical "too few new characters" ticks is one row), and reset when a request leaves. A feature refused by Use AI or its toggle (DISABLED) never reaches the request path, so it is a log entry, not an inspector row.
- Alternatives: include context-building time (needs a hook in every use case); one row per idle tick (floods the 200-row buffer).
- To change it: `traced`/`AiRequestTrace` in `src/main/ai/request.ts`, `skip` in `src/renderer/features/editor/ghostTextController.ts`, `aiFailure` in `src/main/ipc/handlers.ts`.

## 2026-10-07 · Developer tools · What the copied diagnostics report contains
- Question: "Settings with keys and secrets removed" needed a concrete list.
- Chosen: app version, OS and architecture, Electron/Node/Chromium versions; the project's AI source, the own-key provider, whether a key is saved and how it is stored (never the key or its hint), the tier models; app settings limited to models, routing, local server, daily cap and today's tally, view, update channel, backups, and the two switches; the open project's AI settings; the newest 50 log entries and 50 AI request summaries (no prompt or answer text). Every field named like a key, token, secret, password, hint, license, email, or session is dropped, and every string is scrubbed for `sk-…`, `Bearer …`, and JWT-shaped text. Recent project paths, the window state, and the diagnostics queue are left out.
- Alternatives: the whole app-state.json minus secrets (includes project paths).
- To change it: the `devtools:report` handler in `src/main/ipc/handlers.ts`, `formatDiagnosticsReport` in `src/shared/devtools.ts`.

## 2026-10-07 · F-12.4 (CV2) · Compile writers: engine, fonts, and page numbers
- Question: How do the writers carry fonts, page numbers, and the print layout?
- Chosen: (1) The print PDF is the shared print HTML laid out by Paged.js 0.4.3 (MIT, a dev dependency whose polyfill is bundled into main) in a hidden window: script on but sandboxed, no Node, its own session that refuses everything but local files, a CSP, no navigation. It renders offscreen and unthrottled (108 pages in about 2 s; about 105 s otherwise). (2) Fonts: six SIL OFL families ship in `resources/fonts/` with their licences (EB Garamond, Libre Baskerville, Crimson Pro, Courier Prime, Source Sans 3 from Fontsource 5.3.0, Latin and Latin Extended; Liberation Serif 2.1.5). Only the PDF embeds them. DOCX, ODT, and RTF name the font (Liberation Serif asks for Times New Roman, which every agent's Word has); EPUB and HTML name it with fallbacks (reading systems let the reader choose). (3) Page numbers restart at 1 on the body's first page, which goes on a right-hand page when the book has sides; front pages carry no header or footer. Paged.js's own page-counter reset did not carry past its page in this Chromium, so MythScribe numbers the pages itself after layout. (4) Running heads and page numbers are 0.85 × the body size in mirrored (print) formats, the body size otherwise.
- Alternatives: WeasyPrint or Prince (not in Electron; Prince is paid); embed fonts in DOCX (Word ignores embedded fonts unless the reader turns them on) and EPUB (bigger files, often overridden); number front matter in Roman.
- To change it: `src/main/export/pdf.ts`, `src/shared/bookFonts.ts` (`officeFontName`), `src/shared/compilePages.ts`, `src/shared/compileHtml.ts` (`pageCss`, `PAGED_FURNITURE_HANDLER`).

## 2026-10-07 · F-12.4 (CV2) · Compile writers: smaller calls
- Question: Details the plan left open.
- Chosen: (1) `{chapter}` in DOCX and RTF is the chapter that opens each page run (every page break starts a Word/RTF section); in ODT it is ODF's chapter field, which shows the heading text. (2) ODT has no right-page break, so a new recto is a new page there. (3) RTF drop caps open unindented (RTF drop-cap frames are rarely honoured); DOCX uses a real framed drop cap, ODT its drop-cap property. (4) A small-caps first line is CSS `::first-line` in PDF, EPUB, and HTML, and the first ~40 characters (to a word end) in DOCX, ODT, and RTF. (5) Notes set to "comments" are Word comments (DOCX), annotations (ODT, RTF), and print inline after their text everywhere else. (6) A two-line heading reads "Chapter One: The Storm" on one line (contents page, EPUB navigation, Markdown); this changed `plain` in the CV1 model. (7) The DOCX contents page is a Word TOC field whose entries link to the chapters but carry no page numbers until Word updates the field (F9); RTF, plain text, and Markdown list the entries without numbers; PDF prints the numbers. (8) `compile:run` takes the format as shown (unsaved edits included) and the project's stored include ticks, names the file after the book title, reuses `export:progress`, and counts as `export.run` in diagnostics (the counter list is fixed). (9) The old Export dialog stays until CV3, mapped to a format by `exportDialogFormat`; its serif font is now Liberation Serif and its sans Source Sans 3 (before: Georgia/Times and Arial). (10) Hyphenation in the PDF needs Chromium's hyphenation dictionaries, which Electron does not ship on Windows or Linux, so justified paperback text is not hyphenated there (DOCX, ODT, and RTF ask the word processor to hyphenate). (11) epubcheck was not run (it needs Java); the tests check the structure it checks first.
- Alternatives: (1) a Word STYLEREF field; (10) bundle hyphenation patterns (e.g. Hyphenopoly, MIT) into the print page.
- To change it: `src/main/export/{docx,odt,rtf,inlines,run,exportDialog}.ts`, `sectionHeading` in `src/shared/compileModel.ts`.

## 2026-10-07 · F-12.4 (CV3) · Compile window: smaller calls
- Question: How the compile window behaves where the plan left it open.
- Chosen: (1) Built-in formats are read-only; Duplicate makes an editable copy in My formats. (2) A My format's edits stay unsaved (marked "(edited)", kept for the session even if the window closes) until Save or Revert; switching formats with unsaved edits asks first. (3) Duplicate copies what is shown (edits included) under "<name> copy" without asking for a name; Rename… renames the stored format only. (4) The live preview lays out about 6,000 words from a chosen start ("Preview from": the beginning or any page run with a heading), so a novel previews fast; folios count from the window's first page; EPUB, HTML, text, and Markdown preview as the reflowable web page rather than pages; zoom 50/75/100 %. (5) The preview loads the bundled fonts through the project asset scheme (`mythscribe-asset://book-fonts/...`, the scheme now CORS-enabled) instead of bundling a second copy into the renderer. (6) Choosing a format resets "Compile for" to that format's default output. (7) The window closes after a successful compile (the toast names the file). (8) File › Export… stays as an alias of File › Compile…; the F-12.1 dialog, `export:run`, and `exportDialogFormat` are removed. (9) Book details is its own page (File › Book details… and the window's Book details… button) with an explicit Save; the cover is set or removed at once. (10) The binder menu's "Include in compile" shows the row's own tick; the window's list greys out what an unticked folder leaves out.
- Alternatives: (1) editable built-ins saved as a copy on Save; (2) autosave My formats; (4) lay out the whole book, or render pages in main and show images; (5) `import.meta.glob` the fonts into the renderer (+2.6 MB); (7) keep the window open.
- To change it: `src/renderer/features/compile/` (`compileWindowStore.ts`, `CompileWindow.tsx`, `compileContents.ts` `PREVIEW_WORDS`, `pagedFrame.ts`), `src/main/index.ts` (asset scheme), `src/shared/menu.ts`.

## 2026-10-08 · F-9.9 · Review chat: smaller calls
- Question: How the review chat (plan-organize OR2) behaves where the plan left it open.
- Chosen: (1) Its own feature id `reviewChat` with its own toggle and data-sharing row (strong tier, reasoning per the model-choice routing, not forced off like `contextImport`), so its cost shows on its own line. (2) Operations: merge, split, kind, toNotes, fromNotes, rename, aliases, include. Two items that are both existing sheets are never merged here (that is Organise, F-9.10, which always asks); only a new sheet can be renamed (Apply never renames an existing sheet); changing an existing sheet's item to another kind makes a new sheet of that kind (or fills an existing one of that kind and name), and the old sheet is left alone. Skipped operations are listed with the reason. (3) Until the alias model (F-4.14, slice OR1) lands, an item's other names are its records' names and `aliases`; the aliases operation sets the explicit list on its first record, and Apply does not store aliases yet. (4) One level of Undo (the last chat change); a manual edit of the review drops it. Apply and the box wait while the AI answers; Escape in the box stops the answer instead of closing the review. (5) Each answer is one proposal added to the review's `proposalIds` (settled with it at Apply or Cancel; rejected on Undo); its cost shows under its reply, not in the review's footer total. (6) The prompt lists each item on one line (id, kind, name, sheet, other names, files, field values to 60 characters, two details to 100) within 14,000 characters, and the Project notes numbered within 3,000; the last 4 turns go with the message.
- Alternatives: (1) reuse `contextImport`'s id and toggle; (2) allow merging two existing sheets, or renaming one, by extending Apply; (3) a separate alias field on the review item; (4) multi-level undo; (5) fold the chat's cost into the review's footer total.
- To change it: `src/shared/reviewChat.ts` (`applyReviewOps`), `src/main/ai/reviewChat.ts`, `src/main/ai/prompts/reviewChat.v1.ts` (a new version), `src/renderer/features/library/libraryStore.ts` (`sendReviewChat`, `undoReviewChat`), `ContextUploadDialog.tsx` (`ReviewChat`).

## 2026-10-08 · F-9.11 · Story-bible categories and the section picker: smaller calls
- Question: How categories and the section picker behave where the plan (all decisions confirmed) left it open.
- Chosen: (1) Outline counts as used once the manuscript has a document (it is a view of it); Timeline, Edits, Library once they hold an event, a pass, a file. (2) Unused sections are not unreachable: "Show unused sections (n)" at the foot of the picker lists them, and the current section always shows. (3) The three F-9.1 kinds keep their ids (`character`, `setting`, `world`), so the migration only adds `story_category`; no sheet moves. Settings is called Places now (the tag category keeps its "Settings" label). (4) Existing World sheets about magic (World's "Category: Magic system") are not moved into Magic Systems automatically; moving sheets between categories is left to organise (OR3). (5) An AI-invented category is accepted by Apply (the review is the proposal; Rename… and Decline sit on it); Decline files its sheets under World with the fields World lacks moved to their details; at most 6 proposals per sort, 6 fields each. (6) A sheet the model files under another category than an existing same-named sheet fills that sheet where it is (no twin). (7) The chat agent does not create sheets or propose categories yet (it lists and reads every category and edits any category's fields): adding sheet creation means an agent prompt change, which overlaps the parallel story-time work and organise (OR3). (8) F-9.5: a row of a category the project lacks is refused naming it (no category definitions travel in the exchange file yet). (9) No category deletion and no editing of a project category's fields after creation; a library category can be renamed (name, singular, icon), its fields cannot change. (10) Library list: Characters, Places, World, Magic Systems, Factions & Organisations, Religions, Creatures, Items & Artifacts, Cultures, History & Events, Languages, Technology, Lore & Legends; pictures on characters, places, creatures, items.
- Alternatives: (1) Outline hidden until a structure template or a synopsis exists; (2) strictly hidden; (3) rename the stored kinds (`setting` → `place`) with a data migration; (4) a one-time move of World sheets by their Category field; (5) proposals pending in the DB until accepted one by one; (7) an agent tool `create_sheet` / `propose_category` now; (8) carry category definitions in the JSON exchange file and create them on import; (9) delete an empty category, edit fields.
- To change it: `src/renderer/features/shell/sectionList.ts` (`TOOLS[].used`), `src/renderer/features/shell/SidebarSections.tsx`, `src/shared/categories.ts` (`BUILTIN_CATEGORIES`, `ALWAYS_SHOWN_CATEGORIES`), `src/main/entity/categoryStore.ts`, `src/shared/contextLibrary.ts` (`matchSheet`, `declineReviewCategory`, `CONTEXT_PROPOSED_*`), `src/main/ai/contextImport.ts` (`SortCategories`), `src/main/library/apply.ts`, `src/shared/entityExchange.ts`.
