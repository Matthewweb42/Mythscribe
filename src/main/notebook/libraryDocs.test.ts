import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { docToText } from '@shared/docText'
import { contextFile } from '../db/schema'
import { addContextFiles, storedPath } from '../library/libraryStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import type { TreeDb } from '../tree/treeStore'
import { copyLibraryDocsOnce, libraryDocsCopied, readLibraryDocs } from './libraryDocs'
import { getNotebookPage, listNotebook } from './notebookStore'

/** Notes redesign, fresh start: the Library's files into Notes › Docs, once per project. */

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-library-docs-'))
  session = createProject(projectFolderFor(tmp, 'Docs'), 'Docs', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.connection.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const add = (name: string, text: string | Buffer) =>
  addContextFiles(db, session.folder, [
    { name, read: () => (typeof text === 'string' ? Buffer.from(text, 'utf8') : text) }
  ])

describe('copyLibraryDocsOnce', () => {
  it('makes a Docs folder with one page per file, headings kept, images left out', async () => {
    await add('Powers.md', '# Powers\n\nShadow walking costs a memory.\n')
    await add('Notes.txt', 'Mara fears the sea.')
    await add('map.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const ids = await copyLibraryDocsOnce(db, session.folder, () => true)
    // The notes binder: the Docs folder goes in Documents.
    const all = listNotebook(db)
    const documents = all.find((item) => item.role === 'documents')
    const docs = all.find((item) => item.title === 'Docs')
    expect(docs?.parentId).toBe(documents?.id)
    const items = [docs, ...all.filter((item) => item.parentId === docs?.id)]
    expect(items.map((item) => [item?.kind, item?.title])).toEqual([
      ['folder', 'Docs'],
      ['page', 'Notes'],
      ['page', 'Powers']
    ])
    expect(ids).toEqual(items.map((item) => item?.id))
    const powers = getNotebookPage(db, items[2]?.id ?? '')
    expect(powers.content?.content?.[0]).toMatchObject({ type: 'heading' })
    expect(powers.plain).toBe('Powers\nShadow walking costs a memory.')
    expect(libraryDocsCopied(db)).toBe(true)
    // Never twice.
    expect(await copyLibraryDocsOnce(db, session.folder, () => true)).toEqual([])
    expect(listNotebook(db)).toHaveLength(6)
  })

  it('leaves a project with no files alone, making no folder and recording nothing', async () => {
    expect(await copyLibraryDocsOnce(db, session.folder, () => true)).toEqual([])
    expect(listNotebook(db)).toEqual([])
    expect(libraryDocsCopied(db)).toBe(false)
  })

  it('records a Library of images only as done, with no folder', async () => {
    await add('map.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await copyLibraryDocsOnce(db, session.folder, () => true)).toEqual([])
    expect(listNotebook(db)).toEqual([])
    expect(libraryDocsCopied(db)).toBe(true)
  })

  it('uses the text the Library stored when the original is gone', async () => {
    await add('Lost.md', '# Lost\n\nGone from disk.')
    const row = db.select().from(contextFile).get()
    if (row === undefined) throw new Error('no row')
    db.update(contextFile)
      .set({ processedText: 'The stored text.\nSecond line.' })
      .where(eq(contextFile.id, row.id))
      .run()
    fs.rmSync(storedPath(session.folder, row.stored))
    const pages = await readLibraryDocs(db, session.folder)
    expect(pages.map((page) => [page.title, docToText(page.content)])).toEqual([
      ['Lost', 'The stored text.\nSecond line.']
    ])
  })

  it('writes nothing when the project closed while the files were read', async () => {
    await add('Powers.md', 'Shadow walking.')
    expect(await copyLibraryDocsOnce(db, session.folder, () => false)).toEqual([])
    expect(listNotebook(db)).toEqual([])
    expect(libraryDocsCopied(db)).toBe(false)
  })
})
