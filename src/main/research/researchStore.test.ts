import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import { alreadyInResearch, researchSourceLine } from '@shared/research'
import { EMPTY_DOC, TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { contextFile, node, type NodeRow } from '../db/schema'
import { getDocumentContent } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import {
  addContextFiles,
  listContextFiles,
  type ContextSource
} from '../library/libraryStore'
import { textPdf } from '../library/pdfFixture'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { ensureResearchRoot } from '../project/seed'
import {
  createNode,
  deleteNode,
  duplicateNode,
  getNode,
  listNodes,
  type TreeDb
} from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import {
  RESEARCH_TYPES_MESSAGE,
  addResearchFiles,
  copyResearchMeta,
  createResearchNote,
  listResearchDocs,
  researchDocOf,
  researchOriginalPath,
  setResearchNotCanon
} from './researchStore'
import {
  isUnderResearch,
  researchDocumentIds,
  researchRootId,
  researchSubtree
} from './researchTree'

let tmp: string
let session: ProjectSession
let db: TreeDb
let root: string

const SAMPLE_DOCX = path.join(import.meta.dirname, '../import/fixtures/sample.docx')

const source = (name: string, data: string | Buffer): ContextSource => ({
  name,
  read: () => (typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
})

const contentOf = (id: string): TiptapNodeT | null => getDocumentContent(db, id).content

const add = (...sources: ContextSource[]): ReturnType<typeof addResearchFiles> =>
  addResearchFiles(db, session.folder, 'novel', sources)

const onlyCreated = async (...sources: ContextSource[]): Promise<string> => {
  const result = await add(...sources)
  expect(result.skipped).toEqual([])
  const [id] = result.created
  if (id === undefined) throw new Error('nothing created')
  return id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-research-'))
  session = createProject(projectFolderFor(tmp, 'Research'), 'Research', 'novel')
  db = session.connection.orm
  root = ensureResearchRoot(db)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ensureResearchRoot (F-16.8)', () => {
  it('adds one fourth root after end matter, once', () => {
    const roots = listNodes(db).filter((row) => row.parentId === null)
    expect(roots.map((row) => [row.sectionType, row.position])).toEqual([
      ['front', 0],
      ['manuscript', 1],
      ['end', 2],
      ['research', 3]
    ])
    expect(ensureResearchRoot(db)).toBe(root)
    expect(listNodes(db).filter((row) => row.parentId === null)).toHaveLength(4)
    expect(researchRootId(db)).toBe(root)
  })

  it('holds folders and documents, never hierarchy levels', () => {
    const folder = createNode(db, 'novel', {
      parentId: root,
      kind: 'folder',
      hierarchyLevel: null,
      title: 'Maps'
    })
    const page = createResearchNote(db, 'novel', { parentId: folder.id, title: 'Coast' })
    const at = (id: string): NodeRow => {
      const row = getNode(db, id)
      if (row === undefined) throw new Error(`no node ${id}`)
      return row
    }
    expect(isUnderResearch(db, at(folder.id))).toBe(true)
    expect(isUnderResearch(db, at(page.id))).toBe(true)
    expect(isUnderResearch(db, at(root))).toBe(false)
    const [scene] = manuscriptDocuments(db)
    expect(scene !== undefined && isUnderResearch(db, scene)).toBe(false)
    // The one owner of "under Research": the subtree in tree order, and its documents.
    expect([...researchSubtree(listNodes(db))]).toEqual([root, folder.id, page.id])
    expect(researchDocumentIds(listNodes(db))).toEqual([page.id])
    expect(() =>
      createNode(db, 'novel', { parentId: root, kind: 'document', hierarchyLevel: 'scene' })
    ).toThrow(AppError)
  })
})

describe('research uploads become pages (F-16.8)', () => {
  it('turns a Word file into an editable page: headings, marks and the imported origin kept', async () => {
    const id = await onlyCreated(source('Harbour notes.docx', fs.readFileSync(SAMPLE_DOCX)))
    const row = getNode(db, id)
    expect(row?.title).toBe('Harbour notes')
    expect(row?.parentId).toBe(root)
    const doc = contentOf(id)
    expect(TiptapNode.safeParse(doc).success).toBe(true)
    expect(doc?.content?.[0]).toEqual({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Chapter One' }]
    })
    expect(doc?.content?.[1]).toMatchObject({
      type: 'paragraph',
      attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN }
    })
    // The glyph line is a break; the blank line before it is dropped, not a scene split.
    expect(doc?.content?.some((block) => block.type === 'sceneBreak')).toBe(true)
    expect(row?.wordCount).toBeGreaterThan(0)
    expect(researchDocOf(db, id)).toMatchObject({
      origin: 'upload',
      fileType: 'docx',
      fileName: 'Harbour notes.docx',
      converted: false,
      notCanon: false
    })
  })

  it('reads Markdown headings and emphasis, deeper headings shown at level 3', async () => {
    const id = await onlyCreated(
      source('Tides.md', '# Tides\n\nThe *spring* tide comes **twice**.\n\n#### Deep\n\nLast line.')
    )
    expect(contentOf(id)?.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Tides' }] },
      {
        type: 'paragraph',
        attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', text: 'spring', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' tide comes ' },
          { type: 'text', text: 'twice', marks: [{ type: 'bold' }] },
          { type: 'text', text: '.' }
        ]
      },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Deep' }] },
      {
        type: 'paragraph',
        attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
        content: [{ type: 'text', text: 'Last line.' }]
      }
    ])
  })

  it('reads a text file one paragraph per line', async () => {
    const id = await onlyCreated(source('ships.txt', 'The Gull is a cutter.\nThe Wren is a sloop.'))
    expect(contentOf(id)?.content?.map((block) => block.content?.[0]?.text)).toEqual([
      'The Gull is a cutter.',
      'The Wren is a sloop.'
    ])
    expect(researchDocOf(db, id).fileType).toBe('txt')
  })

  it('converts a PDF to its text, marked converted; a scanned one gives an empty page', async () => {
    const id = await onlyCreated(source('Almanac.pdf', textPdf(['Tide tables for 1891.'])))
    expect(contentOf(id)?.content?.[0]?.content?.[0]?.text).toBe('Tide tables for 1891.')
    const doc = researchDocOf(db, id)
    expect(doc).toMatchObject({ fileType: 'pdf', converted: true })
    expect(researchSourceLine(doc)).toBe('Converted from PDF: Almanac.pdf')
    const scanned = await onlyCreated(source('Scan.pdf', textPdf([])))
    expect(contentOf(scanned)).toEqual(EMPTY_DOC)
  })

  it('keeps an image as an attachment with one empty caption paragraph', async () => {
    const id = await onlyCreated(source('map.png', Buffer.from([137, 80, 78, 71, 1, 2])))
    expect(contentOf(id)).toEqual(EMPTY_DOC)
    const doc = researchDocOf(db, id)
    expect(doc).toMatchObject({ fileType: 'image', converted: false })
    expect(researchSourceLine(doc)).toBe('Image: map.png')
    expect(fs.existsSync(researchOriginalPath(db, session.folder, id))).toBe(true)
  })

  it('skips a file of another type and one already in Research, and adds a changed file anew', async () => {
    const first = await add(source('Tides.md', 'High water at six.'), source('song.mp3', 'x'))
    expect(first.created).toHaveLength(1)
    expect(first.skipped).toEqual([{ name: 'song.mp3', reason: RESEARCH_TYPES_MESSAGE }])
    const title = getNode(db, first.created[0] ?? '')?.title ?? ''
    const again = await add(source('Tides.md', 'High water at six.'))
    expect(again).toEqual({
      created: [],
      skipped: [{ name: 'Tides.md', reason: alreadyInResearch(title) }]
    })
    // A different file under the same name is a document of its own; the first keeps its original.
    const firstOriginal = researchOriginalPath(db, session.folder, first.created[0] ?? '')
    const changed = await add(source('Tides.md', 'High water at seven.'))
    expect(changed.created).toHaveLength(1)
    expect(fs.readFileSync(firstOriginal, 'utf8')).toBe('High water at six.')
    expect(db.select().from(contextFile).all()).toHaveLength(2)
    // Once the document is deleted, the same file makes a document again.
    deleteNode(db, first.created[0] ?? '')
    expect((await add(source('Tides.md', 'High water at six.'))).created).toHaveLength(1)
  })

  it("keeps a page's original out of the Library: never listed, matched, updated or replaced", async () => {
    // A file the Library held first becomes Research's once a page is made from it.
    const held = await addContextFiles(db, session.folder, [source('Reef.md', 'Coral.')])
    expect(held.files.map((file) => file.name)).toEqual(['Reef.md'])
    const id = await onlyCreated(source('notes.md', 'Original research text.'))
    const reef = await onlyCreated(source('Reef.md', 'Coral.'))
    const originalOf = (nodeId: string): string =>
      researchOriginalPath(db, session.folder, nodeId)
    const before = [originalOf(id), originalOf(reef)]
    expect(listContextFiles(db)).toEqual([])
    // A Library add (the dialog or a drop) of a same-named file is a Library file of its own.
    const library = await addContextFiles(db, session.folder, [
      source('Notes.md', 'A different library file.'),
      source('reef.md', 'Coral again.')
    ])
    expect(library.changed).toHaveLength(2)
    expect(library.files.map((file) => file.name).sort()).toEqual(['Notes.md', 'reef.md'])
    expect([originalOf(id), originalOf(reef)]).toEqual(before)
    expect(fs.readFileSync(originalOf(id), 'utf8')).toBe('Original research text.')
    expect(fs.readFileSync(originalOf(reef), 'utf8')).toBe('Coral.')
    // Update on a page's original is refused, and changes nothing.
    const fileId = researchDocOf(db, id).contextFileId ?? ''
    await expect(
      addContextFiles(db, session.folder, [source('notes.md', 'Swapped.')], fileId)
    ).rejects.toThrow('That file belongs to a Research document')
    expect(fs.readFileSync(originalOf(id), 'utf8')).toBe('Original research text.')
  })

  it('refuses a parent outside Research', async () => {
    const manuscript = listNodes(db).find((row) => row.sectionType === 'manuscript')
    await expect(
      addResearchFiles(db, session.folder, 'novel', [source('a.md', 'x')], manuscript?.id)
    ).rejects.toThrow('Not a Research folder')
  })
})

