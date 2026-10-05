import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIRST_DRAFT_NAME, type DraftList } from '@shared/drafts'
import type { TiptapNodeT } from '@shared/tiptap'
import { draft, draftText, node, settings, writingLog, type NodeRow } from '../db/schema'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, deleteNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import {
  ACTIVE_DRAFT_KEY,
  compareDrafts,
  deleteDraft,
  duplicateDraft,
  listDrafts,
  renameDraft,
  revertDocuments,
  switchDraft
} from './draftStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
/** The seeded manuscript's documents in reading order; the first three hold text. */
let scenes: NodeRow[]

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const scene = (index: number): NodeRow => {
  const row = scenes[index]
  if (row === undefined) throw new Error(`no scene ${index}`)
  return row
}

const contentOf = (id: string): TiptapNodeT | null => getDocumentContent(db, id).content
const wordsOf = (id: string): number | undefined => getNode(db, id)?.wordCount

const byName = (list: DraftList, name: string): string => {
  const found = list.drafts.find((each) => each.name === name)
  if (!found) throw new Error(`no draft ${name}`)
  return found.id
}

const rowCount = (draftId: string): number =>
  db.select().from(draftText).where(eq(draftText.draftId, draftId)).all().length

const writingRows = (): unknown[] => db.select().from(writingLog).all()

/** Draft 1 holds `one`, a duplicate "Draft 2" is made and switched to, and gets `two`. */
const twoDrafts = (): { first: string; second: string } => {
  const first = listDrafts(db).activeId
  const second = byName(duplicateDraft(db, first, 'Draft 2'), 'Draft 2')
  switchDraft(db, second)
  return { first, second }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-drafts-'))
  session = createProject(projectFolderFor(tmp, 'Drafts'), 'Drafts', 'novel')
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]
  if (first === undefined) throw new Error('no seeded scene')
  for (let i = 0; i < 2; i++) {
    createNode(db, 'novel', {
      parentId: first.parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: `Extra ${i + 1}`
    })
  }
  scenes = manuscriptDocuments(db)
  saveDocument(db, scene(0).id, doc('The storm broke at dawn.'))
  saveDocument(db, scene(1).id, doc('Mara waited by the gate.'))
  saveDocument(db, scene(2).id, doc('Nothing changed here.'))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('listDrafts (F-8.5)', () => {
  it('creates "Draft 1", active, on first use and only once', () => {
    expect(db.select().from(draft).all()).toEqual([])
    const list = listDrafts(db)
    expect(list.drafts).toHaveLength(1)
    expect(list.drafts[0]).toMatchObject({ name: FIRST_DRAFT_NAME, active: true, wordCount: 13 })
    expect(list.activeId).toBe(list.drafts[0]?.id)
    expect(listDrafts(db)).toEqual(list)
    expect(db.select().from(draft).all()).toHaveLength(1)
  })

  it('repairs an active id that names no draft to the first draft', () => {
    const list = listDrafts(db)
    db.update(settings)
      .set({ value: JSON.stringify('ghost') })
      .where(eq(settings.key, ACTIVE_DRAFT_KEY))
      .run()
    expect(listDrafts(db).activeId).toBe(list.activeId)
  })

  it('counts each draft as it reads the manuscript', () => {
    const { first, second } = twoDrafts()
    saveDocument(db, scene(0).id, doc('Short.'))
    const list = listDrafts(db)
    expect(list.drafts.map((each) => [each.id, each.wordCount, each.active])).toEqual([
      [first, 13, false],
      [second, 9, true]
    ])
  })
})

