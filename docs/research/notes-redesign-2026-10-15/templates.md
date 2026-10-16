# Phase 6: note templates (2026-10-15)

**Status: built 2026-10-15** (no migration, no channel, no prompt change; calls in `QUESTIONS.md` "Note templates (2026-10-15)").

Part of `plan.md`. The author's decision: "free pages in folders for now, but later some templates
for people that don't like free form." The author said "keep going" (2026-10-15); everything below
is decided by Claude, unconfirmed, and goes in `QUESTIONS.md` ("Note templates (2026-10-15)").
Phase 5 (live Google Docs link) waits: it needs a Google Cloud OAuth client only the author can
create.

## What it does

1. **New page from a template.** The Notes tree's new-page control (and a folder's context menu)
   gains "New from template ›" with built-in templates: **Character, Place, Group / faction,
   Item, Magic or power system, Event, Timeline, Chapter plan, Style guide**. Each makes an
   ordinary free page (same editor, fully editable, nothing locked) with a title placeholder and
   headings / short labelled lines to fill (e.g. Character: Role, Appearance, Wants, Fears, Voice
   and speech, Powers, Relationships, Arc, First appears). Style guide matches what the edit
   flow's Copyediting reads (the page named "Style guide"): spelling choices, capitalised terms,
   numbers, dialogue punctuation, swearing.
2. **Your own templates.** Any page inside a Notes folder named **Templates** shows in the same
   menu under "My templates" (above the built-ins), and a page's menu gets "Save as template"
   (copies it into Templates, creating the folder once). No new storage: the folder is ordinary
   notes. Ms Scribe skips the Templates folder when she reads notes (it is scaffolding, not story
   facts), and lists it only when asked.
3. **A starter set for an empty Notes.** When Notes has no pages, its empty state offers "Start
   with folders" (Characters, Places, World, Plot, Timeline, plus a Style guide page) beside
   "Start blank" and the file drop. One click, nothing made unless chosen.
4. **Ms Scribe uses the template shape.** When she creates a page in Write/Vibe (`create_note`)
   in a folder whose name matches a built-in kind (Characters → Character, Places → Place, …) or
   when a "My templates" page of that name exists, the page she writes follows the template's
   headings, filling what she knows and leaving the rest empty. Done locally: the tool result
   tells her the headings (no prompt version change needed if it rides in the tool result; if a
   rule line is needed, it is a new `scribe.v4`).

## Where

`src/shared/notebookTemplates.ts` (the built-ins as data: title, headings, lines; pure, tested),
the Notes tree and empty state in `src/renderer/features/notebook/`, `notebook:create` as is
(content passed in), Ms Scribe's `create_note` in `src/main/scribe2/tools.ts` and her note
reading in `src/main/scribe2/source.ts` / `context.ts` (skip Templates). No migration, no new
channel expected.

## Tests

Unit: each built-in template is a valid Tiptap doc with its headings; the menu lists My templates
first then built-ins; Save as template copies and creates the folder once; the starter set makes
the folders once; Ms Scribe's context leaves out the Templates folder; `create_note` in
Characters gets the Character headings in its result. e2e (`e2e/notebook.spec.ts`): new page from
the Character template, type in it, save one as a template, it appears under My templates.