describe('research notes, Not canon and Open original (F-16.8)', () => {
  it('creates a written note that reads as written and canon', () => {
    const note = createResearchNote(db, 'novel', { title: 'Questions' })
    expect(note.parentId).toBe(root)
    expect(researchDocOf(db, note.id)).toMatchObject({
      origin: 'written',
      contextFileId: null,
      fileType: null,
      notCanon: false
    })
    expect(listResearchDocs(db).map((doc) => doc.nodeId)).toEqual([note.id])
  })

  it('switches a page Not canon and back, a document with no row included', () => {
    const plain = createNode(db, 'novel', {
      parentId: root,
      kind: 'document',
      hierarchyLevel: null
    })
    expect(researchDocOf(db, plain.id).notCanon).toBe(false)
    expect(setResearchNotCanon(db, plain.id, true).notCanon).toBe(true)
    expect(researchDocOf(db, plain.id)).toMatchObject({ origin: 'written', notCanon: true })
    expect(setResearchNotCanon(db, plain.id, false).notCanon).toBe(false)
  })

  it('refuses a document outside Research', () => {
    const scene = listNodes(db).find((row) => row.hierarchyLevel === 'scene')
    expect(() => researchDocOf(db, scene?.id ?? '')).toThrow('Not a Research document')
    expect(() => setResearchNotCanon(db, scene?.id ?? '', true)).toThrow(AppError)
  })

  it('opens only an upload, and refuses a hand-edited path that leaves the library folder', async () => {
    const note = createResearchNote(db, 'novel', {})
    expect(() => researchOriginalPath(db, session.folder, note.id)).toThrow(
      'This document has no original file'
    )
    const id = await onlyCreated(source('Tides.md', 'High water at six.'))
    const fileId = researchDocOf(db, id).contextFileId ?? ''
    expect(researchOriginalPath(db, session.folder, id)).toContain(
      path.join(session.folder, 'assets', 'library')
    )
    db.update(contextFile).set({ stored: '../project.db' }).where(eq(contextFile.id, fileId)).run()
    expect(() => researchOriginalPath(db, session.folder, id)).toThrow(
      'is not a stored library file'
    )
    db.update(contextFile).set({ stored: '..' }).where(eq(contextFile.id, fileId)).run()
    expect(() => researchOriginalPath(db, session.folder, id)).toThrow(AppError)
  })

  it('carries the meta of a duplicated folder onto its copies', async () => {
    const folder = createNode(db, 'novel', {
      parentId: root,
      kind: 'folder',
      hierarchyLevel: null,
      title: 'Sea'
    })
    const result = await addResearchFiles(
      db,
      session.folder,
      'novel',
      [source('Tides.md', 'High water at six.')],
      folder.id
    )
    const upload = result.created[0] ?? ''
    setResearchNotCanon(db, upload, true)
    const copies = duplicateNode(db, folder.id)
    copyResearchMeta(db, folder.id, copies)
    const copied = copies.find((row) => row.kind === 'document')
    expect(researchDocOf(db, copied?.id ?? '')).toMatchObject({
      origin: 'upload',
      fileType: 'md',
      notCanon: true,
      contextFileId: researchDocOf(db, upload).contextFileId
    })
  })

  it('lists every Research document in tree order; deleting one drops its meta', async () => {
    const a = createResearchNote(db, 'novel', { title: 'A' })
    const b = await onlyCreated(source('B.md', 'Bee.'))
    expect(listResearchDocs(db).map((doc) => doc.nodeId)).toEqual([a.id, b])
    deleteNode(db, a.id)
    expect(listResearchDocs(db).map((doc) => doc.nodeId)).toEqual([b])
    expect(db.select().from(node).where(eq(node.id, a.id)).all()).toEqual([])
  })
})
