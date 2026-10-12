import { describe, expect, it } from 'vitest'
import {
  ALL_SLOTS,
  BASE_SLOTS,
  DETAIL_LABEL_NAMES,
  SlotSchema,
  parseSlot,
  readerAccepts,
  slotGroup,
  slotLabel
} from './slots'

describe('the closed slot list (F-16.17, design §2.2)', () => {
  it('parses every base slot and every detail label, and nothing else', () => {
    for (const slot of BASE_SLOTS) expect(parseSlot(slot)).toBe(slot)
    expect(parseSlot('detail:income')).toBe('detail:income')
    expect(parseSlot('detail:favouriteColour')).toBeNull()
    expect(parseSlot('mood')).toBeNull()
    expect(parseSlot('relation:mara')).toBeNull()
    expect(SlotSchema.safeParse('eyes').success).toBe(true)
    expect(SlotSchema.safeParse('detail:nope').success).toBe(false)
    expect(SlotSchema.safeParse(3).success).toBe(false)
  })

  it('has about twenty detail labels, fixed or lasting only', () => {
    expect(DETAIL_LABEL_NAMES.length).toBeGreaterThanOrEqual(18)
    expect(DETAIL_LABEL_NAMES.length).toBeLessThanOrEqual(22)
    for (const label of DETAIL_LABEL_NAMES) {
      expect(['fixed', 'lasting']).toContain(slotGroup(`detail:${label}`))
    }
    expect(ALL_SLOTS).toHaveLength(BASE_SLOTS.length + DETAIL_LABEL_NAMES.length)
  })

  it('groups the slots as the design does', () => {
    expect(
      ['eyes', 'born', 'species', 'kinship'].map((s) => slotGroup(parseSlot(s) ?? 'eyes'))
    ).toEqual(['fixed', 'fixed', 'fixed', 'fixed'])
    expect(slotGroup('hair')).toBe('lasting')
    expect(slotGroup('alive')).toBe('lasting')
    expect(slotGroup('age')).toBe('lasting')
    expect(slotGroup('location')).toBe('transient')
    expect(slotGroup('objects')).toBe('transient')
    expect(slotGroup('traits')).toBe('accumulating')
    expect(slotGroup('relation')).toBe('accumulating')
    expect(slotGroup('detail:height')).toBe('fixed')
    expect(slotGroup('detail:income')).toBe('lasting')
  })

  it('refuses knows and thread to the P2a reader, and names every slot for display', () => {
    expect(readerAccepts('knows')).toBe(false)
    expect(readerAccepts('thread')).toBe(false)
    expect(readerAccepts('eyes')).toBe(true)
    expect(slotLabel('location')).toBe('Last seen at')
    expect(slotLabel('detail:income')).toBe('Income')
    for (const slot of ALL_SLOTS) expect(slotLabel(slot)).not.toBe('')
  })
})