describe('switchDraft (F-8.5)', () => {
  it('round-trips: each draft gets its own text back, and the target keeps no rows', () => {
    const { first, second } = twoDrafts()
    saveDocument(db, scene(0).id, doc('The squall broke at noon.'))
    saveDocument(db, scene(1).id, doc('Mara left.'))

    const back = switchDraft(db, first)
    expect(back.list.activeId).toBe(first)
    expect(back.changed).toEqual([
      { id: scene(0).id, wordCount: 5 },
      { id: scene(1).id, wordCount: 5 }
    ])
    expect(contentOf(scene(0).id)).toEqual(doc('The storm broke at dawn.'))
    expect(contentOf(scene(1).id)).toEqual(doc('Mara waited by the gate.'))
    expect(wordsOf(scene(1).id)).toBe(5)
    expect(rowCount(first)).toBe(0)
    expect(rowCount(second)).toBe(scenes.length)

    const again = switchDraft(db, second)
    expect(again.changed.map((each) => each.id)).toEqual([scene(0).id, scene(1).id])
    expect(contentOf(scene(0).id)).toEqual(doc('The squall broke at noon.'))
    expect(contentOf(scene(1).id)).toEqual(doc('Mara left.'))
    expect(wordsOf(scene(1).id)).toBe(2)
    expect(contentOf(scene(2).id)).toEqual(doc('Nothing changed here.'))
  })

  it('changes nothing when switching to the active draft', () => {
    const list = listDrafts(db)
    const result = switchDraft(db, list.activeId)
    expect(result.changed).toEqual([])
    expect(result.list.activeId).toBe(list.activeId)
    expect(rowCount(list.activeId)).toBe(0)
  })

  it('refuses an unknown draft', () => {
    listDrafts(db)
    expect(() => switchDraft(db, 'ghost')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('reads a scene added after a draft was left as its live text there (missing-row rule)', () => {
    const { first } = twoDrafts()
    const added = createNode(db, 'novel', {
      parentId: scene(0).parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Added'
    })
    saveDocument(db, added.id, doc('Written in Draft 2.'))
    const back = switchDraft(db, first)
    expect(back.changed.map((each) => each.id)).not.toContain(added.id)
    expect(contentOf(added.id)).toEqual(doc('Written in Draft 2.'))
    // Edited in Draft 1 now, so each draft has its own version from here on.
    saveDocument(db, added.id, doc('Draft 1 version.'))
    const list = listDrafts(db)
    switchDraft(db, byName(list, 'Draft 2'))
    expect(contentOf(added.id)).toEqual(doc('Written in Draft 2.'))
  })

  it('keeps an empty (never written) scene empty in the draft that had it empty', () => {
    const empty = createNode(db, 'novel', {
      parentId: scene(0).parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Empty'
    })
    const { first } = twoDrafts()
    saveDocument(db, empty.id, doc('Now it has words.'))
    switchDraft(db, first)
    expect(contentOf(empty.id)).toBeNull()
    expect(wordsOf(empty.id)).toBe(0)
  })

  it('leaves front and end matter documents out of every draft', () => {
    const front = db.select().from(node).where(eq(node.sectionType, 'front')).get()
    if (!front) throw new Error('no front matter section')
    const matter = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Dedication'
    })
    saveDocument(db, matter.id, doc('For Ada.'))
    const { first } = twoDrafts()
    saveDocument(db, matter.id, doc('For Ada and Lin.'))
    switchDraft(db, first)
    expect(contentOf(matter.id)).toEqual(doc('For Ada and Lin.'))
    expect(db.select().from(draftText).where(eq(draftText.nodeId, matter.id)).all()).toEqual([])
  })

  it('drops a draft text with its scene', () => {
    const { first, second } = twoDrafts()
    deleteNode(db, scene(2).id)
    expect(rowCount(first)).toBe(scenes.length - 1)
    switchDraft(db, first)
    expect(rowCount(second)).toBe(scenes.length - 1)
  })

  it('does not count as words written', () => {
    const before = writingRows()
    const { first } = twoDrafts()
    saveDocument(db, scene(0).id, doc('A much longer opening line than before, by far.'))
    switchDraft(db, first)
    expect(writingRows()).toEqual(before)
  })
})

describe('duplicateDraft (F-8.5)', () => {
  it('copies the active draft from the live text without switching', () => {
    const first = listDrafts(db).activeId
    const list = duplicateDraft(db, first, '  Draft 2  ')
    const second = byName(list, 'Draft 2')
    expect(list.activeId).toBe(first)
    expect(list.drafts.map((each) => each.name)).toEqual(['Draft 1', 'Draft 2'])
    expect(list.drafts[1]?.wordCount).toBe(13)
    expect(rowCount(second)).toBe(scenes.length)
  })

  it('copies an inactive draft from its rows, and the copy reads like it', () => {
    const { first } = twoDrafts()
    saveDocument(db, scene(0).id, doc('Changed in Draft 2.'))
    const list = duplicateDraft(db, first, 'Final')
    const final = byName(list, 'Final')
    expect(list.activeId).not.toBe(final)
    expect(compareDrafts(db, first, final).docs).toEqual([])
    switchDraft(db, final)
    expect(contentOf(scene(0).id)).toEqual(doc('The storm broke at dawn.'))
  })

  it('refuses a taken name (case-insensitive), an empty one, and an unknown source', () => {
    const first = listDrafts(db).activeId
    expect(() => duplicateDraft(db, first, 'draft 1')).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => duplicateDraft(db, first, '   ')).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => duplicateDraft(db, 'ghost', 'Other')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(listDrafts(db).drafts).toHaveLength(1)
  })
})

