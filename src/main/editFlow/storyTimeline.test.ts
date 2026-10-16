import { describe, expect, it } from 'vitest'
import { docToText } from '@shared/docText'
import type { TiptapNodeT } from '@shared/tiptap'
import { insertTimelineEvents } from './storyTimeline'

/** The notes binder (2026-10-16, `editNotes.v2`): events put on the Story timeline page. */

const para = (text: string): TiptapNodeT => ({
  type: 'paragraph',
  content: [{ type: 'text', text }]
})
const heading = (text: string): TiptapNodeT => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }]
})
const lines = (blocks: readonly TiptapNodeT[]): string[] =>
  blocks.map((block) => docToText({ type: 'doc', content: [block] }))

const PAGE = [
  heading('Before the story'),
  para('Ch 1 · Mara reaches the quay.'),
  para('Ch 3 · Mara leaves the valley.')
]

describe('insertTimelineEvents', () => {
  it('inserts an event after the line it follows, in story order, keeping every line and heading', () => {
    const { blocks, added } = insertTimelineEvents(PAGE, [
      { line: 'Ch 2 · Rook meets Mara.', after: 'Ch 1 · Mara reaches the quay.' }
    ])
    expect(lines(blocks)).toEqual([
      'Before the story',
      'Ch 1 · Mara reaches the quay.',
      'Ch 2 · Rook meets Mara.',
      'Ch 3 · Mara leaves the valley.'
    ])
    expect(blocks[0]).toBe(PAGE[0])
    expect(added).toEqual(['Ch 2 · Rook meets Mara.'])
  })

  it('puts a flashback’s event first with "", keeps events that share an anchor in order, and appends one with none', () => {
    const { blocks } = insertTimelineEvents(PAGE, [
      { line: 'Ch 2 · Years before, Rook burns the ledger.', after: '' },
      { line: 'Ch 2 · The river freezes.', after: '' },
      { line: 'Ch 2 · Rook meets Mara.', after: 'ch 1 · mara reaches  the quay' },
      { line: 'Ch 2 · Rook gives her the key.', after: 'Ch 1 · Mara reaches the quay.' },
      { line: 'Ch 4 · The mill burns.', after: null },
      { line: 'Ch 5 · The flood.', after: 'a line that is not there' }
    ])
    expect(lines(blocks)).toEqual([
      'Ch 2 · Years before, Rook burns the ledger.',
      'Ch 2 · The river freezes.',
      'Before the story',
      'Ch 1 · Mara reaches the quay.',
      'Ch 2 · Rook meets Mara.',
      'Ch 2 · Rook gives her the key.',
      'Ch 3 · Mara leaves the valley.',
      'Ch 4 · The mill burns.',
      'Ch 5 · The flood.'
    ])
  })

  it('anchors on an event added before it in the same batch, finds a line by a part of it, and skips a line the page has', () => {
    const { blocks, added } = insertTimelineEvents(PAGE, [
      { line: 'Ch 2 · Rook meets Mara.', after: 'Mara reaches the quay' },
      { line: 'Ch 2 · Rook gives her the key.', after: 'Ch 2 · Rook meets Mara.' },
      { line: 'Ch 3 · Mara leaves the valley.', after: '' },
      { line: 'ch 2 · rook meets mara.', after: '' }
    ])
    expect(lines(blocks)).toEqual([
      'Before the story',
      'Ch 1 · Mara reaches the quay.',
      'Ch 2 · Rook meets Mara.',
      'Ch 2 · Rook gives her the key.',
      'Ch 3 · Mara leaves the valley.'
    ])
    expect(added).toEqual(['Ch 2 · Rook meets Mara.', 'Ch 2 · Rook gives her the key.'])
  })

  it('makes the page’s lines from nothing, and adds nothing for no event', () => {
    expect(lines(insertTimelineEvents([], [{ line: 'Ch 1 · A.', after: 'x' }]).blocks)).toEqual([
      'Ch 1 · A.'
    ])
    expect(insertTimelineEvents(PAGE, [])).toEqual({ blocks: PAGE, added: [] })
  })
})
