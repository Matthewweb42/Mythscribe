import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultExportFormatting, type ExportOptions } from '@shared/bookExport'
import type { TiptapNodeT } from '@shared/tiptap'
import type { NodeRow } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { collectBook } from './collect'
import type { BookBlock } from './model'

let tmp: string
let session: ProjectSession
let db: TreeDb

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const options = (over: Partial<ExportOptions> = {}): ExportOptions => ({
  format: 'md',
  scope: { kind: 'manuscript' },
  includeFront: true,
  includeEnd: true,
  formatting: defaultExportFormatting('* * *'),
  ...over
})

function section(type: NodeRow['sectionType']): NodeRow {
  const row = listNodes(db).find((r) => r.sectionType === type)
  if (!row) throw new Error(`no ${type}`)
  return row
}

/** The seeded chapters, in reading order: Part 1's three, then Part 2's. */
function chapters(): NodeRow[] {
  const rows = listNodes(db)
  const parts = rows.filter((r) => r.hierarchyLevel === 'part')
  return parts.flatMap((part) =>
    rows.filter((r) => r.parentId === part.id && r.hierarchyLevel === 'chapter')
  )
}

function sceneOf(chapter: NodeRow): NodeRow {
  const scene = listNodes(db).find((r) => r.parentId === chapter.id && r.hierarchyLevel === 'scene')
  if (!scene) throw new Error('seed changed')
  return scene
}

function texts(blocks: readonly BookBlock[]): string[] {
  return blocks.map((b) =>
    b.kind === 'title'
      ? `${b.level}:${b.text}`
      : b.kind === 'paragraph'
        ? b.runs.map((r) => (r.kind === 'text' ? r.text : '\n')).join('')
        : b.kind
  )
}

function matter(type: 'front' | 'end', title: string, text: string | null): NodeRow {
  const row = createNode(db, 'novel', {
    parentId: section(type).id,
    kind: 'document',
    hierarchyLevel: null,
    title
  })
  if (text !== null) saveDocument(db, row.id, para(text))
  return row
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-export-'))
  session = createProject(projectFolderFor(tmp, 'Export'), 'Export', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('collectBook (F-12.1)', () => {
  it('collects the manuscript with front and end matter units, text only, and counts words', () => {
    const [c1, c2] = chapters()
    if (!c1 || !c2) throw new Error('seed changed')
    saveDocument(db, sceneOf(c1).id, para('The storm broke.'))
    saveDocument(db, sceneOf(c2).id, para('Rain fell.'))
    matter('front', 'Title page', 'Export')
    matter('front', 'Empty', null)
    matter('end', 'Afterword', 'Thanks to all.')

    const book = collectBook(db, options(), 'Export')
    expect(book.units.map((u) => [u.kind, u.title])).toEqual([
      ['matter', 'Title page'],
      ['body', 'Export'],
      ['matter', 'Afterword']
    ])
    expect(texts(book.units[0]?.blocks ?? [])).toEqual(['Export'])
    expect(texts(book.units[1]?.blocks ?? []).slice(0, 5)).toEqual([
      'part:Part 1',
      'chapter:Chapter 1',
      'The storm broke.',
      'chapter:Chapter 2',
      'Rain fell.'
    ])
    expect(book.words).toBe(1 + 3 + 2 + 3)
  })

  it('leaves matter out when not asked', () => {
    const [c1] = chapters()
    if (!c1) throw new Error('seed changed')
    saveDocument(db, sceneOf(c1).id, para('Words here.'))
    matter('front', 'Dedication', 'For M.')
    const book = collectBook(db, options({ includeFront: false, includeEnd: false }), 'Export')
    expect(book.units.map((u) => u.kind)).toEqual(['body'])
    expect(book.words).toBe(2)
  })

  it('keeps chosen chapters with the part above them', () => {
    const [first, , , , chosen] = chapters()
    if (!first || !chosen) throw new Error('seed changed')
    saveDocument(db, sceneOf(chosen).id, para('Only this.'))
    saveDocument(db, sceneOf(first).id, para('Not this.'))
    const book = collectBook(
      db,
      options({ scope: { kind: 'chapters', ids: [chosen.id] }, includeFront: false }),
      'Export'
    )
    expect(texts(book.units[0]?.blocks ?? [])).toEqual([
      'part:Part 2',
      'chapter:Chapter 2',
      'Only this.'
    ])
    expect(book.words).toBe(2)
  })

  it('prints one document alone, from any section, without matter', () => {
    const dedication = matter('front', 'Dedication', 'For M.')
    matter('end', 'Afterword', 'Thanks.')
    const book = collectBook(
      db,
      options({ scope: { kind: 'document', id: dedication.id } }),
      'Export'
    )
    expect(book.units).toEqual([
      {
        kind: 'body',
        title: 'Dedication',
        blocks: [
          {
            kind: 'paragraph',
            align: null,
            runs: [expect.objectContaining({ kind: 'text', text: 'For M.' })]
          }
        ]
      }
    ])
    expect(book.words).toBe(2)
  })

  it('refuses a missing document, a folder, and a scope with nothing to print', () => {
    const [chapter] = chapters()
    if (!chapter) throw new Error('seed changed')
    expect(() =>
      collectBook(db, options({ scope: { kind: 'document', id: 'missing' } }), 'Export')
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() =>
      collectBook(db, options({ scope: { kind: 'document', id: chapter.id } }), 'Export')
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
    matter('front', 'Empty', null)
    expect(() => collectBook(db, options(), 'Export')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', message: 'Nothing to export.' })
    )
  })
})
