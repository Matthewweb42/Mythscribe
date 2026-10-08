import { describe, expect, it } from 'vitest'
import { BookDetails } from '@shared/bookDetails'
import { BUILTIN_COMPILE_FORMATS, type CompileFormat } from '@shared/compileFormat'
import { compileBook, type CompiledBook, type CompileNode } from '@shared/compileModel'
import type { TreeNode } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex } from '@renderer/features/manuscript/treeStore'
import {
  chapterGroups,
  formatProblem,
  includeRows,
  itemWords,
  previewBook,
  previewIsWhole,
  previewStarts,
  replacementError,
  resolveScope
} from './compileContents'

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }))
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

/** Three chapters of one scene each, `words` words a scene. */
function book(words: number, format = builtin('paperback-6x9')): CompiledBook {
  const text = Array.from({ length: words }, () => 'word').join(' ')
  return compileBook({
    source: {
      front: [],
      manuscript: [1, 2, 3].flatMap((n) => [
        node({ id: `c${n}`, kind: 'folder', level: 'chapter', title: `Part of ${n}` }),
        node({ id: `s${n}`, depth: 1, content: doc(text) })
      ]),
      end: []
    },
    format,
    output: 'pdf',
    details: BookDetails.parse({ title: 'Salt Road', author: 'Ada Marlowe' }),
    projectName: 'P',
    scope: { kind: 'manuscript' },
    excluded: []
  })
}

describe('chapterGroups (F-12.4 quick pick)', () => {
  it('lists the manuscript’s chapters in reading order under their parts', () => {
    expect(
      chapterGroups(buildIndex(treeFixture)).map((g) => [g.partTitle, g.chapters.length])
    ).toEqual([
      ['Arc 1', 3],
      ['Arc 2', 3]
    ])
  })

  it('lists a scene at chapter level like a chapter and looks through generic folders', () => {
    const scene = treeFixture.find((n) => n.id === 'sc-1')
    const chapter = treeFixture.find((n) => n.id === 'ch-1')
    if (!scene || !chapter) throw new Error('fixture changed')
    const extra: TreeNode[] = [
      { ...scene, id: 'prologue', parentId: 'manuscript', position: -1, title: 'Prologue' },
      { ...chapter, id: 'box', parentId: 'manuscript', position: 6, hierarchyLevel: null },
      { ...chapter, id: 'boxed', parentId: 'box', position: 0, title: 'Boxed' }
    ]
    const groups = chapterGroups(buildIndex([...treeFixture, ...extra]))
    expect(groups[0]?.chapters).toEqual([{ id: 'prologue', title: 'Prologue' }])
    expect(groups.at(-1)?.chapters).toEqual([{ id: 'boxed', title: 'Boxed' }])
  })

  it('answers no groups without a manuscript section', () => {
    expect(chapterGroups({ byId: {}, childrenOf: {}, rootIds: [] })).toEqual([])
  })
})

describe('resolveScope', () => {
  const context = { chapterIds: new Set(['ch-1', 'ch-2']), openDocumentId: 'sc-1' }

  it('makes each quick pick, or null while it cannot run', () => {
    expect(resolveScope('manuscript', [], context)).toEqual({ kind: 'manuscript' })
    expect(resolveScope('chapters', ['ch-2', 'gone'], context)).toEqual({
      kind: 'chapters',
      ids: ['ch-2']
    })
    expect(resolveScope('chapters', ['gone'], context)).toBeNull()
    expect(resolveScope('document', [], context)).toEqual({ kind: 'document', id: 'sc-1' })
    expect(resolveScope('document', [], { ...context, openDocumentId: null })).toBeNull()
  })
})

describe('includeRows', () => {
  it('lists every node in tree order and marks what an unticked folder leaves out', () => {
    const rows = includeRows(buildIndex(treeFixture), new Set(['arc-2', 'sc-1']))
    expect(rows.map((r) => r.title).slice(0, 5)).toEqual([
      'front',
      'Title Page',
      'manuscript',
      'Arc 1',
      'Chapter 1'
    ])
    const byTitle = (title: string) => rows.find((r) => r.title === title)
    expect(byTitle('front')).toMatchObject({ kind: 'section', depth: 0 })
    expect(byTitle('Scene 1')).toMatchObject({ excluded: true, excludedAbove: false, depth: 3 })
    expect(byTitle('Arc 2')).toMatchObject({ excluded: true, excludedAbove: false })
    expect(byTitle('Chapter 4')).toMatchObject({ excluded: false, excludedAbove: true })
    expect(byTitle('Scene 4')).toMatchObject({ kind: 'document', excludedAbove: true })
  })
})

describe('the preview window', () => {
  it('starts at the beginning or at any page run with a name', () => {
    const b = book(10)
    const starts = previewStarts(b)
    expect(starts[0]).toEqual({ item: 0, label: 'Beginning' })
    expect(starts.map((s) => s.label)).toContain('Chapter Two: Part of 2')
    for (const start of starts.slice(1)) expect(b.items[start.item]).toBeDefined()
  })

  it('lays out about the word budget from the start, the crossing item whole', () => {
    const b = book(1000)
    const all = previewBook(b, 0, 100_000)
    expect(previewIsWhole(b, all)).toBe(true)
    const window = previewBook(b, 0, 1500)
    expect(previewIsWhole(b, window)).toBe(false)
    expect(window.items.reduce((sum, item) => sum + itemWords(item), 0)).toBe(2000)
    const from = previewStarts(b).find((s) => s.label.startsWith('Chapter Three'))
    if (!from) throw new Error('no chapter three start')
    const tail = previewBook(b, from.item, 10)
    expect(tail.items[0]).toBe(b.items[from.item])
    expect(tail.metadata).toBe(b.metadata)
  })

  it('counts the words an item prints', () => {
    const b = book(7)
    const text = b.items.find((item) => item.kind === 'text')
    const section = b.items.find((item) => item.kind === 'section')
    if (!text || !section) throw new Error('book changed')
    expect(itemWords(text)).toBe(7)
    expect(itemWords(section)).toBe(0)
  })
})

describe('format checks', () => {
  it('names the first invalid setting', () => {
    const format = builtin('standard-manuscript')
    expect(formatProblem(format)).toBeNull()
    expect(formatProblem({ ...format, sceneSeparator: { kind: 'text', text: '  ' } })).toMatch(
      /^sceneSeparator › text: /
    )
  })

  it('explains a replacement that cannot run', () => {
    const rule = { enabled: true, find: '--', replace: '—', regex: false, caseSensitive: true }
    expect(replacementError(rule)).toBeNull()
    expect(replacementError({ ...rule, find: '' })).toBe('Type what to find')
    expect(replacementError({ ...rule, find: '(', regex: true })).toBe(
      'Not a valid regular expression'
    )
  })
})
