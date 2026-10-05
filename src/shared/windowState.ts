import { z } from 'zod'

/** A window rectangle in screen coordinates, as Electron's `getNormalBounds` answers it. */
export const WindowBounds = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})
export type WindowBounds = z.infer<typeof WindowBounds>

/**
 * Window state (F-7.9), kept under one key in app-state.json and written only by main: where the
 * window was and whether it was maximized when it last closed, the project that was open, and
 * whether that project opens again on launch. Fullscreen is focus mode (F-6.1) and is never
 * restored; the bounds are the normal ones underneath it.
 */
export const WindowState = z.object({
  bounds: WindowBounds.nullable().default(null),
  maximized: z.boolean().default(false),
  /** The folder of the project open at the last quit; null after File › Close project. */
  lastProject: z.string().nullable().default(null),
  /** On by default: the author picks up where they stopped. */
  reopenLastProject: z.boolean().default(true)
})
export type WindowState = z.infer<typeof WindowState>

export function defaultWindowState(): WindowState {
  return { bounds: null, maximized: false, lastProject: null, reopenLastProject: true }
}

/** The startup settings the Appearance tab shows and changes (F-7.9). */
export const StartupSettings = z.object({ reopenLastProject: z.boolean() })
export type StartupSettings = z.infer<typeof StartupSettings>

/** How much of a saved window must still be on some display to be put back there. */
export const MIN_VISIBLE = { width: 120, height: 80 } as const

/**
 * The saved bounds when they can be put back, else null (the default size, centered). A window
 * left on a monitor that is gone, or dragged almost off-screen, would open where the author cannot
 * reach it, so it has to overlap one display's work area by at least `MIN_VISIBLE`, and its top
 * edge (the title bar) has to be inside that area. The size never goes below `minSize`.
 */
export function restorableBounds(
  saved: WindowBounds | null,
  workAreas: readonly WindowBounds[],
  minSize: { width: number; height: number }
): WindowBounds | null {
  if (saved === null) return null
  const fits = workAreas.some((area) => {
    const overlapWidth =
      Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)
    const overlapHeight =
      Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y)
    const topInside = saved.y >= area.y && saved.y < area.y + area.height
    return overlapWidth >= MIN_VISIBLE.width && overlapHeight >= MIN_VISIBLE.height && topInside
  })
  if (!fits) return null
  return {
    ...saved,
    width: Math.max(saved.width, minSize.width),
    height: Math.max(saved.height, minSize.height)
  }
}

/** The project to open at launch: the last one, when the author wants it and it is still there. */
export function projectToReopen(
  state: WindowState,
  isProject: (folder: string) => boolean
): string | null {
  if (!state.reopenLastProject || state.lastProject === null) return null
  return isProject(state.lastProject) ? state.lastProject : null
}
