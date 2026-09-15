import { describe, expect, it } from 'vitest'
import { estimateTokens } from './ai'
import {
  renderStoryBible,
  STORY_BIBLE_GHOST_TOKEN_BUDGET,
  STORY_BIBLE_HEADING,
  STORY_BIBLE_TOKEN_BUDGET,
  type StoryBibleFacts
} from './storyBible'

const bank: StoryBibleFacts['bank'] = [
  { category: 'character', name: 'mara' },
  { category: 'setting', name: 'ferry-landing' },
  { category: 'character', name: 'tomas' },
  { category: 'plotThread', name: 'the-crossing' }
]

const full: StoryBibleFacts = {
  bank,
  scene: {
    title: 'The Ferry',
    ancestors: ['Chapter 2', 'Part One'],
    index: 2,
    count: 4,
    tags: ['ferry-landing', 'mara']
  },
  previous: { title: 'Leaving', location: 'Town', pov: 'Mara', timeline: 'Day 1' },
  next: { title: 'Night', location: '', pov: '', timeline: '' }
}

describe('renderStoryBible (F-14.9)', () => {
  it('renders the heading, the categories in bank order within each, the scene, and both neighbours', () => {
    expect(renderStoryBible(full, STORY_BIBLE_TOKEN_BUDGET)).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'Characters: mara, tomas\n' +
        'Settings: ferry-landing\n' +
        'Plot threads: the-crossing\n' +
        'This scene: "The Ferry", in "Chapter 2", in "Part One", scene 2 of 4; tagged ferry-landing, mara.\n' +
        'Previous scene: "Leaving" (location Town, POV Mara, timeline Day 1).\n' +
        'Next scene: "Night".'
    )
  })

  it('is null when there is nothing informative, and not when the scene alone carries a tag', () => {
    expect(renderStoryBible({ bank: [], scene: null, previous: null, next: null }, 400)).toBeNull()
    const lone = { title: 'Only', ancestors: ['Chapter 1'], index: 1, count: 1, tags: [] }
    expect(renderStoryBible({ bank: [], scene: lone, previous: null, next: null }, 400)).toBeNull()
    expect(
      renderStoryBible(
        { bank: [], scene: { ...lone, tags: ['mara'] }, previous: null, next: null },
        400
      )
    ).toBe(`${STORY_BIBLE_HEADING}\nThis scene: "Only", in "Chapter 1", scene 1 of 1; tagged mara.`)
  })

  it('renders the bank alone outside the manuscript, and omits empty neighbour fields', () => {
    expect(renderStoryBible({ bank, scene: null, previous: null, next: null }, 400)).toBe(
      `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\nSettings: ferry-landing\nPlot threads: the-crossing`
    )
    const built = renderStoryBible(
      {
        ...full,
        previous: { title: 'Leaving', location: '', pov: 'Mara', timeline: '' },
        next: null
      },
      400
    )
    expect(built).toContain('Previous scene: "Leaving" (POV Mara).')
    expect(built).not.toContain('Next scene')
  })

  it('keeps the heading and the scene line first, then the neighbours, then cuts the bank to fit', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      category: 'character' as const,
      name: `character-number-${i}`
    }))
    const built = renderStoryBible({ ...full, bank: many }, STORY_BIBLE_GHOST_TOKEN_BUDGET)
    expect(built).not.toBeNull()
    expect(estimateTokens(built ?? '')).toBeLessThanOrEqual(STORY_BIBLE_GHOST_TOKEN_BUDGET)
    expect(built).toContain('This scene: "The Ferry"')
    expect(built).toContain('Previous scene:')
    expect(built).toContain('Next scene:')
    expect(built).toMatch(/Characters: character-number-0, .* … and \d+ more\n/)
  })

  it('drops a category that cannot keep even one name, never the scene line', () => {
    const tight = estimateTokens(
      `${STORY_BIBLE_HEADING}\nThis scene: "The Ferry", in "Chapter 2", in "Part One", scene 2 of 4; tagged ferry-landing, mara.`
    )
    const built = renderStoryBible(full, tight)
    expect(built).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'This scene: "The Ferry", in "Chapter 2", in "Part One", scene 2 of 4; tagged ferry-landing, mara.'
    )
  })
})
