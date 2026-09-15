import { useEffect, useState, useSyncExternalStore } from 'react'

/** How close to the bottom edge (px) the pointer must be for the control bar to show. */
export const SHOW_ZONE_PX = 48
/** How long (ms) the bar stays after the last reason to show it has gone. */
export const HIDE_DELAY_MS = 1500
/** How long (ms) the bar shows on entering focus mode, so the author learns it exists. */
export const INTRO_MS = 2000

/**
 * The reasons the bar is held open: the pointer near the bottom edge, the pointer over the
 * bar, keyboard focus inside it, or a dialog it opened.
 */
export type HoldKind = 'edge' | 'bar' | 'focus' | 'dialog'

export interface AutoHide {
  /** Whether the bar is shown right now. */
  getSnapshot: () => boolean
  subscribe: (listener: () => void) => () => void
  /** Starts or ends one reason to keep the bar shown. */
  hold: (kind: HoldKind, on: boolean) => void
  /** Shows the bar for `INTRO_MS` (or until the holds release, whichever is later). */
  intro: () => void
  /** Clears the pending timer; the controller is done. */
  dispose: () => void
}

/**
 * The control bar's auto-hide (F-6.5), independent of React so its timing is testable with
 * fake timers: the bar shows while any hold is on and for the intro, and hides `HIDE_DELAY_MS`
 * after the last hold ends (never before the intro is over). Starting a hold cancels a pending
 * hide; a hold that is already in that state changes nothing.
 */
export function createAutoHide(): AutoHide {
  const holds: Record<HoldKind, boolean> = { edge: false, bar: false, focus: false, dialog: false }
  const listeners = new Set<() => void>()
  let visible = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** When the intro ends, as a timestamp; 0 once it is over. */
  let introUntil = 0

  const held = (): boolean => holds.edge || holds.bar || holds.focus || holds.dialog

  const show = (on: boolean): void => {
    if (visible === on) return
    visible = on
    for (const listener of listeners) listener()
  }

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** Hides after `delay` ms, or when the intro ends if that is later. */
  const scheduleHide = (delay: number): void => {
    cancel()
    const wait = Math.max(delay, introUntil - Date.now())
    timer = setTimeout(() => {
      timer = null
      introUntil = 0
      show(false)
    }, wait)
  }

  return {
    getSnapshot: () => visible,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hold(kind, on) {
      if (holds[kind] === on) return
      holds[kind] = on
      if (held()) {
        cancel()
        show(true)
      } else {
        scheduleHide(HIDE_DELAY_MS)
      }
    },
    intro() {
      introUntil = Date.now() + INTRO_MS
      show(true)
      if (!held()) scheduleHide(0)
    },
    dispose: cancel
  }
}

/**
 * The control bar's visibility and its `hold` setter as React state: one controller per
 * mounted bar, the intro on mount, the timer dropped on unmount.
 */
export function useAutoHide(): { visible: boolean; hold: AutoHide['hold'] } {
  const [controller] = useState(createAutoHide)
  useEffect(() => {
    controller.intro()
    return controller.dispose
  }, [controller])
  const visible = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { visible, hold: controller.hold }
}
