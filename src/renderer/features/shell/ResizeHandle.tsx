import { useEffect, useState } from 'react'

/** How far one arrow key moves a handle, in px. */
export const RESIZE_KEY_STEP_PX = 16

interface ResizeHandleProps {
  /** Which edge of its panel the handle sits on; decides which pointer direction widens it. */
  side: 'left' | 'right'
  /** The panel's current size, minimum, and maximum as fractions of the window (for the ARIA values). */
  value: number
  min: number
  max: number
  ariaLabel: string
  /**
   * Called for every pointer move while dragging and for every arrow key, with the px the panel
   * should grow (positive) or shrink (negative) by since the last call.
   */
  onChange: (deltaPx: number) => void
}

const percent = (fraction: number): number => Math.round(fraction * 100)

/**
 * The one drag handle for resizable panels (F-7.2): an absolutely positioned strip on one edge
 * of a `relative` panel, wider than it looks so it is easy to grab, highlighted on hover and
 * while dragging. Drags use window listeners so a fast pointer never escapes the strip; the
 * arrow keys move it by `RESIZE_KEY_STEP_PX`. It reports px deltas only; the owner of the size
 * turns them into whatever unit it stores.
 */
export function ResizeHandle({
  side,
  value,
  min,
  max,
  ariaLabel,
  onChange
}: ResizeHandleProps): React.JSX.Element {
  /** The pointer's x at the last reported move; null while not dragging. */
  const [dragX, setDragX] = useState<number | null>(null)
  // A handle on the right edge widens its panel when it moves right; one on the left, when it moves left.
  const sign = side === 'right' ? 1 : -1

  useEffect(() => {
    if (dragX === null) return
    const onMove = (event: PointerEvent): void => {
      const delta = event.clientX - dragX
      if (delta === 0) return
      setDragX(event.clientX)
      onChange(delta * sign)
    }
    const onUp = (): void => setDragX(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragX, onChange, sign])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    onChange((event.key === 'ArrowRight' ? RESIZE_KEY_STEP_PX : -RESIZE_KEY_STEP_PX) * sign)
  }

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuenow={percent(value)}
      aria-valuemin={percent(min)}
      aria-valuemax={percent(max)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDragX(event.clientX)
      }}
      onKeyDown={onKeyDown}
      className={`absolute top-0 bottom-0 z-10 w-2 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none ${side === 'right' ? '-right-1' : '-left-1'} ${dragX === null ? '' : 'bg-accent/40'}`}
    />
  )
}
