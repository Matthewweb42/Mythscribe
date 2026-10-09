import { describe, expect, it } from 'vitest'
import { sheetAt, type Fact } from './facts'

/**
 * Verifier (F-9.13): a replace field's current value is "the newest canon value stated at or
 * before the scene". A plan or idea statement must never decide it, including when it restates
 * the words of an older canon value.
 */

const ORDER = ['s1', 's2', 's3', 's4', 's5']

let next = 0
function f(over: Partial<Fact> & Pick<Fact, 'attribute' | 'value'>): Fact {
  next += 1
  return {
    id: `v${next}`,
    entityId: 'mara',
    objectEntityId: null,
    nodeId: 's1',
    quote: 'q',
    origin: 'ai',
    status: 'canon',
    hidden: false,
    createdAt: `2026-10-0${(next % 9) + 1}T00:00:00.000Z`,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over
  }
}

const age = (facts: Fact[], position: string | null): ReturnType<typeof sheetAt>[number] => {
  const view = sheetAt({ facts, fields: {}, attributes: ['age'], order: ORDER, position })
  const found = view.find((row) => row.attribute === 'age')
  if (found === undefined) throw new Error('no age')
  return found
}

describe('sheetAt current value and statuses (verifier)', () => {
  it('does not let an idea scene restating an older value outrank a newer canon value', () => {
    const facts = [
      f({ attribute: 'age', value: '30', nodeId: 's1' }),
      f({ attribute: 'age', value: '31', nodeId: 's3' }),
      // An Idea scene later in the book repeats the old age.
      f({ attribute: 'age', value: '30', nodeId: 's5', status: 'idea' })
    ]
    expect(age(facts, 's5').current?.value).toBe('31')
  })

  it('shows a canon statement as current even when the same words were first stated as an idea', () => {
    const facts = [
      f({ attribute: 'age', value: '40', nodeId: 's1', status: 'idea' }),
      // The author wrote it into a canon scene later.
      f({ attribute: 'age', value: '40', nodeId: 's3' })
    ]
    expect(age(facts, 's4').current?.value).toBe('40')
  })

  it('ignores a later plan value and keeps the canon one current, while the plan shows in history', () => {
    const facts = [
      f({ attribute: 'age', value: '30', nodeId: 's1' }),
      f({ attribute: 'age', value: '35', nodeId: 's3', status: 'plan' })
    ]
    const row = age(facts, 's5')
    expect(row.current?.value).toBe('30')
    expect(row.history.map((each) => [each.value, each.status])).toEqual([
      ['30', 'canon'],
      ['35', 'plan']
    ])
  })

  it('has no current value when only ideas and plans are stated', () => {
    const facts = [
      f({ attribute: 'age', value: '30', nodeId: 's1', status: 'idea' }),
      f({ attribute: 'age', value: '31', nodeId: 's2', status: 'plan' })
    ]
    expect(age(facts, 's5').current).toBeNull()
  })

  it('does not count a canon statement after the position', () => {
    const facts = [
      f({ attribute: 'age', value: '40', nodeId: 's1', status: 'idea' }),
      f({ attribute: 'age', value: '40', nodeId: 's4' })
    ]
    expect(age(facts, 's2').current).toBeNull()
    expect(age(facts, 's4').current?.value).toBe('40')
  })

  it('leaves hidden canon facts out of the current value', () => {
    const facts = [
      f({ attribute: 'age', value: '30', nodeId: 's1' }),
      f({ attribute: 'age', value: '31', nodeId: 's3', hidden: true }),
      f({ attribute: 'age', value: '31', nodeId: 's4', status: 'idea' })
    ]
    expect(age(facts, 's5').current?.value).toBe('30')
  })

  it('keeps the author baseline beside the dated current value', () => {
    const view = sheetAt({
      facts: [
        f({ attribute: 'age', value: '30', nodeId: 's1', origin: 'author' }),
        f({ attribute: 'age', value: '50', nodeId: 's2', status: 'idea' })
      ],
      fields: { age: 'about thirty' },
      attributes: ['age'],
      order: ORDER,
      position: null
    })
    const row = view.find((each) => each.attribute === 'age')
    expect(row?.baseline).toBe('about thirty')
    expect(row?.current?.value).toBe('30')
    expect(row?.current?.origin).toBe('author')
  })

  it('leaves accumulate fields listing plan and idea details as before', () => {
    const view = sheetAt({
      facts: [
        f({ attribute: 'history', value: 'grew up at sea', nodeId: 's1' }),
        f({ attribute: 'history', value: 'may have a sister', nodeId: 's2', status: 'idea' })
      ],
      fields: {},
      attributes: ['history'],
      order: ORDER,
      position: 's3'
    })
    const row = view.find((each) => each.attribute === 'history')
    expect(row?.mode).toBe('accumulate')
    expect(row?.current).toBeNull()
    expect(row?.details.map((each) => [each.value, each.status])).toEqual([
      ['grew up at sea', 'canon'],
      ['may have a sister', 'idea']
    ])
  })
})
