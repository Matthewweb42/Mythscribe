# Phase 1: the notes area and Ms Scribe with full context (draft, 2026-10-15)

Part of `plan.md` (same folder). Built on the v1 project (what the installed app runs); story
memory v2 stays dormant behind `storyMemory`. Additive migration only.

## What the author gets

- A **Notes** section in the sidebar: pages in folders, created, renamed, moved, deleted, edited
  in the same editor as the manuscript. Drop docx / md / txt / pdf files to make pages.
- **Ms Scribe** in the right column with modes **Brainstorm / Write / Vibe** that answer the
  question set in `plan.md` with the whole book and every note in view, sources under every
  answer, note edits applied directly with highlights and Undo, prose changes as tracked changes.
- **Settings › Archived features**: writing presets, quick actions, voice profile, author rules,
  banned phrases, editor's notes, proofread hidden everywhere unless switched back on.

## Slices

**0. Data and contract (main session, first, small).**
- Migration 0041 `note_page`: id, parent_id (folder or null), kind (`folder` | `page`), title,
  content (Tiptap JSON), plain (derived text, for search and the prompt), position, created,
  modified. `note_page_version`: page id, content, author (`me` | `ai`), created — the Undo and
  history for AI edits (kept: the last 20 per page).
- Repository `src/main/notes/` (list, get, create, update, move, delete, versions, restore) with
  unit tests; IPC channels `notes:*` in the contract and `channelAccess`.

**1. The notes area (renderer, one implementer, parallel with slice 2).**
- Sidebar section "Notes": a tree like the manuscript tree (reuse its component and drag/drop),
  New page / New folder, rename, delete with Undo.
- Page editor: the manuscript editor's schema without manuscript-only extensions; autosave.
- AI edits show as highlighted changes with "Undo Ms Scribe's edit" (restores the version).
- Import: drop or pick files; docx/md/txt/pdf → one page each (reuse the manuscript import and
  context-file text extraction); a folder of files keeps its folders.
- Settings › Archived features (the seven listed), each entry point hidden when archived.

**2. Context and Ms Scribe (main, one implementer, parallel with slice 1).**
- `src/main/scribe2/context.ts` builds the request in cache order: rules → all note pages → the
  book map (each scene: title, place, synopsis, scene notes; an AI line only where no synopsis,
  from the existing scene summaries) → the book (whole when the total is under 60k tokens; else
  the scenes picked by names and the full-text index, plus neighbours of the current scene) → the
  moment (current scene in full, its notes, the selection) → the conversation.
- New prompt `scribe.v1` (with golden and eval cases): who she is; ground every answer in the
  notes, outline and flow so far; point to where (scene links); offer two options when
  suggesting; say plainly when a page or fact is missing; never invent plot turns that fight the
  notes; mode rules.
- Tools (an agent loop like `agent.ts`): `search_book`, `open_scene`, `list_notes`, `open_note`;
  in Write and Vibe also `edit_note`, `create_note`, `propose_prose_edit` (the existing tracked
  proposal path; never a direct prose edit). Brainstorm uses no write tool until the author says
  "save that", then she edits or creates pages and reports them.
- Modes Brainstorm / Write / Vibe replace Auto / Ask / Plan in the chat (stored mode mapped:
  plan → Brainstorm, ask/auto → Write); Vibe also turns ghost text on and asks the rewrite and
  ghost text prompts for bolder suggestions.
- Default tier `strong` (DeepSeek V4 Pro); cost shown per answer as today.
- Sources: every answer lists the scenes and pages it used, clickable.

**3. Acceptance (the author).** Install; ask the six questions in `plan.md` on the real book;
mark each answer good or not, with what was missing. The main session may also run them
against a local copy with the author's key, the author running the command.

## Not in phase 1

The edit flow (phase 2), automatic note updates (phase 3), conversion of the story bible
(phase 4: until then the old story bible stays where it is and Ms Scribe also reads its sheets
as notes), Google Docs (phase 5), templates (phase 6).

## Gates

Unit tests for the repository, context builder (budget, order, whole-book switch, pick), tools,
mode mapping and the archive switch; one e2e step (make a page, ask Ms Scribe against the fake
provider, see the page edited and Undo it); full gates once at the end.
