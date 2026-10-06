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
import { saveDocument } from '../document/documentStore'
import { createNode, getNode, listNodes, type TreeDb } from '../tree/treeStore'
import { importDraft } from './commit'
import { withExisting } from './existing'

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
  return { id, title: id, excluded, paragraphs: [paragraph(text)], tags: [] }
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

  // F-12.3: the AI pass's tag candidates travel with the draft and come back keyed by the node
  // that was created, which is what the handler turns into one pending proposal per scene.
  it('reports the tag candidates of each created manuscript scene, deduplicated, and none for matter', () => {
    const tagged = (id: string, text: string, tags: string[]): ImportScene => ({
      ...scene(id, text),
      tags
    })
    const { rows, tagCandidates } = importDraft(
      db,
      'novel',
      draftOf([
        part('p1', [
          chapter('c1', [
            tagged('s1', 'One.', ['protagonist', ' protagonist ', 'dark-forest', '  ']),
            scene('s2', 'Two.'),
            tagged('s3', 'Three.', ['melancholy'])
          ]),
          chapter('Afterword', [tagged('s4', 'Four.', ['protagonist'])], { placement: 'end' })
        ])
      ])
    )
    const idOf = (title: string): string => rows.find((row) => row.title === title)?.id ?? ''
    expect(tagCandidates).toEqual([
      { nodeId: idOf('s1'), tags: ['protagonist', 'dark-forest'] },
      { nodeId: idOf('s3'), tags: ['melancholy'] }
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

describe('importDraft with the combined outline (F-12.2 rework)', () => {
  /** The starter skeleton's node at a level: Part 1, Chapter 1, Scene 1. */
  function skeleton(level: 'part' | 'chapter' | 'scene'): NodeRow {
    const row = listNodes(db).find((r) => r.hierarchyLevel === level)
    if (!row) throw new Error(`no ${level}`)
    return row
  }

  const own = (text: string): TiptapNodeT => ({
    type: 'paragraph',
    content: [{ type: 'text', text }]
  })

  function write(id: string, ...texts: string[]): void {
    saveDocument(db, id, { type: 'doc', content: texts.map(own) })
  }

  function combined(parts: ImportPart[]): ImportDraft {
    return withExisting(db, draftOf(parts))
  }

  /** The first part (the project's own), its chapter, and that chapter's scenes, from a draft. */
  function existingPart(draft: ImportDraft): ImportPart {
    const first = draft.parts[0]
    if (!first?.existing) throw new Error('no existing part')
    return first
  }

  const textOf = (id: string): string[] =>
    ((JSON.parse(getNode(db, id)?.content ?? '{"content":[]}') as TiptapNodeT).content ?? []).map(
      (p) => p.content?.[0]?.text ?? ''
    )

  it('puts the project’s outline, with its text, ahead of the imported parts', () => {
    write(skeleton('scene').id, 'Mara climbed.')
    const draft = combined([part('p1', [chapter('c1', [scene('s1', 'New text.')])])])
    expect(draft.parts.map((p) => [p.title, p.existing === true])).toEqual([
      ['Part 1', true],
      ['p1', false]
    ])
    expect(draft.existing).toEqual({
      parts: [skeleton('part').id],
      chapters: [skeleton('chapter').id],
      scenes: [skeleton('scene').id]
    })
    expect(existingPart(draft).chapters[0]?.scenes[0]?.paragraphs).toEqual([own('Mara climbed.')])
  })

  it('imports around an untouched outline without writing a single existing row', () => {
    write(skeleton('scene').id, 'Mara climbed.')
    const before = listNodes(db)
    const result = importDraft(
      db,
      'novel',
      combined([part('p1', [chapter('c1', [scene('s1', 'New text.')])])])
    )
    expect(result).toMatchObject({ changedExisting: false, rewritten: [], deleted: [], words: 2 })
    const after = listNodes(db)
    expect(after.filter((row) => before.some((b) => b.id === row.id))).toEqual(before)
    expect(result.rows[0]).toMatchObject({ title: 'p1', position: 1 })
  })

  it('moves an imported chapter into an existing part, renames, and merges into an existing scene', () => {
    const sceneId = skeleton('scene').id
    write(sceneId, 'Mara climbed.')
    const draft = combined([part('p1', [chapter('c1', [scene('s1', 'New text.')])])])
    const mine = existingPart(draft)
    const chapterOne = mine.chapters[0]
    const sceneOne = chapterOne?.scenes[0]
    const imported = draft.parts[1]?.chapters[0]
    if (!chapterOne || !sceneOne || !imported) throw new Error('fixture')
    const edited: ImportDraft = {
      ...draft,
      parts: [
        {
          ...mine,
          chapters: [
            {
              ...chapterOne,
              scenes: [
                {
                  ...sceneOne,
                  title: 'The Climb',
                  paragraphs: [...sceneOne.paragraphs, paragraph('Also new.')]
                }
              ]
            },
            imported
          ]
        },
        { ...part('p1', []) }
      ]
    }
    const result = importDraft(db, 'novel', edited)
    const sceneRow = getNode(db, sceneId)
    expect(sceneRow?.title).toBe('The Climb')
    expect(textOf(sceneRow?.id ?? '')).toEqual(['Mara climbed.', 'Also new.'])
    expect(sceneRow?.wordCount).toBe(4)
    expect(result.rewritten).toEqual([{ id: sceneRow?.id, wordCount: 4 }])
    expect(result.words).toBe(4)
    expect(result.changedExisting).toBe(true)
    // The imported chapter landed in Part 1 after Chapter 1; no empty part was made for it.
    expect(result.rows.map((row) => row.title)).toEqual(['c1', 's1'])
    expect(result.rows[0]).toMatchObject({ parentId: skeleton('part').id, position: 1 })
  })

  it('deletes the existing scenes the author merged away or removed, and nothing else', () => {
    const chapterId = skeleton('chapter').id
    const first = skeleton('scene')
    write(first.id, 'One.')
    const second = createNode(db, 'novel', {
      parentId: chapterId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Two'
    })
    write(second.id, 'Two.')
    const third = createNode(db, 'novel', {
      parentId: chapterId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Three'
    })
    const draft = combined([part('p1', [chapter('c1', [scene('s1', 'New.')])])])
    const mine = existingPart(draft)
    const chapterOne = mine.chapters[0]
    const [s1, s2] = chapterOne?.scenes ?? []
    if (!chapterOne || !s1 || !s2) throw new Error('fixture')
    const edited: ImportDraft = {
      ...draft,
      parts: [
        {
          ...mine,
          chapters: [
            {
              ...chapterOne,
              scenes: [
                { ...s1, paragraphs: [...s1.paragraphs, ...s2.paragraphs], absorbed: [s2.id] }
              ]
            }
          ]
        },
        ...draft.parts.slice(1)
      ]
    }
    const result = importDraft(db, 'novel', edited)
    expect(result.deleted.sort()).toEqual([second.id, third.id].sort())
    expect(getNode(db, second.id)).toBeUndefined()
    expect(getNode(db, third.id)).toBeUndefined()
    expect(textOf(first.id)).toEqual(['One.', 'Two.'])
    // Only the imported words count: the merged-in existing text was already the author's.
    expect(result.words).toBe(1)
  })

  it('moves a document the outline does not show out of a deleted chapter, to the manuscript', () => {
    const chapterOne = skeleton('chapter')
    const sceneOne = skeleton('scene').id
    const loose = createNode(db, 'novel', {
      parentId: chapterOne.id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Research'
    })
    const draft = combined([part('p1', [chapter('c1', [scene('s1', 'New.')])])])
    const mine = existingPart(draft)
    const result = importDraft(db, 'novel', {
      ...draft,
      parts: [{ ...mine, chapters: [] }, ...draft.parts.slice(1)]
    })
    expect(result.deleted.sort()).toEqual([chapterOne.id, sceneOne].sort())
    expect(getNode(db, chapterOne.id)).toBeUndefined()
    expect(getNode(db, loose.id)?.parentId).toBe(root('manuscript').id)
    // Part 1 stays, empty, where it was; the moved document follows the outline's parts.
    expect(children(root('manuscript').id).map((row) => row.title)).toEqual([
      'Part 1',
      'p1',
      'Research'
    ])
  })

  it('refuses a draft whose existing nodes changed since it was opened, writing nothing', () => {
    const draft = combined([part('p1', [chapter('c1', [scene('s1', 'New.')])])])
    createNode(db, 'novel', {
      parentId: skeleton('chapter').id,
      kind: 'document',
      hierarchyLevel: 'scene'
    })
    const stale: ImportDraft = {
      ...draft,
      existing: { parts: [], chapters: [], scenes: ['gone'] }
    }
    const before = listNodes(db)
    expect(() => importDraft(db, 'novel', stale)).toThrowError(/changed since the import/)
    expect(listNodes(db)).toEqual(before)
  })

  it('keeps an existing chapter in the manuscript', () => {
    const draft = combined([part('p1', [chapter('c1', [scene('s1', 'New.')])])])
    const mine = existingPart(draft)
    const chapterOne = mine.chapters[0]
    if (!chapterOne) throw new Error('fixture')
    expect(() =>
      importDraft(db, 'novel', {
        ...draft,
        parts: [{ ...mine, chapters: [{ ...chapterOne, placement: 'front' }] }]
      })
    ).toThrowError(/stays in the manuscript/)
  })
})
