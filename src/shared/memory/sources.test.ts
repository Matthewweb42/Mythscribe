import { describe, expect, it } from 'vitest'
import { MEMORY_SOURCES, meaningOf, readerMayRead, type MemorySource } from './sources'

describe('meaning by place (F-16.3, design §2.2)', () => {
  it('reads a scene up to the open one as happened and a later one as later in the book', () => {
    expect(meaningOf('scene', { order: 3, openOrder: 5 })).toBe('happened')
    expect(meaningOf('scene', { order: 5, openOrder: 5 })).toBe('happened')
    expect(meaningOf('scene', { order: 6, openOrder: 5 })).toBe('later')
  })

  it('gives every other source one meaning wherever the author is', () => {
    const expected: Record<Exclude<MemorySource, 'scene'>, string> = {
      pinned: 'canon',
      note: 'canon',
      research: 'canon',
      synopsis: 'plan',
      brief: 'plan',
      sceneNote: 'plan',
      plannedCard: 'plan',
      idea: 'never',
      try: 'never',
      chat: 'never',
      inactiveDraft: 'never',
      ideaScene: 'never',
      excludedScene: 'never',
      notCanon: 'never',
      card: 'map'
    }
    for (const source of MEMORY_SOURCES) {
      if (source === 'scene') continue
      expect(meaningOf(source, { order: 1, openOrder: 9 })).toBe(expected[source])
      expect(meaningOf(source, { order: 9, openOrder: 1 })).toBe(expected[source])
    }
  })

  it('lets the reader read manuscript scenes only', () => {
    expect(MEMORY_SOURCES.filter(readerMayRead)).toEqual(['scene'])
  })
})
