import { z } from 'zod'
import { DockPanelId, columnOf, defaultDock, isValidDock, normalizeDock } from './dock'
import { SidebarTabId } from './sidebarTabs'

/**
 * The resizable panel layout (F-7.2). Every size is a fraction of the window width, so a
 * persisted layout means the same thing at any window size and the panels follow an OS resize
 * without a listener. The assistant panel (F-5.4) and the references panel (F-9.6) each joined as
 * a field `StoredLayout` defaults, so a layout written before them still loads. Since layout 3c
 * (2026-10-06) the panels sit in dockable columns (`dock`, see `./dock.ts`): a column is as wide
 * as its first open panel's `size`, panels stacked in one column share its width, and the editor
 * minimum is counted per column, not per panel.
 */

export const LAYOUT_PANELS = ['sidebar', 'notes', 'tags', 'assistant', 'references'] as const
export type LayoutPanel = (typeof LAYOUT_PANELS)[number]

/** Per-panel `[min, max]` fractions, plus the share the editor always keeps. */
export const LAYOUT_LIMITS = {
  sidebar: [0.15, 0.35],
  notes: [0.15, 0.5],
  // The tags column (replaced the tag bar above the editor, 2026-10-06): chips in a narrow column.
  tags: [0.15, 0.35],
  // F-5.4: wide enough at its floor for the tab strip, the mode radios, and the composer.
  assistant: [0.2, 0.5],
  // F-9.6: a column of cards, as narrow and as wide as the sidebar.
  references: [0.15, 0.35],
  editorMin: 0.3
} as const

const panelSchema = ([min, max]: readonly [number, number]): z.ZodObject<{
  open: z.ZodBoolean
  size: z.ZodNumber
}> => z.object({ open: z.boolean(), size: z.number().min(min).max(max) })

const sidebarSchema = panelSchema(LAYOUT_LIMITS.sidebar)

/** The assistant panel (F-5.4) starts closed; Ctrl+K opens it at just under a third. */
const DEFAULT_ASSISTANT = { open: false, size: 0.3 } as const

const assistantSchema = panelSchema(LAYOUT_LIMITS.assistant)

/** The tags column starts closed at a fifth of the window; the header's Tags button opens it. */
const DEFAULT_TAGS = { open: false, size: 0.2 } as const

const tagsSchema = panelSchema(LAYOUT_LIMITS.tags)

/** The references panel (F-9.6) starts closed; the first pin opens it at just under a quarter. */
const DEFAULT_REFERENCES = { open: false, size: 0.22 } as const

const referencesSchema = panelSchema(LAYOUT_LIMITS.references)

/** The panels focus mode shows as floating windows (F-6.6). */
export const FLOATING_PANELS = ['notes', 'assistant'] as const
export type FloatingPanel = (typeof FLOATING_PANELS)[number]

/** The smallest a floating window may be, in px: room for the notes editor or the composer. */
export const FLOATING_MIN_SIZE = { width: 280, height: 200 } as const

/** How far one arrow key moves a floating window (Shift: resizes it), in px. */
export const FLOATING_KEY_STEP_PX = 16

/**
 * A floating window's geometry (F-6.6), in px from the viewport's top-left corner. Stored in
 * px rather than as fractions: a window keeps its size across displays and is clamped into
 * the viewport at render time (`clampRect`), not by this schema, which only holds the floor.
 */
export const Rect = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(FLOATING_MIN_SIZE.width),
  height: z.number().min(FLOATING_MIN_SIZE.height)
})
export type Rect = z.infer<typeof Rect>

/** A viewport's size in px; `clampRect` keeps windows inside it. */
export interface Viewport {
  width: number
  height: number
}

const floatingSchema = z.object({ notes: Rect, assistant: Rect })

/** The notes window at the right third of a 1280 × 800 window and the assistant below it. */
const DEFAULT_FLOATING: Record<FloatingPanel, Rect> = {
  notes: { x: 860, y: 48, width: 380, height: 320 },
  assistant: { x: 860, y: 392, width: 380, height: 380 }
}

/** A fresh copy of the default floating-window geometry (F-6.6). */
export function defaultFloating(): Record<FloatingPanel, Rect> {
  return { notes: { ...DEFAULT_FLOATING.notes }, assistant: { ...DEFAULT_FLOATING.assistant } }
}

