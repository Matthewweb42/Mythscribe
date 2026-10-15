# Notes + Ms Scribe redesign (draft 1, 2026-10-15)

Status: **draft for the author to mark up. Nothing is built until the author approves it.**

## The flow the author wants

One application: the manuscript, a notes area of pages in folders, and Ms Scribe on the right.
Ms Scribe works like Claude with a Google Drive connector, except inside the app: she reads the
book and the notes when asked, answers with sources, edits notes directly, and suggests prose
changes as tracked changes. Goals: find inconsistencies faster, update notes faster, look things
up faster. No copying docs back and forth.

## Why the last design failed (short)

It turned the book into a database of small "facts" with a cheap model and nobody looking, then
answered from those facts. Fiction is too ambiguous for that (six live runs never passed), and the
chat saw slivers of the book instead of the book. Measured on the author's real project: prose
about 23k words, notes and uploaded docs about 12k words, about 47k tokens in all. That fits in
one request with room to spare: about 2¢ fresh and about 0.2¢ cached on DeepSeek V4 Pro.

## Decisions so far (the author, 2026-10-15)

- Notes: **free pages in folders** (like Notion/Docs). Templates later.
- AI note edits: **direct, with changed lines highlighted and Undo**.
- Context: **smart pick by default, plus a "whole book" option**; the app decides locally what to
  send so spending stays low.
- Default model: **DeepSeek V4 Pro**.
- Inconsistencies: an **edit flow** run at a dedicated time ("Ms Scribe, edit this" or a step):
  categories (continuity, plot holes, line and spelling, …), **quick cheap checks** and **deep
  whole-book edits**.
- Prose: **suggested tracked changes only**; never changed on its own.
- Notes update: **all four**: when told in chat, an "Update notes" step, a category of the edit
  flow, and automatically after a chapter.
- Old story bible, story memory, tags, sheets: **convert to pages, then remove** — but **nothing is
  dropped yet** (the author, 2026-10-15).
- Import: **drop files in** (docx, md, txt, pdf) and later a **live Google Docs link**.
- Edit-flow results: **issue list grouped by category, with tracked changes where fixable**.
- Delivery: **phases the author installs and tries between**.
- Quality is tested on **a local copy of the author's real book** with the author's own questions.
- Ms Scribe: right column; **sources under every answer**; **knows the selection and the scene**;
  modes **Brainstorm** (plans, never edits until "save that"), **Write** (edits notes, adds
  things, suggests prose), **Vibe** (ghost text on, bolder suggested changes).
- Features:
  - **Stay and get work:** notes area, editor with ghost text, scene notes panel (synopsis +
    notes), outline / cork board + scene details, Rewrite, beta reader, Ms Scribe.
  - **Fine for now (stay, no new work):** scene brief + Draft with AI, edit passes (becomes the
    edit flow), local models, cost display and caps, Use AI on/off; and everything not listed.
  - **Archived (hidden, code kept, may return):** writing presets, quick actions, voice profile,
    author rules, banned phrases, editor's notes, proofread.
  - **Story bible family:** converted in phase 4; hidden after the author's check; deleted only on
    the author's word.

## How Ms Scribe gets the right context

Built on the project as it is today (the v1 data the installed app uses); story memory v2 stays
dormant behind its switch and is not used.

1. **Always sent, stable and cached first:** her rules; every note page (or, past a budget, the
   page list plus the pages that match); the book map (each scene's title, place in the book,
   synopsis and scene notes).
2. **Always sent for the moment:** the current scene in full, its notes, the selection.
3. **Picked locally for the question:** scenes found by the names in the question and in the
   current scene, and by the full-text index the project already has; later meaning search.
4. **Whole book:** when everything fits under a budget (default 60k tokens, ~2¢ fresh) it is sent
   whole automatically; above that only when the author turns on "whole book" or the edit flow
   asks for it.
5. **She can look further, like Claude does:** tools to search the book, open a scene, open a note
   page, and (in Write) edit or create note pages and propose prose changes. Every answer lists
   the scenes and pages she used, clickable.

## The edit flow

- Start from the chat ("edit this chapter for continuity") or an Edit menu: pick **scope** (scene,
  chapter, book) and **categories**: continuity against the notes and earlier scenes, plot holes,
  character consistency, timeline, line edits and spelling, update the notes.
- **Quick** (DeepSeek Flash, scene or chapter, cents) or **Deep** (Pro, whole book). Priced first.
- Results: one list grouped by category, each issue with its passage and, where fixable, a tracked
  change to accept or reject; "update the notes" results land as direct note edits with Undo.

## Notes updates

- Chat: "put that in Mara's page and the timeline".
- Step: "Update notes from this scene / chapter / book".
- Automatic: when the author leaves a chapter after writing in it (switch in Settings, off by
  default, with a daily cap); changes appear in the notes with highlights and Undo, and a line in
  the activity bar.

## Phases

1. **Notes area + Ms Scribe v2.** Notes pages in folders (same editor as the manuscript, links
   between pages), file import, the context builder above, Brainstorm / Write / Vibe, tools,
   sources, direct note edits with Undo, prose suggestions as tracked changes. Archive the listed
   features behind a hidden switch. Acceptance: the author's question set on the real book.
2. **Edit flow** (from edit passes): scopes, categories, quick and deep, the issue list.
3. **Notes updates:** the step, the edit-flow category, automatic after a chapter.
4. **Conversion:** story bible sheets, entities, uploaded docs and research pages become note
   pages; the old views hidden after the author checks.
5. **Live Google Docs link.**
6. **Templates** for authors who do not like free-form.

## How we keep it fast

- One plan per phase, short; one implementer, or parallel slices on separate files.
- No planted-error harnesses or live pass bars. The acceptance test is the author's question set
  run on a local copy of the real book, answers read by the author.
- Full gates once per phase; the author installs and tries each phase.

## Answered (the author, 2026-10-15)

1. **Whole book when it fits:** yes, automatically under 60k tokens; longer books use the smart pick
   unless "whole book" is turned on.
2. **Book map:** the author's synopsis and scene notes; a short AI summary only for scenes with no
   synopsis, written once per change.
3. **Brainstorm "save that":** she picks the page(s) or makes one, then shows the change with Undo.
4. **Archived features:** hidden everywhere; Settings › Archived features switches one back on.

## The question set (the author, 2026-10-15): phase 1's acceptance test

Asked on a local copy of the real book; each with what a good answer contains.

1. "When was the last time [he] used that ability, and under what context?" → the chapter, as a
   link, and the context around it.
2. "What can I do to make this scene have more tension?" → the scene's current flow, then two
   options grounded in the notes and outline ("instead of this line, either this or this").
3. "Is what [he] says here in line with his character?" → a verdict against his page and earlier
   scenes, with a line he might say instead.
4. "I'm stuck, what should go next?" → from the outline and the flow so far: one or two next beats.
5. "What's another good power I can use for this character?" → says the character has no sheet,
   draws on the docs about powers, offers one fitting option and one darker one.
6. "What can I do to make this scene better?" → grounded in the scene's own notes and the plan,
   never a new plot turn that fights them.

What every answer does: points to where (links), grounds itself in the outline, notes and the
flow so far, offers two options when it suggests, and says plainly when something is missing.
