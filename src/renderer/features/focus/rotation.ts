import { useEffect } from 'react'
import { useBackgroundStore } from './backgroundStore'

/**
 * Background rotation (F-6.3): while focus mode shows the backdrop and rotation is on, every
 * `intervalMinutes` the next uploaded background (list order, wrapping) becomes the current
 * one through the store's `select`, so it persists exactly like a manual pick. Nothing runs
 * with fewer than two backgrounds. Mounted by `App` only while focus mode is active, so
 * leaving focus mode stops the timer and entering restarts it.
 */
export function useBackgroundRotation(): void {
  const enabled = useBackgroundStore((s) => s.settings?.rotation.enabled ?? false)
  const intervalMinutes = useBackgroundStore((s) => s.settings?.rotation.intervalMinutes ?? 0)
  const count = useBackgroundStore((s) => s.backgrounds.length)

  useEffect(() => {
    if (!enabled || intervalMinutes <= 0 || count < 2) return
    const timer = setInterval(
      () => {
        const { backgrounds, settings, select } = useBackgroundStore.getState()
        if (backgrounds.length < 2) return
        const at = backgrounds.findIndex((b) => b.id === settings?.backgroundId)
        select(backgrounds[(at + 1) % backgrounds.length]?.id ?? null)
      },
      intervalMinutes * 60 * 1000
    )
    return () => clearInterval(timer)
  }, [enabled, intervalMinutes, count])
}

/** Renders nothing; exists so `App` can mount the rotation only in focus mode. */
export function BackgroundRotation(): null {
  useBackgroundRotation()
  return null
}
