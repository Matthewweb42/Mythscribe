import { useEffect, useState } from 'react'

/** How far one arrow key moves a handle, in px. */
export const RESIZE_KEY_STEP_PX = 16

export type ResizeSide = 'left' | 'right' | 'top' | 'bottom'

interface ResizeHandleProps {
  /**
   * Which edge of its panel the handle sits on; decides the axis and which pointer direction
   * grows the panel. `left`/`right` resize a width, `top`/`bottom` a height (F-4.4).
   */
  side: ResizeSide
  /** The panel's current size, minimum, and maximum in the owner's unit (for the ARIA values). */
  value: number
  min: number
  max: number
  ariaLabel: string
  /**
   * Called for every pointer move while dragging and for every arrow key, with the px the panel
   * should grow (positive) or shrink (negative) by since the last call.
   */
  onChange: (deltaPx: number) => void
  /**
   * Turns `value`/`min`/`max` into the whole numbers the ARIA values show. Defaults to whole
   * percents of a 0–1 fraction (the width panels); a px-based owner passes `Math.round`.
   */
  ariaValue?: (value: number) => number
}

const percent = (fraction: number): number => Math.round(fraction * 100)

/** The classes that place the strip on its edge and set the cursor, per side. */
const EDGE: Record<ResizeSide, string> = {
  left: 'top-0 bottom-0 -left-1 w-2 cursor-col-resize',
  right: 'top-0 bottom-0 -right-1 w-2 cursor-col-resize',
  top: 'left-0 right-0 -top-1 h-2 cursor-row-resize',
  bottom: 'left-0 right-0 -bottom-1 h-2 cursor-row-resize'
}

/**
 * The one drag handle for resizable panels (F-7.2): an absolutely positioned strip on one edge
 * of a `relative` panel, wider than it looks so it is easy to grab, highlighted on hover and
 * while dragging. Drags use window listeners so a fast pointer never escapes the strip; the
 * arrow keys along the handle's axis move it by `RESIZE_KEY_STEP_PX`. It reports px deltas
 * only; the owner of the size turns them into whatever unit it stores.
 */
export function ResizeHandle({
  side,
  value,
  min,
  max,
  ariaLabel,
  onChange,
  ariaValue = percent
}: ResizeHandleProps): React.JSX.Element {
  /** The pointer's position along the handle's axis at the last reported move; null while not dragging. */
  const [drag, setDrag] = useState<number | null>(null)
  const horizontal = side === 'left' || side === 'right'
  // A handle on the right or bottom edge grows its panel when it moves right or down; one on
  // the left or top, when it moves left or up.
  const sign = side === 'right' || side === 'bottom' ? 1 : -1

  useEffect(() => {
    if (drag === null) return
    const onMove = (event: PointerEvent): void => {
      const at = horizontal ? event.clientX : event.clientY
      const delta = at - drag
      if (delta === 0) return
      setDrag(at)
      onChange(delta * sign)
    }
    const onUp = (): void => setDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, onChange, sign, horizontal])

  const [shrinkKey, growKey] = horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== shrinkKey && event.key !== growKey) return
    event.preventDefault()
    onChange((event.key === growKey ? RESIZE_KEY_STEP_PX : -RESIZE_KEY_STEP_PX) * sign)
  }

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuenow={ariaValue(value)}
      aria-valuemin={ariaValue(min)}
      aria-valuemax={ariaValue(max)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        setDrag(horizontal ? event.clientX : event.clientY)
      }}
      onKeyDown={onKeyDown}
      className={`absolute z-10 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none ${EDGE[side]} ${drag === null ? '' : 'bg-accent/40'}`}
    />
  )
}
