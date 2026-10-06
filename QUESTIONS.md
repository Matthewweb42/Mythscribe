# Questions for the author

Written by Claude during unattended `/goal` runs. Each entry is a decision Claude made without
waiting (recorded in `FEATURES.md` as "decided by Claude, unconfirmed"), or a step only the author can
do. Review, then confirm, change, or delete the entry.

<!-- Entry format:
## YYYY-MM-DD · F-x.y · short title
- Question:
- Chosen: (what was built)
- Alternatives:
- To change it: (files or feature to revisit)
-->

## 2026-10-05 · F-11.2b · How birth years and ages work
- Question: where the birth year lives, which characters an event lists ages for, and how ages reach the continuity check.
- Chosen: a new character sheet field "Born (story year)" holding a whole number (exports gain a `born` column); an event lists ages for characters whose tag is on one of its scenes or who are a scene's POV; continuity sends "age N at this scene" in place of the sheet's static Age (no new reference kind, no prompt change), and an observed age whose number differs becomes a candidate.
- Alternatives: birth years kept in the timeline instead of the sheet; inline mentions counted as appearances (left to F-11.2c's logs); a separate `age` reference kind (needs a new prompt version).
- To change it: `src/shared/entities.ts`, `src/shared/timeline.ts`, `src/main/ai/continuity.ts`, `features/timeline/`.

## 2026-10-05 · F-11.2c · What counts as an appearance, and how conflicts show
- Question: what makes a character or setting "appear" in a scene, and whether the two-places-at-once conflict becomes a continuity finding.
- Chosen: an appearance is the entity's tag linked to the scene, mentioned in it (F-4.12 scan), or (characters) the scene's POV; "scenes set here" match the setting's name in Location; the conflict is shown on the character page and the timeline card only, never stored.
- Alternatives: count only explicit tag links; feed conflicts into the F-13.4 findings list (needs main-side storage and dismissal).
- To change it: `src/renderer/features/timeline/usageLog.ts`, `features/entities/UsageLog.tsx`.

## 2026-10-05 · F-11.2c · Appearances replaces the "Scenes" list on character and setting pages
- Question: the F-9.4 "Scenes" list (links and mentions) and the new Appearances log (links, mentions, POV) listed the same thing differently on one page.
- Chosen: for characters and settings, Appearances replaces the F-9.4 list and shows each scene's chapter as the old list did; world entities keep the F-9.4 list.
- Alternatives: keep both; add POV to the F-9.4 list and drop the log's reading-order view.
- To change it: `features/entities/EntityEditor.tsx`, `UsageLog.tsx`.
