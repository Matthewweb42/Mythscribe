import { describe, expect, it } from 'vitest'
import { passageParagraphs } from '../mentions'
import { sceneSentences } from './anchor'
import type { RenameEdit } from './rename'
import {
  rewriteAnchor,
  rewriteQuote,
  rewriteWords,
  sentencePairs,
  textEdits,
  type TextEdit
} from './renameEvidence'

const TEXTS = ['The ridge was cold.', "Mara's eyes were grey. Mara waited, and Mr. Mara Vell came."]
const PARAGRAPHS = passageParagraphs({
  type: 'doc',
  content: TEXTS.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/** The rename's edits for every whole-word "Mara" of paragraph 1 not inside "Mara Vell". */
function edits(): RenameEdit[] {
  const paragraph = PARAGRAPHS[1]
  if (paragraph === undefined) throw new Error('no paragraph')
  return [0, 23].map((at) => ({
    from: paragraph.from + at,
    to: paragraph.from + at + 4,
    text: 'Mara',
    replacement: 'Rynna'
  }))
}

describe('textEdits (F-16.17)', () => {
  it('moves each edit to offsets in its paragraph', () => {
    const byPara = textEdits(PARAGRAPHS, edits())
    expect([...byPara.keys()]).toEqual([1])
    expect(byPara.get(1)?.map((edit) => [edit.start, edit.end])).toEqual([
      [0, 4],
      [23, 27]
    ])
    expect(TEXTS[1]?.slice(23, 27)).toBe('Mara')
  })
})

describe('rewriteQuote', () => {
  const byPara = textEdits(PARAGRAPHS, edits()).get(1) ?? []

  it('rewrites the names inside a quote and leaves the rest', () => {
    expect(rewriteQuote(TEXTS[1] ?? '', "Mara's eyes were grey", byPara)).toBe(
      "Rynna's eyes were grey"
    )
    expect(rewriteQuote(TEXTS[1] ?? '', 'Mara waited', byPara)).toBe('Rynna waited')
    expect(rewriteQuote(TEXTS[1] ?? '', 'came.', byPara)).toBe('came.')
  })

  it('takes in a name the quote only partly covers, and leaves a quote it cannot find', () => {
    const partial: TextEdit[] = [
      { start: 5, end: 16, text: 'the Captain', replacement: 'the Major' }
    ]
    expect(rewriteQuote('Then the Captain wept.', 'Captain wept', partial)).toBe('the Major wept')
    expect(rewriteQuote(TEXTS[1] ?? '', 'not in the text at all', byPara)).toBeNull()
  })
})

describe('rewriteWords, sentencePairs and rewriteAnchor', () => {
  it('replaces the renamed words on word boundaries in their case', () => {
    const list: TextEdit[] = [{ start: 0, end: 4, text: 'Mara', replacement: 'Rynna' }]
    expect(rewriteWords('Mara waits; Maralyn and mara stay.', list)).toBe(
      'Rynna waits; Maralyn and mara stay.'
    )
  })

  it('pairs each sentence with its rewritten one, and moves an anchor by position', () => {
    const after = [
      'The ridge was cold.',
      "Rynna's eyes were grey. Rynna waited, and Mr. Mara Vell came."
    ]
    const pairs = sentencePairs(TEXTS, after)
    const old = sceneSentences(TEXTS).map((sentence) => sentence.hash)
    const fresh = sceneSentences(after).map((sentence) => sentence.hash)
    expect(rewriteAnchor(old, pairs)).toEqual(fresh)
    expect(rewriteAnchor(['unknown'], pairs)).toEqual(['unknown'])
    expect(pairs?.texts.get("Mara's eyes were grey.")).toBe("Rynna's eyes were grey.")
    // A rewrite that changes how the scene splits pairs nothing.
    expect(sentencePairs(['One. Two.'], ['One Two.'])).toBeNull()
    expect(rewriteAnchor(old, null)).toEqual(old)
  })
})
