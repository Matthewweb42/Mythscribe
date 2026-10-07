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
