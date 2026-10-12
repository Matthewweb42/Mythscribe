import { describe, expect, it } from 'vitest'
import { recordKindOf } from './records'
import {
  NAMED_KINDS,
  SECRET_CATEGORY_ID,
  TOPIC_CAPS,
  isNamedKind,
  isTopicCategory,
  isTopicKind,
  parseStep,
  sameAsCandidates,
  stepRank,
  threadNotRightSlot,
  topicLabel,
  topicLinesTokens,
  topicRosterLine,
  topicTerms,
  uniqueTopicLabel,
  type TopicFacet,
  type TopicName
} from './topics'

describe('topic kinds and categories (P2b-D1, D2)', () => {
  it('makes secrets and threads topics of fixed categories, and not names', () => {
    expect(recordKindOf(SECRET_CATEGORY_ID)).toBe('secret')
    expect(recordKindOf('thread')).toBe('thread')
    expect(isTopicKind('secret')).toBe(true)
    expect(isTopicKind('thread')).toBe(true)
    expect(isTopicKind('character')).toBe(false)
    expect(isTopicCategory('secret')).toBe(true)
    expect(isTopicCategory('thread')).toBe(true)
    expect(isTopicCategory('character')).toBe(false)
    expect(NAMED_KINDS).toEqual(['character', 'place', 'thing', 'group', 'term'])
    expect(isNamedKind('secret')).toBe(false)
    expect(isNamedKind('thread')).toBe(false)
    expect(isNamedKind('group')).toBe(true)
  })

  it('caps new topics per page at 3 secrets and 2 threads (P2b-D11)', () => {
    expect(TOPIC_CAPS).toEqual({ secret: 3, thread: 2 })
  })

  it('reads steps leniently and ranks a resolve after an advance', () => {
    expect(parseStep('opens')).toBe('opens')
    expect(parseStep('Advanced')).toBe('advances')
    expect(parseStep('resolve')).toBe('resolves')
    expect(parseStep('closes')).toBeNull()
    expect(stepRank('resolves')).toBeGreaterThan(stepRank('advances'))
    expect(stepRank('opens')).toBe(stepRank('advances'))
    expect(threadNotRightSlot('t1')).toBe('thread:t1')
  })
})

describe('topicLabel', () => {
  it('trims, collapses and cuts to 8 words, keeping a leading "the"', () => {
    expect(topicLabel('  the   sold map. ')).toBe('the sold map')
    expect(topicLabel('"Ashby\'s return"')).toBe("Ashby's return")
    expect(topicLabel('the one two three four five six seven eight nine')).toBe(
      'the one two three four five six seven'
    )
    expect(topicLabel('the one two three four five, six', 4)).toBe('the one two three')
  })

  it('writes a roster line and counts its tokens', () => {
    expect(topicRosterLine('s3', 'the sold map', 'secret')).toBe('s3 the sold map · secret')
    expect(topicLinesTokens([])).toBe(0)
    expect(topicLinesTokens(['s3 the sold map · secret'])).toBeGreaterThan(0)
  })

  it('makes a label unique among the records’ names (P2b-D1)', () => {
    const taken = new Set(['ashby', "ashby's return"])
    const free = (norm: string): boolean => taken.has(norm)
    expect(uniqueTopicLabel('the sold map', 'secret', '1.1', free)).toBe('the sold map')
    expect(uniqueTopicLabel('Ashby', 'thread', '13.1', free)).toBe('Ashby (thread)')
    taken.add('ashby (thread)')
    expect(uniqueTopicLabel('Ashby', 'thread', '13.1', free)).toBe('Ashby (thread, 13.1)')
    taken.add('ashby (thread, 131)')
    expect(uniqueTopicLabel('Ashby', 'thread', '13.1', free)).toBe('Ashby (thread 2)')
  })
})

describe('topicTerms (P2b-D4)', () => {
  const names: TopicName[] = [
    { recordId: 'ashby', text: 'Mr. Ashby' },
    { recordId: 'ashby', text: 'Ashby' },
    { recordId: 'ashby', text: 'Ned' },
    { recordId: 'tomas', text: 'Tomas' }
  ]

  it('folds each roster name to its record and keeps the content words', () => {
    expect(
      topicTerms("Ashby's return", 'he said that he was coming back to Thornmere', names)
    ).toEqual(['@ashby', 'return', 'said', 'coming', 'back', 'thornmere'])
    expect(topicTerms('the sold map', 'Tomas sold the map.', names)).toEqual([
      '@tomas',
      'sold',
      'map'
    ])
  })

  it('matches a renamed character by record, whatever name the quote uses', () => {
    const one = topicTerms("Ned's homecoming", '', names)
    const two = topicTerms('Mr. Ashby comes home', '', names)
    expect(one).toContain('@ashby')
    expect(two).toContain('@ashby')
    expect(one).not.toContain('ned')
  })

  it('matches a capitalised name only as written', () => {
    expect(topicTerms('the tomas question', '', names)).not.toContain('@tomas')
  })
})

describe('sameAsCandidates (P2b-D4)', () => {
  const secret = (id: string, terms: string[], holders: string[] = []): TopicFacet => ({
    id,
    kind: 'secret',
    terms,
    holders
  })

  it('offers same-kind topics sharing a word or a holder, highest overlap first, at most 3', () => {
    const fresh = secret('x1', ['map', 'sale', '@tomas'], ['orrin'])
    const open = [
      secret('s1', ['sold', 'map'], []),
      secret('s2', ['debts', 'captain'], ['orrin']),
      secret('s3', ['map', '@tomas'], []),
      secret('s4', ['heir'], []),
      secret('s5', ['map', 'sale', '@tomas'], ['orrin'])
    ]
    expect(sameAsCandidates(fresh, open).map((topic) => topic.id)).toEqual(['s5', 's3', 's1'])
    expect(sameAsCandidates(fresh, open, { max: 5 }).map((topic) => topic.id)).toEqual([
      's5',
      's3',
      's1',
      's2'
    ])
  })

  it('never offers another kind, itself, or a topic sharing nothing', () => {
    const fresh = secret('x1', ['map'])
    const thread: TopicFacet = { id: 't1', kind: 'thread', terms: ['map'], holders: [] }
    expect(
      sameAsCandidates(fresh, [thread, secret('x1', ['map']), secret('s9', ['heir'])])
    ).toEqual([])
  })

  it('compares threads by words and named records only, not holders', () => {
    const fresh: TopicFacet = {
      id: 'x2',
      kind: 'thread',
      terms: ['@ashby', 'return'],
      holders: ['a']
    }
    const open: TopicFacet[] = [
      { id: 't1', kind: 'thread', terms: ['heir'], holders: ['a'] },
      { id: 't2', kind: 'thread', terms: ['@ashby', 'letter'], holders: [] }
    ]
    expect(sameAsCandidates(fresh, open).map((topic) => topic.id)).toEqual(['t2'])
  })
})
