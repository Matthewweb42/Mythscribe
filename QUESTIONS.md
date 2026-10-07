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

## 2026-10-06 · F-7.2 · Dockable columns (layout 3c)
- Question: How do column widths, stacking, and the editor's grip behave?
- Chosen: Each panel keeps its own width; a column is as wide as its first open panel and
  resizing it resizes every panel stacked in it, so the author's widths from before survived
  unchanged. Stacked panels split the column height evenly (no handle between them yet). The
  editor is never stacked with a panel. Its grip and menu float in a 12 px strip over the
  toolbar's left padding instead of a header row. Dropping uses 48 px strips along a panel's
  left and right edges for "new column here" and its top/bottom halves for "stack above/below".
  View › Reset layout restores the default columns, open panels, and widths (the sidebar tab and
  the floating windows stay).
- Alternatives: a stored width per column; a resize handle between stacked panels; a visible
  header row above the editor.
- To change it: `src/shared/dock.ts`, `src/shared/layout.ts` (`columnWidth`, `withColumnSize`),
  `src/renderer/features/shell/Dock.tsx`.
