import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../ai'
import {
  STORY_BIBLE_GHOST_TOKEN_BUDGET,
  STORY_BIBLE_TOKEN_BUDGET,
  STORY_BIBLE_VALUE_MAX
} from '../storyBible'
import type { TiptapNodeT } from '../tiptap'
import { NOT_CANON_ATTR } from './pageMarks'
import {
  pinnedCanonLines,
  renderStoryNotes,
  STORY_NOTES_ALIASES_MAX,
  STORY_NOTES_HEADING,
  type StoryNotesFacts,
  type StoryNotesRecord
} from './storyNotes'

const paragraph = (text: string, notCanon = false): TiptapNodeT => ({
  type: 'paragraph',
  ...(notCanon ? { attrs: { [NOT_CANON_ATTR]: true } } : {}),
  content: [{ type: 'text', text }]
})
const page = (...blocks: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content: blocks })

const record = (
  id: string,
  name: string,
  over: Partial<Omit<StoryNotesRecord, 'id' | 'name'>> = {}
): StoryNotesRecord => ({ id, name, aliases: [], pinned: null, ideas: null, ...over })

const mara = record('r-mara', 'Mara Vell', {
  aliases: ['Mara', 'the Captain'],
  pinned: page(paragraph('Eyes: grey'), paragraph('Lost her brother at sea.')),
  ideas: page(paragraph('IDEA: maybe Mara is the drowned bell-ringer'))
})
const orrin = record('r-orrin', 'Orrin Dask', {
  pinned: page(paragraph('A ferryman of Gullhaven'))
})
const tomas = record('r-tomas', 'Tomas Harrow', {
  pinned: page(
    paragraph('Height: tall'),
    // The switch-over's "Filed by AI earlier: please check" block is Not canon (decision 8).
    paragraph('Filed by AI earlier: please check', true),
    paragraph('NOTCANON: Tomas sold the map', true)
  )
})
const rynna = record('r-rynna', 'Rynna Falsire', {
  pinned: page(paragraph('High Crown of the Falsire line'))
})

const facts = (over: Partial<StoryNotesFacts> = {}): StoryNotesFacts => ({
  pov: mara,
  alsoHere: [orrin],
  named: [tomas, rynna],
  labels: [
    { name: 'tense', kind: 'tone' },
    { name: 'violence', kind: 'content' },
    { name: 'grief', kind: 'theme' },
    { name: 'needs research', kind: 'custom' }
  ],
  ...over
})

