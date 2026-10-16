import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import {
  SCRIBE_FORCED_BOOK_TOKENS,
  SCRIBE_NOTES_TOKENS,
  SCRIBE_PICK_BOOK_TOKENS,
  SCRIBE_WHOLE_BOOK_TOKENS
} from '@shared/scribe2'
import {
  buildBookMap,
  buildNotesBlock,
  buildScribeContext,
  nameCount,
  namesFound,
  namesIn,
  pageNames,
  pagesNamedIn,
  pickScenes,
  type ScribeContextInput,
  type ScribePage,
  type ScribeScene
} from './context'

/** A scene of about `tokens` tokens whose text says `says`. */
function scene(n: number, says: string, tokens = 50, over: Partial<ScribeScene> = {}): ScribeScene {
  const filler = 'The tide went out and came back. '.repeat(
    Math.max(1, Math.ceil((tokens * 4) / 33))
  )
  return {
    ref: `n${n}`,
    nodeId: `sc-${n}`,
    title: `Chapter 1 › Scene ${n}`,
    synopsis: '',
    notes: '',
    summary: '',
    text: `${says} ${filler}`.trim(),
    ...over
  }
}

const page = (
  n: number,
  title: string,
  text: string,
  over: Partial<ScribePage> = {}
): ScribePage => ({
  ref: `p${n}`,
  id: `pg-${n}`,
  kind: 'note',
  title,
  folder: '',
  text,
  ...over
})

const input = (over: Partial<ScribeContextInput> = {}): ScribeContextInput => ({
  rulesTokens: 400,
  pages: [page(1, 'Mara', 'Eyes: grey. Fears the sea.'), page(2, 'Rook', 'Smuggler.')],
  scenes: [scene(1, 'Mara climbed the ridge.'), scene(2, 'Rook waited at the quay.')],
  currentId: null,
  selection: '',
  question: 'What does Mara fear?',
  wholeBook: false,
  searchHits: [],
  names: ['Mara', 'Rook'],
  ...over
})

