import { z } from 'zod'

/**
 * View zoom (F-7.10): Ctrl+= / Ctrl+- / Ctrl+0 and the View › Zoom items scale the whole window
 * like a browser through Electron's zoom factor. Main owns the value — it steps the persisted
 * factor, applies it to the window, and answers what it applied (`window:zoom`) — so this file
 * holds only the step table and the pure helpers both sides share. Independent of the
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
