import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeForMatch } from '@shared/critique'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions } from './extensions'
import { locateText } from './locateText'
import { passageText } from './rewriteTarget'

const FIRST = 'The storm broke at dusk. Rain followed.'

let editor: Editor

beforeEach(() => {
  resetTagStore()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: FIRST }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Tagged ' },
            { type: 'inlineTag', attrs: { id: 't1', name: 'dark-forest' } },
            { type: 'text', text: ' after. She said “no” to him.' }
          ]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'One' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' }
          ]
        }
      ]
    }
  })
})
afterEach(() => {
  editor.destroy()
})

/** The quote as the panel would read it back out of the document, normalized on both sides. */
function readBack(quote: string): string | null {
  const range = locateText(editor.state.doc, quote)
  if (range === null) return null
  return normalizeForMatch(passageText(editor.state.doc, range.from, range.to))
}

describe('locateText (F-14.8)', () => {
  it('finds a quote inside one paragraph and hands back the range that reads it back', () => {
    const range = locateText(editor.state.doc, 'Rain followed.')
    expect(range).toEqual({
      from: FIRST.length + 1 - 'Rain followed.'.length,
      to: FIRST.length + 1
    })
    expect(readBack('Rain followed.')).toBe('Rain followed.')
    expect(readBack('The storm broke at dusk.')).toBe('The storm broke at dusk.')
  })

  it('finds a quote across a paragraph boundary and across a hard break', () => {
    expect(readBack('Rain followed. Tagged #dark-forest after.')).toBe(
      'Rain followed. Tagged #dark-forest after.'
    )
    expect(readBack('One two')).toBe('One two')
  })

  it('matches through curly quotes, line breaks, and doubled spaces in the quote', () => {
    expect(readBack('She said "no" to him.')).toBe('She said "no" to him.')
    expect(readBack('  Rain\n  followed.  ')).toBe('Rain followed.')
  })

  it('is null for an absent quote, an empty one, and one that only looks close', () => {
    expect(locateText(editor.state.doc, 'The lighthouse blinked twice.')).toBeNull()
    expect(locateText(editor.state.doc, '   ')).toBeNull()
    expect(locateText(editor.state.doc, 'Rain fell.')).toBeNull()
  })

  it('covers a whole inline tag token when the quote starts inside it', () => {
    const range = locateText(editor.state.doc, 'dark-forest after.')
    expect(range).not.toBeNull()
    expect(normalizeForMatch(passageText(editor.state.doc, range?.from ?? 0, range?.to ?? 0))).toBe(
      '#dark-forest after.'
    )
  })
})