describe('Ms Scribe’s v1 context (notes redesign phase 1)', () => {
  it('sends the whole book while everything is under the line, with every page and the map', () => {
    const context = buildScribeContext(input({ currentId: 'sc-2', selection: 'the quay' }))
    expect(context.bookMode).toBe('whole')
    expect(context.wholeEstimate).toBeLessThan(SCRIBE_WHOLE_BOOK_TOKENS)
    expect(context.notes).toContain('## p1 Mara (note)\nEyes: grey. Fears the sea.')
    expect(context.notes).toContain('## p2 Rook (note)')
    expect(context.map.split('\n')).toHaveLength(2)
    expect(context.book).toContain('### n1 Chapter 1 › Scene 1\nMara climbed the ridge.')
    expect(context.book).toContain('### n2 Chapter 1 › Scene 2\nRook waited at the quay.')
    // The open scene is in the book already: the moment points at it, never repeats it.
    expect(context.moment).toContain('The author is in n2 Chapter 1 › Scene 2.')
    expect(context.moment).toContain('Its text is in the book above (n2).')
    expect(context.moment).not.toContain('Rook waited at the quay.')
    expect(context.moment).toContain('Selected passage:\n"the quay"')
    expect(context.sentScenes).toEqual(['sc-1', 'sc-2'])
    expect(context.sentPages).toEqual(['pg-1', 'pg-2'])
  })

  it('switches to the picked scenes past the line, and sends the open scene in the moment', () => {
    // Twenty scenes of ~4,000 tokens: about 80,000, over the 60,000 line.
    const scenes = Array.from({ length: 20 }, (_, i) =>
      scene(i + 1, i === 3 ? 'Mara stared at the sea.' : `Scene ${i + 1} opens.`, 4_000)
    )
    const context = buildScribeContext(input({ scenes, currentId: 'sc-10' }))
    expect(context.wholeEstimate).toBeGreaterThan(SCRIBE_WHOLE_BOOK_TOKENS)
    expect(context.bookMode).toBe('picked')
    expect(estimateTokens(context.book)).toBeLessThanOrEqual(SCRIBE_PICK_BOOK_TOKENS + 10)
    // Named in the question first, then the neighbours (two before, one after).
    expect(context.book).toContain('### n4 ')
    expect(context.book).toContain('### n9 ')
    expect(context.book).toContain('### n11 ')
    expect(context.book).not.toContain('### n10 ')
    expect(context.moment).toContain('Its text:\nScene 10 opens.')
    expect(context.sentScenes).toContain('sc-10')
    // The map still names every scene.
    expect(context.map.split('\n')).toHaveLength(20)
  })

  it('"Whole book" forces the whole book past the line, cut at its cap with the rest named', () => {
    const scenes = Array.from({ length: 30 }, (_, i) => scene(i + 1, `Scene ${i + 1}.`, 4_000))
    const context = buildScribeContext(input({ scenes, wholeBook: true }))
    expect(context.bookMode).toBe('whole')
    expect(estimateTokens(context.book)).toBeLessThanOrEqual(SCRIBE_FORCED_BOOK_TOKENS + 200)
    expect(context.book).toContain('### n1 ')
    expect(context.book).toMatch(/Left out for length: .*n30; open them with open_scene\./)
  })

  it('orders the pick: names in the question, the full-text hits, the neighbours, then names in the open scene', () => {
    const scenes = [
      scene(1, 'Rook counted coins.'),
      scene(2, 'The quay was empty.'),
      scene(3, 'Mara slept.'),
      scene(4, 'Rook spoke to Mara.'),
      scene(5, 'Gulls.'),
      scene(6, 'Fog.')
    ]
    const cost = estimateTokens(`### n1 Chapter 1 › Scene 1\n${scenes[0]?.text ?? ''}`) + 1
    // Room for three scenes: Mara's two (the question names her), then the search hit.
    const picked = pickScenes(
      scenes,
      {
        currentId: 'sc-5',
        question: 'where does mara sleep',
        searchHits: ['sc-2'],
        names: ['Mara', 'Rook']
      },
      cost * 3
    )
    expect(picked.map((s) => s.nodeId)).toEqual(['sc-2', 'sc-3', 'sc-4'])
    // With room, the neighbours come next (two before, one after), never the open scene.
    const more = pickScenes(scenes, {
      currentId: 'sc-5',
      question: 'what now',
      searchHits: [],
      names: []
    })
    expect(more.map((s) => s.nodeId)).toEqual(['sc-3', 'sc-4', 'sc-6'])
  })

  it('finds names as words, any case in the question and as written in the book', () => {
    expect(namesFound('what does MARA fear?', ['Mara', 'Rook'], true)).toEqual(['Mara'])
    expect(namesFound('Marabel arrived.', ['Mara'], false)).toEqual([])
    expect(namesFound('the rook flew', ['Rook'], false)).toEqual([])
    expect(namesFound('Al and Bo', ['Al', 'Bo'], true)).toEqual([])
  })

  it('past the notes budget lists every page, then the pages the question names, then the rest that fit', () => {
    const big = 'word '.repeat(SCRIBE_NOTES_TOKENS)
    const pages = [
      page(1, 'Atlas', big),
      page(2, 'Mara', 'Fears the sea.'),
      page(3, 'Rook', 'Smuggler.')
    ]
    const block = buildNotesBlock(pages, new Set(['pg-2']))
    expect(block.text).toContain(
      'Every page (open one with open_note):\np1 Atlas (note)\np2 Mara (note)'
    )
    expect(block.text).toContain('## p2 Mara (note)\nFears the sea.')
    expect(block.text).toContain('## p3 Rook (note)')
    expect(block.text).not.toContain('## p1 Atlas')
    expect(block.sent).toEqual(['pg-2', 'pg-3'])
  })

  it('maps each scene by its synopsis and notes, and by the stored summary only without a synopsis', () => {
    const map = buildBookMap([
      scene(1, 'x', 10, {
        synopsis: 'Mara climbs.',
        notes: 'Raise the stakes.',
        summary: 'ignored'
      }),
      scene(2, 'y', 10, { summary: 'Rook waits at the quay.' })
    ])
    expect(map).toBe(
      'n1 Chapter 1 › Scene 1 | synopsis: Mara climbs. | notes: Raise the stakes.\n' +
        'n2 Chapter 1 › Scene 2 | summary (AI): Rook waits at the quay.'
    )
    expect(buildBookMap([])).toBe('The book has no scenes yet.')
  })
})

describe('page names (notes redesign, 2026-10-15)', () => {
  it('counts a name each time it stands as a word, side by side too', () => {
    expect(nameCount('Tash, Tash and Tasha. TASH', 'Tash', false)).toBe(2)
    expect(nameCount('Tash, Tash and Tasha. TASH', 'Tash', true)).toBe(3)
    expect(nameCount('Tash Tash', 'Tash', false)).toBe(2)
    expect(nameCount('Al and Al', 'Al', false)).toBe(0)
    expect(namesIn('Rook waited.', 'Rook', false)).toBe(true)
    expect(namesIn('Rooks waited.', 'Rook', false)).toBe(false)
  })

  it('answers a page to its title and its capitalised words of four letters or more', () => {
    expect(pageNames('Tash — powers')).toEqual(['Tash — powers', 'Tash'])
    expect(pageNames("Mara's Ship")).toEqual(["Mara's Ship", 'Mara', 'Ship'])
    expect(pageNames('What the river knows')).toEqual(['What the river knows'])
    expect(pageNames('Rook')).toEqual(['Rook'])
    expect(pageNames('Al & Bo')).toEqual(['Al & Bo'])
  })

  it('ranks the pages a text names by how often, ties in order, the rest left out', () => {
    const pages = [
      { title: 'Mara' },
      { title: 'Tash — powers' },
      { title: 'Outline' },
      { title: 'Rook' }
    ]
    expect(
      pagesNamedIn(pages, [
        { text: 'Mara saw Tash. Tash ran.', caseless: false },
        { text: 'rook waits', caseless: true }
      ]).map((page) => page.title)
    ).toEqual(['Tash — powers', 'Mara', 'Rook'])
    expect(pagesNamedIn(pages, [{ text: 'rook waits', caseless: false }])).toEqual([])
  })
})
