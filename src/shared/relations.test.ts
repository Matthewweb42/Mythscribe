import { describe, expect, it } from 'vitest'
import {
  RELATION_INVERSE_LABEL,
  RELATION_LABEL,
  RELATION_TYPES,
  parseRelationType,
  relationAttribute,
  relationTypeOf
} from './relations'

describe('relationships (F-9.14, D5)', () => {
  it('round-trips a type through its attribute and refuses anything else', () => {
    for (const type of RELATION_TYPES) expect(relationTypeOf(relationAttribute(type))).toBe(type)
    expect(relationTypeOf('relation:nemesis')).toBeNull()
    expect(relationTypeOf('relationships')).toBeNull()
  })

  it('reads the model’s spellings of a type', () => {
    expect(parseRelationType(' Member of ')).toBe('member-of')
    expect(parseRelationType('LOCATED_IN')).toBe('located-in')
    expect(parseRelationType('nemesis')).toBeNull()
  })

  it('labels both directions, the reverse for the directed types', () => {
    expect(RELATION_LABEL.mentor).toBe('Mentor of')
    expect(RELATION_INVERSE_LABEL.mentor).toBe('Mentored by')
    expect(RELATION_INVERSE_LABEL.friend).toBe(RELATION_LABEL.friend)
  })
})
