# Vibe's bolder suggestions + Notes in every prompt (2026-10-15)

Status: built 2026-10-15 (decisions in `QUESTIONS.md`, "Vibe and Notes in prompts (2026-10-15)").

Part of `plan.md`. The author's words for Vibe: "Vibe is ghostwriting is active and will suggest
much more aggressive changes if necessary." Phase 1 turned ghost text on in Vibe; the bolder
suggestions were never built. Building it showed a gap from the fresh start, fixed here too.
The author said "keep going" (2026-10-15); calls marked "decided by Claude" are unconfirmed and go
in `QUESTIONS.md` ("Vibe and Notes in prompts (2026-10-15)").

## A. Notes take the old story bible's place in every v1 prompt

The fresh start stopped Ms Scribe and the background jobs from reading the old sheets, but every
other v1 prompt still builds its story-bible block from them through
`src/main/ai/context/storyBible.ts` `buildStoryBible`: ghost text, Rewrite, critique, What next,
scene suggestions, the old chat (`ghostText.ts`, `rewrite.ts`, `critique.ts`, `whatNext.ts`,
`sceneSuggest.ts`, `chat.ts`). While the old story bible is archived
(`storyBibleArchivedIn(db, 'v1')`):

- `buildStoryBible` leaves out the tag bank, the scene's tags and the entity sheets (hidden data),
  and keeps what is not story-bible data: the scene's place (chapter, position) and its
  neighbours' metadata and summaries.
- It adds the **note pages the scene names**: a page whose title (or a word of it of 4+ letters
  that is a name, e.g. "Tash" in "Tash — powers") appears in the scene's text, synopsis or scene
  notes, ranked by how often, each page's text cut to fit, within the block's existing budget
  (`STORY_BIBLE_TOKEN_BUDGET`, and the much smaller ghost budget, where a page gives its first
  lines). Reuse the page matching Ms Scribe already does (`src/main/scribe2/context.ts` /
  `source.ts`); do not write a second matcher. Decided by Claude: titles only, no AI.
- The rendered block keeps the prompt's heading and format (the content of the slot changes, not
  the prompt text, so no new prompt versions for these features). It still goes into each
  feature's context hash, so a changed note misses the local cache.
- One owner: the change is inside `buildStoryBible` (or one helper it calls), not in six callers.

## B. Vibe: bolder prose suggestions from Ms Scribe

- New prompt version **`scribe.v3`** (`scribe.v2` stays catalogued as shipped). The mode is said
  in the moment block (after the cached prefix, so switching mode never busts the cache).
- **Write** (as now): when asked, she suggests; options in text, "one close to her plan and one
  bolder"; prose changes when asked.
- **Vibe** (new): she is bolder and does the work: when her answer finds a passage that could be
  stronger, she proposes the change herself as a tracked change (`propose_prose_edit`), unasked,
  and she may go big when it is warranted: rewrite a whole paragraph, cut, reorder a beat, add a
  missing line of dialogue. At most 3 prose proposals per answer (decided by Claude), each tied to
  a reason in one line. Still never changes prose on her own: every proposal is a tracked change
  the author accepts or rejects (the author's rule).
- **Brainstorm** unchanged.
- Ghost text in Vibe keeps its length cap (≤ 60 tokens, a sentence or two; decided by Claude: a
  longer continuation is Draft with AI's job).

## Tests

Unit: `buildStoryBible` with the switch archived has no tag, sheet or bank line and carries the
named pages within budget (the ghost budget too), and with the switch on renders exactly as
before (golden unchanged); each of the six features' prompts with archived bible carries no sheet
text. `scribe.v3` golden tests per mode; eval cases: a Vibe answer with prose proposals, a Write
answer without unasked proposals; `run.ts` passes the mode; at most 3 proposals kept in Vibe.
e2e: in `e2e/scribe.spec.ts`, a Vibe question against the fake provider shows a tracked change in
the scene that Accept applies.
