import { getSchema } from '@tiptap/core'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { countInDoc, replaceInDoc, type ReplaceOptions } from '@shared/replace'
import type { TiptapMarkT, TiptapNodeT } from '@shared/tiptap'
import { buildExtensions } from '@renderer/features/editor/extensions'

/**
 * F-10.2 writes manuscript JSON the editor never produced itself, so everything `replaceInDoc`
 * returns must load in the real manuscript schema (ProseMirror refuses an empty text node and
 * content a block does not allow) and must hold exactly the text a per-run string replace gives.
 * Checked over generated documents: mixed marks, hard breaks, inline tag tokens, nested blocks.
 */
const schema = getSchema(
  buildExtensions({
    sceneBreak: '* * *',
    onSave: () => undefined,
    onEscape: () => false,
    inlineTagNodeId: 'n1'
  })
)

/** A small deterministic generator (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MARKS: TiptapMarkT[][] = [[], [{ type: 'bold' }], [{ type: 'italic' }]]
const TOKEN: TiptapNodeT = { type: 'inlineTag', attrs: { id: 't-1', name: 'rose' } }
const BREAK: TiptapNodeT = { type: 'hardBreak' }
// `İ` lowercases to two code units, the emoji is a surrogate pair, `’` folds to a straight quote.
const ALPHABET = ['a', 'a', 'b', 'b', 'A', 'B', ' ', 'İ', '😀', '’']

function randomDoc(next: () => number): TiptapNodeT {
  const pick = <T>(from: readonly T[]): T => {
    const value = from[Math.floor(next() * from.length)]
    if (value === undefined) throw new Error('empty choice')
    return value
  }
  const textNode = (): TiptapNodeT => {
    const length = 1 + Math.floor(next() * 5)
    let value = ''
    for (let i = 0; i < length; i++) value += pick(ALPHABET)
    const marks = pick(MARKS)
    return marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value }
  }
  const inline = (): TiptapNodeT[] => {
    const out: TiptapNodeT[] = []
    const length = Math.floor(next() * 7)
    for (let i = 0; i < length; i++) {
      const roll = next()
      out.push(roll < 0.1 ? TOKEN : roll < 0.2 ? BREAK : textNode())
    }
    return out
  }
  const textblock = (type: 'paragraph' | 'heading'): TiptapNodeT => {
    const content = inline()
    const base: TiptapNodeT = type === 'heading' ? { type, attrs: { level: 2 } } : { type }
    return content.length > 0 ? { ...base, content } : base
  }
  const blocks: TiptapNodeT[] = []
  const count = 1 + Math.floor(next() * 4)
  for (let i = 0; i < count; i++) {
    const roll = next()
    if (roll < 0.15) blocks.push({ type: 'blockquote', content: [textblock('paragraph')] })
    else blocks.push(textblock(roll < 0.3 ? 'heading' : 'paragraph'))
  }
  return { type: 'doc', content: blocks }
}

/** The document's text with every non-text node and block edge as a separator no query holds. */
function flat(node: TiptapNodeT): string {
  if (node.text !== undefined) return node.text
  return `\u0001${(node.content ?? []).map(flat).join('')}\u0001`
}

