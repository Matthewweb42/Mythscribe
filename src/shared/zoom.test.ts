import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ZOOM,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  ZoomFactor,
  ZoomStep,
  formatZoom,
  nearestZoom,
  nextZoom
} from './zoom'

describe('view zoom (F-7.10)', () => {
  it('runs from 67 % to 200 % in rising steps, with 100 % the default and on the table', () => {
    expect([...ZOOM_STEPS]).toEqual([...ZOOM_STEPS].sort((a, b) => a - b))
    expect(ZOOM_MIN).toBe(0.67)
    expect(ZOOM_MAX).toBe(2)
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM)
  })

  it('steps one entry either way and stays put at the ends', () => {
    expect(nextZoom(1, 'in')).toBe(1.1)
    expect(nextZoom(1.1, 'in')).toBe(1.25)
    expect(nextZoom(1, 'out')).toBe(0.9)
    expect(nextZoom(0.67, 'out')).toBe(0.67)
    expect(nextZoom(2, 'in')).toBe(2)
  })

  it('walks the whole table from either end without skipping a step', () => {
    let rising = ZOOM_MIN
    const up = [rising]
    while (rising < ZOOM_MAX) {
      rising = nextZoom(rising, 'in')
      up.push(rising)
    }
    expect(up).toEqual([...ZOOM_STEPS])

    let falling = ZOOM_MAX
    const down = [falling]
    while (falling > ZOOM_MIN) {
      falling = nextZoom(falling, 'out')
      down.push(falling)
    }
    expect(down).toEqual([...ZOOM_STEPS].reverse())
  })

  it('resets to 100 % from anywhere', () => {
    expect(nextZoom(2, 'reset')).toBe(DEFAULT_ZOOM)
    expect(nextZoom(0.67, 'reset')).toBe(DEFAULT_ZOOM)
    expect(nextZoom(1, 'reset')).toBe(DEFAULT_ZOOM)
  })

  it('snaps a factor between steps (a hand-edited file) to the nearest one', () => {
    expect(nearestZoom(1.02)).toBe(1)
    expect(nearestZoom(1.2)).toBe(1.25)
    // Exactly between two steps takes the lower one.
    expect(nearestZoom(0.85)).toBe(0.8)
    expect(nextZoom(1.02, 'in')).toBe(1.1)
    expect(nextZoom(1.04, 'out')).toBe(0.9)
  })

  it('accepts a factor inside the range and refuses one outside it', () => {
    expect(ZoomFactor.parse(1.25)).toBe(1.25)
    // A value between steps is still applicable; only the range is enforced.
    expect(ZoomFactor.parse(1.02)).toBe(1.02)
    expect(ZoomFactor.safeParse(0.5).success).toBe(false)
    expect(ZoomFactor.safeParse(3).success).toBe(false)
    expect(ZoomFactor.safeParse('1').success).toBe(false)
  })

  it('names the three steps and nothing else', () => {
    expect(ZoomStep.options).toEqual(['in', 'out', 'reset'])
    expect(ZoomStep.safeParse('reset-all').success).toBe(false)
  })

  it('reads the factor as a percentage', () => {
    expect(formatZoom(1)).toBe('100 %')
    expect(formatZoom(1.25)).toBe('125 %')
    expect(formatZoom(0.67)).toBe('67 %')
    expect(formatZoom(2)).toBe('200 %')
  })
})
