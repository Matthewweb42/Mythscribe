import { create } from 'zustand'
import {
  REFERENCE_PINS_MAX,
  addPin,
  hasPin,
  movePin,
  removePin,
  type ReferencePin
} from '@shared/references'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** What a pin over the cap says; the list is for the handful in use. */
export const REFERENCES_FULL_MESSAGE = `References holds ${REFERENCE_PINS_MAX} pins at most. Unpin something first.`

/**
 * The one owner of the quick reference panel's pins in the renderer (F-9.6): the ordered list
 * the project stores under one settings key. `load` reads it when a project opens (main has
 * already dropped the pins whose target is gone); every change applies at once and is written
 * with one `reference:set`, and a refused write puts the list back and toasts the cause. The
 * list arithmetic is `@shared/references`, the same main runs. What a pin shows is not here: a
 * card reads its entity, node, or notes from the store that owns it.
 */
interface ReferenceState {
  pins: readonly ReferencePin[]
  loaded: boolean
  load: () => Promise<void>
  clear: () => void
  /**
   * Pins the target at the end of the list and opens the panel if it is closed, so the author
   * sees where it went. Already pinned: only the panel opens. At the cap: a warning, no change.
   */
  pin: (pin: ReferencePin) => Promise<void>
  /** Unpins the target; main deletes the file of an image pin. A no-op when it is not pinned. */
  unpin: (pin: ReferencePin) => Promise<void>
  /** Moves the pin at `from` to position `to` (clamped); a no-op when nothing would change. */
  move: (from: number, to: number) => Promise<void>
  /**
   * Opens the OS image dialog and pins what was chosen (main copies the files in). Refused files
   * are named in one warning; a cancelled dialog changes nothing.
   */
  addImages: () => Promise<void>
}

/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0
/** Bumped by every write, so only the latest write's answer (or failure) touches the list. */
let writes = 0

function openPanel(): void {
  const layout = useLayoutStore.getState()
  if (!layout.layout.references.open) layout.toggle('references')
}

/** Applies `next` at once and writes it; a failure reverts to `previous` unless a newer change is already on its way. */
async function commit(
  previous: readonly ReferencePin[],
  next: readonly ReferencePin[]
): Promise<void> {
  if (next === previous) return
  const mine = generation
  const write = ++writes
  useReferenceStore.setState({ pins: next })
  try {
    const stored = await ipc().invoke('reference:set', { pins: [...next] })
    if (mine === generation && write === writes) useReferenceStore.setState({ pins: stored.pins })
  } catch (err) {
    if (mine !== generation) return // the project closed meanwhile; nothing to revert
    if (write === writes) useReferenceStore.setState({ pins: previous })
    toast.error(describeError(err))
  }
}

export const useReferenceStore = create<ReferenceState>((set, get) => ({
  pins: [],
  loaded: false,

  async load() {
    const mine = ++generation
    const value = await ipc().invoke('reference:get', undefined)
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    set({ pins: value.pins, loaded: true })
  },

  clear() {
    generation++
    writes++
    set({ pins: [], loaded: false })
  },

  async pin(pin) {
    const previous = get().pins
    if (hasPin(previous, pin)) {
      openPanel()
      return
    }
    const next = addPin(previous, pin)
    if (next === previous) {
      toast.warning(REFERENCES_FULL_MESSAGE)
      return
    }
    openPanel()
    await commit(previous, next)
  },

  async unpin(pin) {
    const previous = get().pins
    await commit(previous, removePin(previous, pin))
  },

  async move(from, to) {
    const previous = get().pins
    await commit(previous, movePin(previous, from, to))
  },

  async addImages() {
    const mine = generation
    try {
      const result = await ipc().invoke('reference:addImages', undefined)
      // Null is a cancelled file dialog, not a change.
      if (result === null || mine !== generation) return
      writes++ // main's list is newer than any write still in flight
      set({ pins: result.pins.pins })
      if (result.skipped.length > 0)
        toast.warning(
          `Not pinned (not an image under 20 MB, or References is full): ${result.skipped.join(', ')}`
        )
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
    }
  }
}))

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetReferenceStore(): void {
  useReferenceStore.getState().clear()
}
