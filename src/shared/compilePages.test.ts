import { describe, expect, it } from 'vitest'
import { BookDetails } from './bookDetails'
import { BUILTIN_COMPILE_FORMATS, type CompileFormat } from './compileFormat'
import { compileBook, type CompiledBook, type CompileNode } from './compileModel'
import { hasSides, itemBreak, pageRuns } from './compilePages'
import type { TiptapNodeT } from './tiptap'

const words = (value: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }]
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

function builtin(id: string): CompileFormat {
  const format = BUILTIN_COMPILE_FORMATS.find((f) => f.id === `builtin:${id}`)
  if (!format) throw new Error(`no ${id}`)
  return structuredClone(format)
}

function book(format: CompileFormat): CompiledBook {
  return compileBook({
    source: {
      front: [node({ id: 'fw', title: 'Foreword', content: words('First.') })],
      manuscript: [
        node({ id: 'c1', kind: 'folder', level: 'chapter', title: 'One' }),
        node({ id: 's1', depth: 1, content: words('Rain.') }),
        node({ id: 's2', depth: 1, content: words('More.') }),
        node({ id: 'c2', kind: 'folder', level: 'chapter', title: 'Two' }),
        node({ id: 's3', depth: 1, content: words('Calm.') })
      ],
      end: []
    },
    format,
    output: 'pdf',
    details: BookDetails.parse({ title: 'T', author: 'A B', dedication: 'For C.' }),
    projectName: 'P',
    scope: { kind: 'manuscript' },
    excluded: []
  })
}

describe('pageRuns (Compile v2)', () => {
  it('runs a paperback: bare front pages, recto starts, bare openers, numbering from the body', () => {
    const b = book(builtin('paperback-6x9'))
    const runs = pageRuns(b).map((r) => ({
      kind: b.items[r.start]?.kind,
      how: r.how,
      front: r.front,
      bareFirst: r.bareFirst,
      restart: r.restartNumbering,
      head: r.runningHead
    }))
    expect(runs).toEqual([
      { kind: 'page', how: 'first', front: true, bareFirst: false, restart: false, head: '' },
      { kind: 'page', how: 'newPage', front: true, bareFirst: false, restart: false, head: '' },
      { kind: 'page', how: 'newRecto', front: true, bareFirst: false, restart: false, head: '' },
      { kind: 'matter', how: 'newPage', front: true, bareFirst: false, restart: false, head: '' },
      // The first chapter is forced onto a recto as page 1.
      {
        kind: 'section',
        how: 'newRecto',
        front: false,
        bareFirst: true,
        restart: true,
        head: 'One'
      },
      {
        kind: 'section',
        how: 'newPage',
        front: false,
        bareFirst: true,
        restart: false,
        head: 'Two'
      }
    ])
    expect(hasSides(b.format)).toBe(true)
  })

  it('keeps a recto a plain new page when the book has no sides, and openers furnished', () => {
    const format = builtin('standard-manuscript')
    format.sections.chapter.pageBreak = 'newRecto'
    const b = book(format)
    expect(hasSides(format)).toBe(false)
    const runs = pageRuns(b)
    expect(runs.every((r) => r.how !== 'newRecto')).toBe(true)
    expect(runs.some((r) => r.bareFirst)).toBe(false)
    // Every run ends where the next starts; the last at the end.
    runs.forEach((r, i) => expect(r.end).toBe(runs[i + 1]?.start ?? b.items.length))
  })

  it('starts a run at the body even when its first item flows', () => {
    const format = builtin('plain-text')
    format.matter.frontMatter = true
    const b = book(format)
    const bodyStart = b.items.findIndex((i) => i.division === 'body')
    const first = b.items[bodyStart]
    if (!first) throw new Error('no body')
    expect(itemBreak(first)).toBe('none')
    expect(pageRuns(b).find((r) => r.start === bodyStart)?.restartNumbering).toBe(true)
  })
})
