# Phase 2: the edit flow (2026-10-15)

Part of `plan.md`. Grows out of the existing edit passes (F-14.15, `editPass.v2`); the archived
Proofread (F-14.12) is replaced by the flow's Proofreading stage.

## The author's answers (2026-10-15, confirmed)

- **Stages** (the author's definitions, kept as written in the UI's help text):
  1. **Developmental editing**: a big-picture review of the entire story: plot structure,
     character arcs, pacing, point of view, world-building, thematic consistency. First stage,
     after a rough draft; often leads to major rewrites.
  2. **Line editing**: sentence-by-sentence and paragraph-by-paragraph craft and style: flow,
     rhythm, voice, word choice, syntax, showing vs telling, cutting repetitive or awkward
     phrasing. After the developmental issues are fixed.
  3. **Copyediting**: technical and mechanical: grammar, spelling, punctuation, capitalisation,
     consistency (eye colour, timeline logic), adherence to a style guide. Near the end.
  4. **Proofreading**: final quality control: residual typos, missing words, weird spacing,
     layout or formatting errors in the final typeset file. Last.
- **Focused checks** as well: Continuity, Plot holes & logic, Character voice, Line edit &
  spelling.
- **Update notes** is its own category: new characters, events and timeline go into Notes as
  direct edits, highlighted, with Undo.
- **Results** in a panel in the right column beside the manuscript: an issue list; click an issue
  to jump to its passage (selected and centred, as Ms Scribe's sources do); fixable issues carry a
  tracked change accepted or rejected inline in the text.
- **Depth:** **Quick** = the chosen scene or chapter on the fast tier (DeepSeek Flash) with the
  notes; **Deep** = the whole book and notes on the strong tier (DeepSeek Pro). Priced first.

## Decided by Claude, unconfirmed

- **Start** from an "Edit" button in the right column's header (beside Ms Scribe) or by asking
  Ms Scribe ("edit this chapter for continuity", which opens the flow pre-filled). The flow:
  pick stage(s) and/or checks, scope (this scene, this chapter, the whole book), Quick or Deep;
  the price shows before Run.
- **Developmental** answers as a short written overview at the top of the results (strengths,
  the biggest structural problems, each with passages) plus issues; it never proposes prose
  rewrites on its own (they would be major rewrites the author decides). Deep only, since it
  needs the whole story; Quick on a chapter gives a chapter-level version.
- **Line editing, Copyediting, Proofreading, Line edit & spelling** propose tracked changes for
  what they fix; Continuity, Plot holes, Character voice give issues with passages and, where a
  line fix is obvious, a tracked change.
- **Proofreading** checks the manuscript text and the compile settings (spacing, missing words,
  stray characters, scene breaks, heading consistency); it does not read the exported PDF/ePub
  file itself (said in its help text).
- **Copyediting's style guide:** the Notes page named "Style guide" if one exists; otherwise
  standard conventions, consistent with the book's own usage.
- Long scopes run as one request per chapter (Quick) or per budget-sized slice with the whole
  notes and book map as the cached prefix (Deep), results merged in book order; a run can be
  stopped, keeping what came back.
- Results are kept per project (the latest run per scope), so closing the app doesn't lose them;
  an issue whose passage changed is marked "text changed".
- Prompts: new versions per stage family as needed (e.g. `edit.developmental.v1`,
  `edit.line.v1`, `edit.copy.v1`, `edit.proof.v1`, `edit.checks.v1`), each compact, JSON out,
  every issue citing an exact quote checked locally (reuse `scribe2/quotes.ts`).

## Tests

Unit: the flow's request plan (scope, slices, tier, price), quote checking, merge order, result
keeping; prompt goldens and eval cases. e2e (`e2e/editflow.spec.ts`): Quick copyedit of a scene
against the fake provider: the issue list, jump to the passage, accept one tracked change and
reject another; an Update notes result edits a page with Undo.
