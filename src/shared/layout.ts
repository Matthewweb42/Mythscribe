import { z } from 'zod'
import { SidebarTabId } from './sidebarTabs'

/**
 * The resizable panel layout (F-7.2). Every size is a fraction of the window width, so a
 * persisted layout means the same thing at any window size and the panels follow an OS resize
 * without a listener. The assistant panel (F-5.4) joined as a field `StoredLayout` defaults; the
 * references panel (M2) joins the same way.
 */

export const LAYOUT_PANELS = ['sidebar', 'notes', 'assistant'] as const
export type LayoutPanel = (typeof LAYOUT_PANELS)[number]

/** Per-panel `[min, max]` fractions, plus the share the editor always keeps. */
export const LAYOUT_LIMITS = {
  sidebar: [0.15, 0.35],
  notes: [0.15, 0.5],
  // F-5.4: wide enough at its floor for the tab strip, the mode radios, and the composer.
  assistant: [0.2, 0.5],
  editorMin: 0.3
} as const

const panelSchema = ([min, max]: readonly [number, number]): z.ZodObject<{
  open: z.ZodBoolean
  size: z.ZodNumber
}> => z.object({ open: z.boolean(), size: z.number().min(min).max(max) })

const sidebarSchema = panelSchema(LAYOUT_LIMITS.sidebar)

/**
 * Floor of the draggable tag bar (F-4.4), in px. The ceiling is 60 % of the window height,
 * enforced by the renderer against the live window (`clampTagBarHeight`) and by `max-height`
 * at render, not by this schema: a static bound cannot express it, and unlike the width
 * panels the height is stored in px rather than as a scale-invariant fraction.
 */
export const TAG_BAR_MIN_HEIGHT = 100
/** The share of the window height the tag bar may take at most. */
export const TAG_BAR_MAX_FRACTION = 0.6

/** The share of the tag bar's width the metadata pane may take (F-4.5), as `[min, max]`. */
export const TAG_BAR_SPLIT_LIMITS = [0.3, 0.7] as const

const tagBarSchema = z.object({
  open: z.boolean(),
  height: z.number().min(TAG_BAR_MIN_HEIGHT),
  // F-4.5: the metadata pane's share of the bar's width; a fraction of the bar, not the window.
  split: z.number().min(TAG_BAR_SPLIT_LIMITS[0]).max(TAG_BAR_SPLIT_LIMITS[1])
})

const DEFAULT_TAG_BAR = { open: true, height: 120, split: 0.4 } as const
/** The assistant panel (F-5.4) starts closed; Ctrl+K opens it at just under a third. */
const DEFAULT_ASSISTANT = { open: false, size: 0.3 } as const

const assistantSchema = panelSchema(LAYOUT_LIMITS.assistant)

export const Layout = z.object({
  // F-7.3: the sidebar's active tab.
  sidebar: sidebarSchema.extend({ tab: SidebarTabId }),
  notes: panelSchema(LAYOUT_LIMITS.notes),
  // F-4.4: the document tag bar above the editor; a height, so it never joins LAYOUT_PANELS.
  tagBar: tagBarSchema,
  // F-5.4: the AI assistant panel on the right, beside the notes.
  assistant: assistantSchema
})
export type Layout = z.infer<typeof Layout>

/**
 * `Layout` as read from the app-state file: a layout written before F-7.3 has no tab and parses
 * to Manuscript. The IPC contract uses the strict `Layout`, so the input and output types match.
 */
export const StoredLayout = z.object({
  sidebar: sidebarSchema.extend({ tab: SidebarTabId.default('manuscript') }),
  notes: Layout.shape.notes,
  // A layout written before F-4.4 has no tag bar and parses to the default one; one written
  // before F-4.5 has a tag bar without `split`, which parses to the default split on its own.
  tagBar: tagBarSchema
    .extend({ split: tagBarSchema.shape.split.default(DEFAULT_TAG_BAR.split) })
    .default({ ...DEFAULT_TAG_BAR }),
  // A layout written before F-5.4 has no assistant panel and parses to the closed default.
  assistant: assistantSchema.default({ ...DEFAULT_ASSISTANT })
})

/**
 * A fresh install: the Manuscript tab open at just under a quarter, the notes closed at a
 * quarter, the tag bar open at 120 px with the metadata pane at 40 % of it, the assistant
 * closed at just under a third.
 */
export function defaultLayout(): Layout {
  return {
    sidebar: { open: true, size: 0.22, tab: 'manuscript' },
    notes: { open: false, size: 0.25 },
    tagBar: { ...DEFAULT_TAG_BAR },
    assistant: { ...DEFAULT_ASSISTANT }
  }
}

/** The tag bar height clamped to `[TAG_BAR_MIN_HEIGHT, 60 % of the given window height]` (F-4.4). */
export function clampTagBarHeight(height: number, windowInnerHeight: number): number {
  const max = Math.max(TAG_BAR_MIN_HEIGHT, windowInnerHeight * TAG_BAR_MAX_FRACTION)
  return Math.min(max, Math.max(TAG_BAR_MIN_HEIGHT, height))
}

/** The metadata pane's share of the tag bar clamped to `TAG_BAR_SPLIT_LIMITS` (F-4.5). */
export function clampTagBarSplit(split: number): number {
  const [min, max] = TAG_BAR_SPLIT_LIMITS
  return Math.min(max, Math.max(min, split))
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

/** The order in which open panels give way when the editor would get too little: assistant, notes, sidebar. */
const GIVE_WAY_ORDER: readonly LayoutPanel[] = ['assistant', 'notes', 'sidebar']

/**
 * A layout that respects the editor minimum: an already-valid layout is returned as is; an
 * over-wide one (a hand-edited app-state file, or a third panel opening beside two wide ones)
 * gives way assistant first, then notes, then the sidebar. Every panel at its floor still
 * leaves the editor its minimum, so the result always fits.
 */
export function normalizeLayout(layout: Layout): Layout {
  let next = layout
  for (const panel of GIVE_WAY_ORDER) {
    if (fitsEditorMin(next)) return next
    if (!next[panel].open) continue
    next = {
      ...next,
      [panel]: { ...next[panel], size: clampForEditorMin(next, panel, next[panel].size) }
    }
  }
  return next
}
