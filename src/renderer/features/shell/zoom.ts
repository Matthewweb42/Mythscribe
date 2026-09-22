import type { MenuItemId } from '@shared/menu'
import type { ZoomStep } from '@shared/zoom'
import { APP_SHORTCUTS, matchesShortcut, type Chord } from '@renderer/features/shell/shortcuts'

/**
 * How a keystroke, a Ctrl+wheel, or a View item turns into a document-zoom step (F-7.10). The
 * step itself is run by `viewStore.zoomDocument`, which is the one owner of the value and of the
 * announcement; this file is only the input side, and every function here is pure.
 */

/** The View › Zoom items (F-7.1) and the step each one asks for. */
export const ZOOM_MENU_STEPS = {
  zoomIn: 'in',
  zoomOut: 'out',
  zoomReset: 'reset'
} as const satisfies Partial<Record<MenuItemId, ZoomStep>>

/**
 * The chords the zoom listener binds: Ctrl+= / Ctrl+- / Ctrl+0 from the registry (F-2.7), plus
 * `+` for the layouts that report that for the key marked `+` (with Shift) and for the numpad
 * (without it).
 */
const ZOOM_CHORDS: readonly [Chord, ZoomStep][] = [
  [APP_SHORTCUTS.zoomIn.chord, 'in'],
  [{ key: '+', ctrl: true }, 'in'],
  [{ key: '+', ctrl: true, shift: true }, 'in'],
  [APP_SHORTCUTS.zoomOut.chord, 'out'],
  [APP_SHORTCUTS.zoomReset.chord, 'reset']
]

/** The step a keystroke asks for, or null when it is not one of the zoom chords. */
export function zoomStepFor(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): ZoomStep | null {
  return ZOOM_CHORDS.find(([chord]) => matchesShortcut(event, chord))?.[1] ?? null
}

/**
 * How long after a wheel step the next one is ignored (F-7.10). One notch of a real wheel emits
 * several deltas, and a trackpad pinch arrives on Windows as Ctrl+wheel with a stream of small
 * ones; a burst is one step, which is what a browser does too.
 */
export const WHEEL_ZOOM_COALESCE_MS = 150

/**
 * The step a Ctrl+wheel asks for, or null when it is not a zoom or it falls inside the burst
 * that follows the last step. Ctrl only (Alt+wheel is the OS's, and the plain wheel scrolls);
 * up is in, down is out, and a wheel that reported no vertical movement asks for nothing.
 * `lastAt` is when the last step was taken, or null when there has been none.
 */
export function wheelZoomStepFor(
  event: Pick<WheelEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'deltaY'>,
  now: number,
  lastAt: number | null
): ZoomStep | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null
  if (event.deltaY === 0) return null
  if (lastAt !== null && now - lastAt < WHEEL_ZOOM_COALESCE_MS) return null
  return event.deltaY < 0 ? 'in' : 'out'
}
