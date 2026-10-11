import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STORY_MEMORY,
  StoryMemoryState,
  defaultStoryMemoryState,
  effectiveStoryMemory,
  parseStoryMemoryOverride
} from './storyMemory'

describe('the story-memory switch (F-16.2)', () => {
  it('defaults every project to v1, never switched', () => {
    expect(DEFAULT_STORY_MEMORY).toBe('v1')
    expect(StoryMemoryState.parse({})).toEqual(defaultStoryMemoryState())
    expect(defaultStoryMemoryState()).toEqual({ version: 'v1', switchedAt: null })
  })

  it('keeps a stored v2 with its date', () => {
    expect(
      StoryMemoryState.parse({ version: 'v2', switchedAt: '2026-10-11T09:00:00.000Z' })
    ).toEqual({ version: 'v2', switchedAt: '2026-10-11T09:00:00.000Z' })
  })

  it('reads a broken row as v1, never as v2', () => {
    expect(StoryMemoryState.parse({ version: 'v3', switchedAt: 12 })).toEqual({
      version: 'v1',
      switchedAt: null
    })
    expect(StoryMemoryState.parse({ version: null })).toEqual(defaultStoryMemoryState())
    expect(StoryMemoryState.safeParse('v2').success).toBe(false)
  })

  it('accepts exactly v1 or v2 as the override', () => {
    expect(parseStoryMemoryOverride('v1')).toBe('v1')
    expect(parseStoryMemoryOverride('v2')).toBe('v2')
    for (const raw of [undefined, '', 'V2', ' v2', 'v2 ', 'true', '2']) {
      expect(parseStoryMemoryOverride(raw)).toBeNull()
    }
  })

  it('lets the override win over the stored version, and the stored one stand without it', () => {
    expect(effectiveStoryMemory({ version: 'v1' }, 'v2')).toBe('v2')
    expect(effectiveStoryMemory({ version: 'v2' }, 'v1')).toBe('v1')
    expect(effectiveStoryMemory({ version: 'v2' }, null)).toBe('v2')
    expect(effectiveStoryMemory({ version: 'v1' }, null)).toBe('v1')
  })
})
