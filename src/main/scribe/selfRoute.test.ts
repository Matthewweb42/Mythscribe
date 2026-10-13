import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveDocument } from '../document/documentStore'
import { getNode } from '../tree/treeStore'
import { evidenceFrame } from './evidence'
import { closeScribeBook, doc, scribeBook, type ScribeBook } from './scribeFixture'
import { resolveNeed, widenKeys } from './selfRoute'

/** Self-Route (F-16.25, P3-D15): what one `{"need":…}` names, on the scribe test book (1.1–1.3). */

let book: ScribeBook
beforeEach(() => {
  book = scribeBook()
})
afterEach(() => closeScribeBook(book))

describe('resolveNeed', () => {
  it('reads a chapter by number, Roman numeral or title, a scene, and a range', () => {
    const frame = evidenceFrame(book.db, book.one)
    const all = [book.one, book.two, book.three]
    expect(resolveNeed(frame, 'chapter 1')).toEqual({ what: 'chapter 1 (1.1–1.3)', nodeIds: all })
    expect(resolveNeed(frame, 'Ch. I')?.nodeIds).toEqual(all)
    expect(resolveNeed(frame, '1')?.nodeIds).toEqual(all)
    expect(resolveNeed(frame, '1.2')).toEqual({ what: '1.2', nodeIds: [book.two] })
    expect(resolveNeed(frame, 'scene 1.3')?.nodeIds).toEqual([book.three])
    expect(resolveNeed(frame, '1.2-1.3')).toEqual({
      what: '1.2–1.3',
      nodeIds: [book.two, book.three]
    })
    expect(resolveNeed(frame, '1.1 to 1.2')?.nodeIds).toEqual([book.one, book.two])
    expect(resolveNeed(frame, '“Two”')).toEqual({ what: '1.2', nodeIds: [book.two] })
    const chapter = getNode(book.db, getNode(book.db, book.one)?.parentId ?? '')
    expect(resolveNeed(frame, `the chapter ${chapter?.title ?? ''}`)?.nodeIds).toEqual(all)
  })

  it('answers null for a need that names nothing readable', () => {
    const frame = evidenceFrame(book.db, book.one)
    expect(resolveNeed(frame, 'chapter 40')).toBeNull()
    expect(resolveNeed(frame, '9.3')).toBeNull()
    expect(resolveNeed(frame, '')).toBeNull()
    expect(resolveNeed(frame, 'the one where nothing happens')).toBeNull()
  })

  it('widens each scene whole', () => {
    const frame = evidenceFrame(book.db, book.one)
    expect(widenKeys(frame, [book.two, book.three])).toEqual([
      { kind: 'scene', nodeId: book.two, from: 0, to: 1 },
      { kind: 'scene', nodeId: book.three, from: 0, to: 1 }
    ])
  })

  it('leaves out a scene over what is left of the budget, and reads one too long alone in part around the hit', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i} ${'harbour '.repeat(20)}`)
    saveDocument(book.db, book.two, doc(...long))
    const frame = evidenceFrame(book.db, book.one)
    // 1.2 is far over 300 tokens; 1.3 fits whole.
    expect(widenKeys(frame, [book.two, book.three], { budget: 300, hits: [] })).toEqual([
      { kind: 'scene', nodeId: book.three, from: 0, to: 1 }
    ])
    // 1.2 alone: the paragraphs around the turn's hit in it that fit, never nothing.
    const part = widenKeys(frame, [book.two], {
      budget: 300,
      hits: [{ nodeId: book.two, para: 20 }]
    })
    expect(part).toHaveLength(1)
    const key = part[0]
    expect(key?.kind === 'scene' && key.from <= 20 && key.to >= 20 && key.to - key.from < 39).toBe(
      true
    )
    // Without a hit, from its start.
    expect(widenKeys(frame, [book.two], { budget: 300, hits: [] })[0]).toMatchObject({ from: 0 })
    // A paragraph over the whole budget alone: nothing to read.
    expect(widenKeys(frame, [book.two], { budget: 10, hits: [] })).toEqual([])
  })
})
