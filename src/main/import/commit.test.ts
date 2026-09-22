import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImportChapter, ImportDraft, ImportPart, ImportScene } from '@shared/import'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import type { NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { importDraft } from './commit'

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-import-'))
  session = createProject(projectFolderFor(tmp, 'novel'), 'novel', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function root(sectionType: NodeRow['sectionType']): NodeRow {
  const row = listNodes(db).find((r) => r.sectionType === sectionType)
  if (!row) throw new Error(`no ${sectionType} root`)
  return row
}

function children(parentId: string): NodeRow[] {
  return listNodes(db).filter((r) => r.parentId === parentId)
}

function paragraph(text: string): TiptapNodeT {
  return {
    type: 'paragraph',
    attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
    content: [{ type: 'text', text }]
  }
}

function scene(id: string, text: string, excluded = false): ImportScene {
  return { id, title: id, excluded, paragraphs: [paragraph(text)] }
}

function chapter(
  id: string,
  scenes: ImportScene[],
  over: Partial<ImportChapter> = {}
): ImportChapter {
  return { id, title: id, excluded: false, placement: 'manuscript', scenes, ...over }
}

function part(id: string, chapters: ImportChapter[], over: Partial<ImportPart> = {}): ImportPart {
  return { id, title: id, excluded: false, chapters, ...over }
}

function draftOf(parts: ImportPart[]): ImportDraft {
  return {
    source: { name: 'Sample.docx', format: 'docx', words: 0, paragraphs: 0 },
    parts,
    nextId: 1
  }
}

describe('importDraft', () => {
  it('appends the parts after the manuscript children the project already has', () => {
    const before = children(root('manuscript').id)
    const { rows, words } = importDraft(
      db,
      'novel',
      draftOf([part('p1', [chapter('p1c1', [scene('p1c1s1', 'One two three.')])])])
    )

    const after = children(root('manuscript').id)
    expect(after).toHaveLength(before.length + 1)
    expect(after.map((row) => row.position)).toEqual(after.map((_row, index) => index))
    const imported = after.at(-1)
    expect(imported?.title).toBe('p1')
    expect(imported?.hierarchyLevel).toBe('part')
    expect(imported?.kind).toBe('folder')
    expect(rows[0]?.id).toBe(imported?.id)
    expect(words).toBe(3)
  })

  it('writes chapters and scenes with contiguous positions and cached word counts', () => {
    const { rows } = importDraft(
      db,
      'novel',
      draftOf([
        part('p1', [
          chapter('c1', [scene('s1', 'One two.'), scene('s2', 'Three.')]),
          chapter('c2', [scene('s3', 'Four five six.')])
        ])
      ])
    )
    expect(rows.map((row) => row.title)).toEqual(['p1', 'c1', 's1', 's2', 'c2', 's3'])

    const partRow = rows[0]
    expect(children(partRow!.id).map((row) => [row.title, row.position])).toEqual([
      ['c1', 0],
      ['c2', 1]
    ])
    const chapterRow = rows[1]
    const scenes = children(chapterRow!.id)
    expect(scenes.map((row) => [row.title, row.position, row.wordCount])).toEqual([
      ['s1', 0, 2],
      ['s2', 1, 1]
    ])
    expect(scenes[0]?.hierarchyLevel).toBe('scene')
    expect(scenes[0]?.kind).toBe('document')
  })

  it('keeps the imported origin on the paragraphs it stores', () => {
    const { rows } = importDraft(
      db,
      'novel',
      draftOf([part('p1', [chapter('c1', [scene('s1', 'The bell rang.')])])])
    )
    const stored: unknown = JSON.parse(rows[2]?.content ?? 'null')
    expect(stored).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
          content: [{ type: 'text', text: 'The bell rang.' }]
        }
      ]
    })
  })

  it('skips excluded parts, chapters, and scenes', () => {
    const { rows } = importDraft(
      db,
      'novel',
      draftOf([
        part('gone', [chapter('c0', [scene('s0', 'Nothing.')])], { excluded: true }),
        part('p1', [
          chapter('skipped', [scene('s1', 'Nothing.')], { excluded: true }),
          chapter('kept', [scene('s2', 'One.'), scene('s3', 'Two.', true)])
        ])
      ])
    )
    expect(rows.map((row) => row.title)).toEqual(['p1', 'kept', 's2'])
  })

  it('does not create a part whose chapters all went to matter', () => {
    const { rows } = importDraft(
      db,
      'novel',
      draftOf([
        part('p1', [chapter('Dedication', [scene('s1', 'For no one.')], { placement: 'front' })])
      ])
    )
    expect(rows.map((row) => row.title)).toEqual(['Dedication'])
    expect(rows[0]?.parentId).toBe(root('front').id)
    expect(rows[0]?.hierarchyLevel).toBeNull()
    expect(rows[0]?.kind).toBe('document')
    expect(children(root('manuscript').id).some((row) => row.title === 'p1')).toBe(false)
  })

  it('flattens a matter chapter into one document, its scenes joined by a scene break', () => {
    const { rows, words } = importDraft(
      db,
      'novel',
      draftOf([
        part('p1', [
          chapter('Afterword', [scene('s1', 'One two.'), scene('s2', 'Three.')], {
            placement: 'end'
          }),
          chapter('c1', [scene('s3', 'Four.')])
        ])
      ])
    )
    const afterword = rows.find((row) => row.title === 'Afterword')
    expect(afterword?.parentId).toBe(root('end').id)
    const stored: unknown = JSON.parse(afterword?.content ?? 'null')
    expect(stored).toEqual({
      type: 'doc',
      content: [paragraph('One two.'), { type: 'sceneBreak' }, paragraph('Three.')]
    })
    expect(afterword?.wordCount).toBe(3)
    expect(words).toBe(4)
  })

  it('falls back to the default title when the author cleared one', () => {
    const { rows } = importDraft(
      db,
      'novel',
      draftOf([part('  ', [chapter(' ', [{ ...scene('s1', 'One.'), title: '' }])])])
    )
    expect(rows.map((row) => row.title)).toEqual([
      'Untitled Part',
      'Untitled Chapter',
      'Untitled Scene'
    ])
  })

  it('refuses a draft with nothing left to import and writes nothing', () => {
    const before = listNodes(db).length
    expect(() =>
      importDraft(db, 'novel', draftOf([part('p1', [chapter('c1', [scene('s1', 'One.', true)])])]))
    ).toThrow(AppError)
    expect(listNodes(db)).toHaveLength(before)
  })

  it('refuses an empty draft', () => {
    try {
      importDraft(db, 'novel', draftOf([]))
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('VALIDATION')
      return
    }
    throw new Error('expected VALIDATION')
  })
})
