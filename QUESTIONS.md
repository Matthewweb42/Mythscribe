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

## 2026-10-06 · F-4.4 / F-4.5 · Tags column and notes column layout
- Question: How should the tags column and the moved scene metadata look?
- Chosen: The tags column starts closed and opens at 20 % of the window (15–35 %), to the right of
  the notes. The notes column has a 4-line Synopsis box on top, the notes in the middle, and the
  rest of the metadata in a "Scene details" disclosure at the bottom, collapsed by default; it
  stays open across scene switches and resets when the column closes (not persisted). With five panels open at their
  minimums the editor would get less than 30 %, so opening one now closes others (tags,
  references, notes, assistant, sidebar, never the one being opened) once shrinking them is not
  enough.
- Alternatives: tags open by default; Scene details above the notes or remembered open; let the
  editor drop under 30 %.
- To change it: `src/shared/layout.ts` (`DEFAULT_TAGS`, `normalizeLayout`),
  `src/renderer/features/editor/NotesPanel.tsx` (`SceneDetails`).
