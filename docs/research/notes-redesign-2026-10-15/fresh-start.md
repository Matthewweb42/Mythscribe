# Fresh start: the old story bible put away (2026-10-15)

Replaces phase 4 ("conversion") of `plan.md`. The author's decision (2026-10-15): "I don't want
the story bible stuff that's there right now. Most of it is AI generated and I kinda wanna restart
it all anyway… So long as my manuscript stays untouched." No conversion of sheets.

## The author's answers (2026-10-15, confirmed)

- **Uploaded docs** (the Library / context library files, the author's own writing) become
  editable pages in a Notes folder **Docs**, once per project.
- **Old story bible data** (sheets / entities, categories, tags and the Index, facts, threads,
  the To do list, the Changes log, Organise, story memory v2) is **hidden and no longer read**;
  the rows stay in the project file untouched (and in backups) until the old code is removed in
  a later piece.
- The manuscript, scene notes, synopses and scene details are untouched.

## What changes

1. **One switch, "Old story bible"**, added to Settings › Archived features (archived by default):
   while archived, every old story-bible section, panel, button and menu item is hidden
   (Characters, Places, World and other categories, Index / tags, Threads, Library, To do,
   Changes, Organise, the editor's tag bar and tag suggestions, the quick reference, the This
   scene / Book panel of v1 where it shows sheets), and switching it off brings them back.
2. **Nothing reads it while archived:** Ms Scribe's context (`src/main/scribe2/source.ts`) stops
   reading sheets and uploads; the old background AI jobs that write story-bible data stop
   (automatic tags, observed facts, background continuity, the To do check), so no money is
   spent on hidden data. Scene summaries stay (the book map uses them for scenes with no
   synopsis).
3. **Docs into Notes, once:** on open, a project whose Library has files and that has not been
   through this yet gets a Notes folder "Docs" with one page per file (the stored text, headings
   kept where the extraction has them), recorded in the project settings so it never repeats and
   an empty Docs folder is never recreated. Free, no AI.
4. **The sidebar** then shows Manuscript, Notes, Outline (and the other tools the author kept:
   Edits, goals and statistics).

## Not changing

Prose, scene notes, synopses, scene details, drafts, snapshots, backups; v2 stays dormant.

## Tests

Unit: the switch hides each entry point and stops each job; the Docs copy runs once, keeps
headings, skips a project with no files; Ms Scribe's context has no sheets while archived.
e2e: the smoke switches "Old story bible" back on with the other archived features before
covering them; a new step in `e2e/notebook.spec.ts`: a project with a Library file opens with
Notes › Docs holding it and no Characters section.
