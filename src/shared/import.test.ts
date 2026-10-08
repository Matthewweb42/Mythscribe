import { describe, expect, it } from 'vitest'
import {
  IMPORT_PREVIEW_MAX,
  IMPORT_TITLE_MAX,
  draftSummary,
  importFormatOf,
  sceneDocument,
  sceneFirstLine,
  sceneWords,
  type ImportDraft,
  type ImportScene
} from './import'
import { NODE_TITLE_MAX } from './ipc/contract'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from './provenance'
import type { TiptapNodeT } from './tiptap'

function paragraph(text: string): TiptapNodeT {
  return {
    type: 'paragraph',
    attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
    content: [{ type: 'text', text }]
  }
}

function scene(id: string, texts: string[], excluded = false): ImportScene {
  return { id, title: id, excluded, paragraphs: texts.map(paragraph), tags: [] }
}

describe('importFormatOf', () => {
  it('maps the supported extensions case-insensitively and refuses the rest', () => {
    expect(importFormatOf('Book.DOCX')).toBe('docx')
    expect(importFormatOf('book.markdown')).toBe('md')
    expect(importFormatOf('book.md')).toBe('md')
    expect(importFormatOf('book.txt')).toBe('txt')
    expect(importFormatOf('book.pdf')).toBeNull()
    expect(importFormatOf('book')).toBeNull()
  })
})

describe('scene helpers', () => {
  it('keeps the title cap equal to the contract', () => {
    expect(IMPORT_TITLE_MAX).toBe(NODE_TITLE_MAX)
  })

  it('previews the first paragraph on one line, capped', () => {
    expect(sceneFirstLine(scene('s', ['It was  a\ndark night.', 'Second.']))).toBe(
      'It was a dark night.'
    )
    const long = sceneFirstLine(scene('s', ['x'.repeat(300)]))
    expect(long).toHaveLength(IMPORT_PREVIEW_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(sceneFirstLine(scene('s', []))).toBe('')
  })

  it('counts words and wraps paragraphs in a document', () => {
    expect(sceneWords(scene('s', ['one two', 'three']))).toBe(3)
    expect(sceneDocument([])).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(sceneDocument([paragraph('a')]).content).toHaveLength(1)
  })
})

describe('draftSummary', () => {
  const draft: ImportDraft = {
    source: { name: 'book.md', format: 'md', words: 9, paragraphs: 5 },
    nextId: 1,
    parts: [
      {
        id: 'p1',
        title: 'Part 1',
        excluded: false,
        chapters: [
          {
            id: 'p1c1',
            title: 'Copyright',
            excluded: false,
            placement: 'front',
            scenes: [scene('a', ['all rights reserved'])]
          },
          {
            id: 'p1c2',
            title: 'Chapter 1',
            excluded: false,
            placement: 'manuscript',
            scenes: [
              scene('b', ['one two']),
              scene('c', ['three'], true),
              scene('d', ['four five'])
            ]
          },
          {
            id: 'p1c3',
            title: 'Chapter 2',
            excluded: true,
            placement: 'manuscript',
            scenes: [scene('e', ['six'])]
          }
        ]
      },
      {
        id: 'p2',
        title: 'Part 2',
        excluded: false,
        chapters: [
          {
            id: 'p2c1',
            title: 'Chapter 3',
            excluded: false,
            placement: 'manuscript',
            scenes: [scene('f', ['seven'], true)]
          }
        ]
      }
    ]
  }

  it('counts only what Import would create', () => {
    expect(draftSummary(draft)).toEqual({ parts: 1, chapters: 1, scenes: 2, matter: 1, words: 7 })
  })
})
