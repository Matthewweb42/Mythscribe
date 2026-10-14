import { describe, expect, it } from 'vitest'
import { INLINE_TAG_NODE_TYPE } from '../inlineTags'
import { TAG_RANGE_MARK } from '../tagRanges'
import type { TiptapNodeT } from '../tiptap'
import {
  containsInlineTag,
  inlineTagSamples,
  inlineTagTokens,
  inlineTagWords,
  replaceInlineTags,
  tagNameAsWords
} from './inlineTagReplace'

const text = (value: string, marks?: TiptapNodeT['marks']): TiptapNodeT =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks }
const token = (id: string, name: string, marks?: TiptapNodeT['marks']): TiptapNodeT => ({
  type: INLINE_TAG_NODE_TYPE,
  attrs: { id, name },
  ...(marks === undefined ? {} : { marks })
})
const paragraph = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'paragraph', content })
const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })

describe('inlineTagWords (F-16.31: one rule for the rewrite and the check)', () => {
  it('takes the trimmed consented words, else the name as words, else nothing', () => {
    const words = new Map([
      ['t-1', '  Mara Vell '],
      ['t-2', '   ']
    ])
    expect(inlineTagWords(token('t-1', 'mara'), words)).toBe('Mara Vell')
    expect(inlineTagWords(token('t-2', 'the--old-mill'), words)).toBe('the old mill')
    expect(inlineTagWords(token('t-3', 'harbour'), words)).toBe('harbour')
    expect(inlineTagWords({ type: INLINE_TAG_NODE_TYPE, attrs: { name: 'no-id' } }, words)).toBe('')
    expect(inlineTagWords(text('plain'), words)).toBe('')
  })
})

describe('replaceInlineTags (F-16.15)', () => {
  it('turns each token into its replacement and joins the text around it', () => {
    const source = doc(paragraph(text('Then '), token('t-1', 'mara'), text(' left.')))
    const out = replaceInlineTags(source, new Map([['t-1', 'Mara']]))
    expect(out.replaced).toBe(1)
    expect(out.doc).toEqual(doc(paragraph(text('Then Mara left.'))))
  })

  it('falls back to the stored name with hyphens as spaces, also for a blank replacement', () => {
    const source = doc(
      paragraph(token('t-1', 'dark-forest'), text(' and '), token('t-2', 'old-mill'))
    )
    const out = replaceInlineTags(source, new Map([['t-2', '   ']]))
    expect(out.doc).toEqual(doc(paragraph(text('dark forest and old mill'))))
    expect(out.replaced).toBe(2)
  })

  it('keeps the token marks on its text and joins only matching neighbours', () => {
    const bold = [{ type: 'bold' }]
    const source = doc(paragraph(text('A ', bold), token('t-1', 'mara', bold), text(' b')), {
      type: 'blockquote',
      content: [paragraph(token('t-1', 'mara'))]
    })
    const out = replaceInlineTags(source, new Map([['t-1', 'Mara Vell']]))
    expect(out.doc).toEqual(
      doc(paragraph(text('A Mara Vell', bold), text(' b')), {
        type: 'blockquote',
        content: [paragraph(text('Mara Vell'))]
      })
    )
  })

  it('leaves range-tag marks and documents without tokens untouched (the same object)', () => {
    const ranged = doc(
      paragraph(text('The storm', [{ type: TAG_RANGE_MARK, attrs: { tagId: 'x' } }]))
    )
    const out = replaceInlineTags(ranged, new Map())
    expect(out.doc).toBe(ranged)
    expect(out.replaced).toBe(0)
  })

  it('drops a malformed token with no id and no name rather than writing empty text', () => {
    const source = doc(paragraph(text('A'), { type: INLINE_TAG_NODE_TYPE, attrs: {} }, text('B')))
    expect(replaceInlineTags(source, new Map()).doc).toEqual(doc(paragraph(text('AB'))))
  })

  it('lists tokens in order and samples the words around the first of each', () => {
    const long = 'word '.repeat(60)
    const source = doc(
      paragraph(text('Then '), token('t-1', 'mara'), text(' left.')),
      paragraph(text(long), token('t-2', 'harbour'), text(` ${long}`)),
      paragraph(token('t-1', 'mara'))
    )
    expect(inlineTagTokens(source).map((t) => t.id)).toEqual(['t-1', 't-2', 't-1'])
    const samples = inlineTagSamples(source)
    expect(samples.get('t-1')).toBe('Then #mara left.')
    const harbour = samples.get('t-2') ?? ''
    expect(harbour).toContain('#harbour')
    expect(harbour.startsWith('…')).toBe(true)
    expect(harbour.endsWith('…')).toBe(true)
    expect(harbour.length).toBeLessThanOrEqual(162)
  })

  it('writes names as words', () => {
    expect(tagNameAsWords('mara--vell')).toBe('mara vell')
  })
})

describe('containsInlineTag (F-16.31)', () => {
  it('finds a token at any depth, well formed or not, and nothing in plain prose', () => {
    expect(containsInlineTag(doc(paragraph(text('Mara walked.'))))).toBe(false)
    expect(containsInlineTag(doc(paragraph(text('With '), token('t1', 'mara'))))).toBe(true)
    const broken: TiptapNodeT = { type: INLINE_TAG_NODE_TYPE }
    expect(containsInlineTag(doc({ type: 'blockquote', content: [paragraph(broken)] }))).toBe(true)
    expect(containsInlineTag(replaceInlineTags(doc(paragraph(broken)), new Map()).doc)).toBe(false)
  })
})
