import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiWrittenOf, pageTextBlocks } from '@shared/memory/pageMarks'
import { card, claim, reading } from '../db/schema'
import { searchMemoryPassages } from '../memory/passageIndexer'
import { getRecord, savePage } from '../memory/recordStore'
import { closeScribeBook, doc, SCRIBE_NOW, scribeBook, type ScribeBook } from './scribeFixture'
import { addSheetLine, removeSheetLine } from './sheetLines'

/**
 * Sheet lines from the chat (F-16.26; plan P3 §1.6): a line lands at the end of Pinned or Ideas
 * marked `aiWritten`, a line the page says already is refused, the Undo takes it out only while it
 * reads as written, the passage index finds it at once, and nothing but the page is written (no
 * claim, card or reading, P3 rule 6).
 */

let book: ScribeBook

beforeEach(() => {
  book = scribeBook()
})
afterEach(() => closeScribeBook(book))

const blocksOf = (page: 'pinned' | 'ideas'): ReturnType<typeof pageTextBlocks> => {
  const record = getRecord(book.db, book.mara)
  const doc = page === 'pinned' ? record?.pinned : record?.ideas
  return doc == null ? [] : pageTextBlocks(doc)
}

const rows = (): number[] =>
  [claim, card, reading].map((table) => book.db.select().from(table).all().length)

describe('addSheetLine and removeSheetLine (F-16.26)', () => {
  it('names the Pinned line a new line contradicts (same label, another value); Ideas may disagree', () => {
    savePage(book.db, book.mara, 'pinned', doc('Eyes: grey', 'Born: 1790'), SCRIBE_NOW)
    const added = addSheetLine(
      book.db,
      { id: book.mara, page: 'pinned', text: 'Eyes: green', turn: 'm1' },
      SCRIBE_NOW
    )
    expect(added).toMatchObject({ index: 2, conflict: { index: 0, text: 'Eyes: grey' } })
    savePage(book.db, book.mara, 'ideas', doc('Eyes: grey'), SCRIBE_NOW)
    expect(
      addSheetLine(
        book.db,
        { id: book.mara, page: 'ideas', text: 'Eyes: violet', turn: 'm2' },
        SCRIBE_NOW
      ).conflict
    ).toBeNull()
  })

  it('appends a marked line to Pinned, refuses one Pinned says already, and indexes it', () => {
    const before = rows()
    savePage(book.db, book.mara, 'pinned', doc('Born: 1790'), SCRIBE_NOW)
    const added = addSheetLine(
      book.db,
      { id: book.mara, page: 'pinned', text: '  Hates   the sea. ', turn: 'm7' },
      SCRIBE_NOW
    )
    expect(added).toMatchObject({ index: 1, text: 'Hates the sea.', conflict: null })
    expect(blocksOf('pinned').map((block) => [block.text, aiWrittenOf(block.block)])).toEqual([
      ['Born: 1790', null],
      ['Hates the sea.', { turn: 'm7', date: '2026-10-13' }]
    ])
    expect(added.record.pinned).toEqual(getRecord(book.db, book.mara)?.pinned)
    expect(() =>
      addSheetLine(
        book.db,
        { id: book.mara, page: 'pinned', text: 'hates the sea', turn: 'm8' },
        SCRIBE_NOW
      )
    ).toThrow(/already says that/)
    expect(() =>
      addSheetLine(
        book.db,
        { id: book.mara, page: 'pinned', text: 'Born: 1790', turn: 'm8' },
        SCRIBE_NOW
      )
    ).toThrow(/already says that/)
    expect(searchMemoryPassages(book.db, 'sea')).toMatchObject([
      { source: 'pinned', ownerId: book.mara, para: 1, label: 'pinned' }
    ])
    // Only the page was written: no claim, card or reading.
    expect(rows()).toEqual(before)
  })

  it('appends to Ideas on an empty page, found as the author’s idea', () => {
    const added = addSheetLine(
      book.db,
      { id: book.mara, page: 'ideas', text: 'Maybe a twin in the north.', turn: 'm2' },
      SCRIBE_NOW
    )
    expect(added.index).toBe(0)
    expect(aiWrittenOf(blocksOf('ideas')[0]?.block ?? { type: 'paragraph' })).toEqual({
      turn: 'm2',
      date: '2026-10-13'
    })
    expect(searchMemoryPassages(book.db, 'twin')).toMatchObject([
      { source: 'idea', ownerId: book.mara, canon: 'notCanon', label: 'idea' }
    ])
  })

  it('takes the line out while it reads as written, and refuses after the author edited it', () => {
    savePage(book.db, book.mara, 'pinned', doc('Born: 1790'), SCRIBE_NOW)
    const added = addSheetLine(
      book.db,
      { id: book.mara, page: 'pinned', text: 'Hates the sea.', turn: 'm7' },
      SCRIBE_NOW
    )
    const undo = {
      id: book.mara,
      page: 'pinned' as const,
      index: added.index,
      text: added.text,
      turn: 'm7'
    }
    expect(() => removeSheetLine(book.db, { ...undo, turn: 'm9' }, SCRIBE_NOW)).toThrow(
      'Edited since; change it on the sheet.'
    )
    const removed = removeSheetLine(book.db, undo, SCRIBE_NOW)
    expect(removed.pinned).toEqual(doc('Born: 1790'))
    expect(searchMemoryPassages(book.db, 'sea')).toEqual([])
    // Written again, then edited by the author (her edit clears the mark): it stays.
    addSheetLine(
      book.db,
      { id: book.mara, page: 'pinned', text: 'Hates the sea.', turn: 'm7' },
      SCRIBE_NOW
    )
    savePage(book.db, book.mara, 'pinned', doc('Born: 1790', 'Hates the sea.'), SCRIBE_NOW)
    expect(() => removeSheetLine(book.db, undo, SCRIBE_NOW)).toThrow('Edited since')
    savePage(book.db, book.mara, 'pinned', doc('Born: 1790', 'Loves the sea.'), SCRIBE_NOW)
    expect(() => removeSheetLine(book.db, undo, SCRIBE_NOW)).toThrow('Edited since')
    expect(blocksOf('pinned').map((block) => block.text)).toEqual(['Born: 1790', 'Loves the sea.'])
  })

  it('undoes two lines of one turn in the order they were added (the second moved up)', () => {
    const add = (text: string): ReturnType<typeof addSheetLine> =>
      addSheetLine(book.db, { id: book.mara, page: 'pinned', text, turn: 't1' }, SCRIBE_NOW)
    const first = add('Hates the sea.')
    const second = add('Limps on the left.')
    expect([first.index, second.index]).toEqual([0, 1])
    const undo = (added: ReturnType<typeof addSheetLine>): void =>
      void removeSheetLine(
        book.db,
        { id: book.mara, page: 'pinned', index: added.index, text: added.text, turn: 't1' },
        SCRIBE_NOW
      )
    undo(first)
    expect(blocksOf('pinned').map((block) => block.text)).toEqual(['Limps on the left.'])
    undo(second)
    expect(blocksOf('pinned')).toEqual([])
  })

  it('writes only on a named record’s sheet', () => {
    expect(() =>
      addSheetLine(
        book.db,
        { id: book.map, page: 'pinned', text: 'Sold in 1.1.', turn: 'm1' },
        SCRIBE_NOW
      )
    ).toThrow(/named record/)
    expect(() =>
      addSheetLine(book.db, { id: 'nobody', page: 'pinned', text: 'x', turn: 'm1' }, SCRIBE_NOW)
    ).toThrow()
  })
})
