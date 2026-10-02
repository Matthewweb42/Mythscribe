import { describe, expect, it } from 'vitest'
import { ENTITY_KINDS, isFieldOf } from './entities'
import {
  ExtractedFact,
  OBSERVED_ATTRIBUTES,
  OBSERVED_FACT_VALUE_MAX,
  ObservedDismissed,
  defaultObservedDismissed,
  factKey,
  groupFacts,
  isObservedAttribute,
  isObservedDismissed,
  observedAttributeField,
  observedAttributeLabel,
  withObservedDismissed,
  withoutObservedDismissed,
  type ObservedFact
} from './observedFacts'

let seq = 0
function fact(patch: Partial<ObservedFact>): ObservedFact {
  seq += 1
  return {
    id: `f-${seq}`,
    entityId: 'mara',
    nodeId: 'sc-1',
    attribute: 'appearance',
    value: 'Grey eyes',
    quote: 'her grey eyes',
    hidden: false,
    createdAt: '2026-10-02T10:00:00.000Z',
    ...patch
  }
}

describe('OBSERVED_ATTRIBUTES', () => {
  it('maps every attribute onto a field of the same kind', () => {
    for (const kind of ENTITY_KINDS) {
      expect(OBSERVED_ATTRIBUTES[kind].length).toBeGreaterThan(0)
      for (const attribute of OBSERVED_ATTRIBUTES[kind]) {
        expect(isFieldOf(kind, attribute)).toBe(true)
        expect(observedAttributeField(kind, attribute)).toBe(attribute)
      }
    }
  })

  it('leaves the author-only fields out and refuses another kind’s attribute', () => {
    expect(isObservedAttribute('character', 'age')).toBe(true)
    expect(isObservedAttribute('character', 'notes')).toBe(false)
    expect(isObservedAttribute('setting', 'associatedCharacters')).toBe(false)
    expect(isObservedAttribute('setting', 'age')).toBe(false)
    expect(isObservedAttribute('world', 'rules')).toBe(true)
    expect(observedAttributeField('setting', 'age')).toBeNull()
  })

  it('labels an attribute as the sheet does, and falls back to the raw id', () => {
    expect(observedAttributeLabel('character', 'goals')).toBe('Goals / motivations')
    expect(observedAttributeLabel('world', 'impact')).toBe('Impact on story')
    expect(observedAttributeLabel('setting', 'height')).toBe('height')
  })
})

describe('ExtractedFact', () => {
  const base = {
    entity: ' Mara ',
    kind: 'character',
    attribute: 'age',
    value: ' nineteen ',
    quote: 'She was nineteen that spring.'
  }

  it('trims every part', () => {
    expect(ExtractedFact.parse(base)).toEqual({
      entity: 'Mara',
      kind: 'character',
      attribute: 'age',
      value: 'nineteen',
      quote: 'She was nineteen that spring.'
    })
  })

  it('refuses a blank part, an unknown kind, and a value over the cap', () => {
    expect(ExtractedFact.safeParse({ ...base, value: '  ' }).success).toBe(false)
    expect(ExtractedFact.safeParse({ ...base, quote: '' }).success).toBe(false)
    expect(ExtractedFact.safeParse({ ...base, kind: 'faction' }).success).toBe(false)
    expect(
      ExtractedFact.safeParse({ ...base, value: 'x'.repeat(OBSERVED_FACT_VALUE_MAX + 1) }).success
    ).toBe(false)
  })
})

describe('factKey', () => {
  it('ignores case, spacing, and closing punctuation', () => {
    expect(factKey('appearance', 'Grey eyes.')).toBe(factKey(' Appearance ', '  grey   eyes '))
    expect(factKey('age', 'Nineteen!')).toBe(factKey('age', 'nineteen'))
  })

  it('keeps different values and different attributes apart', () => {
    expect(factKey('appearance', 'grey eyes')).not.toBe(factKey('appearance', 'green eyes'))
    expect(factKey('appearance', 'tall')).not.toBe(factKey('personality', 'tall'))
  })
})

