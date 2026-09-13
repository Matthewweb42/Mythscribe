import { describe, expect, it } from 'vitest'
import { docToText } from './docText'
import { EMPTY_DOC, type TiptapNodeT } from './tiptap'

const paragraph = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'paragraph', content })
const text = (t: string): TiptapNodeT => ({ type: 'text', text: t })

describe('docToText (F-4.7)', () => {
  it('returns a plain paragraph as its text and the empty document as an empty string', () => {
    expect(docToText({ type: 'doc', content: [paragraph(text('The storm broke.'))] })).toBe(
      'The storm broke.'
    )
    expect(docToText(EMPTY_DOC)).toBe('')
  })

  it('joins blocks with newlines and inline leaves without a separator, marks ignored', () => {
    expect(
      docToText({
        type: 'doc',
        content: [
          paragraph(text('Rain '), { type: 'text', text: 'followed.', marks: [{ type: 'bold' }] }),
          { type: 'sceneBreak' },
          { type: 'heading', attrs: { level: 1 }, content: [text('Then silence.')] }
        ]
      })
    ).toBe('Rain followed.\n\nThen silence.')
  })

  it('renders an inline tag token as #name, and as nothing when its name is not a string', () => {
    expect(
      docToText({
        type: 'doc',
        content: [
          paragraph(
            text('At the '),
            { type: 'inlineTag', attrs: { id: 't-1', name: 'dark-forest' } },
            text(' at dusk')
          ),
          paragraph({ type: 'inlineTag', attrs: { id: 't-2' } }, text('x')),
          paragraph({ type: 'inlineTag', attrs: { id: 't-3', name: 7 } })
        ]
      })
    ).toBe('At the #dark-forest at dusk\nx\n')
  })
})
