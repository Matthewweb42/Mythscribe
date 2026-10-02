import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setSpellChecker } from '@renderer/lib/spellcheck'
import { resetDictionaryStore, useDictionaryStore } from './dictionaryStore'
import { buildExtensions } from './extensions'
import {
  NAME_NEAR_MISS_CLASS,
  resetNameCheck,
  resetNameMenuStore,
  useNameMenuStore
} from './nameCheck'

const TEXT = 'Marra rode the mare past Mara and Zorvath.'

/** The words the fake spellchecker underlines; everything else is a word of the language. */
let misspelled: Set<string>
let editor: Editor
let onUpdate: () => void

/** The bible holds one character, renamed per test: every other fixture row is left out. */
function setEntityNames(...names: string[]): void {
  const [template] = entityFixture
  if (!template) throw new Error('fixture has no entity')
  const byId = Object.fromEntries(
    names.map((name, n) => [`e-${n}`, { ...template, id: `e-${n}`, name }])
  )
  useEntityStore.setState({ byId, ids: Object.keys(byId), loaded: true })
}

/** One tag in the bank, of the fixture's shape. */
function setTag(name: string, category: (typeof tagFixture)[number]['category']): void {
  const [template] = tagFixture
  if (!template) throw new Error('fixture has no tag')
  const tag = { ...template, id: 't-only', name, category }
  useTagStore.setState({ byId: { [tag.id]: tag }, ids: [tag.id], loaded: true })
}

function build(text: string = TEXT): Editor {
  onUpdate = vi.fn()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    onUpdate
  })
  return editor
}

const spans = (): HTMLElement[] =>
  Array.from(editor.view.dom.querySelectorAll<HTMLElement>(`.${NAME_NEAR_MISS_CLASS}`))
/** Each underlined word with the spelling it would be offered. */
const nearMisses = (): [string, string | null][] =>
  spans().map((span) => [span.textContent ?? '', span.getAttribute('data-name')])

/** A right-click on an element of the editor; answers whether the default was prevented. */
function rightClick(target: Element, x = 40, y = 60): boolean {
  return !target.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
  )
}

beforeEach(() => {
  resetEntityStore()
  resetTagStore()
  resetDictionaryStore()
  resetNameMenuStore()
  resetNameCheck()
  misspelled = new Set(['Marra', 'Zorvath', 'Vosss', 'forrest', 'Forrest', 'Marr'])
  setSpellChecker((word) => misspelled.has(word))
  useDictionaryStore.setState({ words: [], notNames: [] })
})
afterEach(() => {
  editor.destroy()
  setSpellChecker(null)
  resetEntityStore()
  resetTagStore()
  resetDictionaryStore()
  resetNameMenuStore()
  resetNameCheck()
})