describe('renderStoryNotes (F-16.14)', () => {
  it('renders Here, Named, the records with Pinned canon text, then the label lines, in that order', () => {
    expect(renderStoryNotes(facts(), STORY_BIBLE_TOKEN_BUDGET)).toBe(
      [
        STORY_NOTES_HEADING,
        'Here: Mara Vell (POV), Orrin Dask',
        'Named: Tomas Harrow, Rynna Falsire',
        'Mara Vell (Mara, the Captain): Eyes: grey. Lost her brother at sea.',
        'Orrin Dask: A ferryman of Gullhaven.',
        'Tomas Harrow: Height: tall.',
        'Rynna Falsire: High Crown of the Falsire line.',
        'Tone (write in it): tense',
        'Content (keep to it): violence',
        'Themes (keep in view): grief'
      ].join('\n')
    )
  })

  it('never carries Ideas, a Not canon paragraph, or a custom label', () => {
    const block = renderStoryNotes(facts(), STORY_BIBLE_TOKEN_BUDGET) ?? ''
    expect(block).not.toContain('IDEA')
    expect(block).not.toContain('NOTCANON')
    expect(block).not.toContain('Filed by AI earlier')
    expect(block).not.toContain('needs research')
  })

  it('never states an absence: no POV line without a POV, no Named line with nobody named', () => {
    const block = renderStoryNotes(
      facts({ pov: null, named: [], alsoHere: [orrin], labels: [] }),
      STORY_BIBLE_TOKEN_BUDGET
    )
    expect(block).toBe(
      [STORY_NOTES_HEADING, 'Here: Orrin Dask', 'Orrin Dask: A ferryman of Gullhaven.'].join('\n')
    )
    expect(block).not.toMatch(/POV|Named|none|nobody/iu)
  })

  it('leaves a Here record out of Named, and says nothing when nothing is here, named or labelled', () => {
    const block = renderStoryNotes(facts({ named: [mara, tomas], labels: [] }), 400) ?? ''
    expect(block.split('\n')[2]).toBe('Named: Tomas Harrow')
    expect(
      renderStoryNotes(
        { pov: null, alsoHere: [], named: [], labels: [{ name: 'x', kind: 'custom' }] },
        400
      )
    ).toBeNull()
    // Labels alone still steer.
    expect(
      renderStoryNotes(
        { pov: null, alsoHere: [], named: [], labels: [{ name: 'quiet', kind: 'tone' }] },
        400
      )
    ).toBe(`${STORY_NOTES_HEADING}\nTone (write in it): quiet`)
  })

  it('lists a record without Pinned text by name only, and cuts long paragraphs and many nicknames', () => {
    const long = 'w'.repeat(STORY_BIBLE_VALUE_MAX + 40)
    const many = record('r-many', 'Callum', {
      aliases: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
      pinned: page(paragraph(long))
    })
    const block = renderStoryNotes(facts({ pov: many, alsoHere: [], named: [orrin] }), 400) ?? ''
    expect(block).toContain(`Callum (A1, A2, A3, A4, A5, …): ${'w'.repeat(STORY_BIBLE_VALUE_MAX)}…`)
    expect(STORY_NOTES_ALIASES_MAX).toBe(5)
    const plain = renderStoryNotes(
      facts({ pov: record('r-x', 'Ash'), alsoHere: [], named: [] }),
      400
    )
    expect(plain?.split('\n')).toEqual([
      STORY_NOTES_HEADING,
      'Here: Ash (POV)',
      'Tone (write in it): tense',
      'Content (keep to it): violence',
      'Themes (keep in view): grief'
    ])
  })

  it('keeps within both budgets, trimming the least named records first and the Here text last', () => {
    const bulky = (id: string, name: string): StoryNotesRecord =>
      record(id, name, {
        pinned: page(
          ...Array.from({ length: 6 }, (_, i) => paragraph(`${name} fact ${i} ${'x'.repeat(80)}`))
        )
      })
    const pov = bulky('r-p', 'Povvy')
    const also = bulky('r-a', 'Also')
    const named = [bulky('r-n1', 'Most'), bulky('r-n2', 'Least')]
    const big = facts({ pov, alsoHere: [also], named })
    for (const budget of [STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_TOKEN_BUDGET]) {
      const block = renderStoryNotes(big, budget) ?? ''
      expect(estimateTokens(block)).toBeLessThanOrEqual(budget)
      const lines = block.split('\n')
      // The heading, Here, Named and label lines are always kept.
      expect(lines).toContain('Here: Povvy (POV), Also')
      expect(lines).toContain('Named: Most, Least')
      expect(lines.slice(-3)).toEqual([
        'Tone (write in it): tense',
        'Content (keep to it): violence',
        'Themes (keep in view): grief'
      ])
    }
    const ghost = renderStoryNotes(big, STORY_BIBLE_GHOST_TOKEN_BUDGET) ?? ''
    const full = renderStoryNotes(big, STORY_BIBLE_TOKEN_BUDGET) ?? ''
    // Under the ghost budget the named records' lines go first; the POV keeps some text.
    expect(ghost).toContain('Povvy: Povvy fact 0')
    expect(ghost).not.toContain('Least: ')
    expect(ghost).not.toContain('Most: ')
    // With more room the POV's whole text comes first, then the also-here record's.
    expect(full).toContain('Povvy fact 5')
    expect(full.indexOf('Povvy: ')).toBeLessThan(full.indexOf('Also: '))
    expect(full).not.toContain('Least: ')
  })

  it('cuts the Here and Named lists to "… and N more" only when they alone would not fit', () => {
    const crowd = Array.from({ length: 60 }, (_, i) => record(`r-${i}`, `Person Number ${i}`))
    const block =
      renderStoryNotes(
        { pov: null, alsoHere: crowd.slice(0, 30), named: crowd.slice(30), labels: [] },
        STORY_BIBLE_GHOST_TOKEN_BUDGET
      ) ?? ''
    expect(estimateTokens(block)).toBeLessThanOrEqual(STORY_BIBLE_GHOST_TOKEN_BUDGET)
    expect(block).toMatch(/^Here: Person Number 0, .* … and \d+ more$/mu)
    // Here took the room first; Named keeps what fits after it, or nothing at all.
    expect(block).not.toContain('Person Number 59')
  })
})

describe('pinnedCanonLines', () => {
  it('reads the canon paragraphs of a page, a Not canon list item included in the exclusion', () => {
    const doc = page(
      paragraph('Eyes: grey'),
      {
        type: 'bulletList',
        attrs: { [NOT_CANON_ATTR]: true },
        content: [{ type: 'listItem', content: [paragraph('A rumour only')] }]
      },
      paragraph('   ')
    )
    expect(pinnedCanonLines({ pinned: doc })).toEqual(['Eyes: grey.'])
    expect(pinnedCanonLines({ pinned: null })).toEqual([])
  })
})
