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