describe('renameDraft and deleteDraft (F-8.5)', () => {
  it('renames, allowing a case change of its own name, refusing another draft’s', () => {
    const { first, second } = twoDrafts()
    expect(renameDraft(db, second, 'Final').drafts[1]?.name).toBe('Final')
    expect(renameDraft(db, second, 'FINAL').drafts[1]?.name).toBe('FINAL')
    expect(() => renameDraft(db, second, 'DRAFT 1')).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => renameDraft(db, first, 'x'.repeat(61))).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => renameDraft(db, 'ghost', 'Other')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })

  it('refuses to delete the last draft and the active one', () => {
    const only = listDrafts(db).activeId
    expect(() => deleteDraft(db, only)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    const { second } = twoDrafts()
    expect(() => deleteDraft(db, second)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => deleteDraft(db, 'ghost')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('deletes an inactive draft with its texts and leaves the live text alone', () => {
    const { first, second } = twoDrafts()
    saveDocument(db, scene(0).id, doc('Draft 2 text.'))
    const list = deleteDraft(db, first)
    expect(list.drafts.map((each) => each.id)).toEqual([second])
    expect(rowCount(first)).toBe(0)
    expect(contentOf(scene(0).id)).toEqual(doc('Draft 2 text.'))
  })
})

describe('compareDrafts (F-8.5)', () => {
  it('lists changed documents in tree order with diffs, paths, and an unchanged count', () => {
    const { first, second } = twoDrafts()
    saveDocument(db, scene(1).id, doc('Mara waited by the old gate.'))
    saveDocument(db, scene(0).id, doc('The squall broke at dawn.'))
    const result = compareDrafts(db, first, second)
    expect(result).toMatchObject({ fromId: first, toId: second, unchanged: scenes.length - 2 })
    expect(result.docs.map((each) => each.nodeId)).toEqual([scene(0).id, scene(1).id])
    const parent = getNode(db, scene(0).parentId ?? '')
    expect(result.docs[0]?.title).toBe(scene(0).title)
    expect(result.docs[0]?.path.at(-1)).toBe(parent?.title)
    expect(result.docs[0]?.segments).toEqual([
      { op: 'same', text: 'The ' },
      { op: 'del', text: 'storm' },
      { op: 'add', text: 'squall' },
      { op: 'same', text: ' broke at dawn.' }
    ])
    expect(result.docs[0]).toMatchObject({ wordsAdded: 1, wordsRemoved: 1 })
    expect(result.docs[1]).toMatchObject({ wordsAdded: 1, wordsRemoved: 0 })

    const reverse = compareDrafts(db, second, first)
    expect(reverse.docs[1]).toMatchObject({ wordsAdded: 0, wordsRemoved: 1 })
  })

  it('counts formatting-only differences as unchanged and a draft against itself as all same', () => {
    const { first, second } = twoDrafts()
    saveDocument(db, scene(2).id, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Nothing changed here.', marks: [{ type: 'bold' }] }]
        }
      ]
    })
    const all = scenes.length
    expect(compareDrafts(db, first, second)).toMatchObject({ docs: [], unchanged: all })
    expect(compareDrafts(db, first, first)).toMatchObject({ docs: [], unchanged: all })
  })

  it('refuses an unknown draft', () => {
    const first = listDrafts(db).activeId
    expect(() => compareDrafts(db, first, 'ghost')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})

describe('revertDocuments (F-8.5)', () => {
  it('reverts one scene of the active draft to another draft’s text', () => {
    const { first } = twoDrafts()
    saveDocument(db, scene(0).id, doc('The squall broke.'))
    saveDocument(db, scene(1).id, doc('Mara left.'))
    const result = revertDocuments(db, first, [scene(0).id])
    expect(result.changed).toEqual([{ id: scene(0).id, wordCount: 5 }])
    expect(contentOf(scene(0).id)).toEqual(doc('The storm broke at dawn.'))
    expect(contentOf(scene(1).id)).toEqual(doc('Mara left.'))
    // The source draft keeps its text.
    expect(rowCount(first)).toBe(scenes.length)
  })

  it('reverts every manuscript document when no ids are given', () => {
    const { first } = twoDrafts()
    saveDocument(db, scene(0).id, doc('The squall broke.'))
    saveDocument(db, scene(1).id, doc('Mara left.'))
    const result = revertDocuments(db, first)
    expect(result.changed.map((each) => each.id)).toEqual([scene(0).id, scene(1).id])
    expect(compareDrafts(db, first, result.list.activeId).docs).toEqual([])
  })

  it('skips ids that are not manuscript documents and refuses the active draft as source', () => {
    const { first, second } = twoDrafts()
    expect(revertDocuments(db, first, ['ghost']).changed).toEqual([])
    expect(() => revertDocuments(db, second)).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => revertDocuments(db, 'ghost')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })

  it('does not count as words written', () => {
    const { first } = twoDrafts()
    saveDocument(db, scene(0).id, doc('Short.'))
    const before = writingRows()
    revertDocuments(db, first)
    expect(writingRows()).toEqual(before)
    expect(
      db
        .select()
        .from(node)
        .where(eq(node.id, scene(0).id))
        .get()?.wordCount
    ).toBe(5)
  })
})
