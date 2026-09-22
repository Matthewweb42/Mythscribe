import { z } from 'zod'

/**
 * Document zoom (F-7.10): Ctrl+= / Ctrl+- / Ctrl+0 and the View › Zoom items scale the writing
 * surface — the manuscript's font size and column width together — and nothing else. Main owns
 * the value (it steps the persisted one and answers it, `view:zoomDocument`); the renderer
 * multiplies the project's formatting by it in `editor/column.ts`. Independent of the
 * per-project font size (F-3.6), which stays the manuscript's own setting.
 */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

export const DEFAULT_ZOOM = 1
export const ZOOM_MIN = Math.min(...ZOOM_STEPS)
export const ZOOM_MAX = Math.max(...ZOOM_STEPS)

/** A zoom factor the app will apply; a hand-edited file may hold one between two steps. */
export const ZoomFactor = z.number().min(ZOOM_MIN).max(ZOOM_MAX)
export type ZoomFactor = z.infer<typeof ZoomFactor>

/** What a zoom request asks for: one step either way, or back to 100 %. */
export const ZoomStep = z.enum(['in', 'out', 'reset'])
export type ZoomStep = z.infer<typeof ZoomStep>

/**
 * The factor one step from `current`: the next entry of the table either way, staying put at
 * its ends, and `reset` is always 100 %. A factor between steps (a hand-edited app-state.json)
 * snaps to the nearest one first, so the next keystroke lands back on the table.
 */
export function nextZoom(current: number, step: ZoomStep): number {
  if (step === 'reset') return DEFAULT_ZOOM
  const from = nearestZoom(current)
  const [next] =
    step === 'in'
      ? ZOOM_STEPS.filter((f) => f > from)
      : ZOOM_STEPS.filter((f) => f < from).reverse()
  return next ?? from
}

/** The table entry closest to `factor`; exactly between two steps takes the lower one. */
export function nearestZoom(factor: number): number {
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - factor) < Math.abs(best - factor) ? step : best
  )
}

/** The factor as the author reads it: `100 %`, `125 %`. */
export function formatZoom(factor: number): string {
  return `${Math.round(factor * 100)} %`
}

/**
 * Interface size (F-7.10): everything that is not the manuscript — sidebar, panels, toolbar,
 * dialogs — in three settings, applied as Electron's window zoom factor. The document is inside
 * the window, so it scales with the interface too and the document zoom multiplies on top.
 */
export const UI_SCALES = ['small', 'medium', 'large'] as const

export const UiScale = z.enum(UI_SCALES)
export type UiScale = z.infer<typeof UiScale>

/** The window zoom factor each setting applies; `medium` is the untouched 100 %. */
export const UI_SCALE_FACTORS: Record<UiScale, number> = {
  small: 0.9,
  medium: 1,
  large: 1.15
}

/** What the Appearance tab calls each setting. */
export const UI_SCALE_LABELS: Record<UiScale, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large'
}

/**
 * The two app-wide view settings, kept under one key in app-state.json. Main is the only writer
 * of either: it steps the document zoom, applies the interface size to every window, and answers
 * the pair, which is what the renderer mirrors.
 */
export const ViewSettings = z.object({
  /** The multiplier the editing surface applies to the project's font size and column width. */
  editorZoom: ZoomFactor.default(DEFAULT_ZOOM),
  uiScale: UiScale.default('medium')
})
export type ViewSettings = z.infer<typeof ViewSettings>

/** A fresh install: the document at 100 % and the interface at its normal size. */
export function defaultViewSettings(): ViewSettings {
  return { editorZoom: DEFAULT_ZOOM, uiScale: 'medium' }
}
