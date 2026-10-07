import { z } from 'zod'

/**
 * The dockable columns of the project screen (layout 3c, author request 2026-10-06): which panel
 * sits in which column, left to right, and which panels share a column top to bottom. Pure
 * functions only, so the renderer's drag and drop, the panel menus, and main's validation all
 * work on the same arrangement. Sizes and open flags stay on the panels in `Layout`; this module
 * only orders them.
 */

/** Every panel the dock arranges; `editor` is the main pane, the others are the side panels. */
export const DOCK_PANELS = [
  'sidebar',
  'editor',
  'notes',
  'tags',
  'references',
  'assistant'
] as const
export const DockPanelId = z.enum(DOCK_PANELS)
export type DockPanelId = z.infer<typeof DockPanelId>

/** The columns, left to right; each lists its panels top to bottom. */
export type DockColumns = DockPanelId[][]

/** What each panel is called in its menu and its grip's label. */
export const DOCK_PANEL_LABEL: Record<DockPanelId, string> = {
  sidebar: 'Sidebar',
  editor: 'Editor',
  notes: 'Notes',
  tags: 'Tags',
  references: 'References',
  assistant: 'Assistant'
}

/**
 * The default arrangement: the sidebar, the editor, then the notes, the tags, the references,
 * and the assistant each in a column of its own. Closed panels keep their slot, so the tags and
 * the references (closed on a fresh install) open right of the notes.
 */
export function defaultDock(): DockColumns {
  return [['sidebar'], ['editor'], ['notes'], ['tags'], ['references'], ['assistant']]
}

/**
 * True for a well-formed arrangement: every panel exactly once, no empty column, and the editor
 * alone in its column (it is never stacked with a side panel).
 */
export function isValidDock(columns: readonly (readonly string[])[]): boolean {
  const seen = columns.flat()
  if (seen.length !== DOCK_PANELS.length) return false
  if (!DOCK_PANELS.every((panel) => seen.includes(panel))) return false
  if (columns.some((column) => column.length === 0)) return false
  return columns.every((column) => !column.includes('editor') || column.length === 1)
}

/**
 * Any stored arrangement repaired into a valid one: unknown names and repeats are dropped, a
 * stacked editor is taken out into its own column where it was, empty columns go, and a panel
 * that is missing gets its own column at the end (the editor in the middle when it is the one
 * missing). A valid arrangement comes back equal.
 */
export function normalizeDock(columns: readonly (readonly string[])[]): DockColumns {
  const seen = new Set<DockPanelId>()
  const next: DockColumns = []
  for (const column of columns) {
    const kept: DockPanelId[] = []
    for (const name of column) {
      const parsed = DockPanelId.safeParse(name)
      if (!parsed.success || seen.has(parsed.data)) continue
      seen.add(parsed.data)
      if (parsed.data === 'editor') {
        if (kept.length > 0) next.push([...kept])
        kept.length = 0
        next.push(['editor'])
      } else {
        kept.push(parsed.data)
      }
    }
    if (kept.length > 0) next.push(kept)
  }
  for (const panel of DOCK_PANELS) {
    if (seen.has(panel)) continue
    if (panel === 'editor') next.splice(Math.ceil(next.length / 2), 0, ['editor'])
    else next.push([panel])
  }
  return next
}

/** The index of the column that holds `panel`. */
export function columnOf(columns: DockColumns, panel: DockPanelId): number {
  return columns.findIndex((column) => column.includes(panel))
}

/**
 * Where a dragged panel lands: in a new column beside another panel's column (`beside`, left or
 * right of it), or stacked into that panel's column above or below it (`stack`).
 */
export type DockTarget =
  | { kind: 'beside'; panel: DockPanelId; side: 'left' | 'right' }
  | { kind: 'stack'; panel: DockPanelId; position: 'before' | 'after' }

/** `columns` without `panel`, dropping the column it leaves empty. */
function without(columns: DockColumns, panel: DockPanelId): DockColumns {
  return columns
    .map((column) => column.filter((id) => id !== panel))
    .filter((column) => column.length > 0)
}

