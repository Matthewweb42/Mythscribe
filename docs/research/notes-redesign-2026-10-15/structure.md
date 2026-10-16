# Two tabs, splitting uploads, Ms Scribe moves things (2026-10-16)

Part of `plan.md`. The author asked (2026-10-16):

1. "the notes/manuscript drop down can be simplified … just have those two be side by side";
   answered: "Timeline and edits and outline should be technically under 'notes'".
2. "When files are uploaded, they should have the option to sort through the information into
   smaller, easier to manage bits"; picked: both, the author chooses (split at headings, free;
   or sort with Ms Scribe, priced).
3. "When Ms Scribe is asked to do anything with moving folders, files, or creating new ones, it
   should have full capabilities"; picked: Notes and Manuscript, done at once in Write and Vibe
   with Undo, deletions always ask, Brainstorm changes nothing, scene text still only as
   suggestions.

Calls marked "decided by Claude" are unconfirmed and go in `QUESTIONS.md` under "Two tabs,
splitting, Ms Scribe's structure tools (2026-10-16)". Built lean: one implementer per part, unit
tests for what changes, the full gate suite once at the end of each part.

## A. Two tabs: Manuscript | Notes (renderer only) — built 2026-10-16

**Changed by the author (2026-10-16):** three tabs, Manuscript | Notes | Edits; Outline and
Timeline are two large folders at the top of the Notes tree (built the same day). The text below is
the first version.

- **While the old story bible is archived** (the fresh start, `useIsArchived('storyBible')`), the
  sidebar's section dropdown becomes **two tabs side by side, Manuscript and Notes**, on the same
  row as the dock controls (`controls`). With the story bible on, or in a v2 project, the dropdown
  stays as it is (decided by Claude: those have many sections).
- **Outline, Timeline and Edits live under Notes.** The Notes tab shows, above its tree, a short
  group of three rows with their icons: **Outline**, **Timeline**, **Edits** (always listed in
  the fresh start; decided by Claude: an empty one shows its own empty state). Clicking one
  shows that view in the Notes panel with a "‹ Notes" back row at its top. The Notes tab stays
  the selected tab while one of them is open.
- **Ids unchanged.** The stored section ids `outline`, `timeline`, `edits` still work: anything
  that calls `setSidebarTab('edits')` (edit-flow results, menus, the activity bar) selects the
  Notes tab with that view open, and a restored session opens the same way. One owner: the
  layout store's sidebar tab stays the single state; the tabs and the Notes sub-view are derived
  from it (`notes` → the tree, `outline`/`timeline`/`edits` → that view under Notes).
- Keyboard: the tabs are an ARIA tablist (Left/Right move, Home/End), the panel a tabpanel.

Where: `src/renderer/features/shell/SidebarSections.tsx`, `sectionList.ts`,
`src/renderer/features/notebook/NotesTab.tsx`. Tests: `SidebarSections.test.tsx` (two tabs while
archived, dropdown otherwise; `edits` selects Notes with Edits open; back row), the e2e steps
that pick a section through the dropdown in the fresh start updated to the tabs.

## B. Breaking an upload into smaller pages — built 2026-10-16

- **After a drop or a pick into Notes**, before importing, one small choice for the files
  (decided by Claude: one choice for the whole drop): **One page each** (as today) · **Split at
  headings** · **Sort with Ms Scribe** (hidden while Use AI is off or the feature is off; shows
  its price first, from a local token estimate, as the edit flow does). Default: One page each.
- The same two actions on an **existing page's menu** ("Split at headings", "Sort with Ms
  Scribe…"), so the author's two docs already in Notes › Docs can be broken up.
- **Split at headings** (no AI, main side): a folder named after the file (or the page), one page
  per heading of the highest level the file uses, titled by the heading, its text up to the next
  such heading; text before the first heading becomes a page named after the file. A file with
  no headings imports as one page (and says so). For an existing page, the folder takes the
  page's place and the page is deleted; one Undo restores the page and removes the folder
  (decided by Claude: the split loses nothing, so the original is not kept twice).
