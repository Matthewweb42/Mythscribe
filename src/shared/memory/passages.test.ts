import { describe, expect, it } from 'vitest'
import { passageParagraphs } from '../mentions'
import type { TiptapNodeT } from '../tiptap'
import { markedParagraphs } from './pageMarks'
import { DEFAULT_PASSAGE_SOURCES, PASSAGE_SOURCES, passageCanon, passageLabel } from './passages'
import { meaningOf } from './sources'

const para = (text: string, notCanon = false): TiptapNodeT => ({
  type: 'paragraph',
  ...(notCanon ? { attrs: { notCanon: true } } : {}),
  content: [{ type: 'text', text }]
})

describe('passage labels (F-16.5)', () => {
  it('labels a marked paragraph Not canon, whatever its source, and means never', () => {
    expect(passageLabel('pinned', 'canon')).toBe('pinned')
    expect(passageLabel('pinned', 'notCanon')).toBe('notCanon')
    expect(meaningOf(passageLabel('research', 'notCanon'), { order: 0, openOrder: 0 })).toBe(
      'never'
    )
    expect(meaningOf(passageLabel('idea', 'canon'), { order: 0, openOrder: 0 })).toBe('never')
    expect(meaningOf(passageLabel('sceneNote', 'canon'), { order: 0, openOrder: 0 })).toBe('plan')
  })

  it('never reads Ideas, Idea scenes or left-out scenes as canon, and keeps their own label', () => {
    for (const source of ['idea', 'ideaScene', 'excludedScene'] as const) {
      expect(passageCanon(source, false)).toBe('notCanon')
      expect(passageLabel(source, passageCanon(source, false))).toBe(source)
    }
    // Every source whose text means anything but never (or a map) is canon until marked.
    for (const source of PASSAGE_SOURCES) {
      const meaning = meaningOf(source, { order: 0, openOrder: 0 })
      const real = meaning !== 'never' && meaning !== 'map'
      expect(passageCanon(source, false)).toBe(real ? 'canon' : 'notCanon')
      expect(passageCanon(source, true)).toBe('notCanon')
    }
  })

  it('keeps a card line (F-16.18) a map: never canon, labelled card, left out of a default search', () => {
    expect(passageCanon('card', false)).toBe('notCanon')
    expect(passageLabel('card', 'notCanon')).toBe('card')
    expect(meaningOf('card', { order: 0, openOrder: 0 })).toBe('map')
    expect(DEFAULT_PASSAGE_SOURCES).not.toContain('card')
    expect(DEFAULT_PASSAGE_SOURCES).toHaveLength(PASSAGE_SOURCES.length - 1)
  })
})

describe('markedParagraphs', () => {
  it('reads the same paragraphs as passageParagraphs, with each one’s mark, inherited from its block', () => {
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        para('Eyes: grey'),
        para('Maybe she was a twin?', true),
        { type: 'paragraph' },
        {
          type: 'bulletList',
          attrs: { notCanon: true },
          content: [{ type: 'listItem', content: [para('Born in the north')] }]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Line one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line two' }
          ]
        }
      ]
    }
    const marked = markedParagraphs(doc)
    expect(marked.map((p) => p.text)).toEqual(passageParagraphs(doc).map((p) => p.text))
    expect(marked.map((p) => [p.index, p.notCanon])).toEqual([
      [0, false],
      [1, true],
      [2, true],
      [3, false]
    ])
  })
})
