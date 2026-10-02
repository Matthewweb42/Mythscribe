import { describe, expect, it } from 'vitest'
import { estimateTokens } from './ai'
import {
  renderStoryBible,
  renderStoryBibleEntities,
  STORY_BIBLE_GHOST_TOKEN_BUDGET,
  STORY_BIBLE_HEADING,
  STORY_BIBLE_TOKEN_BUDGET,
  STORY_BIBLE_VALUE_MAX,
  type StoryBibleEntity,
  type StoryBibleFacts
} from './storyBible'
import { SUMMARY_MAX_CHARS } from './summary'

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
  previous: { title: 'Leaving', location: 'Town', pov: 'Mara', timeline: 'Day 1', summary: null },
  next: { title: 'Night', location: '', pov: '', timeline: '', summary: null }
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
        previous: { title: 'Leaving', location: '', pov: 'Mara', timeline: '', summary: null },
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

  it("renders the neighbours' summaries last, after the category lines (F-5.6)", () => {
    const withSummaries: StoryBibleFacts = {
      ...full,
      previous: { ...full.previous!, summary: 'Mara left town before the thaw.' },
      next: { ...full.next!, summary: 'Tomas walks to the north pasture.' }
    }
    expect(renderStoryBible(withSummaries, STORY_BIBLE_TOKEN_BUDGET)).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'Characters: mara, tomas\n' +
        'Settings: ferry-landing\n' +
        'Plot threads: the-crossing\n' +
        'This scene: "The Ferry", in "Chapter 2", in "Part One", scene 2 of 4; tagged ferry-landing, mara.\n' +
        'Previous scene: "Leaving" (location Town, POV Mara, timeline Day 1).\n' +
        'Next scene: "Night".\n' +
        'Previous scene summary: Mara left town before the thaw.\n' +
        'Next scene summary: Tomas walks to the north pasture.'
    )
  })

  it('takes a summary whole or not at all, and stays inside the budget (F-5.6)', () => {
    const long = 's'.repeat(SUMMARY_MAX_CHARS)
    const withSummaries: StoryBibleFacts = {
      ...full,
      previous: { ...full.previous!, summary: long },
      next: { ...full.next!, summary: long }
    }
    const tight = renderStoryBible(withSummaries, STORY_BIBLE_GHOST_TOKEN_BUDGET)
    expect(estimateTokens(tight ?? '')).toBeLessThanOrEqual(STORY_BIBLE_GHOST_TOKEN_BUDGET)
    expect(tight).not.toContain('scene summary:')
    const roomy = renderStoryBible(withSummaries, STORY_BIBLE_TOKEN_BUDGET)
    expect(estimateTokens(roomy ?? '')).toBeLessThanOrEqual(STORY_BIBLE_TOKEN_BUDGET)
    // The first fits whole; the second has no room left and is dropped rather than cut.
    expect(roomy).toContain(`Previous scene summary: ${long}`)
    expect(roomy).not.toContain('Next scene summary:')
  })

  it('never carries a summary whose scene line was cut for the budget (F-5.6)', () => {
    const tight = estimateTokens(
      `${STORY_BIBLE_HEADING}\nThis scene: "The Ferry", in "Chapter 2", in "Part One", scene 2 of 4; tagged ferry-landing, mara.`
    )
    const built = renderStoryBible(
      { ...full, previous: { ...full.previous!, summary: 'Mara left town before the thaw.' } },
      tight
    )
    expect(built).not.toContain('Previous scene:')
    expect(built).not.toContain('Previous scene summary:')
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

describe('entity sheets and observed facts in the bible (F-5.16)', () => {
  const mara: StoryBibleEntity = {
    name: 'Mara Vell',
    kind: 'character',
    sheet: [
      { label: 'Age', value: '31' },
      { label: 'Appearance', value: 'Tall,\nwith a scar over one eye.' }
    ],
    observed: [
      { label: 'Goals / motivations', value: 'Cross the river' },
      { label: 'Relationships', value: 'Her brother owes the mill' }
    ]
  }
  const landing: StoryBibleEntity = {
    name: 'Ferry landing',
    kind: 'setting',
    sheet: [],
    observed: [{ label: 'Features', value: 'A bell with no clapper' }]
  }
  const MARA_SHEET = 'Mara Vell (character): Age: 31; Appearance: Tall, with a scar over one eye.'
  const MARA_FULL =
    'Mara Vell (character): Age: 31; Appearance: Tall, with a scar over one eye. Seen in the ' +
    'manuscript: Goals / motivations: Cross the river; Relationships: Her brother owes the mill.'
  const LANDING =
    'Ferry landing (setting): Seen in the manuscript: Features: A bell with no clapper.'

  it('renders exactly as before for facts with no entities, absent or empty', () => {
    const before = renderStoryBible(full, STORY_BIBLE_TOKEN_BUDGET)
    expect(renderStoryBible({ ...full, entities: [] }, STORY_BIBLE_TOKEN_BUDGET)).toBe(before)
    expect(before).not.toContain('Seen in the manuscript')
  })

  it('puts one line per entity after the scene line: the sheet, then what the manuscript states', () => {
    expect(renderStoryBible({ ...full, entities: [mara, landing] }, STORY_BIBLE_TOKEN_BUDGET)).toBe(
      `${STORY_BIBLE_HEADING}\n` +
        'Characters: mara, tomas\n' +
        'Settings: ferry-landing\n' +
        'Plot threads: the-crossing\n' +
        'This scene: "The Ferry", in "Chapter 2", in "Part One", scene 2 of 4; tagged ferry-landing, mara.\n' +
        `${MARA_FULL}\n` +
        `${LANDING}\n` +
        'Previous scene: "Leaving" (location Town, POV Mara, timeline Day 1).\n' +
        'Next scene: "Night".'
    )
  })

  it('drops the observed facts before the sheets when the budget is short, last fact first', () => {
    expect(renderStoryBibleEntities([mara, landing], 400)).toEqual([MARA_FULL, LANDING])
    const sheetOnly = estimateTokens(`${MARA_SHEET}\n`)
    expect(renderStoryBibleEntities([mara, landing], sheetOnly)).toEqual([MARA_SHEET])
    // Room for the sheet and one fact: the earlier attribute stays.
    const oneFact =
      'Mara Vell (character): Age: 31; Appearance: Tall, with a scar over one eye. Seen in the ' +
      'manuscript: Goals / motivations: Cross the river.'
    expect(renderStoryBibleEntities([mara], estimateTokens(`${oneFact}\n`))).toEqual([oneFact])
    expect(renderStoryBibleEntities([mara, landing], 5)).toEqual([])
    for (const budget of [20, 40, 60, 100]) {
      const lines = renderStoryBibleEntities([mara, landing], budget)
      expect(estimateTokens(lines.map((line) => `${line}\n`).join(''))).toBeLessThanOrEqual(budget)
    }
  })

  it('admits the sheets ahead of the neighbour summaries and the observed facts after them', () => {
    const summary = 'Mara left town at first light and nobody saw her go.'
    const facts: StoryBibleFacts = {
      ...full,
      previous: { ...full.previous!, summary },
      entities: [mara]
    }
    const whole = renderStoryBible(facts, STORY_BIBLE_TOKEN_BUDGET) ?? ''
    expect(whole).toContain(MARA_FULL)
    expect(whole).toContain(`Previous scene summary: ${summary}`)
    // Just short of everything: the last fact goes; the sheet and the summary stay.
    const tight = renderStoryBible(facts, estimateTokens(whole) - 1) ?? ''
    expect(tight).toContain(
      `${MARA_SHEET} Seen in the manuscript: Goals / motivations: Cross the river.\n`
    )
    expect(tight).not.toContain('Relationships')
    expect(tight).toContain(`Previous scene summary: ${summary}`)
    expect(estimateTokens(tight)).toBeLessThanOrEqual(estimateTokens(whole) - 1)
  })

  it('cuts a long value to one line within the cap', () => {
    const long: StoryBibleEntity = {
      name: 'Tomas',
      kind: 'character',
      sheet: [{ label: 'Background', value: `${'b'.repeat(STORY_BIBLE_VALUE_MAX)} and more` }],
      observed: []
    }
    expect(renderStoryBibleEntities([long], 400)).toEqual([
      `Tomas (character): Background: ${'b'.repeat(STORY_BIBLE_VALUE_MAX)}…`
    ])
  })

  it('renders nothing for an entity with neither a sheet nor a fact', () => {
    expect(
      renderStoryBibleEntities([{ name: 'Ilse', kind: 'character', sheet: [], observed: [] }], 400)
    ).toEqual([])
  })
})
