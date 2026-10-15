import { describe, expect, it } from 'vitest'
import {
  ALL_SLOTS,
  BASE_SLOTS,
  DETAIL_LABEL_NAMES,
  NOT_READ_SLOTS,
  READER_V6_NOT_READ_SLOTS,
  SlotSchema,
  parseSlot,
  readSlot,
  slotFitsKind,
  slotGroup,
  slotIsRead,
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

  it('groups knows and thread on their own, and names every slot for display', () => {
    expect(slotGroup('knows')).toBe('knows')
    expect(slotGroup('thread')).toBe('thread')
    expect(slotLabel('location')).toBe('Last seen at')
    expect(slotLabel('detail:income')).toBe('Income')
    for (const slot of ALL_SLOTS) expect(slotLabel(slot)).not.toBe('')
  })

  it('reads the concrete slots, traits and history, keeping the rest on the closed list (plans ReaderNarrow.md, Suggestions.md)', () => {
    const notRead = ALL_SLOTS.filter((slot) => !slotIsRead(slot))
    expect(notRead).toEqual(['role', 'clothing', 'objects', 'relation'])
    expect(slotIsRead('traits') && slotIsRead('history')).toBe(true)
    expect([...READER_V6_NOT_READ_SLOTS].sort()).toEqual(
      ['clothing', 'history', 'objects', 'relation', 'role', 'traits'].sort()
    )
    expect([...NOT_READ_SLOTS].every((slot) => parseSlot(slot) === slot)).toBe(true)
    for (const slot of ['eyes', 'born', 'species', 'kinship', 'hair', 'alive', 'age'] as const) {
      expect(slotIsRead(slot), slot).toBe(true)
    }
    expect(slotIsRead('scars') && slotIsRead('injuries') && slotIsRead('location')).toBe(true)
    expect(DETAIL_LABEL_NAMES.every((label) => slotIsRead(`detail:${label}`))).toBe(true)
  })
})

describe('reading a slot leniently, and the slots a place holds (live run 2026-10-14)', () => {
  it('reads a bare detail label and a base slot behind the prefix, and nothing invented', () => {
    expect(readSlot('eyes')).toBe('eyes')
    expect(readSlot('occupation')).toBe('detail:occupation')
    expect(readSlot('birthplace')).toBe('detail:birthplace')
    expect(readSlot('detail:location')).toBe('location')
    for (const invented of ['action', 'dialogue', 'emotion', 'question', 'detail:smell', 'mood']) {
      expect(readSlot(invented), invented).toBeNull()
    }
  })

  it('reads a slot in its other number, and never one whose meaning differs (second live run)', () => {
    expect(readSlot('trait')).toBe('traits')
    expect(readSlot('roles')).toBe('role')
    expect(readSlot('detail:scar')).toBe('scars')
    expect(readSlot('detail:trait')).toBe('traits')
    expect(readSlot('Injury')).toBe('injuries')
    expect(readSlot('eye')).toBe('eyes')
    expect(readSlot('object')).toBe('objects')
    expect(readSlot('occupations')).toBe('detail:occupation')
    expect(readSlot('detail:titles')).toBe('detail:title')
    for (const other of [
      'voice',
      'dialogue',
      'memory',
      'secret',
      'trait-like',
      'detail:action',
      'detail:belief',
      'detail:breathing',
      'detail:event',
      'detail:return',
      'detail:speech',
      'detail:voice',
      'event',
      'speech'
    ]) {
      expect(readSlot(other), other).toBeNull()
    }
  })

  it('gives a place no person’s slot, and a secret or thread no fact', () => {
    expect(slotFitsKind('detail:home', 'place')).toBe(false)
    expect(slotFitsKind('eyes', 'place')).toBe(false)
    expect(slotFitsKind('history', 'place')).toBe(true)
    // Third live run of 2026-10-14: "never settled at Thornmere" was Thornmere's location.
    expect(slotFitsKind('location', 'place')).toBe(false)
    expect(slotFitsKind('role', 'place')).toBe(true)
    expect(slotFitsKind('detail:home', 'character')).toBe(true)
    expect(slotFitsKind('location', 'character')).toBe(true)
    expect(slotFitsKind('location', 'group')).toBe(true)
    // A thing keeps a creature's body slots, never a person's place, kin, clothes or role.
    expect(slotFitsKind('eyes', 'thing')).toBe(true)
    for (const slot of ['location', 'role', 'kinship', 'clothing', 'objects'] as const) {
      expect(slotFitsKind(slot, 'thing'), slot).toBe(false)
    }
    expect(slotFitsKind('traits', 'secret')).toBe(false)
    expect(slotFitsKind('traits', undefined)).toBe(true)
  })
})
