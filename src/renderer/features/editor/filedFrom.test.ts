import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_FILED_ATTR, AI_WRITTEN_ATTR } from '@shared/memory/pageMarks'
import { buildPageExtensions } from './extensions'
import { filedFromLabel, writtenLabel } from './filedFrom'

/**
 * F-16.9: a Pinned paragraph filed from a Research page shows where it came from, as a label after
 * its words that is never part of the text, and loses it with the mark.
 */

const FILED = { doc: 'r-bestiary', para: 3, quote: 'Mara Vell has grey eyes' }

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('the Filed from label (F-16.9)', () => {
  it('names the page and its paragraph, or says the page is gone', () => {
    expect(filedFromLabel(FILED, 'Bestiary')).toBe('Filed from “Bestiary” ¶4')
    expect(filedFromLabel(FILED, null)).toBe('Filed from a Research page that is gone')
  })

  it('shows after a filed paragraph only, outside the text, with the quote on hover', () => {
    const element = document.createElement('div')
    editor = new Editor({
      element,
      extensions: buildPageExtensions({
        sceneBreak: '* * *',
        onSave: () => undefined,
        filedTitle: (id) => (id === 'r-bestiary' ? 'Bestiary' : null)
      }),
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { [AI_FILED_ATTR]: FILED },
            content: [{ type: 'text', text: 'Eyes: grey' }]
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'Her own line.' }] }
        ]
      }
    })
    const labels = element.querySelectorAll('[data-testid="filed-from"]')
    expect([...labels].map((label) => label.textContent)).toEqual(['Filed from “Bestiary” ¶4'])
    expect(labels[0]?.getAttribute('title')).toBe('“Mara Vell has grey eyes”')
    expect(editor.getText()).toBe('Eyes: grey\n\nHer own line.')
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(0, AI_FILED_ATTR, null)
      return true
    })
    expect(element.querySelectorAll('[data-testid="filed-from"]')).toHaveLength(0)
  })
})

describe('the Written from the chat label (F-16.26)', () => {
  it('names the day, and says only "Written from the chat" without one it can read', () => {
    expect(writtenLabel({ turn: 'r-1', date: '2026-10-13' })).toBe('Written from the chat, 13 Oct')
    expect(writtenLabel({ turn: 'r-1', date: 'someday' })).toBe('Written from the chat')
  })

  it('shows after a line Ms Scribe wrote, outside the text, and goes with the mark', () => {
    const element = document.createElement('div')
    editor = new Editor({
      element,
      extensions: buildPageExtensions({
        sceneBreak: '* * *',
        onSave: () => undefined,
        filedTitle: () => null
      }),
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Her own line.' }] },
          {
            type: 'paragraph',
            attrs: { [AI_WRITTEN_ATTR]: { turn: 'r-1', date: '2026-10-13' } },
            content: [{ type: 'text', text: 'Hates the sea' }]
          }
        ]
      }
    })
    const labels = element.querySelectorAll('[data-testid="written-from-chat"]')
    expect([...labels].map((label) => label.textContent)).toEqual(['Written from the chat, 13 Oct'])
    expect(editor.getText()).toBe('Her own line.\n\nHates the sea')
    editor.commands.command(({ tr }) => {
      tr.setNodeAttribute(tr.doc.child(0).nodeSize, AI_WRITTEN_ATTR, null)
      return true
    })
    expect(element.querySelectorAll('[data-testid="written-from-chat"]')).toHaveLength(0)
  })
})
