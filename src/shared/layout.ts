import { z } from 'zod'

/**
 * The resizable panel layout (F-7.2). Every size is a fraction of the window width, so a
 * persisted layout means the same thing at any window size and the panels follow an OS resize
 * without a listener. The AI and references panels (M2) join `Layout` later as defaulted fields.
 */

export const LAYOUT_PANELS = ['sidebar', 'notes'] as const
export type LayoutPanel = (typeof LAYOUT_PANELS)[number]

/** Per-panel `[min, max]` fractions, plus the share the editor always keeps. */
export const LAYOUT_LIMITS = {
  sidebar: [0.15, 0.35],
  notes: [0.15, 0.5],
  editorMin: 0.3
} as const

const panelSchema = ([min, max]: readonly [number, number]): z.ZodObject<{
  open: z.ZodBoolean
  size: z.ZodNumber
}> => z.object({ open: z.boolean(), size: z.number().min(min).max(max) })

export const Layout = z.object({
  sidebar: panelSchema(LAYOUT_LIMITS.sidebar),
  notes: panelSchema(LAYOUT_LIMITS.notes)
})
export type Layout = z.infer<typeof Layout>

/** A fresh install: the tree open at just under a quarter, the notes closed at a quarter. */
export function defaultLayout(): Layout {
  return { sidebar: { open: true, size: 0.22 }, notes: { open: false, size: 0.25 } }
}

/** `size` clamped to the panel's own `[min, max]`. */
export function clampPanel(panel: LayoutPanel, size: number): number {
  const [min, max] = LAYOUT_LIMITS[panel]
  return Math.min(max, Math.max(min, size))
}

/**
 * The size `panel` may take so that the editor keeps at least `editorMin` of the window next
 * to the other open panels (closed panels count 0), then clamped to the panel's own limits.
 * Only the dragged panel gives way; the others keep their size.
 */
export function clampForEditorMin(layout: Layout, panel: LayoutPanel, proposed: number): number {
  const others = LAYOUT_PANELS.filter((p) => p !== panel).reduce(
    (sum, p) => sum + (layout[p].open ? layout[p].size : 0),
    0
  )
  const room = 1 - LAYOUT_LIMITS.editorMin - others
  return clampPanel(panel, Math.min(proposed, room))
}

/** Rounding slack for fractions that were produced by pixel arithmetic. */
const EPSILON = 1e-9

/** The share of the window left to the editor by the open panels. */
export function editorFraction(layout: Layout): number {
  return LAYOUT_PANELS.reduce((left, p) => left - (layout[p].open ? layout[p].size : 0), 1)
}

/** True when the open panels leave the editor its minimum. Each size is still checked by the schema. */
export function fitsEditorMin(layout: Layout): boolean {
  return editorFraction(layout) >= LAYOUT_LIMITS.editorMin - EPSILON
}

/**
 * A layout that respects the editor minimum: an already-valid layout is returned as is; an
 * over-wide one (a hand-edited app-state file) gives way notes first, then the sidebar.
 */
export function normalizeLayout(layout: Layout): Layout {
  if (fitsEditorMin(layout)) return layout
  let next: Layout = { ...layout, notes: { ...layout.notes } }
  if (next.notes.open) {
    next = {
      ...next,
      notes: { ...next.notes, size: clampForEditorMin(next, 'notes', next.notes.size) }
    }
  }
  if (!fitsEditorMin(next) && next.sidebar.open) {
    next = {
      ...next,
      sidebar: { ...next.sidebar, size: clampForEditorMin(next, 'sidebar', next.sidebar.size) }
    }
  }
  return next
}
