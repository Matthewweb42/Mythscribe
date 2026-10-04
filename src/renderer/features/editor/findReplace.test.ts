import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FindOptions } from '@shared/findInDocument'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions } from './extensions'
import { FIND_MATCH_CLASS, FIND_MATCH_CURRENT_CLASS, findStateOf } from './findReplace'

let editor: Editor

const find = (query: string, patch: Partial<FindOptions> = {}): FindOptions => ({
  query,
  matchCase: false,
  wholeWord: false,
  regex: false,
  ...patch
})

beforeEach(() => {
  resetTagStore()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The cat ' },
            { type: 'text', text: 'sat', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' with a cat.' }
          ]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ca' },
            { type: 'inlineTag', attrs: { id: 't1', name: 'cat' } },
            { type: 'text', text: 't and ca' },
            { type: 'hardBreak' },
            { type: 'text', text: 't. Cat!' }
          ]
        }
      ]
    }
  })
})
afterEach(() => {
  editor.destroy()
})

const texts = (selector: string): string[] =>
  Array.from(editor.view.dom.querySelectorAll(selector)).map((el) => el.textContent ?? '')
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}
const matchTexts = (): string[] =>
  findStateOf(editor.state).matches.map(({ from, to }) => editor.state.doc.textBetween(from, to))

describe('FindReplace (F-3.10)', () => {
  it('starts empty and highlights every match within a run, across marks', () => {
    expect(findStateOf(editor.state).matches).toEqual([])
    editor.commands.setFind(find('cat sat'))
    expect(matchTexts()).toEqual(['cat sat'])
    expect(texts(`.${FIND_MATCH_CLASS}`).join('')).toBe('cat sat')
  })

  it('never matches across an inline tag token, a hard break, or a block boundary', () => {
    editor.commands.setFind(find('cat'))
    // "ca#cat t" and "ca<br>t" are not matches; "Cat" matches case-insensitively.
    expect(matchTexts()).toEqual(['cat', 'cat', 'Cat'])
    editor.commands.setFind(find('cat', { matchCase: true }))
    expect(matchTexts()).toEqual(['cat', 'cat'])
  })

  it('marks the first match at or after the anchor as current, wrapping', () => {
    editor.commands.setFind(find('cat'), 10)
    expect(findStateOf(editor.state).current).toBe(1)
    expect(texts(`.${FIND_MATCH_CURRENT_CLASS}`)).toEqual(['cat'])
    editor.commands.setFind(find('cat'), editor.state.doc.content.size)
    expect(findStateOf(editor.state).current).toBe(0)
  })

  it('steps forward and back with wrapping and selects the current match', () => {
    editor.commands.setFind(find('cat'), 0)
    expect(editor.commands.findStep(1)).toBe(true)
    const { matches } = findStateOf(editor.state)
    let { current } = findStateOf(editor.state)
    expect(current).toBe(1)
    expect(editor.state.selection.from).toBe(matches[1]?.from)
    expect(editor.state.selection.to).toBe(matches[1]?.to)
    editor.commands.findStep(1)
    editor.commands.findStep(1)
    ;({ current } = findStateOf(editor.state))
    expect(current).toBe(0)
    editor.commands.findStep(-1)
    ;({ current } = findStateOf(editor.state))
    expect(current).toBe(2)
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
    ).toBe('Cat')
  })

  it('reports an invalid pattern and highlights nothing', () => {
    editor.commands.setFind(find('(', { regex: true }))
    expect(findStateOf(editor.state)).toMatchObject({ error: 'Invalid pattern', matches: [] })
    expect(texts(`.${FIND_MATCH_CLASS}`)).toEqual([])
    expect(editor.commands.findStep(1)).toBe(false)
  })

  it('clears with null options', () => {
    editor.commands.setFind(find('cat'))
    editor.commands.setFind(null)
    expect(findStateOf(editor.state)).toMatchObject({ options: null, matches: [], current: -1 })
    expect(texts(`.${FIND_MATCH_CLASS}`)).toEqual([])
  })

  it('recomputes after an edit and keeps current where it was', () => {
    editor.commands.setFind(find('cat'), 10)
    const before = findStateOf(editor.state).matches[1]?.from ?? -1
    editor.commands.insertContentAt(1, 'A cat. ')
    const { matches, current } = findStateOf(editor.state)
    expect(matches).toHaveLength(4)
    expect(matches[current]?.from).toBe(before + 'A cat. '.length)
  })

  it('replaces the current match, keeping its marks, and moves current past it', () => {
    editor.commands.setFind(find('cat'), 0)
    expect(editor.commands.replaceMatch('cats')).toBe(true)
    expect(paragraphs()[0]).toBe('The cats sat with a cat.')
    const { matches, current } = findStateOf(editor.state)
    // The replacement holds the query but is passed over.
    expect(current).toBe(1)
    expect(matches[current]?.from).toBeGreaterThan(5)
  })

  it('replaces all in one transaction that undoes in one step; empty deletes', () => {
    editor.commands.setFind(find('cat', { wholeWord: true }))
    expect(editor.commands.replaceAllMatches('dog')).toBe(true)
    expect(paragraphs()).toEqual(['The dog sat with a dog.', 'cat and cat. dog!'])
    expect(findStateOf(editor.state).matches).toEqual([])
    editor.commands.undo()
    expect(paragraphs()[0]).toBe('The cat sat with a cat.')
    editor.commands.setFind(find(' sat'))
    editor.commands.replaceAllMatches('')
    expect(paragraphs()[0]).toBe('The cat with a cat.')
  })

  it('takes the marks at the match start for the replacement', () => {
    editor.commands.setFind(find('sat'))
    editor.commands.replaceAllMatches('stood')
    const json = JSON.stringify(editor.getJSON())
    expect(json).toContain('{"type":"text","marks":[{"type":"bold"}],"text":"stood"}')
  })

  it('expands captures in regex mode only', () => {
    editor.commands.setFind(find('(\\w+) (cat)', { regex: true }))
    editor.commands.replaceAllMatches('$2 $1')
    expect(paragraphs()[0]).toBe('cat The sat with cat a.')
    editor.commands.setFind(find('sat'))
    editor.commands.replaceAllMatches('$1')
    expect(paragraphs()[0]).toBe('cat The $1 with cat a.')
  })

  it('does nothing without a match', () => {
    editor.commands.setFind(find('zebra'))
    expect(editor.commands.replaceMatch('x')).toBe(false)
    expect(editor.commands.replaceAllMatches('x')).toBe(false)
  })
})