describe('groupFacts', () => {
  const order = ['sc-1', 'sc-2', 'sc-3']

  it('answers nothing for no facts', () => {
    expect(groupFacts([], order)).toEqual([])
  })

  it('merges equal values into one row with a passage per scene, in reading order', () => {
    const late = fact({ nodeId: 'sc-3', value: 'grey eyes.', quote: 'eyes grey as slate' })
    const early = fact({ nodeId: 'sc-1' })
    const [row, ...rest] = groupFacts([late, early], order)
    expect(rest).toEqual([])
    expect(row).toEqual({
      entityId: 'mara',
      attribute: 'appearance',
      value: 'Grey eyes',
      factIds: [early.id, late.id],
      sources: [
        { factId: early.id, nodeId: 'sc-1', quote: 'her grey eyes' },
        { factId: late.id, nodeId: 'sc-3', quote: 'eyes grey as slate' }
      ],
      differs: false
    })
  })

  it('keeps one passage per scene but every fact id', () => {
    const a = fact({})
    const b = fact({ value: 'grey eyes', quote: 'those grey eyes' })
    const [row] = groupFacts([a, b], order)
    expect(row?.factIds).toEqual([a.id, b.id])
    expect(row?.sources).toEqual([{ factId: a.id, nodeId: 'sc-1', quote: 'her grey eyes' }])
  })

  it('marks every value of an attribute that has more than one, in reading order', () => {
    const green = fact({ nodeId: 'sc-2', value: 'Green eyes', quote: 'green eyes' })
    const grey = fact({ nodeId: 'sc-1' })
    const age = fact({ attribute: 'age', value: '19', quote: 'nineteen' })
    const rows = groupFacts([green, grey, age], order)
    expect(rows.map((row) => [row.attribute, row.value, row.differs])).toEqual([
      ['age', '19', false],
      ['appearance', 'Grey eyes', true],
      ['appearance', 'Green eyes', true]
    ])
  })

  it('does not let another entity’s value make a row differ', () => {
    const rows = groupFacts(
      [fact({}), fact({ entityId: 'tash', value: 'Green eyes', quote: 'green' })],
      order
    )
    expect(rows.map((row) => [row.entityId, row.differs])).toEqual([
      ['mara', false],
      ['tash', false]
    ])
  })

  it('leaves hidden facts out, so a hidden value no longer differs', () => {
    const rows = groupFacts(
      [fact({}), fact({ nodeId: 'sc-2', value: 'Green eyes', hidden: true })],
      order
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ value: 'Grey eyes', differs: false })
  })

  it('sorts a scene outside the reading order last and an unknown attribute after the known', () => {
    const gone = fact({ nodeId: 'elsewhere', value: 'Blue eyes', quote: 'blue' })
    const known = fact({ nodeId: 'sc-3', value: 'Brown eyes', quote: 'brown' })
    const odd = fact({ attribute: 'height', value: 'Tall', quote: 'tall' })
    const rows = groupFacts([gone, odd, known], order)
    expect(rows.map((row) => row.value)).toEqual(['Brown eyes', 'Blue eyes', 'Tall'])
  })
})

describe('observed dismissals', () => {
  it('defaults to an empty list, also for a row without names', () => {
    expect(defaultObservedDismissed()).toEqual({ names: [] })
    expect(ObservedDismissed.parse({})).toEqual({ names: [] })
  })

  it('adds a kind and name once, compared by name key, and takes it out again', () => {
    const one = withObservedDismissed(defaultObservedDismissed(), 'character', '  Ada   Lovelace ')
    expect(one).toEqual({ names: [{ kind: 'character', nameKey: 'ada lovelace' }] })
    expect(withObservedDismissed(one, 'character', 'ada lovelace')).toBe(one)
    expect(isObservedDismissed(one, 'character', 'ADA LOVELACE')).toBe(true)
    expect(isObservedDismissed(one, 'setting', 'Ada Lovelace')).toBe(false)
    expect(withoutObservedDismissed(one, 'setting', 'Ada Lovelace')).toBe(one)
    expect(withoutObservedDismissed(one, 'character', 'Ada Lovelace')).toEqual({ names: [] })
  })
})
