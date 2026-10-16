# Notes as a binder: Outline, Timeline, Documents (2026-10-16)

**Status: built 2026-10-16** (migration 0043 `notebook_sections`, additive; prompt `editNotes.v2`; calls in `QUESTIONS.md` "Notes binder (2026-10-16)").

Part of `plan.md`; replaces structure A's "Outline and Timeline under Notes". The author
(2026-10-16): "drop downs of the three, Outline, Timeline, and Documents, then a file selector, kind
of like the manuscript document manager format", with these answers:

- **Outline** holds the author's own outline pages and folders (chapter plans, beats, arcs).
  Nothing automatic.
- **Timeline**: "I personally never use the timeline feature, but it should be there so the AI can
  keep track of events relative to each other" → the AI keeps one page there, **Story timeline**.
- **Documents** holds all the other notes (Characters, Places, World, the Docs folder, uploads,
  templates, the Style guide).
- The old sidebar **Outline** view (cork board, beats, threads) and **Timeline** view (events) are
  **hidden**, their data kept, and can be brought back under Settings › Archived features.

Tabs stay **Manuscript | Notes | Edits**. Calls marked "decided by Claude" go in `QUESTIONS.md`
under "Notes binder (2026-10-16)". Built lean: one implementer, unit tests for what changes, full
gates once at the end.

## 1. Three fixed sections in the notebook (main)

- **Migration 0043** (additive): `notebook_item.role` text, null for ordinary items, or `outline`,
  `timeline`, `documents` for the three section roots (top-level folders).
- **`ensureNotebookSections(db)`** (one owner, `src/main/notebook/notebookStore.ts`), run when a
  project opens: makes any missing root (titles "Outline", "Timeline", "Documents", in that order)
  and moves every other live top-level item into Documents, keeping their order. Idempotent; a
  test proves a second run changes nothing.
- **Guards in the store:** a root cannot be renamed, moved or deleted (VALIDATION error with a
  plain message); nothing new lands at the top level: a create, move or import with
  `parentId: null` goes into **Documents** (decided by Claude).
- Everything that made top-level items now lands in Documents: Start with folders (Characters,
  Places, World, Plot and the Style guide page in Documents; the starter set's Timeline folder is
  dropped since the section exists, and a "Chapter plans" folder goes in Outline — decided by
  Claude), Save as template (Templates folder in Documents), the Docs folder from the library
  (`libraryDocs.ts`), imports and Sort with Ms Scribe (a folder she names goes in Documents unless
  it is Outline or Timeline or under them), Ms Scribe's `create_note` / `create_folder` with no
  folder.
- Folder lookup by name (`findFolder`, `ensureFolderPath`, templates) finds the roots too, so
  "put it in Outline" works; paths in `list_notes` read "Documents › Characters".

## 2. The Notes tab as a binder (renderer)

- The tree shows the three roots as **section rows** styled like the Manuscript binder's own
  section rows (reuse its look and expand/collapse; their open state remembered as folders' is),
  each with a small **+** (New page, New folder, New from template, inside that section; reuse the
  Manuscript tree's small plus pattern). Their context menu has no Rename, Move or Delete.
- Pages and folders inside work as today (drag and drop between and within sections, menus,
  drops of files onto a section or folder).
- The Notes toolbar's New page / New folder / New from template target the selected folder, else
  Documents. The empty state: the three sections always show; "Start with folders" stays offered
  while Documents is empty.
- Structure A's "Views" rows are removed. Tabs Manuscript | Notes | Edits unchanged.

## 3. Old views archived

- New archivable feature **`oldViews`**, labelled "Old Outline and Timeline views", archived by
  default like the others. While archived, the fresh start lists no Outline or Timeline section;
  switched on, they come back as tabs after Edits (decided by Claude). Stored ids `outline` /
  `timeline` open Notes while archived. The cork board and timeline data are untouched.

## 4. The AI keeps the Story timeline

- New prompt version **`editNotes.v2`** (v1 kept catalogued): the edit flow's Update notes (manual,
  the "Update notes from this…" step, and the automatic after-a-chapter run) also keeps the page
  **Story timeline** in the Timeline section: one line per event that matters for continuity,
  **in story order** (when it happens in the story, not where it is told; a flashback's event goes
  where it happened), each with its chapter: `Ch 3 · Mara learns the bell's secret`. It inserts a
  new event where it belongs and never removes the author's lines. The page is made the first
  time an update has an event (decided by Claude: never an empty page). Same tier and budgets;
  the page goes in its notes context like any page. Undo as for every note edit.
- Ms Scribe reads it as any note page (no prompt change for her).

## Tests

Unit: the migration; `ensureNotebookSections` (fresh project, an old project's top-level items
moved in order, idempotent); the guards; creates/imports/starter set/Save as template/libraryDocs
land in Documents; `findFolder` by a root name; the binder tree (three section rows, + menu, no
Rename/Delete on a root); `oldViews` archived hides Outline and Timeline, switched on shows them;
`editNotes.v2` golden and eval cases (an event inserted in story order, a flashback placed by when
it happened, the page made once); I run `npm run eval:ai -- -u`.
e2e (`e2e/notebook.spec.ts`, `e2e/editflow.spec.ts`): the three sections show and fold; a page made
in Outline; an old project's notes open under Documents; an Update notes run against the fake
provider writes Story timeline in Timeline, Undo restores.
