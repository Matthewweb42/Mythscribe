import { describe, expect, it } from 'vitest'
import { defaultExportFormatting, type ExportOptions } from '@shared/bookExport'
import { defaultBookDetails } from '@shared/bookDetails'
import { compileBook, type CompileNode } from '@shared/compileModel'
import type { TiptapNodeT } from '@shared/tiptap'
import { legacyCompileFormat, legacyUnits, startsPage, type Run } from './model'

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

const node = (over: Partial<CompileNode>): CompileNode => ({
  id: 'x',
  kind: 'document',
  level: 'scene',
  depth: 0,
  title: '',
  meta: null,
  tags: [],
  content: null,
  synopsis: '',
  notes: null,
  ...over
})

const options = (over: Partial<ExportOptions> = {}): ExportOptions => ({
  format: 'md',
  scope: { kind: 'manuscript' },
  includeFront: true,
  includeEnd: true,
  formatting: defaultExportFormatting('* * *'),
  ...over
})

function units(
  manuscript: CompileNode[],
  front: CompileNode[] = [],
  end: CompileNode[] = [],
  opts: ExportOptions = options()
): ReturnType<typeof legacyUnits> {
  const book = compileBook({
    source: { front, manuscript, end },
    format: legacyCompileFormat(opts),
    output: opts.format,
    details: defaultBookDetails(),
    projectName: 'Book',
    scope: opts.scope,
    excluded: []
  })
  return legacyUnits(book, 'Book')
}

describe('legacyUnits over the compile model (F-12.1 on Compile v2)', () => {
  it('prints titles, breaks between scenes, and text, never scene headers or marks beyond five', () => {
    const result = units([
      node({ id: 'p', kind: 'folder', level: 'part', title: 'Part One' }),
      node({ id: 'c', kind: 'folder', level: 'chapter', depth: 1, title: 'Chapter One' }),
      node({
        id: 's1',
        depth: 2,
        content: doc(
          para(text('First '), text('bold', ['bold', 'aiOrigin']), text('.', ['tagRange']))
        ),
        meta: { location: 'Harbor', pov: '', timeline: '' }
      }),
      node({ id: 's2', depth: 2, content: doc(para(text('Second.'))) })
    ])
    expect(result).toEqual([
      {
        kind: 'body',
        title: 'Book',
        blocks: [
          { kind: 'title', level: 'part', text: 'Part One', inPart: false },
          { kind: 'title', level: 'chapter', text: 'Chapter One', inPart: true },
          {
            kind: 'paragraph',
            align: null,
            runs: [run('First '), run('bold', { bold: true }), run('.')]
          },
          { kind: 'sceneBreak' },
          { kind: 'paragraph', align: null, runs: [run('Second.')] }
        ]
      }
    ])
  })

  it('titles a scene at chapter level (a prologue) like a chapter; a part-less chapter is top-level', () => {
    const [body] = units([
      node({ id: 'pro', title: 'Prologue', content: doc(para(text('Before.'))) }),
      node({ id: 'p', kind: 'folder', level: 'part', title: 'Part One' }),
      node({ id: 'c1', kind: 'folder', level: 'chapter', depth: 1, title: 'Chapter 1' }),
      node({ id: 's1', depth: 2, content: doc(para(text('One.'))) }),
      node({ id: 'i', depth: 1, title: 'Interlude', content: doc(para(text('Between.'))) }),
      node({ id: 'c2', kind: 'folder', level: 'chapter', title: 'Chapter 2' }),
      node({ id: 's2', depth: 1, content: doc(para(text('Two.'))) }),
      node({ id: 's3', depth: 1, content: doc(para(text('Three.'))) })
    ])
    expect(body?.blocks).toEqual([
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

  it('maps quotes, headings, and in-document breaks; matter units wrap the body', () => {
    const result = units(
      [
        node({
          id: 's',
          content: doc(
            { type: 'heading', attrs: { level: 2 }, content: [text('Late')] },
            { type: 'blockquote', content: [para(text('Quoted'))] },
            { type: 'sceneBreak' },
            para(text('After'))
          )
        })
      ],
      [node({ id: 'f', level: null, title: 'Dedication', content: doc(para(text('For M.'))) })],
      [node({ id: 'e', level: null, title: 'Afterword', content: doc(para(text('Thanks.'))) })],
      options()
    )
    expect(result.map((u) => [u.kind, u.title])).toEqual([
      ['matter', 'Dedication'],
      ['body', 'Book'],
      ['matter', 'Afterword']
    ])
    // An untitled chapter-level scene prints no title at all.
    expect(result[1]?.blocks).toEqual([
      { kind: 'heading', level: 2, align: null, runs: [run('Late')] },
      { kind: 'quote', blocks: [{ kind: 'paragraph', align: null, runs: [run('Quoted')] }] },
      { kind: 'sceneBreak' },
      { kind: 'paragraph', align: null, runs: [run('After')] }
    ])
  })

  it('leaves the body out when it prints no word, and matter out when not asked', () => {
    const result = units(
      [node({ id: 'c', kind: 'folder', level: 'chapter', title: 'Chapter 1' })],
      [node({ id: 'f', level: null, title: 'Dedication', content: doc(para(text('For M.'))) })],
      [],
      options({ includeFront: false })
    )
    expect(result).toEqual([])
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
