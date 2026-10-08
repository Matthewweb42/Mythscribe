import { Node as PmNode, Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import {
  findMentions,
  nameWords,
  paragraphIndexes,
  passageParagraphs,
  type MentionCandidate,
  type MentionRange
} from './mentions'
import type { TiptapNodeT } from './tiptap'

/**
 * The editor's document shape, cut down to what the scan has to count: containers, text, the
 * inline tag atom (F-4.6), the scene break, and a hard break. Every range the scan answers is
 * read back out of a real ProseMirror document built from this schema, so the position
 * arithmetic in `findMentions` is checked against ProseMirror itself and not against itself.
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    sceneBreak: { group: 'block', atom: true },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    inlineTag: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { id: { default: '' }, name: { default: '' } }
    }
  }
})

const character = (name: string): MentionCandidate => ({
  id: `t-${name}`,
  name,
  category: 'character'
})
const tone = (name: string): MentionCandidate => ({ id: `t-${name}`, name, category: 'tone' })

const paragraph = (...text: string[]): TiptapNodeT => ({
  type: 'paragraph',
  content: text.map((value) => ({ type: 'text', text: value }))
})

const docOf = (...blocks: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content: blocks })

/** What each range covers in the real document: the scan's answer as ProseMirror reads it back. */
function surface(doc: TiptapNodeT, ranges: MentionRange[]): string[] {
  const pm = PmNode.fromJSON(schema, doc)
  return ranges.map(([from, to]) => pm.textBetween(from, to))
}

/** The ranges recorded for one candidate, or [] when it was never mentioned. */
function rangesOf(doc: TiptapNodeT, candidates: MentionCandidate[], id: string): MentionRange[] {
  return findMentions(doc, candidates).get(id) ?? []
}

describe('nameWords', () => {
  it('splits a kebab-case name and drops empty parts', () => {
    expect(nameWords('rose-marsh')).toEqual(['rose', 'marsh'])
    expect(nameWords('rose')).toEqual(['rose'])
    expect(nameWords('--')).toEqual([])
  })
})

describe('findMentions', () => {
  it('answers ranges ProseMirror reads back as the name, and hand-counted positions agree', () => {
    const doc = docOf(paragraph('Rose waited.'), paragraph('The storm found Rose again.'))
    const ranges = rangesOf(doc, [character('rose')], 't-rose')
    // The first paragraph opens at 0 and its text starts at 1; its 12 characters and its closing
    // token end it at 14, so the second paragraph's text starts at 15 and "Rose" sits 16 in.
    expect(ranges).toEqual([
      [1, 5],
      [31, 35]
    ])
    expect(surface(doc, ranges)).toEqual(['Rose', 'Rose'])
  })

  it('counts an inline tag token, a scene break, and a hard break as one position each', () => {
    const doc = docOf(
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Tagged ' },
          { type: 'inlineTag', attrs: { id: 't-rose', name: 'rose' } },
          { type: 'text', text: ' then.' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Rose left.' }
        ]
      },
      { type: 'sceneBreak' },
      paragraph('Rose came back.')
    )
    const ranges = rangesOf(doc, [character('rose')], 't-rose')
    expect(surface(doc, ranges)).toEqual(['Rose', 'Rose'])
    // The token is never a mention: it is already an explicit link (F-4.6).
    expect(ranges).toHaveLength(2)
  })

  it('reads a name inside a heading too', () => {
    const doc = docOf(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Rose alone' }] },
      paragraph('She waited.')
    )
    const ranges = rangesOf(doc, [character('rose')], 't-rose')
    expect(surface(doc, ranges)).toEqual(['Rose'])
  })

  it('keeps to whole words', () => {
    const doc = docOf(paragraph('Rosemary held a Rose-coloured cup. Rose. "Rose?"'))
    const ranges = rangesOf(doc, [character('rose')], 't-rose')
    // "Rosemary" is one word; "Rose-coloured" ends the word at the hyphen, which is not a letter.
    expect(surface(doc, ranges)).toEqual(['Rose', 'Rose', 'Rose'])
    // The first hit is the "Rose" of "Rose-coloured" (text starts at 1, the word 16 in), not
    // anything inside "Rosemary".
    expect(ranges[0]).toEqual([17, 21])
  })

  it('takes a character tag only where it reads as a proper noun', () => {
    const doc = docOf(paragraph('The rose opened. Rose did not look. roses everywhere.'))
    expect(surface(doc, rangesOf(doc, [character('rose')], 't-rose'))).toEqual(['Rose'])
  })

  it('matches every other category whatever the case', () => {
    const doc = docOf(paragraph('Rain, then rain, then RAIN.'))
    expect(surface(doc, rangesOf(doc, [tone('rain')], 't-rain'))).toEqual(['Rain', 'rain', 'RAIN'])
  })

  it('matches a multi-word name across the whitespace inside one text node, not across nodes', () => {
    const doc = docOf(
      paragraph('Rose  Marsh came home.'),
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Rose' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Marsh' }
        ]
      },
      paragraph('Rose'),
      paragraph('Marsh')
    )
    const marsh = character('rose-marsh')
    expect(surface(doc, rangesOf(doc, [marsh], marsh.id))).toEqual(['Rose  Marsh'])
  })

  it('gives the longest name the range and leaves nothing of it for a shorter one', () => {
    const rose = character('rose')
    const marsh = character('rose-marsh')
    const doc = docOf(paragraph('Rose Marsh nodded at Rose.'))
    const found = findMentions(doc, [rose, marsh])
    expect(surface(doc, found.get(marsh.id) ?? [])).toEqual(['Rose Marsh'])
    expect(surface(doc, found.get(rose.id) ?? [])).toEqual(['Rose'])
    expect(found.get(rose.id)).toHaveLength(1)
  })

  it('leaves a tag that is never mentioned out of the map altogether', () => {
    const doc = docOf(paragraph('Nobody was there.'))
    const found = findMentions(doc, [character('rose'), tone('rain')])
    expect(found.size).toBe(0)
  })

  it('answers nothing for an empty document, an empty candidate list, or a nameless tag', () => {
    expect(
      findMentions({ type: 'doc', content: [{ type: 'paragraph' }] }, [character('rose')])
    ).toEqual(new Map())
    expect(findMentions(docOf(paragraph('Rose waited.')), []).size).toBe(0)
    expect(findMentions(docOf(paragraph('Rose waited.')), [character('-')]).size).toBe(0)
  })

  it('treats a caseless script as a proper noun, since it cannot say otherwise', () => {
    const doc = docOf(paragraph('さくら waited.'))
    const sakura: MentionCandidate = { id: 't-sakura', name: 'さくら', category: 'character' }
    expect(surface(doc, rangesOf(doc, [sakura], sakura.id))).toEqual(['さくら'])
  })

  it('escapes a name that carries regular-expression characters', () => {
    const doc = docOf(paragraph('The a.b crossing. Then axb.'))
    const odd: MentionCandidate = { id: 't-odd', name: 'a.b', category: 'tone' }
    expect(surface(doc, rangesOf(doc, [odd], odd.id))).toEqual(['a.b'])
  })

  it('counts every alias as a mention of its tag, in document order, under the same rules (F-4.14)', () => {
    const rynna: MentionCandidate = {
      id: 't-rynna',
      name: 'rynna-falsire',
      category: 'character',
      aliases: ['High Crown Falsire', 'Rynna', 'rynna-falsire', '???']
    }
    const doc = docOf(
      paragraph('The High Crown Falsire spoke. Rynna Falsire listened, and Rynna left.'),
      paragraph('A rynna is not her.')
    )
    expect(surface(doc, rangesOf(doc, [rynna], rynna.id))).toEqual([
      'High Crown Falsire',
      'Rynna Falsire',
      'Rynna'
    ])
  })
})

