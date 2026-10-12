import { describe, expect, it } from 'vitest'
import {
  emptySceneDetails,
  parseStoryYear,
  SceneDetails,
  STORY_YEAR_MAX,
  STORY_YEAR_MIN
} from './sceneDetails'

/** F-16.11: a scene's typed details, and the story year as the author types it (decision 5). */
describe('parseStoryYear (F-16.11)', () => {
  it('reads a whole year, negatives included, and nothing typed as no year', () => {
    expect(parseStoryYear('1814')).toBe(1814)
    expect(parseStoryYear('  1814 ')).toBe(1814)
    expect(parseStoryYear('-40')).toBe(-40)
    expect(parseStoryYear('0')).toBe(0)
    expect(parseStoryYear('')).toBeNull()
    expect(parseStoryYear('   ')).toBeNull()
    expect(parseStoryYear(String(STORY_YEAR_MIN))).toBe(STORY_YEAR_MIN)
    expect(parseStoryYear(String(STORY_YEAR_MAX))).toBe(STORY_YEAR_MAX)
  })

  it('refuses words, fractions, signs other than minus, exponents and years out of range', () => {
    for (const text of ['spring', '1814.5', '+1814', '1e3', '18 14', '--40', '1814 AD']) {
      expect(parseStoryYear(text)).toBeUndefined()
    }
    expect(parseStoryYear(String(STORY_YEAR_MAX + 1))).toBeUndefined()
    expect(parseStoryYear(String(STORY_YEAR_MIN - 1))).toBeUndefined()
  })
})

describe('SceneDetails (F-16.11)', () => {
  it('starts empty and holds a parsed year only within range', () => {
    expect(SceneDetails.parse(emptySceneDetails())).toEqual(emptySceneDetails())
    expect(
      SceneDetails.safeParse({ ...emptySceneDetails(), storyYear: STORY_YEAR_MAX + 1 }).success
    ).toBe(false)
  })
})
