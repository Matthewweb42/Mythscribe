import { describe, expect, it } from 'vitest'
import type { CompiledEntry } from '@shared/compile'
import type { TiptapNodeT } from '@shared/tiptap'
import { bodyBlocks, docBlocks, startsPage, type Run } from './model'

const text = (value: string, marks: string[] = []): TiptapNodeT => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {})
})
const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })
const para = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'paragraph', content })
const run = (value: string, marks: Partial<Run> = {}): Run => ({
  kind: 'text',
  text: value,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  ...marks
})

const entry = (over: Partial<CompiledEntry>): CompiledEntry => ({
  id: 'x',
  kind: 'document',
  level: 'scene',
  depth: 0,
  title: '',
  meta: null,
  tags: [],
  content: null,
  ...over
})

describe('docBlocks (F-12.1)', () => {
  it('reads paragraphs with marks, ignoring the AI-origin mark and paragraph origin', () => {
    const blocks = docBlocks(
      doc({
        type: 'paragraph',
        attrs: { textAlign: 'center', origin: 'import' },
        content: [
          text('Plain '),
          text('bold', ['bold', 'aiOrigin']),
          text(' and '),
          text('all', ['italic', 'underline', 'strike', 'code', 'mystery'])
        ]
      })
    )
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        align: 'center',
        runs: [
          run('Plain '),
          run('bold', { bold: true }),
          run(' and '),
          run('all', { italic: true, underline: true, strike: true, code: true })
        ]
      }
    ])
  })

  it('never prints a tag range (F-4.8): the tagged text reads as the text around it', () => {
    const blocks = docBlocks(
      doc(
        para(
          text('Mara '),
          { type: 'text', text: 'waited', marks: [{ type: 'tagRange', attrs: { tagId: 't-1' } }] },
          {
            type: 'text',
            text: ' long',
            marks: [{ type: 'italic' }, { type: 'tagRange', attrs: { tagId: 't-2' } }]
          }
        )
      )
    )
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        align: null,
        runs: [run('Mara '), run('waited'), run(' long', { italic: true })]
      }
    ])
  })

  it('prints inline tags as their name, keeps hard breaks, and drops empty paragraphs', () => {
    const blocks = docBlocks(
      doc(
        para(),
        para(
          text('Met '),
          { type: 'inlineTag', attrs: { name: 'mara' } },
          { type: 'hardBreak' },
          text('again')
        )
      )
    )
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        align: null,
        runs: [run('Met '), run('mara'), { kind: 'hardBreak' }, run('again')]
      }
    ])
  })

  it('reads headings, quotes, scene breaks, and the content of unknown nodes', () => {
    const blocks = docBlocks(
      doc(
        { type: 'heading', attrs: { level: 3, textAlign: 'bogus' }, content: [text('Late')] },
        { type: 'heading', attrs: { level: 9 }, content: [text('Odd')] },
        { type: 'blockquote', content: [para(text('Quoted'))] },
        { type: 'sceneBreak' },
        { type: 'mysteryBlock', content: [para(text('Inside'))] }
      )
    )
    expect(blocks).toEqual([
      { kind: 'heading', level: 3, align: null, runs: [run('Late')] },
      { kind: 'heading', level: 1, align: null, runs: [run('Odd')] },
      { kind: 'quote', blocks: [{ kind: 'paragraph', align: null, runs: [run('Quoted')] }] },
      { kind: 'sceneBreak' },
      { kind: 'paragraph', align: null, runs: [run('Inside')] }
    ])
  })
})

describe('bodyBlocks (F-12.1)', () => {
  it('prints titles, breaks between scenes, and text, never scene headers', () => {
    const blocks = bodyBlocks([
      entry({ id: 'p', kind: 'folder', level: 'part', title: 'Part One' }),
      entry({ id: 'c', kind: 'folder', level: 'chapter', depth: 1, title: 'Chapter One' }),
      entry({
        id: 's1',
        depth: 2,
        content: doc(para(text('First.'))),
        meta: { location: 'Harbor', pov: '', timeline: '' }
      }),
      entry({ id: 's2', depth: 2, content: doc(para(text('Second.'))) })
    ])
    expect(blocks).toEqual([
      { kind: 'title', level: 'part', text: 'Part One', inPart: false },
      { kind: 'title', level: 'chapter', text: 'Chapter One', inPart: true },
      { kind: 'paragraph', align: null, runs: [run('First.')] },
      { kind: 'sceneBreak' },
      { kind: 'paragraph', align: null, runs: [run('Second.')] }
    ])
  })

  it('titles a scene at chapter level (a prologue) like a chapter; a part-less chapter is top-level', () => {
    const blocks = bodyBlocks([
      entry({ id: 'pro', title: 'Prologue', content: doc(para(text('Before.'))) }),
      entry({ id: 'p', kind: 'folder', level: 'part', title: 'Part One' }),
      entry({ id: 'c1', kind: 'folder', level: 'chapter', depth: 1, title: 'Chapter 1' }),
      entry({ id: 's1', depth: 2, content: doc(para(text('One.'))) }),
      entry({ id: 'i', depth: 1, title: 'Interlude', content: doc(para(text('Between.'))) }),
      entry({ id: 'c2', kind: 'folder', level: 'chapter', title: 'Chapter 2' }),
      entry({ id: 's2', depth: 1, content: doc(para(text('Two.'))) }),
      entry({ id: 's3', depth: 1, content: doc(para(text('Three.'))) })
    ])
    expect(blocks).toEqual([
      { kind: 'title', level: 'chapter', text: 'Prologue', inPart: false },
      { kind: 'paragraph', align: null, runs: [run('Before.')] },
      { kind: 'title', level: 'part', text: 'Part One', inPart: false },
      { kind: 'title', level: 'chapter', text: 'Chapter 1', inPart: true },
      { kind: 'paragraph', align: null, runs: [run('One.')] },
      { kind: 'title', level: 'chapter', text: 'Interlude', inPart: true },
      { kind: 'paragraph', align: null, runs: [run('Between.')] },
      { kind: 'title', level: 'chapter', text: 'Chapter 2', inPart: false },
      { kind: 'paragraph', align: null, runs: [run('Two.')] },
      { kind: 'sceneBreak' },
      { kind: 'paragraph', align: null, runs: [run('Three.')] }
    ])
  })
})

describe('startsPage (F-12.1)', () => {
  const title = { kind: 'title', level: 'chapter', text: 'C', inPart: true } as const
  const pBlock = { kind: 'sceneBreak' } as const
  it('breaks before every unit but the first and before later titles when asked', () => {
    expect(startsPage(0, 0, title, true)).toBe(false)
    expect(startsPage(1, 0, pBlock, false)).toBe(true)
    expect(startsPage(0, 3, title, true)).toBe(true)
    expect(startsPage(0, 3, title, false)).toBe(false)
    expect(startsPage(0, 3, pBlock, true)).toBe(false)
  })
})
