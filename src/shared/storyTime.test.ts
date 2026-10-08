import { describe, expect, it } from 'vitest'
import { estimateTokens } from './ai'
import {
  STORY_MAP_HEADING,
  STORY_MAP_LATEST_NOTE,
  STORY_MAP_NOTHING_WRITTEN,
  folderProgress,
  mapSummary,
  positionIn,
  renderStoryMap,
  resolveNow,
  sceneProgress,
  type StoryMapItem
} from './storyTime'

const folder = (id: string, title: string, depth = 0): StoryMapItem => ({
  id,
  ref: '',
  title,
  depth,
  kind: 'folder',
  progress: null,
  summary: null
})
const scene = (
  id: string,
  title: string,
  progress: StoryMapItem['progress'],
  summary: string | null = null,
  depth = 1
): StoryMapItem => ({ id, ref: '', title, depth, kind: 'document', progress, summary })

describe('sceneProgress (F-11.1d)', () => {
  it('is Planned with no words whatever the status, Revised for revised or final, Drafted otherwise', () => {
    expect(sceneProgress(0, 'final')).toBe('planned')
    expect(sceneProgress(0, 'none')).toBe('planned')
    expect(sceneProgress(12, 'none')).toBe('drafted')
    expect(sceneProgress(12, 'idea')).toBe('drafted')
    expect(sceneProgress(12, 'draft')).toBe('drafted')
    expect(sceneProgress(12, 'revised')).toBe('revised')
    expect(sceneProgress(12, 'final')).toBe('revised')
  })

  it('rolls a folder up: none, all planned, all revised, or a mix', () => {
    expect(folderProgress([])).toBeNull()
    expect(folderProgress(['planned', 'planned'])).toBe('planned')
    expect(folderProgress(['revised', 'revised'])).toBe('revised')
    expect(folderProgress(['planned', 'revised'])).toBe('drafted')
  })
})

describe('now (F-5.23)', () => {
  const docs = [
    { id: 'a', wordCount: 100 },
    { id: 'b', wordCount: 50 },
    { id: 'c', wordCount: 0 }
  ]

  it('is the open scene, else the latest written scene, else nothing', () => {
    expect(resolveNow(docs, 'a')).toEqual({ nowId: 'a', basis: 'open' })
    expect(resolveNow(docs, 'c')).toEqual({ nowId: 'c', basis: 'open' })
    expect(resolveNow(docs, null)).toEqual({ nowId: 'b', basis: 'latest' })
    expect(resolveNow(docs, 'research-note')).toEqual({ nowId: 'b', basis: 'latest' })
    expect(resolveNow([{ id: 'x', wordCount: 0 }], null)).toEqual({ nowId: null, basis: 'none' })
  })

  it('places scenes before, at, and after now; with nothing written every scene is later', () => {
    const order = ['a', 'b', 'c']
    expect(positionIn(order, 'b', 'a')).toBe('earlier')
    expect(positionIn(order, 'b', 'b')).toBe('now')
    expect(positionIn(order, 'b', 'c')).toBe('later')
    expect(positionIn(order, 'b', 'sheet')).toBeNull()
    expect(positionIn(order, null, 'a')).toBe('later')
  })
})

describe('mapSummary', () => {
  it('keeps the first sentence on one line, cut with an ellipsis', () => {
    expect(mapSummary('Mara lands.\nShe waits.')).toBe('Mara lands.')
    expect(mapSummary('No stop here')).toBe('No stop here')
    expect(mapSummary('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`)
  })
})

describe('renderStoryMap (F-5.23)', () => {
  const book: StoryMapItem[] = [
    folder('c1', 'Chapter 1'),
    scene('s1', 'Arrival', 'revised', 'Mara lands at Keep. She is tired.'),
    scene('s2', 'The ledger', 'drafted', 'Tomas wants the ledger.'),
    folder('c2', 'Chapter 2'),
    scene('s3', 'The war', 'planned')
  ]

  it('lists the book in reading order with progress, summaries, and the mark on now', () => {
    expect(renderStoryMap(book, { nowId: 's2', basis: 'open' }, 1_000)).toBe(
      [
        STORY_MAP_HEADING,
        'Chapter 1',
        '  Arrival [revised]: Mara lands at Keep.',
        '  The ledger [drafted] ▶ NOW: Tomas wants the ledger.',
        'Chapter 2',
        '  The war [planned]'
      ].join('\n')
    )
  })

  it('names the refs when the prompt has them, and says how now was found', () => {
    const withRefs = book.map((item, i) => ({ ...item, ref: `n${i + 2}` }))
    const latest = renderStoryMap(withRefs, { nowId: 's2', basis: 'latest' }, 1_000) ?? ''
    expect(latest.split('\n').slice(0, 3)).toEqual([
      STORY_MAP_HEADING,
      STORY_MAP_LATEST_NOTE,
      'n2 Chapter 1'
    ])
    const none = renderStoryMap(book, { nowId: null, basis: 'none' }, 1_000) ?? ''
    expect(none).toContain(STORY_MAP_NOTHING_WRITTEN)
    expect(none).not.toMatch(/\] ▶ NOW/)
  })

  it('is null without a document', () => {
    expect(
      renderStoryMap([folder('c1', 'Chapter 1')], { nowId: null, basis: 'none' }, 1_000)
    ).toBeNull()
  })

  it('drops summaries before scenes, the earlier ones nearest now kept first', () => {
    const expected = [
      STORY_MAP_HEADING,
      'Chapter 1',
      '  Arrival [revised]',
      '  The ledger [drafted] ▶ NOW: Tomas wants the ledger.',
      'Chapter 2',
      '  The war [planned]'
    ]
    // Exactly room for every line and now's summary: Arrival's summary is the one left out.
    const budget = expected.reduce((sum, line) => sum + estimateTokens(`${line}\n`), 0)
    expect(renderStoryMap(book, { nowId: 's2', basis: 'open' }, budget)).toBe(expected.join('\n'))
  })

  it('keeps a window around now within the budget on a long book, counting what it cut', () => {
    const long: StoryMapItem[] = Array.from({ length: 300 }, (_, i) =>
      scene(`s${i}`, `Scene number ${i}`, 'drafted', 'Something happens here.', 0)
    )
    const map = renderStoryMap(long, { nowId: 's150', basis: 'open' }, 300) ?? ''
    expect(estimateTokens(map)).toBeLessThanOrEqual(300)
    expect(map).toContain('Scene number 150 [drafted] ▶ NOW')
    expect(map).toMatch(/^… \d+ earlier scenes$/m)
    expect(map).toMatch(/^… \d+ later scenes$/m)
    expect(map).toContain('Scene number 149')
    expect(map).toContain('Scene number 151')
    expect(map).not.toContain('Scene number 0 ')
  })
})