export const Layout = z.object({
  // F-7.3: the sidebar's active tab.
  sidebar: sidebarSchema.extend({ tab: SidebarTabId }),
  notes: panelSchema(LAYOUT_LIMITS.notes),
  // The tags column (2026-10-06), which replaced the F-4.4 tag bar above the editor.
  tags: tagsSchema,
  // F-5.4: the AI assistant panel on the right, beside the notes.
  assistant: assistantSchema,
  // F-9.6: the quick reference panel on the right, between the main pane and the assistant.
  references: referencesSchema,
  // F-6.6: where the notes and assistant windows float in focus mode.
  floating: floatingSchema,
  // Layout 3c: the columns the panels and the editor sit in, left to right.
  dock: z.object({
    columns: z.array(z.array(DockPanelId)).refine(isValidDock, 'not a valid panel arrangement')
  })
})
export type Layout = z.infer<typeof Layout>

/**
 * `Layout` as read from the app-state file: a layout written before F-7.3 has no tab and parses
 * to Manuscript. The IPC contract uses the strict `Layout`, so the input and output types match.
 */
export const StoredLayout = z.object({
  sidebar: sidebarSchema.extend({ tab: SidebarTabId.default('manuscript') }),
  notes: Layout.shape.notes,
  // A layout written before the tags column has none and parses to the closed default; the old
  // `tagBar` key (F-4.4) is unknown to this schema and dropped on parse.
  tags: tagsSchema.default({ ...DEFAULT_TAGS }),
  // A layout written before F-5.4 has no assistant panel and parses to the closed default.
  assistant: assistantSchema.default({ ...DEFAULT_ASSISTANT }),
  // A layout written before F-9.6 has no references panel and parses to the closed default.
  references: referencesSchema.default({ ...DEFAULT_REFERENCES }),
  // A layout written before F-6.6 has no floating windows and parses to the default geometry.
  floating: floatingSchema.default(defaultFloating()),
  // A layout written before the dock (3c) has none and parses to the default arrangement, so
  // every panel keeps its open state and width; a damaged one is repaired, never refused.
  dock: z
    .object({ columns: z.array(z.array(z.string())) })
    .transform((dock) => ({ columns: normalizeDock(dock.columns) }))
    .default({ columns: defaultDock() })
    .catch({ columns: defaultDock() })
})

/**
 * A fresh install: the Manuscript tab open at just under a quarter, the notes closed at a
 * quarter, the tags closed at a fifth, the assistant
 * closed at just under a third, the references closed at just under a quarter, the floating
 * windows at their default geometry.
 */
export function defaultLayout(): Layout {
  return {
    sidebar: { open: true, size: 0.22, tab: 'manuscript' },
    notes: { open: false, size: 0.25 },
    tags: { ...DEFAULT_TAGS },
    assistant: { ...DEFAULT_ASSISTANT },
    references: { ...DEFAULT_REFERENCES },
    floating: defaultFloating(),
    dock: { columns: defaultDock() }
  }
}

/**
 * `rect` kept inside `viewport` (F-6.6): the size is preserved and the window moved back in
 * when it overflows; only when it is larger than the viewport itself does it shrink, never
 * under `minSize` (a viewport smaller than that still gets a window of `minSize` at the
 * origin). Values are rounded to whole px, so the stored geometry stays tidy.
 */
export function clampRect(
  rect: Rect,
  viewport: Viewport,
  minSize: { width: number; height: number } = FLOATING_MIN_SIZE
): Rect {
  const width = Math.round(
    Math.min(Math.max(minSize.width, viewport.width), Math.max(minSize.width, rect.width))
  )
  const height = Math.round(
    Math.min(Math.max(minSize.height, viewport.height), Math.max(minSize.height, rect.height))
  )
  const x = Math.round(Math.min(Math.max(0, viewport.width - width), Math.max(0, rect.x)))
  const y = Math.round(Math.min(Math.max(0, viewport.height - height), Math.max(0, rect.y)))
  return { x, y, width, height }
}

/** True when two rects have the same geometry. */
export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** `size` clamped to the panel's own `[min, max]`. */
export function clampPanel(panel: LayoutPanel, size: number): number {
  const [min, max] = LAYOUT_LIMITS[panel]
  return Math.min(max, Math.max(min, size))
}

/** The side panels in `panel`'s column, top to bottom (the panel alone when it is not docked). */
export function columnPanels(layout: Layout, panel: LayoutPanel): LayoutPanel[] {
  const column = layout.dock.columns[columnOf(layout.dock.columns, panel)] ?? [panel]
  return column.filter((id): id is LayoutPanel => id !== 'editor')
}

