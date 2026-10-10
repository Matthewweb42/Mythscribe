import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_ORIGIN_MARK, aiOriginStats } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  AgentEditError,
  appendBlocks,
  cutFromParagraph,
  insertParagraphs,
  paragraphsFrom,
  removeInsertedProse,
  replacePassage,
  undoInsertParagraphs,
  undoReplacePassage
} from './agentEditing'
import { buildExtensions } from './extensions'

const FIRST = 'The storm broke at dusk.'
const SECOND = 'Mara climbed the ridge alone.'
const THIRD = 'Nobody followed her.'

let editor: Editor

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(node.textContent))
  return out
}

beforeEach(() => {
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: doc(FIRST, SECOND, THIRD)
  })
})
afterEach(() => {
  editor.destroy()
})

describe('the chat agent’s text edits (F-5.22)', () => {
  it('replaces a passage with AI-origin prose, and the undo puts the author’s words back', () => {
    const undo = replacePassage(editor, 'climbed the ridge alone', 'went up the ridge', 'p-1')
    expect(paragraphs()).toEqual([FIRST, 'Mara went up the ridge.', THIRD])
    expect(aiOriginStats(editor.getJSON() as TiptapNodeT).byProposal).toEqual({ 'p-1': 17 })
    undoReplacePassage(editor, undo)
    expect(paragraphs()).toEqual([FIRST, SECOND, THIRD])
    expect(aiOriginStats(editor.getJSON() as TiptapNodeT).aiChars).toBe(0)
  })

  it('cuts a passage, and the undo finds the text before the cut to put it back', () => {
    const undo = replacePassage(editor, 'alone', '', 'p-1')
    expect(paragraphs()[1]).toBe('Mara climbed the ridge.')
    undoReplacePassage(editor, undo)
    expect(paragraphs()).toEqual([FIRST, SECOND, THIRD])
  })

  it('refuses a passage the scene no longer holds, or holds twice', () => {
    expect(() => replacePassage(editor, 'the sea', 'x', 'p-1')).toThrow(AgentEditError)
    editor.commands.setContent(doc('It rained.', 'It rained.'))
    expect(() => replacePassage(editor, 'It rained.', 'x', 'p-1')).toThrow(
      'The passage now occurs more than once'
    )
  })

  it('adds paragraphs after the one holding a passage, or at the end, and takes them out whole', () => {
    const text = insertParagraphs(editor, 'ridge alone', 'The wind rose.\n\nShe kept on.', 'p-2')
    expect(paragraphs()).toEqual([FIRST, SECOND, 'The wind rose.', 'She kept on.', THIRD])
    expect(aiOriginStats(editor.getJSON() as TiptapNodeT).byProposal['p-2']).toBeGreaterThan(0)
    undoInsertParagraphs(editor, text)
    expect(paragraphs()).toEqual([FIRST, SECOND, THIRD])
    insertParagraphs(editor, '', 'The end.', 'p-3')
    expect(paragraphs().at(-1)).toBe('The end.')
  })

  it('splits from the paragraph holding a passage, and appending the cut restores the scene', () => {
    const moved = paragraphsFrom(editor, 'climbed')
    expect((moved.content ?? []).map((block) => block.content?.[0]?.text)).toEqual([SECOND, THIRD])
    expect(paragraphs()).toEqual([FIRST, SECOND, THIRD])
    const cut = cutFromParagraph(editor, 'climbed')
    expect(paragraphs()).toEqual([FIRST])
    appendBlocks(editor, cut)
    expect(paragraphs()).toEqual([FIRST, SECOND, THIRD])
    expect(() => cutFromParagraph(editor, 'The storm')).toThrow(
      'Splitting there would leave the scene empty'
    )
  })
})

describe('removeInsertedProse', () => {
  const marked = (text: string, proposalId: string): TiptapNodeT => ({
    type: 'paragraph',
    content: [
      { type: 'text', text, marks: [{ type: AI_ORIGIN_MARK, attrs: { proposalId, accepted: 1 } }] }
    ]
  })

  it('takes out the copy its proposal marked when the same words sit there twice', () => {
    // Loaded, not set: the AI-origin plugin strips marks no insertion vouched for.
    editor.destroy()
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [
          marked(SECOND, 'p-1'),
          { type: 'paragraph', content: [{ type: 'text', text: FIRST }] },
          marked(SECOND, 'p-2')
        ]
      }
    })
    removeInsertedProse(editor, SECOND, 'p-2')
    expect(paragraphs()).toEqual([SECOND, FIRST])
    expect(aiOriginStats(editor.getJSON()).aiChars).toBe(SECOND.length)
  })

  it('refuses when no single copy is its own', () => {
    editor.commands.setContent(doc(SECOND, FIRST, SECOND))
    expect(() => removeInsertedProse(editor, SECOND, 'p-2')).toThrow(AgentEditError)
    expect(() => removeInsertedProse(editor, SECOND)).toThrow(AgentEditError)
  })
})