/** No empty text node anywhere, and no block left with an empty `content` array. */
function wellFormed(node: TiptapNodeT): boolean {
  if (node.text !== undefined) return node.text.length > 0
  if (node.content === undefined) return true
  return node.content.length > 0 && node.content.every(wellFormed)
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('replaceInDoc against the manuscript schema (F-10.2)', () => {
  it('has the node and mark types the generated documents use', () => {
    expect(Object.keys(schema.nodes)).toEqual(
      expect.arrayContaining(['paragraph', 'heading', 'blockquote', 'hardBreak', 'inlineTag'])
    )
    expect(Object.keys(schema.marks)).toEqual(expect.arrayContaining(['bold', 'italic']))
  })

  it('always returns a document ProseMirror accepts, holding the text a per-run replace gives', () => {
    const next = prng(20261001)
    const queries = ['a', 'ab', 'aa', 'b a', ' ', 'ba', 'aab']
    const replacements = ['', 'a', 'aa', 'X', 'ab ab', ' ']
    let replaced = 0
    for (let round = 0; round < 1500; round++) {
      const input = randomDoc(next)
      const before = JSON.stringify(input)
      const query = queries[round % queries.length] ?? 'a'
      const replacement = replacements[Math.floor(next() * replacements.length)] ?? ''
      const options: ReplaceOptions = { query, replacement, matchCase: true, wholeWord: false }

      const { doc, count } = replaceInDoc(input, options)
      replaced += count

      // The input is never touched, and the count is the one the preview shows.
      expect(JSON.stringify(input)).toBe(before)
      expect(count).toBe(countInDoc(input, options))
      if (count === 0) expect(doc).toBe(input)
      // Exactly the text of a left-to-right, non-overlapping replace inside each run.
      expect(flat(doc)).toBe(flat(input).split(query).join(replacement))
      // Storable: no empty text node, and the editor's schema loads it.
      expect(wellFormed(doc)).toBe(true)
      expect(() => ProseMirrorNode.fromJSON(schema, doc).check()).not.toThrow()
      // Tokens and breaks are all still there, in place.
      const atoms = (value: TiptapNodeT): number =>
        (value.type === 'inlineTag' || value.type === 'hardBreak' ? 1 : 0) +
        (value.content ?? []).reduce((sum, child) => sum + atoms(child), 0)
      expect(atoms(doc)).toBe(atoms(input))
    }
    // The generator really exercised the replace.
    expect(replaced).toBeGreaterThan(1000)
  })

  it('matches without case at the right offsets beside characters whose lowercase is longer', () => {
    const next = prng(7)
    for (let round = 0; round < 500; round++) {
      const input = randomDoc(next)
      const query = round % 2 === 0 ? 'ab' : 'A'
      const options: ReplaceOptions = {
        query,
        replacement: '#',
        matchCase: false,
        wholeWord: false
      }
      const { doc } = replaceInDoc(input, options)
      expect(flat(doc)).toBe(flat(input).replace(new RegExp(escapeRegExp(query), 'gi'), '#'))
      expect(() => ProseMirrorNode.fromJSON(schema, doc).check()).not.toThrow()
    }
  })

  it('whole word never replaces inside a longer word, whatever the node boundaries', () => {
    const next = prng(99)
    for (let round = 0; round < 500; round++) {
      const input = randomDoc(next)
      const options: ReplaceOptions = {
        query: 'ab',
        replacement: '#',
        matchCase: true,
        wholeWord: true
      }
      const { doc } = replaceInDoc(input, options)
      const expected = flat(input).replace(/(?<![\p{L}\p{M}\p{N}_])ab(?![\p{L}\p{M}\p{N}_])/gu, '#')
      expect(flat(doc)).toBe(expected)
    }
  })

  it('survives a stored empty text node and leaves none behind in a run it rewrites', () => {
    const input: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'fo' },
            { type: 'text', text: '', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'o bar' }
          ]
        }
      ]
    }
    const { doc, count } = replaceInDoc(input, {
      query: 'foo',
      replacement: 'x',
      matchCase: true,
      wholeWord: false
    })
    expect(count).toBe(1)
    expect(doc).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          // Two nodes, one per source node: adjacent nodes with the same marks need not be merged.
          content: [
            { type: 'text', text: 'x' },
            { type: 'text', text: ' bar' }
          ]
        }
      ]
    })
    expect(() => ProseMirrorNode.fromJSON(schema, doc).check()).not.toThrow()
  })

  it('a paragraph of differently marked nodes deleted whole is stored as an empty paragraph', () => {
    const input: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: 'center' },
          content: [
            { type: 'text', text: 'go' },
            { type: 'text', text: 'ne', marks: [{ type: 'bold' }] },
            { type: 'text', text: '!', marks: [{ type: 'italic' }] }
          ]
        }
      ]
    }
    const { doc } = replaceInDoc(input, {
      query: 'gone!',
      replacement: '',
      matchCase: true,
      wholeWord: false
    })
    expect(doc).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { textAlign: 'center' } }]
    })
    expect(() => ProseMirrorNode.fromJSON(schema, doc).check()).not.toThrow()
  })
})