describe('passageParagraphs and paragraphIndexes (F-9.12)', () => {
  const doc = docOf(
    paragraph('Rose came in from the rain.'),
    { type: 'paragraph' },
    { type: 'sceneBreak' },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Later' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'At dusk' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Rose left' },
        { type: 'inlineTag', attrs: { id: 't', name: 'x' } },
        { type: 'text', text: 'quietly.' }
      ]
    }
  )

  it('numbers the text blocks with text in order and skips empty ones and leaves', () => {
    const paragraphs = passageParagraphs(doc)
    expect(paragraphs.map((p) => [p.index, p.text])).toEqual([
      [0, 'Rose came in from the rain.'],
      [1, 'Later'],
      [2, 'At dusk\nRose left quietly.']
    ])
  })

  it('places each block where ProseMirror does', () => {
    const pm = PmNode.fromJSON(schema, doc)
    for (const p of passageParagraphs(doc)) {
      const read = pm.textBetween(p.from, p.to, undefined, (leaf) =>
        leaf.type.name === 'hardBreak' ? '\n' : ' '
      )
      expect(read).toBe(p.text)
    }
  })

  it('answers the paragraph each mention starts in', () => {
    const ranges = rangesOf(doc, [character('rose')], 't-rose')
    expect(surface(doc, ranges)).toEqual(['Rose', 'Rose'])
    expect(paragraphIndexes(passageParagraphs(doc), ranges)).toEqual([0, 2])
    expect(paragraphIndexes(passageParagraphs(doc), [[0, 0]])).toEqual([-1])
  })
})