/**
 * `panel` moved to `target`. A drop on itself, a stack onto or of the editor, and a drop that
 * would leave everything where it is return `columns` itself, so a caller can tell "nothing
 * moved" by identity.
 */
export function movePanel(
  columns: DockColumns,
  panel: DockPanelId,
  target: DockTarget
): DockColumns {
  if (target.panel === panel) return columns
  if (target.kind === 'stack' && (panel === 'editor' || target.panel === 'editor')) return columns
  const rest = without(columns, panel)
  const at = columnOf(rest, target.panel)
  if (at < 0) return columns
  let next: DockColumns
  if (target.kind === 'beside') {
    next = rest.map((column) => [...column])
    next.splice(target.side === 'left' ? at : at + 1, 0, [panel])
  } else {
    next = rest.map((column, index) => {
      if (index !== at) return [...column]
      const row = column.indexOf(target.panel)
      const copy = [...column]
      copy.splice(target.position === 'before' ? row : row + 1, 0, panel)
      return copy
    })
  }
  return sameDock(next, columns) ? columns : next
}

/** True when two arrangements are the same, column by column. */
export function sameDock(a: DockColumns, b: DockColumns): boolean {
  return (
    a.length === b.length &&
    a.every(
      (column, index) =>
        column.length === b[index]?.length && column.every((id, row) => id === b[index]?.[row])
    )
  )
}

/**
 * The keyboard and menu alternative to a drag (Move left / Move right): a panel stacked with
 * others steps out into a column of its own on that side of its column; a panel alone in its
 * column trades places with the nearest column on that side the author can see (`visible`),
 * skipping columns whose panels are all closed. Returns `columns` itself when there is nowhere
 * to go.
 */
export function stepPanel(
  columns: DockColumns,
  panel: DockPanelId,
  direction: 'left' | 'right',
  visible: (column: readonly DockPanelId[]) => boolean
): DockColumns {
  const at = columnOf(columns, panel)
  if (at < 0) return columns
  const column = columns[at] ?? []
  if (column.length > 1) {
    const next = columns.map((c) => c.filter((id) => id !== panel))
    next.splice(direction === 'left' ? at : at + 1, 0, [panel])
    return next
  }
  const step = direction === 'left' ? -1 : 1
  let neighbour = at + step
  while (neighbour >= 0 && neighbour < columns.length) {
    const candidate = columns[neighbour]
    if (candidate && visible(candidate)) break
    neighbour += step
  }
  if (neighbour < 0 || neighbour >= columns.length) return columns
  const next = columns.filter((_, index) => index !== at).map((c) => [...c])
  // Removing the column shifted the neighbour left by one when it was to the right.
  const target = direction === 'left' ? neighbour : neighbour - 1
  next.splice(direction === 'left' ? target : target + 1, 0, [...column])
  return next
}

/** Where on a panel the pointer is, as a drop target: the outer edges open a new column, the rest stacks. */
export interface DropRect {
  left: number
  top: number
  width: number
  height: number
}

/** How wide the strip along a panel's left and right edges is that means "a new column here", in px. */
export const DOCK_EDGE_PX = 48

/**
 * The drop target for a pointer at (`x`, `y`) over `panel`'s box `rect`: within `DOCK_EDGE_PX` of
 * the left or right edge (or anywhere over the editor, which never stacks: its left or right
 * half) a new column on that side; otherwise the top or bottom half stacks above or below it.
 */
export function dropTargetAt(panel: DockPanelId, rect: DropRect, x: number, y: number): DockTarget {
  const fromLeft = x - rect.left
  const fromRight = rect.left + rect.width - x
  const edge = Math.min(DOCK_EDGE_PX, rect.width / 3)
  if (panel === 'editor') {
    return { kind: 'beside', panel, side: fromLeft < rect.width / 2 ? 'left' : 'right' }
  }
  if (fromLeft < edge) return { kind: 'beside', panel, side: 'left' }
  if (fromRight < edge) return { kind: 'beside', panel, side: 'right' }
  return { kind: 'stack', panel, position: y - rect.top < rect.height / 2 ? 'before' : 'after' }
}