/** A column's width: the size of its first open panel, or 0 while all of its panels are closed. */
export function columnWidth(layout: Layout, column: readonly DockPanelId[]): number {
  const first = column.find((id): id is LayoutPanel => id !== 'editor' && layout[id].open)
  return first === undefined ? 0 : layout[first].size
}

/**
 * The `[min, max]` a column may take: the tightest bounds of its open panels and `panel` (the
 * one being resized or opened), so every panel stacked in it stays inside its own limits.
 */
export function columnLimits(layout: Layout, panel: LayoutPanel): [number, number] {
  const members = columnPanels(layout, panel).filter((p) => p === panel || layout[p].open)
  const min = Math.max(...members.map((p) => LAYOUT_LIMITS[p][0]))
  const max = Math.min(...members.map((p) => LAYOUT_LIMITS[p][1]))
  return [min, Math.max(min, max)]
}

/** The widths of the side columns other than `panel`'s (all of them for null), summed. */
function otherColumnsWidth(layout: Layout, panel: LayoutPanel | null): number {
  const own = panel === null ? -1 : columnOf(layout.dock.columns, panel)
  return layout.dock.columns.reduce(
    (sum, column, index) => (index === own ? sum : sum + columnWidth(layout, column)),
    0
  )
}

/**
 * The width `panel`'s column may take so that the editor keeps at least `editorMin` of the
 * window next to the other columns (columns whose panels are all closed count 0), then clamped
 * to the column's limits. Only the dragged column gives way; the others keep their width.
 */
export function clampForEditorMin(layout: Layout, panel: LayoutPanel, proposed: number): number {
  const room = 1 - LAYOUT_LIMITS.editorMin - otherColumnsWidth(layout, panel)
  const [min, max] = columnLimits(layout, panel)
  return Math.min(max, Math.max(min, Math.min(proposed, room)))
}

/** `layout` with every panel of `panel`'s column at `size` (each kept inside its own limits). */
export function withColumnSize(layout: Layout, panel: LayoutPanel, size: number): Layout {
  let next = layout
  for (const p of columnPanels(layout, panel)) {
    next = { ...next, [p]: { ...next[p], size: clampPanel(p, size) } }
  }
  return next
}

/** Rounding slack for fractions that were produced by pixel arithmetic. */
const EPSILON = 1e-9

/** The share of the window left to the editor by the side columns. */
export function editorFraction(layout: Layout): number {
  return 1 - otherColumnsWidth(layout, null)
}

/** True when the side columns leave the editor its minimum. Each size is still checked by the schema. */
export function fitsEditorMin(layout: Layout): boolean {
  return editorFraction(layout) >= LAYOUT_LIMITS.editorMin - EPSILON
}

/** The order in which open panels' columns give way when the editor would get too little: assistant, references, tags, notes, sidebar. */
const GIVE_WAY_ORDER: readonly LayoutPanel[] = [
  'assistant',
  'references',
  'tags',
  'notes',
  'sidebar'
]

/**
 * The order in which open panels close when shrinking every one to its floor still leaves the
 * editor too little (five panels at their floors do): the tags column first, then the
 * references, the notes, the assistant, and the sidebar last.
 */
const CLOSE_ORDER: readonly LayoutPanel[] = ['tags', 'references', 'notes', 'assistant', 'sidebar']

/**
 * A layout that respects the editor minimum: an already-valid layout is returned as is; an
 * over-wide one (a hand-edited app-state file, or another panel opening beside wide ones)
 * gives way assistant first, then the references, the tags, the notes, and the sidebar. Five
 * panels at their floors no longer leave the editor its minimum (the tags column made five), so
 * when shrinking is not enough panels close in `CLOSE_ORDER`, never `keep` (the panel the author
 * just opened), until the editor has its share.
 */
export function normalizeLayout(layout: Layout, keep?: LayoutPanel): Layout {
  let next = layout
  for (const panel of GIVE_WAY_ORDER) {
    if (fitsEditorMin(next)) return next
    if (!next[panel].open) continue
    const width = columnWidth(next, columnPanels(next, panel))
    next = withColumnSize(next, panel, clampForEditorMin(next, panel, width))
  }
  for (const panel of CLOSE_ORDER) {
    if (fitsEditorMin(next)) return next
    if (panel === keep || !next[panel].open) continue
    next = { ...next, [panel]: { ...next[panel], open: false } }
  }
  return next
}
