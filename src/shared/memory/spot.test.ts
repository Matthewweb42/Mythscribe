import { describe, expect, it } from 'vitest'
import { SPOT_EVERY, spotPicked } from './spot'

describe('spot-check picks (F-16.17, P2a-D8)', () => {
  it('picks about one claim in twenty, the same one every time', () => {
    const keys = Array.from({ length: 2_000 }, (_, i) => `scene|${i}|Mara's eyes were grey|eyes`)
    const picked = keys.filter((key) => spotPicked(key))
    expect(picked.length).toBeGreaterThan(2_000 / SPOT_EVERY / 2)
    expect(picked.length).toBeLessThan((2_000 / SPOT_EVERY) * 2)
    expect(keys.filter((key) => spotPicked(key))).toEqual(picked)
    expect(spotPicked('anything', 1)).toBe(true)
  })
})
