import { describe, expect, it } from 'vitest'
import { WHEEL_ZOOM_COALESCE_MS, ZOOM_MENU_STEPS, wheelZoomStepFor, zoomStepFor } from './zoom'

/** A keyboard event as the listener sees it, with every modifier up unless named. */
const chord = (
  key: string,
  mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

describe('ZOOM_MENU_STEPS (F-7.10)', () => {
  it('maps each View › Zoom item to its step', () => {
    expect(ZOOM_MENU_STEPS).toEqual({ zoomIn: 'in', zoomOut: 'out', zoomReset: 'reset' })
  })
})

describe('zoomStepFor (F-2.7 chords)', () => {
  it('reads Ctrl+= / Ctrl+- / Ctrl+0, and Ctrl+Shift+= as zoom in', () => {
    expect(zoomStepFor(chord('=', { ctrlKey: true }))).toBe('in')
    expect(zoomStepFor(chord('+', { ctrlKey: true, shiftKey: true }))).toBe('in')
    // The numpad reports `+` without Shift.
    expect(zoomStepFor(chord('+', { ctrlKey: true }))).toBe('in')
    expect(zoomStepFor(chord('-', { ctrlKey: true }))).toBe('out')
    expect(zoomStepFor(chord('0', { ctrlKey: true }))).toBe('reset')
  })

  it('ignores the same keys without Ctrl, with Alt, and every other chord', () => {
    expect(zoomStepFor(chord('='))).toBeNull()
    expect(zoomStepFor(chord('0'))).toBeNull()
    expect(zoomStepFor(chord('-'))).toBeNull()
    // Ctrl+Alt+0 is the editor's Paragraph command (F-3.1), not a zoom reset.
    expect(zoomStepFor(chord('0', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(zoomStepFor(chord('=', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(zoomStepFor(chord('k', { ctrlKey: true }))).toBeNull()
  })
})

describe('wheelZoomStepFor (F-7.10)', () => {
  /** A wheel event as the listener sees it, with every modifier up unless named. */
  const wheel = (
    deltaY: number,
    mods: Partial<Pick<WheelEvent, 'ctrlKey' | 'altKey' | 'metaKey'>> = {}
  ): Pick<WheelEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'deltaY'> => ({
    deltaY,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    ...mods
  })

  it('zooms in on a wheel up and out on a wheel down while Ctrl is held', () => {
    expect(wheelZoomStepFor(wheel(-120), 1000, null)).toBe('in')
    expect(wheelZoomStepFor(wheel(120), 1000, null)).toBe('out')
  })

  it('ignores the wheel without Ctrl, with Alt or Meta, and with no vertical movement', () => {
    expect(wheelZoomStepFor(wheel(-120, { ctrlKey: false }), 1000, null)).toBeNull()
    expect(wheelZoomStepFor(wheel(-120, { altKey: true }), 1000, null)).toBeNull()
    expect(wheelZoomStepFor(wheel(-120, { metaKey: true }), 1000, null)).toBeNull()
    expect(wheelZoomStepFor(wheel(0), 1000, null)).toBeNull()
  })

  it('takes one step per burst: the deltas that follow a step within the window are dropped', () => {
    expect(wheelZoomStepFor(wheel(-4), 1000, 1000)).toBeNull()
    expect(wheelZoomStepFor(wheel(-4), 1000 + WHEEL_ZOOM_COALESCE_MS - 1, 1000)).toBeNull()
    expect(wheelZoomStepFor(wheel(-4), 1000 + WHEEL_ZOOM_COALESCE_MS, 1000)).toBe('in')
    // The direction still decides once the window has passed.
    expect(wheelZoomStepFor(wheel(4), 1000 + WHEEL_ZOOM_COALESCE_MS, 1000)).toBe('out')
  })
})
