# Small fixes after phase 6 (2026-10-15)

The author asked (2026-10-15): "Do the small fixes you already know about." Three fixes; calls
marked "decided by Claude" go in `QUESTIONS.md` ("Small fixes (2026-10-15)").

## 1. Ms Scribe's prose suggestions as tracked changes in the scene

Today a `propose_prose_edit` shows only as a pending change card in the chat (old words struck,
new ones marked), and Apply puts it in the editor. The author's decision is "prose changes are
suggested as tracked changes", like the edit flow's fixes, which draw inline in the editor with
Accept / Reject.

- Her proposals also draw **inline in the scene** as tracked changes, through the **same
  machinery the edit flow uses** (edit-pass rows and `edit_change` rows drawn by the editor's
  tracked-change plugin, settled through `editPass:settle`); no second tracked-change system.
  Decided by Claude: one hidden run row per chat turn that proposed prose (or the simplest owner
  the existing machinery allows), not listed among edit passes or edit-flow results.
- The chat card stays and stays in sync: Accept / Reject in either place settles both; a card
  whose change was settled in the text shows it as accepted / rejected; a passage edited since
  shows "text changed" as the edit flow does.
- Nothing is applied on its own (the author's rule), in every mode.

## 2. Templates known before she writes

Phase 6's open item: Ms Scribe learns a folder's template only after `create_note`, so her first
page is often free text above empty headings, and filling them costs extra `edit_note` calls.

- The notes block she always gets lists, once, the folders that have a template and their
  headings (e.g. `Characters → template: Role, Appearance, Wants, …`), as content in the stable
  part (it changes only when templates or folder names change).
- New prompt version **`scribe.v4`** (v3 stays catalogued as shipped) only if a rule line is
  needed: "a new page in a folder with a template is written under its headings; leave a heading
  empty rather than invent". `create_note`'s local layout (phase 6) stays as the backstop.

## 3. Rewrite in Vibe

Rewrite (F-14.10, `rewrite.v5`, strong tier) is the same in every chat mode. In **Vibe** it may be
bolder: tighten hard, cut, reorder sentences, sharpen dialogue and add a missing beat, within the
selection and in the author's voice; in Write / Brainstorm it stays as now. New version
**`rewrite.v6`** with the mode said in the user turn (after the cached prefix); the fidelity check
(F-14.7) and the proposal flow unchanged; v5 stays as shipped. Decided by Claude: Vibe's Rewrite
offers the bolder version only (not both), since the author picked Vibe for bolder.

## Tests

Unit: a Scribe proposal creates its tracked change and draws in the scene; settling from the text
updates the card and from the card updates the text; text changed since marks it; the notes block
lists folder templates; `scribe.v4` and `rewrite.v6` goldens and eval cases (Vibe vs Write).
e2e: in `e2e/scribe.spec.ts` the Vibe proposal shows inline in the scene, Accept in the text
applies it and the card shows accepted; a Rewrite in Vibe sends `rewrite.v6` with the bolder line.
