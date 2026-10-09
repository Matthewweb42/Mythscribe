import { describe, expect, it } from 'vitest'
import { aiFactKey, authorFactKey, fieldMode, sheetAt, type Fact } from './facts'

const ORDER = ['s1', 's2', 's3', 's4']

let next = 0
function f(over: Partial<Fact> & Pick<Fact, 'attribute' | 'value'>): Fact {
  next += 1
  return {
    id: `f${next}`,
    entityId: 'mara',
    objectEntityId: null,
    nodeId: 's1',
    quote: 'q',
    origin: 'ai',
    status: 'canon',
    hidden: false,
    createdAt: `2026-10-0${next % 9}T00:00:00.000Z`,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over
  }
}

const at = (
  facts: Fact[],
  position: string | null,
  fields: Record<string, string> = {}
): ReturnType<typeof sheetAt> =>
  sheetAt({ facts, fields, attributes: ['age', 'appearance'], order: ORDER, position })

const field = (
  view: ReturnType<typeof sheetAt>,
  attribute: string
): ReturnType<typeof sheetAt>[number] => {
  const found = view.find((row) => row.attribute === attribute)
  if (found === undefined) throw new Error(`no ${attribute}`)
  return found
}

describe('fieldMode (D1)', () => {
  it('replaces the short single-valued fields and accumulates the rest', () => {
    expect(['age', 'role', 'type', 'category'].map(fieldMode)).toEqual([
      'replace',
      'replace',
      'replace',
      'replace'
    ])
    expect(['appearance', 'relationships', 'notes'].map(fieldMode)).toEqual([
      'accumulate',
      'accumulate',
      'accumulate'
    ])
  })
})

describe('fact keys', () => {
  it('keys an AI statement by scene and words, and an author line by attribute and scene', () => {
    expect(aiFactKey('s1', 'age', 'Nineteen.')).toBe(aiFactKey('s1', 'age', ' nineteen'))
    expect(aiFactKey('s1', 'age', '19')).not.toBe(aiFactKey('s2', 'age', '19'))
    expect(authorFactKey('age', null)).not.toBe(authorFactKey('age', 's1'))
  })
})

describe('sheetAt (F-9.13)', () => {
  it('lists every template field with the author baseline, in template order', () => {
    const view = at([], null, { age: '31' })
    expect(view.map((row) => [row.attribute, row.mode, row.baseline])).toEqual([
      ['age', 'replace', '31'],
      ['appearance', 'accumulate', null]
    ])
  })

  it('shows a replace field’s newest canon value at the viewed scene, over the baseline', () => {
    const facts = [
      f({ attribute: 'age', value: '19', nodeId: 's1' }),
      f({ attribute: 'age', value: '20', nodeId: 's3' })
    ]
    expect(field(at(facts, 's1', { age: '18' }), 'age').current?.value).toBe('19')
    expect(field(at(facts, 's2', { age: '18' }), 'age').current?.value).toBe('19')
    expect(field(at(facts, 's3', { age: '18' }), 'age').current?.value).toBe('20')
    expect(field(at(facts, null, { age: '18' }), 'age').baseline).toBe('18')
    // Before any scene states it, only the baseline holds.
    expect(
      field(at([f({ attribute: 'age', value: '20', nodeId: 's3' })], 's2'), 'age').current
    ).toBe(null)
  })

  it('counts a restatement as newer: the value stated last at or before the scene wins', () => {
    const facts = [
      f({ attribute: 'age', value: '34', nodeId: 's1' }),
      f({ attribute: 'age', value: '35', nodeId: 's2' }),
      f({ attribute: 'age', value: '34.', nodeId: 's3' })
    ]
    const age = field(at(facts, 's3'), 'age')
    expect(age.current?.value).toBe('34')
    expect(age.current?.sources.map((source) => source.nodeId)).toEqual(['s1', 's3'])
    expect(field(at(facts, 's2'), 'age').current?.value).toBe('35')
  })

  it('accumulates details stated so far, merging the same words over scenes, and marks later ones in the history', () => {
    const facts = [
      f({ attribute: 'appearance', value: 'Grey eyes', nodeId: 's1' }),
      f({ attribute: 'appearance', value: 'grey eyes.', nodeId: 's2' }),
      f({ attribute: 'appearance', value: 'A scar', nodeId: 's4' })
    ]
    const view = field(at(facts, 's2'), 'appearance')
    expect(view.current).toBe(null)
    expect(view.details.map((detail) => [detail.value, detail.sources.length])).toEqual([
      ['Grey eyes', 2]
    ])
    expect(view.history.map((h) => [h.value, h.later])).toEqual([
      ['Grey eyes', false],
      ['A scar', true]
    ])
    expect(field(at(facts, null), 'appearance').details.map((d) => d.value)).toEqual([
      'Grey eyes',
      'A scar'
    ])
  })

  it('leaves out hidden facts and relationship rows, and appends an attribute only facts carry', () => {
    const facts = [
      f({ attribute: 'age', value: '19', hidden: true }),
      f({ attribute: 'age', value: 'friend', objectEntityId: 'tash' }),
      f({ attribute: 'goals', value: 'Cross the river' })
    ]
    const view = at(facts, null)
    expect(field(view, 'age').history).toEqual([])
    expect(view.map((row) => row.attribute)).toEqual(['age', 'appearance', 'goals'])
    expect(field(view, 'goals').details[0]?.value).toBe('Cross the river')
  })

  it('never shows a plan or idea as the current value, but keeps it in details and history', () => {
    const facts = [
      f({ attribute: 'age', value: '19', nodeId: 's1' }),
      f({ attribute: 'age', value: '40', nodeId: 's2', status: 'idea' }),
      f({ attribute: 'appearance', value: 'Tall', nodeId: 's2', status: 'plan' })
    ]
    const view = at(facts, 's2')
    expect(field(view, 'age').current?.value).toBe('19')
    expect(field(view, 'age').history.map((h) => [h.value, h.status])).toEqual([
      ['19', 'canon'],
      ['40', 'idea']
    ])
    expect(field(view, 'appearance').details[0]).toMatchObject({ value: 'Tall', status: 'plan' })
  })

  it('treats an author line dated at a scene like a statement of that scene, and an orphaned one as history only', () => {
    const facts = [
      f({ attribute: 'age', value: '19', nodeId: 's1' }),
      f({ attribute: 'age', value: '21', nodeId: 's3', origin: 'author', quote: null }),
      f({ attribute: 'age', value: '50', nodeId: null, origin: 'author', quote: null })
    ]
    const age = field(at(facts, 's4'), 'age')
    expect(age.current).toMatchObject({ value: '21', origin: 'author' })
    expect(age.history.map((h) => h.value)).toEqual(['50', '19', '21'])
  })

  it('reads a position outside the order as the end of the book', () => {
    const facts = [f({ attribute: 'age', value: '20', nodeId: 's4' })]
    expect(field(at(facts, 'front-matter'), 'age').current?.value).toBe('20')
  })
})
