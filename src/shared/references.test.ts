import { describe, expect, it } from 'vitest'
import {
  REFERENCE_PINS_MAX,
  ReferencePins,
  addPin,
  dedupePins,
  defaultReferencePins,
  hasPin,
  movePin,
  pinKey,
  referenceImageUrl,
  removePin,
  type ReferencePin
} from './references'

const entity = (id: string): ReferencePin => ({ type: 'entity', id })
const note = (id: string): ReferencePin => ({ type: 'note', id })
const image = (file: string): ReferencePin => ({ type: 'image', file })

describe('ReferencePins (F-9.6)', () => {
  it('starts empty and parses the three pin types', () => {
    expect(defaultReferencePins()).toEqual({ pins: [] })
    const pins = [entity('e1'), note('n1'), image('map.0a1b2c3d.png')]
    expect(ReferencePins.parse({ pins })).toEqual({ pins })
  })

  it('refuses an unknown type, an empty id, and a file name that leaves the folder', () => {
    expect(ReferencePins.safeParse({ pins: [{ type: 'scene', id: 'x' }] }).success).toBe(false)
    expect(ReferencePins.safeParse({ pins: [{ type: 'entity', id: '' }] }).success).toBe(false)
    for (const file of ['', '..', '.', '../a.png', 'a/b.png', 'a\\b.png'])
      expect(ReferencePins.safeParse({ pins: [{ type: 'image', file }] }).success).toBe(false)
  })

  it('refuses more than the maximum', () => {
    const pins = Array.from({ length: REFERENCE_PINS_MAX + 1 }, (_, i) => entity(`e${i}`))
    expect(ReferencePins.safeParse({ pins }).success).toBe(false)
    expect(ReferencePins.safeParse({ pins: pins.slice(1) }).success).toBe(true)
  })
})

describe('pinKey / hasPin', () => {
  it('keys a pin by type and target, so an entity and a note with one id are two pins', () => {
    expect(pinKey(entity('x'))).toBe('entity:x')
    expect(pinKey(note('x'))).toBe('note:x')
    expect(pinKey(image('a.png'))).toBe('image:a.png')
    expect(hasPin([entity('x')], note('x'))).toBe(false)
    expect(hasPin([entity('x')], entity('x'))).toBe(true)
  })
})

describe('addPin / removePin', () => {
  it('appends a new pin and answers the same array for a duplicate', () => {
    const pins = [entity('a')]
    expect(addPin(pins, note('a'))).toEqual([entity('a'), note('a')])
    expect(addPin(pins, entity('a'))).toBe(pins)
  })

  it('refuses a pin over the maximum', () => {
    const full = Array.from({ length: REFERENCE_PINS_MAX }, (_, i) => entity(`e${i}`))
    expect(addPin(full, entity('one-more'))).toBe(full)
  })

  it('removes a pin and answers the same array when it was not pinned', () => {
    const pins = [entity('a'), image('b.png')]
    expect(removePin(pins, image('b.png'))).toEqual([entity('a')])
    expect(removePin(pins, note('a'))).toBe(pins)
  })
})

describe('movePin', () => {
  const pins = [entity('a'), entity('b'), entity('c')]

  it('moves a pin up and down', () => {
    expect(movePin(pins, 1, 0)).toEqual([entity('b'), entity('a'), entity('c')])
    expect(movePin(pins, 0, 2)).toEqual([entity('b'), entity('c'), entity('a')])
  })

  it('clamps the target into the list', () => {
    expect(movePin(pins, 0, 99)).toEqual([entity('b'), entity('c'), entity('a')])
    expect(movePin(pins, 2, -5)).toEqual([entity('c'), entity('a'), entity('b')])
  })

  it('answers the same array for a move that changes nothing or starts outside the list', () => {
    expect(movePin(pins, 1, 1)).toBe(pins)
    expect(movePin(pins, 0, -1)).toBe(pins)
    expect(movePin(pins, 2, 3)).toBe(pins)
    expect(movePin(pins, 3, 0)).toBe(pins)
    expect(movePin(pins, -1, 0)).toBe(pins)
    expect(movePin(pins, 0.5, 1)).toBe(pins)
  })

  it('never mutates the list it was given', () => {
    const before = [...pins]
    movePin(pins, 0, 2)
    expect(pins).toEqual(before)
  })
})

describe('dedupePins', () => {
  it('keeps the first copy of each pin in place', () => {
    expect(dedupePins([entity('a'), note('a'), entity('a'), image('x.png'), note('a')])).toEqual([
      entity('a'),
      note('a'),
      image('x.png')
    ])
  })
})

describe('referenceImageUrl', () => {
  it('serves the file from the references folder on the asset scheme', () => {
    expect(referenceImageUrl('map of ys.0a1b2c3d.png')).toBe(
      'mythscribe-asset://references/map%20of%20ys.0a1b2c3d.png'
    )
  })
})
