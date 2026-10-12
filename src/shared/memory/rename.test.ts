import { describe, expect, it } from 'vitest'
import { passageParagraphs } from '../mentions'
import type { TiptapNodeT } from '../tiptap'
import { dismissedKey } from './dismissed'
import { buildNameIndex } from './nameScan'
import { normName } from './names'
import { notMentionMoves, planRename, renameReplacement } from './rename'

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const alias = (id: string, recordId: string, text: string) => ({
  id,
  recordId,
  text,
  norm: normName(text),
  caseRule: 'auto' as const,
  shared: false
})

describe('renameReplacement (F-16.13)', () => {
  it('writes the new name as typed where the place writes the name as stored', () => {
    expect(renameReplacement('Hesk', 'Hesk', 'Haskel')).toBe('Haskel')
    expect(renameReplacement('the captain', 'the captain', 'the skipper')).toBe('the skipper')
  })

  it('keeps an all-caps place in capitals and a first letter in the place’s case', () => {
    expect(renameReplacement('HESK', 'Hesk', 'Haskel')).toBe('HASKEL')
    expect(renameReplacement('The captain', 'the captain', 'the skipper')).toBe('The skipper')
    expect(renameReplacement('the Captain', 'The Captain', 'Old Skip')).toBe('old Skip')
    // A name stored in capitals stays as typed.
    expect(renameReplacement('NASA', 'NASA', 'ESA')).toBe('ESA')
  })
})

describe('planRename (F-16.13)', () => {
  const index = buildNameIndex(
    [
      { id: 'mara', kind: 'character' },
      { id: 'tomas', kind: 'character' }
    ],
    [alias('m1', 'mara', 'Mara Vell'), alias('m2', 'mara', 'Mara'), alias('t1', 'tomas', 'Tomas')]
  )
  const target = { recordId: 'mara', text: 'Mara', norm: 'mara', caseRule: 'auto' as const }

  it('rewrites the certain mentions by that name only and counts the rest', () => {
    const paragraphs = passageParagraphs(doc('Mara Vell came in. Later Mara sat by Tomas.'))
    const plan = planRename(
      paragraphs,
      index,
      { povRecordId: null, notMention: new Set() },
      target,
      'Mira'
    )
    expect(plan.writes).toBe(true)
    expect(plan.edits).toEqual([{ from: 26, to: 30, text: 'Mara', replacement: 'Mira' }])
    expect(plan.kept).toEqual({ notMention: 0, unsure: 0, other: 1 })
  })

  it('skips a text that never writes the name', () => {
    const paragraphs = passageParagraphs(doc('Tomas sat alone.'))
    const plan = planRename(
      paragraphs,
      index,
      { povRecordId: null, notMention: new Set() },
      target,
      'Mira'
    )
    expect(plan).toEqual({ writes: false, edits: [], kept: { notMention: 0, unsure: 0, other: 0 } })
  })
})

describe('notMentionMoves (F-16.13)', () => {
  const index = buildNameIndex(
    [
      { id: 'hesk', kind: 'character' },
      { id: 'mara', kind: 'character' }
    ],
    [alias('h1', 'hesk', 'Hesk'), alias('m1', 'mara', 'Mara')]
  )

  it('answers each struck key before and after the edits', () => {
    const paragraphs = passageParagraphs(doc('Hesk, Mara, and Tomas left.'))
    const before = dismissedKey({ kind: 'notMention', recordId: 'mara', phrase: 'Hesk, Mara, and' })
    const ctx = { povRecordId: null, notMention: new Set([before]) }
    const edits = [{ from: 1, to: 5, text: 'Hesk', replacement: 'Haskel' }]
    expect(notMentionMoves(paragraphs, index, ctx, edits)).toEqual([
      {
        before,
        after: dismissedKey({ kind: 'notMention', recordId: 'mara', phrase: 'Haskel, Mara, and' }),
        phrase: 'Haskel, Mara, and'
      }
    ])
    // Without edits the key answers itself: the text still writes the phrase.
    expect(notMentionMoves(paragraphs, index, ctx, [])).toEqual([
      { before, after: before, phrase: 'Hesk, Mara, and' }
    ])
  })
})