- **Sort with Ms Scribe** (new AI feature id `notesSort`, prompt `notesSort.v1`, `fast` tier,
  JSON out): the file's text in chunks within a fixed per-chunk budget, with the existing folder
  names and page titles; she answers `{ pages: [{ folder, title, text }] }` with the text copied
  or lightly trimmed from the source, never invented (the prompt's rule; a page whose text is not
  found in the source after whitespace folding is dropped, decided by Claude). Folders she names
  are made once (an existing folder by name is reused); a page whose title already exists in that
  folder gets the text appended under a heading (the page's version is kept first). The original
  is **kept** (decided by Claude: a sort may leave things out). One Undo for the whole sort
  removes what it made and restores what it appended to. A line in the activity bar: "Sorted
  <file> into N pages". Cost in the ledger as `notesSort`; it needs its `aiCostNotes` entry, a
  data-sharing row (and the docs page mirror), a per-feature toggle like the others, eval cases.
- Channels (decided by Claude): `notebook:import` gains `split: 'none' | 'headings'`;
  `notebook:splitPage { id }`; `notesSort:estimate { pageIds | files }` and
  `notesSort:run { … }` answering what it made, for Undo; `notebook:undoBatch` (or the existing
  delete/restore and version calls) for the one Undo.

Where: `src/main/notebook/notebookImport.ts`, a new `src/main/notebook/notesSort.ts`, the prompt
under `src/main/ai/prompts/`, `NotesTab.tsx` / `NotebookTree.tsx` / `droppedEntries.ts`.
Tests: the heading split (levels, text before the first heading, no headings), split of an
existing page with Undo; the sort's parse, the dropped invented text, folder reuse, append with
version, the one Undo; golden + eval cases for `notesSort.v1` and `npm run eval:ai -- -u`.
e2e (`e2e/notebook.spec.ts`): drop a Markdown file with headings, pick Split at headings, the
pages appear in a folder; Sort with Ms Scribe against the fake provider makes two pages in two
folders and Undo removes them.

## C. Ms Scribe moves, makes and deletes folders and files — built 2026-10-16

New tools in Write and Vibe (Brainstorm refuses them as it refuses `edit_note` now). Prompt
**`scribe.v5`** (v4 stays catalogued as shipped) with the tools' one-line descriptions only.

**Notes:**
- `create_folder { title, parent? }`: made at once (a missing parent folder by name is made too,
  decided by Claude); `create_note` with a folder that does not exist now makes it instead of
  falling back to the top.
- `move_note { ids[], to, position? }`: pages or folders (by ref, id or title) into a folder (or
  the top); several in one call. At once, Undo puts each back where it was.
- `rename_note { id, title }`: a page or folder; at once, Undo.
- `delete_note { id }`: **asks** (a pending card with Delete / Keep; nothing removed until the
  author presses Delete); Delete then has Undo through `notebook:restore`.

**Manuscript** (reuse the old chat agent's tree edits, never a second implementation):
`create_scene` / `create_chapter`, `move_scene` (one or several: the old agent's `move` /
`moveMany`), `rename`, `split_scene`, `merge_scenes`, `delete` (asks), all resolved through
`resolveAgentEdit` in `src/main/ai/agentTools.ts` and applied with Undo by
`src/renderer/features/ai/agentApply.ts` as the old agent's Auto mode applied them. In Write and
Vibe the non-deletion ones apply at once with their Undo in the chat card; deletions show as a
pending card. The chapter/scene text is never written by these tools (a new scene is empty or
carries only what `create` already allows); prose stays `propose_prose_edit`.

- **Cap:** structure changes have their own cap per message (decided by Claude: 40, counting each
  item moved), beside `SCRIBE_MAX_WRITES` for text; a refused one says so in the tool result.
- The chat card lists each structure change in one line ("Moved Tash into Characters", "New
  chapter: The Fall") with its Undo; one "Undo all" when there are several (decided by Claude).
- Notebook Undo of a move and a rename needs the old place/title in the change (new `notebook`
  edit fields or new edit kinds in the contract, additive).

Where: `src/main/scribe2/tools.ts`, `src/shared/scribe2.ts`, the prompt `scribe.v5`,
`src/shared/ipc/contract.ts` (additive), the chat card in `src/renderer/features/ai/`
(the Ms Scribe turn), `agentApply.ts`. Tests: each tool's result and refusal by mode; move and
rename Undo; delete only after Delete; the manuscript tools resolve to the old agent's edits and
apply with Undo; the cap; `scribe.v5` golden and eval cases (a reorganise request uses
`move_note` with several ids), `npm run eval:ai -- -u`. e2e (`e2e/scribe.spec.ts`): against the
fake provider, "put Tash in a Characters folder" makes the folder and moves the page, Undo puts it
back; a delete shows the card and removes nothing until Delete.

## Order

A and C touch disjoint files and run at the same time; B goes after both (it shares `NotesTab`
with A and the prompt catalogue and token report with C).
