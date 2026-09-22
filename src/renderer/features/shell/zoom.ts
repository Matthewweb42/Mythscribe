import type { MenuItemId } from '@shared/menu'
import { formatZoom, type ZoomStep } from '@shared/zoom'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { APP_SHORTCUTS, matchesShortcut, type Chord } from '@renderer/features/shell/shortcuts'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * View zoom (F-7.10): main owns the factor — it steps the persisted one, scales the window, and
 * answers what it applied — so this side only asks and announces. The announcement is a toast
 * (F-7.6), not the status bar, because the zoom works on the welcome screen too, where there is
 * no status bar. A failure says its cause and changes nothing.
 */
export async function zoomWindow(step: ZoomStep): Promise<void> {
  try {
    const { factor } = await ipc().invoke('window:zoom', { step })
    toast.info(`Zoom ${formatZoom(factor)}`)
  } catch (err) {
    toast.error(describeError(err))
  }
}

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
