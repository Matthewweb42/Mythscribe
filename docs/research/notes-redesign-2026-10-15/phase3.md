# Phase 3: notes updates (2026-10-15)

Part of `plan.md` ("Notes updates"). The author's decision: notes are updated four ways: when
told in chat, an "Update notes" step, a category of the edit flow, and automatically after a
chapter. Phase 1 built the chat (Write mode edits pages; Brainstorm writes on "save that") and
phase 2 the edit-flow category (`editNotes.v1`, note edits with Undo in the results). This phase
adds the step and the automatic update, and closes the chat's route into the flow.

The author said "go ahead and build, I'll test later" (2026-10-15): everything below marked
"decided by Claude" is unconfirmed and logged in `QUESTIONS.md`.

## 1. The step: "Update notes from this…" (decided by Claude)

- **Where:** the Manuscript tree's context menu on a scene, a chapter (folder) and the manuscript
  root ("Update notes from this scene / chapter / the whole book"), and an **Update notes…**
  button in the Notes tab's header (scope: the open scene's chapter, or the book when no scene is
  open).
- **What it does:** opens the edit flow (phase 2 panel) pre-filled: category Update notes, that
  scope, Quick (Deep for the whole book). The price shows as usual; the author presses Run. No
  second runner, no second panel: `useEditFlowStore`'s existing pre-fill (the chat already uses it).
- Hidden while Use AI is off, like the Edit button.

## 2. The chat (decided by Claude)

- A chat request to update the notes from a scope ("update my notes from this chapter", "update
  the notes from the book") in **Brainstorm** opens the flow pre-filled as above, as phase 2 does
  for the other stages. In **Write** and **Vibe** Ms Scribe keeps editing pages herself with her
  tools (phase 1); no change there.

## 3. Automatic after a chapter (decided by Claude where marked)

- **Switch:** Settings › AI, "Update my notes after I finish a chapter", **off by default** (the
  author's decision), with the price per chapter shown under it (fast tier, about 0.2¢ for a
  chapter of the author's book) and a **daily cap** (default 10 runs a day, a number field 1–50;
  decided by Claude). Stored per project in the settings KV (decided by Claude: the book decides,
  like the archived features).
- **When:** the author **leaves a chapter after writing in it**: the open scene changes from one
  in chapter A to one outside A (another chapter, a note page, the Outline, or the project
  closing is NOT a trigger: decided by Claude, so closing the app never spends), and a scene in A
  was saved with changed text since A was entered. The renderer tracks "written in" (it owns the
  open scene and its saves) and calls `editFlow:chapterLeft { chapterId }`.
- **Main decides** (one owner): it runs only when the switch is on, Use AI is on and the feature
  is allowed (`assertFeatureAllowed`, caps and Cloud balance as for every AI call), today's count
  is under the cap, no edit-flow run is in progress (otherwise skipped, not queued: the next leave
  catches up), and A's text hash differs from the hash at A's last automatic update (so writing
  undone, or leaving twice, never pays twice). Otherwise it does nothing and says why only in the
  log, never a dialog.
- **The run:** the phase 2 runner with `{ categories: ['notes'], depth: 'quick', scope: chapter
  A }`, marked automatic. An automatic run never replaces the panel's kept manual result for that
  scope (kept under its own key; decided by Claude) and never opens the panel.
- **What the author sees:** the note pages change with the phase 1 highlights and Undo; a line in
  the activity bar, "Notes updated from <chapter title>: N pages", that opens the run's results in
  the edit flow panel (each note edit with Undo). A run that changes nothing leaves no line.
  A failed run (no key, no balance, rate limit) leaves one line with the cause; it does not retry.
- **Cost:** recorded in the usage ledger as `editFlow` like a manual run; the daily cap counts
  runs started, reset at local midnight.

## Data sharing

The `editFlow` row (and its mirror on the docs page) gains: "also, when you turn on updating your
notes after a chapter, the same for that chapter each time you leave it after writing in it (at
most the daily cap)".

## Not changing

Prompts (`editNotes.v1` as is: no `-u` unless a prompt changes), the edit flow's other
categories, Ms Scribe's tools, the manuscript (an update never touches prose).

## Tests

Unit: the trigger rule in the renderer (leave after a changed save → one call; leave without
writing, leave to a note page, close → none); main's gate (switch off, cap reached, run in
progress, hash unchanged → no run; otherwise one Quick notes run on the chapter, counted; the
count resets on a new day); the automatic run's result kept apart from the manual one; the
activity line (N pages; none when nothing changed; the cause on failure); the step's pre-fill from
the tree menu, the Notes button and a Brainstorm chat request; the settings switch and cap.
e2e (`e2e/editflow.spec.ts`): turn the switch on, write in a scene of chapter 1, open a scene of
chapter 2 → against the fake provider a note page changes, the activity line appears and opens
the results, Undo restores the page; leaving again without writing makes no second request.