describe('NameCheck (F-3.14)', () => {
  it('underlines a word near a story name, with the spellchecker turned off under it', () => {
    setEntityNames('Mara Voss')
    build('Marra met Vosss and Mara.')
    expect(nearMisses()).toEqual([
      ['Marra', 'Mara'],
      ['Vosss', 'Voss']
    ])
    expect(spans()[0]?.getAttribute('spellcheck')).toBe('false')
  })

  it('waits until the caret has left the word being typed', () => {
    setEntityNames('Mara')
    build('She saw ')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent('Marra')
    // The caret stands at the end of the word: still being typed.
    expect(nearMisses()).toEqual([])
    editor.commands.insertContent(' ')
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
    // Back at its end, it is being typed again; anywhere else, it is a word of the scene.
    editor.commands.setTextSelection(editor.state.doc.content.size - 2)
    expect(nearMisses()).toEqual([])
    editor.commands.setTextSelection(1)
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
  })

  it('leaves a near word alone when the spellchecker says it is a word', () => {
    setEntityNames('Mara')
    build()
    // "mare" is one letter from "Mara" and a word; "Zorvath" is misspelled and near nothing.
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
    misspelled.delete('Marra')
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More.')
    expect(nearMisses()).toEqual([])
  })

  it('underlines nothing without names, and nothing in notes', () => {
    build()
    expect(nearMisses()).toEqual([])
    editor.destroy()
    setEntityNames('Mara')
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {} }),
      content: `<p>${TEXT}</p>`
    })
    expect(nearMisses()).toEqual([])
  })

  it('takes the names of character, setting, and world tags, in the capitals the word was typed in', () => {
    setTag('dark-forest', 'setting')
    build('The forrest was dark. Forrest paths.')
    expect(nearMisses()).toEqual([
      ['forrest', 'forest'],
      ['Forrest', 'Forest']
    ])
  })

  it('treats any other tag name, a dictionary word, and a dismissed word as fine', () => {
    setEntityNames('Mara', 'Forest')
    setTag('forrest', 'tone')
    build('Marra in the forrest.')
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
    useDictionaryStore.setState({ words: ['Marra'], notNames: [] })
    expect(nearMisses()).toEqual([])
    useDictionaryStore.setState({ words: [], notNames: [] })
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
    useDictionaryStore.setState({ words: [], notNames: ['marra'] })
    expect(nearMisses()).toEqual([])
  })

  it('reads a possessive as its word and skips an inline tag token', () => {
    setEntityNames('Mara')
    build('x')
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Marra’s sword ' },
            { type: 'inlineTag', attrs: { id: 't-gone', name: 'marra' } },
            { type: 'text', text: ' fell.' }
          ]
        }
      ]
    })
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
  })

  it('leaves a word cut in two by a mark alone', () => {
    setEntityNames('Mara')
    build('x')
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Marr', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'a and Marra.' }
          ]
        }
      ]
    })
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
  })

  it('follows the document as the author types', () => {
    setEntityNames('Mara')
    build('Mara waited.')
    expect(nearMisses()).toEqual([])
    editor.commands.insertContentAt(1, 'Marra and ')
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
    editor.commands.deleteRange({ from: 3, to: 4 })
    expect(editor.getText()).toBe('Mara and Mara waited.')
    expect(nearMisses()).toEqual([])
  })

  it('redraws when a name is added, renamed, or removed, without an update or an undo step', () => {
    build()
    expect(nearMisses()).toEqual([])
    const before = editor.getJSON()
    setEntityNames('Mara')
    expect(nearMisses()).toEqual([['Marra', 'Mara']])
    setEntityNames('Zorvat')
    expect(nearMisses()).toEqual([['Zorvath', 'Zorvat']])
    setTag('marta', 'character')
    expect(nearMisses()).toEqual([
      ['Marra', 'Marta'],
      ['Zorvath', 'Zorvat']
    ])
    resetEntityStore()
    resetTagStore()
    expect(nearMisses()).toEqual([])
    // A refresh is not an edit: nothing to autosave (Tiptap's `update`) and nothing to undo.
    expect(onUpdate).not.toHaveBeenCalled()
    expect(editor.can().undo()).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  })

  it('stops listening to the stores when the editor is destroyed', () => {
    build()
    editor.destroy()
    expect(() => setEntityNames('Mara')).not.toThrow()
  })

  describe('the menu', () => {
    it('opens for a right-click on the underlined word and prevents the browser menu', () => {
      setEntityNames('Mara')
      build()
      const [span] = spans()
      if (!span) throw new Error('no near miss')
      expect(rightClick(span, 12, 34)).toBe(true)
      expect(useNameMenuStore.getState().menu).toMatchObject({
        x: 12,
        y: 34,
        word: 'Marra',
        spelling: 'Mara'
      })
    })

    it('stays closed for a right-click anywhere else', () => {
      setEntityNames('Mara')
      build()
      const paragraph = editor.view.dom.querySelector('p')
      if (!paragraph) throw new Error('no paragraph')
      expect(rightClick(paragraph)).toBe(false)
      expect(useNameMenuStore.getState().menu).toBeNull()
    })

    it('replace() rewrites only that word, keeps its marks, and undoes as one step', () => {
      setEntityNames('Mara')
      build('Marra saw Marra.')
      editor.commands.setTextSelection({ from: 11, to: 16 })
      editor.commands.setBold()
      const second = spans()[1]
      if (!second) throw new Error('no second near miss')
      rightClick(second)
      useNameMenuStore.getState().menu?.replace()
      expect(editor.getText()).toBe('Marra saw Mara.')
      expect(editor.getJSON().content?.[0]?.content).toMatchObject([
        { type: 'text', text: 'Marra saw ' },
        { type: 'text', text: 'Mara', marks: [{ type: 'bold' }] },
        { type: 'text', text: '.' }
      ])
      expect(nearMisses()).toEqual([['Marra', 'Mara']])
      expect(onUpdate).toHaveBeenCalled()
      editor.commands.undo()
      expect(editor.getText()).toBe('Marra saw Marra.')
    })

    it('replace() does nothing once the word is no longer there', () => {
      setEntityNames('Mara')
      build('Marra saw.')
      const [span] = spans()
      if (!span) throw new Error('no near miss')
      rightClick(span)
      const replace = useNameMenuStore.getState().menu?.replace
      editor.commands.insertContentAt(1, 'Then ')
      replace?.()
      expect(editor.getText()).toBe('Then Marra saw.')
      editor.destroy()
      expect(() => replace?.()).not.toThrow()
    })
  })
})
