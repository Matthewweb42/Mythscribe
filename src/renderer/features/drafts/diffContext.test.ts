import { describe, expect, it } from 'vitest'
import type { DiffSegment } from '@shared/drafts'
import { collapseUnchanged } from './diffContext'

const words = (count: number, word = 'word'): string =>
  Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ')

describe('collapseUnchanged (F-8.5)', () => {
  it('keeps short unchanged runs whole', () => {
    const segments: DiffSegment[] = [
      { op: 'same', text: 'The storm ' },
      { op: 'del', text: 'broke' },
      { op: 'add', text: 'arrived' },
      { op: 'same', text: ' at dusk.' }
    ]
    expect(collapseUnchanged(segments, 20)).toEqual(segments)
  })

  it('keeps context next to each change and hides the middle of a long run', () => {
    const middle = `${words(40)} `
    const shown = collapseUnchanged(
      [
        { op: 'add', text: 'New.' },
        { op: 'same', text: middle },
        { op: 'del', text: 'Old.' }
      ],
      20
    )
    expect(shown.map((s) => s.op)).toEqual(['add', 'same', 'gap', 'same', 'del'])
    const [, start, gap, end] = shown
    if (start?.op !== 'same' || gap?.op !== 'gap' || end?.op !== 'same') throw new Error('shape')
    expect(start.text.length).toBeLessThanOrEqual(20)
    expect(middle.startsWith(start.text)).toBe(true)
    expect(start.text.endsWith(' ')).toBe(true) // cut on a word boundary
    expect(end.text.length).toBeLessThanOrEqual(20)
    expect(middle.endsWith(end.text)).toBe(true)
    expect(start.text.length + gap.chars + end.text.length).toBe(middle.length)
  })

  it('hides the far side of a long leading or trailing run', () => {
    const lead = words(30)
    const shown = collapseUnchanged(
      [
        { op: 'same', text: lead },
        { op: 'add', text: ' and more' }
      ],
      20
    )
    expect(shown.map((s) => s.op)).toEqual(['gap', 'same', 'add'])
    const [gap, end] = shown
    if (gap?.op !== 'gap' || end?.op !== 'same') throw new Error('shape')
    expect(gap.chars + end.text.length).toBe(lead.length)
    expect(lead.endsWith(end.text)).toBe(true)
  })
})
